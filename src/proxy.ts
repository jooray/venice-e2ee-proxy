import type { Request, Response } from 'express';
import type { ProxyConfig } from './config.js';
import { SessionManager } from './session-manager.js';
import { logger } from './logger.js';

interface ChatMessage {
  role: string;
  content: string;
}

interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  venice_parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Core proxy handler for chat completions and models listing.
 *
 * Chat completions:
 * - E2EE models (e2ee-*): encrypt messages, forward to Venice, decrypt response
 * - Non-E2EE models: transparently forward with Authorization header
 *
 * GET /v1/models: forward to Venice `/api/v1/models` with the proxy API key.
 */
export class ProxyHandler {
  private sessionManager: SessionManager;
  private config: ProxyConfig;

  constructor(config: ProxyConfig, sessionManager: SessionManager) {
    this.config = config;
    this.sessionManager = sessionManager;
  }

  /**
   * Handle a chat completions request.
   */
  async handleChatCompletions(req: Request, res: Response): Promise<void> {
    const body = req.body as ChatCompletionRequest;

    if (!body.model) {
      res.status(400).json({ error: { message: 'model is required', type: 'invalid_request_error' } });
      return;
    }

    if (!body.messages || !Array.isArray(body.messages)) {
      res.status(400).json({ error: { message: 'messages array is required', type: 'invalid_request_error' } });
      return;
    }

    if (this.sessionManager.isE2EE(body.model)) {
      await this.handleE2EERequest(body, res);
    } else {
      await this.handlePassthroughRequest(body, req, res);
    }
  }

  /**
   * E2EE path: encrypt messages, forward to Venice, decrypt and stream/collect response.
   */
  private async handleE2EERequest(body: ChatCompletionRequest, res: Response, retried = false): Promise<void> {
    const modelId = body.model;
    const wantStream = body.stream !== false; // default to streaming

    try {
      // 1. Get or create E2EE session
      logger.debug(`Getting E2EE session for ${modelId}`);
      const { session, instance } = await this.sessionManager.getSession(modelId);
      logger.info(`E2EE ${modelId} | attestation: ${session.attestation ? 'verified' : 'skipped'}`);

      // 2. Encrypt messages
      const { encryptedMessages, headers: e2eeHeaders, veniceParameters } = await instance.encrypt(body.messages, session);

      // 3. Build Venice request
      const bodyRecord = body as Record<string, unknown>;
      let forwardFields: Record<string, unknown>;
      if (this.config.e2ee_allow_tools) {
        forwardFields = { ...bodyRecord };
      } else {
        // Strip tool-related params by default — many E2EE models don't support function calling,
        // and tool_calls in responses aren't decrypted by the proxy.
        const { tools, tool_choice, parallel_tool_calls, ...bodyWithoutTools } = bodyRecord;
        if (tools || tool_choice || parallel_tool_calls) {
          logger.warn(
            `Stripping unsupported params from E2EE request: ${[tools && 'tools', tool_choice && 'tool_choice', parallel_tool_calls && 'parallel_tool_calls'].filter(Boolean).join(', ')}`
          );
        }
        forwardFields = bodyWithoutTools;
      }

      const veniceBody: Record<string, unknown> = {
        ...forwardFields,
        messages: encryptedMessages,
        stream: true, // always stream from Venice (we decrypt chunks)
        venice_parameters: {
          ...(body.venice_parameters || {}),
          ...veniceParameters,
        },
      };

      const veniceUrl = `${this.config.venice_base_url}/api/v1/chat/completions`;
      logger.debug(`Forwarding encrypted request to ${veniceUrl}`);

      const veniceRes = await fetch(veniceUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.venice_api_key}`,
          ...e2eeHeaders,
        },
        body: JSON.stringify(veniceBody),
      });

      if (!veniceRes.ok) {
        const errorText = await veniceRes.text();
        logger.error(`Venice API error (${veniceRes.status}): ${errorText}`);
        res.status(veniceRes.status).type('application/json').send(errorText);
        return;
      }

      if (!veniceRes.body) {
        res.status(502).json({ error: { message: 'No response body from Venice', type: 'proxy_error' } });
        return;
      }

      // 4. Decrypt and forward response
      if (wantStream) {
        await this.streamE2EEResponse(veniceRes, session, instance, res);
      } else {
        await this.collectE2EEResponse(veniceRes, session, instance, res);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      // Auto-retry once on stale session
      if (!retried && message.includes('session may be stale')) {
        logger.warn(`Stale session detected for ${modelId}, retrying with fresh session`);
        this.sessionManager.invalidateSession(modelId);
        await this.handleE2EERequest(body, res, true);
        return;
      }

      // Retry on attestation/session creation failures
      if (!retried && (message.includes('attestation') || message.includes('TEE'))) {
        logger.warn(`Session creation failed for ${modelId}, retrying: ${message}`);
        this.sessionManager.invalidateSession(modelId);
        await this.handleE2EERequest(body, res, true);
        return;
      }

      logger.error(`E2EE request failed: ${message}`);
      res.status(502).json({ error: { message: `E2EE proxy error: ${message}`, type: 'proxy_error' } });
    }
  }

  /**
   * Stream decrypted E2EE response as standard OpenAI SSE events.
   */
  private async streamE2EEResponse(
    veniceRes: globalThis.Response,
    session: { privateKey: Uint8Array; modelId: string },
    instance: { decryptStream: (body: ReadableStream<Uint8Array>, session: any) => AsyncGenerator<string> },
    res: Response
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    // We need to parse Venice's SSE ourselves to decrypt and re-emit
    const reader = veniceRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let chunkIndex = 0;
    const responseId = `chatcmpl-${Date.now().toString(36)}`;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();

          if (data === '[DONE]') {
            res.write('data: [DONE]\n\n');
            res.end();
            return;
          }

          let event: any;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          const content = event.choices?.[0]?.delta?.content;
          if (content === undefined || content === null) {
            // Forward non-content events as-is (e.g., role events)
            res.write(`data: ${JSON.stringify(event)}\n\n`);
            continue;
          }

          // Decrypt the content
          try {
            const decrypted = await instance.decryptStream
              ? await decryptSingleChunk(session.privateKey, content)
              : content;

            // Re-emit as standard OpenAI SSE
            const sseEvent = {
              id: responseId,
              object: 'chat.completion.chunk',
              created: event.created || Math.floor(Date.now() / 1000),
              model: session.modelId,
              choices: [{
                index: 0,
                delta: { content: decrypted },
                finish_reason: event.choices?.[0]?.finish_reason || null,
              }],
            };

            res.write(`data: ${JSON.stringify(sseEvent)}\n\n`);
            chunkIndex++;
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes('session may be stale') || msg.includes('OperationError')) {
              throw new Error('E2EE decryption failed — session may be stale. Clear the session and retry.');
            }
            // For non-critical decrypt failures (e.g., whitespace tokens that pass through)
            logger.debug(`Chunk decrypt issue (non-fatal): ${msg}`);
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim() && buffer.startsWith('data: ')) {
        const data = buffer.slice(6).trim();
        if (data === '[DONE]') {
          res.write('data: [DONE]\n\n');
        }
      }
    } finally {
      reader.releaseLock();
    }

    res.end();
  }

  /**
   * Collect all decrypted chunks into a single non-streaming response.
   */
  private async collectE2EEResponse(
    veniceRes: globalThis.Response,
    session: { privateKey: Uint8Array; modelId: string },
    instance: { decryptStream: (body: ReadableStream<Uint8Array>, session: any) => AsyncGenerator<string> },
    res: Response
  ): Promise<void> {
    const chunks: string[] = [];
    let finishReason: string | null = null;
    let created = Math.floor(Date.now() / 1000);

    // Parse SSE and collect decrypted text
    const reader = veniceRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;

          let event: any;
          try {
            event = JSON.parse(data);
          } catch {
            continue;
          }

          if (event.created) created = event.created;

          const content = event.choices?.[0]?.delta?.content;
          if (content === undefined || content === null) continue;

          if (event.choices?.[0]?.finish_reason) {
            finishReason = event.choices[0].finish_reason;
          }

          try {
            const decrypted = await decryptSingleChunk(session.privateKey, content);
            chunks.push(decrypted);
          } catch (e: unknown) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes('OperationError')) {
              throw new Error('E2EE decryption failed — session may be stale.');
            }
            logger.debug(`Chunk decrypt issue (non-fatal): ${msg}`);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const fullContent = chunks.join('');

    // Build standard OpenAI response format
    const response = {
      id: `chatcmpl-${Date.now().toString(36)}`,
      object: 'chat.completion',
      created,
      model: session.modelId,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: fullContent,
        },
        finish_reason: finishReason || 'stop',
      }],
      usage: {
        prompt_tokens: 0,  // Not available through E2EE
        completion_tokens: 0,
        total_tokens: 0,
      },
    };

    res.json(response);
  }

  /**
   * Passthrough path: forward non-E2EE requests to Venice transparently.
   */
  private async handlePassthroughRequest(body: ChatCompletionRequest, req: Request, res: Response): Promise<void> {
    const wantStream = body.stream === true;
    const veniceUrl = `${this.config.venice_base_url}/api/v1/chat/completions`;

    logger.info(`Passthrough ${body.model}`);

    try {
      // Forward all headers except host, and add authorization
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.venice_api_key}`,
      };

      // Preserve client headers that might be relevant
      if (req.headers['accept']) headers['Accept'] = req.headers['accept'] as string;

      const veniceRes = await fetch(veniceUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      // Forward status and content type
      res.status(veniceRes.status);

      const contentType = veniceRes.headers.get('content-type');
      if (contentType) res.setHeader('Content-Type', contentType);

      if (!veniceRes.body) {
        const text = await veniceRes.text();
        res.send(text);
        return;
      }

      if (wantStream) {
        // Stream response through
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const reader = veniceRes.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
        } finally {
          reader.releaseLock();
        }
        res.end();
      } else {
        const text = await veniceRes.text();
        res.send(text);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Passthrough request failed: ${message}`);
      res.status(502).json({ error: { message: `Proxy error: ${message}`, type: 'proxy_error' } });
    }
  }

  /**
   * Forward any request to the same path and query on Venice (uses proxy API key).
   * Used when ENDPOINT_PASSTHRU is enabled for routes not handled above.
   */
  async handleVeniceEndpointPassthru(req: Request, res: Response): Promise<void> {
    const base = this.config.venice_base_url.replace(/\/$/, '');
    const veniceUrl = `${base}${req.originalUrl}`;
    logger.info(`Endpoint passthru ${req.method} ${req.originalUrl}`);

    const skipRequestHeaders = new Set([
      'host',
      'connection',
      'content-length',
      'transfer-encoding',
      'authorization',
    ]);

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.venice_api_key}`,
    };

    for (const [key, value] of Object.entries(req.headers)) {
      if (skipRequestHeaders.has(key.toLowerCase())) continue;
      if (value === undefined) continue;
      headers[key] = Array.isArray(value) ? value.join(', ') : value;
    }

    const method = req.method.toUpperCase();
    const hasBody = !['GET', 'HEAD', 'DELETE', 'CONNECT', 'TRACE'].includes(method);

    const init: RequestInit = { method, headers };

    if (hasBody) {
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
      if (rawBody !== undefined) {
        init.body = new Uint8Array(rawBody);
      } else if (req.body !== undefined) {
        init.body = JSON.stringify(req.body);
        if (!headers['content-type'] && !headers['Content-Type']) {
          headers['Content-Type'] = 'application/json';
        }
      }
    }

    try {
      const veniceRes = await fetch(veniceUrl, init);

      res.status(veniceRes.status);
      veniceRes.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        if (['transfer-encoding', 'connection', 'keep-alive'].includes(lower)) return;
        res.setHeader(key, value);
      });

      if (!veniceRes.body) {
        const text = await veniceRes.text();
        res.send(text);
        return;
      }

      const reader = veniceRes.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } finally {
        reader.releaseLock();
      }
      res.end();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Endpoint passthru failed: ${message}`);
      if (!res.headersSent) {
        res.status(502).json({ error: { message: `Proxy error: ${message}`, type: 'proxy_error' } });
      }
    }
  }

  /**
   * Proxy GET /v1/models to Venice's OpenAI-compatible models list.
   */
  async handleModels(req: Request, res: Response): Promise<void> {
    const queryIndex = req.originalUrl.indexOf('?');
    const query = queryIndex >= 0 ? req.originalUrl.slice(queryIndex) : '';
    const veniceUrl = `${this.config.venice_base_url}/api/v1/models${query}`;

    try {
      const headers: Record<string, string> = {
        Authorization: `Bearer ${this.config.venice_api_key}`,
      };
      if (req.headers['accept']) headers['Accept'] = req.headers['accept'] as string;

      const veniceRes = await fetch(veniceUrl, { method: 'GET', headers });

      res.status(veniceRes.status);
      const contentType = veniceRes.headers.get('content-type');
      if (contentType) res.setHeader('Content-Type', contentType);

      const text = await veniceRes.text();
      res.send(text);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Models list request failed: ${message}`);
      if (!res.headersSent) {
        res.status(502).json({ error: { message: `Proxy error: ${message}`, type: 'proxy_error' } });
      }
    }
  }
}

/**
 * Decrypt a single chunk using the low-level decryptChunk from venice-e2ee.
 * Imported dynamically to avoid circular dependency issues.
 */
async function decryptSingleChunk(privateKey: Uint8Array, hexString: string): Promise<string> {
  const { decryptChunk } = await import('venice-e2ee');
  return decryptChunk(privateKey, hexString);
}

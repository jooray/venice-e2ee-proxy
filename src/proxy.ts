import type { Request, Response } from 'express';
import type { ProxyConfig } from './config.js';
import { SessionManager, stripTeePrefix } from './session-manager.js';
import { logger } from './logger.js';
import { debugDump } from './debug-dump.js';
import {
  buildToolSystemPrompt,
  renderToolMessages,
  ToolCallStreamParser,
  type ToolCall,
  type ToolChatMessage,
  type ToolChoice,
  type ToolDefinition,
} from 'venice-e2ee';

interface ChatCompletionRequest {
  model: string;
  messages: ToolChatMessage[];
  stream?: boolean;
  tools?: ToolDefinition[];
  tool_choice?: ToolChoice;
  parallel_tool_calls?: boolean;
  venice_parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Core proxy handler for /v1/chat/completions.
 *
 * Routes:
 * - TEE-only models (tee-*): verify attestation, forward plaintext with the
 *   prefix stripped, leave function calling to Venice
 * - E2EE models (e2ee-*): encrypt messages, forward to Venice, decrypt response
 * - Everything else: transparently forward with Authorization header
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

    if (this.sessionManager.isTeeOnly(body.model)) {
      if (!stripTeePrefix(body.model)) {
        res.status(400).json({
          error: { message: 'model is required after the tee- prefix', type: 'invalid_request_error' },
        });
        return;
      }
      await this.handleTeeOnlyRequest(body, res);
    } else if (this.sessionManager.isE2EE(body.model)) {
      await this.handleE2EERequest(body, res);
    } else {
      await this.handlePassthroughRequest(body, req, res);
    }
  }

  /**
   * TEE-only path: verify the enclave, then forward the request in plaintext.
   *
   * Venice runs the model inside an attested Intel TDX enclave either way; the
   * difference from the E2EE path is who else can read the prompt. Here Venice's
   * proxy can, which is the price of keeping the features E2EE turns off —
   * function calling among them. So no `tools` rewriting happens on this path:
   * schemas go over the wire as-is and Venice returns native `tool_calls`.
   *
   * Attestation still runs, and still fails the request if it does not check out.
   */
  private async handleTeeOnlyRequest(
    body: ChatCompletionRequest,
    res: Response,
    retried = false
  ): Promise<void> {
    const clientModel = body.model;
    const upstreamModel = stripTeePrefix(clientModel);

    try {
      const { verified } = await this.sessionManager.getAttestation(upstreamModel);
      logger.info(`TEE-only ${upstreamModel} | attestation: ${verified ? 'verified' : 'skipped'}`);
      if (!verified) {
        logger.warn(
          `Attestation verification is disabled, so ${clientModel} gives you nothing over a plain ` +
          `passthrough request. Set verify_attestation: true to make the tee- prefix mean something.`
        );
      }

      const veniceBody: Record<string, unknown> = {
        ...body,
        model: upstreamModel,
        venice_parameters: {
          ...(body.venice_parameters || {}),
          // Pin the mode rather than inferring it from the absence of E2EE
          // headers, so a stray header can never silently switch encryption on
          // and take function calling down with it.
          enable_e2ee: false,
        },
      };

      const veniceUrl = `${this.config.venice_base_url}/api/v1/chat/completions`;
      logger.debug(`Forwarding plaintext TEE request to ${veniceUrl}`);

      const veniceRes = await fetch(veniceUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.config.venice_api_key}`,
        },
        body: JSON.stringify(veniceBody),
      });

      res.status(veniceRes.status);
      const contentType = veniceRes.headers.get('content-type');
      if (contentType) res.setHeader('Content-Type', contentType);

      if (!veniceRes.ok || !veniceRes.body) {
        const errorText = await veniceRes.text();
        if (!veniceRes.ok) logger.error(`Venice API error (${veniceRes.status}): ${errorText}`);
        res.send(errorText);
        return;
      }

      // Responses name the upstream model. Echo back the prefixed ID the client
      // asked for instead: agent frameworks that feed `response.model` into the
      // next request would otherwise drop to the E2EE path on turn two and lose
      // their tools.
      if (body.stream === true) {
        await this.streamTeeOnlyResponse(veniceRes, res, upstreamModel, clientModel);
      } else {
        const text = await veniceRes.text();
        res.send(rewriteModelField(text, upstreamModel, clientModel));
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);

      if (!retried && (message.includes('attestation') || message.includes('TEE'))) {
        logger.warn(`Attestation failed for ${upstreamModel}, retrying: ${message}`);
        this.sessionManager.invalidateSession(upstreamModel);
        await this.handleTeeOnlyRequest(body, res, true);
        return;
      }

      logger.error(`TEE-only request failed: ${message}`);
      if (!res.headersSent) {
        res.status(502).json({ error: { message: `TEE proxy error: ${message}`, type: 'proxy_error' } });
      }
    }
  }

  /**
   * Pipe Venice's SSE stream through, rewriting the model field per event.
   *
   * Line-oriented rather than event-oriented: anything that is not a `data:`
   * line carrying JSON is forwarded byte for byte, so unfamiliar SSE fields
   * survive the trip.
   */
  private async streamTeeOnlyResponse(
    veniceRes: globalThis.Response,
    res: Response,
    from: string,
    to: string
  ): Promise<void> {
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const reader = veniceRes.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // Last element is an unterminated line; hold it until more bytes arrive.
        buffer = lines.pop()!;

        for (const line of lines) {
          res.write(`${rewriteSseLine(line, from, to)}\n`);
        }
      }

      if (buffer) res.write(rewriteSseLine(buffer, from, to));
    } finally {
      reader.releaseLock();
    }

    res.end();
  }

  /**
   * E2EE path: encrypt messages, forward to Venice, decrypt and stream/collect response.
   */
  private async handleE2EERequest(body: ChatCompletionRequest, res: Response, retried = false): Promise<void> {
    const modelId = body.model;
    // OpenAI semantics: `stream` defaults to false. Clients that aren't streaming
    // omit the field entirely, so defaulting to true here would hand them SSE text.
    const wantStream = body.stream === true;

    try {
      // 1. Get or create E2EE session
      logger.debug(`Getting E2EE session for ${modelId}`);
      const { session, instance } = await this.sessionManager.getSession(modelId);
      logger.info(`E2EE ${modelId} | attestation: ${session.attestation ? 'verified' : 'skipped'}`);

      // 2. Move function calling into the encrypted channel.
      //
      // Venice's E2EE gateway silently drops the `tools` parameter, so passing it
      // through would leave the model unaware of the tools while leaking their
      // schemas in plaintext. Instead the schemas and the tool-call history are
      // rendered into message content and encrypted with everything else, and the
      // model's `<tool_call>` blocks are parsed back out of the decrypted stream.
      const { tools, tool_choice, parallel_tool_calls, ...restBody } = body as ChatCompletionRequest;
      const toolPrompt = tools?.length ? buildToolSystemPrompt(tools, tool_choice ?? 'auto') : null;

      let messages = renderToolMessages(body.messages);
      if (toolPrompt) {
        // Merge into an existing leading system message so models that only honour
        // the first system turn still see the schemas.
        if (messages[0]?.role === 'system') {
          messages = [{ ...messages[0], content: `${messages[0].content}\n\n${toolPrompt}` }, ...messages.slice(1)];
        } else {
          messages = [{ role: 'system', content: toolPrompt }, ...messages];
        }
        logger.debug(`Injected ${tools!.length} tool schema(s) into the encrypted prompt`);
      }

      debugDump('request', {
        model: modelId,
        stream: wantStream,
        tool_choice: tool_choice ?? null,
        tools: tools ?? null,
        messages,
      });

      // 3. Encrypt every message (the TEE rejects any plaintext content)
      const { encryptedMessages, headers: e2eeHeaders, veniceParameters } = await instance.encrypt(messages, session);

      // 4. Build Venice request
      const veniceBody: Record<string, unknown> = {
        ...restBody,
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

      // 5. Decrypt and forward response. The parser gets the schemas too: they
      // let it coerce arguments and recognise a call the model emitted without
      // the surrounding tags.
      const parserTools = toolPrompt ? tools ?? null : null;
      if (wantStream) {
        await this.streamE2EEResponse(veniceRes, session, res, parserTools);
      } else {
        await this.collectE2EEResponse(veniceRes, session, res, parserTools);
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
   * Iterate Venice's SSE events, yielding each parsed JSON payload.
   */
  private async *iterateVeniceEvents(veniceRes: globalThis.Response): AsyncGenerator<any> {
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
          if (data === '[DONE]') return;
          try {
            yield JSON.parse(data);
          } catch {
            // skip malformed events
          }
        }
      }

      // Trailing event without a newline terminator
      if (buffer.startsWith('data: ')) {
        const data = buffer.slice(6).trim();
        if (data && data !== '[DONE]') {
          try {
            yield JSON.parse(data);
          } catch {
            // ignore partial JSON
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Decrypt one hex field from a delta, mapping stale-session failures onto the
   * retry path in handleE2EERequest.
   */
  private async decryptField(privateKey: Uint8Array, value: string): Promise<string | null> {
    try {
      return await decryptSingleChunk(privateKey, value);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('session may be stale') || msg.includes('OperationError')) {
        throw new Error('E2EE decryption failed — session may be stale. Clear the session and retry.');
      }
      logger.debug(`Chunk decrypt issue (non-fatal): ${msg}`);
      return null;
    }
  }

  /**
   * Stream decrypted E2EE response as standard OpenAI SSE events.
   *
   * When tools were requested, assistant content is routed through a parser that
   * splits `<tool_call>` blocks out of the prose and re-emits them as OpenAI
   * `delta.tool_calls`, so clients see ordinary function calling.
   */
  private async streamE2EEResponse(
    veniceRes: globalThis.Response,
    session: { privateKey: Uint8Array; modelId: string },
    res: Response,
    parseTools: ToolDefinition[] | null
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const responseId = `chatcmpl-${Date.now().toString(36)}`;
    const created = Math.floor(Date.now() / 1000);
    const parser = parseTools ? new ToolCallStreamParser({ tools: parseTools }) : null;
    let toolCallIndex = 0;
    let finishReason: string | null = null;
    let usage: unknown = null;
    // Raw decrypted assistant text, captured before the tool parser touches it.
    const rawParts: string[] = [];
    const rawReasoning: string[] = [];

    const emit = (delta: Record<string, unknown>, reason: string | null = null): void => {
      res.write(`data: ${JSON.stringify({
        id: responseId,
        object: 'chat.completion.chunk',
        created,
        model: session.modelId,
        choices: [{ index: 0, delta, finish_reason: reason }],
      })}\n\n`);
    };

    const emitToolCalls = (calls: ToolCall[]): void => {
      for (const call of calls) {
        emit({ tool_calls: [{ index: toolCallIndex++, ...call }] });
      }
    };

    for await (const event of this.iterateVeniceEvents(veniceRes)) {
      if (event.usage) usage = event.usage;

      const choice = event.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta;
      if (!delta) continue;

      if (delta.role) emit({ role: delta.role });

      // Reasoning arrives encrypted too — decrypt rather than forwarding hex.
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        const reasoning = await this.decryptField(session.privateKey, delta.reasoning_content);
        if (reasoning) {
          rawReasoning.push(reasoning);
          emit({ reasoning_content: reasoning });
        }
      }

      if (typeof delta.content === 'string' && delta.content) {
        const text = await this.decryptField(session.privateKey, delta.content);
        if (text === null) continue;
        rawParts.push(text);

        if (parser) {
          const { content, toolCalls } = parser.push(text);
          if (content) emit({ content });
          emitToolCalls(toolCalls);
        } else if (text) {
          emit({ content: text });
        }
      }
    }

    if (parser) {
      const { content, toolCalls } = parser.flush();
      if (content) emit({ content });
      emitToolCalls(toolCalls);
      if (parser.sawToolCall) finishReason = 'tool_calls';
    }

    debugDump('response', {
      model: session.modelId,
      stream: true,
      raw: rawParts.join(''),
      reasoning: rawReasoning.join(''),
      chunk_count: rawParts.length,
      parsed_tool_calls: parser?.toolCalls ?? [],
      finish_reason: finishReason,
    });

    emit({}, finishReason || 'stop');

    if (usage) {
      res.write(`data: ${JSON.stringify({
        id: responseId,
        object: 'chat.completion.chunk',
        created,
        model: session.modelId,
        choices: [],
        usage,
      })}\n\n`);
    }

    res.write('data: [DONE]\n\n');
    res.end();
  }

  /**
   * Collect all decrypted chunks into a single non-streaming response.
   */
  private async collectE2EEResponse(
    veniceRes: globalThis.Response,
    session: { privateKey: Uint8Array; modelId: string },
    res: Response,
    parseTools: ToolDefinition[] | null
  ): Promise<void> {
    const contentParts: string[] = [];
    const reasoningParts: string[] = [];
    let finishReason: string | null = null;
    let created = Math.floor(Date.now() / 1000);
    let usage: Record<string, unknown> | null = null;

    for await (const event of this.iterateVeniceEvents(veniceRes)) {
      if (event.created) created = event.created;
      if (event.usage) usage = event.usage;

      const choice = event.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta;
      if (!delta) continue;

      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        const reasoning = await this.decryptField(session.privateKey, delta.reasoning_content);
        if (reasoning) reasoningParts.push(reasoning);
      }

      if (typeof delta.content === 'string' && delta.content) {
        const text = await this.decryptField(session.privateKey, delta.content);
        if (text) contentParts.push(text);
      }
    }

    const raw = contentParts.join('');
    let content = raw;
    let toolCalls: ToolCall[] = [];

    if (parseTools) {
      const parser = new ToolCallStreamParser({ tools: parseTools });
      const pushed = parser.push(raw);
      const flushed = parser.flush();
      content = pushed.content + flushed.content;
      toolCalls = [...pushed.toolCalls, ...flushed.toolCalls];
      if (toolCalls.length > 0) finishReason = 'tool_calls';
    }

    debugDump('response', {
      model: session.modelId,
      stream: false,
      raw,
      reasoning: reasoningParts.join(''),
      chunk_count: contentParts.length,
      parsed_tool_calls: toolCalls,
      finish_reason: finishReason,
    });

    const message: Record<string, unknown> = {
      role: 'assistant',
      // OpenAI sends content: null when the turn is purely tool calls.
      content: toolCalls.length > 0 && !content.trim() ? null : content,
    };
    if (reasoningParts.length > 0) message.reasoning_content = reasoningParts.join('');
    if (toolCalls.length > 0) message.tool_calls = toolCalls;

    res.json({
      id: `chatcmpl-${Date.now().toString(36)}`,
      object: 'chat.completion',
      created,
      model: session.modelId,
      choices: [{ index: 0, message, finish_reason: finishReason || 'stop' }],
      usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
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
}

/**
 * Swap a JSON payload's top-level `model` field, leaving anything else — including
 * payloads that are not JSON, or name a different model — exactly as it arrived.
 */
function rewriteModelField(payload: string, from: string, to: string): string {
  try {
    const parsed = JSON.parse(payload);
    if (parsed && typeof parsed === 'object' && (parsed as { model?: unknown }).model === from) {
      (parsed as { model: string }).model = to;
      return JSON.stringify(parsed);
    }
  } catch {
    // Not JSON — forward untouched.
  }
  return payload;
}

/** Apply {@link rewriteModelField} to one SSE line, passing through `[DONE]` and non-data lines. */
function rewriteSseLine(line: string, from: string, to: string): string {
  if (!line.startsWith('data: ')) return line;
  const data = line.slice(6);
  if (data.trim() === '[DONE]') return line;
  return `data: ${rewriteModelField(data, from, to)}`;
}

/**
 * Decrypt a single chunk using the low-level decryptChunk from venice-e2ee.
 * Imported dynamically to avoid circular dependency issues.
 */
async function decryptSingleChunk(privateKey: Uint8Array, hexString: string): Promise<string> {
  const { decryptChunk } = await import('venice-e2ee');
  return decryptChunk(privateKey, hexString);
}

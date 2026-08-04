import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer } from '../src/server.js';
import type { ProxyConfig } from '../src/config.js';
import type { Express } from 'express';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { generateKeypair, deriveAESKey, encryptMessage } from 'venice-e2ee';

// Generate a valid secp256k1 keypair for the mock TEE
const mockTeeKeypair = generateKeypair();

/**
 * Encrypt one response chunk the way the TEE does: a fresh ephemeral keypair per
 * chunk, ECDH against the client's public key, and the ephemeral public key
 * prefixed to the ciphertext so the client can derive the same secret.
 *
 * The mock has to do this for real. Venice E2EE responses are rejected unless
 * every chunk is encrypted, so a mock that emitted plaintext would only prove
 * the proxy accepts a downgrade.
 */
async function encryptForClient(clientPubKeyHex: string, plaintext: string): Promise<string> {
  const ephemeral = generateKeypair();
  const aesKey = await deriveAESKey(ephemeral.privateKey, clientPubKeyHex);
  return encryptMessage(aesKey, ephemeral.publicKey, plaintext);
}

// Helper: create a test config
function testConfig(overrides?: Partial<ProxyConfig>): ProxyConfig {
  return {
    port: 0, // random port
    host: '127.0.0.1',
    venice_api_key: 'test-key-123',
    venice_base_url: 'http://127.0.0.1:0', // will be overridden in tests
    verify_attestation: true,
    enable_dcap: false,
    verify_receipts: false,
    // Kept out of the repo: pinning is a side effect and tests should not leave one.
    receipt_anchor_store: path.join(os.tmpdir(), `venice-anchors-${process.pid}.json`),
    receipt_anchors: {},
    session_ttl: 1800000,
    log_level: 'error', // quiet during tests
    ...overrides,
  };
}

// Helper: make a request to the test server
async function request(
  server: http.Server,
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: text,
  };
}

// Helper: make a streaming request and collect SSE events
async function streamRequest(
  server: http.Server,
  path: string,
  body: unknown
): Promise<{ status: number; events: string[]; rawBody: string }> {
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}${path}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  const events = text
    .split('\n')
    .filter(line => line.startsWith('data: '))
    .map(line => line.slice(6));

  return { status: res.status, events, rawBody: text };
}

describe('Server basics', () => {
  let server: http.Server;
  let sessionManager: ReturnType<typeof createServer>['sessionManager'];

  beforeAll(async () => {
    const config = testConfig();
    const result = createServer(config);
    sessionManager = result.sessionManager;
    server = result.app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
  });

  afterAll(async () => {
    sessionManager.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('GET /health returns status ok', async () => {
    const res = await request(server, 'GET', '/health');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('ok');
    expect(body.verify_attestation).toBe(true);
  });

  it('GET /unknown returns 404', async () => {
    const res = await request(server, 'GET', '/unknown');
    expect(res.status).toBe(404);
    const body = JSON.parse(res.body);
    expect(body.error.type).toBe('invalid_request_error');
  });

  it('POST /v1/chat/completions without model returns 400', async () => {
    const res = await request(server, 'POST', '/v1/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain('model is required');
  });

  it('POST /v1/chat/completions without messages returns 400', async () => {
    const res = await request(server, 'POST', '/v1/chat/completions', {
      model: 'test-model',
    });
    expect(res.status).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain('messages');
  });

  it('POST /chat/completions also works (without /v1 prefix)', async () => {
    const res = await request(server, 'POST', '/chat/completions', {
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(res.status).toBe(400); // Missing model, but endpoint works
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain('model is required');
  });
});

describe('Passthrough (non-E2EE) requests', () => {
  let mockVenice: http.Server;
  let proxyServer: http.Server;
  let sessionManager: ReturnType<typeof createServer>['sessionManager'];

  beforeAll(async () => {
    // Create a mock Venice API server
    mockVenice = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/v1/chat/completions') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          const parsed = JSON.parse(body);

          // Verify authorization header was forwarded
          const auth = req.headers['authorization'];
          if (!auth || !auth.includes('test-key')) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
            return;
          }

          if (parsed.stream) {
            // Streaming response
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
            });
            res.write('data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n');
            res.write('data: {"choices":[{"delta":{"content":" world"},"finish_reason":null}]}\n\n');
            res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            // Non-streaming response
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              id: 'chatcmpl-test',
              object: 'chat.completion',
              choices: [{
                index: 0,
                message: { role: 'assistant', content: 'Hello world' },
                finish_reason: 'stop',
              }],
            }));
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>(resolve => mockVenice.listen(0, '127.0.0.1', resolve));

    const mockAddress = mockVenice.address() as { port: number };
    const config = testConfig({
      venice_base_url: `http://127.0.0.1:${mockAddress.port}`,
    });
    const result = createServer(config);
    sessionManager = result.sessionManager;
    proxyServer = result.app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => proxyServer.once('listening', resolve));
  });

  afterAll(async () => {
    sessionManager.destroy();
    await Promise.all([
      new Promise<void>(resolve => proxyServer.close(() => resolve())),
      new Promise<void>(resolve => mockVenice.close(() => resolve())),
    ]);
  });

  it('forwards non-E2EE request with authorization header', async () => {
    const res = await request(proxyServer, 'POST', '/v1/chat/completions', {
      model: 'qwen3-30b-a3b-p',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.choices[0].message.content).toBe('Hello world');
  });

  it('forwards streaming non-E2EE request', async () => {
    const result = await streamRequest(proxyServer, '/v1/chat/completions', {
      model: 'qwen3-30b-a3b-p',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });
    expect(result.status).toBe(200);
    expect(result.events).toContain('[DONE]');
    // Should have content events
    const contentEvents = result.events
      .filter(e => e !== '[DONE]')
      .map(e => JSON.parse(e));
    expect(contentEvents.length).toBeGreaterThan(0);
  });

  it('handles parallel non-E2EE requests', async () => {
    const promises = Array.from({ length: 5 }, (_, i) =>
      request(proxyServer, 'POST', '/v1/chat/completions', {
        model: 'qwen3-30b-a3b-p',
        messages: [{ role: 'user', content: `Hello ${i}` }],
        stream: false,
      })
    );

    const results = await Promise.all(promises);
    for (const res of results) {
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.choices[0].message.content).toBe('Hello world');
    }
  });
});

describe('E2EE request handling', () => {
  let mockVenice: http.Server;
  let proxyServer: http.Server;
  let sessionManager: ReturnType<typeof createServer>['sessionManager'];
  let lastReceivedHeaders: http.IncomingHttpHeaders;
  let lastReceivedBody: any;

  beforeAll(async () => {
    // Create mock Venice API server that handles attestation + completions
    mockVenice = http.createServer((req, res) => {
      lastReceivedHeaders = req.headers;

      if (req.method === 'GET' && req.url?.startsWith('/api/v1/tee/attestation')) {
        // Return a mock attestation response
        // We need to disable attestation verification for tests
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          verified: true,
          nonce: new URL(`http://localhost${req.url}`).searchParams.get('nonce'),
          model: 'e2ee-qwen3-30b-a3b-p',
          signing_key: mockTeeKeypair.pubKeyHex, // valid secp256k1 pubkey
          server_verification: {
            tdx: { valid: true },
            signingAddressBinding: { bound: true },
            nonceBinding: { bound: true },
            verifiedAt: new Date().toISOString(),
            verificationDurationMs: 100,
          },
        }));
        return;
      }

      if (req.method === 'POST' && req.url === '/api/v1/chat/completions') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          lastReceivedBody = JSON.parse(body);

          // Check for E2EE headers
          const clientPubKey = req.headers['x-venice-tee-client-pub-key'] as string | undefined;
          const hasE2EEHeaders = clientPubKey && req.headers['x-venice-tee-model-pub-key'];

          if (hasE2EEHeaders) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
            });
            for (const text of ['Hello', ' from', ' E2EE']) {
              const content = await encryptForClient(clientPubKey, text);
              res.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`);
            }
            res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Missing E2EE headers' } }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });
    await new Promise<void>(resolve => mockVenice.listen(0, '127.0.0.1', resolve));

    const mockAddress = mockVenice.address() as { port: number };
    const config = testConfig({
      venice_base_url: `http://127.0.0.1:${mockAddress.port}`,
      verify_attestation: false, // Disable for mock server testing
    });
    const result = createServer(config);
    sessionManager = result.sessionManager;
    proxyServer = result.app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => proxyServer.once('listening', resolve));
  });

  afterAll(async () => {
    sessionManager.destroy();
    await Promise.all([
      new Promise<void>(resolve => proxyServer.close(() => resolve())),
      new Promise<void>(resolve => mockVenice.close(() => resolve())),
    ]);
  });

  it('handles E2EE streaming request', async () => {
    const result = await streamRequest(proxyServer, '/v1/chat/completions', {
      model: 'e2ee-qwen3-30b-a3b-p',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });
    expect(result.status).toBe(200);
    expect(result.events).toContain('[DONE]');

    // Verify we got decrypted content back
    const contentEvents = result.events
      .filter(e => e !== '[DONE]')
      .map(e => JSON.parse(e));

    const fullText = contentEvents
      .map(e => e.choices?.[0]?.delta?.content || '')
      .join('');
    expect(fullText).toBe('Hello from E2EE');
  });

  it('handles E2EE non-streaming request', async () => {
    const res = await request(proxyServer, 'POST', '/v1/chat/completions', {
      model: 'e2ee-qwen3-30b-a3b-p',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.object).toBe('chat.completion');
    expect(body.choices[0].message.role).toBe('assistant');
    expect(body.choices[0].message.content).toBe('Hello from E2EE');
    expect(body.choices[0].finish_reason).toBe('stop');
  });

  it('sends E2EE headers to Venice', async () => {
    await request(proxyServer, 'POST', '/v1/chat/completions', {
      model: 'e2ee-qwen3-30b-a3b-p',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    // The proxy should have sent E2EE headers
    expect(lastReceivedHeaders['x-venice-tee-client-pub-key']).toBeDefined();
    expect(lastReceivedHeaders['x-venice-tee-model-pub-key']).toBeDefined();
    expect(lastReceivedHeaders['x-venice-tee-signing-algo']).toBe('ecdsa');
  });

  it('sends encrypted messages to Venice', async () => {
    await request(proxyServer, 'POST', '/v1/chat/completions', {
      model: 'e2ee-qwen3-30b-a3b-p',
      messages: [{ role: 'user', content: 'Secret message' }],
    });

    // Messages should be encrypted (hex strings, not plaintext)
    const messages = lastReceivedBody.messages;
    expect(messages).toBeDefined();
    expect(messages[0].role).toBe('user');
    // Encrypted content is a hex string much longer than the plaintext
    expect(messages[0].content.length).toBeGreaterThan('Secret message'.length * 2);
    expect(messages[0].content).not.toBe('Secret message');
  });

  it('includes venice_parameters with enable_e2ee', async () => {
    await request(proxyServer, 'POST', '/v1/chat/completions', {
      model: 'e2ee-qwen3-30b-a3b-p',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(lastReceivedBody.venice_parameters).toBeDefined();
    expect(lastReceivedBody.venice_parameters.enable_e2ee).toBe(true);
  });

  it('always requests streaming from Venice (even for non-streaming client request)', async () => {
    await request(proxyServer, 'POST', '/v1/chat/completions', {
      model: 'e2ee-qwen3-30b-a3b-p',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
    });

    // Proxy always streams from Venice (to decrypt chunks)
    expect(lastReceivedBody.stream).toBe(true);
  });

  it('handles parallel E2EE requests', async () => {
    const promises = Array.from({ length: 5 }, (_, i) =>
      request(proxyServer, 'POST', '/v1/chat/completions', {
        model: 'e2ee-qwen3-30b-a3b-p',
        messages: [{ role: 'user', content: `Hello ${i}` }],
        stream: false,
      })
    );

    const results = await Promise.all(promises);
    for (const res of results) {
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.choices[0].message.content).toBe('Hello from E2EE');
    }
  });

  it('reuses session across requests', async () => {
    // First request creates a session
    await request(proxyServer, 'POST', '/v1/chat/completions', {
      model: 'e2ee-qwen3-30b-a3b-p',
      messages: [{ role: 'user', content: 'First' }],
      stream: false,
    });
    const firstPubKey = lastReceivedHeaders['x-venice-tee-client-pub-key'];

    // Second request should reuse the same session
    await request(proxyServer, 'POST', '/v1/chat/completions', {
      model: 'e2ee-qwen3-30b-a3b-p',
      messages: [{ role: 'user', content: 'Second' }],
      stream: false,
    });
    const secondPubKey = lastReceivedHeaders['x-venice-tee-client-pub-key'];

    expect(firstPubKey).toBe(secondPubKey);
  });
});

describe('E2EE function calling', () => {
  let mockVenice: http.Server;
  let proxyServer: http.Server;
  let sessionManager: ReturnType<typeof createServer>['sessionManager'];
  let lastReceivedBody: any;
  /** Chunks the mock TEE emits as assistant content, encrypted on the way out. */
  let responseChunks: string[] = [];

  const weatherTool = {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the current weather in a given city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  };

  beforeAll(async () => {
    mockVenice = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/api/v1/tee/attestation')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          verified: true,
          nonce: new URL(`http://localhost${req.url}`).searchParams.get('nonce'),
          model: 'e2ee-glm-5-2-p',
          signing_key: mockTeeKeypair.pubKeyHex,
        }));
        return;
      }

      if (req.method === 'POST' && req.url === '/api/v1/chat/completions') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
          lastReceivedBody = JSON.parse(body);
          const clientPubKey = req.headers['x-venice-tee-client-pub-key'] as string;
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          for (const chunk of responseChunks) {
            const content = await encryptForClient(clientPubKey, chunk);
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`);
          }
          res.write('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });
    await new Promise<void>(resolve => mockVenice.listen(0, '127.0.0.1', resolve));

    const mockAddress = mockVenice.address() as { port: number };
    const config = testConfig({
      venice_base_url: `http://127.0.0.1:${mockAddress.port}`,
      verify_attestation: false,
    });
    const result = createServer(config);
    sessionManager = result.sessionManager;
    proxyServer = result.app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => proxyServer.once('listening', resolve));
  });

  afterAll(async () => {
    sessionManager.destroy();
    await Promise.all([
      new Promise<void>(resolve => proxyServer.close(() => resolve())),
      new Promise<void>(resolve => mockVenice.close(() => resolve())),
    ]);
  });

  it('never sends tool schemas to Venice in plaintext', async () => {
    responseChunks = ['ok'];
    await request(proxyServer, 'POST', '/v1/chat/completions', {
      model: 'e2ee-glm-5-2-p',
      messages: [{ role: 'user', content: 'Weather in Bratislava?' }],
      tools: [weatherTool],
      tool_choice: 'auto',
    });

    // The plaintext tool params must not survive into the upstream request...
    expect(lastReceivedBody.tools).toBeUndefined();
    expect(lastReceivedBody.tool_choice).toBeUndefined();
    // ...and no tool name or description may appear anywhere in the body.
    const wire = JSON.stringify(lastReceivedBody);
    expect(wire).not.toContain('get_weather');
    expect(wire).not.toContain('Get the current weather');
    expect(wire).not.toContain('Bratislava');
  });

  it('carries the tool schemas in an encrypted system message', async () => {
    responseChunks = ['ok'];
    await request(proxyServer, 'POST', '/v1/chat/completions', {
      model: 'e2ee-glm-5-2-p',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [weatherTool],
    });

    // A system turn is prepended, and every message is ciphertext.
    expect(lastReceivedBody.messages[0].role).toBe('system');
    for (const msg of lastReceivedBody.messages) {
      expect(msg.content).toMatch(/^[0-9a-f]+$/);
    }
  });

  it('parses a tool call out of the response (non-streaming)', async () => {
    responseChunks = ['<tool_call>\n{"name":"get_weather","arguments":{"city":"Bratislava"}}\n</tool_call>'];
    const res = await request(proxyServer, 'POST', '/v1/chat/completions', {
      model: 'e2ee-glm-5-2-p',
      messages: [{ role: 'user', content: 'Weather?' }],
      tools: [weatherTool],
    });

    const body = JSON.parse(res.body);
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.choices[0].message.content).toBeNull();
    const calls = body.choices[0].message.tool_calls;
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('get_weather');
    expect(JSON.parse(calls[0].function.arguments)).toEqual({ city: 'Bratislava' });
  });

  it('emits tool calls as OpenAI SSE deltas when streaming', async () => {
    responseChunks = ['Checking. ', '<tool_call>\n{"name":"get_wea', 'ther","arguments":{"city":"Nitra"}}\n</tool_call>'];
    const result = await streamRequest(proxyServer, '/v1/chat/completions', {
      model: 'e2ee-glm-5-2-p',
      messages: [{ role: 'user', content: 'Weather?' }],
      tools: [weatherTool],
      stream: true,
    });

    const events = result.events.filter(e => e !== '[DONE]').map(e => JSON.parse(e));
    const toolDeltas = events.flatMap(e => e.choices?.[0]?.delta?.tool_calls || []);
    expect(toolDeltas).toHaveLength(1);
    expect(toolDeltas[0].index).toBe(0);
    expect(toolDeltas[0].function.name).toBe('get_weather');

    // Prose before the block still reaches the client, and the tag never leaks.
    const text = events.map(e => e.choices?.[0]?.delta?.content || '').join('');
    expect(text).toBe('Checking. ');
    expect(events.some(e => e.choices?.[0]?.finish_reason === 'tool_calls')).toBe(true);
  });

  it('encrypts tool results sent back by the client', async () => {
    responseChunks = ['It is raining.'];
    const res = await request(proxyServer, 'POST', '/v1/chat/completions', {
      model: 'e2ee-glm-5-2-p',
      messages: [
        { role: 'user', content: 'Weather?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Bratislava"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '{"temp":19}' },
      ],
      tools: [weatherTool],
    });

    expect(res.status).toBe(200);
    // The assistant's tool_calls must not ride along as plaintext metadata.
    const assistant = lastReceivedBody.messages.find((m: any) => m.role === 'assistant');
    expect(assistant.tool_calls).toBeUndefined();
    expect(JSON.stringify(lastReceivedBody)).not.toContain('temp');
    // The tool turn survives as an encrypted message.
    expect(lastReceivedBody.messages.some((m: any) => m.role === 'tool')).toBe(true);

    expect(JSON.parse(res.body).choices[0].message.content).toBe('It is raining.');
  });

  it('does not offer tools when tool_choice is none', async () => {
    responseChunks = ['no tools used'];
    await request(proxyServer, 'POST', '/v1/chat/completions', {
      model: 'e2ee-glm-5-2-p',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [weatherTool],
      tool_choice: 'none',
    });

    // No system prompt is injected, so only the original user turn is sent.
    expect(lastReceivedBody.messages).toHaveLength(1);
    expect(lastReceivedBody.messages[0].role).toBe('user');
  });

  it('leaves tool_call markup alone when the request has no tools', async () => {
    responseChunks = ['<tool_call>\n{"name":"x","arguments":{}}\n</tool_call>'];
    const res = await request(proxyServer, 'POST', '/v1/chat/completions', {
      model: 'e2ee-glm-5-2-p',
      messages: [{ role: 'user', content: 'Print a tool_call example' }],
    });

    const body = JSON.parse(res.body);
    expect(body.choices[0].message.tool_calls).toBeUndefined();
    expect(body.choices[0].message.content).toContain('<tool_call>');
    expect(body.choices[0].finish_reason).toBe('stop');
  });
});

describe('E2EE with Venice error responses', () => {
  let mockVenice: http.Server;
  let proxyServer: http.Server;
  let sessionManager: ReturnType<typeof createServer>['sessionManager'];

  beforeAll(async () => {
    mockVenice = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/api/v1/tee/attestation')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          verified: true,
          nonce: new URL(`http://localhost${req.url}`).searchParams.get('nonce'),
          model: 'e2ee-qwen3-30b-a3b-p',
          signing_key: mockTeeKeypair.pubKeyHex,
          server_verification: {
            tdx: { valid: true },
            signingAddressBinding: { bound: true },
            nonceBinding: { bound: true },
            verifiedAt: new Date().toISOString(),
            verificationDurationMs: 100,
          },
        }));
        return;
      }

      if (req.method === 'POST' && req.url === '/api/v1/chat/completions') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          // Simulate Venice API error
          res.writeHead(429, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            error: { message: 'Rate limit exceeded', type: 'rate_limit_error' },
          }));
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });
    await new Promise<void>(resolve => mockVenice.listen(0, '127.0.0.1', resolve));

    const mockAddress = mockVenice.address() as { port: number };
    const config = testConfig({
      venice_base_url: `http://127.0.0.1:${mockAddress.port}`,
      verify_attestation: false,
    });
    const result = createServer(config);
    sessionManager = result.sessionManager;
    proxyServer = result.app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => proxyServer.once('listening', resolve));
  });

  afterAll(async () => {
    sessionManager.destroy();
    await Promise.all([
      new Promise<void>(resolve => proxyServer.close(() => resolve())),
      new Promise<void>(resolve => mockVenice.close(() => resolve())),
    ]);
  });

  it('forwards Venice API errors with correct status code', async () => {
    const res = await request(proxyServer, 'POST', '/v1/chat/completions', {
      model: 'e2ee-qwen3-30b-a3b-p',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(res.status).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain('Rate limit');
  });
});

describe('TEE-only requests (tee- prefix)', () => {
  let mockVenice: http.Server;
  let proxyServer: http.Server;
  let sessionManager: ReturnType<typeof createServer>['sessionManager'];
  let attestedModels: string[];
  let lastReceivedHeaders: http.IncomingHttpHeaders;
  let lastReceivedBody: any;

  const TOOLS = [{
    type: 'function' as const,
    function: {
      name: 'get_weather',
      description: 'Get the current weather in a given city',
      parameters: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  }];

  beforeAll(async () => {
    mockVenice = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/api/v1/tee/attestation')) {
        const params = new URL(`http://localhost${req.url}`).searchParams;
        attestedModels.push(params.get('model')!);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          verified: true,
          nonce: params.get('nonce'),
          model: params.get('model'),
          signing_key: mockTeeKeypair.pubKeyHex,
          server_verification: {
            tdx: { valid: true },
            signingAddressBinding: { bound: true },
            nonceBinding: { bound: true },
            verifiedAt: new Date().toISOString(),
            verificationDurationMs: 100,
          },
        }));
        return;
      }

      if (req.method === 'POST' && req.url === '/api/v1/chat/completions') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          lastReceivedHeaders = req.headers;
          lastReceivedBody = JSON.parse(body);

          // Venice's native function calling: tools arrive as a normal request
          // parameter and come back as native tool_calls.
          const message = lastReceivedBody.tools
            ? {
                role: 'assistant',
                content: null,
                tool_calls: [{
                  id: 'call_abc123',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{"city":"Bratislava"}' },
                }],
              }
            : { role: 'assistant', content: 'Hello from the TEE' };

          if (lastReceivedBody.stream) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            res.write(`data: ${JSON.stringify({
              id: 'chatcmpl-tee',
              object: 'chat.completion.chunk',
              model: lastReceivedBody.model,
              choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
            })}\n\n`);
            res.write(`data: ${JSON.stringify({
              id: 'chatcmpl-tee',
              object: 'chat.completion.chunk',
              model: lastReceivedBody.model,
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            })}\n\n`);
            res.write('data: [DONE]\n\n');
            res.end();
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              id: 'chatcmpl-tee',
              object: 'chat.completion',
              model: lastReceivedBody.model,
              choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
            }));
          }
        });
        return;
      }

      res.writeHead(404);
      res.end();
    });
    await new Promise<void>(resolve => mockVenice.listen(0, '127.0.0.1', resolve));

    const mockAddress = mockVenice.address() as { port: number };
    const config = testConfig({
      venice_base_url: `http://127.0.0.1:${mockAddress.port}`,
      verify_attestation: false, // the mock cannot produce a real TDX quote
    });
    const result = createServer(config);
    sessionManager = result.sessionManager;
    proxyServer = result.app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => proxyServer.once('listening', resolve));
  });

  beforeEach(() => {
    attestedModels = [];
    lastReceivedBody = undefined;
    lastReceivedHeaders = {};
  });

  afterAll(async () => {
    sessionManager.destroy();
    await Promise.all([
      new Promise<void>(resolve => proxyServer.close(() => resolve())),
      new Promise<void>(resolve => mockVenice.close(() => resolve())),
    ]);
  });

  it('strips the tee- prefix before forwarding to Venice', async () => {
    const res = await request(proxyServer, 'POST', '/v1/chat/completions', {
      model: 'tee-e2ee-glm-5-2-p',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
    });
    expect(res.status).toBe(200);
    expect(lastReceivedBody.model).toBe('e2ee-glm-5-2-p');
  });

  it('attests the stripped model before the prompt leaves the proxy', async () => {
    sessionManager.invalidateSession('e2ee-glm-5-2-p');
    await request(proxyServer, 'POST', '/v1/chat/completions', {
      model: 'tee-e2ee-glm-5-2-p',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
    });
    expect(attestedModels).toContain('e2ee-glm-5-2-p');
  });

  it('sends messages in plaintext with no E2EE headers', async () => {
    await request(proxyServer, 'POST', '/v1/chat/completions', {
      model: 'tee-e2ee-glm-5-2-p',
      messages: [{ role: 'user', content: 'the secret is hunter2' }],
      stream: false,
    });
    expect(lastReceivedBody.messages).toEqual([{ role: 'user', content: 'the secret is hunter2' }]);
    expect(lastReceivedHeaders['x-venice-tee-client-pub-key']).toBeUndefined();
    expect(lastReceivedHeaders['x-venice-tee-model-pub-key']).toBeUndefined();
    expect(lastReceivedHeaders['x-venice-tee-signing-algo']).toBeUndefined();
  });

  it('pins enable_e2ee to false and keeps the caller venice_parameters', async () => {
    await request(proxyServer, 'POST', '/v1/chat/completions', {
      model: 'tee-e2ee-glm-5-2-p',
      messages: [{ role: 'user', content: 'Hello' }],
      venice_parameters: { include_venice_system_prompt: false },
      stream: false,
    });
    expect(lastReceivedBody.venice_parameters).toEqual({
      include_venice_system_prompt: false,
      enable_e2ee: false,
    });
  });

  it('forwards tools natively instead of rewriting them into a system prompt', async () => {
    const res = await request(proxyServer, 'POST', '/v1/chat/completions', {
      model: 'tee-e2ee-glm-5-2-p',
      messages: [{ role: 'user', content: 'What is the weather in Bratislava?' }],
      tools: TOOLS,
      stream: false,
    });

    expect(lastReceivedBody.tools).toEqual(TOOLS);
    // No injected schema prompt: the message list is untouched.
    expect(lastReceivedBody.messages).toHaveLength(1);
    expect(lastReceivedBody.messages[0].role).toBe('user');

    const body = JSON.parse(res.body);
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.choices[0].message.tool_calls[0].function.name).toBe('get_weather');
  });

  it('echoes the prefixed model ID back to the client (non-streaming)', async () => {
    const res = await request(proxyServer, 'POST', '/v1/chat/completions', {
      model: 'tee-e2ee-glm-5-2-p',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: false,
    });
    expect(JSON.parse(res.body).model).toBe('tee-e2ee-glm-5-2-p');
  });

  it('echoes the prefixed model ID back in every stream chunk', async () => {
    const result = await streamRequest(proxyServer, '/v1/chat/completions', {
      model: 'tee-e2ee-glm-5-2-p',
      messages: [{ role: 'user', content: 'Hello' }],
      stream: true,
    });

    expect(result.status).toBe(200);
    expect(result.events).toContain('[DONE]');

    const chunks = result.events.filter(e => e !== '[DONE]').map(e => JSON.parse(e));
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.model).toBe('tee-e2ee-glm-5-2-p');
    }
    expect(chunks.map(c => c.choices[0].delta.content || '').join('')).toBe('Hello');
  });

  it('rejects a bare tee- prefix with 400', async () => {
    const res = await request(proxyServer, 'POST', '/v1/chat/completions', {
      model: 'tee-',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.message).toContain('tee- prefix');
  });
});

describe('Config loading', () => {
  it('loads config with defaults', async () => {
    const { loadConfig } = await import('../src/config.js');

    // Set required env var
    const origKey = process.env.VENICE_API_KEY;
    process.env.VENICE_API_KEY = 'test-key';

    try {
      const config = loadConfig('/nonexistent/config.yaml');
      expect(config.port).toBe(3000);
      expect(config.host).toBe('127.0.0.1');
      expect(config.venice_api_key).toBe('test-key');
      expect(config.verify_attestation).toBe(true);
      expect(config.enable_dcap).toBe(true);
      expect(config.session_ttl).toBe(1800000);
    } finally {
      if (origKey !== undefined) {
        process.env.VENICE_API_KEY = origKey;
      } else {
        delete process.env.VENICE_API_KEY;
      }
    }
  });

  it('throws when VENICE_API_KEY is missing', async () => {
    const { loadConfig } = await import('../src/config.js');

    const origKey = process.env.VENICE_API_KEY;
    delete process.env.VENICE_API_KEY;

    try {
      expect(() => loadConfig('/nonexistent/config.yaml')).toThrow('VENICE_API_KEY');
    } finally {
      if (origKey !== undefined) {
        process.env.VENICE_API_KEY = origKey;
      }
    }
  });

  it('ignores an api key set in the config file', async () => {
    const { loadConfig } = await import('../src/config.js');
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'venice-cfg-'));
    const cfgPath = path.join(dir, 'config.yaml');
    fs.writeFileSync(cfgPath, 'port: 4242\nvenice_api_key: "key-from-file"\n');

    const origKey = process.env.VENICE_API_KEY;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      // With the env var set, the file's key must not win.
      process.env.VENICE_API_KEY = 'key-from-env';
      const config = loadConfig(cfgPath);
      expect(config.venice_api_key).toBe('key-from-env');
      expect(config.port).toBe(4242); // other file values still load
      expect(warn).toHaveBeenCalled();

      // With no env var, a key in the file is not a substitute.
      delete process.env.VENICE_API_KEY;
      expect(() => loadConfig(cfgPath)).toThrow('VENICE_API_KEY');
    } finally {
      warn.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
      if (origKey !== undefined) process.env.VENICE_API_KEY = origKey;
      else delete process.env.VENICE_API_KEY;
    }
  });

  it('env vars override config defaults', async () => {
    const { loadConfig } = await import('../src/config.js');

    const origKey = process.env.VENICE_API_KEY;
    const origPort = process.env.PORT;
    const origVerify = process.env.VERIFY_ATTESTATION;

    process.env.VENICE_API_KEY = 'env-key';
    process.env.PORT = '8080';
    process.env.VERIFY_ATTESTATION = 'false';

    try {
      const config = loadConfig('/nonexistent/config.yaml');
      expect(config.venice_api_key).toBe('env-key');
      expect(config.port).toBe(8080);
      expect(config.verify_attestation).toBe(false);
    } finally {
      if (origKey !== undefined) process.env.VENICE_API_KEY = origKey;
      else delete process.env.VENICE_API_KEY;
      if (origPort !== undefined) process.env.PORT = origPort;
      else delete process.env.PORT;
      if (origVerify !== undefined) process.env.VERIFY_ATTESTATION = origVerify;
      else delete process.env.VERIFY_ATTESTATION;
    }
  });
});

describe('SessionManager', () => {
  it('identifies E2EE models correctly', async () => {
    const { SessionManager } = await import('../src/session-manager.js');
    const mgr = new SessionManager(testConfig());

    expect(mgr.isE2EE('e2ee-qwen3-30b-a3b-p')).toBe(true);
    expect(mgr.isE2EE('e2ee-llama-70b')).toBe(true);
    expect(mgr.isE2EE('qwen3-30b-a3b-p')).toBe(false);
    expect(mgr.isE2EE('gpt-4')).toBe(false);

    mgr.destroy();
  });
});

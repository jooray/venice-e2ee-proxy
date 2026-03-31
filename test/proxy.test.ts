import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer } from '../src/server.js';
import type { ProxyConfig } from '../src/config.js';
import type { Express } from 'express';
import http from 'node:http';
import { generateKeypair } from 'venice-e2ee';

// Generate a valid secp256k1 keypair for the mock TEE
const mockTeeKeypair = generateKeypair();

// Helper: create a test config
function testConfig(overrides?: Partial<ProxyConfig>): ProxyConfig {
  return {
    port: 0, // random port
    host: '127.0.0.1',
    venice_api_key: 'test-key-123',
    venice_base_url: 'http://127.0.0.1:0', // will be overridden in tests
    verify_attestation: true,
    enable_dcap: false,
    endpoint_passthru: false,
    e2ee_allow_tools: false,
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
    expect(body.endpoint_passthru).toBe(false);
    expect(body.e2ee_allow_tools).toBe(false);
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

describe('ENDPOINT_PASSTHRU (Venice path forwarding)', () => {
  let mockVenice: http.Server;
  let proxyServer: http.Server;
  let sessionManager: ReturnType<typeof createServer>['sessionManager'];

  beforeAll(async () => {
    mockVenice = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/v1/extra') {
        const auth = req.headers['authorization'];
        if (!auth || !auth.includes('test-key')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ passthru: true }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/v1/rate-limited') {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Too many requests' } }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>(resolve => mockVenice.listen(0, '127.0.0.1', resolve));

    const mockAddress = mockVenice.address() as { port: number };
    const config = testConfig({
      venice_base_url: `http://127.0.0.1:${mockAddress.port}`,
      endpoint_passthru: true,
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

  it('forwards GET to an arbitrary Venice path with proxy authorization', async () => {
    const res = await request(proxyServer, 'GET', '/api/v1/extra');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.passthru).toBe(true);
  });

  it('forwards Venice HTTP error responses unchanged', async () => {
    const res = await request(proxyServer, 'GET', '/api/v1/rate-limited');
    expect(res.status).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.error.message).toContain('Too many');
  });
});

describe('Passthrough (non-E2EE) requests', () => {
  let mockVenice: http.Server;
  let proxyServer: http.Server;
  let sessionManager: ReturnType<typeof createServer>['sessionManager'];

  beforeAll(async () => {
    // Create a mock Venice API server
    mockVenice = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url?.startsWith('/api/v1/models')) {
        const auth = req.headers['authorization'];
        if (!auth || !auth.includes('test-key')) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list',
          data: [{ id: 'qwen3-30b-a3b-p', object: 'model' }],
        }));
        return;
      }
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

  it('forwards GET /v1/models to Venice with authorization', async () => {
    const res = await request(proxyServer, 'GET', '/v1/models');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.object).toBe('list');
    expect(body.data[0].id).toBe('qwen3-30b-a3b-p');
  });

  it('forwards GET /models to the same Venice models list', async () => {
    const res = await request(proxyServer, 'GET', '/models');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data[0].id).toBe('qwen3-30b-a3b-p');
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
        req.on('end', () => {
          lastReceivedBody = JSON.parse(body);

          // Check for E2EE headers
          const hasE2EEHeaders = req.headers['x-venice-tee-client-pub-key'] &&
            req.headers['x-venice-tee-model-pub-key'];

          if (hasE2EEHeaders) {
            // For E2EE requests, Venice returns encrypted chunks
            // Since we can't actually encrypt in the mock, we'll return
            // plaintext short strings (which pass through decryptChunk as-is)
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
            });
            // Short non-hex strings pass through decryptChunk as plaintext
            res.write('data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n');
            res.write('data: {"choices":[{"delta":{"content":" from"},"finish_reason":null}]}\n\n');
            res.write('data: {"choices":[{"delta":{"content":" E2EE"},"finish_reason":null}]}\n\n');
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

  it('strips tools from E2EE requests by default', async () => {
    await request(proxyServer, 'POST', '/v1/chat/completions', {
      model: 'e2ee-qwen3-30b-a3b-p',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [{ type: 'function', function: { name: 'fn', parameters: {} } }],
      tool_choice: 'auto',
      parallel_tool_calls: true,
    });

    expect(lastReceivedBody.tools).toBeUndefined();
    expect(lastReceivedBody.tool_choice).toBeUndefined();
    expect(lastReceivedBody.parallel_tool_calls).toBeUndefined();
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

describe('E2EE with e2ee_allow_tools enabled', () => {
  let mockVenice: http.Server;
  let proxyServer: http.Server;
  let sessionManager: ReturnType<typeof createServer>['sessionManager'];
  let lastReceivedBody: any;

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
          lastReceivedBody = JSON.parse(body);
          const hasE2EEHeaders = req.headers['x-venice-tee-client-pub-key'] &&
            req.headers['x-venice-tee-model-pub-key'];
          if (hasE2EEHeaders) {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
            });
            res.write('data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n');
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
      verify_attestation: false,
      e2ee_allow_tools: true,
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

  it('forwards tools and related fields to Venice', async () => {
    const tools = [{ type: 'function', function: { name: 'fn', parameters: {} } }];
    await request(proxyServer, 'POST', '/v1/chat/completions', {
      model: 'e2ee-qwen3-30b-a3b-p',
      messages: [{ role: 'user', content: 'Hello' }],
      tools,
      tool_choice: 'auto',
      parallel_tool_calls: true,
      stream: false,
    });

    expect(lastReceivedBody.tools).toEqual(tools);
    expect(lastReceivedBody.tool_choice).toBe('auto');
    expect(lastReceivedBody.parallel_tool_calls).toBe(true);
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
      expect(config.endpoint_passthru).toBe(false);
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

  it('env vars override config defaults', async () => {
    const { loadConfig } = await import('../src/config.js');

    const origKey = process.env.VENICE_API_KEY;
    const origPort = process.env.PORT;
    const origVerify = process.env.VERIFY_ATTESTATION;
    const origPassthru = process.env.ENDPOINT_PASSTHRU;

    process.env.VENICE_API_KEY = 'env-key';
    process.env.PORT = '8080';
    process.env.VERIFY_ATTESTATION = 'false';
    process.env.ENDPOINT_PASSTHRU = 'true';

    try {
      const config = loadConfig('/nonexistent/config.yaml');
      expect(config.venice_api_key).toBe('env-key');
      expect(config.port).toBe(8080);
      expect(config.verify_attestation).toBe(false);
      expect(config.endpoint_passthru).toBe(true);
    } finally {
      if (origKey !== undefined) process.env.VENICE_API_KEY = origKey;
      else delete process.env.VENICE_API_KEY;
      if (origPort !== undefined) process.env.PORT = origPort;
      else delete process.env.PORT;
      if (origVerify !== undefined) process.env.VERIFY_ATTESTATION = origVerify;
      else delete process.env.VERIFY_ATTESTATION;
      if (origPassthru !== undefined) process.env.ENDPOINT_PASSTHRU = origPassthru;
      else delete process.env.ENDPOINT_PASSTHRU;
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

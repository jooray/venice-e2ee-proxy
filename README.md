# venice-e2ee-proxy

A local proxy server that transparently encrypts [OpenAI-compatible](https://platform.openai.com/docs/api-reference/chat) API requests using [Venice AI's](https://venice.ai) end-to-end encryption (E2EE) protocol.

Your prompts are encrypted locally before leaving your machine and can only be decrypted inside Venice's Trusted Execution Environment (Intel TDX). Venice never sees your plaintext prompts or responses.

## How It Works

```
Your app / curl                venice-e2ee-proxy               Venice API (TEE)
      |                              |                              |
      |  POST /v1/chat/completions   |                              |
      |  (plaintext, OpenAI format)  |                              |
      |----------------------------->|                              |
      |                              |  1. ECDH key exchange        |
      |                              |  2. Verify TEE attestation   |
      |                              |  3. Encrypt messages         |
      |                              |  POST /api/v1/chat/completions
      |                              |  (encrypted + E2EE headers)  |
      |                              |----------------------------->|
      |                              |                              |
      |                              |  SSE stream (encrypted)      |
      |                              |<-----------------------------|
      |                              |  4. Decrypt each chunk       |
      |  SSE stream (plaintext)      |                              |
      |<-----------------------------|                              |
```

The proxy handles:

- **ECDH key exchange** (secp256k1) with the TEE
- **TEE attestation verification** (Intel TDX quote parsing, nonce binding, signing key binding)
- **Optional full DCAP verification** (PCK certificate chain, quote signatures, TCB evaluation)
- **AES-256-GCM encryption** of all messages
- **Per-chunk decryption** of streaming responses (each chunk uses a fresh server ephemeral key)
- **Session caching** with configurable TTL (default 30 minutes)
- **Parallel request handling** (sessions are safely shared across concurrent requests)

## Quick Start

```bash
# Clone with submodule
git clone --recurse-submodules https://github.com/jooray/venice-e2ee-proxy.git
cd venice-e2ee-proxy

# Install dependencies
npm install

# Set your Venice API key
cp .env.example .env
# edit .env and set VENICE_API_KEY

# Start the proxy
npm run dev

# In another terminal, send a request
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "e2ee-qwen3-30b-a3b-p",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": true
  }'
```

## Installation

### Prerequisites

- Node.js 20+
- A [Venice AI](https://venice.ai) API key

### Setup

```bash
git clone --recurse-submodules https://github.com/jooray/venice-e2ee-proxy.git
cd venice-e2ee-proxy
npm install
```

If you cloned without `--recurse-submodules`:

```bash
git submodule update --init --recursive
npm install
```

### Build (optional, for production)

```bash
npm run build
npm start
```

## Running with Docker

You need [Docker](https://docs.docker.com/get-docker/) and Docker Compose (v2: `docker compose`). Only `docker-compose.yml` is versioned; name any custom file differently (for example `docker-compose.local.yml`) and point Compose at it with `docker compose -f …`.

1. Copy and edit environment variables:

   ```bash
   cp .env.example .env
   # Set VENICE_API_KEY (required)
   ```

2. Build and start the container:

   ```bash
   docker compose up -d --build
   ```

The image is built from the `Dockerfile` in this repo. If `VENICE_PROXY_REF` is not set, the build uses **`main`** (whatever tip is at clone time). Set `VENICE_PROXY_REF` to a branch name, tag, or full commit SHA when you want a specific revision or a reproducible image. You can also set `VENICE_PROXY_REPO` to clone from a fork.

Inside the container the proxy listens on `0.0.0.0`. Compose maps it to the host as `127.0.0.1:<port>:<port>` only (not exposed on all interfaces). Set `PORT` to change the listen and publish port (default `3000`).

Check health:

```bash
curl http://127.0.0.1:3000/health
```

Stop:

```bash
docker compose down
```

## Configuration

Configuration is loaded from `config.yaml` (optional) with environment variable overrides. `.env` is loaded automatically at startup. Copy the example to get started:

```bash
cp config.example.yaml config.yaml
cp .env.example .env
# Edit .env to add your VENICE_API_KEY
```

### Environment Variables

| Variable | Default | Description |
|---|---|---|
| `VENICE_API_KEY` | (required) | Your Venice AI API key |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | Host to bind to |
| `VENICE_BASE_URL` | `https://api.venice.ai` | Venice API base URL |
| `VERIFY_ATTESTATION` | `true` | Verify TEE attestation (recommended) |
| `ENABLE_DCAP` | `true` | Full DCAP quote verification |
| `SESSION_TTL` | `1800000` | Session TTL in ms (default: 30 min) |
| `LOG_LEVEL` | `info` | Log level: debug, info, warn, error |
| `ENDPOINT_PASSTHRU` | `false` | When `true` or `1`, forward any request that does not match a built-in route to Venice using the same method, path, query string, and body. Uses the proxy’s API key (`Authorization` from the client is replaced). Venice’s status code and body are returned as-is. Network failures still yield a `502` from the proxy. |
| `E2EE_ALLOW_TOOLS` | `false` | When `true` or `1`, forward `tools`, `tool_choice`, and `parallel_tool_calls` on E2EE (`e2ee-*`) chat completions. Default strips them: many models do not support tools under E2EE, and tool-related content in the assistant reply is not decrypted by this proxy. |

### config.yaml

```yaml
port: 3000
host: "127.0.0.1"
venice_base_url: "https://api.venice.ai"
verify_attestation: true
enable_dcap: true
endpoint_passthru: false
e2ee_allow_tools: false
session_ttl: 1800000
log_level: "info"
```

Environment variables always override config.yaml values.

### Attestation Verification

The proxy supports two levels of attestation verification:

**Level 1 (verify_attestation: true)** - Always recommended:
- Parses the Intel TDX quote binary
- Rejects debug-mode TEEs
- Verifies your client nonce in REPORTDATA (prevents replay attacks)
- Verifies the signing key's Ethereum address in REPORTDATA
- Cross-checks Venice's server-side verification results

**Level 2 (enable_dcap: true)** - Full verification:
- Everything in Level 1, plus:
- PCK certificate chain validation up to Intel SGX Root CA
- ECDSA P-256 quote signature verification
- QE identity validation
- TCB level evaluation and CRL checking
- Requires `@phala/dcap-qvl` (included in this proxy's dependencies)

To disable all verification (not recommended):
```yaml
verify_attestation: false
enable_dcap: false
```

## Usage

### E2EE Models

Send requests with models prefixed with `e2ee-`. The proxy will handle encryption/decryption transparently.

By default, **tool-calling parameters** (`tools`, `tool_choice`, `parallel_tool_calls`) are removed before the request is sent to Venice, because tool-related assistant output is not decrypted in the streaming path. To experiment with tools anyway, set `e2ee_allow_tools: true` in `config.yaml` or `E2EE_ALLOW_TOOLS=true` in the environment (see [Configuration](#configuration)).

```bash
# Streaming (default)
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "e2ee-qwen3-30b-a3b-p",
    "messages": [{"role": "user", "content": "What is the meaning of life?"}],
    "stream": true
  }'

# Non-streaming
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "e2ee-qwen3-30b-a3b-p",
    "messages": [{"role": "user", "content": "What is the meaning of life?"}],
    "stream": false
  }'
```

### Non-E2EE Models (Passthrough)

Models without the `e2ee-` prefix are forwarded to Venice transparently with just the authorization header added:

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3-30b-a3b-p",
    "messages": [{"role": "user", "content": "Hello"}],
    "stream": false
  }'
```

### Parallel Requests

The proxy handles concurrent requests safely. Sessions are cached per model and shared across requests (encryption uses fresh IVs, decryption uses per-chunk ephemeral keys from the server):

```bash
# Fire 5 requests in parallel
for i in $(seq 1 5); do
  curl -s http://127.0.0.1:3000/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d "{\"model\": \"e2ee-qwen3-30b-a3b-p\", \"messages\": [{\"role\": \"user\", \"content\": \"Count to $i\"}], \"stream\": false}" &
done
wait
```

### Health Check

```bash
curl http://127.0.0.1:3000/health
```

### API Compatibility

Standard OpenAI-compatible API:

- `POST /v1/chat/completions`
- `POST /chat/completions`
- `GET /v1/models`
- `GET /models`

Any other path returns **404** unless `ENDPOINT_PASSTHRU` is enabled (see environment variables): then unmatched requests are forwarded to `VENICE_BASE_URL` with the same path and query (for example `GET /api/v1/...` on the proxy becomes `GET https://api.venice.ai/api/v1/...` when using the default base URL).

Use any OpenAI-compatible client library with `base_url` pointing at the proxy:

```python
# Python (openai library)
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:3000/v1",
    api_key="unused",  # proxy handles auth
)

response = client.chat.completions.create(
    model="e2ee-qwen3-30b-a3b-p",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

## Testing

### Unit Tests

```bash
npm test
```

### Manual curl Tests

With the proxy running:

```bash
npm run test:curl
```

## Development

```bash
# Run in development mode (with tsx, auto-reloads)
npm run dev

# Run tests in watch mode
npm run test:watch

# Build for production
npm run build
npm start
```

## Security

- Private keys are zeroized when sessions expire or are cleared
- ECDH intermediates are zeroized after key derivation
- AES-256-GCM with random IVs per message
- Per-chunk ephemeral server keys provide forward secrecy for streaming responses
- TEE attestation prevents man-in-the-middle attacks
- Sessions auto-expire after TTL (default 30 minutes)
- Stale sessions are auto-detected and refreshed on decryption failure

The proxy binds to `127.0.0.1` by default and should not be exposed to the public internet. It is designed to run locally alongside your application.

## License

MIT

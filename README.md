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
- **Function calling** over E2EE, with tool schemas and arguments kept encrypted ([details](#function-calling))
- **Reasoning content** decryption for reasoning models (`reasoning_content`)
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

### config.yaml

```yaml
port: 3000
host: "127.0.0.1"
venice_base_url: "https://api.venice.ai"
verify_attestation: true
enable_dcap: true
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

Send requests with models prefixed with `e2ee-`. The proxy will handle encryption/decryption transparently:

```bash
# Streaming
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "e2ee-qwen3-30b-a3b-p",
    "messages": [{"role": "user", "content": "What is the meaning of life?"}],
    "stream": true
  }'

# Non-streaming (the default, as in the OpenAI API)
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "e2ee-qwen3-30b-a3b-p",
    "messages": [{"role": "user", "content": "What is the meaning of life?"}]
  }'
```

Reasoning models additionally return decrypted `reasoning_content` (as a delta field when
streaming, on the message when not).

### Function Calling

Pass `tools` and `tool_choice` exactly as you would with the OpenAI API.
Verified to work over E2EE end-to-end against the live API:

| Model | Context | Output | $ in / M | $ out / M |
|---|---|---|---|---|
| `e2ee-glm-5-2-p` | 524 288 | 32 768 | 1.75 | 5.75 |
| `e2ee-deepseek-v4-flash` | 1 000 000 | 8 192 | 0.182 | 0.373 |
| `e2ee-qwen3-6-27b` | 256 000 | 32 768 | 0.346 | 3.46 |
| `e2ee-qwen3-6-35b-a3b` | 32 000 | 4 096 | 0.182 | 1.18 |
| `e2ee-gemma-4-31b` | 32 000 | 4 096 | 0.139 | 0.43 |

(`e2ee-qwen3-30b-a3b-p` advertises function calling too, but Venice's
attestation endpoint currently returns 502 for it — unrelated to this proxy.)

Function calling is implemented by carrying tool schemas in an encrypted
system message and parsing the model's emitted `<tool_call>` blocks out of
the decrypted stream, so tool names, descriptions, arguments and results
stay ciphertext like the rest of the conversation. The test suite asserts
that none of them reach the wire.

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "e2ee-glm-5-2-p",
    "messages": [{"role": "user", "content": "What is the weather in Bratislava?"}],
    "tools": [{
      "type": "function",
      "function": {
        "name": "get_weather",
        "description": "Get the current weather in a given city",
        "parameters": {
          "type": "object",
          "properties": {"city": {"type": "string"}},
          "required": ["city"]
        }
      }
    }]
  }'
```

You get back a standard OpenAI tool call, and feed the result back with a `tool` message
as usual:

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": null,
      "tool_calls": [{
        "id": "call_65757dda1acabfe0648fdc41",
        "type": "function",
        "function": {"name": "get_weather", "arguments": "{\"city\":\"Bratislava\"}"}
      }]
    },
    "finish_reason": "tool_calls"
  }]
}
```

Streaming works too: tool calls arrive as `delta.tool_calls` followed by a
`finish_reason: "tool_calls"` chunk.

**How it works — and why your tools stay private.** Venice's E2EE gateway drops the
`tools` request parameter: a request carrying encrypted messages reaches the model with no
tool schemas attached. (The same model returns native tool calls when the E2EE headers are
absent, so this is a property of the encrypted path, not the model.) Passing `tools`
through would therefore have been the worst of both worlds — the model would ignore your
tools while their names, descriptions and JSON schemas travelled to Venice in plaintext.

So the proxy moves function calling inside the encrypted channel:

- Tool schemas are rendered into a system message and encrypted with the rest of the
  conversation.
- The model's emitted `<tool_call>` blocks are parsed out of the decrypted stream and
  converted back into OpenAI `tool_calls`.
- Prior `tool_calls` and `tool` results in your message history are folded into encrypted
  message content, and the plaintext `tool_calls` field is dropped before the request
  leaves the proxy.

Venice sees only ciphertext — tool names, descriptions, arguments and results included.
The test suite asserts that none of them appear in the outgoing request.

Two consequences worth knowing:

- Tool calling is prompt-driven rather than constrained decoding, so a model can in
  principle emit a malformed call. Validate arguments before acting on them, as you would
  with any model.
- Requests carrying tools cost some extra prompt tokens for the injected schemas.

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

The proxy exposes a standard OpenAI-compatible API on both endpoints:
- `POST /v1/chat/completions`
- `POST /chat/completions`

This means it works with any OpenAI-compatible client library. Just point it at the proxy:

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

Function calling uses the ordinary OpenAI tool loop:

```python
import json

tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the current weather in a given city",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "required": ["city"],
        },
    },
}]

messages = [{"role": "user", "content": "What's the weather in Bratislava?"}]

response = client.chat.completions.create(
    model="e2ee-glm-5-2-p", messages=messages, tools=tools
)
msg = response.choices[0].message
messages.append(msg.model_dump(exclude_none=True))

for call in msg.tool_calls or []:
    args = json.loads(call.function.arguments)
    result = json.dumps({"temp": 19, "conditions": "light rain"})  # your function here
    messages.append({"role": "tool", "tool_call_id": call.id, "content": result})

final = client.chat.completions.create(
    model="e2ee-glm-5-2-p", messages=messages, tools=tools
)
print(final.choices[0].message.content)
```

### opencode

[opencode](https://opencode.ai) is an AI coding agent that supports any
OpenAI-compatible backend. Add the proxy as a provider in
`~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "venice-e2ee": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Venice E2EE Proxy",
      "options": {
        "baseURL": "http://127.0.0.1:5656/v1",
        "apiKey": "unused"
      },
      "models": {
        "e2ee-glm-5-2-p": {
          "name": "GLM 5.2 (E2EE)",
          "tool_call": true,
          "reasoning": true,
          "attachment": false,
          "limit": { "context": 524288, "output": 32768 },
          "cost": { "input": 1.75, "output": 5.75 }
        },
        "e2ee-deepseek-v4-flash": {
          "name": "DeepSeek V4 Flash (E2EE)",
          "tool_call": true,
          "reasoning": true,
          "attachment": false,
          "limit": { "context": 1000000, "output": 8192 },
          "cost": { "input": 0.182, "output": 0.373 }
        },
        "e2ee-qwen3-6-27b": {
          "name": "Qwen 3.6 27B FP8 (E2EE)",
          "tool_call": true,
          "reasoning": true,
          "attachment": false,
          "limit": { "context": 256000, "output": 32768 },
          "cost": { "input": 0.346, "output": 3.46 }
        },
        "e2ee-qwen3-6-35b-a3b": {
          "name": "Qwen 3.6 35B A3B FP8 (E2EE)",
          "tool_call": true,
          "reasoning": true,
          "attachment": false,
          "limit": { "context": 32000, "output": 4096 },
          "cost": { "input": 0.182, "output": 1.18 }
        },
        "e2ee-gemma-4-31b": {
          "name": "Gemma 4 31B Instruct (E2EE)",
          "tool_call": true,
          "reasoning": true,
          "attachment": false,
          "limit": { "context": 32000, "output": 4096 },
          "cost": { "input": 0.139, "output": 0.43 }
        }
      }
    }
  },
  "model": "venice-e2ee/e2ee-glm-5-2-p",
  "small_model": "venice-e2ee/e2ee-qwen3-6-35b-a3b"
}
```

Adjust `baseURL` to match your `port` setting. The `apiKey` is unused — the
proxy reads `VENICE_API_KEY` from the environment. A sample config is also
in [`opencode.example.json`](opencode.example.json).

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

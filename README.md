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
- **TEE-only mode** via a `tee-` model prefix — attested enclave, plaintext prompts, Venice's native function calling ([details](#tee-only-models))
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
| `VERIFY_RECEIPTS` | `false` | Verify the signed receipt for each completion ([details](#response-receipts)) |
| `RECEIPT_ANCHOR_STORE` | `.venice-receipt-anchors.json` | Where trust-on-first-use receipt anchors are recorded |
| `ENABLE_DCAP` | `true` | Full DCAP quote verification |
| `DCAP_PCCS_URL` | Phala PCCS | Where DCAP collateral is fetched from ([details](#dcap-collateral)) |
| `VERIFY_GPU_ATTESTATION` | `false` | Check GPU evidence against NVIDIA, failing closed ([details](#gpu-attestation)) |
| `VERIFY_GPU_TOKEN_SIGNATURES` | `true` | Verify NVIDIA's ES384 token signatures, not just TLS |
| `GPU_PINNED_CERTS` | (none) | Comma-separated SHA-256 digests required in NVIDIA's cert chain |
| `NRAS_URL` | NVIDIA NRAS | Override the GPU attestation verifier endpoint |
| `NRAS_JWKS_URL` | NVIDIA JWKS | Override where NVIDIA's signing keys are fetched from |
| `SESSION_TTL` | `1800000` | Session TTL in ms (default: 30 min) |
| `LOG_LEVEL` | `info` | Log level: debug, info, warn, error |

### config.yaml

```yaml
port: 3000
host: "127.0.0.1"
venice_base_url: "https://api.venice.ai"
verify_attestation: true
enable_dcap: true
# dcap_pccs_url: "https://your-pccs.example/sgx/certification/v4"
verify_gpu_attestation: false
session_ttl: 1800000
log_level: "info"
```

Environment variables always override config.yaml values.

### DCAP collateral

DCAP verification needs collateral — PCK certificates, CRLs and TCB info — and
that has to come from a PCCS. Left unset, the library defaults to Phala's public
PCCS at `https://pccs.phala.network`. That works, and it also means a third party
sees which enclaves you verify and when, and that your verification fails when
theirs does.

Set `dcap_pccs_url` (or `DCAP_PCCS_URL`) to your own PCCS to remove both. The
collateral is signed by Intel either way, so pointing elsewhere does not weaken
the check — it only changes who serves and observes it.

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

### TEE-Only Models

Venice exposes one model ID for two request flows: the model runs inside an attested
Intel TDX enclave either way, and [the request decides](https://docs.venice.ai/overview/privacy)
whether prompts are also encrypted client-side. An OpenAI-compatible request carries
nothing but a model name, so the proxy takes the choice from there — prefix the model
with `tee-` and it runs TEE-only:

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "tee-e2ee-glm-5-2-p",
    "messages": [{"role": "user", "content": "What is the weather in Bratislava?"}],
    "tools": [{"type": "function", "function": {"name": "get_weather", "parameters": {
      "type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]
    }}}]
  }'
```

The proxy strips the prefix, verifies the enclave's attestation exactly as the E2EE path
does, and forwards the request in plaintext with `venice_parameters.enable_e2ee: false`.
Responses echo the prefixed ID back, so a client that replays `response.model` stays on
the same path.

**What you gain.** [Venice disables several features under E2EE](https://docs.venice.ai/guides/features/tee-e2ee-models)
— streaming is mandatory, and web search, file uploads and **function calling** are off.
TEE-only keeps them. Tool schemas go over the wire untouched and Venice returns native
`tool_calls`, so none of the prompt-based tool machinery below is involved.

**What you give up.** Venice's proxy sees your prompt. TEE-only removes the GPU host from
your trust set; it does not remove Venice, whose no-retention guarantee is a policy rather
than a cryptographic one. E2EE removes both. Pick `tee-` when you need the features, `e2ee-`
when you need the secrecy.

Attestation still gates the request: if verification fails, nothing is sent. With
`verify_attestation: false` the prefix buys you nothing over a plain passthrough, and the
proxy logs a warning saying so.

### Response Receipts

Attestation proves an enclave exists. It says nothing about whether *your* request
went through it — Venice could serve you from an ordinary GPU and the attestation
would still check out. The receipt narrows that gap, though not as far as it
first appears. Two limits are worth reading before you rely on it.

#### The trust anchor is pinned, not proven

`verifyReceipt` needs a workload identity and keyset digest it can trust, and
refuses to take them from the response being checked — a provider serving both
sides would just make them agree.

There is no cryptographic source for those values today. Venice's TDX quote binds
the signing address and your nonce (`report_data` decodes as
`[address(20) | zeros(12) | nonce(32)]`) and says nothing about the ACI keyset
digest. The `keyset_endorsement` signature sitting next to it could close that
gap, but its message construction is undocumented — 112 candidate
reconstructions failed to recover the attested signer, the same wall the
top-level secp256k1 signature runs into.

So the proxy pins on first use, the way SSH pins a host key. The first
attestation for a model is recorded to `receipt_anchor_store`
(`.venice-receipt-anchors.json` by default); every later one has to match. A
change is an error, not a silent update:

```
ERROR Receipt anchor CHANGED for e2ee-glm-5-2-p — pinned sha256:3def…/sha256:dead…,
      attestation now says sha256:3def…/sha256:c5c0…. The workload serving this model
      is not the one pinned.
```

This catches a substituted keyset or a silent downgrade. It does **not**
establish the enclave was genuine at pin time — pin what Venice says and you have
pinned Venice's claim. The first request says so explicitly (`anchor recorded on
this request — pinned, not yet corroborated`), and the pin is only corroborated
by it holding over time. If you have an out-of-band source for the digest, set it
under `receipt_anchors` and it takes precedence:

```yaml
receipt_anchors:
  e2ee-glm-5-2-p:
    workloadId: "sha256:3def476b…"
    workloadKeysetDigest: "sha256:c5c0f582…"
```

The store is read once at startup, so edits to it need a restart.

#### The body binding cannot be checked from here

A receipt carries hashes of the request and response bytes. Measured against the
live API, **those two checks never pass from behind `api.venice.ai`** — they fail
identically on the E2EE and TEE-only paths, streaming or not, which places a
re-serializing hop between this proxy and the enclave that issues the receipt.
Venice demonstrably re-wraps responses (it adds `cost` and `venice_parameters`),
and the request hashes point the same way.

The proxy reports this honestly rather than as a failure, since a failure on
every completion would just teach you to ignore it:

```
WARN  Receipt body binding cannot be verified for e2ee-glm-5-2-p: Venice re-serializes
      between this proxy and the enclave that issues the receipt…
INFO  Receipt authentic for ce0fd827… (e2ee-glm-5-2-p): signature, keyset and chat id
      check out. Body binding not reproducible from here.
```

So what a receipt buys you here is that **the attested enclave signed a receipt
for this completion id** — 11 of 13 checks, including the Ed25519 receipt
signature, the keyset membership and the anchor. What it does not buy is proof
that the bytes you received are the ones it produced. Only something sitting
directly in front of the ACI gateway could establish that.

#### Not every model issues receipts

`e2ee-deepseek-v4-flash` attests as Intel TDX and serves E2EE traffic normally,
but returns the pre-ACI attestation shape — no `workload_id`, no keyset, nothing
to check. That is a missing capability, not a failure, and it is reported once
per model without affecting completions:

```
INFO  Receipts unavailable for e2ee-deepseek-v4-flash: attestation carries no ACI
      workload identity (pre-ACI gateway). Completions are unaffected.
```

`e2ee-glm-5-2-p` and `e2ee-qwen3-30b-a3b-p` share one workload today, so they pin
to the same anchor — recorded separately, so a move by either is still visible.

Set `verify_receipts: true` (or `VERIFY_RECEIPTS=1`) and the proxy fetches
`GET /api/v1/tee/signature` after each completion and verifies it, on both the
E2EE and TEE-only paths:

```
INFO  Receipt verified for 11955ea790bd48b89e7d037ecd1da988 (e2ee-glm-5-2-p)
```

Six checks run, all of which must pass:

| Check | What it rules out |
|---|---|
| `key_in_attested_keyset` | a receipt signed by a key the enclave never vouched for |
| `key_algo_matches` | algorithm confusion between receipt and keyset |
| `receipt_signature` | any edit to the receipt or its event log |
| `keyset_digest_matches` | a substituted keyset — the digest is folded into the quote's `report_data` |
| `chat_id_matches_request` | a valid receipt for somebody else's completion |
| `signing_address_matches_attestation` | the two endpoints describing different enclaves |

The signature is Ed25519 over the RFC 8785 (JCS) canonicalization of the receipt
with `signature.value` removed, under a key from
`attestation.workload_keyset.receipt_signing_keys` — the scheme Phala's
[private-ai-gateway](https://github.com/Dstack-TEE/private-ai-gateway) reference
verifier implements. Note that the top-level secp256k1 `signature` over
`<request-hash>:<response-hash>` in the same response is *not* what gets checked;
its message construction is undocumented and the reference verifier ignores it.

Verification runs after the response is already on its way to the client. It
costs two extra round trips, and blocking every completion to prove what already
happened is a bad trade — so results are logged, not returned. Off by default.

#### What the receipt does not tell you

- **The response bytes are not bound to it.** `response.returned.cleartext_hash`
  covers the gateway's output; Venice re-wraps that (adding `cost`,
  `venice_parameters`) before you see it, so `sha256(body you received)` will not
  match. The receipt proves the enclave produced *a* response with that hash, not
  that the JSON in your hand is that response.
- **The attested enclave is the gateway, not the GPU.** See below.

### What is actually attested

The attestation is worth reading rather than trusting, and it is self-describing.
`attestation.evidence.app_compose` carries the full measured deployment manifest,
hashed into RTMR3 in the TDX quote. For Venice's E2EE models it resolves to
Phala's `private-ai-gateway` running under dstack, fronting `tee.redpill.ai`,
`api.redpill.ai` and `inference.phala.com`.

What that buys you, and what it does not:

- **`vm_config.num_gpus` is `0`.** The attested CVM has no GPU. It is the
  *gateway*; inference happens on a separate host (`*.usc2-router.phala.com`)
  reached over TLS. Your prompt is decrypted inside the attested gateway enclave
  and forwarded onward — a real boundary, but not "decrypted only on the machine
  that runs the model".
- **The upstream is vouched for, not verified by you.** The receipt's
  `upstream.verified.claims.tee_attested` reads
  `{"status": "asserted", "source": "verifier_derived"}` — the gateway says it
  checked. `gpu_attested`, `tcb_up_to_date`, `os_known_good` and
  `model_weights_provenance` are all `"unknown"`, and `upstream.verified.required`
  is `false`.
- **The gateway is built from source at boot, not from a pinned image.**
  `source_provenance` names
  `https://github.com/Dstack-TEE/private-ai-gateway.git` at a specific commit, and
  those literals sit in the compose `environment:` block, so the commit is
  measured into the quote. But `source_provenance.image_digest` and
  `image_provenance` are both `null`: what is attested is the *instruction* to
  build that commit, not a reproducible artifact. The build fetches dependencies
  at boot and reuses a persistent, unmeasured `pal-cache` volume across reboots.
- **Not every image is pinned.** `dstack-ingress`, the launcher and
  `node-exporter` are pinned by `@sha256:` digest. `dstacktee/dstack-verifier`
  is `:latest` — its content can change without changing any measurement. It
  serves the NEAR AI verification path rather than the ACI path Venice's models
  use, so it is likely out of the request path, but the measurement does not
  constrain it.
- **The OS image is a dev build.** `vm_config.image` is
  `dstack-dev-0.5.9-de9c74f0`, and `attestation.vendor` is
  `private-ai-gateway-dev`.
- **Attested serving is not forced on Venice's hostname.** The measured gateway
  config sets `middleware.tee_only_domains` to `["tee.redpill.ai",
  "inference.phala.com"]`; on those hosts completions are, per the gateway source,
  "forced to attested serving". The attestation's
  `evidence.downstream_tls_binding.domain` for Venice is `api.redpill.ai`, which
  is **not** in that list — consistent with `upstream.verified.required: false`.
  Observed requests were still routed to a verified upstream; the point is that
  the policy does not compel it.

None of this is hidden — it is all in the attestation Venice already serves, and
the ACI spec is explicit that measurement binding "does not prove that an image,
launcher, source revision, compiler, dependency, or OS build is acceptable".
Decide what that is worth for your threat model rather than reading "TEE" as a
single boolean.

### GPU attestation

Off by default. Turn it on with `verify_gpu_attestation: true` (or
`VERIFY_GPU_ATTESTATION=true`) and sessions fail closed unless NVIDIA vouches for
the GPU evidence Venice served, with a nonce proving the verdict is about your
request.

```yaml
verify_attestation: true          # required — GPU evidence is checked as part of it
verify_gpu_attestation: true
```

Venice's attestation response carries an `nvidia_payload` alongside
`server_verification.nvidia.valid`. That second field is Venice's own verdict on
its own hardware; the library has always treated `nvidia.valid: false` as fatal,
but a self-reported boolean from the party the encryption defends against only
catches an honest node reporting its own degradation. `@axlabs/venice-e2ee-proxy`
ships exactly that field as its `VERIFY_GPU_ATTESTATION`, and its source is
candid about it — the flag "enforces Venice's GPU verdict" rather than checking
NVIDIA's. It also reads it on a *separate* `/tee/attestation` fetch made before
the handshake, so the evidence it gates on is not the evidence that produced the
session key.

This setting does the real check instead. `nvidia_payload` holds `nonce`, `arch`
and an `evidence_list` of GPU measurements with endorsement certificates signed
by a key NVIDIA burns into the die at manufacture. It goes verbatim to NVIDIA's
Remote Attestation Service, which returns an ES384-signed Entity Attestation
Token. The proxy then requires, on the same attestation that establishes the
session:

- `eat_nonce` equal to the nonce this session sent — the claim that makes the
  verdict about your request instead of a replayed report
- `x-nvidia-overall-att-result: true`
- per GPU: `secboot: true`, `dbgstat: "disabled"`, `measres: "success"`

Measured against the live API rather than assumed:

```
model                  evidence   GPUs   arch     NVIDIA verdict
e2ee-gpt-oss-20b-p     12103 B    1      HOPPER   GH100, secboot ✓ dbgstat=disabled measres=success
e2ee-glm-5-2-p         98158 B    8      HOPPER   GH100 ×8, all passing, eat_nonce bound
```

7 of the 9 E2EE models that answered a sweep carried GPU evidence; the other two
returned 502 or 429 rather than an empty payload.

**What this does not establish is co-location.** The attested CVM's `vm_config`
reports `num_gpus: 0` and `cpu_count: 16` — the enclave holding the signing key
has no GPU, as described above. The GPU evidence therefore comes from a different
machine, and the only thread joining the two is the nonce, which the gateway
handed to both. A gateway inclined to could pass that nonce to any attested
Hopper node and return its evidence.

So the honest reading of a passing check is "an attested H100 in
confidential-compute mode, with secure boot on and debug off, answered a
challenge derived from your request" — not "the GPU that ran your prompt is
attested". That is a real step up from a boolean Venice writes about itself, and
still short of what `gpu_attested: "unknown"` in the receipt is telling you.

Each new session costs a round trip to NVIDIA, which learns that the evidence was
checked. `NRAS_URL` points the check at your own verifier instead.

#### NVIDIA token signatures

NVIDIA's verdict arrives as ES384-signed JWTs. `verify_gpu_token_signatures` is
**on by default** whenever GPU attestation is on: the tokens are checked against
NVIDIA's published key set rather than trusted because of the TLS connection they
came down. It costs one cached key fetch per 15 minutes.

The difference matters for what the verdict is worth. Authenticated by TLS, a
token means something only on the call you made yourself. Signature-checked, it
stands on its own — it can be relayed, cached, or logged and still verify, which
is what would eventually allow Venice to pass a token through instead of the
proxy calling NVIDIA per session.

Alongside the signature, the algorithm is pinned to ES384 rather than read from
the token, which is where the JWT confusion attacks start, `alg: none` included.
`iss`, `exp` and `nbf` are checked. Every token is verified, overall and per-GPU,
and any failure fails the session.

NVIDIA rotates these signing certificates roughly every 48 hours — measured, not
assumed:

```
cert[0]  CN=NVIDIA Attestation Service GPU GH100      valid 48 hours
cert[1]  CN=NVIDIA Attestation Service GPU Intermediate 004   valid to Dec 2029
         issued by NVIDIA Attestation Service CA 001
```

So the key set is cached briefly and refetched when a token names a `kid` that is
not held, rate-limited so a malformed token cannot become a request flood.

If you have obtained NVIDIA's intermediate or root out of band and would rather
not rely on the TLS fetch at all, `gpu_pinned_certs` takes SHA-256 digests that
must appear in the token's chain:

```yaml
gpu_pinned_certs:
  - "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
```

This is deliberately not full RFC 5280 path validation — a hand-rolled X.509
validator is security-critical code that is usually subtly wrong — but the leaf
certificate is required to carry the same key as the JWK, and a malformed digest
is rejected at startup rather than silently never matching.

To see the evidence without enabling the gate:

```bash
python3 scripts/audit-gpu-evidence.py            # is there GPU evidence?
python3 scripts/audit-gpu-evidence.py --nras     # verify it with NVIDIA
```

### Function Calling

> **For agent workloads, use the `tee-` prefix, not `e2ee-`.** Function calling
> over E2EE is best-effort and fails often enough to be unusable for anything
> that chains tool calls. See [E2EE tool calling is
> best-effort](#e2ee-tool-calling-is-best-effort) for what actually goes wrong.

Pass `tools` and `tool_choice` exactly as you would with the OpenAI API.
Verified end-to-end against the live API, on both the E2EE and TEE-only paths:

| Model | Tools | Context | Output | $ in / M | $ out / M |
|---|---|---|---|---|---|
| `e2ee-glm-5-2-p` | yes | 524 288 | 32 768 | 1.75 | 5.75 |
| `e2ee-deepseek-v4-flash` | yes | 1 000 000 | 8 192 | 0.182 | 0.373 |
| `e2ee-qwen3-6-27b` | yes | 256 000 | 32 768 | 0.346 | 3.46 |
| `e2ee-qwen3-6-35b-a3b` | yes | 32 000 | 4 096 | 0.182 | 1.18 |
| `e2ee-gemma-4-31b` | no | 32 000 | 4 096 | 0.139 | 0.43 |

Check `supportsFunctionCalling` on `/models` before relying on tools. The two paths
disagree about what happens when it is `false`, and the difference matters:

- **TEE-only refuses.** `tools` is a real request parameter, so Venice rejects it —
  `400 "tools is not supported by this model"`. You find out immediately.
- **E2EE appears to work.** Schemas travel inside the prompt, so Venice's capability
  check never sees them. `e2ee-gemma-4-31b` will emit well-formed `<tool_call>` blocks
  that this proxy parses into real `tool_calls` — but the model was never trained for the
  round trip and echoes the `<tool_response>` back instead of answering it.

So the prompt-based path is not a way to add function calling to models that lack it. It
is a way to keep function calling private on models that have it.

(`e2ee-qwen3-30b-a3b-p` and `e2ee-qwen3-vl-30b-a3b-p` also advertise function calling, but
Venice's attestation endpoint has been returning 502 for them — unrelated to this proxy.)

Function calling is implemented by carrying tool schemas in an encrypted
system message and parsing the model's emitted `<tool_call>` blocks out of
the decrypted stream, so tool names, descriptions, arguments and results
stay ciphertext like the rest of the conversation. The test suite asserts
that none of them reach the wire.

Because the model is following a prompt rather than a constrained decoder, the
decoder accepts more than the format it asks for: `<function_call>` and
`<|tool_call|>` tags as well as `<tool_call>`, several calls batched into one
block as an array or a `{"tool_calls": [...]}` wrapper, `tool_name`/`args`
spellings, an OpenAI-shaped `{"function": {...}}` payload, and a call emitted
with no tags at all. The untagged form is only accepted when it names a tool you
actually declared, so a model asked to reply in JSON still returns JSON. A single
argument passed bare (`"arguments": "Bratislava"`) is wrapped using the schema
when the function takes exactly one parameter.

If you use this path directly through the library, pass the schemas to the parser
— `new ToolCallStreamParser({ tools })` — since argument coercion and untagged
recovery both need them. The proxy does this for you.

#### What GLM actually emits

GLM has its own tool-call template it was trained on, and it uses the same
`<tool_call>` tag this prompt asks for. So it reaches for that tag and then fills
it with a blend of its own format and the requested JSON — differently each time.
Captured verbatim from `e2ee-glm-5-2-p` in one opencode session:

```
<tool_call>read</arg_value>filePath</arg_key><arg_value>/Users/juraj/…</arg_value></tool_call>
<tool_call>glob<arg_key>pattern "**/opencode.json"</arg_value></tool_call>
<tool_call>
{"name":"edit","arguments":{"filePath":"…","oldString":"…"}}
</tool_call>
```

All three parse. The decoder accepts the JSON body, well-formed
`<arg_key>`/`<arg_value>` pairs, those pairs with tags missing or run together,
and — gated on the declared schemas — a body with no tags at all. A block that
still yields nothing is returned as visible content rather than dropped, so a
format nobody has seen yet shows up as a mangled answer instead of an empty turn.

In that session the degenerate form appeared on the first tool call and every
later turn used clean JSON, which fits the rendered tool history acting as a
worked example the first call does not have.

### E2EE tool calling is best-effort

Venice's E2EE gateway drops the `tools` parameter, so on the `e2ee-` path the
schemas have to travel inside the prompt and the model's tool calls have to be
parsed back out of prose. That last step is the problem: the model has to
reproduce a format by imitation instead of emitting structured output, and GLM
does not do it reliably.

Across five captured agent sessions — 48 responses, 96 tool calls — GLM 5.2
produced a *different* malformed syntax on almost every run. A sample of what
the same model emitted for the same task on consecutive attempts:

```
<tool_call>grep pattern="good.?match" include="*.svelte"       attribute pairs
<tool_call>tasksubagent_type: "explore"description: "…"        name glued to key
<tool_call>grep{"pattern":"…"}{"path":"…"}                     one object per argument
<tool_call>readfilePath":"/src/app.css","limit":15}            opening brace absorbed
<tool_call>edit(filePath:"…", oldString:"…")                   call syntax
<tool_call>grep\npattern\ngood.?match                          line-delimited
<tool_call>pattern":"--ok|--accent-bg</arg_value>              no tool name at all
```

The parser handles the well-formed shapes and a few mechanical repairs —
unescaped newlines inside JSON strings, unquoted keys, parentheses for braces,
stray `<arg_key>`/`<arg_value>` tags. **About a quarter of tool calls still do
not survive**, and those surface as visible markup in the response instead of a
call.

That is deliberate. Recovering the rest means guessing where one argument ends
and the next begins, which was implemented and then removed: it converted lost
calls into plausible-looking wrong ones. A `grep` whose pattern was silently
truncated looks like it worked, and an `edit` with a corrupted `oldString`
fails in a way that is much harder to diagnose than a call that visibly did not
happen. A missing call is recoverable; a wrong one is not.

**Use `tee-` for tool calling.** The request stays inside the attested enclave
and Venice's native function calling handles the schemas properly, so none of
the above applies. The trade is real and worth stating plainly: prompts are not
end-to-end encrypted on that path — Venice can see them, and you are relying on
the TDX attestation instead. See [TEE-Only Models](#tee-only-models).

The proxy logs a warning the first time it sees `tools` on an `e2ee-` model.

### Debugging tool-call formats

When a client's tool call does not come back the way you expect, set
`VENICE_PROXY_DEBUG_DUMP` to a file path. The proxy appends one JSON object per
request and per response: the tool schemas and fully-rendered prompt going in,
and the raw decrypted model text going out — captured *before* the tool parser
touches it — alongside reasoning, chunk count, and the parsed result.

```bash
VENICE_PROXY_DEBUG_DUMP=/tmp/venice-dump.jsonl npm run dev
```

> This writes your plaintext prompts and responses to disk, which is exactly what
> the rest of this proxy exists to prevent. It is off unless the variable is set,
> the proxy logs a warning the first time it writes, and the file is yours to
> delete. Do not leave it enabled.

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

## Related projects

[`@axlabs/venice-e2ee-proxy`](https://github.com/AxLabs/venice-e2ee-proxy) is an
independent proxy over the same Venice protocol, and it is the more packaged of
the two: `npx`-installable, NestJS with a Swagger UI, validated CLI flags, and a
`DCAP_PCCS_URL` setting so DCAP collateral can be fetched from somewhere other
than Phala's PCCS. Its [`NOTICE.md`](https://github.com/AxLabs/venice-e2ee-proxy/blob/main/NOTICE.md)
is a good treatment of the GPL question that applies to any proxy bundling this
library.

Two differences to know before picking one. It binds to `0.0.0.0` by default
while holding your Venice API key, where this one binds to `127.0.0.1`. And it
forked the encryption library at a commit predating function calling over E2EE,
so tool calls — what Cline, Roo Code and Continue lean on hardest — take a
different path there than the one documented above. Its
`VERIFY_GPU_ATTESTATION` flag is covered under
[GPU attestation](#gpu-attestation).

## License

GPL-3.0-only. See [`LICENSE`](LICENSE), and [`NOTICE.md`](NOTICE.md) for why:
the proxy vendors the GPL-3.0 `venice-e2ee` library as a submodule and links it
at runtime, so any distributed build is a combined work under the GPL. Running
the proxy yourself, including as a service reachable over the network, carries no
distribution obligation — this is the GPL, not the AGPL.

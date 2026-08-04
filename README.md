# venice-e2ee-proxy

A local proxy that encrypts [OpenAI-compatible](https://platform.openai.com/docs/api-reference/chat) API requests using [Venice AI's](https://venice.ai) end-to-end encryption protocol.

Prompts are encrypted on your machine and decrypted inside an attested Intel TDX enclave. Venice's own infrastructure never holds the plaintext. What the enclave then does with it is worth understanding before you rely on that: see [what is actually attested](#what-is-actually-attested).

## How it works

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

- ECDH key exchange (secp256k1) with the TEE, AES-256-GCM message encryption
- TEE attestation: TDX quote parsing, nonce binding, signing key binding
- Full DCAP verification against Intel's root, and [GPU attestation](#gpu-attestation) against NVIDIA's
- Per-chunk decryption of streaming responses, each chunk under a fresh server ephemeral key
- [Function calling](#function-calling) over E2EE with schemas and arguments kept encrypted
- [TEE-only mode](#tee-only-models) via a `tee-` prefix: attested enclave, plaintext prompts, native function calling
- `reasoning_content` decryption for reasoning models
- Session caching (30 minute default) shared safely across concurrent requests

## Quick start

```bash
git clone --recurse-submodules https://github.com/jooray/venice-e2ee-proxy.git
cd venice-e2ee-proxy
npm install

cp .env.example .env      # then set VENICE_API_KEY
npm run dev
```

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "e2ee-qwen3-30b-a3b-p", "messages": [{"role": "user", "content": "Hello!"}]}'
```

Node.js 20+ and a [Venice AI](https://venice.ai) API key are required. If you cloned without `--recurse-submodules`, run `git submodule update --init --recursive` first. For production, `npm run build && npm start`.

## Configuration

Settings come from `config.yaml` (optional), overridden by environment variables. `.env` loads automatically.

```bash
cp config.example.yaml config.yaml
cp .env.example .env
```

| Variable | Default | Description |
|---|---|---|
| `VENICE_API_KEY` | (required) | Your Venice AI API key |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | Host to bind to |
| `VENICE_BASE_URL` | `https://api.venice.ai` | Venice API base URL |
| `VERIFY_ATTESTATION` | `true` | Verify TEE attestation |
| `ENABLE_DCAP` | `true` | Full DCAP quote verification |
| `DCAP_PCCS_URL` | Phala PCCS | Where DCAP collateral comes from ([details](#dcap-collateral)) |
| `VERIFY_GPU_ATTESTATION` | `true` | Check GPU evidence with NVIDIA ([details](#gpu-attestation)) |
| `VERIFY_GPU_TOKEN_SIGNATURES` | `true` | Verify NVIDIA's ES384 signatures, not just TLS |
| `GPU_PINNED_CERTS` | (none) | SHA-256 digests required in NVIDIA's cert chain, comma separated |
| `NRAS_URL` | NVIDIA NRAS | Override the GPU attestation endpoint |
| `NRAS_JWKS_URL` | NVIDIA JWKS | Override where NVIDIA's signing keys come from |
| `VERIFY_RECEIPTS` | `false` | Verify the receipt for each completion ([details](#response-receipts)) |
| `RECEIPT_ANCHOR_STORE` | `.venice-receipt-anchors.json` | Where trust-on-first-use anchors are recorded |
| `SESSION_TTL` | `1800000` | Session TTL in ms |
| `LOG_LEVEL` | `info` | debug, info, warn, error |

The same keys work in `config.yaml` in snake_case. Environment variables always win.

### DCAP collateral

DCAP verification needs PCK certificates, CRLs and TCB info, which come from a PCCS. Unset, the library uses Phala's public one at `https://pccs.phala.network`. That works, and it also means a third party sees which enclaves you verify and when, and your verification fails when theirs does.

Point `dcap_pccs_url` at your own PCCS to remove both. Intel signs the collateral either way, so this changes who serves and observes it, not how strong the check is.

## Attestation verification

Three checks run, answering three different questions. All are on by default.

| Setting | Question it answers | Trusts |
|---|---|---|
| `verify_attestation` | Is this quote about my request, and does it carry the key I am about to encrypt to? | nothing external |
| `enable_dcap` | Is this a real Intel TDX quote from genuine, current silicon? | Intel's roots, via a PCCS |
| `verify_gpu_attestation` | Does NVIDIA vouch for the GPU evidence served alongside it? | NVIDIA's roots, via NRAS |

They stack. Binding without DCAP gives you a well-formed quote nobody vouched for. DCAP without binding gives you a genuine quote that might be about somebody else's session. Neither says anything about the GPU, which is why the third exists.

`verify_attestation` parses the quote and checks, client side, that your 32-byte nonce sits in `REPORTDATA[32:64]` so the quote is about this request rather than a replay; that the signing key's Ethereum address sits in `REPORTDATA[0:20]`, so the key you encrypt to is the one the enclave attested; that the TD debug bit is clear, since a debug-mode TEE can be introspected by its host; and that Venice's own `server_verification` agrees with what the proxy computed.

`enable_dcap` hands the quote to `@phala/dcap-qvl`, which validates the PCK certificate chain up to Intel's SGX Root CA, the ECDSA P-256 quote signature, the quoting enclave's identity, and the TCB level against Intel's collateral and CRLs. This is what makes the quote evidence rather than a well-formed blob.

Turning verification off is not recommended, and it disables the GPU check too, since there is then no attestation to check GPU evidence against:

```yaml
verify_attestation: false
enable_dcap: false
```

### What the quote measures

A passing attestation is not one bit. The quote carries measurement registers describing what booted, and some can be recomputed rather than taken on trust.

| Register | Holds | Reproducible? |
|---|---|---|
| `MRTD` | initial VM memory: firmware and kernel | only by rebuilding the dstack OS image |
| `MRCONFIGID` | `0x01 ‖ sha256(app_compose) ‖ zeros` | yes, hash the manifest the response ships |
| `RTMR0-2` | firmware and boot configuration | no |
| `RTMR3` | extended by a measured boot event log | partly, individual events cross-check |
| `REPORTDATA` | `signing address(20) ‖ zeros(12) ‖ nonce(32)` | yes, both halves are values you hold |

The reproducible ones matter most, because they bind the quote to things you can read. `MRCONFIGID` covers the deployment manifest, so the enclave cannot run a different compose file than the one it showed you. The RTMR3 event log names `compose-hash`, `os-image-hash`, `app-id`, `key-provider`, `mr-kms` and `instance-id`; the first two restate values carried elsewhere in the response, so they can be checked against each other.

`scripts/audit-attestation.py` does all of this and prints what held:

```
$ ./scripts/audit-attestation.py --model e2ee-glm-5-2-p

BINDING (recomputed from the quote's REPORTDATA)
  PASS  our nonce is inside the quote
  PASS  quote binds the signing key 0x79a5061efe5a46b0d1f33b11cf1c5adbedae6b79
  PASS  TEE is not in debug mode

WHAT IS RUNNING (recomputed, not taken from Venice's own report)
  PASS  MRCONFIGID reproduces from the compose manifest
  PASS  event log's compose-hash matches that manifest
  PASS  event log's os-image-hash matches vm_config
```

### Can you verify the images?

Partly, and the gap is worth knowing precisely.

The compose manifest is measured, so the list of images is fixed by the quote. Venice cannot claim one manifest and run another. Most images inside it are pinned by digest:

```
IMAGES NAMED BY THE MEASURED MANIFEST
  PASS  dstacktee/dstack-ingress:2.2            pinned @ sha256:d05a7b34…
  PASS  ghcr.io/redpill-ai/private-ai-launcher  pinned @ sha256:c083ff9e…
  FAIL  dstacktee/dstack-verifier:latest        NOT pinned
  PASS  prom/node-exporter:v1.8.2               pinned @ sha256:4032c6d5…

BUILT AT BOOT, NOT SHIPPED AS AN IMAGE
  repo         https://github.com/Dstack-TEE/private-ai-gateway.git
  commit       aa65d64c191949b8df7b1ebe210f5b8f8a8e6b99
  image digest null, the built artifact is not measured
```

Three of four are pinned to exact content. `dstack-verifier` rides a `:latest` tag, which is pulled over TLS from a public registry, so the risk is not interception but drift: the tag can point at different content later without changing any measurement. It serves the NEAR AI verification path rather than the ACI path Venice's models use, so it is probably out of the request path.

The larger gap is the gateway itself, the process that decrypts your prompt. It is not shipped as an image at all. The launcher clones and builds it from source at boot. What the quote fixes is the instruction to build a named commit, not the binary that instruction produced, and there is no reproducible build to check it against. The build fetches dependencies at boot and reuses a persistent, unmeasured `pal-cache` volume across reboots.

So you can verify what the enclave was told to run, exactly and byte for byte. You cannot verify what it ended up running.

## Usage

### E2EE models

Prefix the model with `e2ee-` and the proxy handles encryption and decryption:

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "e2ee-qwen3-30b-a3b-p", "messages": [{"role": "user", "content": "Hello"}], "stream": true}'
```

Streaming and non-streaming both work; non-streaming is the default, as in the OpenAI API. Reasoning models also return decrypted `reasoning_content`, as a delta field when streaming and on the message when not.

Models without the `e2ee-` prefix are forwarded to Venice untouched, with only the authorization header added.

### TEE-only models

Venice exposes one model ID for two request flows. The model runs inside an attested enclave either way, and [the request decides](https://docs.venice.ai/overview/privacy) whether prompts are also encrypted client side. An OpenAI-compatible request carries nothing but a model name, so the proxy takes the choice from there. Prefix with `tee-`:

```bash
curl http://127.0.0.1:3000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model": "tee-e2ee-glm-5-2-p", "messages": [{"role": "user", "content": "Weather in Bratislava?"}],
       "tools": [{"type": "function", "function": {"name": "get_weather", "parameters": {
         "type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}]}'
```

The proxy strips the prefix, verifies attestation exactly as the E2EE path does, and forwards in plaintext with `venice_parameters.enable_e2ee: false`. Responses echo the prefixed ID back, so a client replaying `response.model` stays on the same path.

What you gain: [Venice disables several features under E2EE](https://docs.venice.ai/guides/features/tee-e2ee-models), including web search, file uploads and function calling, and streaming becomes mandatory. TEE-only keeps them. Tool schemas go over the wire untouched and Venice returns native `tool_calls`, so none of the prompt-based machinery below is involved.

What you give up: Venice's proxy layer sees your prompt in the clear. E2EE keeps it encrypted until it reaches the attested gateway, which is the reason to prefer `e2ee-` when you need secrecy.

Neither mode removes the inference host from your trust set. Both leave your prompt in plaintext on the machine running the model, for reasons covered in [what is actually attested](#what-is-actually-attested).

Attestation gates the request on both paths: if verification fails, nothing is sent. With `verify_attestation: false` the prefix buys you nothing over a plain passthrough, and the proxy says so.

## What is actually attested

**TLDR.** The Intel attestation covers a *gateway*, not the machine that runs the model. Your prompt is decrypted there and forwarded over ordinary TLS to a separate inference host, which sees it in plaintext. The GPU attestation covers a *chip*, not the software on it: NVIDIA vouches that a genuine Hopper GPU is in confidential-compute mode with known firmware, and says nothing about what code or model weights it loaded. Neither attestation covers where the gateway forwards to, because the upstream list is runtime state and is not measured. What you get is a strong guarantee about one hop and a weak one about the rest.

### The chain, hop by hop

| Hop | Sees your prompt | What attestation covers it |
|---|---|---|
| Your machine to gateway | ciphertext only | the ECDH key is bound into the TDX quote |
| Gateway enclave (Intel TDX) | plaintext | the full Intel attestation above |
| Gateway to inference host | ciphertext (TLS) | TLS SPKI recorded in the signed receipt |
| Inference host (the GPU) | plaintext | NVIDIA attests the chip, not the software |

### What the Intel attestation actually proves

That an Intel TDX enclave booted with a specific measured configuration, and that the key you encrypted to belongs to it. That configuration resolves to Phala's `private-ai-gateway` running under dstack, fronting `tee.redpill.ai`, `api.redpill.ai` and `inference.phala.com`.

What that gateway does is route. It terminates your encryption, selects an upstream, and forwards the request onward over HTTPS. `vm_config.num_gpus` is `0`: the attested CVM has no GPU and cannot be running the model.

The routing table is the part attestation does not reach. The measured config seeds it empty:

```
gateway-upstreams:
  content: |
    []
```

with the comment that routes are "seeded into `<state_dir>/upstreams.json` only when empty, then managed at runtime via `PUT /v1/admin/upstreams`". Every upstream the gateway forwards to is installed after boot through an admin API, backed by a mutable volume. The quote fixes a gateway whose upstream list is empty. It says nothing about which machines the running gateway talks to, or what policy it applies to them.

The gateway source supports per-upstream attestation policy (`accepted_workload_ids`, `accepted_image_digests`, `pccs_url`), but those are optional, and its own comment notes that plain OpenAI-compatible upstreams "have no verifier".

### What the gateway to inference link looks like

Ordinary HTTPS, terminated at the far end. A signed receipt records which endpoint was used and pins its TLS key:

```json
{ "type": "upstream.verified",
  "url_origin": "https://glm-5-2.aus1-router.phala.com",
  "verifier_id": "aci-service/v2", "result": "verified", "required": false,
  "channel_bindings": [{ "type": "tls_spki_sha256", "spki_sha256": "0da57eba…" }],
  "claims": {
    "tee_attested": { "status": "asserted", "source": "verifier_derived" },
    "gpu_attested": { "status": "unknown" },
    "serving_software_known_good": { "status": "unknown" },
    "model_weights_provenance": { "status": "unknown" } } }
```

Encrypted in transit, then plaintext on arrival. The inference host reads your prompt. `result: verified` means the gateway checked the upstream and bound the channel, so this is the gateway's word rather than yours, and `required: false` means the check was not mandatory for this route.

The remaining claims are the honest part. Venice's own receipt reports `gpu_attested`, `serving_software_known_good` and `model_weights_provenance` as `unknown`.

### What the GPU attestation actually proves

That the chip is genuine and healthy. NVIDIA's token names the hardware (`hwmodel: GH100`, a per-device `ueid`), confirms secure boot is on and debug is off, and reports that firmware and VBIOS measurements matched NVIDIA's reference values (`measres: success`).

It does not say what runs on that chip. There is no claim about the inference server, the model weights, or what happens to your prompt after it arrives. A GPU passing attestation while running entirely different software would produce the same token. That is why the receipt's `model_weights_provenance` is `unknown` and cannot be anything else.

### Other things the attestation admits

The gateway is built from source at boot rather than from a pinned image, as described above. `attestation.vendor` is `private-ai-gateway-dev` and `vm_config.image` is `dstack-dev-0.5.9-de9c74f0`, a dev build.

Attested serving is also not forced on Venice's hostname. The measured config sets `middleware.tee_only_domains` to `["tee.redpill.ai", "inference.phala.com"]`, where completions are, per the gateway source, "forced to attested serving". Venice's `evidence.downstream_tls_binding.domain` is `api.redpill.ai`, which is not in that list, consistent with `required: false` above. Observed requests were still routed to a verified upstream. The point is that policy does not compel it.

None of this is hidden. It is all in the attestation Venice already serves, and the ACI spec says plainly that measurement binding "does not prove that an image, launcher, source revision, compiler, dependency, or OS build is acceptable". Decide what that is worth for your threat model rather than reading "TEE" as a single boolean.

## GPU attestation

On by default. Sessions fail closed unless NVIDIA vouches for the GPU evidence Venice served, with a nonce proving the verdict is about your request. Both `e2ee-` and `tee-` models go through the same handshake, so both are gated.

```yaml
verify_gpu_attestation: false     # to switch it off
```

Turning it off leaves the GPU vouched for only by Venice, which is the thing this proxy otherwise exists to avoid. The reason it might be worth doing is availability: with it on, sessions depend on NVIDIA being reachable, in the same way `enable_dcap` already makes them depend on a PCCS. Switching `verify_attestation` off turns this off with it.

Venice serves an `nvidia_payload` alongside `server_verification.nvidia.valid`. That second field is Venice's verdict on its own hardware. The library has always treated `nvidia.valid: false` as fatal, but a self-reported boolean from the party the encryption defends against only catches an honest node reporting its own degradation.

This setting does the real check. `nvidia_payload` holds `nonce`, `arch` and an `evidence_list` of GPU measurements with endorsement certificates signed by a key NVIDIA burns into the die at manufacture. It goes verbatim to NVIDIA's Remote Attestation Service, which returns an ES384-signed Entity Attestation Token. The proxy then requires, on the same attestation that establishes the session:

- `eat_nonce` equal to the nonce this session sent, the claim that makes the verdict about your request instead of a replayed report
- `x-nvidia-overall-att-result: true`
- per GPU: `secboot: true`, `dbgstat: "disabled"`, `measres: "success"`

Measured against the live API:

```
model                  evidence   GPUs   arch     NVIDIA verdict
e2ee-gpt-oss-20b-p     12103 B    1      HOPPER   GH100, secboot ok, dbgstat disabled, measres success
e2ee-glm-5-2-p         98158 B    8      HOPPER   GH100 x8, all passing, eat_nonce bound
```

Every E2EE model that answered a full sweep carried GPU evidence, 13 of 13. The three that did not answer returned 502 from Venice's attestation endpoint, and those already fail with plain `verify_attestation`. Turning this on costs no model that works today.

Cost is one NRAS round trip per session, measured at roughly nothing next to the 1.7s attestation handshake, and once per session rather than per request. `NRAS_URL` points it at your own verifier instead.

To look at the evidence without enabling the gate:

```bash
python3 scripts/audit-gpu-evidence.py            # is there GPU evidence?
python3 scripts/audit-gpu-evidence.py --nras     # verify it with NVIDIA
```

### NVIDIA token signatures

NVIDIA's verdict arrives as ES384-signed JWTs. `verify_gpu_token_signatures` is on by default: the tokens are checked against NVIDIA's published key set rather than trusted because of the TLS connection they came down. It costs one cached key fetch.

The difference matters for what the verdict is worth. Authenticated by TLS, a token means something only on the call you made yourself. Signature checked, it stands on its own, so it can be relayed, cached or logged and still verify. That is what would eventually let Venice pass a token through instead of the proxy calling NVIDIA per session.

The algorithm is pinned to ES384 rather than read from the token, which is where the JWT confusion attacks start, `alg: none` included. `iss`, `exp` and `nbf` are checked, every token is verified, and any failure fails the session.

The signing certificate's own validity window is enforced per token, and that is what bounds a withdrawn key. Measured rather than assumed:

```
cert[0]  CN=NVIDIA Attestation Service GPU GH100             valid 48 hours
cert[1]  CN=NVIDIA Attestation Service GPU Intermediate 004  valid to Dec 2029
         issued by NVIDIA Attestation Service CA 001
```

Because a withdrawn key stops working on NVIDIA's own 48 hour schedule, the key set does not need frequent polling. It is cached for 12 hours and refetched whenever a token names a `kid` not held, rate limited so a malformed token or a failing NVIDIA cannot become a request flood.

If you have obtained NVIDIA's intermediate or root out of band and would rather not rely on the TLS fetch, `gpu_pinned_certs` takes SHA-256 digests that must appear in the token's chain:

```yaml
gpu_pinned_certs:
  - "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
```

This is deliberately not full RFC 5280 path validation, since a hand-rolled X.509 validator is security-critical code that is usually subtly wrong. The leaf certificate is required to carry the same key as the JWK, and a malformed digest is rejected at startup rather than silently never matching.

## Response receipts

Attestation proves an enclave exists. It says nothing about whether your request went through it: Venice could serve you from an ordinary GPU and the attestation would still check out. The receipt narrows that gap, though not as far as it first appears.

Set `verify_receipts: true` and the proxy fetches `GET /api/v1/tee/signature` after each completion and verifies it, on both paths:

```
INFO  Receipt authentic for 0b56cc7a57e14e69a7269ae25288a830 (e2ee-glm-5-2-p): signature,
      keyset and chat id check out. Body binding not reproducible from here.
```

It says "authentic" rather than "verified" deliberately. `verified` is the library's own field, and it is `false` on every completion because of the two body-hash checks below. Reporting that as a failure would be accurate and useless.

### The trust anchor is pinned, not proven

`verifyReceipt` needs a workload identity and keyset digest it can trust, and refuses to take them from the response being checked, since a provider serving both sides would just make them agree.

There is no cryptographic source for those values today. Venice's TDX quote binds the signing address and your nonce, and says nothing about the ACI keyset digest. The `keyset_endorsement` signature sitting next to it could close that gap, but its message construction is undocumented; 112 candidate reconstructions failed to recover the attested signer, the same wall the top-level secp256k1 signature runs into.

So the proxy pins on first use, the way SSH pins a host key. The first attestation for a model is recorded to `receipt_anchor_store`, and every later one has to match. A change is an error, not a silent update:

```
ERROR Receipt anchor CHANGED for e2ee-glm-5-2-p — pinned sha256:3def…/sha256:dead…,
      attestation now says sha256:3def…/sha256:c5c0…. The workload serving this model
      is not the one pinned.
```

This catches a substituted keyset or a silent downgrade. It does not establish that the enclave was genuine at pin time: pin what Venice says and you have pinned Venice's claim. The first request says so explicitly. If you have an out-of-band source for the digest, set it under `receipt_anchors` and it takes precedence:

```yaml
receipt_anchors:
  e2ee-glm-5-2-p:
    workloadId: "sha256:3def476b…"
    workloadKeysetDigest: "sha256:c5c0f582…"
```

The store is read once at startup, so edits need a restart.

### The body binding cannot be checked from here

A receipt carries hashes of the request and response bytes. Measured against the live API, those two checks never pass from behind `api.venice.ai`. They fail identically on both paths, streaming or not, which places a re-serializing hop between this proxy and the enclave issuing the receipt. Venice demonstrably re-wraps responses, adding `cost` and `venice_parameters`, and the request hashes point the same way.

The proxy reports this rather than failing, since a failure on every completion would just teach you to ignore it. So a receipt buys you the fact that the attested enclave signed a receipt for this completion id, 12 of the 14 checks below. It does not buy proof that the bytes you received are the ones it produced. Only something sitting directly in front of the ACI gateway could establish that.

### Not every model issues receipts

`e2ee-deepseek-v4-flash` attests as Intel TDX and serves E2EE traffic normally, but returns the pre-ACI attestation shape, with no `workload_id` and no keyset. That is a missing capability rather than a failure, and it is reported once per model without affecting completions.

Models can also share a workload, in which case they pin to the same anchor, recorded per model so a move by either is still visible. `e2ee-glm-5-2-p` and `e2ee-qwen3-30b-a3b-p` did; as of August 2026 the latter's attestation endpoint returns 502, so that pairing cannot currently be re-checked.

### The checks

Fourteen run, and the library's `verified` requires every one.

| Check | What it rules out |
|---|---|
| `verification_context_present` | verifying against a missing or partial trust anchor |
| `api_version_supported` | a receipt in a protocol version these rules were not written for |
| `keyset_well_formed` | a malformed keyset that later checks would read loosely |
| `keyset_digest_matches_trust_anchor` | a substituted keyset, since the digest is recomputed rather than read |
| `attestation_keyset_digest_matches_trust_anchor` | the attestation pointing at a different keyset than the anchor |
| `receipt_keyset_digest_matches_trust_anchor` | the receipt naming a keyset other than the anchored one |
| `workload_id_matches_trust_anchor` | a receipt from a different workload than the pinned one |
| `key_in_trusted_keyset` | a receipt signed by a key the enclave never vouched for |
| `key_algo_matches` | algorithm confusion between receipt and keyset |
| `receipt_signature` | any edit to the receipt or its event log |
| `chat_id_matches_request` | a valid receipt for somebody else's completion |
| `signing_address_cross_check` | the two endpoints describing different enclaves |
| `request_body_hash_matches` | never passes from here, see above |
| `response_body_hash_matches` | never passes from here, see above |

Four of these compare against the trust anchor rather than the response. That is the point: a provider serving both the receipt and the attestation could make them agree with each other, but not with a value pinned earlier.

The signature is Ed25519 over the RFC 8785 (JCS) canonicalization of the receipt with `signature.value` removed, under a key from `attestation.workload_keyset.receipt_signing_keys`, which is the scheme Phala's [private-ai-gateway](https://github.com/Dstack-TEE/private-ai-gateway) reference verifier implements. The top-level secp256k1 `signature` over `<request-hash>:<response-hash>` in the same response is not what gets checked; its message construction is undocumented and the reference verifier ignores it.

## Function calling

> For agent workloads use the `tee-` prefix rather than `e2ee-`. Function calling over E2EE is best-effort and fails often enough to be unusable for anything chaining tool calls. See [E2EE tool calling is best-effort](#e2ee-tool-calling-is-best-effort).

Pass `tools` and `tool_choice` exactly as with the OpenAI API. Verified end to end against the live API on both paths:

| Model | Tools | Context | Output | $ in / M | $ out / M |
|---|---|---|---|---|---|
| `e2ee-glm-5-2-p` | yes | 524288 | 32768 | 1.75 | 5.75 |
| `e2ee-deepseek-v4-flash` | yes | 1000000 | 8192 | 0.182 | 0.373 |
| `e2ee-qwen3-6-27b` | yes | 256000 | 32768 | 0.346 | 3.46 |
| `e2ee-qwen3-6-35b-a3b` | yes | 32000 | 4096 | 0.182 | 1.18 |
| `e2ee-gemma-4-31b` | no | 32000 | 4096 | 0.139 | 0.43 |

Check `supportsFunctionCalling` on `/models` before relying on tools. The two paths disagree about what happens when it is `false`. TEE-only refuses, because `tools` is a real request parameter and Venice rejects it with `400 "tools is not supported by this model"`, so you find out immediately. E2EE appears to work, because schemas travel inside the prompt and Venice's capability check never sees them. `e2ee-gemma-4-31b` emits well-formed `<tool_call>` blocks that this proxy parses into real `tool_calls`, but the model was never trained for the round trip and echoes the `<tool_response>` back instead of answering it.

So the prompt-based path is not a way to add function calling to models that lack it. It is a way to keep function calling private on models that have it.

(`e2ee-qwen3-30b-a3b-p` and `e2ee-qwen3-vl-30b-a3b-p` also advertise function calling, but Venice's attestation endpoint has been returning 502 for them, unrelated to this proxy.)

Venice's E2EE gateway drops the `tools` request parameter, so a request carrying encrypted messages reaches the model with no schemas attached. The same model returns native tool calls when the E2EE headers are absent, so this is a property of the encrypted path rather than the model. Passing `tools` through would have been the worst of both worlds: the model would ignore your tools while their names, descriptions and schemas travelled to Venice in plaintext.

So the proxy moves function calling inside the encrypted channel. Schemas are rendered into a system message and encrypted with the rest of the conversation. The model's `<tool_call>` blocks are parsed out of the decrypted stream and converted back into OpenAI `tool_calls`. Prior `tool_calls` and `tool` results in your history are folded into encrypted message content, and the plaintext `tool_calls` field is dropped before the request leaves. The test suite asserts that none of them reach the wire.

Two consequences: tool calling is prompt-driven rather than constrained decoding, so validate arguments before acting on them; and requests carrying tools cost extra prompt tokens for the injected schemas.

Because the model follows a prompt rather than a constrained decoder, the decoder accepts more than the format it asks for: `<function_call>` and `<|tool_call|>` tags as well as `<tool_call>`, several calls batched into one block as an array or a `{"tool_calls": [...]}` wrapper, `tool_name`/`args` spellings, an OpenAI-shaped `{"function": {...}}` payload, and a call emitted with no tags at all. The untagged form is only accepted when it names a tool you actually declared, so a model asked to reply in JSON still returns JSON. A single argument passed bare (`"arguments": "Bratislava"`) is wrapped using the schema when the function takes exactly one parameter.

Using the library directly, pass the schemas to the parser (`new ToolCallStreamParser({ tools })`), since argument coercion and untagged recovery both need them. The proxy does this for you.

### What GLM emits

GLM has its own tool-call template it was trained on, and it uses the same `<tool_call>` tag this prompt asks for. So it reaches for that tag and fills it with a blend of its own format and the requested JSON, differently each time. Captured verbatim from `e2ee-glm-5-2-p` in one opencode session:

```
<tool_call>read</arg_value>filePath</arg_key><arg_value>/Users/juraj/…</arg_value></tool_call>
<tool_call>glob<arg_key>pattern "**/opencode.json"</arg_value></tool_call>
<tool_call>
{"name":"edit","arguments":{"filePath":"…","oldString":"…"}}
</tool_call>
```

All three parse. The decoder accepts the JSON body, well-formed `<arg_key>`/`<arg_value>` pairs, those pairs with tags missing or run together, and, gated on the declared schemas, a body with no tags at all. A block that still yields nothing is returned as visible content rather than dropped, so a format nobody has seen yet shows up as a mangled answer instead of an empty turn.

In that session the degenerate form appeared on the first tool call and every later turn used clean JSON, which fits the rendered tool history acting as a worked example the first call does not have.

### E2EE tool calling is best-effort

On the `e2ee-` path the schemas travel inside the prompt and tool calls have to be parsed back out of prose. That last step is the problem: the model reproduces a format by imitation instead of emitting structured output, and GLM does not do it reliably.

Across five captured agent sessions (48 responses, 96 tool calls) GLM 5.2 produced a different malformed syntax on almost every run. A sample of what the same model emitted for the same task on consecutive attempts:

```
<tool_call>grep pattern="good.?match" include="*.svelte"       attribute pairs
<tool_call>tasksubagent_type: "explore"description: "…"        name glued to key
<tool_call>grep{"pattern":"…"}{"path":"…"}                     one object per argument
<tool_call>readfilePath":"/src/app.css","limit":15}            opening brace absorbed
<tool_call>edit(filePath:"…", oldString:"…")                   call syntax
<tool_call>grep\npattern\ngood.?match                          line-delimited
<tool_call>pattern":"--ok|--accent-bg</arg_value>              no tool name at all
```

The parser handles the well-formed shapes and a few mechanical repairs: unescaped newlines inside JSON strings, unquoted keys, parentheses for braces, stray `<arg_key>`/`<arg_value>` tags. About a quarter of tool calls still do not survive, and those surface as visible markup in the response instead of a call.

That is deliberate. Recovering the rest means guessing where one argument ends and the next begins, which was implemented and then removed: it converted lost calls into plausible-looking wrong ones. A `grep` whose pattern was silently truncated looks like it worked, and an `edit` with a corrupted `oldString` fails in a way that is much harder to diagnose than a call that visibly did not happen. A missing call is recoverable; a wrong one is not.

Use `tee-` for tool calling. The request stays inside the attested enclave and Venice's native function calling handles schemas properly. The trade is that prompts are not end-to-end encrypted on that path, so you are relying on the TDX attestation instead. The proxy logs a warning the first time it sees `tools` on an `e2ee-` model.

### Debugging tool-call formats

When a client's tool call does not come back as expected, set `VENICE_PROXY_DEBUG_DUMP` to a file path. The proxy appends one JSON object per request and per response: the tool schemas and fully rendered prompt going in, and the raw decrypted model text going out, captured before the tool parser touches it, alongside reasoning, chunk count and the parsed result.

```bash
VENICE_PROXY_DEBUG_DUMP=/tmp/venice-dump.jsonl npm run dev
```

> This writes your plaintext prompts and responses to disk, which is what the rest of this proxy exists to prevent. It is off unless the variable is set, the proxy warns the first time it writes, and the file is yours to delete. Do not leave it enabled.

## Clients

The proxy exposes an OpenAI-compatible API on `POST /v1/chat/completions` and `POST /chat/completions`, plus `GET /health`. Any OpenAI-compatible client works:

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:3000/v1", api_key="unused")
response = client.chat.completions.create(
    model="e2ee-qwen3-30b-a3b-p",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(response.choices[0].message.content)
```

Function calling uses the ordinary OpenAI tool loop: pass `tools`, read `msg.tool_calls`, append a `{"role": "tool", "tool_call_id": ...}` message with your result, and call again. Tool calls come back in standard form, and streaming delivers them as `delta.tool_calls` followed by a `finish_reason: "tool_calls"` chunk.

Concurrent requests are safe. Sessions are cached per model and shared, since encryption uses fresh IVs and decryption uses per-chunk ephemeral keys from the server.

### opencode

[opencode](https://opencode.ai) is an AI coding agent that supports any OpenAI-compatible backend. Add the proxy as a provider in `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "venice-e2ee": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Venice E2EE Proxy",
      "options": { "baseURL": "http://127.0.0.1:5656/v1", "apiKey": "unused" },
      "models": {
        "tee-e2ee-glm-5-2-p": {
          "name": "GLM 5.2 (TEE)",
          "tool_call": true, "reasoning": true, "attachment": false,
          "limit": { "context": 524288, "output": 32768 },
          "cost": { "input": 1.75, "output": 5.75 }
        }
      }
    }
  },
  "model": "venice-e2ee/tee-e2ee-glm-5-2-p",
  "small_model": "venice-e2ee/tee-e2ee-qwen3-6-35b-a3b"
}
```

[`opencode.example.json`](opencode.example.json) has the full list: the four models with `supportsFunctionCalling: true` that also pass a live attestation probe, each in both `tee-` and `e2ee-` form. The `tee-` variants are the defaults because Venice's native function calling works on that path, while the `e2ee-` path's prompt-based parsing is best-effort. The `e2ee-` entries stay selectable for non-tool or maximum-privacy turns.

## Testing and development

```bash
npm test              # unit tests
npm run test:watch    # watch mode
npm run test:curl     # manual curl tests, proxy must be running
npm run dev           # tsx, auto-reloads
npm run build && npm start
```

## Security

Private keys are zeroized when sessions expire or are cleared, and ECDH intermediates are zeroized after key derivation. Messages use AES-256-GCM with random IVs. Streaming responses get forward secrecy from per-chunk ephemeral server keys. Sessions expire after the TTL and stale ones are detected and refreshed on decryption failure. TEE attestation prevents man-in-the-middle attacks against the enclave you are talking to.

The proxy binds to `127.0.0.1` and should not be exposed to the public internet. It is designed to run locally alongside your application.

## Related projects

[`@axlabs/venice-e2ee-proxy`](https://github.com/AxLabs/venice-e2ee-proxy) is an independent proxy over the same Venice protocol, and the more packaged of the two: `npx`-installable, NestJS with a Swagger UI, validated CLI flags, and a `DCAP_PCCS_URL` setting. Its [`NOTICE.md`](https://github.com/AxLabs/venice-e2ee-proxy/blob/main/NOTICE.md) is a good treatment of the GPL question that applies to any proxy bundling this library.

Two differences before picking one. It binds to `0.0.0.0` by default while holding your Venice API key, where this one binds to `127.0.0.1`. And it forked the encryption library at a commit predating function calling over E2EE, so tool calls take a different path there than the one documented above. Its `VERIFY_GPU_ATTESTATION` flag reads Venice's self-reported verdict rather than checking with NVIDIA; see [GPU attestation](#gpu-attestation).

## License

GPL-3.0-only. See [`LICENSE`](LICENSE), and [`NOTICE.md`](NOTICE.md) for why: the proxy vendors the GPL-3.0 `venice-e2ee` library as a submodule and links it at runtime, so any distributed build is a combined work under the GPL. Running the proxy yourself, including as a service reachable over the network, carries no distribution obligation. This is the GPL, not the AGPL.

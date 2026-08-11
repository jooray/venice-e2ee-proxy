# Security audit: venice-e2ee-proxy and the attested Venice/Phala stack

Date: 2026-08-06. Auditor: Qwen (automated review, live experiments included).
Scope: this proxy repo (commit `3ac2725`), the vendored `venice-e2ee` library
(submodule v0.4.1, `fd7a0e2`), and, transitively, what the attested Venice
enclave actually runs, verified against the live API with a real API key.

Everything below marked "live" was observed from `api.venice.ai` or the attested
endpoints on 2026-08-05/06. Everything marked "source" was read from the pinned
gateway commit `aa65d64c191949b8df7b1ebe210f5b8f8a8e6b99` of
`Dstack-TEE/private-ai-gateway`, the exact commit the quote names.

---

## Abstract

The proxy encrypts prompts on your machine to a key carried in an Intel TDX
attestation, so Venice's network and infrastructure never hold plaintext.
Decryption happens inside a Phala-operated enclave, the gateway, which forwards
your plaintext to an inference router, which forwards it to a GPU node.
"End-to-end" therefore means end-to-enclave, not end-to-nobody. The encryption
itself works. What is worth auditing is what those enclaves are, and how much of
the claim about them a client can check for itself.

Start with what a client verifies on its own. DCAP-verifying the gateway's TDX
quote against Intel's PCK roots and CRLs establishes genuine, current silicon in
a non-debug TD. That quote's REPORTDATA binds the key you encrypt to, the nonce
you chose, and, on the enclave's native ACI endpoint, the digest of its workload
keyset. The third binding is what makes the rest possible: the keyset holds the
receipt-signing keys, so the signed receipt for your completion verifies under an
anchor proven by Intel rather than pinned on first sight. The receipt's event log
carries the gateway's verdict on the machine it forwarded to, along with a
content-addressed session id. Fetch that session, recompute its id, and the
router's own attestation report comes back inline. Its quote DCAP-verifies too,
and its attested TLS key has to be the one the gateway actually dialled. NVIDIA
separately vouches for the GPU evidence served with the attestation, with your
nonce in the token, though the enclave serving it reports `num_gpus: 0`, so that
verdict describes some confidential GPU rather than the one that ran your prompt.
A secp256k1 signature made by the quote-bound key covers the request and response
hashes.

The gateway also verifies on your behalf, and its check is substantial. Before
forwarding, it runs `aci-service/v2` against the router: full DCAP with
collateral, an RTMR3 replay from the event log matched against the quote, the
`app_compose` preimage matched to the RTMR3-bound compose hash, the KMS custody
chain, and a channel binding requiring the router's TLS SPKI to be in its
attested keyset for the host being dialled. Because the evidence behind that
check is served and committed to, a client re-runs its substance rather than
trusting the summary. The router runs an analogous check one hop further down
against the GPU nodes, under `private-ai-verifier/phala-direct/v1`, which treats
GPU evidence as supplemental and never as a gate. That verdict is published only
as an unsigned list, and the GPU nodes' own attestation endpoint answers 401
without the router's bearer token, so the third hop is where independent checking
stops.

Four gaps remain, roughly in order of how much they matter. The serving software
is unattested at every hop: `serving_software_known_good` and
`model_weights_provenance` are `unknown` in every claim set, so the program that
reads your prompt and the weights it runs are the one thing nobody measures. The
quote measures a recipe rather than a binary: the gateway is built from source at
boot against a persistent, unmeasured cargo cache, and `image_digest` is null, so
the attestation fixes an instruction to build a commit rather than the artifact
that ran, on a dev OS image, with `secure_time: false` and `public_logs: true`.
Runtime state sits outside the quote: the routing table is installed through an
admin token, an SSH key may or may not have been injected
(`DSTACK_ROOT_PUBLIC_KEY` is in `allowed_envs`, and attestation cannot tell you
which), and an external control plane picks your route per request. Two bindings
stay out of reach: the gateway does not publish the nonce behind the router's
report, so that hop's freshness rests on the gateway having behaved, and Venice
re-serialises request and response bodies, so the receipt's body hashes never
reproduce from a client's vantage point. Upstream verification is also advisory
rather than enforced on the domain Venice's traffic uses (`required: false`), and
nothing ties the NVIDIA-attested GPU to the TDX-attested CPU beyond a shared
nonce.

### The wins that would make this real

Roughly in order of value per unit of effort. Measuring the serving software and
weights comes first, because an unattested inference stack means every attested
hop above it proves something about the wrong component, and this is the one
change that would move "confidential inference" from a deployment property to a
verifiable one. Second, ship the gateway as a digest-pinned, reproducibly built
image instead of compiling from source at boot against a mutable cache, so the
quote measures the binary that ran. Third, run a production dstack image with no
SSH: drop `DSTACK_ROOT_PUBLIC_KEY` from `allowed_envs`, turn off the serial
console, and if remote access has to stay possible, reflect in the attestation
evidence whether a key was actually injected. An operator who might have root
inside the enclave, with no way for a relying party to tell, undoes much of what
the quote establishes. Fourth, enforce upstream verification on the route Venice
actually uses, by putting `api.redpill.ai` in `tee_only_domains` and accepting
`provider.aci_verified` from clients, so a failed check blocks a request instead
of being noted in a receipt afterwards. Fifth, publish the nonce behind each
upstream report, or chain it to the caller's, which closes the last freshness gap
in the transitive chain for the cost of one field. Sixth, stop re-serialising
between clients and the gateway, so the two body-hash checks that can never pass
today become proof that the bytes you received are the bytes the enclave
produced. Items one to three and five are Phala's to make, six is Venice's, and
four needs both: Venice to accept the flag on its API, Phala to add the domain to
the measured `tee_only_domains`. None of them requires new cryptography. Every
one is a deployment or plumbing decision the protocol already accommodates.

### How this reads next to the other providers

This audit covers one provider and one client. The cross-provider version is
Andrew Miller's [awesome-private-inference](https://github.com/amiller/awesome-private-inference)
([dashboard](https://amiller.github.io/awesome-private-inference/)), a registry
that re-verifies attestation bundles from Venice, NEAR AI, Tinfoil, Chutes and
RedPill/Phala every day and scores which layers each one proves. Its finding is
that none of them is complete, and the shapes recur: serving code excluded from
the measurement, mutable image tags, operator SSH on dev OS images, gateway
checks that are advisory rather than enforced. Read alongside §2.4, it is
useful for telling which of the gaps below are Venice's and which are what the
whole category currently looks like. The per-provider reasoning lives in
[devproof-audits-guide](https://github.com/amiller/devproof-audits-guide/tree/main/case-studies),
whose [Venice case study](https://github.com/amiller/devproof-audits-guide/blob/main/case-studies/venice-private-inference/DEVPROOF-REPORT.md)
(2026-04-24) takes the complementary angle to this one: it confirms the wire
protocol by live probe and then goes after `veniceai/skills`, the agent-facing
guidance, which misnames ECIES as HPKE or Noise, points at a 404, and teaches
none of the verification this proxy performs. That is the trust-on-first-use
hole the client side of this document is written to avoid.

The registry revised Venice's score on 2026-08-10 after reading this audit.
`prod_os_image` and `serving_code_attested` had been left out of Venice's
required layers on the grounds that the backend belongs to NEAR or Phala, which
made Venice the only complete row on the dashboard. Those are exactly the two
layers where §2.4 locates the prompt-path exposure: the dev OS image with
`DSTACK_ROOT_PUBLIC_KEY` in `allowed_envs`, and the unmeasured serving software
at the hop that holds plaintext. Venice now reads 6 of 9, Stage 1 with a
verifying proxy and Stage 0 for the infrastructure and the skill. The registry's
own post-mortem on having set the bar wrong is
[issue #11](https://github.com/amiller/awesome-private-inference/issues/11), and
the general fix, deriving each provider's bar from its claims rather than from
what its API happens to expose, is
[issue #6](https://github.com/amiller/awesome-private-inference/issues/6).

---

## 0. Verification pass, 2026-08-06

Every claim above was re-checked against the code, the pinned gateway source,
and the live API. Most held. The findings on the proxy and library were accurate
at the cited lines, the container table is right down to which images carry
digests, and B1 to B4, B6, B8, B9 and B10 reproduce verbatim.

Four claims did not hold, all of them about the same thing: how much of this
chain is cryptographic. The audit concluded the trust chain bottoms out in
trust-on-first-use and in undocumented formats. That conclusion was wrong.

The quote binds the keyset digest, so B7 was wrong. Venice's
`/api/v1/tee/attestation` serves the legacy report shape, whose `report_data` is
`[address(20) | zeros(12) | nonce(32)]`, and that part of the finding is right.
But the same enclave answers `GET /v1/aci/attestation` on its own hostnames,
unauthenticated, and there `report_data` is

```text
sha256(JCS({purpose: "aci.report_data.v1", workload_id, workload_keyset_digest, nonce}))
```

Recomputed live: `494b1fa37be7df75379c37922491a3b57a04509d15599e64b86f3d89e6363d83`,
byte-for-byte the quote's REPORTDATA, with the same `workload_id` and keyset
digest Venice reports. A proven anchor could have replaced TOFU the whole time,
with no vendor change. Now implemented; see §4.

`keyset_endorsement` is documented and verifies. It is ECDSA-secp256k1 over
`sha256(JCS({purpose: "aci.keyset.endorsement.v1", workload_keyset_digest}))`
under the identity key. The construction is in the gateway source this audit
read (`src/aci/types.rs:183`, `src/aci/identity.rs:61`). It verifies live, so the
"112 reconstructions failed" note can be retired.

The custody `signature_chain` is documented and verifies too. `chain[0]` is a
recoverable secp256k1 signature over `keccak256("{purpose}:{compressed_pubkey}")`
recovering an app key; `chain[1]` covers
`keccak256("dstack-kms-issued:" || app_id || compressed_app_key)` and recovers the
KMS root (`src/aci/verifier/dstack.rs:218-239`). Verified live for the identity
key. One caveat matters, though: the recovered root
(`0334c76e0c3f52ec64cbf9bbf5c910c272330166fd656c0a86bb330963e46910e1`) is not the
P-256 key in the measured `key-provider` event, and is not in the measured
compose either. That chain terminates at an out-of-band constant, so it adds
nothing the `report_data` binding does not already give, and the `report_data`
binding is the one to rely on.

The top-level signature is verifiable. The audit calls it unverifiable and
suggests Venice document or drop it. It is EIP-191 `personal_sign` over
`"<request_hash>:<response_hash>"`, recovering to
`0x79a5061efe5a46b0d1f33b11cf1c5adbedae6b79`, the address the quote carries in
REPORTDATA. That makes it the only artifact in the scheme signed directly by a
quote-bound key, and neither the audit nor the library was using it. Now
verified; see §4.

### Transitive verification is real, and committed rather than asserted

This was the question the audit was commissioned to answer, and §2.1 understates
it in both directions.

`aci-service/v2` is a thorough check. It runs DCAP with collateral, replays
RTMR3 from the event log against the quote, matches the `app_compose` preimage
to the RTMR3-bound compose hash, walks the KMS custody chain, and requires the
upstream's TLS SPKI to appear in its attested keyset and match the host being
dialled (`src/aci/verifier/aci_service.rs`). That last requirement is channel
binding, which rules out verifying one machine and then talking to whichever host
answers.

The verdict also reaches a client as a commitment rather than an assertion. The
receipt's `upstream.verified` event carries a `session_id` that is
content-addressed:

```text
session_id = "as_" + sha256(JCS({upstream_name, endpoint, verifier_id,
                                 identity, channel_binding, claims, evidence_digest}))
```

Recomputed against the gateway's public session store, our receipt's session
matched, and so did 346 of the 346 records in the store. So "you only have the
router's word, and that session list is unsigned" does not hold. The list needs
no signature, because the ids are hashes and the hash sits inside a signed
receipt. The recommendation to sign `/v1/aci/sessions` asks for something weaker
than what already exists.

The evidence is served as well. Fetched by id rather than from the list, a
session carries the upstream's complete ACI report inline as a `data:` URI, quote
included. The second hop is therefore checkable rather than only committed to:
its TDX quote DCAP-verifies against Intel's roots from a client machine, and the
TLS key the gateway bound the channel to appears in that upstream's own attested
keyset for the host it dialled. Both checks now run in the proxy (§4).

What survives of the concern is narrower than the audit had it, and comes to two
things. First, `required: false` on Venice's route means the check is recorded
rather than enforced, and B2 is exactly right about why. Second, freshness: the
gateway does not publish the nonce it sent when it fetched that report, so the
statement binding cannot be recomputed and a captured report cannot be told from
a current one. Everything else in the chain is verifiable from a client's own
machine.

### Claims the audit missed

- Two defects in this proxy, both now fixed. The gateway's upstream verdict was
  reported before the receipt carrying it was verified, so a failed receipt still
  produced "Gateway verified the upstream…" from unauthenticated text. The
  receipt path also re-fetched attestation through `instance.attest()`, which runs
  no quote checks at all, then recorded the TOFU anchor from that response.
- B5 is overstated. `dstack-verifier:latest` is genuinely unpinned, but the
  measured compose states the ACI path uses "the gateway's vendored
  confidential_verifier package, so it needs no separate pin". The sidecar serves
  the NEAR-AI path, so it is not a trust root on Venice's route.
- `aci_session_ids` exists (`src/aggregator/service/wire.rs:275`): a hard
  allowlist pinning a request to specific attested sessions. Unusable through
  Venice, which rejects the whole `provider` block, but available to anyone
  calling the gateway directly.
- The gateway's session store is world-readable on all three hostnames, exposing
  346 sessions with endpoints, claims and bindings. It is what makes the
  verification above possible, and also an enumeration surface nobody asked for.
- That store serves the evidence, not just its digest. The by-id endpoint returns
  the upstream's full ACI report inline, which is what makes independent
  verification of the second hop possible at all.
- The claim that the OS image "cannot be inspected" is contradicted by
  `phala_direct.py`, which re-downloads the published image and verifies the
  hash-to-`is_dev` binding.

Minor drift: `keyset_epoch.not_after` measured 2.04 days out rather than roughly
2.6, since it rotates. 70/70 proxy tests pass as claimed, and the library is at
246/246 after this work.

---

## 1. The proxy and the library (your code)

### Verdict

The code is solid and fail-closed by default, with documentation that is unusually
candid about its own limits. 70/70 unit tests pass. I found no vulnerability in
the proxy or library that breaks E2EE confidentiality. The weaknesses are
architectural, inherited from Venice's protocol, plus a few minor items.

### What it gets right

- Attestation gating: nothing is sent if verification fails; GPU check fails
  closed, including when no `nvidia_payload` is served (`src/session-manager.ts:149`,
  `venice-e2ee/src/attestation.ts:508`).
- Nonce binding, signing-key binding, debug-bit check all recomputed client-side
  from the quote (`venice-e2ee/src/attestation.ts:360-399`), constant-time compares.
- NVIDIA tokens: algorithm pinned to ES384 (no `alg` confusion), `iss`/`exp`
  required, every token verified, JWKS cached with a revocation-window TTL and
  leaf-cert validity enforcement (`venice-e2ee/src/nras-jwks.ts`).
- Plaintext-downgrade protection: `decryptChunk` rejects unencrypted content
  unless explicitly allowed (`venice-e2ee/src/crypto.ts:92-101`); the proxy never
  enables `allowPlaintextResponses`.
- Tool schemas/arguments never leak outside the encrypted channel on the E2EE
  path; tests assert `tool_calls` never reach the wire (`src/proxy.ts:487`).
- API key kept out of config file, env only (`src/config.ts:143`).
- Receipt anchors: TOFU with loud conflict reporting, config pins beat recorded
  pins (`src/receipt-anchors.ts:84`).
- Debug plaintext dump is off unless explicitly enabled, warns on first write
  (`src/debug-dump.ts`).

### Minor findings (proxy/library)

| # | Finding | Severity | Note |
|---|---|---|---|
| P1 | The local proxy has no authentication. Anyone with access to `127.0.0.1:PORT` can spend your Venice API key and route prompts through the E2EE path. | low (documented, loopback bind) | If you ever expose it (container, LAN), add a bearer token. The AxLabs variant binds `0.0.0.0` by default, which the README already flags. |
| P2 | `logger.error(\`Venice API error (${status}): ${errorText}\`)` logs Venice's full error body (`src/proxy.ts:282,544`). On the TEE-only/passthrough paths Venice error bodies can echo request fragments, so your own proxy log can contain prompt text. | low | Truncate/redact, or log status only. |
| P3 | In streaming E2EE, chunks that fail decryption non-fatally are silently skipped (`decryptField` returns null, then `continue`, at `src/proxy.ts:654,733`). A malicious server could drop selected chunks without detection. | info | The server controls the model output anyway, so this is an integrity nuance rather than a confidentiality one. Receipts, when enabled, partially cover the wire bytes. |
| P4 | HKDF uses an empty salt and the info string `ecdsa_encryption` (`venice-e2ee/src/crypto.ts:47`), a legacy Venice protocol choice with no domain separation between directions or models. | info | Venice's protocol. Server-to-client traffic uses fresh ephemeral keys per chunk, which mitigates it. Not fixable client-side. |
| P5 | Session attestation is reused up to `SESSION_TTL` (30 min). The attestation `freshness` window served by Venice is 1h (`fetched_at`/`stale_after`), so the default is inside bounds, but nothing stops you configuring a TTL longer than the freshness window. | info | Library could clamp TTL to `stale_after`. |
| P6 | `keyset_epoch.not_after` (keyset rotation deadline, ~2.6 days out in the live response) is not surfaced by the proxy. | info | Would explain/detect forced re-attestations. |
| P7 | Missed by this audit. The gateway's `upstream.verified` verdict was logged before the receipt carrying it was verified (`src/proxy.ts:359`, ahead of the result checks). A receipt that failed verification still produced "Gateway verified the upstream…" from event-log text nothing had authenticated. | low, now fixed | A log line rather than a gate, but it is the transitive evidence this audit exists to assess, reported without checking it. |
| P8 | Missed by this audit. The receipt path called `instance.attest()`, which performs no quote verification at all (`venice-e2ee/src/index.ts:203`), and the TOFU anchor was recorded from that unverified response. It also cost one extra attestation round trip per completion. | low, now fixed | Now superseded: the anchor comes from a DCAP-verified quote. |

None of P1 to P6 changes the E2EE guarantee against Venice-the-network; they are
hygiene. P7 and P8 were a different matter, since they let the proxy present
unauthenticated server text as a verified finding, and both are fixed in §4.

---

## 2. What the attested containers actually do

### 2.1 The chain your prompt travels (live-verified)

```
you ──TLS──> api.venice.ai ──> [CVM-1 gateway] ──TLS──> [CVM-2 router] ──TLS──> [GPU node]
              (unattested,        tee.redpill.ai etc.      glm-5-2.aus1-router     glm-5-2.aus1/aus2
               re-serializes)     (attested, this is       .phala.com              .phala.com
                                   where E2EE terminates)   (attested)              (attested per router)
```

Live receipt for my test completion `39704d6fb8964b0081914c240432945e`
(model `e2ee-glm-5-2-p`, prompt "Reply with exactly: AUDIT-MARKER-7f3a…"):

- route selected: `phala-142:z-ai/glm-5.2`
- forwarded to `https://glm-5-2.aus1-router.phala.com`, verifier `aci-service/v2`,
  `result: verified`, **`required: false`**
- claims: `tee_attested: asserted`; `gpu_attested`, `tcb_up_to_date`,
  `os_known_good`, `serving_software_known_good`, `model_weights_provenance`
  all **unknown**
- `transparency.request_modified` and `transparency.response_modified` events,
  which confirm that a hop (Venice's API) re-wraps bytes between you and the
  enclave. That is why receipt body-hashes never reproduce from here.

The router's **public, unauthenticated** `/v1/aci/sessions` then shows the
third hop: it load-balances across `glm-5-2.aus1.phala.com` and
`glm-5-2.aus2.phala.com`, verified with `private-ai-verifier/phala-direct/v1`,
claims `tee_attested/gpu_attested/tcb_up_to_date/os_known_good: asserted`,
`serving_software_known_good/model_weights_provenance: unknown`. The GPU
nodes' own attestation endpoint (`/v1/attestation/report`) returns 401 without
the router's bearer token, so the third hop cannot be inspected independently.
You have the router's word for it, on an unsigned session list.

### 2.2 Container-by-container (CVM-1, the enclave you attest)

Measured compose manifest, reproduced: `MRCONFIGID = 0x01 ‖ sha256(app_compose)`,
and the event-log `compose-hash` matches. `scripts/audit-attestation.py` passes
live.

| Container | Image | What it does | Attested how |
|---|---|---|---|
| `dstack-ingress` | `dstacktee/dstack-ingress:2.2` **pinned by digest** | TLS-terminates `tee.redpill.ai`, `inference.phala.com`, `api.redpill.ai` (Let's Encrypt via Cloudflare DNS-01), forwards the **decrypted** stream to the gateway over the compose network. Inside the CVM, so covered by the same quote. E2EE ciphertext passes through it still encrypted. | digest in measured compose |
| `launcher` | `ghcr.io/redpill-ai/private-ai-launcher` **pinned by digest** | Clones `Dstack-TEE/private-ai-gateway` at the measured commit, builds it (`cargo build --release --locked`), runs it under supervisord. Public source; image is reproducible-built (epoch-0 timestamp), rust 1.94.1 toolchain baked in. | digest in measured compose; source public |
| gateway process | **built from source at boot, not an image** | The thing that decrypts your prompt. Routes, consults control plane, verifies upstreams, signs receipts. | only the *instruction* "build commit aa65d64" is measured; the binary is not |
| `dstack-verifier` | `dstacktee/dstack-verifier:latest`, NOT pinned | TDX quote verifier sidecar used by the NEAR-AI path (and by phala-direct on CVM-2). | tag only, so content can drift between boots without any measurement changing |
| `node-exporter` | `prom/node-exporter:v1.8.2` **pinned** | CVM host metrics, basic-auth protected. | digest in measured compose |

OS: `dstack-dev-0.5.9-de9c74f0`, a dev dstack build. The hash is measured and
fixed, but the image contents are not published or reproducible, so what boots
cannot be inspected. The gateway's own phala-direct verifier source comments that
"the deployed fleet currently runs dev images" and that dev images have
"SSH/serial-console enabled" (`scripts/provider_verifier/phala_direct.py:239`).

### 2.3 What IS attested (holds up under recomputation)

- Genuine TDX quote, DCAP-verified against Intel roots (proxy does this; Venice's
  own `server_verification` agrees, incl. CRL check).
- Nonce + E2EE signing key bound in REPORTDATA; debug bit clear.
- Compose manifest byte-for-byte (images, env literals, mounted configs, the
  pre-launch script, log driver sizes, `RUST_LOG`).
- OS image hash, app-id, instance-id, KMS root key (`mr-kms`, `key-provider`
  events in RTMR3).
- Workload keyset served with the attestation is the one KMS-custodied under
  that measured KMS root (custody chains present; see blind spot B7).

### 2.4 What can be changed WITHOUT breaking the quote (the blind spots)

**B1. The routing table is runtime state.** `gateway-upstreams` seeds `[]`, and
real routes are installed via `PUT /v1/admin/upstreams` under a secret
`admin_token` (a dstack encrypted secret whose value is unmeasured), persisting on
the mutable `pal-state` volume. Whoever holds the admin token can point your
prompts at any upstream at any time, including `OpenAiCompatible` and `Anthropic`
routes that are explicitly not TEEs (`src/aggregator/upstream_config/builders.rs:71`:
"Plain OpenAI-compatible cloud APIs have no provider attestation"). The quote
cannot see this.

**B2. Upstream verification is not enforced on Venice's route.** The gateway
supports fail-closed operation (`provider.aci_verified: true`,
`src/http/app/handlers.rs:589`), but Venice's public API rejects the field
(live: `400 Unrecognized key(s) in object: 'provider'`). Enforced attested serving
applies only to `tee_only_domains = ["tee.redpill.ai", "inference.phala.com"]`,
while Venice's traffic arrives on `api.redpill.ai` (live
`downstream_tls_binding.domain`), which is excluded. Hence every receipt says
`required: false`, and a failed upstream check would be recorded rather than
blocking.

**B3. An external control plane steers each request.** The measured config
contains `middleware.control_url` and `control_token`, whose values are secrets.
Per request the gateway POSTs `/consult/pre` with `{apiKeyHash, model, provider,
reasoning, tee}` and gets back an allow or deny decision, the ordered candidate
route list, and pricing (`src/middleware/control.rs:136`,
`src/middleware/types.rs`). It fails closed when the control plane is
unreachable, and it does not receive prompt content. It does, however, see every
request's model, timing, API-key hash and user id; it picks which of the
installed routes serves you; and it lives outside the TEE. After the request,
`/consult/post` reports usage, status, route and `error_message`. Upstream error
text can echo request fragments, which makes that a narrow plaintext-egress
channel from the enclave to Venice and Redpill infrastructure.

**B4. The build is not reproducible, and the cache is both persistent and
unmeasured.** At boot the launcher builds the gateway with `CARGO_HOME`,
`RUSTUP_HOME`, `CARGO_TARGET_DIR` and `UV_CACHE_DIR` all on the persistent
`pal-cache` volume (`entrypoint.sh:51-56` of the launcher), and prepends
`$CARGO_HOME/bin` to `PATH`. Consequences:
  - a planted `cargo` or `rustc` in that volume shadows the image toolchain;
  - cargo reuses `CARGO_TARGET_DIR` artifacts without integrity checks, so a
    poisoned incremental-build cache can change the linked binary while the
    source stays pinned;
  - crates are hash-pinned via Cargo.lock, with 528 checksums, which is good, but
    the compiler and the uv-managed Python interpreter for the verifier bridge
    are whatever the cache or image provides.

  The quote measures the instruction to build a commit, not the binary that runs.
  Anyone who can write the volume, and the dstack platform operator provisions and
  persists volumes, can subvert the next boot.

**B5. `dstack-verifier:latest` drift.** The component that verifies TDX quotes
for the NEAR-AI and phala-direct paths rides an unpinned tag, re-pulled at every
boot by the pre-launch script's `docker compose pull`, which is fail-soft. A
malicious or compromised registry tag swap changes the verifier without changing
any measurement. This is narrower than stated, though: the measured compose says
the ACI path uses "the gateway's vendored confidential_verifier package, so it
needs no separate pin", and `aci-service/v2` does DCAP in-process. The sidecar is
not in Venice's request path, so calling an unpinned verifier an unpinned trust
root does not apply to this route.

**B6. Root SSH into the enclave is configurable and invisible.** The measured
`pre_launch_script` (Phala Cloud v0.0.15) writes `$DSTACK_ROOT_PUBLIC_KEY`,
`$DSTACK_AUTHORIZED_KEYS` and user-config keys into root's `authorized_keys`, and
sets a root password. `DSTACK_ROOT_PUBLIC_KEY` is in `allowed_envs`. Whether a
key is actually injected is an encrypted secret, and attestation cannot tell you
which. If one is set, the key holder has root inside the "trusted" enclave, with
full access to plaintext prompts, the admin token and upstreams.json. The same
script runs `docker compose pull` (see B5) and `docker image/volume prune`.

**B7. ~~Keyset to quote binding is TOFU, not proven.~~ Wrong; see §0.** The
legacy quote Venice serves binds the E2EE key address and your nonce rather than
the `workload_keyset_digest`, and that much is right. But the enclave's native
ACI report puts `sha256(JCS({purpose, workload_id, workload_keyset_digest,
nonce}))` in REPORTDATA, so a DCAP-verified quote commits to the digest directly.
Verified live and now implemented (§4). The `keyset_endorsement` format is
documented in the gateway source and verifies. The custody `signature_chain`
verifies too, though it terminates at an out-of-band KMS root rather than at
anything measured, so it adds nothing beyond the `report_data` binding.

**B8. `secure_time: false`.** The manifest disables trusted time, so the guest
clock is host-supplied. Certificate validity, keyset epochs, receipt timestamps
and attestation freshness inside the CVM are only as honest as the host.

**B9. `public_logs: true`, `public_sysinfo: true` and `public_tcbinfo: true`** on
both CVM-1 and CVM-2. dstack can expose container logs through the platform
gateway. I could not reach the app-id subdomain from outside today
(`fdb7a14e….dstack-pha-prod7.phala.network` completes TLS then drops), so the
exposure is not currently internet-reachable. The capability is switched on in
the measured config regardless, and the platform operator can always read the
json-file logs on the persistent volume.

**B10. The GPU hop.** On CVM-1, `num_gpus: 0`. NVIDIA attestation, which the
proxy checks against NRAS and binds to its nonce, proves a genuine Hopper chip in
CC mode with good firmware, and says nothing about software or weights. At the
GPU node (hop 3), the router's phala-direct verifier treats NVIDIA evidence as
"supplemental, never a gate" and states plainly that it "does not prove that GPU
is bound to this CPU TEE or serving this request"
(`scripts/provider_verifier/phala_direct.py:197-202`).
`serving_software_known_good` and `model_weights_provenance` stay `unknown` at
every hop.

### 2.5 Logging / prompt egress inventory (your priority question)

Where plaintext or prompt-adjacent content can go, hop by hop:

| Where | Content | Verdict |
|---|---|---|
| Gateway `request_outcome` log lines | Structured, content-free fields by default. With `request_outcome=debug` the raw upstream error detail, up to 240 chars, is logged (`src/middleware/completion.rs:153-180`). The measured compose sets exactly `RUST_LOG=info,request_outcome=debug`, and its own comment admits "upstream error bodies may echo request fragments into these operator-visible logs". | Real, measured in, and acknowledged. 500 MB × 10 rotated files is roughly a month of retention on a persistent volume. Only fires on failed requests (all failures except 429). |
| Container logs on disk / `public_logs` | The above, plus supervisord/build output. | Operator-visible; platform-exposable by config. |
| `/consult/post` to control plane | `error_message` (can contain upstream error text echoing request fragments), usage, model, route, timings, user id. | **Egress outside the TEE per request** (best-effort). Narrow but real. |
| Receipts | Hashes only, no content (`src/aggregator/service/receipt_store.rs:7`). | Safe; auditable. |
| `sessions.jsonl` | Attested upstream-session records (ids, bindings, claims), no prompts. | Safe. |
| Prometheus `/v1/metrics` | Counters only. | Safe. |
| Inference hosts (CVM-2 router, GPU nodes) | The full plaintext prompt. Their serving software is unmeasured (`serving_software_known_good: unknown`), and nothing cryptographic prevents them logging or exfiltrating it. | The main residual exposure of the whole scheme. |
| api.venice.ai itself | Sees ciphertext on E2EE path; sees plaintext on `tee-` and passthrough paths (by design). Also re-wraps/re-serializes everything (receipt body-binding fails from client vantage). | By design; documented. |
| This proxy | Logs metadata at info; error bodies at error (P2); optional plaintext dump, off by default, loud warning. | Under your control. |

On sending prompts somewhere else, three mechanisms exist. The runtime upstream
table (B1), where whoever holds `admin_token` can add an arbitrary plaintext
route and the attestation would still pass. Control-plane candidate selection
among installed routes (B3). And whatever the unmeasured inference-host software
does, which is the biggest unknown. There is no telemetry or hidden third
destination in the pinned gateway source: it forwards to the selected upstream
and nowhere else. I grepped the source for external calls and found the control
plane, verifiers, upstreams and the dstack socket, and nothing further.

---

## 3. What I would change

### In this repo (small, high-value)

0. Done, in §4: anchor receipts on the ACI quote instead of pinning on first
   use, verify the top-level signature, and stop reporting the gateway's upstream
   verdict before the receipt carrying it has been verified (P7, P8).
1. Log redaction: stop writing Venice's raw error bodies to the proxy log
   (P2); log status + truncated, content-free detail.
2. Add an optional local bearer token for the proxy endpoints (cheap insurance
   if anyone ever binds it beyond loopback).
3. Surface `keyset_epoch.not_after` and attestation `stale_after` in logs;
   clamp `SESSION_TTL` to the freshness window (P5/P6).
4. Consider failing, or at least error-logging per request rather than once,
   when a receipt says `required: false` and `result != verified`. You already do
   the latter; the former is the systemic condition worth keeping visible.
5. README: add the third hop (GPU nodes aus1/aus2, bearer-gated, unverifiable
   from outside) to the "chain, hop by hop" table, which currently stops at the
   router. Also worth naming: `DSTACK_ROOT_PUBLIC_KEY` in `allowed_envs` (B6),
   `secure_time: false` (B8), `public_logs: true` (B9), and the persistent build
   cache (B4). The README's "what is actually attested" section is excellent but
   stops one layer short of these.

### Report upstream

**To venice-e2ee (elkimek/venice-e2ee).** The library is in good shape, so these
are suggestions rather than bugs.
- ~~Try to crack `key_custody.signature_chain` verification…~~ **Done, and by a
  shorter route than proposed.** The custody chain does verify, but it recovers
  an out-of-band KMS root rather than the measured `key-provider` key, so it
  would not have closed B7. The ACI `report_data` binding does, directly.
  Implemented as `verifyAciAttestation()`; see §4.
- Clamp session TTL to the attestation freshness window; expose
  `keyset_epoch.not_after`. (The anchor cache already clamps to `stale_after`;
  the session TTL does not.)
- Document that HKDF info `ecdsa_encryption` is a Venice legacy string so
  future integrators don't copy it as a pattern.

**To Venice AI:**
- Accept `provider.aci_verified` and `aci_session_ids` on
  `/api/v1/chat/completions` instead of returning 400. The gateway already
  implements fail-closed enforcement, and clients currently cannot opt in. Of
  everything on this list, it would change the most for the least work.
- Enforce upstream verification on your own E2EE routes (`required: true`),
  and put `api.redpill.ai` in `tee_only_domains`. Today the domain your traffic
  actually uses is the one excluded from enforced attested serving.
- Stop re-serializing between clients and the ACI gateway (or publish the
  canonical byte format) so receipt `request_body_hash`/`response_body_hash`
  become verifiable end-to-end; today 2 of the 16 receipt checks can never
  pass from the public vantage point.
- ~~Document (or drop) the top-level secp256k1 `signature` and
  `keyset_endorsement` message formats; both are currently unverifiable.~~
  Withdrawn, because both are verifiable. The signature is EIP-191 `personal_sign`
  over `"<request_hash>:<response_hash>"` by the quote-bound key; the endorsement
  is ECDSA over `sha256(JCS({purpose, workload_keyset_digest}))` under the
  identity key. Publishing them in the API docs rather than only in gateway
  source would still help; they are not unverifiable, only undiscoverable.
- Ask Phala to drop `request_outcome=debug` from the measured compose. The
  compose's own comment says the fallback is "content-free failure logging",
  which is the right setting for a service whose product is not reading prompts.

**To Phala (dstack / inference provider):**
- Pin `dstack-verifier` by digest everywhere. It is a trust root on the NEAR-AI
  path, though not on the ACI path Venice uses, where the gateway verifies quotes
  in-process, so this is smaller than first stated but still free to fix.
- Fix the build-provenance gap (B4): ship a pinned, digest-measured gateway
  image (the repo's own `deploy/README.md` calls this the production path), or
  at minimum stop reusing an unmeasured persistent cargo/rustup cache and pin
  the toolchain; as-is, the quote measures a recipe, not a binary.
- ~~Sign `/v1/aci/sessions`.~~ Withdrawn. Session ids are content-addressed
  over the verified material including `evidence_digest`, and the id is carried
  in a signed receipt, so the store is already tamper-evident without a
  signature; 346 of 346 records recomputed correctly. What is worth asking for
  instead: **serve the evidence behind `evidence_digest`**, so a relying party
  can re-derive what the gateway verified rather than only confirming it
  committed to something. The GPU nodes' own attestation is still bearer-gated,
  so hop three remains uncheckable from outside.
- GPU↔CPU binding: nothing ties the NVIDIA-attested GPU to the TDX-attested
  CVM serving the request (shared nonce at best). Compound evidence (GPU
  nonce committed in the CVM's report_data, or similar) would close the
  `gpu_attested: unknown` at the gateway hop.
- Publish the dstack OS image build so `os_image_hash` can be inspected; the
  fleet runs dev images with SSH/serial console enabled, which is worth saying
  out loud in the attestation claims.
- Reconsider `secure_time: false`, `public_logs: true`, and
  `DSTACK_ROOT_PUBLIC_KEY` in `allowed_envs` for workloads marketed as
  confidential inference; at minimum, reflect in the attestation evidence
  whether an SSH key was actually injected, so relying parties aren't blind to
  remote-access configuration.

### Bottom line

The proxy and library do their job well and fail closed; the cryptography
between you and the first enclave is sound and genuinely verified. What
attestation then proves is narrow: a specific gateway *configuration* in a
genuine TDX VM, whose routing table, admin credentials, SSH accessibility,
build cache and OS provenance are runtime state the quote does not cover;
whose measured logging setting can leak request fragments on errors; whose
upstream check is advisory on the route Venice actually uses; and which hands
your plaintext prompt to a second attested router and then to GPU hosts whose
software and weights nobody has attested. Treat "E2EE" here as "Venice's network
and infrastructure cannot read my prompt; Phala-operated enclaves can, under a
configuration I can verify but not fully trust". If you want the gap to shrink,
push the upstream items, especially `provider.aci_verified` passthrough and
enforced verification on Venice's own domain.

**Amended after the verification pass.** The above stands, with one correction
that changes the shape of the conclusion rather than its severity, and with the
"second attested router" no longer taken on faith: its quote is verified from
here (§4). This audit
judged the client-side chain to bottom out in trust-on-first-use and in formats
nobody had reconstructed, and recommended asking three parties to fix it. That
was wrong: the binding already existed, in a published protocol, on a public
endpoint, implemented in the source this audit read. The chain from Intel's roots
through the quote to the keyset, the receipt, and the gateway's verdict on the
machine it forwarded to is cryptographic end to end and now verified in code
(§4).

What remains genuinely unproven is smaller and sharper than "the anchor is
pinned". It is: `required: false` on Venice's route, so the upstream check is
recorded rather than enforced; the unpublished nonce behind the upstream report,
which leaves that hop's freshness resting on the attested gateway; body hashes
that cannot be reproduced through Venice's re-serialising hop; and the unmeasured
build, unmeasured secrets and unattested serving software of §2.4. Those are the
things to push on.

---

## 4. What was changed, 2026-08-06

Implemented in `venice-e2ee` (branch `feat/aci-quote-bound-anchor`, offered
upstream) and in this proxy (`f259342`):

- `verifyAciAttestation()` and `establishAciTrustAnchor()` fetch the native ACI
  report with a fresh nonce, DCAP-verify the quote, recompute the `report_data`
  statement, recompute the keyset digest and workload id, and check the
  endorsement signature, the freshness window, the debug bit and the unused
  REPORTDATA tail. The anchor is returned only when all of it passes. DCAP is
  required by default, since an anchor from an unverified quote is no better than
  a pinned one.
- The proxy anchors receipts on that value (`aci_attestation_url`, default
  `https://tee.redpill.ai`), cached until the report's freshness window ends. If
  the proof cannot be obtained, receipts are reported unverifiable rather than
  falling back to pinning, so an attacker who can block one endpoint cannot talk
  the anchor down. Pinning still covers workloads that endpoint does not attest,
  and a configured anchor still outranks both.
- `verifyReceipt()` verifies the top-level signature, adding
  `signed_text_matches_receipt_hashes` and `signature_recovers_to_attested_key`.
  The signed text is recomputed from the receipt's own events, so a valid
  signature over some other pair of hashes fails.
- P7 and P8 are fixed, as described above.

Verified live end to end on both paths, `e2ee-glm-5-2-p` and
`tee-e2ee-glm-5-2-p`, through the running proxy: anchor proven from the quote
(TCB `UpToDate`, gateway source `aa65d64c`), receipt authentic against it, and
the upstream verdict reported only after authentication. The proven digest equals
the pin this repo recorded on 2026-08-04, which is corroboration TOFU could never
give itself. A deliberately unreachable endpoint produced the refusal rather than
a silent downgrade, and wrote no pin.

### Verifying the second hop (`20fbd08`, library `7bb004c`)

- `verifyAttestedSession()`, `fetchAttestedSession()` and
  `computeAttestedSessionId()` recompute the content-addressed session id, check
  the evidence digest, and verify the upstream's own report (DCAP against Intel's
  roots, digest and workload-id recomputation, endorsement, debug bit), folding
  its checks in under an `upstream.` prefix.
- `channel_binding_in_attested_keyset` is the check the others depend on: the TLS
  SPKI the gateway bound must appear in the upstream's attested keyset for the
  host dialled. Without it, a genuine report describing another machine passes.
- `verifyRelayedAciAttestation()` and `nonceBound` keep the freshness gap visible.
  The check is skipped rather than faked, no anchor is derived from a relayed
  report, and the proxy prints the limitation on every line.
- The proxy runs this only after the receipt carrying the session id verifies,
  for the same reason the upstream verdict is now reported late.

Live on both paths:

```
Upstream session as_e8677297… verified here for e2ee-glm-5-2-p: the second hop's
own quote checks out (TCB UpToDate, source 70513c1cc22c2259dc95c598d8b43b9d20aecbbf)
and the channel the gateway bound is a TLS key it attested.
```

Still open from §3: P2 (error-body logging) and P5/P6 (TTL clamping and
`keyset_epoch` surfacing). Three more cannot be fixed from the client at all:
the unpublished nonce behind the upstream report, `required: false` on Venice's
route, and the unmeasured build and serving software of §2.4.

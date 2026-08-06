import {
  BODY_BINDING_CHECKS,
  createVeniceE2EE,
  establishAciTrustAnchor,
  fetchAttestedSession,
  isE2EEModel,
  verifyAttestedSession,
  verifyReceipt,
} from 'venice-e2ee';
import type {
  E2EESession,
  VeniceE2EEOptions,
  ReceiptVerification,
  ReceiptResponseHashField,
} from 'venice-e2ee';
import type { ProxyConfig } from './config.js';
import {
  AnchorStore,
  readObservedAnchor,
  type AnchorSource,
  type TrustAnchor,
} from './receipt-anchors.js';
import { logger } from './logger.js';

/**
 * What came of a receipt check.
 *
 * `unavailable` and `anchor-conflict` are kept apart from a failed verification
 * because they mean different things and deserve different noise levels: the
 * first is a gateway that predates receipts, the second is the alarm this whole
 * mechanism exists to raise.
 */
export type ReceiptOutcome =
  | {
      status: 'checked';
      anchorSource: AnchorSource;
      result: ReceiptVerification;
      /** False when the only failures are the two body-hash checks. */
      bodyBindingOk: boolean;
      /** What the gateway recorded about the node it forwarded to, if anything. */
      upstream: UpstreamVerification | null;
    }
  | { status: 'unavailable'; reason: string }
  | { status: 'anchor-conflict'; reason: string }
  /**
   * Quote-bound anchoring was asked for and could not be completed. Reported
   * rather than quietly falling back to pinning: silently downgrading the trust
   * anchor when the proof is unavailable is exactly what an attacker who can
   * block one endpoint would want.
   */
  | { status: 'anchor-unproven'; reason: string };

/**
 * The gateway's own record of checking the machine it forwarded your prompt to.
 *
 * The receipt's fourteen checks say nothing about this: they establish that the
 * attested enclave signed a receipt for your completion, not what that enclave
 * found when it looked at its upstream. The verdict is in the signed event log
 * either way, so a failure is already recorded. It just was not being read.
 */
export interface UpstreamVerification {
  /** `verified` when the gateway checked the node's quote and bound the channel. */
  result: string;
  /** False means the check ran but was not allowed to block the request. */
  required: boolean;
  origin?: string;
  verifierId?: string;
  reason?: string;
  /**
   * The attested session backing this verdict. Content-addressed over the
   * evidence the gateway verified, so it can be fetched and rechecked rather
   * than believed.
   */
  sessionId?: string;
  /** Claims the gateway could not establish, such as `gpu_attested`. */
  unknownClaims: string[];
}

/**
 * What came of rechecking the gateway's verdict against the session behind it.
 *
 * `verified` means this proxy verified the upstream's own TDX quote — not that
 * the gateway said it did. `nonceBound` stays false regardless: the nonce behind
 * the upstream report is not published, so a captured report cannot be told from
 * a current one, and pretending otherwise would overstate what was checked.
 */
export interface UpstreamSessionOutcome {
  status: 'verified' | 'failed' | 'unavailable';
  reason?: string;
  failures: string[];
  nonceBound: boolean;
  upstreamTcb?: string;
  upstreamCommit?: string;
  unknownClaims: string[];
}

/** Pull the `upstream.verified` event out of a signed receipt's event log. */
export function readUpstreamVerification(signature: unknown): UpstreamVerification | null {
  const log = (signature as { receipt?: { event_log?: unknown } } | null)?.receipt?.event_log;
  if (!Array.isArray(log)) return null;

  const event = log.find(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && (entry as { type?: unknown }).type === 'upstream.verified'
  );
  if (!event) return null;

  const claims = (event.claims ?? {}) as Record<string, { status?: unknown } | null>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

  return {
    result: str(event.result) ?? 'unknown',
    required: event.required === true,
    origin: str(event.url_origin),
    verifierId: str(event.verifier_id),
    reason: str(event.reason),
    sessionId: str(event.session_id),
    unknownClaims: Object.entries(claims)
      .filter(([, value]) => value?.status === 'unknown')
      .map(([name]) => name),
  };
}

/**
 * Client-facing prefix that selects TEE-only mode.
 *
 * Venice exposes one model ID for both modes — the request flow decides whether
 * the model runs TEE-only or end-to-end encrypted. The proxy needs that choice
 * up front, and an OpenAI-compatible request carries nothing but the model name,
 * so the mode is encoded there: `tee-e2ee-glm-5-2-p` is `e2ee-glm-5-2-p` run
 * TEE-only. The prefix is stripped before the request reaches Venice.
 */
export const TEE_ONLY_PREFIX = 'tee-';

export function isTeeOnlyModel(modelId: string): boolean {
  return modelId.startsWith(TEE_ONLY_PREFIX);
}

/** `tee-e2ee-glm-5-2-p` -> `e2ee-glm-5-2-p`. Other IDs pass through unchanged. */
export function stripTeePrefix(modelId: string): string {
  return isTeeOnlyModel(modelId) ? modelId.slice(TEE_ONLY_PREFIX.length) : modelId;
}

/**
 * An anchor established from the gateway's quote, or the reason it could not be.
 *
 * `anchor: null` with no `reason` means quote-bound anchoring was never asked
 * for; with a `reason` it means it was asked for and failed, which is not the
 * same thing and must not be treated as one.
 */
interface ProvenAnchor {
  anchor: TrustAnchor | null;
  reason?: string;
  /** Unix seconds after which the report that produced this anchor goes stale. */
  staleAfter?: number | null;
}

/**
 * Manages E2EE sessions across multiple models.
 * Each model gets its own createVeniceE2EE instance, which internally
 * caches a single session with TTL and deduplicates concurrent creation.
 *
 * Thread-safety for parallel requests:
 * - Session creation is deduplicated per model by the library
 * - Encryption is stateless (fresh IVs per call)
 * - Decryption is stateless (per-chunk ephemeral keys from server)
 * - So multiple requests sharing a session is safe
 */
export class SessionManager {
  private instances = new Map<string, ReturnType<typeof createVeniceE2EE>>();
  private config: ProxyConfig;
  private dcapVerifier?: VeniceE2EEOptions['dcapVerifier'];
  private gpuVerifier?: VeniceE2EEOptions['gpuVerifier'];
  private anchors: AnchorStore;
  /** Cached outcome of proving an anchor from the gateway's own quote. */
  private provenAnchor: (ProvenAnchor & { expiresAt: number }) | null = null;
  private provenAnchorPending: Promise<ProvenAnchor> | null = null;
  /** Verified upstream sessions, keyed by the content-addressed session id. */
  private upstreamSessions = new Map<string, { outcome: UpstreamSessionOutcome; expiresAt: number }>();

  constructor(config: ProxyConfig) {
    this.config = config;
    this.anchors = new AnchorStore(config.receipt_anchor_store, config.receipt_anchors ?? {});
  }

  /**
   * Lazily initialize DCAP verifier if enabled.
   */
  private async getDcapVerifier(): Promise<VeniceE2EEOptions['dcapVerifier']> {
    if (!this.config.enable_dcap) return undefined;
    if (this.dcapVerifier) return this.dcapVerifier;

    try {
      const { createDcapVerifier } = await import('venice-e2ee/dcap');
      this.dcapVerifier = createDcapVerifier(this.config.dcap_pccs_url);
      logger.info(
        `DCAP verifier initialized (collateral: ${this.config.dcap_pccs_url ?? 'Phala PCCS default'})`
      );
      return this.dcapVerifier;
    } catch (e) {
      logger.warn('Failed to initialize DCAP verifier. Install @phala/dcap-qvl for full DCAP support.', e);
      return undefined;
    }
  }

  /**
   * Lazily initialize the GPU verifier if enabled.
   *
   * Unlike DCAP, a failure to construct this one is fatal rather than a warning:
   * the setting exists to fail closed, so silently continuing without it would
   * turn a hard guarantee into a log line nobody reads.
   */
  private async getGpuVerifier(): Promise<VeniceE2EEOptions['gpuVerifier']> {
    if (!this.config.verify_gpu_attestation) return undefined;
    if (this.gpuVerifier) return this.gpuVerifier;

    const { createNvidiaVerifier, createNrasTokenVerifier } = await import('venice-e2ee/nvidia');

    const tokenVerifier = this.config.verify_gpu_token_signatures
      ? createNrasTokenVerifier({
          jwksUrl: this.config.nras_jwks_url,
          pinnedLeafCertSha256: this.config.gpu_pinned_certs,
        })
      : undefined;

    this.gpuVerifier = createNvidiaVerifier({ nrasUrl: this.config.nras_url, tokenVerifier });

    logger.info(
      `GPU attestation enabled (verifier: ${this.config.nras_url ?? 'NVIDIA NRAS'}) — ` +
      `sessions fail closed without a passing, nonce-bound NVIDIA verdict`
    );
    if (tokenVerifier) {
      const pins = this.config.gpu_pinned_certs.length;
      logger.info(
        `GPU token signatures verified against NVIDIA's key set` +
        (pins ? ` (${pins} pinned certificate${pins === 1 ? '' : 's'})` : '')
      );
    } else {
      logger.warn(
        'GPU token signatures are NOT verified — NVIDIA\'s verdict rests on TLS to NRAS alone. ' +
        'Set verify_gpu_token_signatures: true to check them.'
      );
    }
    return this.gpuVerifier;
  }

  /**
   * Get or create an E2EE instance for a specific model.
   * Each instance caches one session internally.
   */
  private getOrCreateInstance(modelId: string): ReturnType<typeof createVeniceE2EE> {
    let instance = this.instances.get(modelId);
    if (!instance) {
      instance = createVeniceE2EE({
        apiKey: this.config.venice_api_key,
        baseUrl: this.config.venice_base_url,
        sessionTTL: this.config.session_ttl,
        verifyAttestation: this.config.verify_attestation,
        dcapVerifier: this.dcapVerifier,
        gpuVerifier: this.gpuVerifier,
        requireGpu: this.config.verify_gpu_attestation,
      });
      this.instances.set(modelId, instance);
      logger.debug(`Created E2EE instance for model: ${modelId}`);
    }
    return instance;
  }

  /**
   * Get an active E2EE session for a model.
   * Creates a new session if needed (with attestation verification).
   * Concurrent calls for the same model are deduplicated by the library.
   */
  async getSession(modelId: string): Promise<{
    session: E2EESession;
    instance: ReturnType<typeof createVeniceE2EE>;
  }> {
    // Ensure verifiers are loaded before creating instances — an instance built
    // without them would cache a session that skipped the checks.
    if (this.config.enable_dcap && !this.dcapVerifier) {
      await this.getDcapVerifier();
    }
    if (this.config.verify_gpu_attestation && !this.gpuVerifier) {
      await this.getGpuVerifier();
    }

    const instance = this.getOrCreateInstance(modelId);
    const session = await instance.createSession(modelId);
    return { session, instance };
  }

  /**
   * Invalidate a session for a specific model (e.g., on stale session error).
   * The next getSession call will create a fresh session.
   */
  invalidateSession(modelId: string): void {
    const instance = this.instances.get(modelId);
    if (instance) {
      instance.clearSession();
      this.instances.delete(modelId);
      logger.info(`Invalidated session for model: ${modelId}`);
    }
  }

  /**
   * Check if a model ID is an E2EE model.
   */
  isE2EE(modelId: string): boolean {
    return isE2EEModel(modelId);
  }

  /**
   * Check if a model ID requests TEE-only mode (`tee-` prefix).
   */
  isTeeOnly(modelId: string): boolean {
    return isTeeOnlyModel(modelId);
  }

  /**
   * Verify a model's TEE attestation without using the encrypted channel.
   *
   * Attestation is the same handshake the E2EE path performs, so this reuses the
   * cached session rather than re-attesting per request. That session also holds
   * an ephemeral keypair and AES key which TEE-only never uses — a few
   * microseconds of ECDH per TTL window, in exchange for one attestation cache
   * shared by both modes.
   *
   * Returns `verified: false` when attestation checking is switched off in the
   * config; throws when verification is on and fails.
   */
  async getAttestation(modelId: string): Promise<{ verified: boolean }> {
    const { session } = await this.getSession(modelId);
    return { verified: session.attestation !== undefined };
  }

  /** How long a failed anchor proof is remembered, so receipts cannot become a retry storm. */
  private static readonly ANCHOR_FAILURE_TTL_MS = 60_000;

  /**
   * Establish the receipt trust anchor from the gateway's own attestation quote.
   *
   * The gateway's native ACI report puts `sha256(JCS({purpose, workload_id,
   * workload_keyset_digest, nonce}))` in REPORTDATA, so a DCAP-verified quote
   * commits to the keyset digest. That is the whole difference between an anchor
   * that is proven and one that has merely been seen before.
   *
   * Cached, because it costs a 50 kB fetch and a full DCAP verification, and the
   * answer is a property of the enclave rather than of the request. The cache
   * never outlives the report's own freshness window.
   *
   * Returns `{ anchor: null, reason }` rather than throwing: an unprovable
   * anchor stops receipt verification, and must never quietly become a pin.
   */
  private async getProvenAnchor(): Promise<ProvenAnchor> {
    const url = this.config.aci_attestation_url?.trim();
    if (!url) return { anchor: null };

    const cached = this.provenAnchor;
    if (cached && Date.now() < cached.expiresAt) {
      return { anchor: cached.anchor, reason: cached.reason };
    }
    if (this.provenAnchorPending) return this.provenAnchorPending;

    this.provenAnchorPending = this.proveAnchor(url)
      .catch((err: unknown): ProvenAnchor => ({
        anchor: null,
        reason: `could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`,
      }))
      .then((outcome) => {
        const staleAt = outcome.staleAfter ? outcome.staleAfter * 1000 : Number.POSITIVE_INFINITY;
        this.provenAnchor = {
          anchor: outcome.anchor,
          reason: outcome.reason,
          expiresAt: outcome.anchor
            ? Math.min(Date.now() + this.config.session_ttl, staleAt)
            : Date.now() + SessionManager.ANCHOR_FAILURE_TTL_MS,
        };
        return outcome;
      })
      .finally(() => {
        this.provenAnchorPending = null;
      });

    return this.provenAnchorPending;
  }

  /**
   * Recheck the gateway's verdict on its upstream against the evidence behind it.
   *
   * The receipt's `upstream.verified` event names an attested session whose id is
   * content-addressed over the material the gateway verified — the channel
   * binding, the claims, and a digest of the upstream's own attestation report.
   * Fetching that session by id yields the report inline, so the second hop's
   * quote is verified here rather than taken on the gateway's word.
   *
   * Called only after the receipt carrying the session id has been
   * authenticated. An unverified receipt's event log is attacker-supplied text,
   * and chasing network references out of it would be reading it as evidence.
   *
   * Cached per session id: one attested channel serves many completions, and
   * re-running DCAP for each of them would buy nothing.
   */
  async verifyUpstreamSession(upstream: UpstreamVerification): Promise<UpstreamSessionOutcome> {
    const url = this.config.aci_attestation_url?.trim();
    const sessionId = upstream.sessionId;
    if (!url || !sessionId) {
      return {
        status: 'unavailable',
        reason: sessionId ? 'no ACI endpoint configured' : 'receipt named no attested session',
        failures: [],
        nonceBound: false,
        unknownClaims: upstream.unknownClaims,
      };
    }

    const cached = this.upstreamSessions.get(sessionId);
    if (cached && Date.now() < cached.expiresAt) return cached.outcome;

    const outcome = await this.checkUpstreamSession(url, sessionId, upstream);
    this.upstreamSessions.set(sessionId, {
      outcome,
      expiresAt:
        Date.now() +
        (outcome.status === 'verified'
          ? this.config.session_ttl
          : SessionManager.ANCHOR_FAILURE_TTL_MS),
    });
    return outcome;
  }

  private async checkUpstreamSession(
    url: string,
    sessionId: string,
    upstream: UpstreamVerification
  ): Promise<UpstreamSessionOutcome> {
    const base: Pick<UpstreamSessionOutcome, 'failures' | 'nonceBound' | 'unknownClaims'> = {
      failures: [],
      nonceBound: false,
      unknownClaims: upstream.unknownClaims,
    };

    const dcapVerifier = await this.getDcapVerifier();
    if (!dcapVerifier) {
      return {
        ...base,
        status: 'unavailable',
        reason: 'DCAP is switched off, so the upstream quote cannot be checked here',
      };
    }

    let session;
    try {
      session = await fetchAttestedSession(url, sessionId);
    } catch (err: unknown) {
      // Sessions are retained only as long as the receipts citing them, so a
      // miss on an old completion is expiry rather than missing evidence.
      return {
        ...base,
        status: 'unavailable',
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    const result = await verifyAttestedSession(session, {
      expectedSessionId: sessionId,
      expectedOrigin: upstream.origin,
      dcapVerifier,
    });

    return {
      status: result.verified ? 'verified' : 'failed',
      failures: result.checks
        .filter((check) => !check.ok)
        .map((check) => `${check.name}${check.detail ? ` — ${check.detail}` : ''}`),
      nonceBound: result.upstreamNonceBound,
      upstreamTcb: result.upstream?.dcap?.status,
      upstreamCommit: result.upstream?.sourceCommit ?? undefined,
      unknownClaims: result.unknownClaims.length ? result.unknownClaims : upstream.unknownClaims,
    };
  }

  /** One attempt at proving the anchor. Caching and failure policy live in the caller. */
  private async proveAnchor(url: string): Promise<ProvenAnchor> {
    const dcapVerifier = await this.getDcapVerifier();
    if (!dcapVerifier) {
      return {
        anchor: null,
        reason:
          'quote-bound anchoring needs DCAP verification, which is switched off or unavailable ' +
          '(set enable_dcap: true, or clear aci_attestation_url to pin instead)',
      };
    }

    const result = await establishAciTrustAnchor(url, { dcapVerifier });
    if (!result.anchor) {
      const failures = result.checks
        .filter((check) => !check.ok)
        .map((check) => `${check.name}${check.detail ? ` — ${check.detail}` : ''}`)
        .join('; ');
      return { anchor: null, reason: `attestation from ${url} did not verify: ${failures}` };
    }

    logger.info(
      `Receipt anchor proven from the attested quote at ${url}: ` +
        `${result.anchor.workloadKeysetDigest} (gateway source ${result.sourceCommit ?? 'unstated'}, ` +
        `TCB ${result.dcap?.status ?? 'unreported'})`
    );
    return { anchor: result.anchor, staleAfter: result.staleAfter };
  }

  /**
   * Fetch and verify the signed receipt for a completion.
   *
   * Attestation proves an enclave exists; the receipt proves this particular
   * completion came out of it — but only against a trust anchor, which is pinned
   * rather than proven. See {@link AnchorStore} for why that is the best
   * available today.
   *
   * Returns `unavailable` rather than throwing when the model's gateway predates
   * ACI: `e2ee-deepseek-v4-flash` attests fine and serves E2EE traffic, but its
   * attestation carries no `workload_id`, no keyset and no receipt to check.
   * That is a missing capability, not a failed verification, and reporting it as
   * a failure would be a false alarm on every request.
   */
  async verifyReceipt(
    modelId: string,
    requestId: string,
    bodies: { requestBody: string; responseBody: string; responseHashField: ReceiptResponseHashField }
  ): Promise<ReceiptOutcome> {
    const instance = this.getOrCreateInstance(modelId);
    const attestation = await instance.attest(modelId);

    const observed = readObservedAnchor(attestation);
    if (!observed) {
      return {
        status: 'unavailable',
        reason: 'attestation carries no ACI workload identity (pre-ACI gateway)',
      };
    }

    const proven = await this.getProvenAnchor();
    if (this.config.aci_attestation_url?.trim() && !proven.anchor) {
      return {
        status: 'anchor-unproven',
        reason: proven.reason ?? 'the gateway quote did not yield a trust anchor',
      };
    }

    const resolution = this.anchors.resolve(modelId, observed, proven.anchor);
    if (resolution.conflict) {
      return {
        status: 'anchor-conflict',
        reason:
          `pinned ${resolution.conflict.expected.workloadId} / ` +
          `${resolution.conflict.expected.workloadKeysetDigest}, ` +
          `attestation now says ${resolution.conflict.observed.workloadId} / ` +
          `${resolution.conflict.observed.workloadKeysetDigest}`,
      };
    }

    const signature = await instance.fetchResponseSignature(modelId, requestId);
    const result = await verifyReceipt(signature, attestation, {
      trustAnchor: resolution.anchor,
      requestId,
      requestBody: bodies.requestBody,
      responseBody: bodies.responseBody,
      responseHashField: bodies.responseHashField,
    });

    const failed = result.checks.filter((check) => !check.ok);
    // Measured against the live API, the body-binding checks never pass from
    // behind `api.venice.ai`: both fail identically on the E2EE and TEE-only
    // paths, streaming or not, which places a re-serializing hop between this
    // proxy and the ACI gateway that issues the receipt. A failure here means
    // "could not be reproduced from this vantage point", not "the bytes were
    // tampered with", and the two must not be conflated.
    return {
      status: 'checked',
      anchorSource: resolution.source,
      result,
      bodyBindingOk: !failed.some((check) => BODY_BINDING_CHECKS.includes(check.name)),
      upstream: readUpstreamVerification(signature),
    };
  }

  /**
   * Clean up all sessions. Zeroizes private keys.
   */
  destroy(): void {
    for (const [modelId, instance] of this.instances) {
      instance.clearSession();
      logger.debug(`Cleared session for model: ${modelId}`);
    }
    this.instances.clear();
  }
}

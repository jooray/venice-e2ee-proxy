import { createVeniceE2EE, isE2EEModel, verifyReceipt } from 'venice-e2ee';
import type {
  E2EESession,
  VeniceE2EEOptions,
  ReceiptVerification,
  ReceiptResponseHashField,
} from 'venice-e2ee';
import type { ProxyConfig } from './config.js';
import { AnchorStore, readObservedAnchor, type AnchorSource } from './receipt-anchors.js';
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
    }
  | { status: 'unavailable'; reason: string }
  | { status: 'anchor-conflict'; reason: string };

/**
 * The checks that bind a receipt to specific request and response bytes.
 *
 * Measured against the live API, these never pass from behind `api.venice.ai`:
 * both fail identically on the E2EE and TEE-only paths, streaming or not, which
 * places a re-serializing hop between this proxy and the ACI gateway that issues
 * the receipt. Venice demonstrably re-wraps responses — it adds `cost` and
 * `venice_parameters` — and the request hashes suggest the same on the way in.
 *
 * They are kept and reported rather than suppressed, but a failure here means
 * "could not be reproduced from this vantage point", not "the bytes were
 * tampered with", and the two must not be conflated.
 */
const BODY_BINDING_CHECKS = new Set(['request_body_hash_matches', 'response_body_hash_matches']);

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
  private anchors: AnchorStore;

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
      this.dcapVerifier = createDcapVerifier();
      logger.info('DCAP verifier initialized');
      return this.dcapVerifier;
    } catch (e) {
      logger.warn('Failed to initialize DCAP verifier. Install @phala/dcap-qvl for full DCAP support.', e);
      return undefined;
    }
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
    // Ensure DCAP verifier is loaded before creating instances
    if (this.config.enable_dcap && !this.dcapVerifier) {
      await this.getDcapVerifier();
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

    const resolution = this.anchors.resolve(modelId, observed);
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
    return {
      status: 'checked',
      anchorSource: resolution.source,
      result,
      bodyBindingOk: !failed.some((check) => BODY_BINDING_CHECKS.has(check.name)),
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

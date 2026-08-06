import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

/**
 * Trust anchors for receipt verification — proven where possible, pinned where not.
 *
 * `verifyReceipt` needs a workload identity and keyset digest it can trust, and
 * refuses to take them from the response being checked, since a provider serving
 * both sides just makes them agree.
 *
 * Venice's `/api/v1/tee/attestation` cannot supply them: its `report_data`
 * decodes as `[address(20) | zeros(12) | nonce(32)]`, which binds the E2EE key
 * and the nonce and says nothing about the keyset. That is why this used to pin
 * on first use, the way SSH pins a host key.
 *
 * It no longer has to. The same enclave answers the native ACI protocol, whose
 * quote covers `sha256(JCS({purpose, workload_id, workload_keyset_digest,
 * nonce}))` — so a DCAP-verified quote commits to the digest. When the caller
 * supplies an anchor established that way, it is used and reported as
 * `quote-bound`, and a stored pin that disagrees with it loses: a value proven
 * against Intel's roots outranks one that was merely seen first.
 *
 * Pinning remains for the models that proof cannot reach — a workload other than
 * the one the ACI endpoint attests, or an operator who switched the endpoint
 * off. The distinction stays in the result rather than being smoothed over: a
 * pin recorded on this very request is reported as `first-seen`, never as a
 * match, and a proven anchor is never reported as a pin.
 */

export const DEFAULT_ANCHOR_STORE = '.venice-receipt-anchors.json';

export interface TrustAnchor {
  workloadId: string;
  workloadKeysetDigest: string;
}

export type AnchorSource =
  /** Derived from a DCAP-verified quote that commits to this keyset digest. */
  | 'quote-bound'
  /** Operator supplied it in config — the only case with provenance outside Venice. */
  | 'config'
  /** Matched a previously recorded pin. */
  | 'pinned'
  /** Recorded just now. Nothing has been checked against it yet. */
  | 'first-seen';

export interface AnchorResolution {
  anchor: TrustAnchor;
  source: AnchorSource;
  /** Set when a stored pin disagrees with what the attestation just said. */
  conflict?: { expected: TrustAnchor; observed: TrustAnchor };
}

interface StoredAnchor extends TrustAnchor {
  first_seen_at: string;
}

/** An attestation that carries no ACI fields cannot be anchored at all. */
export function readObservedAnchor(attestation: unknown): TrustAnchor | null {
  const a = attestation as Record<string, unknown> | null | undefined;
  const workloadId = a?.workload_id;
  const workloadKeysetDigest = a?.workload_keyset_digest;
  if (typeof workloadId !== 'string' || !workloadId) return null;
  if (typeof workloadKeysetDigest !== 'string' || !workloadKeysetDigest) return null;
  return { workloadId, workloadKeysetDigest };
}

export class AnchorStore {
  private readonly file: string;
  private readonly pins: Record<string, TrustAnchor>;
  private cache: Record<string, StoredAnchor> | null = null;

  constructor(file: string | undefined, configuredPins: Record<string, TrustAnchor> = {}) {
    // Receipts are optional, so a config that predates this setting must not stop
    // the proxy from starting.
    this.file = path.resolve(file || DEFAULT_ANCHOR_STORE);
    this.pins = configuredPins ?? {};
  }

  /**
   * Resolve the anchor to verify `modelId` against, recording it when this is the
   * first time the model has been seen.
   *
   * A conflict is reported, never silently overwritten: the whole point of the
   * pin is that the second value is the suspicious one.
   */
  resolve(modelId: string, observed: TrustAnchor, proven?: TrustAnchor | null): AnchorResolution {
    const configured = this.pins[modelId];
    if (!configured && proven && proven.workloadId === observed.workloadId) {
      // Same workload, so the quote speaks to this model. A digest that differs
      // from the proven one is exactly the substitution the anchor exists to
      // catch, and here it can be called rather than guessed at.
      if (proven.workloadKeysetDigest !== observed.workloadKeysetDigest) {
        return { anchor: proven, source: 'quote-bound', conflict: { expected: proven, observed } };
      }
      this.recordProven(modelId, proven);
      return { anchor: proven, source: 'quote-bound' };
    }

    if (configured) {
      const agrees =
        configured.workloadId === observed.workloadId &&
        configured.workloadKeysetDigest === observed.workloadKeysetDigest;
      return agrees
        ? { anchor: configured, source: 'config' }
        : { anchor: configured, source: 'config', conflict: { expected: configured, observed } };
    }

    const store = this.load();
    const stored = store[modelId];

    if (!stored) {
      store[modelId] = { ...observed, first_seen_at: new Date().toISOString() };
      this.save(store);
      logger.info(
        `Pinned receipt anchor for ${modelId}: ${observed.workloadId} / ` +
          `${observed.workloadKeysetDigest} (first seen — recorded, not verified)`
      );
      return { anchor: observed, source: 'first-seen' };
    }

    const expected: TrustAnchor = {
      workloadId: stored.workloadId,
      workloadKeysetDigest: stored.workloadKeysetDigest,
    };
    const agrees =
      expected.workloadId === observed.workloadId &&
      expected.workloadKeysetDigest === observed.workloadKeysetDigest;

    return agrees
      ? { anchor: expected, source: 'pinned' }
      : { anchor: expected, source: 'pinned', conflict: { expected, observed } };
  }

  /**
   * Keep the store aligned with what the quote proved.
   *
   * A pin that disagrees is superseded rather than reported as a conflict: the
   * proven value is the better one by construction, so the stored disagreement
   * says the pin was stale (or was recorded before proof was available), not
   * that something is being substituted now. It is still worth saying out loud,
   * because a pin quietly changing is the event this file exists to surface.
   */
  private recordProven(modelId: string, proven: TrustAnchor): void {
    const store = this.load();
    const stored = store[modelId];
    if (
      stored &&
      stored.workloadId === proven.workloadId &&
      stored.workloadKeysetDigest === proven.workloadKeysetDigest
    ) {
      return;
    }

    if (stored) {
      logger.warn(
        `Replacing the recorded receipt anchor for ${modelId} with a quote-bound one: ` +
          `was ${stored.workloadId} / ${stored.workloadKeysetDigest}, ` +
          `the attested quote commits to ${proven.workloadId} / ${proven.workloadKeysetDigest}.`
      );
    }
    store[modelId] = { ...proven, first_seen_at: new Date().toISOString() };
    this.save(store);
  }

  private load(): Record<string, StoredAnchor> {
    if (this.cache) return this.cache;
    try {
      const raw = fs.readFileSync(this.file, 'utf-8');
      const parsed = JSON.parse(raw) as { anchors?: Record<string, StoredAnchor> };
      this.cache = parsed.anchors ?? {};
    } catch {
      // Missing or unreadable: start empty. A store that cannot be read is the
      // same situation as a first run, and failing the request over it would
      // make an audit feature able to break inference.
      this.cache = {};
    }
    return this.cache;
  }

  private save(anchors: Record<string, StoredAnchor>): void {
    this.cache = anchors;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, `${JSON.stringify({ anchors }, null, 2)}\n`);
    } catch (err: unknown) {
      logger.warn(
        `Could not persist receipt anchors to ${this.file}: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `Anchors will be re-pinned on the next start.`
      );
    }
  }
}

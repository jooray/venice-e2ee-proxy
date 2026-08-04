import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

/**
 * Trust-on-first-use store for receipt trust anchors.
 *
 * `verifyReceipt` needs a workload identity and keyset digest it can trust, and
 * refuses to take them from the response being checked — otherwise a provider
 * serving both sides just makes them agree.
 *
 * There is no cryptographic source for those values today. Venice's TDX quote
 * binds the signing address and the client nonce (`report_data` decodes as
 * `[address(20) | zeros(12) | nonce(32)]`) and says nothing about the ACI keyset
 * digest. The `keyset_endorsement` signature alongside it could close that gap,
 * but its message construction is undocumented and 112 candidate reconstructions
 * failed to recover the attested signer.
 *
 * So this pins instead of proving, the way SSH pins a host key. The first
 * attestation for a model is recorded; every later one has to match. That does
 * not establish the enclave was ever genuine — pin what Venice says and you have
 * pinned Venice's claim — but it does catch the digest changing underneath you,
 * which is what a substituted keyset or a silent downgrade looks like.
 *
 * The distinction is kept in the result rather than smoothed over: a pin
 * recorded on this very request is reported as `first-seen`, not as a match.
 */

export const DEFAULT_ANCHOR_STORE = '.venice-receipt-anchors.json';

export interface TrustAnchor {
  workloadId: string;
  workloadKeysetDigest: string;
}

export type AnchorSource =
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
  resolve(modelId: string, observed: TrustAnchor): AnchorResolution {
    const configured = this.pins[modelId];
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

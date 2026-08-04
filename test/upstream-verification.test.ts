import { describe, it, expect } from 'vitest';
import { readUpstreamVerification } from '../src/session-manager.js';

/** A receipt shaped like the ones Venice actually returns. */
function receipt(event: Record<string, unknown> | null) {
  return {
    receipt: {
      chat_id: 'abc',
      event_log: [
        { seq: 0, type: 'request.received', body_hash: 'sha256:…' },
        ...(event ? [{ seq: 5, type: 'upstream.verified', ...event }] : []),
        { seq: 8, type: 'response.returned', cleartext_hash: 'sha256:…' },
      ],
    },
  };
}

const VERIFIED = {
  upstream_name: 'private-ai-gateway-dev',
  url_origin: 'https://glm-5-2.aus1-router.phala.com',
  verifier_id: 'aci-service/v2',
  result: 'verified',
  required: false,
  reason: null,
  claims: {
    tee_attested: { status: 'asserted', source: 'verifier_derived' },
    gpu_attested: { status: 'unknown' },
    model_weights_provenance: { status: 'unknown' },
  },
};

describe('readUpstreamVerification', () => {
  it('reads the gateway verdict about the node it forwarded to', () => {
    const upstream = readUpstreamVerification(receipt(VERIFIED));
    expect(upstream).toEqual({
      result: 'verified',
      required: false,
      origin: 'https://glm-5-2.aus1-router.phala.com',
      verifierId: 'aci-service/v2',
      reason: undefined,
      unknownClaims: ['gpu_attested', 'model_weights_provenance'],
    });
  });

  it('reports a failed verification rather than dropping it', () => {
    const upstream = readUpstreamVerification(
      receipt({ ...VERIFIED, result: 'failed', reason: 'quote verification failed' })
    );
    expect(upstream?.result).toBe('failed');
    expect(upstream?.reason).toBe('quote verification failed');
  });

  it('distinguishes an enforced check from an unenforced one', () => {
    expect(readUpstreamVerification(receipt({ ...VERIFIED, required: true }))?.required).toBe(true);
    expect(readUpstreamVerification(receipt(VERIFIED))?.required).toBe(false);
  });

  it('treats a non-boolean required as not enforced', () => {
    // Anything but an explicit true has to read as unenforced, or a missing
    // field would be reported as a guarantee nobody made.
    expect(readUpstreamVerification(receipt({ ...VERIFIED, required: 'yes' }))?.required).toBe(false);
  });

  it('lists only the claims the gateway could not establish', () => {
    const upstream = readUpstreamVerification(
      receipt({ ...VERIFIED, claims: { tee_attested: { status: 'asserted' }, gpu_attested: { status: 'asserted' } } })
    );
    expect(upstream?.unknownClaims).toEqual([]);
  });

  it('returns null when the receipt records no upstream event', () => {
    expect(readUpstreamVerification(receipt(null))).toBeNull();
  });

  it('survives receipts that are missing or malformed', () => {
    expect(readUpstreamVerification(null)).toBeNull();
    expect(readUpstreamVerification({})).toBeNull();
    expect(readUpstreamVerification({ receipt: {} })).toBeNull();
    expect(readUpstreamVerification({ receipt: { event_log: 'nope' } })).toBeNull();
  });

  it('falls back to unknown rather than inventing a result', () => {
    const upstream = readUpstreamVerification(receipt({ url_origin: 'https://x.example' }));
    expect(upstream?.result).toBe('unknown');
    expect(upstream?.verifierId).toBeUndefined();
  });
});

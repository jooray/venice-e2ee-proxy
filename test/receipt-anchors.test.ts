import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AnchorStore, readObservedAnchor } from '../src/receipt-anchors.js';

const A = { workloadId: 'sha256:aaa', workloadKeysetDigest: 'sha256:111' };
const B = { workloadId: 'sha256:bbb', workloadKeysetDigest: 'sha256:222' };

let storeFile: string;

beforeEach(() => {
  storeFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'venice-anchors-')),
    'anchors.json'
  );
});

afterEach(() => {
  fs.rmSync(path.dirname(storeFile), { recursive: true, force: true });
});

describe('readObservedAnchor', () => {
  it('reads the ACI fields when present', () => {
    expect(
      readObservedAnchor({ workload_id: 'sha256:aaa', workload_keyset_digest: 'sha256:111' })
    ).toEqual(A);
  });

  it('returns null for a pre-ACI attestation', () => {
    // The shape e2ee-deepseek-v4-flash actually returns: attests fine, no ACI
    // fields at all. Must read as "no receipts here", not as a failed check.
    expect(
      readObservedAnchor({ verified: true, tee_provider: 'near-ai', signing_address: '0xabc' })
    ).toBeNull();
  });

  it('returns null rather than a partial anchor', () => {
    expect(readObservedAnchor({ workload_id: 'sha256:aaa' })).toBeNull();
    expect(readObservedAnchor({ workload_keyset_digest: 'sha256:111' })).toBeNull();
    expect(readObservedAnchor(null)).toBeNull();
  });
});

describe('AnchorStore', () => {
  it('records the first anchor it sees and says so', () => {
    const store = new AnchorStore(storeFile);
    const first = store.resolve('e2ee-glm-5-2-p', A);
    expect(first.source).toBe('first-seen');
    expect(first.anchor).toEqual(A);
    expect(first.conflict).toBeUndefined();
  });

  it('matches the pin on later requests', () => {
    new AnchorStore(storeFile).resolve('e2ee-glm-5-2-p', A);
    const later = new AnchorStore(storeFile).resolve('e2ee-glm-5-2-p', A);
    expect(later.source).toBe('pinned');
    expect(later.conflict).toBeUndefined();
  });

  it('reports a conflict when the workload changes, and keeps the pin', () => {
    new AnchorStore(storeFile).resolve('e2ee-glm-5-2-p', A);
    const changed = new AnchorStore(storeFile).resolve('e2ee-glm-5-2-p', B);
    expect(changed.conflict).toEqual({ expected: A, observed: B });
    // The pin is what was trusted; adopting the new value would defeat pinning.
    expect(changed.anchor).toEqual(A);
    expect(JSON.parse(fs.readFileSync(storeFile, 'utf-8')).anchors['e2ee-glm-5-2-p'].workloadId)
      .toBe(A.workloadId);
  });

  it('pins models separately even when they share a workload', () => {
    const store = new AnchorStore(storeFile);
    store.resolve('e2ee-glm-5-2-p', A);
    // Same gateway serves both today; a move is still detectable per model.
    expect(store.resolve('e2ee-qwen3-30b-a3b-p', A).source).toBe('first-seen');
    expect(store.resolve('e2ee-qwen3-30b-a3b-p', A).source).toBe('pinned');
  });

  it('prefers a configured anchor over anything recorded', () => {
    new AnchorStore(storeFile).resolve('e2ee-glm-5-2-p', A);
    const configured = new AnchorStore(storeFile, { 'e2ee-glm-5-2-p': B });
    const resolved = configured.resolve('e2ee-glm-5-2-p', B);
    expect(resolved.source).toBe('config');
    expect(resolved.anchor).toEqual(B);
  });

  it('flags a configured anchor that the attestation contradicts', () => {
    const configured = new AnchorStore(storeFile, { 'e2ee-glm-5-2-p': A });
    const resolved = configured.resolve('e2ee-glm-5-2-p', B);
    expect(resolved.source).toBe('config');
    expect(resolved.conflict).toEqual({ expected: A, observed: B });
  });

  it('uses a quote-bound anchor and reports it as proven, not pinned', () => {
    const store = new AnchorStore(storeFile);
    const resolved = store.resolve('e2ee-glm-5-2-p', A, A);
    expect(resolved.source).toBe('quote-bound');
    expect(resolved.anchor).toEqual(A);
    expect(resolved.conflict).toBeUndefined();
  });

  it('flags a keyset digest the quote did not commit to', () => {
    // Same workload, different keyset: the substitution pinning was invented to
    // catch, except here it can be proven rather than merely suspected.
    const store = new AnchorStore(storeFile);
    const observed = { workloadId: A.workloadId, workloadKeysetDigest: 'sha256:999' };
    const resolved = store.resolve('e2ee-glm-5-2-p', observed, A);
    expect(resolved.source).toBe('quote-bound');
    expect(resolved.anchor).toEqual(A);
    expect(resolved.conflict).toEqual({ expected: A, observed });
  });

  it('supersedes a stale pin with the proven value', () => {
    new AnchorStore(storeFile).resolve('e2ee-glm-5-2-p', B);
    const resolved = new AnchorStore(storeFile).resolve('e2ee-glm-5-2-p', A, A);
    expect(resolved.source).toBe('quote-bound');
    expect(JSON.parse(fs.readFileSync(storeFile, 'utf-8')).anchors['e2ee-glm-5-2-p'].workloadId)
      .toBe(A.workloadId);
  });

  it('falls back to pinning for a model the proven workload does not cover', () => {
    // The ACI endpoint attests one workload. A model served by another is not a
    // conflict — there is simply nothing proven about it.
    const store = new AnchorStore(storeFile);
    const resolved = store.resolve('e2ee-other', B, A);
    expect(resolved.source).toBe('first-seen');
    expect(resolved.anchor).toEqual(B);
    expect(resolved.conflict).toBeUndefined();
  });

  it('keeps a configured anchor ahead of a proven one', () => {
    // The operator's out-of-band value is the one deliberate choice in the file.
    const store = new AnchorStore(storeFile, { 'e2ee-glm-5-2-p': B });
    const resolved = store.resolve('e2ee-glm-5-2-p', B, A);
    expect(resolved.source).toBe('config');
    expect(resolved.anchor).toEqual(B);
  });

  it('treats an unreadable store as a first run instead of throwing', () => {
    fs.writeFileSync(storeFile, 'not json');
    const store = new AnchorStore(storeFile);
    expect(store.resolve('e2ee-glm-5-2-p', A).source).toBe('first-seen');
  });

  it('falls back to a default path when none is configured', () => {
    // Receipts are optional; an older config must not stop the proxy starting.
    expect(() => new AnchorStore(undefined)).not.toThrow();
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

// loadConfig reads config.yaml from cwd when no path is given. These tests pass
// an explicit path that does not exist, so only defaults and env are in play.
const NO_FILE = '/nonexistent/venice-proxy-config.yaml';

describe('loadConfig — GPU attestation', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.VENICE_API_KEY = 'test-key';
    delete process.env.VERIFY_GPU_ATTESTATION;
    delete process.env.VERIFY_ATTESTATION;
    delete process.env.NRAS_URL;
    delete process.env.DCAP_PCCS_URL;
    delete process.env.VERIFY_GPU_TOKEN_SIGNATURES;
    delete process.env.GPU_PINNED_CERTS;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('checks GPU attestation by default', () => {
    expect(loadConfig(NO_FILE).verify_gpu_attestation).toBe(true);
  });

  it('can be switched off explicitly', () => {
    process.env.VERIFY_GPU_ATTESTATION = 'false';
    expect(loadConfig(NO_FILE).verify_gpu_attestation).toBe(false);
    process.env.VERIFY_GPU_ATTESTATION = '0';
    expect(loadConfig(NO_FILE).verify_gpu_attestation).toBe(false);
  });

  it('keeps checking on a typo rather than silently disabling', () => {
    process.env.VERIFY_GPU_ATTESTATION = 'no';
    expect(loadConfig(NO_FILE).verify_gpu_attestation).toBe(true);
  });

  it('rejects GPU attestation explicitly asked for without attestation verification', () => {
    process.env.VERIFY_GPU_ATTESTATION = 'true';
    process.env.VERIFY_ATTESTATION = 'false';
    expect(() => loadConfig(NO_FILE)).toThrow(/requires verify_attestation/);
  });

  it('follows attestation off, rather than refusing to start', () => {
    // Someone running with attestation disabled should not be broken by the
    // GPU default turning on underneath them.
    process.env.VERIFY_ATTESTATION = 'false';
    const config = loadConfig(NO_FILE);
    expect(config.verify_attestation).toBe(false);
    expect(config.verify_gpu_attestation).toBe(false);
  });

  it('carries an NRAS override through', () => {
    process.env.NRAS_URL = 'https://verifier.internal/gpu';
    expect(loadConfig(NO_FILE).nras_url).toBe('https://verifier.internal/gpu');
  });

  it('leaves the PCCS URL unset so the library picks its default', () => {
    expect(loadConfig(NO_FILE).dcap_pccs_url).toBeUndefined();
  });

  it('carries a PCCS override through', () => {
    process.env.DCAP_PCCS_URL = 'https://pccs.internal/sgx/certification/v4';
    expect(loadConfig(NO_FILE).dcap_pccs_url).toBe('https://pccs.internal/sgx/certification/v4');
  });
});

describe('loadConfig — GPU token signatures', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    process.env.VENICE_API_KEY = 'test-key';
    delete process.env.VERIFY_GPU_TOKEN_SIGNATURES;
    delete process.env.GPU_PINNED_CERTS;
    delete process.env.NRAS_JWKS_URL;
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('verifies token signatures by default', () => {
    expect(loadConfig(NO_FILE).verify_gpu_token_signatures).toBe(true);
  });

  it('can be switched off explicitly', () => {
    process.env.VERIFY_GPU_TOKEN_SIGNATURES = 'false';
    expect(loadConfig(NO_FILE).verify_gpu_token_signatures).toBe(false);
  });

  it('pins no certificates by default', () => {
    expect(loadConfig(NO_FILE).gpu_pinned_certs).toEqual([]);
  });

  it('parses a comma-separated pin list', () => {
    const a = 'a'.repeat(64);
    const b = 'b'.repeat(64);
    process.env.GPU_PINNED_CERTS = `${a}, ${b.toUpperCase()}`;
    expect(loadConfig(NO_FILE).gpu_pinned_certs).toEqual([a, b]);
  });

  it('rejects a malformed pin rather than never matching it', () => {
    process.env.GPU_PINNED_CERTS = 'not-a-digest';
    expect(() => loadConfig(NO_FILE)).toThrow(/SHA-256 hex digests/);
  });

  it('carries a JWKS override through', () => {
    process.env.NRAS_JWKS_URL = 'https://mirror.internal/jwks.json';
    expect(loadConfig(NO_FILE).nras_jwks_url).toBe('https://mirror.internal/jwks.json');
  });
});

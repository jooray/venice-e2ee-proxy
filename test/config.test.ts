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
  });

  afterEach(() => {
    process.env = { ...saved };
  });

  it('leaves GPU attestation off by default', () => {
    expect(loadConfig(NO_FILE).verify_gpu_attestation).toBe(false);
  });

  it('enables it from the environment', () => {
    process.env.VERIFY_GPU_ATTESTATION = 'true';
    expect(loadConfig(NO_FILE).verify_gpu_attestation).toBe(true);
  });

  it('treats any value other than true/1 as off, so typos fail safe-to-run', () => {
    process.env.VERIFY_GPU_ATTESTATION = 'yes';
    expect(loadConfig(NO_FILE).verify_gpu_attestation).toBe(false);
  });

  it('rejects GPU attestation without attestation verification', () => {
    process.env.VERIFY_GPU_ATTESTATION = 'true';
    process.env.VERIFY_ATTESTATION = 'false';
    expect(() => loadConfig(NO_FILE)).toThrow(/requires verify_attestation/);
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

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

export interface ProxyConfig {
  port: number;
  host: string;
  venice_api_key: string;
  venice_base_url: string;
  verify_attestation: boolean;
  enable_dcap: boolean;
  /**
   * PCCS server used to fetch DCAP collateral (PCK certs, CRLs, TCB info).
   * Unset means the library's default, Phala's public PCCS — which is a third
   * party watching which enclaves you verify, and a single point of failure for
   * verification. Point it at your own PCCS to avoid both.
   */
  dcap_pccs_url?: string;
  /**
   * Check the GPU evidence Venice serves against NVIDIA rather than against
   * Venice's own verdict on it. On by default, and fails closed — including
   * when no GPU evidence is served at all, since otherwise the check could be
   * skipped by omitting the payload.
   *
   * The cost is one NRAS round trip per session, which measures as noise beside
   * the attestation handshake itself. The real trade is availability: sessions
   * now depend on NVIDIA being reachable, the same way `enable_dcap` already
   * makes them depend on a PCCS. Set false if that coupling is not worth it,
   * accepting that the GPU is then vouched for only by Venice.
   */
  verify_gpu_attestation: boolean;
  /** Override the NRAS endpoint (a self-hosted verifier, or an air-gapped stub). */
  nras_url?: string;
  /**
   * Verify the ES384 signature on NVIDIA's tokens against its published keys,
   * rather than trusting TLS to NRAS alone. On by default whenever GPU
   * attestation is on: it costs one cached JWKS fetch per 15 minutes, and
   * without it a token is only as good as the connection it arrived on.
   */
  verify_gpu_token_signatures: boolean;
  /** Override where NVIDIA's key set is fetched from. */
  nras_jwks_url?: string;
  /**
   * SHA-256 hex digests of NVIDIA certificates that must appear in the token's
   * chain. Supply the intermediate or root obtained out of band to stop relying
   * on the TLS fetch. Empty means no pinning.
   */
  gpu_pinned_certs: string[];
  verify_receipts: boolean;
  /** Where trust-on-first-use receipt anchors are recorded. */
  receipt_anchor_store: string;
  /**
   * Anchors supplied by the operator, keyed by model id. These are the only ones
   * with provenance outside Venice, so they win over anything recorded on first
   * use — a mismatch is reported as a conflict rather than adopted.
   */
  receipt_anchors: Record<string, { workloadId: string; workloadKeysetDigest: string }>;
  session_ttl: number;
  log_level: 'debug' | 'info' | 'warn' | 'error';
}

const DEFAULTS: Omit<ProxyConfig, 'venice_api_key'> = {
  port: 3000,
  host: '127.0.0.1',
  venice_base_url: 'https://api.venice.ai',
  verify_attestation: true,
  enable_dcap: true,
  verify_gpu_attestation: true,
  verify_gpu_token_signatures: true,
  gpu_pinned_certs: [],
  verify_receipts: false,
  receipt_anchor_store: '.venice-receipt-anchors.json',
  receipt_anchors: {},
  session_ttl: 30 * 60 * 1000, // 30 minutes
  log_level: 'info',
};

/**
 * Load configuration from YAML file + environment variable overrides.
 * Environment variables take precedence over the config file.
 * VENICE_API_KEY is always read from the environment (never stored in config file).
 */
export function loadConfig(configPath?: string): ProxyConfig {
  let fileConfig: Record<string, unknown> = {};

  // Try loading config file
  const paths = configPath
    ? [configPath]
    : ['config.yaml', 'config.yml'];

  for (const p of paths) {
    const resolved = path.resolve(p);
    if (fs.existsSync(resolved)) {
      const content = fs.readFileSync(resolved, 'utf-8');
      fileConfig = (yaml.load(content) as Record<string, unknown>) || {};
      break;
    }
  }

  // Environment variable overrides
  const envOverrides: Record<string, unknown> = {};
  if (process.env.PORT) envOverrides.port = parseInt(process.env.PORT, 10);
  if (process.env.HOST) envOverrides.host = process.env.HOST;
  if (process.env.VENICE_BASE_URL) envOverrides.venice_base_url = process.env.VENICE_BASE_URL;
  if (process.env.VERIFY_ATTESTATION !== undefined) {
    envOverrides.verify_attestation = process.env.VERIFY_ATTESTATION !== 'false' && process.env.VERIFY_ATTESTATION !== '0';
  }
  if (process.env.ENABLE_DCAP !== undefined) {
    envOverrides.enable_dcap = process.env.ENABLE_DCAP === 'true' || process.env.ENABLE_DCAP === '1';
  }
  if (process.env.DCAP_PCCS_URL) envOverrides.dcap_pccs_url = process.env.DCAP_PCCS_URL;
  if (process.env.VERIFY_GPU_ATTESTATION !== undefined) {
    // Only an explicit false/0 disables it. Now that the default is on, a typo
    // has to leave the check running rather than quietly switch it off.
    envOverrides.verify_gpu_attestation =
      process.env.VERIFY_GPU_ATTESTATION !== 'false' && process.env.VERIFY_GPU_ATTESTATION !== '0';
  }
  if (process.env.NRAS_URL) envOverrides.nras_url = process.env.NRAS_URL;
  if (process.env.NRAS_JWKS_URL) envOverrides.nras_jwks_url = process.env.NRAS_JWKS_URL;
  if (process.env.VERIFY_GPU_TOKEN_SIGNATURES !== undefined) {
    envOverrides.verify_gpu_token_signatures =
      process.env.VERIFY_GPU_TOKEN_SIGNATURES !== 'false' &&
      process.env.VERIFY_GPU_TOKEN_SIGNATURES !== '0';
  }
  if (process.env.GPU_PINNED_CERTS) {
    envOverrides.gpu_pinned_certs = process.env.GPU_PINNED_CERTS.split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  }
  if (process.env.VERIFY_RECEIPTS !== undefined) {
    envOverrides.verify_receipts =
      process.env.VERIFY_RECEIPTS === 'true' || process.env.VERIFY_RECEIPTS === '1';
  }
  if (process.env.RECEIPT_ANCHOR_STORE) {
    envOverrides.receipt_anchor_store = process.env.RECEIPT_ANCHOR_STORE;
  }
  if (process.env.SESSION_TTL) envOverrides.session_ttl = parseInt(process.env.SESSION_TTL, 10);
  if (process.env.LOG_LEVEL) envOverrides.log_level = process.env.LOG_LEVEL;

  // API key: environment only, never the config file — config.yaml is the file
  // people share, paste into issues and accidentally commit.
  if (fileConfig.venice_api_key) {
    delete fileConfig.venice_api_key;
    console.warn(
      'Ignoring venice_api_key found in the config file. Set VENICE_API_KEY in the ' +
      'environment (or .env) instead, and remove the key from the config file.'
    );
  }

  const apiKey = process.env.VENICE_API_KEY;
  if (!apiKey) {
    throw new Error(
      'VENICE_API_KEY environment variable is required.\n' +
      'Set it with: export VENICE_API_KEY=your-key-here'
    );
  }

  const merged = {
    ...DEFAULTS,
    ...fileConfig,
    ...envOverrides,
    venice_api_key: apiKey,
  } as ProxyConfig;

  // Caught here rather than at the first request, where the library would throw
  // the same objection with far less context about which setting caused it.
  if (merged.verify_gpu_attestation && !merged.verify_attestation) {
    // Only a contradiction if both were asked for. Turning attestation off and
    // leaving the GPU default alone is a coherent choice, and now that the
    // default is on it must not start refusing to boot for those setups.
    const gpuWasRequested =
      'verify_gpu_attestation' in fileConfig || 'verify_gpu_attestation' in envOverrides;

    if (gpuWasRequested) {
      throw new Error(
        'verify_gpu_attestation requires verify_attestation. GPU evidence is checked as part of ' +
        'attestation, so it cannot be enforced while attestation is switched off.'
      );
    }
    merged.verify_gpu_attestation = false;
    console.warn(
      'Attestation verification is off, so GPU attestation is off too — there is no attestation ' +
      'to check GPU evidence against.'
    );
  }

  // A malformed pin silently never matches, which reads as "pinning is on" while
  // being equivalent to refusing every session. Catch the typo instead.
  for (const digest of merged.gpu_pinned_certs ?? []) {
    if (!/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error(
        `gpu_pinned_certs entries must be SHA-256 hex digests (64 hex chars); got "${digest}"`
      );
    }
  }

  return merged;
}

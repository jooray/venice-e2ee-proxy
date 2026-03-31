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
  /** When true, forward unrecognized paths to Venice with the same method, path, query, and body. */
  endpoint_passthru: boolean;
  /**
   * When true, forward `tools`, `tool_choice`, and `parallel_tool_calls` on E2EE chat requests.
   * Default false strips them (tool-related response fields are not decrypted by the proxy).
   */
  e2ee_allow_tools: boolean;
  session_ttl: number;
  log_level: 'debug' | 'info' | 'warn' | 'error';
}

const DEFAULTS: Omit<ProxyConfig, 'venice_api_key'> = {
  port: 3000,
  host: '127.0.0.1',
  venice_base_url: 'https://api.venice.ai',
  verify_attestation: true,
  enable_dcap: true,
  endpoint_passthru: false,
  e2ee_allow_tools: false,
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
  if (process.env.ENDPOINT_PASSTHRU !== undefined) {
    envOverrides.endpoint_passthru =
      process.env.ENDPOINT_PASSTHRU === 'true' || process.env.ENDPOINT_PASSTHRU === '1';
  }
  if (process.env.E2EE_ALLOW_TOOLS !== undefined) {
    envOverrides.e2ee_allow_tools =
      process.env.E2EE_ALLOW_TOOLS === 'true' || process.env.E2EE_ALLOW_TOOLS === '1';
  }
  if (process.env.SESSION_TTL) envOverrides.session_ttl = parseInt(process.env.SESSION_TTL, 10);
  if (process.env.LOG_LEVEL) envOverrides.log_level = process.env.LOG_LEVEL;

  // API key: always from environment
  const apiKey = process.env.VENICE_API_KEY || (fileConfig.venice_api_key as string | undefined);
  if (!apiKey) {
    throw new Error(
      'VENICE_API_KEY environment variable is required.\n' +
      'Set it with: export VENICE_API_KEY=your-key-here'
    );
  }

  return {
    ...DEFAULTS,
    ...fileConfig,
    ...envOverrides,
    venice_api_key: apiKey,
  } as ProxyConfig;
}

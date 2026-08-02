import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

/**
 * TEMPORARY diagnostic dump for the E2EE tool-calling path.
 *
 * Writes the plaintext prompt and the raw decrypted model output to disk so the
 * exact bytes can be inspected when a client's tool call fails to parse. This
 * defeats the entire point of the proxy, so it is off unless
 * `VENICE_PROXY_DEBUG_DUMP` names a file, and it says so loudly on first use.
 *
 * Remove once the tool-call formats in the wild are pinned down.
 */
const target = process.env.VENICE_PROXY_DEBUG_DUMP;
let warned = false;

export const debugDumpEnabled = Boolean(target);

export function debugDump(kind: string, payload: Record<string, unknown>): void {
  if (!target) return;

  if (!warned) {
    warned = true;
    logger.warn(
      `PLAINTEXT DUMP ENABLED — prompts and responses are being written to ${target}. ` +
      `Unset VENICE_PROXY_DEBUG_DUMP and delete that file when you are done.`
    );
    try {
      fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
    } catch {
      // Directory may already exist, or be unwritable — the append below reports it.
    }
  }

  try {
    fs.appendFileSync(target, `${JSON.stringify({ kind, ...payload })}\n`);
  } catch (err: unknown) {
    logger.error(`Debug dump failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

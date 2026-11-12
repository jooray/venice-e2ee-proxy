import { flattenMessageContent, type ContentPart } from 'venice-e2ee';

interface ChatMessageLike {
  role: string;
  content?: string | ContentPart[] | null;
  [key: string]: unknown;
}

/**
 * Collapse every `system` message into one, before anything is encrypted.
 *
 * Venice's E2EE gateway accepts at most one system message. With two or more —
 * leading or scattered through the conversation — it joins their contents
 * server-side, on the ciphertext, and the joined string is no longer a single
 * encrypted field. Depending on the model the request then fails with
 * "Encrypted field is not valid hex" or "E2EE decryption failed" (issues #2, #4).
 * Clients such as opencode and SillyTavern send several system messages by
 * default, so this has to be handled here, in plaintext.
 *
 * Measured against live Venice (2026-11): repeated `user`, `assistant` and
 * `tool` turns are accepted as they are, and so is a single system message that
 * is not first. Only the system role is merged; everything else keeps its role
 * and position, because rewriting other turns would change the conversation the
 * model sees for no gain.
 *
 * The merged message takes the place of the first system message, joining the
 * parts with a blank line. `extra` (the rendered tool schemas) is appended last,
 * which matches where it used to go; with no system message it becomes a new one
 * at the front. Empty parts are dropped so they do not leave stray blank lines.
 *
 * A request with a single system message and no `extra` is returned untouched.
 */
export function mergeSystemMessages<T extends ChatMessageLike>(
  messages: T[],
  extra?: string | null
): Array<T | { role: 'system'; content: string }> {
  const systemCount = messages.filter((m) => m.role === 'system').length;
  if (systemCount <= 1 && !extra) return messages;

  const parts = messages
    .filter((m) => m.role === 'system')
    .map((m) => flattenMessageContent(m.content));
  if (extra) parts.push(extra);
  const merged = { role: 'system' as const, content: parts.filter((p) => p !== '').join('\n\n') };

  const firstSystem = messages.findIndex((m) => m.role === 'system');
  if (firstSystem === -1) return [merged, ...messages];

  const out: Array<T | { role: 'system'; content: string }> = [];
  messages.forEach((m, i) => {
    if (i === firstSystem) out.push(merged);
    else if (m.role !== 'system') out.push(m);
  });
  return out;
}

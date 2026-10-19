/**
 * Last gate before an inbound source hands the agent's reply back to its
 * caller: residual internal directives (egressGuard) and anything that looks
 * like a key. A hit withholds the whole reply; the caller gets the harmless
 * notice instead and the original goes to the dead-letter log (keys masked).
 */

import { recordDeadLetter } from "../contacts";
import { EGRESS_BLOCKED_REPLY, guardOutgoing } from "../egressGuard";
import { inboundTokenValues } from "./server";

/** Agents Gateway keys: `lgw_<type>_<base62>`. */
export const KEY_PATTERN = /\blgw_[a-z]+_[A-Za-z0-9]{8,}/g;

/** `text` with key-shaped strings and the inbound tokens masked out. */
export function maskSecrets(text: string): string {
  let out = text.replace(KEY_PATTERN, "lgw_…");
  for (const t of inboundTokenValues()) out = out.split(t).join("…");
  return out;
}

function containsSecret(text: string): boolean {
  return new RegExp(KEY_PATTERN.source).test(text) || inboundTokenValues().some((t) => text.includes(t));
}

export async function screenReply(opts: {
  /** Source name, for logs and dead-letter (e.g. "agents-gateway"). */
  source: string;
  /** Conversation the reply is for, for logs and dead-letter. */
  target: string;
  text: string;
}): Promise<{ text: string; withheld: boolean }> {
  if (containsSecret(opts.text)) {
    console.error(`[inbound] BLOCKED ${opts.source} reply for ${opts.target}: contains a key — withheld`);
    await recordDeadLetter({
      at: new Date().toISOString(),
      source: opts.source,
      target: opts.target,
      error: "reply contained a key; withheld",
      preview: maskSecrets(opts.text).slice(0, 200),
    });
    return { text: EGRESS_BLOCKED_REPLY, withheld: true };
  }
  // No dmAdmin: inbound sources have no channel to an admin, so a block is
  // logged and dead-lettered by the guard.
  if (await guardOutgoing({ platform: opts.source, text: opts.text, context: opts.target })) {
    return { text: EGRESS_BLOCKED_REPLY, withheld: true };
  }
  return { text: opts.text, withheld: false };
}

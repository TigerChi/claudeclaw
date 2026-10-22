/**
 * Last gate before an inbound source hands the agent's reply back to its
 * caller: anything that looks like a key. A hit withholds the whole reply;
 * the caller gets a short notice instead and the original goes to the
 * dead-letter log (keys masked). [notify:] blocks never get here — run()
 * delivers and strips them.
 */

import { recordDeadLetter } from "../contacts";
import { inboundTokenValues } from "./server";

/** Sent in place of a reply that contained a key. */
export const KEY_WITHHELD_REPLY = "這則回覆含有金鑰，已攔下沒有送出。";

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
    return { text: KEY_WITHHELD_REPLY, withheld: true };
  }
  return { text: opts.text, withheld: false };
}

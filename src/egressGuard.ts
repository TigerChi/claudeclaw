import { recordDeadLetter } from "./contacts";

/**
 * Fail-closed egress guard.
 *
 * Internal directive markers (`[notify:` …) are meant to be stripped before a
 * message reaches a user-facing channel. If one survives to the egress point, a
 * strip path upstream failed — and the current design leaks the whole internal
 * payload into whatever chat the agent was replying to (e.g. an outside bank
 * group). This guard is the belt to that suspenders: at each platform's send
 * choke point we scan the final text and, if any marker remains, withhold the
 * whole message rather than risk leaking internals.
 *
 * It is deliberately a dumb substring check. The point is a guarantee that holds
 * even when a future code path forgets to strip — so it errs toward blocking.
 */
export const RESIDUAL_DIRECTIVE_MARKERS = [
  "[notify:",
  "[/notify]",
  "[send-agent:",
  "[/send-agent]",
] as const;

/** Shown in the originating conversation when a message is blocked. Must never
 *  contain the original (marker-laden) text. */
export const EGRESS_BLOCKED_REPLY = "已收到，請私訊我 🙏";

/** First residual marker found in `text`, or null if the text is clean. */
export function findResidualDirective(text: string): string | null {
  for (const marker of RESIDUAL_DIRECTIVE_MARKERS) {
    if (text.includes(marker)) return marker;
  }
  return null;
}

export interface EgressGuardOptions {
  /** Platform label for logs / dead-letter (e.g. "line", "slack"). */
  platform: string;
  /** The exact text about to be sent to the user-facing channel. */
  text: string;
  /** Admin DM target for this platform (config.adminUserId). */
  adminUserId?: string | number;
  /** Platform-specific DM sender. MUST bypass this guard — the admin message
   *  intentionally carries the original marker-laden text. */
  dmAdmin?: (adminId: string, body: string) => Promise<void>;
  /** Human-readable origin for logs / dead-letter (e.g. chat/channel id). */
  context?: string;
}

/**
 * Call at each platform's send choke point AFTER all legitimate directives are
 * stripped and BEFORE the user-facing send.
 *
 * On a residual marker: the original goes nowhere user-visible. The admin is
 * DM'd the original + reason; if no admin is resolvable (or the DM fails) it is
 * dead-lettered and logged. Either way the caller must send
 * `EGRESS_BLOCKED_REPLY` to the originating conversation — never the original.
 *
 * @returns true if blocked (caller must not send the original text).
 */
export async function guardOutgoing(opts: EgressGuardOptions): Promise<boolean> {
  const marker = findResidualDirective(opts.text);
  if (!marker) return false;

  const where = opts.context ? ` (${opts.context})` : "";
  console.error(
    `[egress-guard] BLOCKED ${opts.platform}${where}: residual directive "${marker}" — message withheld`,
  );

  const adminId = opts.adminUserId != null ? String(opts.adminUserId) : "";
  if (adminId && opts.dmAdmin) {
    const body = [
      "⚠️ 一則外送訊息被攔截，未發出（含內部指令標記，可能是漏剝除）。",
      `平台：${opts.platform}${where}`,
      `原因：殘留標記 ${marker}`,
      "──原文──",
      opts.text,
    ].join("\n");
    try {
      await opts.dmAdmin(adminId, body);
      return true;
    } catch (err) {
      console.error(
        `[egress-guard] admin DM to ${adminId} failed: ${err instanceof Error ? err.message : err}`,
      );
      // fall through to dead-letter so the blocked payload is never lost
    }
  }

  // No admin resolvable, or the admin DM failed. Never fall back to the
  // originating conversation — record it for out-of-band follow-up instead.
  await recordDeadLetter({
    at: new Date().toISOString(),
    source: `egress-guard:${opts.platform}`,
    target: adminId ? `admin:${adminId}` : "admin:unset",
    error: `residual directive "${marker}"${where}${adminId ? " (admin DM failed)" : " (no adminUserId configured)"}`,
    preview: opts.text.slice(0, 200),
  }).catch(() => {});
  return true;
}

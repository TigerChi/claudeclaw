import { listAgents } from "./agent-bus";
import { loadBook, recordDeadLetter, resolveNotifyTarget } from "./contacts";

/**
 * Fail-closed egress guard.
 *
 * Internal directives (`[notify:…]…[/notify]`, `[send-agent:…]`) are meant to
 * be handled before a message reaches a user-facing channel. If one survives to
 * the egress point, a strip path upstream failed — and the current design
 * leaks the whole internal payload into whatever chat the agent was replying
 * to (e.g. an outside bank group). This guard is the belt to that suspenders:
 * at each platform's send choke point we scan the final text and, if it still
 * carries a directive, withhold the whole message rather than risk leaking.
 *
 * "Carries a directive" follows what the directive parsers would act on, so
 * prose that merely mentions the syntax ("I write [notify:target] in my
 * output") goes through. Blocked:
 *   - a complete `[notify:X]…[/notify]` pair anywhere, code spans and fences
 *     included (a model may wrap a real directive in a code block);
 *   - a line that opens with `[notify:` or `[send-agent:<name>]` (with or
 *     without list / quote / code markers before it) — the shape of a real
 *     directive, even if malformed;
 *   - `[notify:X]` or `[send-agent:X]` anywhere else when X is a real target:
 *     a contacts-book recipient, a `platform:id` address, `reply`, or a
 *     registered agent. A real target with no closing tag usually means the
 *     closing tag was dropped and what follows was meant for X alone.
 * Placeholder targets ("target", "X", "對象") and lone closing tags pass. When
 * the contacts book or the agent registry cannot be read (or is empty), every
 * target of that kind counts as real.
 */
export const RESIDUAL_DIRECTIVE_MARKERS = [
  "[notify:",
  "[/notify]",
  "[send-agent:",
  "[/send-agent]",
] as const;

/** Shown in the originating group / channel when a message is blocked. Must
 *  never contain the original text. */
export const EGRESS_BLOCKED_REPLY = "已收到，請私訊我 🙏";

/** Shown instead in a direct conversation, where "DM me" makes no sense. */
export const EGRESS_BLOCKED_REPLY_DIRECT = "這則回覆含有系統指令語法，已攔下沒有送出。";

/** The notice to send in place of a blocked message. */
export function egressBlockedReply(direct: boolean): string {
  return direct ? EGRESS_BLOCKED_REPLY_DIRECT : EGRESS_BLOCKED_REPLY;
}

/** Which directive targets are real. */
export interface DirectiveTargets {
  isNotifyTarget(name: string): boolean;
  isAgent(name: string): boolean;
}

/** Every target is real — used when the book / registry cannot be read. */
const ALL_REAL: DirectiveTargets = { isNotifyTarget: () => true, isAgent: () => true };

const NOTIFY_PAIR = /\[notify:[^\]\r\n]+\][\s\S]*?\[\/notify\]/i;
// Leading whitespace, blockquote, list bullets / numbers and code ticks.
const LINE_PREFIX = /^(?:[\s>*+\-•·`]|\d+[.)])*/;
const LINE_NOTIFY = /^\[notify:/i;
const LINE_SEND_AGENT = /^\[send-agent:[a-z0-9_-]+\]/i;
const OPEN_NOTIFY = /\[notify:([^\]\r\n]+)\]/gi;
const OPEN_SEND_AGENT = /\[send-agent:([^\]\r\n]+)\]/gi;

/**
 * The directive in `text` that would leak if sent, or null if the text is
 * clean. `targets` decides which names are real (default: all of them).
 */
export function findResidualDirective(text: string, targets: DirectiveTargets = ALL_REAL): string | null {
  if (NOTIFY_PAIR.test(text)) return "[notify:…]…[/notify]";

  for (const line of text.split(/\r?\n/)) {
    const body = line.replace(LINE_PREFIX, "");
    if (LINE_NOTIFY.test(body)) return "[notify: at line start";
    if (LINE_SEND_AGENT.test(body)) return "[send-agent: at line start";
  }

  for (const m of text.matchAll(OPEN_NOTIFY)) {
    const name = m[1]!.trim();
    if (targets.isNotifyTarget(name)) return `[notify:${name}]`;
  }
  for (const m of text.matchAll(OPEN_SEND_AGENT)) {
    const name = m[1]!.trim();
    if (targets.isAgent(name)) return `[send-agent:${name}]`;
  }
  return null;
}

/**
 * Real targets from the shared contacts book and the agent-bus registry. Both
 * loaders return an empty result when their file cannot be read, so an empty
 * book or registry counts as unreadable (the running daemon is always in the
 * registry; a missing book just makes the guard stricter).
 */
async function loadTargets(): Promise<DirectiveTargets> {
  try {
    const [book, registry] = await Promise.all([loadBook(), listAgents()]);
    const agents = new Set(Object.keys(registry).map((n) => n.toLowerCase()));
    const bookKnown = Object.keys(book.recipients).length > 0;
    return {
      isNotifyTarget: bookKnown ? (name) => resolveNotifyTarget(name, book).ok : ALL_REAL.isNotifyTarget,
      isAgent: agents.size > 0 ? (name) => agents.has(name.toLowerCase()) : ALL_REAL.isAgent,
    };
  } catch {
    return ALL_REAL;
  }
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
 * On a residual directive: the original goes nowhere user-visible. The admin is
 * DM'd the original + reason; if no admin is resolvable (or the DM fails) it is
 * dead-lettered and logged. Either way the caller must send
 * `egressBlockedReply(<is a direct conversation>)` to the originating
 * conversation — never the original.
 *
 * @returns true if blocked (caller must not send the original text).
 */
export async function guardOutgoing(opts: EgressGuardOptions): Promise<boolean> {
  // Cheap pre-check: nothing to look at without a marker.
  if (!RESIDUAL_DIRECTIVE_MARKERS.some((m) => opts.text.includes(m))) return false;
  const marker = findResidualDirective(opts.text, await loadTargets());
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

import { describe, expect, test } from "bun:test";
import {
  EGRESS_BLOCKED_REPLY,
  EGRESS_BLOCKED_REPLY_DIRECT,
  egressBlockedReply,
  findResidualDirective,
  type DirectiveTargets,
} from "./egressGuard";

// "boss" is a contacts-book recipient; jake / felix are registered agents.
const targets: DirectiveTargets = {
  isNotifyTarget: (n) => ["boss", "reply"].includes(n.toLowerCase()) || /^(line|slack|telegram|discord):\S+/.test(n),
  isAgent: (n) => ["jake", "felix"].includes(n.toLowerCase()),
};
const blocked = (t: string) => expect(findResidualDirective(t, targets)).not.toBeNull();
const passes = (t: string) => expect(findResidualDirective(t, targets)).toBeNull();

describe("complete [notify:] pairs are always blocked", () => {
  test("plain", () => blocked("好的。[notify:boss]明天請假[/notify]"));
  test("placeholder target", () => blocked("例如 [notify:對象]訊息[/notify] 這樣"));
  test("inside inline code", () => blocked("語法是 `[notify:對象]訊息[/notify]`"));
  test("inside a fenced block", () => blocked("範例：\n```\n[notify:boss]\n明天請假\n[/notify]\n```"));
});

describe("a line opening with a directive is blocked", () => {
  test("lone [notify:] at line start", () => blocked("收到\n[notify:對象] 明天請假"));
  test("after a list bullet", () => blocked("- [notify:boss] 明天請假"));
  test("after a blockquote / code tick", () => blocked("> `[notify:x]` 下一行"));
  test("[send-agent:<name>] at line start", () => blocked("[send-agent:jake] 幫我查一下"));
  test("[send-agent:<name>] after indentation", () => blocked("  [send-agent:somebody] 幫我查"));
});

describe("mid-sentence: real targets are blocked", () => {
  test("[notify:] to a contacts-book name", () => blocked("我等等會用 [notify:boss] 跟他講"));
  test("[notify:] to a platform address", () => blocked("寫成 [notify:line:Uabc123] 就會送"));
  test("[notify:reply]", () => blocked("用 [notify:reply] 回覆"));
  test("[send-agent:] to a registered agent", () => blocked("我請 [send-agent:felix] 處理"));
});

describe("mid-sentence: placeholders and closing tags pass", () => {
  test("the reply that was blocked on 10/21", () =>
    passes("主動發的（每天 08:30 催辦、20:30 銀行摘要這種排程）\n我在輸出裡寫 [notify:對象]，ClaudeClaw daemon 收到後，拿 settings 裡的 token 直接推給你。"));
  test("English placeholder", () => passes("Write [notify:target] before the message."));
  test("[send-agent:<name>] placeholder", () => passes("語法是 [send-agent:<name>]，要寫在行首"));
  test("lone closing [/notify]", () => passes("最後要用 [/notify] 收尾"));
  test("lone closing [/send-agent]", () => passes("結尾是 [/send-agent]"));
  test("no markers at all", () => passes("今天的帳記好了"));
});

describe("fail closed", () => {
  test("without target lists every name counts as real", () =>
    expect(findResidualDirective("我在輸出裡寫 [notify:對象]")).not.toBeNull());
});

describe("blocked-message notice", () => {
  test("group / channel", () => expect(egressBlockedReply(false)).toBe(EGRESS_BLOCKED_REPLY));
  test("direct conversation", () => expect(egressBlockedReply(true)).toBe(EGRESS_BLOCKED_REPLY_DIRECT));
  test("the DM notice does not ask to be DM'd", () => expect(EGRESS_BLOCKED_REPLY_DIRECT).not.toContain("私訊"));
});

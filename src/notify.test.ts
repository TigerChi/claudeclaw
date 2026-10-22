import { describe, expect, test } from "bun:test";
import { extractNotifyDirectives, hideNotifyBlocks } from "./contacts";

const parse = (t: string) => extractNotifyDirectives(t);

describe("blocks are delivered side by side", () => {
  test("reply text plus one block", () => {
    const r = parse("收到，我私訊她。\n\n[notify:line:U1]\n明天十點見\n[/notify]\n");
    expect(r.cleaned).toBe("收到，我私訊她。");
    expect(r.directives).toEqual([{ target: "line:U1", payload: "明天十點見" }]);
  });

  test("several targets, each its own block", () => {
    const r = parse("好的。[notify:boss]A 的內容[/notify][notify:alice@slack]B 的內容[/notify]已通知兩位");
    expect(r.cleaned).toBe("好的。已通知兩位");
    expect(r.directives).toEqual([
      { target: "boss", payload: "A 的內容" },
      { target: "alice@slack", payload: "B 的內容" },
    ]);
  });

  test("only blocks: nothing left for the conversation", () => {
    const r = parse("[notify:boss]只給你[/notify]");
    expect(r.cleaned).toBe("");
    expect(r.directives).toHaveLength(1);
  });
});

describe("a block inside another is pulled out, not nested", () => {
  test("inner block is its own delivery; outer keeps only its own text", () => {
    const r = parse("群組回覆[notify:a]給 a 前段[notify:b]給 b[/notify]給 a 後段[/notify]");
    expect(r.cleaned).toBe("群組回覆");
    expect(r.directives).toEqual([
      { target: "a", payload: "給 a 前段給 a 後段" },
      { target: "b", payload: "給 b" },
    ]);
    for (const d of r.directives) expect(d.payload).not.toContain("[notify:");
  });
});

describe("prose about the syntax is not swallowed", () => {
  test("an unclosed tag stays as text", () => {
    const t = "我在輸出裡寫 [notify:對象]，daemon 收到後就會推給你。";
    expect(parse(t)).toEqual({ cleaned: t, directives: [] });
  });
  test("a stray closing tag stays as text", () => {
    const t = "最後要用 [/notify] 收尾";
    expect(parse(t)).toEqual({ cleaned: t, directives: [] });
  });
  test("an unclosed tag after a real block stays as text", () => {
    const r = parse("[notify:a]x[/notify]語法是 [notify:對象] 開頭");
    expect(r.directives).toEqual([{ target: "a", payload: "x" }]);
    expect(r.cleaned).toBe("語法是 [notify:對象] 開頭");
  });
  test("an empty block is dropped", () => {
    expect(parse("[notify:a]  [/notify]好").directives).toEqual([]);
  });
});

describe("streaming preview hides notify content", () => {
  test("complete block removed", () => expect(hideNotifyBlocks("嗨[notify:a]秘密[/notify]你好")).toBe("嗨你好"));
  test("open block held back", () => expect(hideNotifyBlocks("嗨\n[notify:a]\n秘密還在打")).toBe("嗨"));
  test("tag still arriving", () => expect(hideNotifyBlocks("嗨 [noti")).toBe("嗨"));
  test("only a block so far", () => expect(hideNotifyBlocks("[notify:a]秘密")).toBe(""));
  test("plain text unchanged", () => expect(hideNotifyBlocks("今天的帳記好了")).toBe("今天的帳記好了"));
});

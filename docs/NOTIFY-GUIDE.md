# ClaudeClaw 定向通知（Notify）使用指南

本文件寫給**使用者**：說明 agent 怎麼把訊息「指定發給某個人 / 群組 / 頻道」、通訊錄怎麼建立與維護、以及訊息沒送到時怎麼查。
（給 agent 看的精簡規則在 `prompts/USAGE.md`；工程規格在 `docs/NOTIFY.md`。）

---

## 一、這是什麼？跟以前差在哪

以前 ClaudeClaw 只有「**廣播**」：agent 的 bus 回覆、排程（cron）結果、heartbeat 回報，會無差別發給**每個平台 allowlist 上的所有人**。人一多、agent 一多，通知就會洗版。

現在改成「**定向通知**」：

| | 廣播（舊） | 定向通知（新） |
|---|---|---|
| 對象 | 所有平台的所有 allowed users | 指定的一個人 / 群組 / 頻道 |
| 平台 | 全部啟用的平台 | 對象的預設平台，或顯式指定 |
| 觸發 | 自動（有輸出就發） | agent 明確使用 `[notify:]` 才發 |

預設模式是 `explicit`：**agent 之間的 bus 對話不會再自動轉發給你**，只有 agent 明確指定對象的訊息才會送出。

---

## 二、怎麼使用（一般情境）

你不需要記語法——直接用自然語言跟 agent 說就好：

> 「處理完之後，用 Telegram 通知我」
> 「每天早上 8 點把菜單發到家庭群組」
> 「結果發到 ops 頻道」

Agent 會在輸出裡使用 `[notify:<對象>]訊息[/notify]`，daemon 解析後定向送出。收到的訊息**尾端**會帶一行 `[來源]` 標籤（哪個 agent / 哪個排程發的），例如：

```
今日菜單：……
[menu-daily]
```

---

## 三、通訊錄：讓 agent 知道「某某人」是誰

所有 agent 共用一本通訊錄，放在：

```
~/.claude/claudeclaw/contacts/
├── book.json            # 名冊（你或 agent 維護）
├── seen/<agent>.json    # 候選池（自動收集，不用管）
└── dead-letter.jsonl    # 發送失敗紀錄
```

### book.json 長這樣

```json
{
  "recipients": {
    "boss": {
      "type": "person",
      "aliases": ["老闆"],
      "platforms": {
        "telegram": "123456789",
        "slack": "U0123ABCDEF",
        "line": "U99887766..."
      },
      "default": ["telegram"]
    },
    "family-group": {
      "type": "group",
      "aliases": ["家庭群", "家人群組"],
      "platforms": { "line": "C55443322..." },
      "default": ["line"]
    }
  }
}
```

重點規則：

- **以「人／群組」為單位**，不是以平台為單位。一個人可以有多個平台 id；群組天生只屬於一個平台。
- **`default`**：講「通知 boss」時只發這些平台（可多個），其他平台不吵。要發非預設平台要點名，例如「用 LINE 通知 boss」。
- **`aliases`**：多個別名都指到同一個對象（群組特別有用——每次描述的講法不一定一樣）。別名不能跨對象重複，也不能用保留字（`reply` / `telegram` / `slack` / `line` / `discord`）。
- 改完**立即生效**（每次發送都重新讀檔），不用重啟任何 daemon。

### 通訊錄怎麼「長出來」——候選池（harvest）

通訊平台**不提供**「列出 bot 所在的所有群組」這種 API，id 只能在**收到訊息的當下**被記錄。所以 ClaudeClaw 的作法是：

1. 每個 agent 收到任何訊息時，自動把「平台、id、名稱（拿得到的話）、類型」記進自己的候選池 `seen/<agent>.json`。
2. 你想把某個人／群組加進名冊時，用 `/claudeclaw:contacts` 指令（或直接請 agent 幫忙）從候選池挑出來、取個名字、寫進 book.json。

### 想讓 agent 發訊息到某個群組？三步驟

1. **把該 agent 的 bot 帳號邀進群**（LINE 邀官方帳號、Slack `/invite @bot`、TG 把 bot 加進群）。你自己在不在群裡無所謂——**bot 在就行**。
2. 群裡隨便有一則訊息後，群組 id 就進了候選池。
3. 用 `/claudeclaw:contacts promote` 給它取名字 → 之後就能說「發到某某群」。

> 限制：bot 不在的群組發不進去，這是所有平台的硬限制，沒有繞法。

### 管理指令

```
/claudeclaw:contacts              # 看名冊 + 候選池
/claudeclaw:contacts promote <候選> <名字>   # 候選轉正
/claudeclaw:contacts alias <名字> <別名...>  # 加別名
/claudeclaw:contacts default <名字> <平台...> # 設預設平台
/claudeclaw:contacts dead-letters # 看最近的發送失敗
```

---

## 四、排程訊息到指定對象（cron + notify）

Job 的 prompt 裡交代對象即可。範例 `.claude/claudeclaw/jobs/menu-daily.md`：

```markdown
---
schedule: "0 8 * * *"
recurring: true
---
整理今天的菜單，然後用 [notify:family-group]...[/notify] 發到家庭群組。
```

規則：job 輸出**只要有 `[notify:]`，就只發給指定對象**，原本的 `channels` 廣播整個跳過；沒寫 notify 的舊 job 行為不變（相容）。

---

## 五、notify.mode 設定

每個 agent 的 `settings.json` 可設：

```json
{ "notify": { "mode": "explicit" } }
```

- **`explicit`（預設）**：bus 純文字不外發，只有 `[notify:]` 會送到使用者。
- **`legacy`**：舊行為——bus 純文字廣播給所有人。只給特殊需求 opt-in 用。

改這個設定 30 秒內 hot-reload 生效，不用重啟。

---

## 六、訊息沒送到？排查順序

1. **查 dead-letter**：`/claudeclaw:contacts dead-letters`（或直接看 `~/.claude/claudeclaw/contacts/dead-letter.jsonl`）。每筆失敗都有：時間、哪個來源、發給誰、錯誤原因。
2. 常見原因對照：

| dead-letter 錯誤 | 原因 | 解法 |
|---|---|---|
| `recipient "X" not found` | 名冊裡沒這個名字/別名 | promote 或加別名 |
| `bot 不在群 / API 錯誤` | bot 沒被邀進目標群組 | 把 bot 邀進群 |
| `not configured on this agent` | 發送的 agent 沒有該平台的 token | 換有該平台的 agent 發，或幫它補 token |
| `[notify:reply] is not available...` | 排程/bus 觸發的執行沒有「原訊息」可回 | 改用名冊名或直接定址 |

3. dead-letter 沒有紀錄、log 顯示 `sent` → 訊息已由平台接收，檢查手機通知設定或找錯聊天室了。

補充說明：名冊裡一個對象的 `default` 有多個平台時，**發送的 agent 沒有 token 的平台會安靜跳過**（不算失敗）——例如某 agent 只接了 Slack，它通知你時就只走 Slack。全部平台都發不出去才會進 dead-letter。

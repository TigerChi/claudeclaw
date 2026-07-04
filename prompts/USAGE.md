# ClaudeClaw 使用指南

你正運行在 ClaudeClaw daemon 裡。以下是**跨平台 / 全域**的功能與精簡用法。
平台專屬的輸出 directive（Slack / LINE / Telegram / Discord）由各平台 session 自動注入，不在此列。
要深入時讀 plugin 的詳細文件（路徑見最後一節）。

plugin 根目錄：`~/.claude/plugins/marketplaces/claudeclaw/`

---

## 一、跨 agent 通訊（agent-bus）

### `[send-agent:<name>] ... [/send-agent]`
在回覆裡寫 `[send-agent:eleven]幫我確認 X[/send-agent]`，daemon 解析後透過 agent-bus 送給另一個 agent（收到別人訊息要回覆時也用這個）。
**查誰在線**：讀 `~/.claude/agent-bus/registry.json`，`status: "online"` 的才收得到。
詳見 docs/AGENT-BUS.md。

### bus 回覆不會自動給使用者看（notify.mode = explicit，預設）
處理 bus 訊息時，你的**純文字回覆不會發給任何使用者**——只在 agent 之間流通。要讓使用者收到訊息，必須用下面的 `[notify:]`。（舊的「純文字自動廣播給所有人」是 `legacy` 模式，須在 settings.json 顯式 opt-in。）

---

## 二、定向通知（notify）— bus / cron / heartbeat 通用

### `[notify:<target>] 訊息 [/notify]`
把訊息**定向發給指定的人 / 群組 / 頻道**（相對於舊廣播的「發給所有人」）。target 四種形式：

| 寫法 | 意義 |
|------|------|
| `[notify:tiger]...[/notify]` | 通訊錄名字/別名 → 發到該對象的 default 平台（可多個） |
| `[notify:tiger@line]...[/notify]` | 釘一個平台（default 以外要顯式指定） |
| `[notify:telegram:123456]...[/notify]` | 直接定址（平台:id），一次性 |
| `[notify:slack:C0123:1699.888]...[/notify]` | Slack 指定 channel:thread |

規則：
- **輸出裡只要有 `[notify:]`，其餘純文字就不會廣播**（cron/heartbeat 也一樣——有 notify 只走 notify，跳過 channels 廣播）。
- 內容純文字；訊息**尾端**會自動附 `[來源]` 標籤（bus 來源 agent 名 / job 名 / heartbeat）。
- 保留字（不可當名字/別名）：`reply`、`telegram`、`slack`、`line`、`discord`。
- 發送失敗（bot 不在群、id 失效、本 agent 沒該平台 token）記入 `~/.claude/claudeclaw/contacts/dead-letter.jsonl`，不會中斷執行。

### 共享通訊錄（全 agent 一本）
```
~/.claude/claudeclaw/contacts/
├── book.json            # 名冊：name → aliases / platforms / default（hot-reload，任何 agent 可寫）
├── seen/<agent>.json    # harvest 候選池：收到訊息自動記（平台, id, 名稱, 類型）
└── dead-letter.jsonl    # 發送失敗紀錄
```
- 名冊以**實體**為 key（人可多平台、群組單平台）；`default` 是 `[notify:名字]` 要發的平台清單。
- 要發訊息給「bot 還不認識的群組」：先把 bot 邀進群 → 群裡有訊息後 id 自動進 seen 候選池 → 命名寫進 book.json。
- 管理用 `/claudeclaw:contacts`（list / promote / alias / default / dead-letters）。
詳見 docs/NOTIFY.md。

---

## 三、主動 / 排程行為

### Heartbeat（定期喚醒）
daemon 會定期用 heartbeat prompt 喚醒你巡檢。**沒事要回報就回 `HEARTBEAT_OK`**（開頭精確這字串），會被靜音、不轉發到任何平台。要通知特定對象用 `[notify:]`（有 notify 就不廣播）。

### Cron 排程任務
建排程：寫 markdown 到 `.claude/claudeclaw/jobs/<name>.md`（schema 見系統提示「Scheduled jobs」段）。管理用 `/claudeclaw:jobs`。詳見 commands/jobs.md。
job 輸出可用 `[notify:]` 定向發送（例：定期發訊息到某個群組）；沒用 notify 才走 `channels` 廣播。

---

## 四、Session 模型
- **全域 session**（DM / 一般）vs **每個 thread / 群組獨立 session**（Slack/Discord thread、LINE/TG 群組）。
- prompt 開頭可能帶 **inbox**（你上次發言後這個頻道發生的事，含代你發出的訊息）— 那是「已發生」的背景，**不要重貼或重發**。
- `/claudeclaw:clear` 清空當前 session 重開。

---

## 五、管理指令（多為人操作，你知道存在即可）
- daemon 生命週期：`/claudeclaw:status` `/start` `/stop` `/restart` `/config` `/logs`
- **Hub**（多 agent 儀表板 + reverse proxy）：`/claudeclaw:hub` — 詳見 docs/HUB-GUIDE.md
- **LINE webhook proxy**（多 agent 共用一個 port）：`/claudeclaw:proxy`
- 平台狀態：`/claudeclaw:slack` `/line` `/telegram` `/discord`
- 技能：`/claudeclaw:create-skill`（建）`/install-skill`（裝）

---

## 六、詳細文件（要深入時讀）
都在 `~/.claude/plugins/marketplaces/claudeclaw/` 下：

| 主題 | 文件 |
|------|------|
| agent-bus 跨 agent 通訊 | docs/AGENT-BUS.md |
| 定向通知 [notify:] / 通訊錄（規格） | docs/NOTIFY.md |
| 定向通知 使用者指南（中文） | docs/NOTIFY-GUIDE.md |
| Hub 用法 / 架構 | docs/HUB-GUIDE.md / docs/HUB-INTERNALS.md |
| 多 session（thread） | docs/MULTI_SESSION.md |
| 平台存取控制 / 配對 | docs/Channel_Guide.md |
| LINE 設定 | docs/LINE-GUIDE.md |
| 語音轉錄 | docs/WHISPER-GUIDE.md |
| 對話內指令（/cancel 等） | docs/CHAT-COMMANDS.md |
| 平台輸出 directive | prompts/{slack,line,telegram,discord}/DIRECTIVES.md |

# ClaudeClaw 本機入口（Inbound）

讓同一台電腦上的其他程式把訊息交給 ClaudeClaw agent，並在 HTTP 回應裡拿回 agent 的回覆。供整合者與維運者參考。

> 範例中的 `<Agent>`、`<port>`、`<caller>`、token 皆為占位符，實際值請換成你自己的。

---

## 目錄

1. [這是什麼](#1-這是什麼)
2. [架構](#2-架構)
3. [快速開始](#3-快速開始)
4. [設定](#4-設定)
5. [HTTP 合約](#5-http-合約)
6. [通用來源 `message`](#6-通用來源-message)
7. [安全模型](#7-安全模型)
8. [寫一個新來源](#8-寫一個新來源)
9. [已知限制](#9-已知限制)
10. [附錄：檔案位置](#10-附錄檔案位置)

---

## 1. 這是什麼

ClaudeClaw 的各通道（LINE、Telegram、Slack、Discord）都是 daemon 直接連平台。本機入口反過來：daemon 在 `127.0.0.1` 開一個 HTTP 端點，讓**本機的其他程式**把一則訊息交給 agent，等 agent 處理完，回應裡就是 agent 的回覆。

| 需求 | 用什麼 |
|---|---|
| 使用者在聊天平台跟 agent 對話 | 各平台通道（見 [Channel_Guide.md](Channel_Guide.md)） |
| ClaudeClaw agent 之間互傳訊息 | Agent Bus（見 [AGENT-BUS.md](AGENT-BUS.md)） |
| **本機的其他程式**（腳本、別家 agent、橋接程式）交辦工作給 agent | 本機入口（本文件） |

目前有兩個來源：

| 來源 | 路徑 | 給誰用 |
|---|---|---|
| `message` | `POST /inbound/message` | 任何程式，照固定格式送一則訊息（§6） |
| `agents-gateway` | `POST /inbound/agents-gateway` | Agents Gateway 的 bridge（見 [AGENTS-GATEWAY-GUIDE.md](AGENTS-GATEWAY-GUIDE.md)） |

---

## 2. 架構

```
呼叫端（腳本、其他 agent、bridge…）
  │  POST http://127.0.0.1:<port>/inbound/<來源>
  │  Authorization: Bearer <該呼叫端的 token>
  ▼
通用層  src/inbound/server.ts
  │  驗 token → 查這個呼叫端能不能用這個來源 → 依路徑交給來源
  ▼
來源    src/inbound/<來源>.ts
  │  看懂格式 → 去重 → 決定 session → 組 prompt → 執行 agent → 送出前檢查
  ▼
agent session（runUserMessage）
  │
  ◀── HTTP 回應 {"text": "…"}
```

| 通用層負責 | 來源負責 |
|---|---|
| 只聽 `127.0.0.1`、固定 port、隨設定啟停 | 看懂自己的訊息格式、驗證欄位 |
| 驗 token，找出是哪個呼叫端 | 判斷要不要叫醒 agent |
| 檢查這個呼叫端能不能用這個來源 | 決定 session key |
| 依 `/inbound/<來源>` 分派；不看 body 內容 | 用該來源的 id 去重、合併同一則的重複請求 |
| body 上限、JSON 格式、不讓長請求逾時 | 組 prompt、執行 agent |
| 呼叫端斷線時通知來源（`signal`） | 送出前檢查（§7）、把結果整理成呼叫端要的格式 |
| 把來源的結果變成 HTTP 狀態碼＋JSON | 自己的狀態檔 |

要走哪個來源，由呼叫端打的網址決定。通用層不會依內容猜測。

---

## 3. 快速開始

以 `message` 來源為例，在 agent 目錄（`<Agent>`）裡：

**1. 為呼叫端產生 token**（每個呼叫端一個檔，名稱即呼叫端名）

```bash
mkdir -p _claude/.auth/inbound && chmod 700 _claude/.auth/inbound
( umask 077; printf '%s' "$(openssl rand -hex 32)" > _claude/.auth/inbound/<caller>.token )
```

`_claude/.auth/` 必須在 `.gitignore` 裡。

**2. 開啟入口**（`.claude/claudeclaw/settings.json`）

```json
"inbound": {
  "enabled": true,
  "port": 4710,
  "callers": {
    "<caller>": { "sources": ["message"] }
  }
}
```

約 30 秒內熱重載生效，daemon log 會出現：

```
[inbound] listening on http://127.0.0.1:4710/inbound/<source> (callers: <caller>→message)
```

**3. 試打**

```bash
curl -s http://127.0.0.1:4710/inbound/health
# {"ok":true,"sources":["agents-gateway","message"]}

curl -s http://127.0.0.1:4710/inbound/message \
  -H "Authorization: Bearer $(cat _claude/.auth/inbound/<caller>.token)" \
  -H 'content-type: application/json' \
  -d '{"id":"hello-1","conversation":{"id":"demo"},"text":"你好，請自我介紹一句"}'
# {"id":"hello-1","text":"…agent 的回覆…"}
```

> 在 agent 自己的 Claude 對話裡不要這樣做：token 不該出現在 agent 的指令列或輸出裡。

---

## 4. 設定

`settings.json` 的 `inbound` 區塊：

| 欄位 | 預設 | 說明 |
|---|---|---|
| `enabled` | `false` | 開關入口 |
| `port` | `4710` | **每個 agent 不同**。被占用就報錯、不自動換號——呼叫端是照這個 port 設定的 |
| `callers.<name>` | — | 一個呼叫端。token 放在 `_claude/.auth/inbound/<name>.token`；名稱限小寫英數與 `-`，最多 32 字 |
| `callers.<name>.sources` | 全部 | 這個呼叫端能用的來源。建議一律寫明 |
| `message.enabled` | `true` | 關掉就只關 `message` 來源 |
| `message.session` | `"conversation"` | 見 §6.3 |
| `agentsGateway.*` | — | 見 [AGENTS-GATEWAY-GUIDE.md §3](AGENTS-GATEWAY-GUIDE.md#3-設定-claudeclaw) |

**相容舊設定：** `_claude/agent.env` 若 export `CLAUDECLAW_INBOUND_TOKEN`，它算一個名為 `default`、可用所有來源的呼叫端。新設定請改用 `callers`。

**什麼時候生效：**

| 改了什麼 | 生效方式 |
|---|---|
| `enabled`、`port`、`callers`（增刪呼叫端、改 `sources`） | 熱重載重啟入口（約 30 秒） |
| `message.*`、`agentsGateway.*` | 熱重載，下一則訊息起 |
| token 檔內容（換 token） | 改一下 `callers` 或重啟 daemon。**同時要更新呼叫端**，否則它會收到 401 |
| 來源的 DIRECTIVES 檔 | 重啟 daemon（有記憶體快取） |

---

## 5. HTTP 合約

### 5.1 端點

| 方法 | 路徑 | 驗證 | 說明 |
|---|---|---|---|
| `GET` | `/inbound/health` | 不需要 | `{"ok":true,"sources":[…]}`，只列出目前開著的來源 |
| `POST` | `/inbound/<來源>` | 需要 | body 為該來源定義的 JSON |

只接受 `127.0.0.1`。

### 5.2 驗證

兩種 header 擇一，值是呼叫端的 token：

```
Authorization: Bearer <token>
X-Bridge-Token: <token>
```

token 最短 16 字，太短的不會被載入。

### 5.3 回應與狀態碼

| 狀態 | `error` | 意思 | 呼叫端該做什麼 |
|---|---|---|---|
| 200 | — | 處理完成；回覆在 body（各來源格式見各自說明） | — |
| 400 | `bad_json`／`invalid_request`／`not_a_delivery` | 格式錯；`detail` 說明哪裡錯 | 修正後再送，不要原樣重試 |
| 401 | `unauthorized` | 沒帶 token 或 token 錯 | 檢查 token；不要重試 |
| 403 | `source_not_allowed` | 這個呼叫端不能用這個來源 | 檢查 `callers.<name>.sources` |
| 404 | `not_found`／`unknown_source` | 路徑錯、來源不存在或已關閉 | 檢查網址與設定 |
| 405 | `method_not_allowed` | 不是 POST | — |
| 413 | `payload_too_large` | body 超過 40 MB | 縮小附件 |
| 500 | `internal_error` | 來源程式出錯 | 可以重試；持續發生請看 daemon log |
| 503 | `agent_failed` | agent 這次執行失敗 | 稍後用**同一個 id** 重試 |

### 5.4 長請求與斷線

- 伺服器端**沒有逾時**。agent 一則可能跑好幾分鐘（上限是 agent 的 `sessionTimeoutMs`，預設 15 分鐘），呼叫端自己設等待上限。
- 呼叫端先斷線，agent 不會被中斷，會照樣跑完。各來源會把答案留住，呼叫端用同一個 id 重送就能拿到（§6.4）。
- 同一個 agent 的同一個 session 一次只跑一則，其餘排隊（見 [MULTI_SESSION.md](MULTI_SESSION.md)）。排隊時間也算在呼叫端的等待裡。

---

## 6. 通用來源 `message`

### 6.1 請求

`POST /inbound/message`

```json
{
  "id": "build-2026-10-19-01",
  "conversation": { "id": "ops", "name": "Ops desk" },
  "sender": { "id": "ci", "name": "Build bot" },
  "text": "昨晚的 build 失敗了，請看 log 說明原因。",
  "attachments": [
    { "path": "/abs/path/build.log", "kind": "file" },
    { "name": "screen.png", "kind": "image", "data": "<base64>" }
  ],
  "context": ["08:55 Build bot：開始 nightly build", "09:10 Build bot：build failed"],
  "instructions": "用三點條列回答。"
}
```

| 欄位 | 必填 | 說明 |
|---|---|---|
| `id` | ✓ | 這則訊息的 id，1–128 字 `[A-Za-z0-9_.:-]`。**同一個呼叫端內唯一**；重送時帶同一個 |
| `conversation.id` | ✓ | 呼叫端這邊的對話 id，同規則。同一個 id 共用同一個 session |
| `conversation.name` | | 顯示名，放進 prompt |
| `sender.id`／`sender.name` | | 誰說的，放進 prompt |
| `text` | ✓＊ | 訊息本文，最多 100,000 字。＊有附件時可省 |
| `attachments[]` | | 最多 20 個、每個最多 25 MB。給 `path`（本機絕對路徑），或給 `name`＋`data`（base64）。`kind`：`image`／`file`／`audio`／`video`（預設 `file`） |
| `context[]` | | 前文，每行一個字串；只當背景，agent 不會逐句回覆 |
| `instructions` | | 只對這一則有效的額外指示 |

附件一律先複製（或解碼）到 agent 自己的目錄 `.claude/claudeclaw/inbound/media/`，agent 讀的是那份。原因：agent 在 `moderate` 以上的安全等級只能讀自己目錄底下的檔案。`audio` 會先用 ClaudeClaw 的 Whisper 轉成文字（見 [WHISPER-GUIDE.md](WHISPER-GUIDE.md)）。

### 6.2 回應

```json
{ "id": "build-2026-10-19-01", "text": "…agent 的回覆…" }
```

| 欄位 | 說明 |
|---|---|
| `text` | agent 的回覆。空字串表示 agent 選擇不回（它輸出了 `NO_SEND`） |
| `repeated` | `true`＝同一個 id 之前已回答過，這是第一次的答案，沒有重新執行 |
| `withheld` | `true`＝原回覆被送出前檢查擋下（§7），`text` 換成固定句 |

### 6.3 Session

| `message.session` | session key | 適合 |
|---|---|---|
| `"conversation"`（預設） | `inbound:<caller>:<conversation.id>` | 各對話各自記憶，互不影響；不同對話可同時處理 |
| `"shared"` | `inbound:shared` | 所有呼叫端、所有對話共用一份記憶；一次只處理一則 |

session key 含呼叫端名稱，不同呼叫端就算用同一個 `conversation.id` 也不會碰到彼此。

### 6.4 去重與重試

| 情況 | 行為 |
|---|---|
| 同一個呼叫端＋`id` 已回答過 | 直接回第一次的答案（`repeated: true`），不重跑。紀錄保留 2 天 |
| 同一個 `id` 還在跑時又送來 | 接上同一次執行，兩個請求拿到同一份答案 |
| 呼叫端中途斷線 | agent 照樣跑完、答案留住；重送同一個 `id` 就拿到 |
| agent 執行失敗（503） | 不留紀錄；重送同一個 `id` 會重新執行 |

### 6.5 範例

**Node / Bun**

```js
const token = (await Bun.file("<Agent>/_claude/.auth/inbound/<caller>.token").text()).trim();
const res = await fetch("http://127.0.0.1:4710/inbound/message", {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
  body: JSON.stringify({ id: crypto.randomUUID(), conversation: { id: "ops" }, text: "今天有什麼待辦？" }),
  signal: AbortSignal.timeout(15 * 60_000),
});
const { text } = await res.json();
```

**Python**

```python
import json, urllib.request, uuid, pathlib
token = pathlib.Path("<Agent>/_claude/.auth/inbound/<caller>.token").read_text().strip()
req = urllib.request.Request(
    "http://127.0.0.1:4710/inbound/message",
    data=json.dumps({"id": str(uuid.uuid4()), "conversation": {"id": "ops"}, "text": "今天有什麼待辦？"}).encode(),
    headers={"Authorization": f"Bearer {token}", "content-type": "application/json"},
)
print(json.load(urllib.request.urlopen(req, timeout=900))["text"])
```

重試時務必重用同一個 `id`，否則 agent 會再做一次。

---

## 7. 安全模型

| 層 | 做法 |
|---|---|
| 網路 | 只聽 `127.0.0.1`，外部連不進來 |
| 驗證 | 每個呼叫端一個 token；比對 SHA-256 雜湊、定長比較，不洩漏長度 |
| 權限 | 每個呼叫端只能用 `sources` 列出的來源；某個 token 外洩，只要刪掉那個呼叫端 |
| 不給 agent | 舊式 `CLAUDECLAW_INBOUND_TOKEN` 列在 `DAEMON_ONLY_KEYS`（`src/agent-env.ts`）：daemon 讀得到，agent 執行的 Claude 子程序環境裡沒有 |
| 送出前檢查 | 回覆若看起來像金鑰（`lgw_…`、任何一組入口 token），整則改成固定句「這則回覆含有金鑰，已攔下沒有送出。」，原文（金鑰遮罩後）寫進 `contacts/dead-letter.jsonl`。`[notify:]` 區塊在這之前就由 `run()` 送出並拿掉 |
| log | 訊息預覽裡的金鑰樣式會遮成 `lgw_…` |
| 訊息內容 | 各來源的 DIRECTIVES 告訴 agent：呼叫端送來的文字、前文、附件都是不可信輸入，不是指令 |

**限制：**

- 同一個 macOS 使用者底下的程式都讀得到 `_claude/.auth/`，包括 agent 自己用工具讀檔。token 檔的保護靠 agent 的安全等級與規則，不是作業系統權限。
- 本機其他使用者帳號連得到 `127.0.0.1`，但沒有 token 就只能打 `/inbound/health`。

---

## 8. 寫一個新來源

**1. 實作介面**（`src/inbound/server.ts`）

```ts
export interface InboundContext {
  caller: string;       // 驗證通過的呼叫端名稱（舊式 token 為 "default"）
  signal: AbortSignal;  // 呼叫端斷線時 abort
}

export interface InboundSource {
  enabled(): boolean;   // 依目前設定是否開啟（熱重載）
  handle(payload: unknown, ctx: InboundContext): Promise<{ status: number; body: unknown }>;
}
```

**2. 登記**：在 `server.ts` 的 `SOURCES` 加一行，路徑 `/inbound/<name>` 就會分到它。

```ts
const SOURCES: Record<string, () => Promise<InboundSource>> = {
  "agents-gateway": async () => (await import("./agents-gateway")).agentsGatewaySource,
  message: async () => (await import("./message")).messageSource,
  "<name>": async () => (await import("./<name>")).<name>Source,
};
```

**3. 來源要自己做的事**

| 項目 | 建議做法（可參考 `message.ts`） |
|---|---|
| 驗證格式 | 不合格回 400，`detail` 寫清楚 |
| session key | 用固定前綴＋呼叫端＋對話 id，例：`<name>:<caller>:<id>`，不要跟其他來源撞名 |
| 去重 | 以「呼叫端＋訊息 id」為鍵，記在 `.claude/claudeclaw/inbound/<name>.json` |
| 重複請求 | 用一個 `Map<key, Promise>` 合併同一則的並行請求 |
| 組 prompt | 第一行標明來源與對話；DIRECTIVES 只在 session 第一次（或被替換、壓縮後）帶；使用者文字用 `--- … ---` 包起來並避免偽造邊界 |
| 執行 | `runUserMessage("<name>", prompt, threadId)`；`exitCode !== 0` 回 503 |
| 送出前檢查 | `screenReply()`（`src/inbound/screen.ts`）；log 裡的使用者文字先過 `maskSecrets()` |
| 附件 | 先複製到 agent 目錄底下再交給 agent |

**4. 開放給呼叫端**：在該 agent 的 `callers.<name>.sources` 加上新來源名稱。

---

## 9. 已知限制

- **只有一問一答。** agent 不能主動回推給呼叫端；要長時間工作的結果，呼叫端要等著，或 agent 改用其他通道（例如 `[notify:]`）。
- **沒有速率限制。** 呼叫端要自己控制頻率；同一個 session 會排隊。
- **呼叫端名稱就是 token 檔名。** 換名稱等於換 token。
- **health 不需驗證。** 本機任何程式都能知道入口開著、有哪些來源。

---

## 10. 附錄：檔案位置

| 檔案 | 位置 | 用途 |
|---|---|---|
| 入口設定 | `<Agent>/.claude/claudeclaw/settings.json` 的 `inbound` | port、呼叫端、各來源選項 |
| 呼叫端 token | `<Agent>/_claude/.auth/inbound/<caller>.token` | 每個呼叫端一個（600） |
| 舊式 token | `<Agent>/_claude/agent.env` 的 `CLAUDECLAW_INBOUND_TOKEN` | 相容用 |
| `message` 狀態 | `<Agent>/.claude/claudeclaw/inbound/message.json` | 已回答的 id、session 紀錄 |
| 附件副本 | `<Agent>/.claude/claudeclaw/inbound/media/` | 交給 agent 讀的檔案 |
| Sessions | `<Agent>/.claude/claudeclaw/sessions.json` | `inbound:…` 等 session |
| 被擋下的回覆 | `~/.claude/claudeclaw/contacts/dead-letter.jsonl` | 送出前檢查的紀錄 |
| 通用層 | `<claudeclaw>/src/inbound/server.ts` | |
| `message` 來源 | `<claudeclaw>/src/inbound/message.ts` | |
| 送出前檢查 | `<claudeclaw>/src/inbound/screen.ts` | |
| `message` DIRECTIVES | `<claudeclaw>/prompts/inbound/MESSAGE.md` | 注入給 agent 的規則 |

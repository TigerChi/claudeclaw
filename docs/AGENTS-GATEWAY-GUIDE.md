# ClaudeClaw × Agents Gateway 使用指南

透過 [Agents Gateway](https://agents-gateway.cloud) 讓 ClaudeClaw agent 接上 LINE 群組與私訊：架構、設定、bridge 安裝、各功能運作方式。供 Agent 與維運者參考。

> 範例中的 `<Agent>`、`<agent>`、`<port>`、`<chatId>`、群組 ID 皆為占位符，實際值請換成你自己的。

---

## 目錄

1. [架構](#1-架構)
2. [前置準備](#2-前置準備)
3. [設定 ClaudeClaw](#3-設定-claudeclaw)
4. [安裝 bridge](#4-安裝-bridge)
5. [Session 模式](#5-session-模式)
6. [訊息處理](#6-訊息處理)
7. [可靠性](#7-可靠性)
8. [安全性](#8-安全性)
9. [用 MCP 讀 LINE 紀錄](#9-用-mcp-讀-line-紀錄)
10. [從 LINE 原生通道搬過來](#10-從-line-原生通道搬過來)
11. [已知限制](#11-已知限制)
12. [疑難排解](#12-疑難排解)
13. [附錄：檔案位置](#13-附錄檔案位置)

---

## 1. 架構

```
LINE 使用者
  ⇅
LINE Platform ──webhook──▶ Agents Gateway（雲端：收訊、紀錄、派發、回覆）
                               ⇅  長輪詢（只往外連）
                           bridge（本機常駐，--adapter http）
                               │  POST 送達包
                               ▼
              ClaudeClaw 本機入口 127.0.0.1:<port>/inbound/agents-gateway
                               │
                               ▼
                    agent session（每個群組一個，或共用）
                               │
                     {"text": "回覆"} ──▶ bridge ──▶ Gateway ──▶ LINE
```

| 元件 | 負責 | 文件 |
|---|---|---|
| Agents Gateway | 管 LINE bot、記錄所有訊息、決定哪則送給哪個 agent（點名、旁聽、白名單、群組 Prompt）、用 reply token 或 push 送回 LINE | [安裝說明](https://agents-gateway.cloud/install.md) |
| bridge | 向 Gateway 長輪詢、ack、失敗重試、清積壓、持有 Gateway Agent 金鑰；把每則送達 POST 給 ClaudeClaw | 同上 §3.2 |
| ClaudeClaw 本機入口 | 只聽本機、驗 token、分派給來源 | [INBOUND.md](INBOUND.md) |
| `agents-gateway` 來源 | 看懂送達包、決定 session、組 prompt、執行 agent、去重、送出前檢查 | 本文件 |

**跟 LINE 原生通道（[LINE-GUIDE.md](LINE-GUIDE.md)）的差別：**

| 項目 | LINE 原生通道 | Agents Gateway |
|---|---|---|
| 對外連線 | 要公開 HTTPS webhook（ngrok／proxy） | 只往外連，不開 port、不需 tunnel |
| LINE 金鑰 | channel token／secret 放在 ClaudeClaw | 放在 Gateway；ClaudeClaw 不碰 |
| 誰能叫醒 agent | `allowedUserIds`、pairing、`requireMention` | Gateway 的回覆模式、白名單、點名規則 |
| 群組行為規則 | `speechPolicy`、`extraPrompt` | Gateway 的群組 Prompt |
| 聊天紀錄 | ClaudeClaw `chatlog/` | Gateway 保存全部；ClaudeClaw `chatlog/` 只記送來的那些 |
| 多個 agent 共用一隻 bot | 不支援 | 支援（點名、關鍵字、旁聽） |

---

## 2. 前置準備

1. **Gateway 上已有 bot 與聊天室**：照 [Agents Gateway 安裝說明](https://agents-gateway.cloud/install.md) §1～§2 建好 workspace、登記 LINE bot、把 bot 加進群組。
2. **連接連結**：在 Gateway 為這個 agent 產生一次性連接連結（安裝說明 §3.2 第 1 步，`platform` 填 `claudeclaw`）。這個連結等同金鑰，不要貼到公開地方。
3. **Node.js ≥ 20.19 或 Bun**（bridge 用）。
4. **為每個 agent 選一個固定 port**（例：4710、4711…），不能跟其他 agent 或服務重複。

---

## 3. 設定 ClaudeClaw

在 agent 目錄（`<Agent>`）裡。

### 3.1 bridge 用的 token

```bash
mkdir -p _claude/.auth/inbound && chmod 700 _claude/.auth/inbound
( umask 077; printf '%s' "$(openssl rand -hex 32)" > _claude/.auth/inbound/bridge.token )
```

### 3.2 settings.json

```json
"inbound": {
  "enabled": true,
  "port": 4710,
  "callers": {
    "bridge": { "sources": ["agents-gateway"] }
  },
  "agentsGateway": {
    "session": "chat",
    "chats": { "<chatId>": { "session": "shared" } },
    "systemEvents": "ack",
    "listen": "log",
    "chatLog": { "enabled": false }
  }
}
```

| 欄位 | 預設 | 說明 |
|---|---|---|
| `callers.bridge.sources` | — | 建議只開 `agents-gateway`，bridge 的 token 就不能拿來打其他來源 |
| `agentsGateway.enabled` | `true` | 關掉就只關這個來源 |
| `agentsGateway.session` | `"chat"` | 見 §5 |
| `agentsGateway.chats.<chatId>.session` | — | 個別聊天室覆寫；`<chatId>` 是 Gateway 的聊天室 id |
| `agentsGateway.systemEvents` | `"ack"` | 系統事件（Bot 進退群、成員進出…）：`"ack"` 只記錄、不叫醒 agent；`"agent"` 交給 agent |
| `agentsGateway.listen` | `"log"` | 不能回話的送達（`reason=listen`、聊天室 `reply=false`）：`"log"` 記錄，下次被叫醒時當前文；`"agent"` 照樣叫醒（agent 不能在那裡說話） |
| `agentsGateway.chatLog.enabled` | `false` | 在本機 `chatlog/` 留副本（§6.5）。預設關：Gateway 已保存完整紀錄 |

port、callers 等入口共通欄位見 [INBOUND.md §4](INBOUND.md#4-設定)。存檔後約 30 秒熱重載，daemon log 會出現：

```
[inbound] listening on http://127.0.0.1:4710/inbound/<source> (callers: bridge→agents-gateway)
```

---

## 4. 安裝 bridge

### 4.1 安裝與連接

```bash
cd <Agent>
export LINE_GATEWAY_HOME="$PWD/_claude/.auth/agents-gateway/bridge"   # bridge 的設定與金鑰跟 agent 放在一起
mkdir -p "$LINE_GATEWAY_HOME" && chmod 700 "$LINE_GATEWAY_HOME"

curl -fsSL https://agents-gateway.cloud/bridge/install.sh | sh -s -- <連接連結> \
  --adapter http \
  --target http://127.0.0.1:<port>/inbound/agents-gateway \
  --token "$(cat _claude/.auth/inbound/bridge.token)" \
  --name <agent>
```

成功時印出 `connected as <agent> (…) to https://agents-gateway.cloud [workspace …, adapter http, bridge name <agent>]`，並裝好登入時自動啟動的服務（macOS 為 `~/Library/LaunchAgents/tw.chifa.line-gateway-bridge.<agent>.plist`，服務會帶著 `LINE_GATEWAY_HOME`）。

- 不設 `LINE_GATEWAY_HOME` 也可以，bridge 預設放在 `~/.line-gateway/profiles/<agent>/`。
- 之後所有 bridge 指令都要帶**同一個** `LINE_GATEWAY_HOME`，否則找不到這個名稱。

### 4.2 建議設定

```bash
bridge() { node "$HOME/line-gateway-bridge/line-gateway-bridge.js" "$@"; }   # 本文其餘指令都用這個函式

bridge stop --name <agent>
bridge config set adapterTimeoutSec 960 --name <agent>   # 要大於 agent 一則最長的處理時間（sessionTimeoutMs 預設 15 分）
bridge config set systemEvents ack --name <agent>         # 系統事件由 bridge 直接 ack，不送進 ClaudeClaw
bridge start --name <agent>
```

（每次開新的終端機，都要先 `export LINE_GATEWAY_HOME=…`（§4.1）並定義 `bridge`。）

> ⚠️ **一定要先 `stop` 再 `config set`。** bridge 0.5.0 執行中每 60 秒會把記憶體裡的設定寫回 `config.json`，服務在跑時改的值會被蓋掉。

| 設定 | 預設 | 建議 | 說明 |
|---|---|---|---|
| `adapterTimeoutSec` | 120 | 960 | bridge 等 ClaudeClaw 回應的上限；超過算失敗、重試。`session: "shared"` 時要算進排隊時間 |
| `systemEvents` | `deliver` | `ack` | 或在 ClaudeClaw 端用 `agentsGateway.systemEvents` 處理 |
| `ackAfterSec`／`ackMessage` | 20／「收到，處理中」 | 依需求 | 超過幾秒還沒回就先用 reply token 送這句，正式回覆改用 push；`config set ackMessage off` 可關 |

### 4.3 驗證

```bash
curl -s http://127.0.0.1:<port>/inbound/health    # {"ok":true,"sources":[…"agents-gateway"…]}
bridge status --name <agent>                       # online、版本、最近一筆送達
bridge test --name <agent>                         # Gateway 建一筆測試送達，走完整條路（不送到 LINE）
```

`test` 有時會印 `test delivery was not returned by wait (another bridge instance may have taken it)`：表示背景服務先拿走了，看 `bridge logs --name <agent>` 是否有 `"replied" … "via":"test"` 即可。

最後在群組裡 @bot 說一句話，確認會回。

---

## 5. Session 模式

| `session` | session key | 適合 |
|---|---|---|
| `"chat"`（預設） | `line:group:<groupId>`、`line:room:<roomId>`、`line:dm:<userId>` | 各群組／私訊各自記憶，互不影響；不同群組可同時處理 |
| `"shared"` | `agw:shared` | 這個 agent 的所有群組共用一份記憶，能跨群引用；一次只處理一則 |

- `"chat"` 的 key 跟 LINE 原生通道**完全相同**（`lineSessionId()`），從原生通道搬過來時，各群組的對話記憶直接延續（§10）。送達包沒有 LINE id 時改用 `agw:<chatId>`。
- `"shared"` 不是 agent 的主 session（heartbeat、cron 用的那個），不會跟排程混在一起。
- 共用模式下，每則訊息開頭標明來自哪個聊天室，回覆只會送回那個聊天室；各聊天室的 Gateway Prompt 只套用在自己的訊息。
- 可以用 `chats.<chatId>.session` 只讓某幾個群共用，其餘各自獨立。

---

## 6. 訊息處理

### 6.1 分流

| 送達 | 處理 | 回給 bridge |
|---|---|---|
| Agent 事件（`chat: null`，例：bridge 版本通知） | 只記 log | 空字串 |
| 系統事件（`reason=system`）且 `systemEvents: "ack"` | 記進 chatlog，不叫醒 agent | 空字串 |
| 不能回話（`reason=listen` 或 `reply=false`）且 `listen: "log"` | 記進 chatlog，暫存為前文 | 空字串 |
| `/cancel` | 取消這個 session 正在跑的回覆 | 確認句 |
| 其他（被點名、私訊、關鍵字、按鈕…） | 叫醒 agent | agent 的回覆 |

bridge 收到空字串只 ack，不送任何訊息到 LINE。

### 6.2 Prompt 組成

叫醒 agent 時，prompt 依序包含：

1. **標頭**：`[Agents Gateway · LINE group「<群組名>」 chat=<chatId> · from <發言者>（<角色>） <userId> · reason=<原因>]`
2. **指示區塊**（只在需要時）：`prompts/agents-gateway/DIRECTIVES.md`，加上這個聊天室的 Gateway 指示（bot 名、agent 在群裡的顯示名、群組說明、Gateway 疊好的 Prompt）。session 第一次、內容有變、session 被換掉或壓縮後才重帶，不是每則都帶。
3. **前文**：上次叫醒之後、這則之前的訊息（旁聽暫存的＋送達包 `context.recent` 裡較新的），已經給過的不重複。實際訊息數多於列出的會註明，並指出 chatlog 位置。
4. **引用**：被引用的那則。
5. **本文**：去掉 @bot 之後的文字；只 @ 沒說話時會提示 agent 看前文。按鈕回傳為 `Button action data`；系統事件為事件描述。
6. **附件**：圖片與檔案下載到本機後給路徑；語音給轉文字（§6.3）。
7. **狀態註記**：測試送達、這個聊天室不能說話時會註明。

### 6.3 附件與語音

- 送達包的 `media.url` 是 Gateway 的簽章網址，ClaudeClaw 直接下載到 `.claude/claudeclaw/inbound/media/`（上限 25 MB），agent 讀本機檔。
- 附件存在使用者自己的雲端（例如 Google Drive，送達包沒有 `url`）時，ClaudeClaw 拿不到檔案，只會告訴 agent 有附件。
- 語音：優先用 Gateway 的轉文字（`transcript.status=done`）；沒有就下載音檔，用 ClaudeClaw 的 Whisper 轉（[WHISPER-GUIDE.md](WHISPER-GUIDE.md)）。

### 6.4 回覆

- agent 的整段輸出就是回覆，以純文字送到 LINE（超過 5000 字由 Gateway 切段）。
- 輸出 `NO_SEND` → 不回。
- 回覆送出前會先檢查（§8）。
- reply token 還有效就用 reply，否則 Gateway 改 push；官方 Bot 逾時後進延遲回覆佇列。這些都由 Gateway 處理，ClaudeClaw 只回文字。

### 6.5 chatlog

預設不寫。完整紀錄在 Gateway，用 MCP 讀（§9）。本機副本等於把每個群的內容放在 agent 自己讀得到的地方，跨群隔離（§8）就多一個破口，所以預設關。

開了 `chatLog.enabled` 時，送到 ClaudeClaw 的訊息與 agent 的回覆寫進 `.claude/claudeclaw/chatlog/<群組名>__agw-<chatId>/`（格式同 [LINE-GUIDE.md §7.7](LINE-GUIDE.md)）。Gateway 沒送來的訊息（例如沒點名、也沒設旁聽的）不在這裡。

---

## 7. 可靠性

同一則送達可能送到 ClaudeClaw 不只一次：bridge 逾時或連線失敗會重試，Gateway 在 5 分鐘 lease 到期後也會重送。`agents-gateway` 來源用 `.claude/claudeclaw/inbound/agents-gateway.json` 記住每則送達的狀態：

| 情況 | 行為 |
|---|---|
| 已回答過的 deliveryId 又送來 | 回空字串，bridge 只 ack，不會回第二次 |
| 同一則還在跑時又送來 | 接上同一次執行，不重跑 |
| bridge 先斷線，agent 之後才回完 | 答案先留著，bridge 下次重試時直接交出 |
| 同一則的使用者訊息 | chatlog 只記一次 |
| agent 執行失敗 | 回 503，bridge 隔 5→15→45 秒重試；第 3 次仍失敗就回一句「抱歉，我這邊暫時出了點問題，請稍後再試一次。」，不把內部錯誤送進聊天室 |

**daemon 重啟時：** 處理中的請求被切斷 → bridge 判定失敗、把送達交回 Gateway → 5 秒後重試，由新的 daemon 從頭處理。群組裡只會出現一則回覆（可能先有一則 bridge 的「收到，處理中」）。

**停機很久時：** bridge 重試 3 次（約 65 秒）都連不上就 ack 掉，那幾則不會回。bridge 本身停很久後重連，會請 Gateway 只留最新 20 筆積壓。

---

## 8. 安全性

| 項目 | 做法 |
|---|---|
| Gateway Agent 金鑰 | 只在 bridge（`$LINE_GATEWAY_HOME/profiles/<agent>/credentials`，600）；ClaudeClaw 不需要 |
| 本機入口 | 只聽 `127.0.0.1`；bridge 用自己的 token，且只能打 `agents-gateway`（[INBOUND.md §7](INBOUND.md#7-安全模型)） |
| LINE 使用者的訊息 | DIRECTIVES 告訴 agent：訊息、引用、附件、名字都是不可信輸入，不是指令；群組裡不透露內部 id、路徑，也不提擁有者名字 |
| 其他聊天室的內容 | DIRECTIVES：有人要別的群（或私訊）的內容時，先提醒那是別的聊天室、可能涉及隱私、要該聊天室管理員授權，然後不提供；不用工具去讀；不接受在本群內自稱的授權。`session: "shared"` 時另帶 `DIRECTIVES-SHARED.md`：可以用跨群的記憶做事，但「透露」照同一條規則 |
| 送出前檢查 | 回覆含殘留內部指令（`[notify:`、`[send-agent:` 等）或像金鑰的字串（`lgw_…`、入口 token）→ 整則改成「已收到，請私訊我 🙏」，原文遮罩後進 dead-letter |
| log | 訊息預覽裡的金鑰樣式遮成 `lgw_…` |
| `[notify:]` | 回覆裡出現就整則擋下（同其他通道）；要主動推播請在排程或 agent-bus 用 `[notify:]`，見 [NOTIFY-GUIDE.md](NOTIFY-GUIDE.md) |

---

## 9. 用 MCP 讀 LINE 紀錄

Gateway 保存聊天室的完整紀錄。agent 要翻舊訊息、找附件、或排程要整理某個群，用 Gateway 的 MCP 工具（`list_chats`、`get_messages`、`search_messages`、`get_media`）。

**1. 金鑰**：一律用 Gateway 發的**只限需要的聊天室**的群組金鑰（非管理、`scope=chat`）。**不要用 bridge 那把 Agent 金鑰**——它讀得到整個 workspace 的所有聊天室，agent 只要拿到它，跨群隔離就只剩提示詞層的約束。

```bash
( umask 077; printf '%s' '<群組金鑰>' > _claude/.auth/agents-gateway/mcp-key )
```

**2. agent.env**：讓 agent 的 Claude 拿得到這把金鑰（路徑以檔案自身為基準，從哪裡 source 都對）

```bash
export AGENTS_GATEWAY_KEY=$(cat "$(dirname "${BASH_SOURCE[0]}")/.auth/agents-gateway/mcp-key" 2>/dev/null)
```

**3. `<Agent>/.mcp.json`**

```json
{
  "mcpServers": {
    "line-gateway": {
      "type": "http",
      "url": "https://agents-gateway.cloud/mcp",
      "headers": { "Authorization": "Bearer ${AGENTS_GATEWAY_KEY}" }
    }
  }
}
```

**4. `<Agent>/.claude/settings.json`**：允許載入這個專案 MCP（daemon 以非互動模式執行，不會跳出確認）

```json
"enabledMcpjsonServers": ["line-gateway"]
```

**5. 告訴 agent 怎麼用**（寫進 agent 的 `CLAUDE.md`）：紀錄在 Gateway、用哪些工具讀；**MCP 只拿來讀**，發言照舊用回覆或 `[notify:]`，不要用 `send_message`，也不要用它改設定。

下一次執行就生效，不用重啟 daemon。驗證：叫 agent「用 line-gateway MCP 讀 `<群組名>` 最近 5 則」。

---

## 10. 從 LINE 原生通道搬過來

已經用 LINE 原生通道（[LINE-GUIDE.md](LINE-GUIDE.md)）的 agent，可以沿用**同一隻 LINE bot**，群友看不出差別。

**順序很重要：** Gateway 一登記這隻 bot，就會自動把 LINE webhook 改指 Gateway（Gateway 為 https 時），從那一刻起原生通道收不到訊息。所以 ClaudeClaw 端要先準備好。

1. 記下 bot 目前的 webhook 網址（回退用）。
2. 設定本機入口與 bridge token（§3），用 Gateway 為這個 agent 產生的連接連結裝 bridge（§4）。
3. daemon 若是在更新 ClaudeClaw 之前啟動的，先重啟載入新程式（用 hub 依 agent id 重啟，見 [HUB-GUIDE.md](HUB-GUIDE.md)）。
4. 在 Gateway 登記這隻 bot、把聊天室交給這個 agent，並設定原本在 ClaudeClaw 做的規則：

| 原生通道設定 | 改在 Gateway 設 |
|---|---|
| `allowedUserIds`、`pairing` | 白名單／名冊、回覆模式 |
| `requireMention`、`groups[].requireMention` | 回覆模式（點名才回） |
| `groups[].allowUnauthorized` | 該群的回覆模式（不限白名單） |
| `passiveListen`、`chatLog` | 旁聽設定；紀錄由 Gateway 保存 |
| `speechPolicy`、`extraPrompt` | 該群的 Prompt |

5. 在各群組與私訊 @bot 驗證。

**會延續的：** 各群組／私訊的對話記憶（session key 相同，§5）。

**不會延續的：** 本機 `chatlog/`。agents-gateway 預設不寫 chatlog（§6.5），舊資料夾停在切換當下；讀舊 chatlog 的排程要改用 MCP 讀 Gateway（§9）。

**保留原生設定：** `line` 區塊不要刪。webhook 已不指向 ClaudeClaw，原生通道不會再收到訊息，但：

- 排程用的 `[notify:line:<id>]` 推播仍走原生 token，照常可用（這些推播不會出現在 Gateway 紀錄裡）。
- 回退時只要把 webhook 改回第 1 步記下的網址。

---

## 11. 已知限制

- **處理超過 90 秒會有離線通知。** bridge 等 ClaudeClaw 回應期間不呼叫 wait，Gateway 會把 agent 標離線、通知 Owner，回完後再發「已恢復」。功能不受影響。
- **長任務會讓其他群組排隊。** bridge 處理完這一批才拉下一批；一個群跑 3 分鐘，這段時間其他群的新訊息要等。
- **daemon 停機超過約 1 分鐘會漏訊息。** 見 §7。
- **存在使用者雲端的附件拿不到。** 見 §6.3。
- **bridge 0.5.0 執行中的 `config set` 會被蓋回去。** 見 §4.2。
- **一問一答。** agent 不能在回完之後再主動補一則到同一個聊天室；需要時用 `[notify:]`。

---

## 12. 疑難排解

### 群組裡 @ 了沒反應

逐段查：

1. Gateway 有沒有把這則送給這個 agent：聊天室的預設 agent、點名規則（Gateway 主控台或 `GET /v1/chats/<chatId>`）。
2. bridge 在線嗎：`bridge status --name <agent>` 看 `online`、`last delivery`。
3. bridge 有沒有打到 ClaudeClaw：`bridge logs --name <agent>`，找 `adapter failed`（看 HTTP 狀態，見下）。
4. ClaudeClaw 有沒有處理：`grep "\[agw\]" <Agent>/.claude/claudeclaw/logs/daemon.log | tail`。看到 `no reply (NO_SEND)` 表示 agent 決定不回。

### bridge log：`http adapter: 401`

bridge 帶的 token 跟 `_claude/.auth/inbound/bridge.token` 不一致。照 §4.2 的方式**先 stop** 再改（`config set bridgeToken` 或改 `$LINE_GATEWAY_HOME/profiles/<agent>/config.json` 的 `bridgeToken`），再 start。401 對 bridge 是永久失敗，期間的送達會被 ack 掉。

### bridge log：`http adapter: 403`

`callers.bridge.sources` 沒有 `agents-gateway`。

### bridge log：`fetch failed`／連不上

daemon 沒在跑，或入口沒開：`curl -s http://127.0.0.1:<port>/inbound/health`。

### daemon log：`Inbound: enabled but no caller token`

`_claude/.auth/inbound/<caller>.token` 不存在或少於 16 字。補好後改一下 `callers` 讓它熱重載，或重啟 daemon。

### daemon log：`cannot listen on 127.0.0.1:<port>`

port 被占用。換一個沒人用的 port，**同時**更新 bridge 的 `target`（先 stop）。

### agent.env 讀到空值

agent.env 由 hub 啟動 daemon 時執行，工作目錄不一定是 agent 目錄。路徑請用 `$(dirname "${BASH_SOURCE[0]}")/…` 這種以檔案自身為基準的寫法。

---

## 13. 附錄：檔案位置

| 檔案 | 位置 | 用途 |
|---|---|---|
| Agent 設定 | `<Agent>/.claude/claudeclaw/settings.json` 的 `inbound` | port、呼叫端、`agentsGateway` 選項 |
| bridge token | `<Agent>/_claude/.auth/inbound/bridge.token` | bridge 打入口用（600） |
| bridge 設定與金鑰 | `$LINE_GATEWAY_HOME/profiles/<agent>/`（建議 `<Agent>/_claude/.auth/agents-gateway/bridge/`） | `config.json`、`credentials`、`bridge.log` |
| bridge 程式 | `~/line-gateway-bridge/line-gateway-bridge.js` | 同一台電腦的所有 agent 共用 |
| bridge 服務 | `~/Library/LaunchAgents/tw.chifa.line-gateway-bridge.<agent>.plist` | 登入時自動啟動 |
| 送達狀態 | `<Agent>/.claude/claudeclaw/inbound/agents-gateway.json` | 去重、前文進度、指示區塊紀錄 |
| 下載的附件 | `<Agent>/.claude/claudeclaw/inbound/media/` | |
| 對話記錄（預設關） | `<Agent>/.claude/claudeclaw/chatlog/<群組名>__agw-<chatId>/` | §6.5 |
| Sessions | `<Agent>/.claude/claudeclaw/sessions.json` | `line:…`、`agw:shared` |
| MCP 設定 | `<Agent>/.mcp.json`、`<Agent>/.claude/settings.json` | §9 |
| MCP 金鑰 | `<Agent>/_claude/.auth/agents-gateway/mcp-key` | §9 |
| 來源程式 | `<claudeclaw>/src/inbound/agents-gateway.ts` | |
| DIRECTIVES | `<claudeclaw>/prompts/agents-gateway/DIRECTIVES.md`、`DIRECTIVES-SHARED.md` | 注入給 agent 的規則；內容一改，各 session 下一輪就會重帶（daemon 要重啟才讀到新檔） |

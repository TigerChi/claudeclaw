# ClaudeClaw LINE Bot 完整使用指南

本文件說明 ClaudeClaw 的 LINE Messaging API 整合如何運作、如何設定、以及各項功能的使用方式。
供 Agent 和使用者參考。

---

## 目錄

1. [整體架構](#1-整體架構)
2. [前置準備](#2-前置準備)
3. [設定說明](#3-設定說明)
4. [Webhook Proxy（多 Agent 共用）](#4-webhook-proxy多-agent-共用)
5. [啟動與運作](#5-啟動與運作)
6. [訊息處理](#6-訊息處理)
7. [群組行為與 Mention 政策](#7-群組行為與-mention-政策)
8. [使用者授權與 Pairing 配對](#8-使用者授權與-pairing-配對)
9. [語音訊息處理](#9-語音訊息處理)
9.5. [對話速度與自動壓縮](#95-對話速度與自動壓縮)
10. [安全性層級](#10-安全性層級)
11. [常用操作](#11-常用操作)
12. [疑難排解](#12-疑難排解)

---

## 1. 整體架構

```
LINE 使用者
  │
  ▼
LINE Server
  │
  ▼
ngrok（公開 URL → localhost）
  │
  ▼
LINE Webhook Proxy（:18789，共用，按 path 分流）
  │
  ├─ /line/felix  → Agent Felix daemon (:18801)
  ├─ /line/eleven → Agent Eleven daemon (:18802)
  └─ /line/beo    → Agent Beo daemon (:18803)
                       │
                       ▼
                    Claude Code session
                    （讀寫 Agent 工作目錄的檔案、執行指令）
                       │
                       ▼
                    回覆文字 → LINE API → 使用者看到訊息
```

**每個 Agent 是獨立的 Claude Code session**，有自己的：
- 工作目錄（程式碼、文件）
- CLAUDE.md（人格設定）
- settings.json（LINE token、安全設定等）
- session.json（對話記憶）

**Proxy 是共用的**，負責把不同 path 的 webhook 轉發到對應 Agent 的內部 port。

---

## 2. 前置準備

### 2.1 建立 LINE Messaging API Channel

1. 前往 [LINE Developers Console](https://developers.line.biz)
2. 建立 Provider（如果還沒有）
3. 建立新的 **Messaging API** channel
4. 取得以下資訊：
   - **Channel Access Token**（長效版）：Messaging API → Channel access token → 點「Issue」
   - **Channel Secret**：Basic settings → Channel secret

### 2.2 設定 Webhook URL

在 LINE Developers Console → Messaging API：
- **Webhook URL**: `https://<你的公開 URL>/<webhookPath>`
  例如：`https://xxx.ngrok-free.dev/line/felix`
- **Use webhook**: 開啟
- **Auto-reply messages**: 關閉（不然 LINE 官方自動回覆會干擾 bot）

### 2.3 本機 Tunnel（開發用）

LINE webhook 需要公開的 HTTPS URL。本機開發用 ngrok：

```bash
ngrok http 18789
```

拿到的 URL（如 `https://xxx.ngrok-free.dev`）設到 LINE Developers Console 的 Webhook URL。

---

## 3. 設定說明

設定檔位置：`<Agent 工作目錄>/.claude/claudeclaw/settings.json`

### 3.1 LINE 完整設定結構

```jsonc
{
  "line": {
    // === 必填 ===
    "channelAccessToken": "long-lived-token...",    // LINE Channel Access Token
    "channelSecret": "hex-secret...",               // LINE Channel Secret（用於 webhook 簽章驗證）

    // === 使用者授權 ===
    "allowedUserIds": ["U..."],      // 允許使用的 LINE user ID 清單
                                      // 空陣列 [] = 所有人都能用
                                      // 非空 = 只有列出的人能用

    // === Pairing 配對（使用者自助加入白名單）===
    "pairing": {
      "enabled": true,                // 啟用配對功能
      "code": "my-secret-code",       // 配對密碼（初始化時自動產生，可自行修改）
      "welcomeMessage": "Hi! 請輸入配對碼以開始使用。",    // 陌生人收到的提示
      "successMessage": "✅ 配對成功！現在可以開始對話了。"  // 配對成功的回覆
    },

    // === 群組行為 ===
    "requireMention": true,           // 群組中是否要 @mention bot 才回應（預設 true）
    "groups": {                        // 個別群組覆寫設定（key = group ID）
      "Cabc123...": {
        "requireMention": false,       // 此群組免 @mention
        "speechPolicy": "restricted"   // 有外部人的群：只被動回應、不主動、不回報（見 7.35）
      }
    },

    // === 對話記錄（見 7.4）===
    "chatLog": {
      "enabled": false,               // 全部訊息寫入磁碟（預設關閉）
      "injectRecent": 15              // 每次喚醒注入的則數，其餘留在檔案
    },

    // === Webhook 設定 ===
    "webhookPort": 18801,             // 本機內部 port（每個 Agent 要不同）
    "webhookPath": "/line/felix"      // Webhook 路徑（每個 Agent 要不同）
  }
}
```

### 3.2 各欄位詳細說明

| 欄位 | 型別 | 必填 | 預設值 | 說明 |
|---|---|---|---|---|
| `channelAccessToken` | string | ✅ | — | 從 LINE Developers Console 取得 |
| `channelSecret` | string | ✅ | — | 用於驗證 webhook 請求的簽章 |
| `allowedUserIds` | string[] | ❌ | `[]` | 空 = 全部人都能用。LINE user ID 格式：`U` + 32 個 hex 字元 |
| `pairing.enabled` | boolean | ❌ | `false` | `enabled` + `code` 都設好時，任何不在 `allowedUserIds` 的人都會走配對流程 — **包含 `allowedUserIds` 為空的情況** |
| `pairing.code` | string | ❌ | `""` | 初始化時由 AI 自動產生 10 字元隨機碼。可自行修改 |
| `pairing.welcomeMessage` | string | ❌ | 有預設 | 陌生人 DM bot 時看到的提示訊息 |
| `pairing.successMessage` | string | ❌ | 有預設 | 配對成功後的回覆 |
| `requireMention` | boolean | ❌ | `true` | 群組中是否要求 @mention bot 名稱才回應 |
| `groups` | object | ❌ | `{}` | 個別群組的設定覆寫。key 是 group ID（`C` 開頭）或 room ID（`R` 開頭） |
| `webhookPort` | number | ❌ | `3100` | 本機 webhook server 的 port。**多 Agent 時每個要不同**。⚠️ 不要設成 `18789` — 那是 proxy 自己的對外 port，Agent 佔用會讓 proxy 判定 CRITICAL 衝突而拒絕啟動 |
| `webhookPath` | string | ❌ | `/webhook` | Webhook URL 的 path 部分。建議用 `/line/<agent名稱>` |

### 3.3 修改設定

直接編輯 settings.json 即可。Daemon 每 30 秒自動 hot-reload，**不需要重啟**就能生效。

以下情況需要重啟 daemon：
- `channelAccessToken` 或 `channelSecret` 變更
- `webhookPort` 變更

---

## 4. Webhook Proxy（多 Agent 共用）

當多個 Agent 都使用 LINE 時，需要一個 Proxy 共用一個 port 並按 path 分流。

### 4.1 為什麼需要 Proxy

LINE webhook 透過 ngrok 進來只能指向一個 port。多個 Agent 各自開 webhook server 會搶 port。
Proxy 聽一個共用 port（預設 18789），根據 URL path 轉發到各 Agent 的內部 port。

### 4.2 Proxy 設定

Proxy 設定檔：`~/.claude/claudeclaw/proxy-config.json`

```jsonc
{
  "port": 18789,       // Proxy 對外 port（ngrok 指向這裡）
  "bind": "0.0.0.0"   // Bind address
}
```

### 4.3 各 Agent 的 port 分配

每個 Agent 的 `webhookPort` 必須唯一且不能跟 Proxy 的 port 相同：

| Agent | webhookPort | webhookPath |
|---|---|---|
| Proxy（對外） | 18789 | — |
| Felix | 18801 | /line/felix |
| Eleven | 18802 | /line/eleven |
| Beo | 18808 | /line/beo |

### 4.4 Proxy 指令

```
/claudeclaw:proxy           # 查看狀態（從任何 Agent 執行皆可）
/claudeclaw:proxy start     # 啟動 Proxy
/claudeclaw:proxy stop      # 停止 Proxy
```

CLI 版本：
```bash
bun run <claudeclaw>/src/index.ts proxy start
bun run <claudeclaw>/src/index.ts proxy stop
bun run <claudeclaw>/src/index.ts proxy status
```

### 4.5 自動偵測

- **Agent 自動偵測**：Proxy 啟動時掃描 `~/.claude/projects/` 找出所有安裝了 ClaudeClaw 的 Agent 工作目錄，讀取各自的 settings.json，自動建立路由表。不需要手動註冊 Agent。
- **定期重掃**：每 15 秒重新掃描，新 Agent 上線或設定變更會自動偵測。
- **Health check**：每 30 秒檢查各 Agent 的 daemon 是否在線。
- **衝突偵測**：自動檢測重複的 path 或 port，在 log 中顯示警告。

### 4.6 查看狀態

瀏覽器：`http://localhost:18789/status`（JSON）

終端：
```bash
curl http://localhost:18789/status
```

Log：
```bash
tail -f ~/.claude/claudeclaw/proxy.log
```

### 4.7 單 Agent 模式

如果只有一個 Agent 使用 LINE，不需要 Proxy。Agent 的 daemon 直接聽 webhookPort，ngrok 直接指向該 port 即可。

---

## 5. 啟動與運作

### 5.1 啟動流程

**多 Agent（建議）：**
```
1. 啟動 Proxy：    /claudeclaw:proxy start
2. 啟動 Agent A：  /claudeclaw:start（在 Agent A 的工作目錄）
3. 啟動 Agent B：  /claudeclaw:start（在 Agent B 的工作目錄）
```

Daemon 啟動時會自動偵測 Proxy 是否在運行，並顯示：
```
LINE: proxy detected, using internal :18801
LINE: enabled (via proxy)
```

**單 Agent：**
```
1. /claudeclaw:start（直接啟動，不需要 Proxy）
```

### 5.2 停止

```
/claudeclaw:stop              # 停止當前 Agent 的 daemon
/claudeclaw:proxy stop        # 停止 Proxy（影響所有 Agent 的 LINE 收訊）
```

### 5.3 Hot-reload

以下設定改完 30 秒內自動生效，不需要重啟：
- `allowedUserIds`（白名單增減）
- `pairing`（開關、密碼、訊息）
- `requireMention`（群組 mention 政策）
- `groups`（個別群組覆寫）
- `security`（安全層級）

---

## 6. 訊息處理

### 6.1 支援的訊息類型

| 類型 | 處理方式 |
|---|---|
| **文字** | 直接作為 prompt 輸入給 Claude |
| **圖片** | 下載到 `inbox/line/`，Claude 用 Read 工具查看圖片 |
| **語音** | 下載後用 Whisper 轉文字，文字作為 prompt |
| **影片** | 下載到 `inbox/line/`，告知 Claude 有影片檔 |
| **檔案** | 下載到 `inbox/line/`，Claude 用 Read 工具讀取 |
| **貼圖** | 轉成文字描述（sticker keywords） |
| **位置** | 轉成文字（地名、地址、座標） |

### 6.2 回覆格式

- LINE 不支援 markdown，Agent 的回覆必須是**純文字**
- 超過 4500 字元自動分段（LINE 單則上限 5000 字）
- 優先使用 Reply API（免費）。Reply 呼叫**只要拋錯**就 fallback 到 Push API（沒有 timeout 機制）。分段超過 5 則時直接跳過 Reply，整批走 Push（LINE 一次 reply 最多 5 則）

### 6.3 Loading 動畫

收到訊息後，bot 會自動顯示 LINE 的 loading 動畫（三個跳動的點），直到 Claude 回覆完成。每 18 秒自動續期（LINE 上限 20 秒/次）。

### 6.4 訊息去重

同一則訊息在 10 秒內重複收到會被自動忽略（LINE webhook 可能重送）。

---

## 7. 群組行為與 Mention 政策

### 7.1 DM（私訊）

DM 不受 mention 政策影響。只要通過使用者授權（allowedUserIds / pairing），bot 就會回應所有 DM 訊息。

### 7.2 群組中的回應規則

```
收到群組訊息
  │
  ├── 使用者不在 allowedUserIds？ → 忽略
  │
  ├── 查 mention 政策：
  │   1. 這個群組有在 groups[chatId].requireMention 設值？ → 用這個
  │   2. 沒有？ → 用全域 requireMention（預設 true）
  │
  ├── requireMention = true？
  │   ├── 文字訊息且含 @<bot display name>？ → 回應
  │   └── 其餘一律忽略（含圖片 / 影片 / 語音 / 檔案 / 貼圖 / 位置）
  │
  └── requireMention = false？ → 回應所有訊息
```

> **非文字訊息在 `requireMention: true` 的群組不會喚醒 Agent。**
> LINE 的 mention 只存在於文字訊息的內文，圖片與檔案**本質上無法帶 @** ——
> 若放行，等於在「要 @ 才回應」的群組裡被任何一張照片喚醒，而且沒有任何
> 指示可依循。要 Agent 看某個附件，**傳完後再 @ 它一句**。
>
> 附件不會因此遺失：開了 `chatLog`（見 7.4）時，封存發生在權限判斷之前，
> 檔案照樣下載、記錄，Agent 之後往回翻就能取用。

### 7.3 設定範例

**所有群組都要 @mention（預設）：**
```jsonc
"requireMention": true,
"groups": {}
```

**所有群組都免 @mention：**
```jsonc
"requireMention": false,
"groups": {}
```

**只有特定群組免 @mention：**
```jsonc
"requireMention": true,
"groups": {
  "Cfamily_group_id": { "requireMention": false }
}
```

### 7.35 受限群組發言（speechPolicy）

有外部人在場的群組（銀行、廠商往來群）可以設 `speechPolicy: "restricted"`：

```jsonc
"groups": {
  "C<銀行群 id>": {
    "requireMention": true,
    "passiveListen": true,
    "speechPolicy": "restricted"
  }
}
```

行為：agent 被 @ 時仍會回應內部人，但收到一段強化守則 ——
**只回應直接呼叫它的那句、盡量簡短、不主動發言、不在群裡回報任務/系統狀態
（做了什麼改私訊管理者）**。對外部人來說 agent 幾乎隱形。

| | `requireMention` | `speechPolicy: restricted` |
|---|---|---|
| 管的是 | 要不要**醒**（被 @ 才醒） | 醒來後**說什麼**（只回、不主動、不回報） |
| 層級 | 路由層，機械強制 | prompt 層，指令約束 |

兩個搭配用：requireMention 擋掉沒 @ 的喚醒，speechPolicy 約束被 @ 之後的分寸。

> 為什麼發言分寸只能用 prompt、不能機械強制：LINE agent 只在被喚醒時產生輸出，
> 不會憑空發言。「醒來後講多少」是模型行為，路由層沒有東西可攔 —— 唯一能做的是
> 把守則注入 prompt。它不保證 100% 遵守（沒有 prompt 指令做得到），但這是對的層級，
> 且集中成設定值後跨 agent 一致，不必每隻手寫。

---

### 7.36 安全預設：defaultSpeechPolicy

要讓 agent「被拉進任何新群都先當外部群」，設 agent 層的預設：

```jsonc
"line": {
  "defaultSpeechPolicy": "restricted",   // 沒明確設定的群一律 restricted
  "groups": {
    "C<任務群 id>": { "speechPolicy": "normal" }   // 只有明標的內部群放寬
  }
}
```

解析順序：**per-group 的 `speechPolicy` 優先，沒設才落到 `defaultSpeechPolicy`**，
再沒有才是全域預設 `"normal"`。

用途：安全預設。agent 被邀進沒設定過的新群 → 自動 restricted（只被動回應、不主動、
不回報），直到管理者確認「這是內部/任務群」再明標 `"normal"` 放寬。避免 agent 一進
陌生群就自在講話。

- `defaultSpeechPolicy` 預設 `"normal"` → **不設就跟以前完全一樣**，現有 agent 零影響
- 只影響「沒在 `groups` 裡明列」的群；明列的照該群自己的 `speechPolicy`
- 私訊不受影響（restricted 只作用於群組）

---

### 7.4 對話記錄（chatLog）

`requireMention: true` 讓 bot 安靜，但也讓它看不到沒 @ 它的那些訊息 —— 被 @ 時
往往缺前因後果。`chatLog` 解決這件事：**所有進來的訊息（含未配對者、未 @ 的、
DM）以及 bot 自己的回覆，都寫進磁碟**，喚醒時只注入最近 N 則，其餘留在檔案裡讓
agent 自己決定要不要往回讀。

```jsonc
"line": {
  "chatLog": {
    "enabled": false,      // 預設關閉；開啟即開始持久化對話內容
    "injectRecent": 15     // 每次注入的則數；更早的不進 prompt，只給路徑
  }
}
```

**檔案結構**（`<專案>/.claude/claudeclaw/chatlog/`）：

```
chatlog/
├── index.json                  # 對話 ID → 名稱 / 類型 / 最後活動時間
├── group-C0123…/2026-07.jsonl  # 一個對話一個資料夾，按月切檔
└── user-U0abc…/2026-07.jsonl
```

每則一行 JSON：時間、訊息 ID、`role`（`user` / `bot`）、發話者 ID 與顯示名、
訊息類型、內容，附件另加 `mediaPath`。配對碼會被替換成 `[pairing code]`，不落地。

**各類型怎麼存**：

| 類型 | 記錄內容 |
|---|---|
| 文字 | 原文 |
| 圖片 / 影片 / 語音 / 檔案 | 下載到 `inbox/line/<messageId>.<ext>`，`mediaPath` 指向它 |
| 貼圖 | 文字描述：`[sticker: 關鍵字 — package <id>/<id>]`（LINE 不提供貼圖內容下載，關鍵字與 id 是唯一可留的記錄） |
| 位置 | `[location: 名稱 地址 (緯度, 經度)]` |

附件在**授權檢查之前**就下載，未配對者傳的檔案同樣會落地。下載結果按 message id
記憶化，所以封存與交給 agent 的那份是同一次請求、同一個檔案。

注意事項：

- **沒有上限、不會自動裁切**，文字與附件都是。文字一則約 100 bytes，附件則取決於
  內容 —— 磁碟成長主要來自附件，保留多久由運維決定
- 開啟後 `passiveListen` 的記憶體緩衝不再用於 prompt（chatLog 是它的超集）
- 這是對話內容與附件的永久記錄，是否適合取決於使用場景與當地法規 —— 預設關閉不是
  隨口設的

### 7.5 如何取得 Group ID

群組訊息進來時，daemon log 會印出 group ID：
```
[13:05] Line 戚禎庭(U708a...) in group C8035...: "hello"
```

`C8035...` 就是 group ID，可以加到 `groups` 設定裡。

---

## 8. 使用者授權與 Pairing 配對

### 8.1 開放模式（預設）

```jsonc
"allowedUserIds": []    // 空陣列 = 所有人都能用
```

所有 LINE 使用者都能 DM bot、在群組中 @mention bot。

### 8.2 白名單模式

```jsonc
"allowedUserIds": ["U708a61e8a1227945158a4c4920b4e15a"]
```

只有列出的 user ID 能使用 bot。其他人的訊息完全被忽略。

### 8.3 Pairing 配對（自助加入白名單）

只要 `pairing.enabled = true` 且 `pairing.code` 非空，**任何不在 `allowedUserIds` 裡的人**都會走配對流程 — `allowedUserIds` 是不是空陣列都一樣。這讓「純配對」模式可行：白名單留空，operator 不必手動查 LINE User ID。

⚠️ 也因此，8.1 的開放模式和 pairing 不能並存：在原本 `allowedUserIds: []` 全開放的 bot 上打開 pairing，等於把先前所有能用的人全部擋在門外，他們必須先輸入配對碼才能再度使用。

**流程：**
1. 陌生人 DM bot → 收到 `welcomeMessage`（提示輸入配對碼）
2. 陌生人輸入錯誤密碼 → 再次收到 `welcomeMessage`
3. 陌生人輸入正確的 `pairing.code` → 收到 `successMessage`
   - 該 user ID 自動寫入 `allowedUserIds`（持久化到 settings.json）
   - 之後可以正常使用 bot
4. 之後該使用者再發訊息 → 正常對話

**安全注意事項：**
- Pairing 只在 DM 中觸發（群組不會觸發）
- 只有文字訊息能配對（圖片/語音/檔案不會觸發）
- 配對碼是共用密碼模式，洩漏了任何人都能用。定期更換密碼可降低風險
- 初始化時 AI 會自動產生 10 字元隨機碼，建議不要用簡單密碼

### 8.4 如何取得 User ID

使用者的 LINE user ID 會在以下場合出現：
- Daemon log：`Line 戚禎庭(U708a61e8...) in DM: "hello"`
- Pairing 成功時自動寫入 settings.json
- 無法從 LINE app 介面直接查看（需要透過 bot 互動取得）

---

## 9. 語音訊息處理

### 9.1 運作方式

```
使用者發送語音訊息
  → LINE server 推送 webhook（audio type）
  → Daemon 下載音檔（m4a 格式）到 inbox/line/
  → ffmpeg 轉換 m4a → wav（16kHz mono PCM）
  → Whisper 語音辨識 → 文字
  → 文字作為 prompt 送給 Claude
  → Claude 回覆
```

引擎選擇由 `whisper.engine` 決定，預設 `"auto"`：有設 `stt.baseUrl` → 外部 API；否則在 macOS arm64 → MLX（預設模型 `large-v3-turbo`）；其他平台才 fallback 到 whisper.cpp。細節見 [WHISPER-GUIDE.md](WHISPER-GUIDE.md)。

### 9.2 需求

- **ffmpeg**：用於轉換 LINE 的 m4a 格式。macOS: `brew install ffmpeg`
- **MLX 引擎（macOS arm64 預設）**：模型 `large-v3-turbo`，首次使用時自動下載
- **whisper.cpp（非 mac arm64 的 fallback）**：模型 `base.en`（~75MB），binary 與模型都會自動下載，不需要手動安裝

### 9.3 外部 STT API（可選）

如果不想用本機 Whisper，可以設定外部 STT API：

```jsonc
{
  "stt": {
    "baseUrl": "http://localhost:8000",    // OpenAI-compatible STT API
    "model": "Systran/faster-whisper-large-v3"
  }
}
```

設定了 `stt.baseUrl` 後，會使用外部 API 取代本機 Whisper，支援 m4a 直接送出，不需要 ffmpeg。

---

## 9.5 對話速度與自動壓縮

Agent 每次回覆都會重新載入該對話累積的完整歷史 —— 對話越長，每則回覆越慢。

底層 Claude Code 確實會自動壓縮，但**門檻是 context 逼近模型上限**（約 20 萬 token）。
那是為了「不溢出」設計的，不是為了「保持快速」；在觸發之前，context 只增不減。
ClaudeClaw 原本另有兩道：turn ≥ 25 發一次提醒（不動手）、單次執行 timeout 才主動壓縮。
日常對話兩者都碰不到。

`autoCompactTurns` 補上按對話長度觸發的那一道：

```jsonc
{
  "autoCompactTurns": 20,        // 累積幾 turn 後排入壓縮；0 = 關閉（預設）
  "autoCompactIdleMs": 300000    // 對話安靜多久才真的壓；預設 5 分鐘
}
```

**兩段式：達標只是排程，安靜了才執行。**

```
第 20 turn 回完 → 標記「待壓縮」，不動作
                → daemon 每分鐘掃一次
                → 這個對話安靜超過 5 分鐘了嗎？
                     沒有 → 繼續等（還在談）
                     有   → 這時才壓
```

為什麼不達標就壓：回覆雖然已送出，壓縮仍佔著該 thread 的佇列，**下一則訊息會排在它後面**——
成本只是從「這一則」移到「下一則」。而一來一往的節奏裡，每次回完佇列都是空的、
看起來都像有空檔，其實使用者只是在打字。**唯一能分辨「談完了」與「還在打字」的是時間。**

- 壓縮發生在使用者離開後 → 不拖慢任何一則回覆，也不會壓到進行中的討論
- 壓縮走的是同一條 thread 佇列 → 不可能跟 `--resume` 撞在一起；期間有訊息進來，
  壓縮排在它後面
- 失敗不清標記 → 下一輪掃描重試
- 每個 thread（各群組、各 DM）獨立計數與判定
- 壓縮保留摘要，不是清空：agent 記得談過什麼，只是不再逐字重讀

`autoCompactIdleMs` 選值：設太短（1 分鐘）會在對話空檔中間壓；設太長（30 分鐘）
則整天連續使用的 agent 可能一直等不到窗口。5 分鐘對一般聊天節奏夠用。

與 `/claudeclaw:clear` 的差別：`clear` 是**丟棄**整個 session 從零開始；
`autoCompactTurns` 是**濃縮**後繼續。前者手動、後者自動。

> `autoCompactTurns` 選值：對話節奏快、每則都短 → 可調高（30-40）；每則都長或常
> 附檔案 → 調低（10-15）。壓縮本身是一次完整的 Claude 執行（要讀完 context 寫摘要），
> 設太低會頻繁付這個成本。
>
> turn 的定義：**一次喚醒算一 turn**，不論該次內部做了多少工具呼叫。失敗的執行不計。

---

## 10. 安全性層級

`security.level` 控制 Agent 在處理 LINE 訊息時可以使用的工具：

| Level | Read/Grep/Glob | Write/Edit | Bash | WebSearch | 目錄限制 |
|---|---|---|---|---|---|
| `locked` | ✅ | ❌ | ❌ | ❌ | 限專案目錄 |
| `strict` | ✅ | ✅ | ❌ | ❌ | 限專案目錄 |
| `moderate`（預設） | ✅ | ✅ | ✅ | ✅ | 限專案目錄 |
| `unrestricted` | ✅ | ✅ | ✅ | ✅ | **無限制** |

⚠️ `allowedTools` / `disallowedTools` 是**覆寫**，不是疊加。`level: "locked"` 配上 `allowedTools: ["Bash"]`，結果是只剩 Bash — locked 原本給的 Read / Grep / Glob 全部被拿掉。

設定方式：
```jsonc
"security": {
  "level": "moderate",
  "allowedTools": [],        // 非空時「取代」整份允許清單，不是加開
  "disallowedTools": []      // 非空時「取代」整份禁止清單
}
```

---

## 11. 常用操作

### 新增一個 LINE Agent

1. 在 LINE Developers Console 建立新的 Messaging API channel（或用同一個 channel 的不同 webhook path）
2. 在 Agent 的 settings.json 設定 LINE：
   ```jsonc
   "line": {
     "channelAccessToken": "你的 token",
     "channelSecret": "你的 secret",
     "allowedUserIds": [],
     "webhookPort": 18804,          // 選一個沒被用的 port
     "webhookPath": "/line/myagent" // 選一個沒被用的 path
   }
   ```
3. 在 LINE Developers Console 設 Webhook URL：`https://<ngrok>/line/myagent`
4. 確認 Proxy 在跑（`/claudeclaw:proxy`），啟動 Agent（`/claudeclaw:start`）

### 暫時關閉某 Agent 的 LINE

把 `channelAccessToken` 設成空字串：
```jsonc
"channelAccessToken": ""
```
Hot-reload 30 秒後 LINE 通道會自動關閉。其他通道（Slack、Telegram 等）不受影響。

### 更換配對密碼

直接改 settings.json：
```jsonc
"pairing": {
  "code": "new-password-here"
}
```
Hot-reload 生效。已配對的使用者不受影響（他們已在 allowedUserIds 中）。

### 移除某使用者的權限

從 `allowedUserIds` 中刪除該 user ID，hot-reload 後該使用者就無法使用了。

### 讓 bot 在某群組免 @mention

```jsonc
"groups": {
  "C你的群組ID": { "requireMention": false }
}
```

---

## 12. 疑難排解

### LINE 傳訊息沒有回應

1. **檢查 daemon 有在跑嗎？**
   ```bash
   /claudeclaw:status
   ```

2. **檢查 Proxy 有在跑嗎？**（多 Agent 時）
   ```bash
   /claudeclaw:proxy
   ```
   確認你的 Agent 顯示 🟢

3. **檢查 ngrok 有在跑嗎？**
   ```bash
   curl http://127.0.0.1:4040/api/tunnels
   ```

4. **檢查 Webhook URL 設對了嗎？**
   LINE Developers Console → Messaging API → Webhook URL
   應該是 `https://<ngrok-url><webhookPath>`

5. **看 daemon log：**
   ```bash
   tail -50 <Agent 工作目錄>/.claude/claudeclaw/logs/daemon.log
   ```

### 「port is already in use」

- 有其他 Agent 或 Proxy 佔了這個 port
- 解法：改 `webhookPort` 成不同的值，或啟動 Proxy

### 語音訊息無法辨識

- 確認有安裝 ffmpeg：`which ffmpeg`
- 看 daemon log 有沒有 whisper 相關錯誤
- Whisper 模型首次使用會自動下載，需要網路

### Pairing 不生效

- 確認 `pairing.enabled = true` 且 `pairing.code` 不是空字串（兩者缺一就整個略過配對流程，退回單純的 `allowedUserIds` 判斷）
- `allowedUserIds` 是不是空陣列不影響配對是否觸發；已經在 `allowedUserIds` 裡的人不會被要求配對
- Pairing 只在 DM 觸發，群組中不會觸發
- 密碼必須完全一致（區分大小寫）

### 群組中 bot 不回應

- 檢查 `requireMention` 設定
- 確認 @mention 的名稱是 bot 的 **display name**（在 LINE Developers Console 設定的）
- 看 daemon log 有沒有 `Skip group message (mention required)`

### 已配對但無法使用

- 確認 user ID 有在 `allowedUserIds` 中（看 settings.json）
- 可能是 hot-reload 還沒生效（等 30 秒）
- 極端情況：daemon 寫入 settings.json 失敗，看 daemon log 的 error

---

## 附錄：檔案位置一覽

| 檔案 | 位置 | 用途 |
|---|---|---|
| Agent 設定 | `<Agent>/.claude/claudeclaw/settings.json` | LINE token、安全設定等 |
| Claude Session | `<Agent>/.claude/claudeclaw/session.json` | Agent 的對話記憶 |
| Thread Sessions | `<Agent>/.claude/claudeclaw/sessions.json` | 各 thread 的對話記憶 |
| 執行日誌 | `<Agent>/.claude/claudeclaw/logs/` | 每次 LINE 訊息處理的日誌 |
| 收到的媒體 | `<Agent>/.claude/claudeclaw/inbox/line/` | 下載的圖片、語音、檔案 |
| Cron Jobs | `<Agent>/.claude/claudeclaw/jobs/` | 排程工作 |
| LINE Directives | `<claudeclaw>/prompts/line/DIRECTIVES.md` | LINE 行為規則（注入給 Claude） |
| Proxy 設定 | `~/.claude/claudeclaw/proxy-config.json` | Proxy port、bind |
| Proxy PID | `~/.claude/claudeclaw/proxy.pid` | Proxy 的 process ID |
| Proxy Log | `~/.claude/claudeclaw/proxy.log` | Proxy 運行日誌 |
| Whisper | `<Agent>/.claude/claudeclaw/whisper/` | 語音辨識 binary + model |

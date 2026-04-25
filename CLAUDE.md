# claudeclaw — 開發注記

這份是 Tiger 的 fork。開發 / 測試這個 plugin 時請遵守下面兩條：

## 1. 開始開發前先進版本

修改前 bump 三個檔案的 `version`：
- `package.json`
- `.claude-plugin/marketplace.json`
- `.claude-plugin/plugin.json`

規則：
- 新功能 → minor（`1.1.0` → `1.2.0`）
- 修 bug → patch（`1.1.0` → `1.1.1`）

提醒 Tiger 進版（如果他忘了）。

## 2. 測試前確認 cache 已同步最新檔案

Plugin 真正執行的目錄是 `~/.claude/plugins/cache/claudeclaw/claudeclaw/<version>/`，**不是** marketplace 這份。Cache 由 Claude Code 系統管理，要等它同步完才會跑到最新改動。

不要手動編輯 cache，會被覆蓋。所有開發都在 marketplace 進行。

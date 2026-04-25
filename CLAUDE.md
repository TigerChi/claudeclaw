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

Plugin 真正執行的目錄是 `~/.claude/plugins/cache/claudeclaw/claudeclaw/<version>/`，**不是** marketplace 這份。**Cache 不維護 git，純粹是 marketplace 的檔案副本**。

要同步：

```bash
rsync -a --delete \
  --exclude=.git --exclude=node_modules \
  --exclude=.claude --exclude=.codemachine --exclude=AGENTS.md \
  ~/.claude/plugins/marketplaces/claudeclaw/ \
  ~/.claude/plugins/cache/claudeclaw/claudeclaw/1.0.0/
```

不要在 cache 編輯（會被下次 rsync 覆蓋）。所有開發在 marketplace 進行，commit 之後跑 rsync 同步給 cache。

**回報慣例**：對 marketplace 做改動 + rsync 後，回報訊息必須明確寫一句「已同步到 cache」。不要只把指令放在輸出裡讓 Tiger 自己看。

## 3. Push 到 GitHub 前一律先確認

任何 `git push`（包括新分支、fast-forward、`--force`、`--delete`）**必須先取得 Tiger 同意**才執行。本地 commit / merge / rebase 失敗可以 reset 救回；遠端 push 把穩定狀態覆蓋掉後就難救了。「整併好本地」不等於「可以推上 GitHub」，是兩個獨立的決定。

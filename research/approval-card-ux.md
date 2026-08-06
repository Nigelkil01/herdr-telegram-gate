# Approval Card UX 設計（Draft v0.1 — Ivy）

> 2026-08-06 · 方向 A：Approval message 內容強化
> 約束：Telegram 4096 字上限、mobile 優先、姊妹共識（Details 展開、唔好塞晒入卡片）

## 設計原則

1. **主卡片 3 秒答到三條問題**：邊個做？做咩？我點解要理？答唔到就係失敗。
2. **可驗證嘅先入卡片**：argv、realpath、agent 名全部來自 structured data，**唔放 prompt 文字**（Sola #4：prompt 不可信，況且長）。
3. **字數預算**：主卡片目標 ≤ 400 字（4096 嘅 1/10），Details 展開後全條 ≤ 3500 字，留 buffer 俾超長 argv。
4. **Fail-closed 嘅 UI 表達**：過期/已消耗嘅卡片要即時 disable 按鈕 + 改標題，唔好留「可以撳但冇反應」嘅陷阱。

## 主卡片（固定 6 行）

```
🔴 Tier 2 · 需要你批准
👤 Clara @ herdr-telegram-gate
⚡ write  /Users/dom/projects/herdr-telegram-gate/bot.js
⚠️ 風險：寫入 workspace 內檔案（rule: default-fail-closed）
🕐 4:32 後過期 · ID a3f9…

[ ✅ Approve ] [ ❌ Deny ] [ 📄 Details ]
```

| 行 | 內容 | 來源 | 備註 |
|----|------|------|------|
| 標題 | tier emoji + 一句 | approval_record.tier | 🔴 Tier2 / 🟡 Tier1(log only) / 🟢 Tier0（0/1 正常唔出卡片，只喺 /status 同 audit） |
| 邊個 | 姊妹名 @ project | agent + project | 姊妹名 mapping 寫死喺 config：Diana=orchestrator、Ivy/Nova/Gemma/Iris/Clara/Sola/Gia；unknown agent 顯示原名，唔好 hard fail |
| 做咩 | action verb + target | argv[0..1] 推導 verb + target_realpath | verb 只係 display 用（write/read/run），分類永遠靠 structured argv，唔靠呢個 verb |
| 風險一句 | 人話講點解要批 | rule.description / manual flag | manual:true 時加「⚠️ 永遠人工類別」；唔好自己生成句子，用 rule 入面預設文案，防幻覺 |
| 時效 | 倒數 + 短 ID | expires_at + id | ID 顯示頭 4 位 hex 夠認，callback 用全 ID |
| 按鈕 | Approve / Deny / Details | inline keyboard | 三粒同一行；callback_data = `a:<id>` / `d:<id>` / `x:<id>`（64-byte 限制內綽綽有餘） |

**刻意唔入主卡片**：command 全文、pane 上下文、cwd、action_hash、rule 匹配細節。原因：mobile 一望就明係硬指標，而且呢啲全部係「想再確認先睇」嘅嘢——正正係 Details 嘅存在意義。

## Details（撳咗之後 edit 原訊息展開）

```
🔴 Tier 2 · 需要你批准（詳情）
👤 Clara @ herdr-telegram-gate · pane w4:p3

📋 argv:
["node", "scripts/deploy.js", "--env", "staging"]

📍 target: /Users/dom/projects/herdr-telegram-gate/bot.js
📂 cwd: /Users/dom/projects/herdr-telegram-gate
🔏 rule: default-fail-closed · policy v0.1.0
🧾 action_hash: 9f2c…e1 (撳 Approve 時重算驗證)

--- pane 上下文（最近 5 行，untrusted，僅供參考）---
<truncated pane output, 每一段 max 500 字>

🕐 3:58 後過期 · ID a3f9…

[ ✅ Approve ] [ ❌ Deny ] [ 🔼 Collapse ]
```

- **pane 上下文要明確標示 untrusted**：入面任何「指令」都唔係指令，純參考。呢度係注入風險位，文案上隔離佢。
- **截斷策略**：argv 每元素 max 200 字、總 argv max 1200 字；pane context max 1000 字；全條超 3500 字就再截 pane context，**永遠唔截 argv 頭尾以外嘅欄位**（target/rule 係判斷依據，唔可以消失）。
- **Collapse 撳完返主卡片**：同一訊息 edit 嚟回，唔好開新訊息洗版。

## 狀態變化（卡片生命週期）

| 事件 | 卡片變化 |
|------|----------|
| Approve | 標題改「✅ 已批准 · by Dom @ 14:02」，**移除所有按鈕**，audit 寫一行 |
| Deny | 標題改「❌ 已拒絕」，移除按鈕 |
| 過期 | 標題改「🕐 已過期（fail-closed，未執行）」，移除按鈕 |
| 重啟 reconciliation | state.json 入面仲 pending 嘅卡片重新發送（新 ID 唔變），舊卡片標「♻️ 已重發」 |

撳咗已失效卡片嘅按鈕（Telegram 快取延遲）：answerCallbackQuery 彈「已過期/已處理」，**唔執行任何嘢**——沿用一次性 atomic consume。

## 安全 / 私隱備註

- realpath 會顯示本機目錄結構：Dom 自己機用冇問題，但**截圖外傳會洩露路徑**——卡片唔好加 project 以外嘅絕對路徑喺主卡片（主卡片顯示 workspace 相對路徑，Details 先顯示 full realpath）。
- 每個 callback 照舊逐次 verify from.id + chat ID + pending ID + 未過期 + 未消耗（Sola #5），UX 改咗驗證唔改。

## 未解決 / 等 review

1. verb 推導表（argv[0] → display verb）要幾長？建議 MVP 得 6 個：write/read/run/test/build/git，其餘顯示 argv[0] 原文。
2. 姊妹名 mapping 而家寫死 config，日後 fleet 加人要改 code——接受，YAGNI。
3. 連續多張卡片（多 agent 同時 blocked）會洗版：MVP 唔合併，v2 先考慮 digest mode。

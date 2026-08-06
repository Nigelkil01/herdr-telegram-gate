# herdr-telegram-gate — MVP Plan v3（姊妹共識 + Sola 審批版）

> 2026-08-06 · Diana（orchestrator）綜合 · 姊妹共識：Ivy / Nova / Gia / Clara / Sola
> Sola verdict: **APPROVE WITH CHANGES**（6 點 amendments 已全數整合）

## Goal（Dom 定義）

Telegram 上面做到：
1. Fleet 進度通知（了解返進度）
2. Risk-tiered Auto Approval（低風險自動批）
3. 重大事件搵返 Dom 批（escalate）

## 架構

單一 process `bot.js`（Telegram + monitor + policy engine 一個 event loop）：

```
~/projects/herdr-telegram-gate/
├── bot.js          # 一個 process 搞掂晒（唔拆 monitor.js）
├── policy.json     # risk-tier policy（MVP 用 JSON 零 dependency；YAML 留 v2，schema 一致）
├── state.json      # pending approvals（restart 唔丟）
├── audit.log       # append-only 每決定一行
└── .env            # bot token、owner ID、socket path（已建，chmod 600，gitignored）
```

## 核心機制

### Detection（Hybrid）
- `herdr agent wait --until blocked` → 即時 approval 主通道（每 agent 一條 waiter）
- Waiter：**exponential backoff + timeout + retry + 事件去重**（Sola #2）
- 30s 低頻 poll → done/idle 進度通知 + 補漏
- **重啟後先 reconciliation**：對齊 state，避免重覆通知／執行（Sola #2）

### Policy（3-tier，fail-closed）
| Tier | 處理 | 內容 |
|------|------|------|
| Tier 0 | 自動 | read-only（agent read/list、ls/cat，限 `~/projects/**` 內） |
| Tier 1 | 自動 + log | **只准指定 test/build argv allowlist**（Sola #3） |
| Tier 2 | 問 Dom | write / edit / shell / network / git push / 寫出 workspace / send-keys |
| 永遠人工 | 問 Dom | push/merge/release、secrets、delete、破壞性 shell |

- **Tier1「edits」同 Tier2「write」重疊問題已修**：任何 edit/write MVP 一律 Tier2（Sola #3）
- **唔靠 prompt 文字分類後直接執行 shell**（Sola #4）：approval 必須綁定結構化 argv、canonical realpath target、agent/project、expiry；防 symlink/path traversal
- Default: escalate；parse 唔到 = escalate；corpus 外案例一律 Tier2（Sola #6）
- KPI：**unsafe→safer false negatives 必須 0**（獨立量度），auto-approve 覆蓋率其次

### Callback（逐次驗證）
- Verify：`from.id` + chat ID + pending ID + action hash + 未過期 + 未消耗（Sola #5）
- **一次性 atomic consume**（防重放）
- 無匹配 = 唔執行（fail-closed）

### State & Audit
- `state.json`：**atomic write（temp + rename）**（Sola #1）
- `audit.log`：每決定一行，記 decision、actor、policy version、action hash（Sola #1）
- `.env` 最小權限（Sola #1）

## YAGNI（斬走）

blind judge、multi-user、DB、rich UI、parallel dispatch、token spend、cross-machine config、YAML parser（v2 先）、working 狀態 push（改為 done/blocked push + `/status` 主動查）。

## 分工

| 姊妹 | 職責 |
|------|------|
| Clara | classify.js + corpus（完成 ✓）；live corpus capture + shadow-mode comparison（進行中） |
| Gia | bot.js + herdr socket plumbing（按 frozen classify() 實作） |
| Ivy | policy schema draft（完成 ✓）；approval UX 文案 |
| Nova | similar tool scan（完成 ✓） |
| Sola | policy schema + 安全 + **review ambiguity rule + TOCTOU boundary + 最終 review** |
| Gemma / Iris | 後備：中文互動測試 / 通知文案 |

## 驗證結果（2026-08-06，Clara）

**Verdict: GO，with 2 blocking conditions**（詳見 `research/REPORT.md`）

| Metric | Result |
|---|---|
| Corpus | 59 samples（15 個係 attack） |
| Exact tier match | 59/59 (100%) |
| **False negatives (THE KPI)** | **0** |
| Fuzz（property-based） | 2,758 cases / 0 violations |
| Auto-approve coverage | 37.3%（adversarial corpus，真實流量應該更高） |

**重大發現：herdr 已經 solve 咗 blocked-state detection**——`herdr agent explain` + 19 個 maintained per-agent manifests（`~/.local/state/herdr/agent-detection/remote/*.toml`）。**唔好自己寫 blocked detection，用 `agent wait --until blocked` 信任 herdr**。我哋 scope 收窄做：「blocked on what?」（唯一 herdr 唔答嘅問題）。

**classify() frozen signature**：`classify(paneText, agent, { cwd }) -> { tier, action, argv, targets[], rule, reason }`——fail-closed 每步（0 candidates / >1 distinct ⇒ T2；shell metachar ⇒ T2；unquoted glob ⇒ T2；git 無 `-C` ⇒ T2；其餘 ⇒ T2）。

**Blocking condition 1 — shadow mode 先行**：capture ~20 個真實 blocked prompts per agent；未證明 extraction 對真實 output 可靠之前，daemon 行 shadow mode（classify + log + 全部 escalate 去 Telegram），同 Dom 實際 approve 嘅決定比較；**一星期 false negatives = 0 先開 auto-approve**。

**Blocking condition 2 — 執行時 re-resolve**：classify-time `realpath` 只係 advisory，**執行前要 re-run resolution，mismatch 即 abort**（TOCTOU）。

## Sola Review（2026-08-06）

**Verdict: GO for shadow-mode build**，4 個 blocking conditions（live auto-approve 前必須完成）：
1. **Region-based extraction**：正式版只分析 herdr manifest 指定嘅 live approval region（`after_last_horizontal_rule` 等），唔掃整個 pane；0/多候選一律 T2
2. **執行前 pane revalidation**：send-keys 前必須重新 `agent read`，確認 agent/session、blocked 狀態、raw command/argv hash 全部不變，再 re-resolve（bot 檢查後、send-keys 前 terminal 可能已轉成另一個 approval prompt）
3. **cwd binding**：每個 auto decision 綁定 canonical cwd + targets（fix classify.js:239——Tier1 回傳 `targets: []` 無法驗證 implicit cwd）
4. **Symlink race**：檢查與真正 open() 之間仍可換 symlink；live 模式拒絕含 symlink path，或明確接受 workspace process 為 trusted boundary；高風險資料維持 T2

Shadow mode 唔會自動執行，唔阻 build；但 pane revalidation + cwd binding 未完成前唔准開 live auto-approve。

## 開工順序（更新版）

1. ✅ Nova：similar tool scan（完成）
2. ✅ Clara：corpus 驗證（完成，GO + 2 blocking conditions）
3. ✅ Ivy：policy schema draft（完成）
4. ✅ Gia：herdr CLI recon（完成）
5. 🔄 Gia：按 frozen classify() 寫 bot.js（shadow mode 先行）
6. 🔄 Clara：collect live corpus（shadow mode 準備）
7. 🔄 Sola：review ambiguity rule + TOCTOU boundary
8. 整合 + shadow mode 試行一星期 → 開 auto-approve → 交付

# Release Checklist & Blocking Issues

> 2026-08-06 · Diana 維護 · 目標：全員 consensus 先上 GitHub
> Verdict (Nova): 內部 shadow MVP 可用；陌生人 clone-and-run 未 ready

## 🔴 Blocking Issues（要 fix 先放）

- [x] **B1. policy.json rules 唔生效**（Nova）——✅ 已 fix：applyPolicyRules（additive manual-only，只升級唔放寬，safety floor 保持）；README 已講清楚語義
- [x] **B2. README 唔完整**（Nova）——✅ 已 fix：Ivy 重寫（含 BotFather/userinfobot 教學、.env.example、first-approval、shadow 點關）+ Diana 修正 herdr URL + shadow config 指示
- [x] **B3. Runtime artifacts 未 gitignore**（Nova）——✅ Gia 已補（7/7）
- [x] **B4. workspace_root 雙來源**（Nova）——✅ 已 fix：classify() 接受 opts.workspaceRoot（default ~/projects），bot.js 傳 policy.json 嘅 root；test+fuzz 確認無 regression
- [x] **B5. 未有 LICENSE / package.json / 未 commit**（Nova + Diana audit）——✅ LICENSE（MIT）+ package.json（scripts）+ config.example.json 已建；未 commit（上 GitHub 前 git init 已做，等 consensus 後 commit）

## 🟡 Open Questions（等姊妹意見）

- [ ] SHADOW_MODE 寫死 = true——公開版要點 handle？（default shadow？config 可關？）
- [ ] classify.js + corpus（research/）係產品一部分定係 validation tooling？（Clara review 會答）
- [ ] 姊妹名 mapping 要 config 化？（Ivy UX note）
- [ ] herdr 未裝嘅用戶 onboarding——README 指路 + bot 啟動檢查夠唔夠？

## ✅ Done

- [x] Approval 卡片強化（方向 A：redaction、blast radius、action hash、Details 設計）
- [x] Kimi + Gemini extraction 支援（Gia Task 8）
- [x] 核心 flow 端到端驗證（Kimi、Gemini）
- [x] Herdr issue #2396（Cline detection）

## 流程

1. 各姊妹 deliverables 收齊（README/LICENSE、bot.js polish、reviews）
2. Fix blocking issues
3. 反覆真 blocked 測試（冇問題先算）
4. 全員 consensus gate（每隻 agent review + OK）
5. gh repo create + push + 驗證 public clone

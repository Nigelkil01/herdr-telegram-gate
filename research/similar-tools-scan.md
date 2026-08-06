# Similar tools scan + herdr capability check

**Author:** Nova (Grok 4.5)  
**Date:** 2026-08-06  
**Project:** herdr-telegram-gate  
**Scope:** Task 1 — competitive scan + whether herdr already ships policy/approval (go/no-go for positioning)

---

## TL;DR（給 Diana / Dom）

| 問題 | 結論 |
|------|------|
| 有冇 similar tools？ | 有，但多數係 **單 agent chat bridge**，唔係 fleet gate |
| herdr 有冇內建 risk-tier / auto-approval policy？ | **冇。** 只 detect `blocked` + 提供 `wait/read/send-keys`；唔做 tier 決策 |
| 要唔要重諗定位？ | **唔使。** 定位仍然成立：herdr multi-agent 之上嘅 **Telegram approval inbox + risk-tier policy** |
| 最近鄰競品 | Moshi（iOS 終端批准，唔係 Telegram/policy engine）；telclaude（完整 Telegram 作業系統，過重） |

**Verdict: PROCEED as planned.** herdr 係 runtime/multiplexer；我哋係 policy gate on top。

---

## 1. Similar tool matrix

| Tool | 做咩 | 單/多 agent | Approval | Telegram approve? | 我哋差異 |
|------|------|-------------|---------|-------------------|----------|
| **telclaude** ([avivsinai/telclaude](https://github.com/avivsinai/telclaude)) | Isolation-first Telegram ⇄ agent relay；Haiku observer、nonce approval、TOTP、vault、Docker/Hermes | 多 runtime（Hermes + Claude/Codex work units）但 **自己做 orchestration** | 4 tiers：READ_ONLY / WRITE_LOCAL / SOCIAL / FULL_ACCESS | 係（+ LLM 預篩） | 過重；唔綁 herdr fleet status；唔係「插上現有 herdr panes」 |
| **Claude Code Channels — Telegram** ([docs](https://code.claude.com/docs/en/channels)) | 官方 plugin：電話 chat bridge 入 running Claude session；pairing + allowlist | **單 session / 單 Claude** | Claude 自己 permission modes；channel 可 relay permission prompts（capability 視 plugin） | 部分（permission relay 仍係 research preview 問題多） | 只服務 Claude；fleet 無；無 herdr lifecycle；無跨 agent policy.yaml |
| **Copilot CLI Telegram bridge** ([examon/copilot-cli-telegram-bridge](https://github.com/examon/copilot-cli-telegram-bridge)，見 [Code with Dan writeup](https://blog.codewithdan.com/using-telegram-with-github-copilot-cli/)) | Extension `joinSession`，Telegram ↔ 一個 Copilot session | **單 Copilot session** | 靠 Copilot flags（allow/deny / `--yolo`），bridge **唔做** risk-tier | 弱：approval hang 常見；很多人用 yolo 繞過 | 單 agent；無 herdr；無 structured argv envelope |
| **Moshi + Herdr** ([getmoshi.app/guides/herdr](https://getmoshi.app/guides/herdr)) | 手機 terminal；inbox 顯示 blocked/working/done；lock screen Approve/Deny | **多 agent（經 herdr）** | 無 risk-tier auto policy——人工點 | 否（native iOS，唔係 Telegram） | 最近鄰 UX 競品；我哋用 Telegram + **auto-approve tier**，唔使裝 Moshi |
| **OpenClaw / generic HITL Telegram** | Pairing、DM policy、approval buttons for workflows | 視實作 | 各異 | 係 | 通用 automation，唔知 coding-agent blocked UI / herdr states |
| **n8n / Make Telegram HITL** | Workflow pause → Telegram approve | Workflow 節點 | 人手設計 | 係 | 唔係 agent multiplexer 原生 |

### 1.1 telclaude（最接近「有 tier」）

- **做咩：** Telegram 做 front door；security layer（regex → Haiku observer → rate limit → human approval）；tier 映射 tool 能力；FULL_ACCESS 每次要人批；Docker isolation + credential vault。
- **可借：** fail-closed allowlist、nonce/one-shot approval、audit log、per-user tier、destructive bash deny patterns。
- **唔抄：** LLM observer（MVP 過重、幻覺風險）、vault/Hermes 全套、social persona、provider sidecars。
- **差異化：** 我哋 **唔取代 agent runtime**；我哋掛喺 **已有 herdr fleet** 上面，等 `blocked`，用 policy.json 決定 auto vs escalate。

### 1.2 Claude Code Telegram channel

- **做咩：** 官方 chat bridge；sender allowlist；可 push events 入 running session。
- **痛點（公開 issue / 文檔）：** permission prompt 經常仍卡喺 **本地 terminal**；唔批就 stall；unattended 要 `--dangerously-skip-permissions`（全開，無 tier）。
- **差異化：** 我哋目標係 **唔 skip 全部 permission**，而係 **分類後 auto 低風險、高風險搵 Dom**；而且覆蓋 **整支 fleet（Grok/Claude/Codex/GLM…）**，唔只 Claude。

### 1.3 Copilot-CLI-Telegram

- **做咩：** 雙向 message relay；user allowlist；SDK join session。
- **痛點：** tool approval 唔 clean 上 Telegram →「永遠 typing」；實務上靠 CLI allow/deny 或 yolo。
- **差異化：** 我哋用 **herdr `blocked` 檢測 + structured envelope**（argv/path/expiry），唔靠 chat 文字當批准命令。

### 1.4 Moshi（定位邊界要講清楚）

- Moshi 已經做到：**herdr multi-agent 狀態 inbox + remote Approve/Deny**。
- 我哋 **唔係再做一個 terminal app**。
- 我哋差異 = **Telegram（Dom primary chat）+ risk-tiered auto-approval + audit + policy 檔案**，本地、可 script、可同 herdr-vps-bootstrap policy 對齊。

---

## 2. herdr / herdr-remote capability check（生死問題）

**Checked on host:** `herdr 0.8.0-preview.2026-08-04-d78e3d3b5126`  
**Docs:** [Agent automation](https://herdr.dev/docs/agent-automation/)、CLI help、`--default-config`、`--skill`、local `release-notes.json`、`integration` / `notification` surface。

### 2.1 herdr **有** 咩（我哋會用）

| 能力 | 命令 / 機制 | 用途 |
|------|-------------|------|
| Lifecycle 狀態 | `idle` / `working` / `blocked` / `done` / `unknown` | 進度 + 何時要人 |
| Blocked 語意 | 「認可 approval / question UI」 | approval 觸發點 |
| Wait | `herdr agent wait <t> --until blocked` | MVP 主通道 |
| 讀屏 | `herdr agent read … --source recent-unwrapped` | 拎 prompt 做 classify |
| 互動 | `herdr agent send-keys` / `prompt` | approve/deny/esc |
| 列表 | `herdr agent list` / `get` | 多 agent 掃描 |
| Socket API | `herdr api snapshot|schema` | 可 script |
| Notification | `herdr notification show` | **本機 toast only**，唔係 Telegram |
| Integrations | per-agent state hooks（claude/pi/kimi/grok…） | 改善 detection，**唔係 policy** |
| Remote | `herdr --remote <ssh>` | 連 remote server；**唔內建 approval policy** |

### 2.2 herdr **冇** 咩（我哋要填）

- ❌ Risk-tier / policy engine（auto vs escalate）
- ❌ Telegram / chat transport
- ❌ Approval envelope（expires_at、action hash、one-shot consume）
- ❌ Audit log of decisions
- ❌ Auto-approve based on argv/path allowlist
- ❌ Callback verify（from.id 等）——本來就唔係 herdr 職責

`config.toml` 嘅 “policy” 字眼只係 **CWD / host cursor / shell_mode** 等 UI/session 政策，**唔係 tool risk policy**。

Preview release notes（2026-08-04 build）亦無 approval/policy/telegram 類 feature。

### 2.3 定位結論

```
herdr          = 多 agent terminal runtime + blocked 檢測
Moshi          = 手機 terminal + 人手 Approve/Deny（無 auto tier）
Claude/Copilot Telegram = 單 agent chat bridge
telclaude      = 重型自建 Telegram OS + isolation
────────────────────────────────────────────
herdr-telegram-gate = herdr 之上嘅 thin policy gate
                     Telegram notify + risk-tier auto + Dom escalate
```

**定位唔使重諗。** 若他日 herdr 自己 ship risk-tier policy，我哋再收斂成 thin Telegram adapter；今日未見跡象。

---

## 3. 對 PLAN v3 嘅啟示（具體、可執行）

1. **Borrow，唔 rebuild：** fail-closed whitelist、one-shot callback、audit line、structured action（telclaude 證明呢幾樣係業界共識）。
2. **Avoid telclaude trap：** Docker/vault/LLM observer/SOCIAL tier → YAGNI for MVP。
3. **Avoid Claude/Copilot trap：** 唔做「全 chat relay + yolo」；blocked 先決策，否則 stall 或過寬。
4. **Moshi 並存 OK：** Dom 用 Telegram 做 primary；Moshi 用家唔係我哋目標客。
5. **Classify 生死點仍然成立：** herdr 只話「blocked」，**唔話**「呢個 blocked 係 ls 定 git push」——corpus + classify.js 先有 auto-approve 價值。
6. **執行面：** `send-keys` 批准時要有 agent-kind 對照表（Claude vs Codex vs Grok UI 按鍵唔同）——similar tools 多數 bypass 呢層，我哋唔可以。

---

## 4. Sources（抽樣）

- herdr agent automation docs；local CLI 0.8.0-preview.2026-08-04  
- https://github.com/avivsinai/telclaude  
- https://code.claude.com/docs/en/channels  
- https://blog.codewithdan.com/using-telegram-with-github-copilot-cli/  
- https://github.com/examon/copilot-cli-telegram-bridge  
- https://getmoshi.app/guides/herdr  

---

## 5. Nova 建議 next（非 blockers）

- Clara corpus 繼續；classify 準確率先於 bot plumbing  
- Ivy policy schema 可參考 telclaude tier 名，但 **MVP 用 PLAN 三 tier**，唔跟 SOCIAL/FULL_ACCESS 命名  
- 文件化一句定位 slogan：*「Not another Telegram agent. A risk-tiered approval inbox for a herdr fleet.」*

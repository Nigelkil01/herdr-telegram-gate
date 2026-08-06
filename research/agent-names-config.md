# Agent 顯示名 config 化（Design Note — Ivy）

> 2026-08-06 · Task 10a 附帶交付
> 現狀：bot.js 暫時**冇**寫死姊妹名——`agentName = agent.display_agent || agent.agent || 'unknown'`（bot.js:597），即原樣顯示 herdr 返嘅名。Approval card UX 稿（`research/approval-card-ux.md`）預設咗「姊妹名 mapping 寫死喺 config」，所以而家係配置化嘅最好時機：未寫死，就唔使改寫死嘅嘢。

## 建議：新開 `config.json`，唔好塞入 policy.json

| 檔 | 性質 | 改動時機 |
|----|------|----------|
| `policy.json` | **安全決策**（tier、allowlist）— 改錯會批錯嘢 | 改規則時，必 bump version + audit |
| `config.json` | **顯示/行為偏好**（名 mapping、通知開關）— 改錯最多顯示醜 | 加 agent、改名時 |

分開嘅原因：policy 嘅 version bump + audit 紀律唔應該被「改個花名」呢類無害改動沖淡；反之，改花名亦唔應該要過安全 review。

## 格式（最小）

```json
{
  "agent_names": {
    "w4:p1": "Diana",
    "w4:p2": "Ivy",
    "w4:p4": "Clara"
  }
}
```

- **Key 用 pane ID（`w4:p1`），唔好用 agent 名做 key**：agent 名係 agent 自己報嘅（untrusted），pane ID 係 herdr 拓撲，穩定兼唔使信 agent。
- **Fallback**：mapping 冇命中 → 原樣顯示 herdr 名，**唔好 hard fail**（新加 agent 唔使即刻改 config 先用到 bot）。
- **顯示格式**：`Clara (w4:p2)` —— 花名 + pane ID 一齊出，audit.log 記 pane ID 為準，花名純 display。

## bot.js 改動（好細）

1. 啟動時 `loadConfig()`：檔案唔存在 → `{}` 繼續行（fail-open 對 display 合理；呢個唔係安全邊界）。
2. `displayName(agent)` helper：查 `config.agent_names[agent.pane]` → fallback `agent.display_agent || agent.agent`。
3. 所有 user-facing 訊息（卡片、/status、/pending）行 `displayName()`；audit.log 照舊記 raw agent + pane。
4. `additionalProperties` 唔使嚴格——config.json 係 preference，預留擴展位（通知開關、digest mode）唔係罪。

## 刻意唔做（YAGNI）

- 唔做 hot reload：改完 restart 得，bot 本來就要 restart 先改到 policy。
- 唔做 per-agent emoji/顏色：花名已經夠辨認。
- 唔由 herdr 嗰邊儲名：bot 係 presentation 層，名嘅擁有權留喺 bot config，herdr 唔使知。

## 等 review

Sola 睇一眼「display 層 fail-open 可唔可以接受」——立場：可以，因為 audit 永遠記 raw identity，花名唔會入任何安全決策路徑。

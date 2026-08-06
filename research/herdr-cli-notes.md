# herdr CLI Notes — Gia's Reconnaissance

> 2026-08-06 · Gia (GLM-5.2) · herdr 0.8.0-preview.2026-08-04-d78e3d3b5126 · protocol 19
> 實測環境：本地 Mac，workspace w4（local fleet）+ w5（vcvps mirror）

---

## 0. 通用 JSON 格式（所有 agent 命令）

herdr agent 系列命令**預設輸出 JSON**，唔使 `--json` flag。

**成功**：
```json
{"id":"cli:agent:<command>","result":{...}}
```
exit code = 0

**失敗**：
```json
{"error":{"code":"...","message":"..."},"id":"cli:agent:<command>"}
```
exit code = 1

> ⚠️ `herdr agent read` 例外——佢出純 text，唔係 JSON（見 §4）。

---

## 1. `herdr agent list` — 列出所有 agent

### 命令
```
herdr agent list
```
（無 options）

### 輸出結構
```json
{
  "id": "cli:agent:list",
  "result": {
    "type": "agent_list",
    "agents": [ <AgentInfo>, ... ]
  }
}
```

### AgentInfo 字段（完整）

| 字段 | 類型 | 說明 | 範例 |
|------|------|------|------|
| `agent` | string | agent type 名 | `"pi"`, `"kimi"`, `"grok"`, `"gemini"`, `"cline"`, `"claude"`, `"codex"` |
| `agent_session` | object\|null | session 識別（idle agent 可能冇） |見下 |
| `agent_status` | enum | **核心字段** | `"idle"` \| `"working"` \| `"blocked"` \| `"done"` \| `"unknown"` |
| `cwd` | string | 當前工作目錄 | `"/Users/dom"` |
| `focused` | boolean | 是否當前 focused pane | `true` |
| `foreground_cwd` | string | 前景 cwd | `"/Users/dom"` |
| `pane_id` | string | **target 識別**，格式 `wN:pN` | `"w4:p4"` |
| `revision` | number | revision 號 | `1` |
| `screen_detection_skipped` | boolean | optional，有時冇 | `true` |
| `state_change_seq` | number | **單調遞增序號**，change detection 用 | `436` |
| `tab_id` | string | 格式 `wN:tN` | `"w4:t4"` |
| `terminal_id` | string | internal terminal ID | `"term_6583335747afb4"` |
| `terminal_title` | string | 完整 title（可能有 padding） | `"π - dom"` |
| `terminal_title_stripped` | string | stripped title | `"π - dom"` |
| `workspace_id` | string | workspace ID | `"w4"` |

**Mirror pane（remote agent）額外字段**：`display_agent`（如 `"claude"`）、`title`（代替 `terminal_title`）、`cwd` 指向 `.mirror-pane`。

### agent_session 子結構
```json
{
  "agent": "pi",
  "kind": "id",         // "id" | "path"
  "source": "herdr:pi", // 命名空間
  "value": "session_268b54bb-..." // session ID 或 file path
}
```

### bot.js 使用建議
- **狀態監測主入口**：poll `herdr agent list`，比較 `state_change_seq` detect 變化
- 用 `pane_id` 做唯一 key（同一 agent type 可能有多個 pane，如兩個 `pi`）
- `agent_status` 係 risk-tier 判斷嘅第一步：`blocked` → 觸發 approval flow

---

## 2. `herdr agent get <target>` — 查單個 agent

### 命令
```
herdr agent get <target>
```
`<target>` = pane_id（如 `w4:p2`）

### 輸出結構
```json
{
  "id": "cli:agent:get",
  "result": {
    "type": "agent_info",
    "agent": { <AgentInfo> }
  }
}
```

AgentInfo 字段同 §1 完全一致。bot.js 用唔着呢個（agent list 已夠），但可用於 single-agent 快速查詢。

---

## 3. `herdr agent wait <target> --until <status> --timeout <ms>`

### 命令
```
herdr agent wait <TARGET> [--until <STATUS>...] [--timeout <MS>]
```

| Option | 說明 |
|--------|------|
| `--until <STATUS>` | 要 match 嘅狀態，可重複（`--until blocked --until done`）。possible values: `idle`, `working`, `blocked`, `done`, `unknown` |
| `--timeout <MS>` | 幾多 ms 後 fail。**唔寫 = 無限等** |

**預設行為**（冇 `--until`）：match `idle`, `done`, 或 `blocked`。

### Timeout 行為（實測）
```
$ herdr agent wait w4:p2 --until blocked --timeout 3000
{"error":{"code":"timeout","message":"timed out waiting for agent status"},"id":"cli:agent:wait"}
$ echo $?
1
```

### bot.js 使用建議
- **Blocked detection 主通道**：每個 agent 起一條 `herdr agent wait <pane_id> --until blocked --timeout <MS>` waiter
- Timeout 後 wrap retry（exponential backoff，PLAN.md Sola #2 要求）
- 成功返回時（status matched）：預期 `{"id":"cli:agent:wait","result":{"type":"ok",...}}`（timeout 路徑已確認，成功路徑未實測但格式一致）
- **重要**：wait 只係通知你「agent blocked 咗」，要知 *點解* blocked 要再 call `agent read`

---

## 4. `herdr agent read <target>` — 讀 agent terminal 輸出

### 命令
```
herdr agent read <TARGET> [OPTIONS]
```

| Option | Values | 說明 |
|--------|--------|------|
| `--source` | `visible`, `recent`, `recent-unwrapped`, `detection` (default: `recent`) | snapshot 來源 |
| `--lines <N>` | number | 限制行數（從底部數） |
| `--format` | `text`, `ansi` | 輸出格式 |
| `--ansi` | flag | 保留 ANSI escape codes |

> ⚠️ **輸出係純 text，唔係 JSON！** 有 box drawing characters（╭╮╰╯│─）。

### Source 對比

| Source | 特點 | bot.js 用途 |
|--------|------|-------------|
| `recent-unwrapped` | 純 screen text，最乾淨 | **首選**——parse approval prompt |
| `recent` | wrapped 版本 | 唔建議 |
| `visible` | 只係 viewport 可見部分 | 唔建議 |
| `detection` | herdr detection engine 用嘅 snapshot | 可選，同 recent-unwrapped 差唔多 |

### Blocked screen 實例（claude w5:p2，real data）

`herdr agent read w5:p2 --source recent-unwrapped --lines 10` 輸出：
```
   Create fixture tree with escaping symlink

 Compound command contains cd with write operation - manual approval required to prevent path resolution bypass

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for similar commands in /home/dom
   3. No

 Esc to cancel · Tab to amend · ctrl+e to explain
```

### Approval Prompt 特徵（parse 用）
- **觸發詞**：`"Do you want to proceed?"`, `"manual approval required"`, `"Allow"`, `"Deny"`
- **選項格式**：編號列表（`1. Yes`, `2. No`），`❯` 標記當前游標
- **keybinding hint 行**：底部有 `Esc to cancel`, `Tab to amend`, `ctrl+e to explain`
- **risk 關鍵詞**（從 description 行提取）：`write operation`, `delete`, `network`, `push`, `shell`, `path resolution bypass`

### bot.js 使用建議
- Blocked agent → `agent read --source recent-unwrapped --lines 15-20` → extract approval description
- 用正則 / 關鍵詞匹配做 risk-tier 分類（Clara 嘅 classify.js 負責）
- **唔好依賴 `terminal_title`** 做 risk 判斷——佢只係 prompt 開頭幾個字，資訊唔夠

---

## 5. `herdr agent send-keys <target> <key>...` — 發送按鍵

### 命令
```
herdr agent send-keys <TARGET> <KEY>...
```
多個 key 用空格分隔。`esc` = Escape canonical name（`escape` 亦接受）。

### 回傳（實測）
```
$ herdr agent send-keys w4:p8 esc
{"id":"cli:agent:send-keys","result":{"type":"ok"}}
$ echo $?
0
```

### bot.js 使用建議
- **Approval callback 執行通道**：Dom 批准後，用 send-keys 回覆 approval prompt
  - 批准：`herdr agent send-keys <pane_id> Enter`（選當前 `❯` 指向嘅選項）
  - 拒絕：`herdr agent send-keys <pane_id> esc`
  - 選特定選項：可能需要先 `Up`/`Down` 再 `Enter`
- 留意：send-keys 唔會 wait agent 反應，要自己 poll 狀態變化

---

## 6. `herdr agent prompt <target> <text>` — 提交 prompt

### 命令
```
herdr agent prompt <TARGET> <TEXT> [--wait] [--until <STATUS>...] [--timeout <MS>]
```

| Option | 說明 |
|--------|------|
| `--wait` | 等提交後第一個 matching state |
| `--until <STATUS>` | 同 wait，可重複。預設 match `idle`, `done`, `blocked` |
| `--timeout <MS>` | timeout。唔寫 = 無限等 settle |

**`--wait` 特殊行為**：如果 agent 從 non-working state 開始，5 秒內要觀察到狀態變化，否則返回 `agent_prompt_stalled`。

### 回傳（未實測——怕影響 fleet）
從 help 推斷 + send-keys pattern：
- 即時（冇 `--wait`）：`{"id":"cli:agent:prompt","result":{"type":"ok"}}`
- stalled error：`{"error":{"code":"agent_prompt_stalled",...},"id":"cli:agent:prompt"}`
- timeout error：`{"error":{"code":"timeout",...},"id":"cli:agent:prompt"}`

### bot.js 使用建議
- bot 本身唔需要主動 prompt agent（嗰係 Diana orchestrator 嘅活）
- 但如果 Dom 想經 Telegram 遠端 prompt 某個 agent，bot 可以代勞
- 建議加 `--wait --timeout 5000` 確認 prompt 被 agent 接收到

---

## 7. `herdr agent explain <target> --json` — Detection state 詳解

### 命令
```
herdr agent explain [TARGET] [--json] [--format text|json] [-v]
```

### 輸出（實測，`--json`）
```json
{
  "agent": "kimi",
  "state": "idle",
  "visible_blocker": false,
  "visible_idle": false,
  "visible_working": false,
  "screen_detection_skipped": true,
  "screen_detection_skip_reason": "full_lifecycle_hook_authority",
  "evaluated_rules": [],
  "matched_rule": null,
  "fallback_reason": null,
  "local_override_shadowing_remote": false,
  "manifest_source": null,
  "manifest_version": null,
  "cached_remote_version": null,
  "remote_update_status": null,
  "remote_update_error": null,
  "skip_state_update": false,
  "skipped_update_reason": null,
  "warning": null
}
```

### bot.js 使用建議
- **Debug 用**：如果 agent_status 同預期不符，用 explain 睇 detection 點解咁判
- `screen_detection_skip_reason` = `"full_lifecycle_hook_authority"` → agent 自己報狀態（唔靠 screen parsing），可信度更高
- bot.js 正常運行唔需要 call explain，但可以喺 debug mode 開放 `/explain <pane_id>` 命令畀 Dom

---

## 8. `herdr api snapshot` — 完整 session snapshot

### 命令
```
herdr api snapshot
```

### 輸出結構（比 agent list 豐富）
```json
{
  "id": "cli:api:snapshot",
  "result": {
    "type": "session_snapshot",
    "snapshot": {
      "agents": [...],      // 同 agent list 一樣
      "panes": [...],       // 多咗 scroll + label
      "tabs": [...],        // 有人類可讀 label
      "workspaces": [...],
      "layouts": [...],
      "focused_pane_id": "w4:p4",
      "focused_tab_id": "w4:t4",
      "focused_workspace_id": "w4",
      "protocol": 19,
      "version": "0.8.0-preview..."
    }
  }
}
```

### Pane 額外字段（vs agent list）
- `label`: string — 人類可讀名（如 `"pi DS4"`, `"Kimi"`, `"GLM"`, `"Grok"`, `"Gemini"`, `"Mimimax"`, `"Claude"`, `"Codex"`）
- `scroll`: object — `{ "max_offset_from_bottom": N, "offset_from_bottom": N, "viewport_rows": N }`

### Tab 字段
```json
{
  "tab_id": "w4:t4",
  "workspace_id": "w4",
  "label": "DeepSeek",     // 人類可讀 tab 名
  "number": 4,
  "agent_status": "working",
  "pane_count": 1,
  "focused": true
}
```

### bot.js 使用建議
- 如果要一次過攞 agents + pane labels + tab labels，用 snapshot 慳過分開 call
- `label` 可以用嚟 Telegram 通知嘅顯示名（`"DeepSeek (w4:p4) blocked"`）
- 但日常 polling 用 `agent list` 就夠（輕量啲）

---

## 9. `herdr api schema` — API schema 文檔

```
herdr api schema --json     # 完整 JSON schema
herdr api schema --output PATH  # 寫入 file
```

Protocol 19, schema_version 1。包含 `error_response`, `event`, `request`, `subscription_event`, `success_response` 嘅完整 JSON Schema。

> bot.js 唔直接需要，但如果要做 event subscription（WebSocket？）可以參考 `subscription_event` schema。

---

## 10. Summary — bot.js 實作速查

### 核心調用鏈

```
┌─────────────────────────────────────────────────────┐
│  Detection Loop                                      │
│                                                      │
│  for each agent:                                     │
│    herdr agent wait <pane_id> --until blocked        │
│      --timeout <MS>    ← 主通道，event-driven        │
│                                                      │
│  + 30s poll:                                         │
│    herdr agent list   ← 補漏 + done/idle 通知        │
│    比較 state_change_seq detect 變化                  │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼ agent blocked
┌─────────────────────────────────────────────────────┐
│  Read & Classify                                     │
│                                                      │
│  herdr agent read <pane_id> --source recent-unwrapped│
│    --lines 20                                        │
│  → 純 text output → Clara 嘅 classify.js 判 tier    │
└──────────────────────┬──────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────┐
│  Policy Decision                                     │
│                                                      │
│  Tier 0 (read-only):     → auto-approve, log        │
│  Tier 1 (test/build):    → auto-approve argv allow  │
│  Tier 2 (write/shell):   → Telegram 問 Dom           │
│  Hard block:             → 永遠問 Dom                │
└──────────────────────┬──────────────────────────────┘
                       │ Dom callback (approve/deny)
                       ▼
┌─────────────────────────────────────────────────────┐
│  Execute Callback                                    │
│                                                      │
│  approve: herdr agent send-keys <pane_id> Enter      │
│  deny:    herdr agent send-keys <pane_id> esc        │
│  select:  herdr agent send-keys <pane_id> Down Enter │
└─────────────────────────────────────────────────────┘
```

### JSON vs Text 速查

| 命令 | 輸出格式 | parse 方式 |
|------|----------|-----------|
| `agent list` | JSON | `JSON.parse()` |
| `agent get` | JSON | `JSON.parse()` |
| `agent wait` | JSON (success/error) | `JSON.parse()` + check `error.code` |
| `agent read` | **純 text** | regex / string matching |
| `agent send-keys` | JSON | `JSON.parse()` |
| `agent prompt` | JSON | `JSON.parse()` |
| `agent explain --json` | JSON | `JSON.parse()` |
| `api snapshot` | JSON | `JSON.parse()` |

### pane_id 格式
- `<workspace_id>:<pane_number>`，如 `w4:p4`
- workspace `w4` = local，`w5` = vcvps mirror
- 同一 agent type 可以有多個 pane（兩個 `pi`），**一定要用 pane_id 做 unique key**

### state_change_seq
- 單調遞增 integer
- 每次 agent 狀態變化都會 +1（或跳幾個）
- **change detection 利器**：poll agent list 時記住上次 seq，只處理 seq 變咗嘅 agent

---

## 11. 待確認事項（bot.js 實作時再測）

1. **`agent wait` 成功路徑嘅確切 JSON**（目前只確認咗 timeout error 路徑）
2. **`agent prompt` 回傳格式**（未實測，怕副作用）
3. **send-keys 多鍵組合**（如 `Down Enter`）係咪一次 call 搞掂，定要分開
4. **approval prompt 選項導航**：`❯` 指向邊個 option 係 default？send-keys `Enter` 係咪等同揀當前 `❯`？
5. **agent read 嘅 `--lines` 係由頂定由底數**（目前觀察似由底，但要確認）

---

*End of notes — Gia, 2026-08-06*

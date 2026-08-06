# Release review — new-user onboarding (Nova)

**Reviewer:** Nova (Grok 4.5)  
**Date:** 2026-08-06  
**Lens:** First-time user who never saw fleet chat / PLAN.md. Only README + files on disk.  
**Artifacts read:** `README.md`, `bot.js` (~1200 lines), `policy.json`, `research/classify.js` (header + exports), `.gitignore`, tree layout.

---

## Verdict (one line)

**Ship-ready as Dom-internal shadow MVP; not clone-and-run ready for strangers.** README under-explains the hard parts; `policy.json` looks editable but is mostly **documentation theatre** today.

---

## Simulated onboarding path (what breaks)

### Step 0 — “Clone the repo”

| Friction | Severity | Notes |
|----------|----------|--------|
| **No remote / no commits on `main`** (local snapshot) | 🔴 | `git status` shows untracked tree; a public user cannot `git clone github.com/...` yet. README assumes `~/projects/herdr-telegram-gate` path. |
| **No `package.json` / no LICENSE / no version tag** | 🟡 | Zero-dep is fine, but “Node project” without metadata feels unfinished; no license = legal fog for reuse. |
| **No `.env.example`** | 🔴 | User must invent env keys from prose; easy typo (`OWNER` vs `TELEGRAM_OWNER_ID`). |
| **`.gitignore` thin** | 🟡 | Ignores `.env` + `*.log` only. Does **not** ignore `state.json`, `bot.pid`, `tmp-test/`, `audit.log` already tracked-ish as local. New user may commit secrets-adjacent runtime state. |

### Step 1 — Prerequisites

| Friction | Severity | Notes |
|----------|----------|--------|
| **herdr binary path fixed preference** | 🟡 | Code prefers `~/.local/bin/herdr`, else `herdr` on PATH. README matches, but no install link to herdr.dev. |
| **“herdr server running” is vague** | 🔴 | New user doesn’t know: open `herdr` once? headless `herdr server`? which session? What error if socket missing? |
| **`HERDR_SOCKET_PATH` documented but not really used** | 🟡 | `bot.js` stores it then drives **CLI** (`execFile(herdr, …)`), not the socket. Env var is misleading cargo-cult. |
| **Node ≥ 18 only** | 🟢 | Fair; no check beyond runtime features. |

### Step 2 — Telegram setup

| Friction | Severity | Notes |
|----------|----------|--------|
| **How to get `TELEGRAM_OWNER_ID`?** | 🔴 | README never says. Common answers (`@userinfobot`, `getUpdates`) missing → bot starts, then **silently ignores all messages** from non-owner (fail-closed, correct, but looks “broken”). |
| **BotFather steps missing** | 🟡 | Token mentioned; no `/newbot`, privacy mode, or “must DM the bot first” note. |
| **Must use private DM to owner ID as chat** | 🟡 | Callbacks verify `from.id` **and** `chat.id` both == OWNER_ID → **groups will never work**. Not stated. |
| **No mention of single long-poller** | 🟡 | Two `node bot.js` → Telegram 409 conflict. `bot.pid` exists but README never says “one process only” or how to stop. |

### Step 3 — Run

```bash
cd ~/projects/herdr-telegram-gate
node bot.js
```

| Friction | Severity | Notes |
|----------|----------|--------|
| **Hard-coded home path in README** | 🟡 | Clone to `/tmp/foo` still works (uses `__dirname`), but README trains wrong habit. |
| **Success = Telegram “online” message** | 🟢 | Good UX if env OK. |
| **No “expected first blocked approval” walkthrough** | 🔴 | User runs bot, fleet idle, sees nothing, thinks it failed. Missing: trigger a blocked agent, what card looks like, Approve vs Deny keys (`enter` / `esc`). |
| **Shadow mode jargon** | 🔴 | README says SHADOW; card shows `[SHADOW]`. New user doesn’t know: *auto-approve is off; every block pings you; classifier tier is for logging only.* “When do I turn it off?” / “How?” = hardcoded `SHADOW_MODE = true` in `bot.js` — **not in policy.json**, not env. |
| **Mirror panes silently skipped** | 🟡 | Comment in code: herdr-mirror remote agents not controllable. README silent → remote fleet users confused. |

### Step 4 — Configure policy

| Friction | Severity | Notes |
|----------|----------|--------|
| **`policy.json` rules do not drive classify** | 🔴 **Critical honesty gap** | `bot.js` only reads `version`, `approval_ttl_seconds`, `workspace_root`. Risk decisions live in **`research/classify.js` hardcoded sets** (`READ_VERBS`, `TEST_BUILD_ALLOWLIST`, fixed `~/projects`). Editing `policy.json` rules **changes almost nothing**. README table claims “Risk-tier policy (versioned)” → false expectations. |
| **Dual workspace roots** | 🔴 | `policy.json` `workspace_root: "~/projects"` used by bot wrappers; `classify.js` has own `WORKSPACE_ROOT = path.resolve(homedir, 'projects')`. Drift risk if user edits one. |
| **Tier labels need a legend** | 🟡 | T0/T1/T2 appear on cards; README never defines human meaning in one table at top. |
| **Bilingual rule descriptions** | 🟢/🟡 | Fine for Dom; stranger may find mixed 粵/EN odd without project context. |
| **JSON vs “user-friendly”** | 🟡 | Structure is readable for engineers; no comments allowed in JSON; no schema doc linked from README (draft lives under `research/`). No `policy validate` command. |

### Step 5 — Day-to-day use

| Friction | Severity | Notes |
|----------|----------|--------|
| **Commands OK but thin** | 🟡 | `/status` `/pending` `/help` — no `/id`, no `/version`, no `/policy`, no “why shadow”. |
| **Approve = send-keys Enter; Deny = Esc** | 🟡 | Agent UIs that use different keys may mis-fire; not documented per agent kind. |
| **5-minute TTL** | 🟡 | `approval_ttl_seconds: 300` — not called out in README; expired cards feel flaky. |
| **Extract failures** | 🟡 | Card can show `(no command extracted)` — user has no recovery guide (“open pane / approve in terminal”). |
| **Audit trail** | 🟢 | `audit.log` exists; README mentions it; no sample line or how to review. |

---

## README: what’s good

1. Clear product one-liner + **current mode SHADOW** upfront (honest).
2. Zero-dep / single process — matches maker mindset.
3. Architecture ASCII + Safety bullets build trust for security-minded users.
4. File table is useful once the tree is understood.

## README: gaps / hard-to-parse (priority fixes)

1. **End-to-end “first approval in 10 minutes”** tutorial (BotFather → owner id → herdr up → run bot → force a blocked pane → Approve).
2. **Env template file** + how to obtain owner id.
3. **What Shadow means / how to disable later** (env flag preferred over code edit).
4. **Honest policy story:** “`policy.json` today = TTL + workspace root + version; rules are *intent* for vNext; live classifier is `research/classify.js`.” Or wire rules for real.
5. **Operational notes:** one process, `bot.pid`, logs, stop/restart, no group chats.
6. **Install herdr** link + “agents must be local (not mirror) for Approve.”
7. **Tier table** (0 auto / 1 auto+log / 2 always ask) next to Shadow caveat.
8. Don’t hardcode `~/projects/...` in Run section — use `$REPO` / relative.

---

## policy.json user-friendliness

| Aspect | Score | Comment |
|--------|-------|---------|
| Glanceable structure | ✅ | `version`, `workspace_root`, `approval_ttl_seconds`, `defaults`, `rules[]` is intuitive. |
| Rule DSL | ⚠️ | `match.argv` + `paths_under_workspace` + `forbid_args_matching` + `manual` is good **if enforced**. Today not loaded → **dangerously misleading**. |
| Discoverability of effect | ❌ | No README: “edit → restart bot → which field applies”. |
| Completeness vs classify.js | ❌ | classify has more allowlist entries (cargo, go, yarn, pnpm, `npm run test`, git log/show…) than policy.json rules. Two sources of truth. |
| Non-engineer friendly | ❌ | Needs either comments in a `policy.example.json5` or a short “Policy cookbook” section. |

**Recommendation:** Either (a) **wire `policy.rules` into classify** before marketing the file, or (b) **rename/slim policy.json** to only live knobs (`version`, `ttl`, `workspace_root`, `shadow_mode`) and move rule aspirational list to `docs/policy-intent.md`.

---

## New-user onboarding issue checklist (actionable)

### P0 — wrong or missing safety/UX truth

- [ ] Document that **auto-approve is OFF** (shadow); tier labels are advisory until shadow is flipped.
- [ ] Document **how to get `TELEGRAM_OWNER_ID`** and that **DM-only** (chat id must equal owner).
- [ ] Add **`.env.example`** with all three keys + comments.
- [ ] Fix honesty: **`policy.json` rules unused** vs classifier hardcode — pick one truth.
- [ ] Align **workspace root** (single source: policy → inject into classify).

### P1 — clone / run friction

- [ ] First-run walkthrough in README (happy path + expected Telegram card screenshot text).
- [ ] herdr install + “server must be running” smoke command (`herdr agent list`).
- [ ] Expand `.gitignore`: `state.json`, `bot.pid`, `audit.log`, `tmp-test/`, `*.pid`.
- [ ] Explain **Approve/Deny keys**, TTL, and failure modes (expired, TOCTOU abort messages).
- [ ] Note **mirror panes** not controlled; multi-instance Telegram conflict.

### P2 — polish

- [ ] `SHADOW_MODE` via env (`GATE_SHADOW=1`) not code constant.
- [ ] `/help` includes shadow + policy version + workspace root.
- [ ] package metadata optional: `"engines": {"node":">=18"}`, LICENSE (MIT if public).
- [ ] Tier legend + example `audit.log` line.
- [ ] Remove or gate Dom-specific copy (“by Dom”) for generic users → “by owner”.
- [ ] Link PLAN/research as optional deep-dive, not required reading.

---

## Suggested README skeleton (minimal rewrite)

```markdown
# herdr-telegram-gate
What it is (1 para) + Shadow mode warning.

## 10-minute setup
1. Install Node 18+, herdr; start herdr
2. BotFather → token
3. Get numeric user id (link)
4. cp .env.example .env && edit
5. node bot.js → expect Telegram “online”
6. Block any agent → Approve/Deny

## What you will see
Card fields + tier meaning + shadow = always ask

## Commands
/status /pending /help

## Config
.env keys | policy.json (what actually applies today) | state/audit

## Safety model
whitelist, TOCTOU, fail-closed, no groups, one poller

## Limits
local agents only; extract may fail; shadow before auto
```

---

## Nova bottom line for Diana / Dom

| Question | Answer |
|----------|--------|
| Can a stranger clone and succeed? | **Not yet** — missing public repo packaging + owner-id + first blocked walkthrough. |
| Is README the main problem? | **Half** — also product honesty (`policy.rules` dead, shadow hardcoded). |
| Is policy.json user-friendly? | **Looks yes, behaves no** until rules drive classify or file is slimmed. |
| Block release to Dom personally? | **No** — fine for Dom who already knows the stack. |
| Block public/share release? | **Yes** until P0 checklist done. |

*Method note: review is static + code/config cross-check, not a live BotFather install from a clean VM. Highest-severity finding is policy/classifier dual truth, verified by reading `bot.js` load path (only TTL/workspace/version) vs `research/classify.js` constants.*

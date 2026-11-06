# herdr-telegram-gate

A Telegram approval gate for your [herdr](https://herdr.dev) AI agent fleet — one zero-dependency Node.js process that watches your agents, classifies what they're asking to do by risk, and puts every consequential decision in your Telegram inbox.

## Features

- **Shadow mode** — the risk classifier runs silently alongside a human-approves-everything flow, logging what it *would* have decided vs. what you actually approved. Collect real data before trusting automation.
- **Risk-tiered auto-approval** — a versioned `policy.json` sorts every action into Tier 0 (read-only, auto), Tier 1 (allowlisted test/build commands, auto + log), or Tier 2 (everything else → ask you). Fail-closed by design: anything unparseable escalates.
- **Approval inbox** — blocked agents show up as Telegram cards with **✅ Approve / ❌ Deny** inline buttons. Approving sends `Enter` to the agent's pane; denying sends `esc`. Pending approvals survive restarts.

## Do you have herdr yet?

**No** → install herdr first: see [herdr.dev](https://herdr.dev) or the [herdr GitHub repo](https://github.com/herdrdev/herdr). Come back when `herdr agent list` works.

**Yes** → you're ready. This bot sits next to herdr and talks to it through the `herdr` CLI.

## Prerequisites

- Node.js >= 18 (no npm dependencies — `node bot.js` is the whole thing)
- herdr installed (`~/.local/bin/herdr` or on `$PATH`) with its server running
- A Telegram account

## Telegram setup

1. **Create the bot**: message [@BotFather](https://t.me/BotFather) → `/newbot` → follow the prompts → copy the token it gives you.
2. **Get your user ID**: message [@userinfobot](https://t.me/userinfobot) — it replies with your numeric ID. This is the whitelist: only this ID can talk to the bot.
3. Find your herdr socket path (usually `~/.config/herdr/herdr.sock`).

## Install

```bash
git clone https://github.com/hkdom/herdr-telegram-gate.git
cd herdr-telegram-gate

cat > .env <<'EOF'
TELEGRAM_BOT_TOKEN=<token from @BotFather>
TELEGRAM_OWNER_ID=<your numeric user ID>
HERDR_SOCKET_PATH=/Users/<you>/.config/herdr/herdr.sock
EOF
chmod 600 .env

node bot.js
```

You should get a Telegram message from your bot saying it started, in shadow mode.

## Usage

| Command | What it does |
|---------|--------------|
| `/status` | Live status of every agent (idle / working / blocked / done) |
| `/pending` | Approvals waiting on you, with time until expiry |
| `/help` | Command list |

When an agent blocks on a permission prompt, you get an **approval card**: who (agent + project), what (action + target path), why it's being asked (policy rule), and a countdown (approvals expire after 5 minutes by default). Tap **✅ Approve** or **❌ Deny**.

Example card:

```
🔒 Approval Required [SHADOW]
Agent: Ivy (w4:p2) · herdr-telegram-gate
Command: write /Users/you/projects/.../capture-test.txt
Target: /Users/you/projects/.../capture-test.txt
Blast: 1 file
🔴 T2 escalate · structured_write
寫入 workspace 內檔案
⏰ 4:32 · 🔑 a3f8b2c1

[ ✅ Approve ] [ ❌ Deny ]
```

## Security model

The bot treats everything an agent shows it as untrusted. Concretely:

- **Fail-closed** — parse failure, ambiguous commands, unknown verbs, symlinked paths, or any internal error → Tier 2 (ask the human). The default in `policy.json` is hardwired to escalate.
- **TOCTOU revalidation** — between you tapping Approve and the bot pressing Enter, the pane is re-read and re-checked in 6 steps: agent still blocked, same session, same argv hash, same canonical target path. Anything changed → refuse.

  Immediately before sending Enter or Escape, the bot reads the request again and refuses if it changed or cannot be read. Herdr does not offer an atomic read-and-press operation, so the pane could still change in the small interval between that last read and the keypress. A stale request is checked again and escalated; shadow mode remains recommended.
- **Anti-replay** — every approval has a random opaque ID (SHA-256 action hash recorded for audit tracking). Every callback re-verifies `from.id`, chat ID, pending ID, and expiry, then consumes the pending atomically exactly once. The callback carries only the opaque pending ID — the server looks up what to approve; nothing executable travels in callback data.
- **Redaction** — tokens, API keys, `Bearer` strings, and private keys are scrubbed from everything the bot **displays on Telegram** (approval cards, `/pending`, status). Note: `audit.log` and the console retain raw argv by design — `audit.log` is a sensitive internal log, don't share it.
- **Owner whitelist** — messages from any other Telegram user are ignored and logged.

Shadow mode is the ultimate safety net: until you turn it off, the bot can approve *nothing* on its own.

## Visual feedback

The companion `scripts/tg-visual` sends images with **Approve** and **Changes** buttons. The bot records each choice in `visual-feedback.jsonl` in its working directory, including the image caption, message ID and time. On **Changes**, reply to the bot's prompt with one line; that reply is recorded with the same message ID. Visual buttons never send keys to an agent pane. Only the configured Telegram owner can submit feedback. Treat the log as private because captions and replies may contain project details.

After deploying the bot code, the coordinator should restart `herdr-telegram-gate.service`, then install the updated sender at `~/.agents/bin/tg-visual`. Until then, the installed sender and running bot keep their existing behavior.

## policy.json

The policy is a single versioned JSON file (schema draft: `research/policy-schema.draft.json`):

- `defaults.tier` is `2` — unmatched actions escalate. Don't change this.
- `rules` match in order, first match wins. Each rule matches a **structured argv prefix** (`["npm", "test"]` matches `npm test` but not `npm test-publish`), never shell strings or regexes.
- **Rules are additive restrictions only**: they can escalate a decision (e.g. `manual: true`) but can never lower a tier already decided by the built-in classifier. The safety floor is hardcoded and non-disableable.
- Tier 0 auto-approve requires every path argument to resolve via `realpath` — if a path can't be resolved (e.g. missing file), the action escalates instead (fail-closed).
- `paths_under_workspace: true` requires every path argument to canonicalize (realpath, no symlinks) under `workspace_root`, or the rule doesn't match.
- Rules with `manual: true` (e.g. `git push`, `rm`) are always-human, even after shadow mode ends.
- Every decision is written to `audit.log` with the policy version and matched rule ID. Bump `version` whenever you edit rules.

## From shadow to auto-approve

> **Classifier validation status (read this before trusting auto-approve):** the risk
> classifier scores 68/69 (98.6%) on its corpus with **0 unsafe→safer false negatives**, and
> 2,758 property-based fuzz cases with 0 violations. However, the corpus is built from
> **reconstructed prompt layouts plus 2 genuinely captured panes — none captured in a
> live blocked state**. Extraction against real blocked panes is exactly what shadow
> mode collects. Treat the numbers as a lower-bound statement, not a guarantee:
> run shadow mode until the card you see matches the pane you're approving.

1. Run in shadow mode (the default). Every block goes to Telegram; the classifier's opinion is logged alongside your decision.
2. After enough data, diff the classifier's tiers against your actual approvals in `audit.log`. The KPI that matters: **unsafe→safer false negatives must be 0** (the classifier must never auto-approve something you would have rejected).
3. Only then set `"shadow_mode": false` in `config.json` (copy `config.example.json` first). Tier 0/1 start auto-approving; Tier 2 and `manual` rules still come to you.
4. Keep watching `audit.log`. Tightening rules later is one edit + restart.

## FAQ

**The bot doesn't respond to my messages.**
Check, in order: (a) `TELEGRAM_OWNER_ID` matches your numeric ID exactly — messages from anyone else are silently ignored; (b) only one instance is running (`409 Conflict` in `bot.log` means Telegram is refusing a second poller); (c) the token in `.env` has no whitespace or quotes.

**No approval card appears when an agent blocks.**
Confirm the bot sees herdr: `/status` should list your agents. If it's empty, check `HERDR_SOCKET_PATH` and that the herdr server is running. Also check `bot.log` for waiter retry loops.

**The card says the command couldn't be extracted.**
Expected in shadow mode — extraction is best-effort and anything unparseable simply escalates (fail-closed). The card shows the visible approval screen when available. If it is truncated or unclear, inspect the pane before deciding. If extraction fails *consistently* for one agent's prompt style, that's a parser gap — file an issue with a (redacted) pane sample.

**I tapped Approve and it said "stale / changed".**
That's the TOCTOU revalidation working: the pane changed between the card being sent and your tap. The bot refused rather than approve something you didn't see. The visible screen must still match the screen on the card. Ask the agent again or check what it's doing now.

The card includes the full captured viewport because prompt-like text can occur inside a command. Any viewport change, including an unrelated banner change, makes the old card stale and triggers a new check. If a card says the screen was truncated, neither button sends a key. Inspect the pane and handle the request there; a shortened card cannot safely represent the complete request.

**I restarted the bot and got duplicate cards.**
On restart the bot reconciles `state.json` against live agent state. Pending approvals for panes that remain blocked are replaced with new cards. Old buttons no longer work. Consumed, expired, and no-longer-blocked entries are removed from state.

**Does it need a webhook / public URL?**
No. It uses Telegram long polling outbound-only — works behind NAT with no open ports.

## Files

| File | Purpose |
|------|---------|
| `bot.js` | The whole bot: Telegram polling + herdr waiters + policy engine |
| `policy.json` | Risk-tier policy (versioned, audit-logged) |
| `state.json` | Pending approvals (atomic write, survives restart) |
| `audit.log` | Append-only decision log, JSON Lines — **contains raw argv; treat as a sensitive internal log, don't share it** |
| `research/` | Classifier, validation corpus, design notes |

## License

MIT — see [LICENSE](LICENSE).

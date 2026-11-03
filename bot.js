#!/usr/bin/env node
'use strict';

/**
 * herdr-telegram-gate — bot.js
 *
 * Single-process, zero-dependency Telegram approval gate for herdr agents.
 * Node >= 18.  MVP runs in SHADOW MODE: every blocked agent escalates to
 * Telegram regardless of classify() tier, but the classifier's decision is
 * logged so we can compare it against what the owner actually approves.
 *
 * Usage:  node bot.js           — start the bot
 *         node bot.js --doctor  — run preflight checks and exit
 *
 * Env (.env, gitignored — copy .env.example):
 *   TELEGRAM_BOT_TOKEN   — bot token from @BotFather
 *   TELEGRAM_OWNER_ID    — owner's numeric Telegram user ID (whitelist)
 *   HERDR_SOCKET_PATH    — herdr socket path (auto-detected if omitted)
 *
 * Optional config (config.json — copy config.example.json):
 *   shadow_mode      — true = all escalate (MVP), false = auto-approve T0/T1
 *   owner_name       — display name in Telegram messages
 *   agent_aliases    — map herdr agent names to friendly names
 */

// ─── imports ──────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { execFile } = require('child_process');

const ROOT = __dirname;
const STATE_FILE = path.join(ROOT, 'state.json');
const AUDIT_FILE = path.join(ROOT, 'audit.log');
const VISUAL_FEEDBACK_FILE = path.join(ROOT, 'visual-feedback.jsonl');
const POLICY_FILE = path.join(ROOT, 'policy.json');
const CONFIG_FILE = path.join(ROOT, 'config.json');

const { classify } = require('./research/classify.js');

// ─── config ───────────────────────────────────────────────────────────────

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  let content;
  try { content = fs.readFileSync(envPath, 'utf8'); }
  catch { content = ''; }
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!process.env[key]) process.env[key] = val;
  }
}
loadEnv();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID  = process.env.TELEGRAM_OWNER_ID;
const HERDR_SOCKET = process.env.HERDR_SOCKET_PATH || path.join(os.homedir(), '.config/herdr/herdr.sock');

// ─── config (agent aliases, owner name, shadow mode) ──────────────────────

let CONFIG = { shadow_mode: true, owner_name: 'Owner', agent_aliases: {} };
try {
  CONFIG = { ...CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) };
} catch (e) {
  if (e.code !== 'ENOENT') console.error(`WARNING: config.json: ${e.message}, using defaults`);
}
const OWNER_NAME = CONFIG.owner_name || 'Owner';
const SHADOW_MODE = CONFIG.shadow_mode !== false;

/** Display-friendly name from config.json agent_aliases. */
function agentDisplayName(name) {
  return CONFIG.agent_aliases?.[name] || name;
}

// ─── herdr binary resolution ──────────────────────────────────────────────

function findHerdrBin() {
  for (const c of [
    path.join(os.homedir(), '.local/bin/herdr'),
    '/usr/local/bin/herdr',
    '/opt/homebrew/bin/herdr',
  ]) if (fs.existsSync(c)) return c;
  return 'herdr';
}
const HERDR_BIN = findHerdrBin();

function herdrBinAvailable() {
  if (HERDR_BIN !== 'herdr') return fs.existsSync(HERDR_BIN);
  try {
    require('child_process').execFileSync(HERDR_BIN, ['--version'], { timeout: 5000, stdio: 'pipe' });
    return true;
  } catch { return false; }
}

// Timing
const WAIT_TIMEOUT_MS   = 30_000;   // herdr agent wait --timeout
const EXEC_TIMEOUT_MS   = 40_000;   // execFile wrapper for wait
const QUICK_TIMEOUT_MS  = 10_000;   // execFile for list/read/send-keys
const POLL_INTERVAL_MS  = 30_000;   // low-freq agent list poll
const TG_POLL_TIMEOUT   = 30;       // Telegram long-poll seconds

// ─── utilities ────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function ts() { return new Date().toISOString(); }

function log(msg) {
  const line = `[${ts()}] ${msg}`;
  console.log(line);
}

function atomicWriteJSON(file, data) {
  const tmp = file + '.tmp.' + process.pid + '.' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** SHA-256 action hash. Binds agent + project + argv + target + pending-id. */
function actionHash({ agent, project, argv, target, id }) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ a: agent, p: project, v: argv, t: target || '', i: id }))
    .digest('hex');
}

// ─── herdr CLI wrapper ────────────────────────────────────────────────────

/**
 * Run a herdr subcommand that returns JSON.
 * @returns {Promise<object>} parsed result.result
 */
function herdrJSON(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(HERDR_BIN, args, { timeout: timeoutMs || QUICK_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const raw = (stdout || '').trim();
      if (raw) {
        let parsed;
        try { parsed = JSON.parse(raw); } catch { /* not JSON */ }
        if (parsed) {
          if (parsed.error) {
            const e = new Error(parsed.error.message || 'herdr error');
            e.code = parsed.error.code;
            e.stderr = (stderr || '').trim();
            reject(e);
            return;
          }
          if (parsed.result) { resolve(parsed.result); return; }
        }
      }
      if (err) {
        // execFile timeout or non-zero exit with non-JSON output
        err.stderr = (stderr || '').trim();
        reject(err);
      } else {
        resolve(null);
      }
    });
  });
}

/**
 * Run a herdr subcommand that returns plain text (agent read).
 * @returns {Promise<string>} raw text output
 */
function herdrText(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(HERDR_BIN, args, { timeout: timeoutMs || QUICK_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) { reject(err); return; }
      resolve(stdout || '');
    });
  });
}

// ─── herdr convenience commands ───────────────────────────────────────────

async function herdrAgentList() {
  const result = await herdrJSON(['agent', 'list']);
  return result ? (result.agents || []) : [];
}

/**
 * Mirror panes (herdr-mirror) are read-only views of remote agents;
 * herdr does not allow send-keys to them ("agent_not_ready"). Cross-machine
 * control is v2 scope (see PLAN.md) — v1 watches local agents only.
 */
function isMirrorPane(agent) {
  // Board display labels do not identify mirror panes in the live service.
  return false;
}

async function herdrAgentGet(paneId) {
  const result = await herdrJSON(['agent', 'get', paneId]);
  return result ? result.agent : null;
}

async function herdrAgentRead(paneId, lines = 20) {
  return herdrText(['agent', 'read', paneId, '--source', 'visible']);
}

async function herdrAgentSendKeys(paneId, ...keys) {
  return herdrJSON(['agent', 'send-keys', paneId, ...keys]);
}

async function herdrAgentWait(paneId, until, timeoutMs) {
  const args = ['agent', 'wait', paneId, ...until.flatMap(s => ['--until', s]), '--timeout', String(timeoutMs)];
  return herdrJSON(args, timeoutMs + 10_000);
}

// ─── Telegram API ─────────────────────────────────────────────────────────

function tgRequest(method, params) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(params);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${BOT_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 60_000,
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`TG parse error for ${method}: ${e.message}`)); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`TG timeout for ${method}`)); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function tgSendMessage(text, extra) {
  const params = { chat_id: OWNER_ID, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra };
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await tgRequest('sendMessage', params);
      if (res.ok) return res.result;
      if (res.error_code === 429 && res.parameters?.retry_after) {
        log(`TG rate limited, retry in ${res.parameters.retry_after}s`);
        await sleep(res.parameters.retry_after * 1000);
        continue;
      }
      log(`TG sendMessage error: ${res.description}`);
      return null;
    } catch (e) {
      lastErr = e;
      log(`TG sendMessage attempt ${attempt + 1} threw: ${e && e.message ? e.message : e}`);
      await sleep(2000 * (attempt + 1));
    }
  }
  log(`TG sendMessage failed after retries: ${lastErr ? (lastErr.message || lastErr) : 'unknown'}`);
  return null;
}

async function tgAnswerCallback(callbackId, text) {
  await tgRequest('answerCallbackQuery', { callback_query_id: callbackId, text });
}

async function tgEditMessage(chatId, messageId, text, replyMarkup) {
  const params = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
  if (replyMarkup !== undefined) params.reply_markup = replyMarkup;
  await tgRequest('editMessageText', params);
}

// ─── audit log ────────────────────────────────────────────────────────────

/**
 * Append one JSON line per decision to audit.log.
 * Fields: ts, decision, actor, policy_version, agent, pane_id, tier, rule,
 *         action_hash, argv, reason
 */
/**
 * Append one JSON line per decision to audit.log.
 * @param {object} extra  optional fields (displayed, executed, etc.) for
 *                        tracking "what the owner saw" vs "what we sent"
 */
function audit(decision, actor, record, extra = {}) {
  const entry = {
    ts: ts(),
    decision,
    actor,
    policy_version: POLICY.version,
    agent: record.agent || null,
    pane_id: record.pane_id || null,
    tier: record.tier ?? null,
    rule: record.rule || null,
    action_hash: record.action_hash || null,
    argv: record.argv || null,
    reason: record.reason || null,
    ...extra,
  };
  fs.appendFileSync(AUDIT_FILE, JSON.stringify(entry) + '\n');
}

// ─── policy ───────────────────────────────────────────────────────────────

let POLICY = {};
try {
  POLICY = JSON.parse(fs.readFileSync(POLICY_FILE, 'utf8'));
} catch (e) {
  console.error(`FATAL: cannot load policy.json: ${e.message}`);
  process.exit(1);
}

const APPROVAL_TTL = (POLICY.approval_ttl_seconds || 300) * 1000;
const WORKSPACE_ROOT = POLICY.workspace_root
  ? POLICY.workspace_root.replace(/^~/, os.homedir())
  : path.join(os.homedir(), 'projects');

// ─── state management ─────────────────────────────────────────────────────

/** In-memory state mirror. Shape: { pending: { [id]: approval_record } } */
let state = { pending: {} };

function loadState() {
  try {
    state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (!state.pending) state.pending = {};
  } catch {
    state = { pending: {} };
  }
  // Purge expired on load
  const now = Date.now();
  let purged = 0;
  for (const [id, rec] of Object.entries(state.pending)) {
    if (rec.consumed || new Date(rec.expires_at).getTime() <= now) {
      delete state.pending[id];
      purged++;
    }
  }
  if (purged) saveState();
}

function saveState() {
  atomicWriteJSON(STATE_FILE, state);
}

function addPending(record) {
  state.pending[record.id] = record;
  saveState();
}

function getPending(id) {
  return state.pending[id] || null;
}

function removePending(id) {
  if (state.pending[id]) {
    delete state.pending[id];
    saveState();
  }
}

function removeStalePending(agents) {
  const blocked = new Set(agents.filter(a => a.agent_status === 'blocked').map(a => a.pane_id));
  for (const rec of Object.values(state.pending)) {
    if (!rec.consumed && !blocked.has(rec.pane_id)) removePending(rec.id);
  }
}

/** Atomically mark a pending record as consumed. Returns the record or null. */
function consumePending(id) {
  const rec = state.pending[id];
  if (!rec) return null;
  if (rec.consumed) return null;
  rec.consumed = true;
  rec.status = 'consumed';
  saveState();
  return rec;
}

/**
 * Re-open a consumed pending after a transient failure (agent get failed,
 * re-classify threw) so the owner can retry the same approval. Genuine TOCTOU
 * mismatches (not_blocked / session / argv / target changed) must NOT be
 * un-consumed — the pane no longer matches what was approved.
 */
function unconsumePending(id) {
  const rec = state.pending[id];
  if (!rec || !rec.consumed) return;
  rec.consumed = false;
  rec.status = 'pending';
  saveState();
}

// ─── classify safety wrapper (Sola review #2, #3, #4) ─────────────────────

/**
 * Extract the approval region from pane text.
 *
 * MVP (shadow mode): whole-pane scan — returns the full text.
 * Future (v2): region-based extraction using herdr detection manifests
 *   at ~/.local/state/herdr/agent-detection/remote/*.toml.
 *   Each manifest specifies a `region` (e.g. "after_last_horizontal_rule",
 *   "bottom_non_empty_lines(14)") anchoring where the approval block sits.
 *   Switching to region-based reduces noise from file contents that happen
 *   to contain command-like strings above the fold.
 *
 * @param {string} paneText  full pane output from `herdr agent read`
 * @param {string} agent     herdr agent name (claude, codex, kimi, ...)
 * @returns {string}         text region to feed to classify()
 */
function extractApprovalRegion(paneText, agent) {
  // MVP: return full pane text.
  // TODO(v2): parse herdr manifest region per agent.
  return paneText;
}

function requestScreen(text) {
  const markers = [...text.matchAll(/^[ \t]*(?:Would you like to run the following command\?|Bash command)[ \t]*$/gm)];
  if (markers.length) return text.slice(markers[markers.length - 1].index).trim();
  return text.trim();
}

async function requestStillMatches(record) {
  try {
    const text = await herdrAgentRead(record.pane_id, 25);
    return !!record.screen_hash && crypto.createHash('sha256')
      .update(requestScreen(extractApprovalRegion(text, record.agent))).digest('hex') === record.screen_hash;
  } catch (_) { return false; }
}

/**
 * Check whether a path contains a symlink component.
 * realpath !== lexical resolve means at least one symlink was followed.
 *
 * @param {string} p     path to check
 * @param {string|null} cwd  for resolving relative paths
 * @returns {{ checked:boolean, isSymlink:boolean, real?:string, resolved?:string }}
 */
function pathHasSymlink(p, cwd) {
  let resolved = p;
  if (resolved.startsWith('~')) resolved = path.join(os.homedir(), resolved.slice(1));
  if (!path.isAbsolute(resolved)) {
    if (!cwd) return { checked: false };
    resolved = path.resolve(cwd, resolved);
  } else {
    resolved = path.resolve(resolved);
  }
  try {
    const real = fs.realpathSync(resolved);
    return { checked: true, isSymlink: real !== resolved, real, resolved };
  } catch {
    return { checked: false };
  }
}

/**
 * Post-classify safety wrapper. Applies Sola review points:
 *   #2 — any target whose path contains a symlink → downgrade to T2
 *         (symlink chains can redirect writes outside workspace)
 *   #3 — Tier1 (test/build allowlist) returns targets:[] because the
 *         command has no explicit path; bind the agent's cwd as an
 *         implicit target, verify it's inside workspace and symlink-free
 *
 * @param {object} result  classify() return value
 * @param {string} cwd     agent's cwd from herdr agent list
 * @returns {object}       possibly-modified result
 */
/**
 * Apply policy.json rules as ADDITIVE restrictions only.
 *
 * Rules can only RAISE risk (manual:true → always-human Tier 2); they can
 * never lower a tier decided by classify()/classifySafe(). This keeps the
 * safety invariants hardcoded in classify.js non-disableable while making
 * policy.json rules real (Nova release-review: rules were decorative).
 *
 * match: { argv: ["git","push"] } — structured prefix match (npm test matches
 * npm test but not npm test-publish). manual:true rules always escalate.
 */
function argvPrefixMatch(pattern, argv) {
  if (!Array.isArray(pattern) || !Array.isArray(argv)) return false;
  if (pattern.length === 0 || pattern.length > argv.length) return false;
  return pattern.every((p, i) => p === argv[i]);
}

function applyPolicyRules(result, argv, cwd) {
  if (!result || !POLICY.rules || !Array.isArray(POLICY.rules)) return result;
  const joined = Array.isArray(argv) ? argv.join(' ') : '';
  for (const rule of POLICY.rules) {
    if (!rule || !rule.match || !Array.isArray(rule.match.argv)) continue;
    if (!argvPrefixMatch(rule.match.argv, argv)) continue;
    // Path containment, if the rule asks for it
    if (rule.match.paths_under_workspace) {
      const inside = (result.targets || []).every(t => t.canonical && t.canonical.startsWith(WORKSPACE_ROOT));
      if (!inside) continue;
    }
    if (rule.manual) {
      return {
        ...result,
        tier: 2,
        rule: rule.id,
        manual: true,
        reason: rule.description || `manual rule: ${joined}`,
      };
    }
    // Tier rules act as restrictions only: they may RAISE the tier decided by
    // classify(), never lower it. A tier0 rule can't make cat auto-approve if
    // the classifier decided T2 — it simply records intent for future tiers.
    if (typeof rule.tier === 'number' && rule.tier > (result.tier || 0)) {
      return {
        ...result,
        tier: rule.tier,
        rule: rule.id,
        reason: rule.description || `policy rule raised tier to T${rule.tier}`,
      };
    }
  }
  return result;
}

function classifySafe(result, cwd) {
  // Point 2: symlink check on all existing targets
  if (result.targets && result.targets.length > 0) {
    for (const t of result.targets) {
      if (!t.canonical) continue;
      const sc = pathHasSymlink(t.canonical, cwd);
      if (sc.checked && sc.isSymlink) {
        log(`classifySafe: symlink on ${t.canonical} → ${sc.real}, downgrading T2`);
        return {
          ...result,
          tier: 2,
          rule: result.rule + '_symlink_downgrade',
          reason: `symlink in path: ${t.canonical} → ${sc.real}`,
          symlink_detected: true,
        };
      }
    }
  }

  // Point 3: Tier1 implicit cwd binding (targets is empty for test/build)
  if (result.tier === 1 && (!result.targets || result.targets.length === 0)) {
    if (!cwd) {
      return { ...result, tier: 2, rule: 'tier1_cwd_unknown', reason: 'Tier1 with no cwd to bind' };
    }
    const sc = pathHasSymlink(cwd, null);
    if (sc.checked) {
      if (sc.isSymlink) {
        log(`classifySafe: Tier1 cwd is symlink: ${cwd} → ${sc.real}, downgrading T2`);
        return { ...result, tier: 2, rule: 'tier1_cwd_symlink', reason: `cwd is symlink: ${cwd} → ${sc.real}` };
      }
      const inRoot = sc.real === WORKSPACE_ROOT || sc.real.startsWith(WORKSPACE_ROOT + path.sep);
      if (!inRoot) {
        return { ...result, tier: 2, rule: 'tier1_cwd_outside', reason: `cwd outside workspace: ${sc.real}` };
      }
      // Bind cwd as implicit target for revalidation tracking
      result = { ...result, targets: [{ canonical: sc.real, implicit_cwd: true }] };
    } else {
      // realpath failed — cannot verify cwd → fail closed
      return { ...result, tier: 2, rule: 'tier1_cwd_unresolvable', reason: `cwd unresolvable: ${cwd}` };
    }
  }

  return result;
}

// ─── tracking ─────────────────────────────────────────────────────────────

/** pane_id → last processed state_change_seq (dedup) */
const lastSeq = {};
/** pane_id → last known agent_status (for transition notifications) */
const lastStatus = {};
/** pane_id → waiter active flag */
const waiters = new Set();

// ─── approval flow ────────────────────────────────────────────────────────

/** Extract a human-readable project name from cwd. */
function projectFromCwd(cwd) {
  if (!cwd) return 'unknown';
  const rel = path.relative(WORKSPACE_ROOT, cwd);
  if (rel && !rel.startsWith('..')) return rel.split(path.sep)[0] || WORKSPACE_ROOT;
  return path.basename(cwd);
}

// ─── approval card utilities ─────────────────────────────────────────────

/**
 * Redact common secret patterns before sending to Telegram.
 * Catches: API keys (sk-*), password=/secret= assignments, PEM keys, Bearer tokens.
 */
function redactSecrets(str) {
  if (!str) return str;
  return String(str)
    .replace(/sk-[a-zA-Z0-9_-]{8,}/g, 'sk-REDACTED')
    .replace(/(token|password|passwd|secret|api[_-]?key|auth)["'\s]*[:=]\s*["']?[^"'\s\n]{4,}/gi, '$1=REDACTED')
    .replace(/-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g, '-----REDACTED KEY-----')
    .replace(/Bearer\s+[a-zA-Z0-9._-]{8,}/gi, 'Bearer REDACTED');
}

/**
 * Truncate in the middle, keeping head and tail.
 * Dangerous content (flags, paths, targets) tends to be at the end.
 */
function truncateMiddle(str, maxLen = 120) {
  if (!str || str.length <= maxLen) return str || '';
  const ellipsis = '…';
  const keep = maxLen - 1;
  const tailLen = Math.ceil(keep * 0.55);
  const headLen = keep - tailLen;
  return str.slice(0, headLen) + ellipsis + str.slice(-tailLen);
}

/** Short 8-char hash for display (full hash stored in state.json + audit). */
function shortHash(hash) {
  return hash ? hash.slice(0, 8) : '????????';
}

/** Countdown string M:SS from an ISO expiry timestamp. */
function expiryCountdown(expiresAt) {
  const remaining = Math.max(0, Math.round((new Date(expiresAt) - Date.now()) / 1000));
  const min = Math.floor(remaining / 60);
  const sec = remaining % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

/**
 * Blast radius: file count for directory targets or delete operations.
 * Returns null for single-file reads/writes (too noisy to always show).
 */
function blastRadius(target, rule) {
  if (!target) return null;
  try {
    const stat = fs.statSync(target);
    if (stat.isDirectory()) {
      let count = 0;
      const stack = [target];
      while (stack.length > 0 && count < 1000) {
        const dir = stack.pop();
        try {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) stack.push(path.join(dir, entry.name));
            else count++;
          }
        } catch {}
      }
      return count > 0 ? `📂 ${count} files` : '📂 empty dir';
    }
    if (/delete|rm_|manual-rm|destruct/i.test(rule || '')) return '📄 1 file';
  } catch { /* target doesn't exist yet (new file write) */ }
  return null;
}

/**
 * Build the Telegram approval card.
 * All user-facing text is HTML-escaped + secret-redacted.
 * @param {object} record  pending approval record
 * @param {'pending'|'approved'|'denied'} status  controls header
 */
function approvalMessage(record, status = 'pending') {
  const headers = {
    pending:  `🔒 <b>Approval Required</b>${SHADOW_MODE ? ' <i>[SHADOW]</i>' : ''}`,
    approved: `✅ <b>Approved</b> by ${escapeHtml(OWNER_NAME)}`,
    denied:   `🚫 <b>Denied</b> by ${escapeHtml(OWNER_NAME)}`,
  };
  const tierEmoji = { 0: '🟢', 1: '🟡', 2: '🔴' }[record.tier] ?? '⚪';
  const tierLabel = { 0: 'T0 auto', 1: 'T1 auto+log', 2: 'T2 escalate' }[record.tier] ?? `T${record.tier}`;

  const rawCmd = record.screen || (record.argv ? record.argv.join(' ') : '(no command extracted; inspect the pane)');
  const safeCmd = redactSecrets(rawCmd);
  const cmd = escapeHtml(safeCmd.length > 2200 ? '[Screen truncated; inspect pane]\n' + truncateMiddle(safeCmd, 2200) : safeCmd);
  const target = record.target_realpath ? escapeHtml(redactSecrets(record.target_realpath)) : null;
  const blast = blastRadius(record.target_realpath, record.rule);
  const reason = escapeHtml(redactSecrets(record.classify_reason || record.reason || ''));

  const lines = [
    headers[status] || headers.pending,
    '',
    `<b>Agent:</b> ${escapeHtml(agentDisplayName(record.agent))} (<code>${escapeHtml(record.pane_id)}</code>)` +
      (record.project ? ` · ${escapeHtml(record.project)}` : ''),
    ...(record.task_id ? [`<b>Task:</b> ${escapeHtml(record.task_id)}`] : []),
    `<b>Request:</b> <pre>${cmd}</pre>`,
  ];

  if (target) lines.push(`<b>Target:</b> <code>${target}</code>`);
  if (blast) lines.push(`<b>Blast:</b> ${escapeHtml(blast)}`);

  lines.push('');
  lines.push(`${tierEmoji} <b>${tierLabel}</b> · <code>${escapeHtml(record.rule || '?')}</code>`);
  if (reason) lines.push(`<i>${reason}</i>`);

  lines.push('');
  lines.push(`⏰ ${expiryCountdown(record.expires_at)} · 🔑 <code>${escapeHtml(shortHash(record.action_hash))}</code>`);

  return lines.join('\n');
}

/**
 * Core handler: agent transitioned to blocked.
 * 1. Read pane text
 * 2. Classify (shadow mode: always escalate)
 * 3. Create pending approval
 * 4. Send Telegram message with inline keyboard
 */
async function handleBlocked(paneId) {
  let agent;
  try {
    agent = await herdrAgentGet(paneId);
  } catch (e) {
    log(`handleBlocked(${paneId}): cannot get agent: ${e.message}`);
    return;
  }
  if (!agent) return;

  // Dedup via state_change_seq
  const seq = agent.state_change_seq;
  if (lastSeq[paneId] === seq) {
    return; // already processed
  }
  lastSeq[paneId] = seq;

  // Only handle blocked status
  if (agent.agent_status !== 'blocked') {
    return;
  }

  const agentName = agent.agent || 'unknown';
  const taskId = (agent.title || agent.terminal_title_stripped || '').match(/\b[A-Z][A-Z0-9]+-\d+\b/)?.[0] || null;
  const cwd = agent.cwd || WORKSPACE_ROOT;
  const project = projectFromCwd(cwd);

  // Read the pane
  let paneText;
  try {
    paneText = await herdrAgentRead(paneId, 25);
  } catch (e) {
    log(`handleBlocked(${paneId}): cannot read pane: ${e.message}`);
    paneText = '';
  }

  // Extract approval region + classify (Point 4: region-based interface)
  const region = extractApprovalRegion(paneText, agentName);
  let result;
  try {
    const raw = classify(region, agentName, { cwd, workspaceRoot: WORKSPACE_ROOT });
    result = classifySafe(raw, cwd); // Points 2 (symlink), 3 (Tier1 cwd binding)
    result = applyPolicyRules(result, result.argv, cwd); // policy.json additive manual rules
  } catch (e) {
    result = { tier: 2, action: 'classify_error', argv: null, targets: [], rule: 'classify_error', reason: e.message };
  }

  // Create pending approval
  const id = crypto.randomBytes(16).toString('hex');
  const target = result.targets && result.targets[0] ? result.targets[0].canonical : null;
  const hash = actionHash({ agent: agentName, project, argv: result.argv || [], target, id });
  const now = new Date();
  const expires = new Date(now.getTime() + APPROVAL_TTL);

  const record = {
    id,
    action_hash: hash,
    agent: agentName,
    task_id: taskId,
    // Redact the entire viewport before selecting any excerpt; otherwise an
    // excerpt could begin inside a private-key block and expose its body.
    screen: requestScreen(redactSecrets(region)),
    screen_hash: region ? crypto.createHash('sha256').update(requestScreen(region)).digest('hex') : null,
    pane_id: paneId,
    agent_session: agent.agent_session || null,
    state_change_seq: seq,
    project,
    argv: result.argv,
    cwd,
    target_realpath: target,
    tier: result.tier,
    rule: result.rule,
    classify_reason: result.reason,
    created_at: now.toISOString(),
    expires_at: expires.toISOString(),
    status: 'pending',
    consumed: false,
  };
  for (const old of Object.values(state.pending)) {
    if (old.pane_id === paneId && !old.consumed) removePending(old.id);
  }
  addPending(record);

  // Auto-approve path (shadow mode OFF): Tier 0/1 auto-execute, no Telegram card.
  // Full revalidation first: agent still blocked + session unchanged + argv hash
  // unchanged + target unchanged (mirror of the manual approve path — Sola r3 #2).
  if (!SHADOW_MODE && result.tier <= 1) {
    try {
      const reCheck = await herdrAgentGet(paneId);
      if (!reCheck || reCheck.agent_status !== 'blocked') {
        audit('auto_skipped', 'system', record, { reason: `not_blocked:${reCheck?.agent_status || 'gone'}` });
        return;
      }
      if (JSON.stringify(reCheck.agent_session || null) !== JSON.stringify(record.agent_session || null)) {
        audit('auto_skipped', 'system', record, { reason: 'session_changed' });
        return;
      }
      const reText = await herdrAgentRead(paneId, 25);
      const reRegion = extractApprovalRegion(reText, agentName);
      const reRaw = classify(reRegion, agentName, { cwd, workspaceRoot: WORKSPACE_ROOT });
      const reResult = applyPolicyRules(classifySafe(reRaw, cwd), reRaw.argv, cwd);
      const oldHash = crypto.createHash('sha256').update(JSON.stringify(record.argv || [])).digest('hex').slice(0, 16);
      const newHash = crypto.createHash('sha256').update(JSON.stringify(reResult.argv || [])).digest('hex').slice(0, 16);
      if (oldHash !== newHash) {
        audit('auto_skipped', 'system', record, { reason: 'argv_changed' });
        return;
      }
      if (record.target_realpath) {
        const reTarget = reResult.targets && reResult.targets[0] ? reResult.targets[0].canonical : null;
        if (reTarget !== record.target_realpath) {
          audit('auto_skipped', 'system', record, { reason: reTarget ? 'target_changed' : 'target_unresolvable' });
          return;
        }
      }
      if (!await requestStillMatches(record)) {
        delete lastSeq[paneId];
        audit('auto_skipped', 'system', record, { reason: 'screen_changed_or_unreadable' });
        return;
      }
      await herdrAgentSendKeys(paneId, 'Enter');
      audit('auto_approved', 'system', record, { reason: `tier${result.tier} auto (shadow off)` });
      removePending(record.id);
      log(`handleBlocked(${paneId}): AUTO-APPROVED tier${result.tier} [${result.rule}]`);
    } catch (e) {
      log(`handleBlocked(${paneId}): auto-approve error: ${e.message}`);
      audit('auto_error', 'system', record, { reason: e.message });
    }
    return;
  }

  // Audit: escalated (shadow mode) — track "what owner saw" vs raw classification
  const rawCmd = result.argv ? result.argv.join(' ') : '(no command extracted)';
  audit('escalated', 'system', record, {
    displayed: {
      cmd: truncateMiddle(redactSecrets(rawCmd), 120),
      target: record.target_realpath ? redactSecrets(record.target_realpath) : null,
      blast: blastRadius(record.target_realpath, record.rule),
    },
  });

  // Send Telegram message
  const text = approvalMessage(record);
  const keyboard = {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `app:${id}` },
      { text: '❌ Deny',    callback_data: `den:${id}` },
    ]],
  };
  let msg;
  try { msg = await tgSendMessage(text, { reply_markup: keyboard }); }
  catch (e) { log(`handleBlocked(${paneId}): send failed: ${e.message}`); }
  if (!msg) {
    delete lastSeq[paneId]; // Retry delivery on the next poll, even if the sequence is unchanged.
    log(`handleBlocked(${paneId}): failed to send Telegram message`);
  }

  log(`handleBlocked(${paneId}): escalated [tier=${result.tier} rule=${result.rule}] cmd=${result.argv ? result.argv.join(' ') : '?'}`);
}

// ─── callback verification & execution ────────────────────────────────────

/**
 * Verify a Telegram callback. Fail-closed: any mismatch = reject.
 * Checks: from.id, chat_id, pending exists, not expired, hash matches.
 * Does NOT check consumed here — that's done atomically in executeCallback.
 */
function verifyCallback(cb, action) {
  // Owner whitelist
  if (String(cb.from.id) !== String(OWNER_ID)) {
    return { ok: false, reason: 'wrong_user' };
  }
  if (String(cb.message?.chat?.id) !== String(OWNER_ID)) {
    return { ok: false, reason: 'wrong_chat' };
  }

  // Parse callback_data: "app:<id>" or "den:<id>"
  const parts = (cb.data || '').split(':');
  if (parts.length !== 2 || parts[0] !== action) {
    return { ok: false, reason: 'bad_callback_data' };
  }
  const id = parts[1];
  const rec = getPending(id);
  if (!rec) {
    return { ok: false, reason: 'not_found' };
  }

  // Expiry
  if (new Date(rec.expires_at).getTime() < Date.now()) {
    return { ok: false, reason: 'expired', record: rec };
  }

  return { ok: true, record: rec };
}

/**
 * Execute an approval/denial callback.
 * 1. Verify
 * 2. Atomic consume (one-time, anti-replay)
 * 3. TOCTOU: re-read pane, re-classify, compare
 * 4. Execute send-keys
 */
async function executeCallback(cb, action) {
  const verify = verifyCallback(cb, action.substring(0, 3)); // 'app' or 'den'
  if (!verify.ok) {
    await tgAnswerCallback(cb.id, `❌ Rejected: ${verify.reason}`);
    if (verify.record) {
      verify.record.status = verify.reason === 'expired' ? 'expired' : 'rejected';
      saveState();
      audit(verify.reason, cb.from.id, verify.record);
      removePending(verify.record.id);
    }
    return;
  }

  const rec = verify.record;

  // Atomic consume (one-time, anti-replay)
  const consumed = consumePending(rec.id);
  if (!consumed) {
    await tgAnswerCallback(cb.id, '⚠️ Already used');
    audit('replay_blocked', cb.from.id, rec);
    return;
  }

  try {
    // Both actions require pane revalidation before sending keys.
    //   Step 1: re-get agent info
    //   Step 2: verify still blocked
    //   Step 3: verify agent/session identity unchanged
    //   Step 4: re-read pane, re-classify, verify argv hash unchanged
    //   Step 5: re-resolve target, compare canonical path
    //   Step 6: execute send-keys
    const chatId = cb.message?.chat?.id;
    const messageId = cb.message?.message_id;
    const stale = async (reason) => {
      if (reason !== 'screen_truncated') delete lastSeq[rec.pane_id];
      rec.status = 'stale';
      saveState();
      audit('toctou_blocked', cb.from.id, { ...rec, reason });
      const truncated = reason === 'screen_truncated';
      try { await tgAnswerCallback(cb.id, truncated ? '🛑 Request too long; inspect pane' : '🛑 Request stale; checking again'); } catch (_) {}
      try {
        if (chatId) await tgEditMessage(chatId, messageId, truncated
          ? '🛑 <b>Too long to verify</b>\n\nInspect the pane. No key was sent.'
          : '🛑 <b>Stale</b>\n\nRequest changed or could not be verified. A new check will follow.');
      } catch (_) {}
    };

    if (rec.screen && rec.screen.length > 2200) {
      await stale('screen_truncated');
      return;
    }

    // Step 1: re-get agent info
    let agentInfo;
    try {
      agentInfo = await herdrAgentGet(rec.pane_id);
    } catch (e) {
      log(`revalidate(${rec.pane_id}): agent get failed: ${e.message}`);
      await stale('agent_get_failed');
      return;
    }

    // Step 2: verify still blocked
    if (!agentInfo || agentInfo.agent_status !== 'blocked') {
      const status = agentInfo?.agent_status || 'gone';
      await tgAnswerCallback(cb.id, `🛑 Agent no longer blocked (${status})`);
      audit('toctou_blocked', cb.from.id, { ...rec, reason: `not_blocked:${status}` });
      if (chatId) await tgEditMessage(chatId, messageId, `🛑 <b>Aborted</b>\n\nAgent is no longer blocked (status: ${escapeHtml(status)}).`);
      return;
    }

    // Step 3: verify agent/session identity
    const currentSession = JSON.stringify(agentInfo.agent_session || {});
    const storedSession = JSON.stringify(rec.agent_session || {});
    if (currentSession !== storedSession || agentInfo.agent !== rec.agent ||
        rec.state_change_seq == null || agentInfo.state_change_seq !== rec.state_change_seq) {
      await stale('session_changed');
      return;
    }

    // Step 4: re-read pane, re-classify, compare argv hash
    let newResult;
    try {
      const newText = await herdrAgentRead(rec.pane_id, 25);
      const newRegion = extractApprovalRegion(newText, rec.agent);
      if (!rec.screen_hash || crypto.createHash('sha256').update(requestScreen(newRegion)).digest('hex') !== rec.screen_hash) {
        await stale('screen_changed_or_missing');
        return;
      }
      if (action === 'deny') {
        if (!await requestStillMatches(rec)) { await stale('final_screen_changed_or_unreadable'); return; }
        try {
          await herdrAgentSendKeys(rec.pane_id, 'esc');
        } catch (e) {
          log(`executeCallback deny error: ${e.message}`);
          await tgAnswerCallback(cb.id, `❌ Error: ${e.message}`);
          audit('exec_error', cb.from.id, rec);
          return;
        }
        audit('denied', cb.from.id, rec, { executed: { keys: 'esc', pane_id: rec.pane_id } });
        removePending(rec.id);
        try { await tgAnswerCallback(cb.id, '🚫 Denied'); } catch (_) {}
        try { if (chatId) await tgEditMessage(chatId, messageId, approvalMessage(rec, 'denied')); } catch (_) {}
        return;
      }
      const rawNew = classify(newRegion, rec.agent, { cwd: rec.cwd, workspaceRoot: WORKSPACE_ROOT });
      newResult = classifySafe(rawNew, rec.cwd);
      newResult = applyPolicyRules(newResult, newResult.argv, rec.cwd);
    } catch (e) {
      log(`revalidate(${rec.pane_id}): re-classify failed: ${e.message}`);
      await stale('reclassify_failed');
      return;
    }

    const oldArgvHash = crypto.createHash('sha256').update(JSON.stringify(rec.argv || [])).digest('hex').slice(0, 16);
    const newArgvHash = crypto.createHash('sha256').update(JSON.stringify(newResult.argv || [])).digest('hex').slice(0, 16);
    if (oldArgvHash !== newArgvHash) {
      await tgAnswerCallback(cb.id, '🛑 Command changed (TOCTOU)');
      audit('toctou_blocked', cb.from.id, { ...rec, reason: 'argv_changed' });
      if (chatId) await tgEditMessage(chatId, messageId,
        `🛑 <b>Aborted (TOCTOU)</b>\n\nCommand changed between request and approval.\n\n` +
        `Was: <code>${escapeHtml(redactSecrets((rec.argv || []).join(' ')))}</code>\n` +
        `Now: <code>${escapeHtml(redactSecrets((newResult.argv || []).join(' ')))}</code>`);
      return;
    }

    // Step 5: re-resolve target, compare canonical path (Sola #1)
    if (rec.target_realpath) {
      const newTarget = newResult.targets && newResult.targets[0] ? newResult.targets[0].canonical : null;
      // A null/ unresolvable re-target is also a mismatch — fail closed.
      if (newTarget !== rec.target_realpath) {
        await tgAnswerCallback(cb.id, '🛑 Target path changed or unresolvable (TOCTOU)');
        audit('toctou_blocked', cb.from.id, { ...rec, reason: newTarget ? 'target_changed' : 'target_unresolvable' });
        if (chatId) await tgEditMessage(chatId, messageId,
          `🛑 <b>Aborted (TOCTOU)</b>\n\nTarget path changed or could not be re-resolved.\n` +
          `Was: <code>${escapeHtml(redactSecrets(rec.target_realpath))}</code>\n` +
          `Now: <code>${escapeHtml(redactSecrets(newTarget || '(unresolvable)'))}</code>`);
        return;
      }
    }

    // Step 6: all checks passed — execute
    if (!await requestStillMatches(rec)) { await stale('final_screen_changed_or_unreadable'); return; }
    try {
      await herdrAgentSendKeys(rec.pane_id, 'Enter');
    } catch (e) {
      log(`executeCallback approve error: ${e.message}`);
      await tgAnswerCallback(cb.id, `❌ Error: ${e.message}`);
      audit('exec_error', cb.from.id, rec);
      return;
    }
    audit('approved', cb.from.id, { ...rec, reason: 'executed' }, { executed: { keys: 'Enter', pane_id: rec.pane_id, target_verified: rec.target_realpath } });
    removePending(rec.id);
    try { await tgAnswerCallback(cb.id, '✅ Approved'); } catch (_) {}
    try { if (chatId) await tgEditMessage(chatId, messageId, approvalMessage(rec, 'approved')); } catch (_) {}
  } finally {
    if (getPending(rec.id)?.consumed) removePending(rec.id);
  }
}

// ─── waiter pool ──────────────────────────────────────────────────────────

/**
 * Per-agent waiter loop.
 * Phase 1: wait --until blocked (main detection channel)
 * Phase 2: wait --until working/idle/done (prevents tight loop when already blocked)
 */
async function agentWaiterLoop(paneId) {
  waiters.add(paneId);
  log(`waiter started: ${paneId}`);

  while (waiters.has(paneId)) {
    // Phase 1: wait for blocked
    let backoff = 1000;
    try {
      await herdrAgentWait(paneId, ['blocked'], WAIT_TIMEOUT_MS);
    } catch (e) {
      if (e.code === 'timeout') {
        // Normal: agent didn't block within timeout. Just retry.
        continue;
      }
      log(`waiter ${paneId}: phase1 error: ${e.message}`);
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 30_000);
      continue;
    }

    // Agent is blocked — handle it
    try {
      await handleBlocked(paneId);
    } catch (e) {
      log(`waiter ${paneId}: handleBlocked error: ${e.message}`);
    }

    // Phase 2: wait for agent to leave blocked state
    while (waiters.has(paneId)) {
      try {
        await herdrAgentWait(paneId, ['working', 'idle', 'done'], WAIT_TIMEOUT_MS);
        break; // left blocked state
      } catch (e) {
        if (e.code === 'timeout') {
          // Still blocked — keep waiting (don't re-process)
          continue;
        }
        log(`waiter ${paneId}: phase2 error: ${e.message}`);
        await sleep(5000);
      }
    }
  }

  log(`waiter stopped: ${paneId}`);
}

// ─── polling loop (30s) ───────────────────────────────────────────────────

/**
 * Low-frequency poll for progress notifications + new/gone agents + backup detection.
 */
async function pollLoop() {
  while (true) {
    await sleep(POLL_INTERVAL_MS);
    try {
      await pollOnce();
    } catch (e) {
      log(`pollLoop error: ${e.message}`);
    }
  }
}

async function pollOnce() {
  let agents;
  try {
    agents = await herdrAgentList();
  } catch (e) {
    log(`poll: agent list failed: ${e.message}`);
    return;
  }
  agents = agents.filter(a => !isMirrorPane(a));
  removeStalePending(agents);

  const seen = new Set();

  for (const agent of agents) {
    const paneId = agent.pane_id;
    seen.add(paneId);

    const status = agent.agent_status;
    const prev = lastStatus[paneId];

    // Detect transitions for progress notifications
    if (prev && prev !== status) {
      if ((prev === 'working' || prev === 'blocked') && (status === 'done' || status === 'idle')) {
        const name = agent.display_agent || agent.agent || paneId;
        await tgSendMessage(`✅ <b>${escapeHtml(name)}</b> (<code>${paneId}</code>) → ${status}`);
      }
    }
    lastStatus[paneId] = status;

    // Start waiter for new agents
    if (!waiters.has(paneId)) {
      agentWaiterLoop(paneId).catch(e => log(`waiter crash ${paneId}: ${e.message}`));
    }

    // Backup: if agent is blocked and we somehow missed it
    if (status === 'blocked') {
      const seq = agent.state_change_seq;
      if (lastSeq[paneId] !== seq) {
        log(`poll: detected unprocessed blocked ${paneId} (seq=${seq}), handling`);
        try { await handleBlocked(paneId); } catch (e) { log(`poll handleBlocked: ${e.message}`); }
      }
    }
  }

  // Clean up gone agents
  for (const paneId of [...waiters]) {
    if (!seen.has(paneId)) {
      waiters.delete(paneId);
      delete lastStatus[paneId];
      delete lastSeq[paneId];
      log(`poll: agent gone ${paneId}, waiter removed`);
    }
  }
}

// ─── reconciliation (startup) ─────────────────────────────────────────────

async function reconcile() {
  log('reconciliation: scanning agents...');
  let agents;
  try {
    agents = await herdrAgentList();
  } catch (e) {
    log(`reconcile: agent list failed: ${e.message}`);
    return [];
  }
  agents = agents.filter(a => !isMirrorPane(a));
  removeStalePending(agents);

  const blockedAgents = [];
  for (const agent of agents) {
    const paneId = agent.pane_id;
    lastStatus[paneId] = agent.agent_status;
    lastSeq[paneId] = agent.state_change_seq;

    // Start waiter for every agent
    if (!waiters.has(paneId)) {
      agentWaiterLoop(paneId).catch(e => log(`waiter crash ${paneId}: ${e.message}`));
    }

    // Handle already-blocked agents
    if (agent.agent_status === 'blocked') {
      // Reset seq so handleBlocked processes it
      lastSeq[paneId] = -1;
      blockedAgents.push(agent);
    }
  }

  // Process blocked agents
  for (const agent of blockedAgents) {
    log(`reconcile: processing blocked ${agent.pane_id}`);
    try { await handleBlocked(agent.pane_id); } catch (e) { log(`reconcile handleBlocked: ${e.message}`); }
  }

  log(`reconciliation: ${agents.length} agents, ${blockedAgents.length} already blocked`);
  return agents;
}

// ─── Telegram update handler ──────────────────────────────────────────────

let tgOffset = 0;

async function tgPollLoop() {
  while (true) {
    let res;
    try {
      res = await tgRequest('getUpdates', {
        offset: tgOffset,
        timeout: TG_POLL_TIMEOUT,
        allowed_updates: ['message', 'callback_query'],
      });
    } catch (e) {
      log(`TG poll error: ${e.message}`);
      await sleep(5000);
      continue;
    }

    if (!res.ok) {
      log(`TG getUpdates error: ${res.description}`);
      await sleep(5000);
      continue;
    }

    for (const update of res.result || []) {
      tgOffset = update.update_id + 1;
      try {
        await handleUpdate(update);
      } catch (e) {
        log(`handleUpdate error: ${e.message}`);
      }
    }
  }
}

async function handleUpdate(update) {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
  } else if (update.message) {
    await handleMessage(update.message);
  }
}

async function handleCallbackQuery(cb) {
  const data = cb.data || '';
  if (data === 'visual:approve' || data === 'visual:changes') {
    await handleVisualCallback(cb);
  } else if (data.startsWith('app:')) {
    await executeCallback(cb, 'approve');
  } else if (data.startsWith('den:')) {
    await executeCallback(cb, 'deny');
  } else {
    await tgAnswerCallback(cb.id, 'Unknown action');
  }
}

async function handleVisualCallback(cb) {
  if (String(cb.from?.id) !== String(OWNER_ID) || String(cb.message?.chat?.id) !== String(OWNER_ID)) {
    await tgAnswerCallback(cb.id, 'Not authorized');
    return;
  }
  const id = String(cb.message.message_id);
  state.visual = state.visual || {};
  if (state.visual[id] && (state.visual[id].choice !== 'changes' || state.visual[id].prompt_id || state.visual[id].replied)) {
    await tgAnswerCallback(cb.id, 'Already recorded');
    return;
  }
  const choice = cb.data === 'visual:approve' ? 'approve' : 'changes';
  const entry = state.visual[id] || { message_id: id, caption: cb.message.caption || '', choice, time: ts() };
  if (!state.visual[id]) {
    fs.appendFileSync(VISUAL_FEEDBACK_FILE, JSON.stringify(entry) + '\n');
    state.visual[id] = entry;
    saveState();
  }
  if (entry.choice === 'changes') {
    const prompt = await tgSendMessage('Please reply with one line of changes.', {
      reply_to_message_id: cb.message.message_id,
      reply_markup: { force_reply: true, selective: true },
    });
    if (prompt) {
      entry.prompt_id = prompt.message_id;
      saveState();
    }
  }
  await tgAnswerCallback(cb.id, 'Recorded');
}

async function handleMessage(msg) {
  // Owner whitelist
  if (String(msg.from?.id) !== String(OWNER_ID)) return;
  if (String(msg.chat?.id) !== String(OWNER_ID)) return;

  const text = (msg.text || '').trim();
  if (!text) return;
  const replyTo = msg.reply_to_message?.message_id;
  const visual = replyTo == null ? null : Object.values(state.visual || {}).find(v => v.choice === 'changes' && !v.replied && (v.prompt_id === replyTo || Number(v.message_id) === replyTo));
  if (visual) {
    if (/\r|\n/.test(text)) {
      await tgSendMessage('Please reply to the original prompt with one line.');
      return;
    }
    const reply = text;
    fs.appendFileSync(VISUAL_FEEDBACK_FILE, JSON.stringify({ message_id: visual.message_id, caption: visual.caption, choice: visual.choice, reply, time: ts() }) + '\n');
    visual.replied = true;
    saveState();
    await tgSendMessage('Changes recorded.');
    return;
  }

  if (text === '/start' || text === '/help') {
    await tgSendMessage(
      '🤖 <b>herdr-telegram-gate</b>\n\n' +
      'Commands:\n' +
      '/status — Show all agent statuses\n' +
      '/pending — Show pending approvals\n' +
      '/help — This message'
    );
  } else if (text === '/status') {
    await cmdStatus();
  } else if (text === '/pending') {
    await cmdPending();
  }
}

async function cmdStatus() {
  let agents;
  try { agents = await herdrAgentList(); }
  catch (e) { await tgSendMessage(`❌ Cannot list agents: ${escapeHtml(e.message)}`); return; }

  if (agents.length === 0) {
    await tgSendMessage('No agents found.');
    return;
  }

  const emoji = { idle: '⚪', working: '🔵', blocked: '🔴', done: '✅', unknown: '❓' };
  const lines = ['📊 <b>Fleet Status</b>\n'];
  for (const a of agents) {
    const name = agentDisplayName(a.display_agent || a.agent || '?');
    const e = emoji[a.agent_status] || '❓';
    lines.push(`${e} <b>${escapeHtml(name)}</b> (<code>${a.pane_id}</code>) — ${a.agent_status}`);
  }
  await tgSendMessage(lines.join('\n'));
}

async function cmdPending() {
  const pending = Object.values(state.pending).filter(r => !r.consumed && new Date(r.expires_at) > new Date());
  if (pending.length === 0) {
    await tgSendMessage('No pending approvals.');
    return;
  }
  const lines = ['⏳ <b>Pending Approvals</b>\n'];
  for (const r of pending) {
    const cmd = truncateMiddle(redactSecrets(r.argv ? r.argv.join(' ') : '?'), 120);
    const remaining = Math.max(0, Math.round((new Date(r.expires_at) - new Date()) / 1000));
    lines.push(`🔴 <b>${escapeHtml(r.agent)}</b> (<code>${r.pane_id}</code>)\n   <code>${escapeHtml(cmd)}</code>\n   Tier ${r.tier} · ${remaining}s left`);
  }
  await tgSendMessage(lines.join('\n'));
}

// ─── expiry sweeper ───────────────────────────────────────────────────────

async function expiryLoop() {
  while (true) {
    await sleep(60_000); // check every minute
    const now = Date.now();
    for (const rec of Object.values(state.pending)) {
      if (!rec.consumed && new Date(rec.expires_at).getTime() < now) {
        removePending(rec.id);
        audit('expired', 'system', rec);
        log(`expired: ${rec.id} (${rec.agent}/${rec.pane_id})`);
      }
    }
  }
}

// ─── preflight & doctor ──────────────────────────────────────────────────

/** Quick non-interactive checks. Returns array of issue strings (empty = OK). */
function preflight() {
  const issues = [];
  if (!BOT_TOKEN) issues.push('TELEGRAM_BOT_TOKEN not set. Copy .env.example to .env and fill in your values.');
  if (!OWNER_ID) issues.push('TELEGRAM_OWNER_ID not set. Message @userinfobot on Telegram to get your ID.');
  if (!herdrBinAvailable()) issues.push('herdr binary not found. Install: curl -fsSL https://herdr.dev/install.sh | sh');
  if (!fs.existsSync(HERDR_SOCKET)) issues.push(`herdr socket not found (${HERDR_SOCKET}). Is herdr server running? Start with: herdr`);
  if (!POLICY.version) issues.push('policy.json invalid or missing.');
  return issues;
}

/** Interactive preflight — runs all checks, prints results, returns all-pass. */
async function doctor() {
  const results = [];
  function check(name, fn) {
    try { results.push({ name, ok: true, detail: fn() }); }
    catch (e) { results.push({ name, ok: false, detail: e.message }); }
  }
  async function checkAsync(name, fn) {
    try { results.push({ name, ok: true, detail: await fn() }); }
    catch (e) { results.push({ name, ok: false, detail: e.message }); }
  }

  check('Node.js >= 18', () => {
    const major = parseInt(process.versions.node.split('.')[0]);
    if (major < 18) throw new Error(`Node ${process.versions.node} — need >= 18`);
    return `v${process.versions.node}`;
  });
  check('.env file', () => {
    if (!fs.existsSync(path.join(ROOT, '.env')))
      throw new Error('Not found. Run: cp .env.example .env  then fill in values.');
    return 'found';
  });
  check('TELEGRAM_BOT_TOKEN', () => {
    if (!BOT_TOKEN) throw new Error('Not set. Get one from @BotFather on Telegram.');
    return `${BOT_TOKEN.slice(0, 6)}••••`;
  });
  check('TELEGRAM_OWNER_ID', () => {
    if (!OWNER_ID) throw new Error('Not set. Message @userinfobot to get your numeric ID.');
    const id = String(OWNER_ID);
    return id.length > 4 ? `${id.slice(0, 2)}••${id.slice(-2)}` : '••';
  });
  check('herdr binary', () => {
    if (!herdrBinAvailable()) throw new Error('Not found. Install: curl -fsSL https://herdr.dev/install.sh | sh');
    return HERDR_BIN;
  });
  check('herdr server', () => {
    if (!fs.existsSync(HERDR_SOCKET)) throw new Error(`Socket not found: ${HERDR_SOCKET}. Start herdr in a terminal.`);
    return HERDR_SOCKET;
  });
  check('policy.json', () => {
    if (!POLICY.version) throw new Error('Invalid or missing.');
    return `v${POLICY.version}, ${POLICY.rules?.length || 0} rules`;
  });
  check('config.json', () => {
    if (!fs.existsSync(CONFIG_FILE)) return 'not found (using defaults)';
    return `owner=${OWNER_NAME}, aliases=${Object.keys(CONFIG.agent_aliases || {}).length}, shadow=${SHADOW_MODE}`;
  });
  check('classify.js', () => {
    if (typeof classify !== 'function') throw new Error('Not loadable from research/classify.js');
    return 'OK';
  });
  await checkAsync('herdr agent list', async () => {
    const agents = await herdrAgentList();
    return `${agents.length} agents online`;
  });
  await checkAsync('Telegram bot', async () => {
    const me = await tgRequest('getMe', {});
    if (!me.ok) throw new Error(me.description || 'getMe failed');
    return `@${me.result.username}`;
  });

  // Print
  console.log('\n🔍 herdr-telegram-gate — doctor\n');
  for (const r of results) {
    const d = r.detail && r.detail.length > 80 ? r.detail.slice(0, 77) + '...' : r.detail;
    console.log(`  ${r.ok ? '✅' : '❌'} ${r.name}: ${d}`);
  }
  const passed = results.filter(r => r.ok).length;
  console.log(`\n  ${passed}/${results.length} checks passed\n`);
  if (passed === results.length) console.log('  All green. Run: npm start\n');
  else console.log('  Fix the ❌ items above, then re-run: npm run doctor\n');
  return passed === results.length;
}

// ─── main ─────────────────────────────────────────────────────────────────

async function main() {
  // --doctor: interactive preflight then exit
  if (process.argv.includes('--doctor')) {
    const ok = await doctor();
    process.exit(ok ? 0 : 1);
  }

  // Preflight checks
  const issues = preflight();
  if (issues.length > 0) {
    console.error('\n❌ Preflight checks failed:\n');
    for (const issue of issues) console.error(`  • ${issue}`);
    console.error('\nRun: npm run doctor   for detailed diagnostics.\n');
    process.exit(1);
  }

  log(`herdr-telegram-gate starting (shadow=${SHADOW_MODE}, policy=${POLICY.version}, owner=${OWNER_NAME})`);
  log(`workspace_root=${WORKSPACE_ROOT}, approval_ttl=${APPROVAL_TTL / 1000}s`);

  // Load state
  loadState();
  log(`state loaded: ${Object.keys(state.pending).length} pending records`);

  // Verify Telegram bot
  const me = await tgRequest('getMe', {});
  if (!me.ok) {
    console.error(`FATAL: Telegram getMe failed: ${me.description}`);
    process.exit(1);
  }
  log(`Telegram bot: @${me.result.username} (${me.result.first_name})`);

  // Graceful shutdown
  const shutdown = (sig) => {
    log(`received ${sig}, shutting down...`);
    saveState();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // Reconcile + start loops
  await reconcile();
  pollLoop().catch(e => log(`pollLoop crash: ${e.message}`));
  expiryLoop().catch(e => log(`expiryLoop crash: ${e.message}`));
  tgPollLoop().catch(e => log(`tgPollLoop crash: ${e.message}`));

  // Startup notification
  await tgSendMessage(
    `🤖 <b>herdr-telegram-gate</b> online\n` +
    `Shadow mode: ${SHADOW_MODE ? 'ON (all escalate)' : 'OFF'}\n` +
    `Policy: v${POLICY.version}\n` +
    `Use /status or /pending`
  );
  log('startup complete');
}

main().catch(e => {
  console.error('Fatal:', e);
  process.exit(1);
});

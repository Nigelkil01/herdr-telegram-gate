'use strict';
/**
 * classify.js — risk-tier classifier for herdr agent approval prompts.
 * Zero dependency. Node >= 18.
 *
 * Contract (per Sola's review): NEVER return a tier alone. Always return the
 * structured argv + canonical realpath target so the approval binds to the
 * concrete action, not to the prompt text that described it.
 *
 * Tier 0 = auto-approve silently  (read-only, inside workspace root)
 * Tier 1 = auto-approve + log     (test/build argv allowlist only)
 * Tier 2 = escalate to Dom        (everything else, and everything unknown)
 *
 * FAIL-CLOSED: every unhandled path in this file returns tier 2.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const WORKSPACE_ROOT = path.resolve(os.homedir(), 'projects');

/** Canonical-path patterns that are never auto-approved, whatever the verb. */
const SECRET_PATTERNS = [
  /(^|\/)\.ssh(\/|$)/, /(^|\/)\.aws(\/|$)/, /(^|\/)\.gnupg(\/|$)/,
  /(^|\/)\.env($|\.)/, /(^|\/)\.netrc$/, /(^|\/)\.git-credentials$/,
  /id_rsa|id_ed25519|\.pem$|\.key$/, /(^|\/)secrets?(\/|$)/i,
  /(^|\/)\.npmrc$/, /(^|\/)\.pypirc$/,
];

/** Shell metacharacters that allow chaining, redirection or substitution. */
const SHELL_META = /(\|\||&&|[;&|`]|\$\(|>>?|<|\$\{)/;

// find / rg / tree are intentionally NOT in the read allowlist (Sola r4):
// they carry mutation-capable options (-delete/-exec/-fprint, --pre, -o)
// in too many forms to denylist safely, so any use escalates to T2.
// file is likewise option-rich (file -C compiles) — also T2 (Sola r5).
const READ_VERBS = new Set([
  'cat', 'ls', 'head', 'tail', 'wc', 'grep',
  'stat', 'realpath', 'basename', 'dirname',
]);

const GIT_READ_SUBCOMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'branch', 'remote', 'blame',
]);

/** Exact argv prefixes permitted at tier 1. Matched as a prefix, then the
 *  remaining args must contain no paths outside root and no metacharacters. */
const TEST_BUILD_ALLOWLIST = [
  ['npm', 'test'], ['npm', 'run', 'test'], ['npm', 'run', 'build'],
  ['pnpm', 'test'], ['yarn', 'test'],
  ['pytest'], ['python', '-m', 'pytest'],
  ['cargo', 'test'], ['cargo', 'build'], ['cargo', 'check'],
  ['go', 'test'], ['go', 'build'],
  ['make', 'test'], ['make', 'build'], ['make', 'check'],
];

// ---------------------------------------------------------------------------
// Extraction: pane text -> candidate command string
// ---------------------------------------------------------------------------

/**
 * Each extractor returns ALL candidate command strings it can see, not just the
 * first. If a pane yields more than one distinct candidate the request is
 * ambiguous — file contents can forge a second approval block (adv-013) — and
 * ambiguity must fail closed rather than trust regex ordering.
 */
function allMatches(text, re) {
  const out = [];
  let m;
  const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  while ((m = g.exec(text)) !== null) out.push(m[1].trim());
  return out;
}

const EXTRACTORS = {
  claude(text) {
    if (/Edit file|Write file/i.test(text)) return []; // structured write -> tier 2
    return allMatches(text, /Bash command\s*\n\s*\n?[ \t]{2,}(.+)/);
  },
  codex: (text) => allMatches(text, /^[ \t]*\$[ \t]+(.+)$/m),
  hermes: (text) => allMatches(text, /wants to run:\s*\n\s*(.+)/),
  gemini(text) {
    const candidates = [];
    // Legacy format: "Allow execution of:\n  <command>"
    candidates.push(...allMatches(text, /Allow execution of:?\s*\n\s*(.+)/));
    // Current write: "? WriteFile  Writing to <path>" (blocked indicator is the leading ?)
    for (const p of allMatches(text, /\?\s*WriteFile\s+Writing to\s+(\S+)/i)) candidates.push(`write ${p}`);
    // Current edit: "? EditFile  Editing <path>"
    for (const p of allMatches(text, /\?\s*EditFile\s+Editing\s+(\S+)/i)) candidates.push(`edit ${p}`);
    // Fallback: "Apply this change" without preceding WriteFile/EditFile — still a write, just no path
    if (candidates.length === 0 && /Apply this change/i.test(text)) candidates.push('write (path-not-extracted)');
    return candidates;
  },
  kimi(text) {
    const candidates = [];
    // Legacy format: "Tool call: shell\n  <command>"
    candidates.push(...allMatches(text, /Tool call:\s*shell\s*\n\s*(.+)/));
    // Current write: "Write this file?" + absolute/relative path on next non-empty line
    for (const p of allMatches(text, /Write this file\?\s+([\/~.][^\s\n]+)/i)) candidates.push(`write ${p}`);
    // Current edit: "Apply these edits?" + path
    for (const p of allMatches(text, /Apply these edits\?\s+([\/~.][^\s\n]+)/i)) candidates.push(`edit ${p}`);
    // Current shell: "Run this command?" + command (with or without $ prefix)
    candidates.push(...allMatches(text, /Run this command\?\s+\$?\s*(.+)/i));
    return candidates;
  },
  grok: (text) => allMatches(text, /Run command\?\s*\n\s*(.+)/),
};

/** @returns {{cmd:string|null, reason:string|null}} */
function extractCommand(text, agent) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { cmd: null, reason: 'empty pane text' };
  }
  let cands = [];
  const fn = EXTRACTORS[agent];
  if (fn) {
    try { cands = fn(text) || []; } catch { cands = []; }
  }
  if (cands.length === 0) {
    // Generic fallback: "$ cmd" lines, used for unknown agents.
    cands = allMatches(text, /^[ \t]*\$[ \t]+(.+)$/m);
  }
  const distinct = [...new Set(cands)];
  if (distinct.length === 0) return { cmd: null, reason: 'no command could be extracted' };
  if (distinct.length > 1) {
    return { cmd: null, reason: `ambiguous: ${distinct.length} candidate commands in pane` };
  }
  return { cmd: distinct[0], reason: null };
}

// ---------------------------------------------------------------------------
// Tokenisation + path resolution
// ---------------------------------------------------------------------------

/** Naive argv split. Only ever used AFTER the metacharacter check rejects
 *  anything with shell syntax, so quoting is the only case left to handle.
 *  Reports whether each token was quoted: a glob inside quotes is a literal
 *  argument (e.g. `find -name "*.js"`), not shell expansion. */
function tokenize(cmd) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    const quoted = m[1] !== undefined || m[2] !== undefined;
    out.push({ value: m[1] ?? m[2] ?? m[3], quoted });
  }
  return out;
}

function looksLikePath(tok) {
  return tok.includes('/') || tok.startsWith('~') || tok.startsWith('.');
}

/**
 * Resolve a token to a canonical path and decide whether it is safely inside
 * the workspace root. Follows symlinks via realpath — a symlink pointing out
 * of the root is the adv-012 case and must be rejected.
 *
 * `cwd` MUST be the agent's own cwd (herdr `agent list` -> .cwd). Resolving a
 * relative path against this process's cwd instead is a real vulnerability:
 * `pytest tests/` means something different per agent.
 */
function resolveTarget(tok, cwd, workspaceRoot = WORKSPACE_ROOT) {
  let p = tok;
  if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
  if (!path.isAbsolute(p)) {
    if (!cwd) return { ok: false, canonical: p, reason: 'relative_path_cwd_unknown' };
    p = path.resolve(cwd, p);
  } else {
    p = path.resolve(p);
  }

  let real;
  try {
    real = fs.realpathSync(p);
  } catch {
    // Does not exist / cannot be resolved -> cannot verify -> fail closed.
    return { ok: false, canonical: p, reason: 'unresolvable' };
  }

  const inRoot = real === workspaceRoot || real.startsWith(workspaceRoot + path.sep);
  if (!inRoot) return { ok: false, canonical: real, reason: 'outside_workspace_root' };
  if (SECRET_PATTERNS.some((re) => re.test(real))) {
    return { ok: false, canonical: real, reason: 'secret_path' };
  }
  return { ok: true, canonical: real, reason: null };
}

function deny(tier, action, reason, extra = {}) {
  return { tier, action, reason, argv: null, targets: [], ...extra };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * @param {string} paneText raw pane text at the block point
 * @param {string} agent    herdr agent id (claude|codex|hermes|...)
 * @param {{cwd?:string}} opts  cwd MUST come from herdr `agent list` -> .cwd
 * @returns {{tier:0|1|2, action:string, reason:string, argv:string[]|null,
 *            targets:{canonical:string}[], rule:string}}
 */
function classify(paneText, agent, opts = {}) {
  const cwd = opts.cwd || null;
  const wsRoot = opts.workspaceRoot || WORKSPACE_ROOT;
  const ex = extractCommand(paneText, agent);
  if (!ex.cmd) {
    const rule = ex.reason.startsWith('ambiguous') ? 'ambiguous_candidates' : 'extract_failed';
    const action = rule === 'ambiguous_candidates' ? 'ambiguous' : 'unparsable';
    return { ...deny(2, action, ex.reason), rule };
  }
  const cmd = ex.cmd;

  // Any shell syntax at all disqualifies auto-approval. adv-003/004/007/008/009.
  if (SHELL_META.test(cmd)) {
    return { ...deny(2, 'chained', 'shell metacharacters present'), rule: 'shell_meta', raw: cmd };
  }

  const toks = tokenize(cmd);
  if (toks.length === 0) {
    return { ...deny(2, 'unparsable', 'empty argv'), rule: 'empty_argv', raw: cmd };
  }

  // Globs only matter when UNQUOTED — the shell would expand those. A quoted
  // "*.js" is a literal argument (e.g. find -name "*.js") and is harmless.
  if (toks.some((t) => !t.quoted && /[*?\[]/.test(t.value))) {
    return { ...deny(2, 'glob', 'unquoted glob cannot be statically resolved'), rule: 'glob', raw: cmd };
  }

  const argv = toks.map((t) => t.value);
  const verb = path.basename(argv[0]);

  // --- git: REMOVED from T0 (Sola r5) --------------------------------------
  // git carries mutation-capable options (diff --output=, diff --no-index,
  // stash, submodule, worktree...) in too many forms to allowlist safely.
  // Any git use escalates to T2; a per-command positive grammar can bring
  // specific read-only subcommands back in a future release.
  if (verb === 'git') {
    return { tier: 2, action: 'vcs_write', reason: 'git use escalates (mutation-capable options)',
             argv, targets: [], rule: 'git_all_T2' };
  }

  // --- test / build allowlist (tier 1) -------------------------------------
  for (const prefix of TEST_BUILD_ALLOWLIST) {
    if (prefix.every((p, i) => argv[i] === p)) {
      const rest = argv.slice(prefix.length);
      const bad = rest.filter(looksLikePath).map((t) => resolveTarget(t, cwd, wsRoot)).find((r) => !r.ok);
      if (bad) {
        return { tier: 2, action: 'test', reason: bad.reason, argv,
                 targets: [{ canonical: bad.canonical }], rule: 'test_arg_outside' };
      }
      return { tier: 1, action: 'test_build', reason: `allowlisted: ${prefix.join(' ')}`,
               argv, targets: [], rule: 'test_build_allowlist' };
    }
  }

  // --- read-only verbs (tier 0) --------------------------------------------
  if (READ_VERBS.has(verb)) {
    // Dangerous flags turn otherwise-read verbs into mutations (Sola r3 #1):
    //   find . -delete / -exec rm … +   rg --pre 'touch PWNED' needle .
    const DANGEROUS_FLAGS = [
      ['find', ['-delete', '-exec', '-ok', '-execdir', '-okdir']],
      ['rg', ['--pre', '--execute']],
    ];
    for (const [v, flags] of DANGEROUS_FLAGS) {
      if (verb === v) {
        const hit = flags.filter((f) => argv.includes(f));
        if (hit.length) {
          return { tier: 2, action: 'dangerous_option', reason: `${v} ${hit.join(' ')} is destructive`, argv, targets: [], rule: 'dangerous_flags' };
        }
      }
    }
    const pathToks = argv.slice(1).filter(looksLikePath);
    if (pathToks.length === 0) {
      return { tier: 2, action: 'read', reason: 'read verb with no explicit path; cwd unverified',
               argv, targets: [], rule: 'read_no_path' };
    }
    const resolved = pathToks.map((t) => resolveTarget(t, cwd, wsRoot));
    const bad = resolved.find((r) => !r.ok);
    if (bad) {
      const action = bad.reason === 'secret_path' ? 'secret_read' : 'read_outside';
      return { tier: 2, action, reason: bad.reason, argv,
               targets: [{ canonical: bad.canonical }], rule: 'read_target_rejected' };
    }
    return { tier: 0, action: 'read', reason: 'read-only verb, all targets inside workspace',
             argv, targets: resolved.map((r) => ({ canonical: r.canonical })), rule: 'read_allowlist' };
  }

  // --- file write/edit (always Tier 2 — structured write) -----------------
  // Synthetic verbs injected by kimi/gemini write-approval extractors.
  // These represent file mutations, never auto-approved. We still try to
  // resolve the target path for Dom's approval message and TOCTOU checking.
  if (verb === 'write' || verb === 'edit') {
    const pathArg = argv.slice(1).find(looksLikePath);
    let targets = [];
    if (pathArg) {
      let p = pathArg;
      if (p.startsWith('~')) p = path.join(os.homedir(), p.slice(1));
      if (!path.isAbsolute(p) && cwd) p = path.resolve(cwd, p);
      else if (!path.isAbsolute(p)) p = path.resolve(p);
      // File may not exist yet — try full realpath, else resolve parent dir
      try {
        targets = [{ canonical: fs.realpathSync(p) }];
      } catch {
        try {
          const realParent = fs.realpathSync(path.dirname(p));
          targets = [{ canonical: path.join(realParent, path.basename(p)) }];
        } catch { /* unresolvable — leave empty, still T2 */ }
      }
    }
    return {
      tier: 2, action: 'file_write',
      reason: `file ${verb}${pathArg ? ': ' + pathArg : ' (no path)'}`,
      argv, targets, rule: 'structured_write',
    };
  }

  // --- default: everything else escalates ----------------------------------
  return { tier: 2, action: 'other', reason: `verb '${verb}' not in any allowlist`,
           argv, targets: [], rule: 'default_deny' };
}

module.exports = { classify, WORKSPACE_ROOT, TEST_BUILD_ALLOWLIST, READ_VERBS };

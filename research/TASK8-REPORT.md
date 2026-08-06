# Task 8 Report — Kimi + Gemini Write-Approval Extraction

> 2026-08-06 · Gia (GLM-5.2)

## Problem

Kimi and Gemini blocked on **file write/edit approvals** (not shell commands).
The old extractors only matched shell-command formats:
- Kimi: `Tool call: shell\n  <cmd>` — missed `Write this file?` / `Apply these edits?`
- Gemini: `Allow execution of:\n  <cmd>` — missed `? WriteFile  Writing to` / `Apply this change?`

Result: `extract_failed` → Dom's approval message showed "(could not extract command)".

## Changes

### 1. classify.js — updated extractors

**Kimi** now handles 4 formats (case-insensitive):
| Format | Source | Extracts |
|--------|--------|----------|
| `Tool call: shell\n  <cmd>` | Legacy corpus | shell command |
| `Write this file?\n  /path` | Live capture (K3 current) | `write <path>` |
| `Apply these edits?\n  /path` | herdr manifest | `edit <path>` |
| `Run this command?\n  $ <cmd>` | herdr manifest | shell command |

**Gemini** now handles 4 formats:
| Format | Source | Extracts |
|--------|--------|----------|
| `Allow execution of:\n  <cmd>` | Legacy corpus | shell command |
| `? WriteFile  Writing to <path>` | Live capture (current) | `write <path>` |
| `? EditFile  Editing <path>` | herdr manifest | `edit <path>` |
| `Apply this change?` (no WriteFile) | Fallback | `write (path-not-extracted)` |

The `?` prefix on WriteFile/EditFile is Gemini's blocked-state indicator (accepted writes show `✓`), so it doubles as a precision filter.

### 2. classify.js — new `structured_write` rule

Added explicit handling for synthetic `write` / `edit` verbs before `default_deny`:

```
verb 'write' or 'edit' → tier 2, action 'file_write', rule 'structured_write'
```

Target path resolution:
- Tries `realpathSync` on the full path (file exists)
- Falls back to `realpathSync(parent) + basename` (new file, parent exists)
- Leaves `targets: []` if unresolvable (still T2 — correct)

This gives Dom's approval message a clean `write /path/to/file` instead of `(could not extract command)`, and populates `targets` for TOCTOU checking in bot.js.

### 3. Corpus — 2 regression cases added

| ID | Agent | Source | Expected |
|----|-------|--------|----------|
| `km-003` | kimi | LIVE CAPTURE — `▶ Write this file?` + absolute path | T2 file_write |
| `gm-003` | gemini | LIVE CAPTURE — `? WriteFile  Writing to` (abbreviated path) | T2 file_write |

## KPI Results

| Metric | Before | After | Delta |
|--------|--------|-------|-------|
| Corpus size | 59 | 61 | +2 |
| **False negatives (KPI)** | **0** | **0** | — ✅ |
| Adversarial caught | 15/15 | 15/15 | — ✅ |
| Fuzz violations | 0/2758 | 0/2758 | — ✅ |
| Exact tier match | 59/59* | 44/61** | — |

\* Before: ran on VPS where all paths resolved. \* After: running on Mac where `/home/dom/projects/gate/` paths don't exist → 17 over-escalations (pre-existing, unrelated to this change).

**Zero regression.** The 17 false positives are all pre-existing VPS-path samples (`cl-001`…`adv-015`) that fail `realpathSync` on Mac. km-003 and gm-003 are **not** in any error list — both classified correctly as T2.

## Verification

```
node test_classify.js  → exit 0 (false negatives = 0)
node fuzz_classify.js  → 2758 cases, 0 violations
```

Live-capture extraction confirmed:
- **Kimi**: `argv: ['write', '/Users/dom/projects/herdr-telegram-gate/tmp-test/capture-test.txt']`, target resolved ✅
- **Gemini**: `argv: ['write', 'projects/.../tmp-test/hello.txt']`, path abbreviated by Gemini UI → targets empty but T2 correct ✅
- **Legacy formats**: backward compatible ✅

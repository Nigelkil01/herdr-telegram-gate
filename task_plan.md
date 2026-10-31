# Task Plan: Telegram gate fixes

## Goal
Make approval cards readable, remove stale pending entries, and record visual feedback safely.

## Next Step
Reproduce the current pane formats and validate pending cleanup.

## Current Phase
Phase 1

## Phases

### Phase 1: Requirements & Discovery
- [ ] Capture blocked pane formats and identify runtime behavior.
- **Status:** in_progress

### Phase 2: Planning & Structure
- [ ] Map changes to bot, tests, and visual sender.
- **Status:** pending

### Phase 3: Implementation
- [ ] Implement requested fixes with regression tests.
- **Status:** pending

### Phase 4: Testing & Verification
- [ ] Run tests and inspect safety behavior.
- **Status:** pending

### Phase 5: Delivery
- [ ] Commit and document coordinator steps.
- **Status:** pending

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Preserve live mirror-filter correction | Board labels are not mirror markers. |

## Errors Encountered
| Error | Resolution |
|-------|------------|
| Sandbox denied Herdr socket and user bus | Approved elevated read-only inspection. |
| No agents currently blocked | Await real blocked pane for requested capture. |

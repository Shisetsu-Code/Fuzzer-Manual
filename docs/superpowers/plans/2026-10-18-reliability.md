# Fuzzer Manual reliability implementation plan

> **For agentic workers:** Use superpowers:subagent-driven-development and test-driven-development for these bounded repairs.

**Goal:** Make the existing asynchronous screenshot cataloger preserve annotations and session ownership across concurrency, failures and restarts, then update the existing PR with verified changes.
**Architecture:** Retain Node, SQLite and the current Playwright adapter. Add explicit in-flight session accounting, durable action checkpoints, visible recovery, and drafts per task. Preserve independent deterministic replay and the single-session nature of RNG continuations.
**Tech Stack:** ESM JavaScript, Node >=22.13, node:sqlite, Playwright, sharp, plain browser UI.
**Spec:** The repository analysis and repair directions approved by the user's “Continua con eso” on 2026-10-18; acceptance criteria are fixed below.
**Upstream base:** Shisetsu-Code/Fuzzer-Manual PR #1, 88c2b2a6f2828349f5ac28d768ac9aa24ea9ef15, tree 807e4783227fe32b258ab5939e7a0413b915ee48.

## Global constraints

- Operate only on public Pragmatic DEMO catalog URLs through the existing allowlist.
- Preserve existing data with additive migrations; never discard catalogs or duplicate recorded branches.
- One photograph may create multiple independent deterministic branches; a live RNG state permits one continuation.
- No new runtime dependencies. Node 22.13+ remains supported; avoid Node-24-only production APIs.
- Tests exercise real state transitions and SQLite; replace external browser/network operations only where necessary.
- Changes go to the existing feature PR, with a checked expected head; main is not an implementation workspace.
- Each task edits only its assigned files. Parallel tasks use separate git worktrees.
- Do not dispatch subagents or perform remote writes from an implementer. The controller handles reviews, integration and GitHub.

## Review focus

- Capacity during both failed fresh preparation and inherited continuation, including release while work is active.
- A process ending after a click but before persistence, and older catalogs whose preparing actions lack checkpoints.
- Runnable work beyond a fixed candidate page when all live slots are occupied.
- A late failure or success for photo A while photo B is being annotated, followed by polling, navigation and retry.
- Recovery must capture current state without issuing another game input; a released or lost session cannot masquerade as ready.

## Task 1: Backend session lifecycle, recovery, queue and persistence

**Files:** src/browser.js, src/db.js, src/scheduler.js, src/server.js; relevant backend test files and new regression tests.
**Interfaces consumed:** Existing CatalogDB, BrowserEngine and Scheduler. Keep current callers working.
**Interfaces produced for Task 2:**
- GET /api/queue retains items and problems and adds recoveries: array of {id, slug, error, live:true}. It contains every blocked/failed task still owning a live session, including entries older than the ordinary problems limit.
- POST /api/tasks/:id/recapture captures that retained session without a game click, transitions the task back to ready and returns {ok:true}. Missing/lost sessions or active work produce an explicit error.
- POST /api/tasks/:id/release disposes the retained session, updates the task's visible outcome, and rejects release of active preparation/recapture.
- POST /api/tasks/:id/commit is idempotent for the same normalized marks after success: return the existing children. Different marks on an already committed task remain a conflict.
- Serve /annotations.js as a static JavaScript module for Task 2 (that task supplies the file).
- Ready queue capture metadata includes sessionId and gameSymbol when present.

### Required behavior

1. Reserve fresh irreversible capacity synchronously before any await. Reserved plus retained sessions never exceed MAX_LIVE; failure releases the reservation. Inherited continuations reuse their slot.
2. Transfer an inherited live session's ownership to the executing child before operations that can fail. A failure leaves that child visibly recoverable, not a hidden annotated parent. Recovery after post-click failure never replays the old click.
3. Track active work to reject concurrent release, recapture or duplicate prepare against the same session. Stop waits for a pending Chromium launch and never leaves a new browser owned after stopping.
4. Persist an action-dispatched checkpoint after verification and immediately before the actual irreversible mouse input. Restart automatically requeues only unambiguously safe work. Dispatched/uncertain work is blocked with a clear reason. Existing ready snapshots that required a lost live session must not remain actionable. Legacy preparing irreversible work without a trustworthy checkpoint is conservative.
5. Choose runnable live continuations before new-capacity work; do not let a LIMIT of 200/250 permanently hide runnable branches. Keep discovery/branch allocation and borrowing.
6. Add a root lookup index, preferably a unique partial index on tasks(game_id) WHERE parent_task_id IS NULL if existing data permits the invariant. Preserve legacy rows without destructive repair.
7. Fix iframe bounds using the intersection of left/top/right/bottom with the viewport; reject an empty intersection. Correctly handle x/y negative or an entirely offscreen iframe.
8. Implement the API contracts above and idempotent database commit.
9. Keep scheduler/db/browser shutdown ordering correct; failures must not write into a closed DB or spin new work after stop.

### Steps

- [ ] Write regressions before implementation: parallel first irreversible jobs at MAX_LIVE=1; failed inherited click/capture and screenshot-only recovery; all slots full with >250 blocked candidates hiding a runnable continuation; two-process dispatched-action crash; same-payload commit retry and differing-payload conflict; indexed root lookup; negative/offscreen iframe; stop during launch.
- [ ] Run the new tests against the old code and record expected failures.
- [ ] Implement the smallest coordinated changes satisfying the behavior and API contracts.
- [ ] Run focused regressions, then npm run check and npm test. With this local Node runner also run node --test --test-isolation=none test/*.test.js for individual test output.
- [ ] Commit only assigned files and write the report with red/green evidence, API details and concerns.

## Task 2: Per-photo drafts and recovery UI

**Files:** public/app.js, public/annotations.js (new), public/index.html, public/style.css; new frontend regression tests.
**Interfaces consumed:** Task 1's additive queue recoveries and recapture/release endpoints, plus idempotent commit. Existing API response fields remain.
**Interfaces produced:** /annotations.js is imported by app.js and served by Task 1; no new external dependency.

### Required behavior

1. Store each photo's draft and pending save independently by task ID. A late failure on A preserves B's marks and selection; a retry of A uses A's original normalized payload.
2. A failed save restores A to accessible pending work without forcing focus away from B. A successful save retires only A and adds history only after acknowledgement; stale queue polling must not resurrect it.
3. Previous-photo review, switching photos, undo, remove, clear and skip operate on the correct draft. Preserve unfinished B while reading history.
4. Keep drafts across a UI reload using bounded local storage if feasible; handle invalid/unavailable storage without breaking the UI. Never persist session secrets. Pending HTTP state is reconciled through safe idempotent retry rather than assumed success.
5. Render retained failed sessions in the recovery section with Recapturar and Liberar buttons. Capture without click returns the updated task to the normal queue. Show backend errors and keep unrelated drafts.
6. Ignore repeating next/skip keydown events so holding the key cannot silently skip many photographs; preserve configurable hotkeys.
7. Test the real shared state module and actual app integration where needed, not copied versions of production functions.

### Steps

- [ ] Write failing tests for late failed/successful saves, per-photo retry, stale polling, navigation/review and invalid storage.
- [ ] Implement the state module and adapt all mutation paths in app.js to it.
- [ ] Add recovery controls using the fixed backend contract.
- [ ] Run focused tests and the existing suite; document the backend integration assertions that require Task 1.
- [ ] Commit only assigned files and report red/green evidence and remaining concerns.

## Task 3: Preserve allowlisted GET transport evidence

**Files:** src/trace.js, test/trace.test.js.
**Interfaces consumed/produced:** sanitizeRequest still returns {endpoint,method,action,payload}; safeEndpoint continues removing the entire query from the endpoint string.

### Required behavior

1. Parse URL query parameters through sanitizedFields and merge allowlisted POST body fields over query fields. Never retain tokens, cookies or unrelated fields.
2. GET action=doSpin&pur=2 yields action doSpin and those payload fields while query secrets are absent.
3. Conflicting allowlisted POST fields override query fields; endpoint filtering and malformed/oversized payload handling remain bounded.

### Steps

- [ ] Add failing GET and POST/query precedence tests with sensitive-field assertions.
- [ ] Implement the bounded parsing change.
- [ ] Run focused tests and the existing suite, then commit assigned files.
- [ ] Report red/green evidence.

## Task 4: Browser validation and documentation

**Files:** scripts/smoke-branches.js, optional scripts/smoke-bonus.js, .github/workflows/browser-smoke.yml, relevant smoke-helper tests; README.md and docs/OBJETIVO_Y_FUNCIONAMIENTO.md are updated by the controller after behavior is reviewed.
**Interfaces consumed:** Reviewed backend behavior from Task 1, recorded runtime controls and sanitized transport evidence.

### Required behavior

1. Existing purchase-option smoke exercises multiple independent preparations concurrently within MAX_LIVE and verifies the reported limit. Every held context is released in finally.
2. Add an explicitly selectable full-bonus probe only if it can choose inputs from uniquely observed semantic runtime controls. No coordinate guessing, invented game requests, direct protocol wagering or real-money URLs.
3. A full-bonus result requires evidence of entering a bonus and its completed return to stable base, with transport evidence where available. Timeout/unknown controls are reported as incomplete with sanitized observations, never labelled success.
4. Save diagnostic artifacts for the current source revision. Validate with the existing GitHub workflow after the reviewed branch is updated.
5. Documentation distinguishes deterministic preparation/confirmation smoke, simulated failure regressions, and verified full-bonus results.

### Steps

- [ ] Inspect the existing smoke scripts and observed runtime evidence; define bounded success/failure criteria.
- [ ] Add meaningful tests for any new completion/selection helper before implementing it.
- [ ] Implement concurrent smoke and, when support is evidence-backed, the optional bonus probe.
- [ ] Run local regression suites; after integration, execute GitHub CI/browser checks on the exact commit and inspect results/artifacts.
- [ ] Report actual outcomes and concrete remaining limitations.

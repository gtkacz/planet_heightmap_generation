# Task Plan: SP6 Editable Plate Motion

## Goal
Implement SP6 end to end: user-editable plate direction and speed with desktop/mobile parity, deterministic rebuilds, planet-code persistence, documentation, and verification.

## Current Phase
Phase 10

## Phases

### Phase 1: Requirements, discovery, and design
- [x] Confirm the user-facing interaction model
- [x] Audit all state, worker, rendering, encoding, and documentation touchpoints
- [x] Write the SP6 design specification
- **Status:** complete

### Phase 2: Implementation plan and test strategy
- [x] Decompose the design into reviewable implementation tasks
- [x] Define pure-function and integration regression coverage
- [x] Write the SP6 implementation plan
- **Status:** complete

### Phase 3: Motion model, worker state, and persistence
- [x] Add deterministic plate-motion helpers and baseline/override state
- [x] Apply overrides after automatic physics on generate and edit-recompute
- [x] Extend planet-code encoding/decoding compatibly
- [x] Add focused automated tests
- **Status:** complete

### Phase 4: Editing UI and visualization
- [x] Add the unified Land/Sea and Motion edit palette
- [x] Render plate-motion arrows in globe and map views
- [x] Implement plate selection, direction dragging, speed control, reset, batching, and cancellation
- [x] Preserve existing Ctrl-click and mobile workflows
- **Status:** complete

### Phase 5: Documentation and verification
- [x] Update README, tutorial, What's New, and UI hints
- [x] Run syntax, unit, regression, and browser-level checks available in the repository
- [x] Review diff for unrelated changes and mobile accessibility requirements
- **Status:** complete

### Phase 6: Delivery
- [x] Confirm all success criteria and record final test results
- [x] Summarize files changed, behavior, and any residual risks
- **Status:** complete

### Phase 7: Branch and ancestry audit
- [x] Identify the original upstream repository and its current default-branch tip
- [x] Prove which local commits belong to SP1, SP2, and SP3
- [x] Confirm SP6 is uncommitted on local `main` and enumerate its intended file set
- **Status:** complete

### Phase 8: Isolated SP6 worktree
- [x] Create a dedicated branch/worktree directly from the upstream base
- [x] Transfer only the SP6 runtime, UI, documentation, and tests that are valid on that base
- [x] Confirm the branch contains no SP1, SP2, or SP3 commits or unrelated files
- **Status:** complete

### Phase 9: Isolated verification and commit
- [x] Run syntax, focused unit, browser, and relevant regression checks in the worktree
- [x] Review the staged diff and commit only the isolated SP6 implementation
- **Status:** complete

### Phase 10: Push and upstream pull request
- [x] Push the SP6 branch to the fork remote
- [x] Open a pull request against the original upstream repository
- [x] Verify the PR base, head, commits, and file list
- [x] Leave local `main`'s SP6 working changes intact and report final state
- **Status:** complete

## Key Questions
1. What representation keeps edits independent of render Detail and stable in planet codes?
2. How should automatic physics, land/ocean toggles, and user overrides compose deterministically?
3. How can pointer dragging work consistently in globe and equirectangular map views without interfering with OrbitControls?
4. What compact suffix format preserves all existing planet codes?

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Use a centroid-anchored direction arrow plus a separate speed slider | Directly expresses the desired plate motion and remains controllable on touch devices. |
| Reuse the pencil control as a unified `Land/Sea \| Motion` palette | Fits the existing floating-control vocabulary and preserves mobile parity. |
| Preserve desktop Ctrl-click as the existing land/ocean shortcut | Avoids regressing the established editing workflow. |
| Batch motion edits through the existing Rebuild action | Avoids recomputing terrain on every pointer movement and supports multi-plate edits. |
| Apply user motion overrides after automatic plate physics | Makes the displayed direction authoritative and predictable. |
| Rebuild automatic motion from an immutable generated baseline before applying overrides | Prevents cumulative physics mutation and makes interactive edits match planet-code reloads. |
| Persist `{bearingDeg, speedPercent}` per stable coarse plate index | Captures the user-facing intent compactly, stays Detail-independent, and can be deterministically converted to Euler pole/omega. |
| Extend codes with `~` plus fixed six-character motion records | Keeps every existing base/toggle code valid and makes parsing unambiguous. |
| Use a DOM drag handle over a Three.js arrow overlay | Provides a reliable 44px touch target without expensive mesh raycasting or OrbitControls conflicts. |
| Base the PR branch directly on the original upstream default branch | Guarantees SP1–SP3 history is not inherited; only explicitly transferred SP6 changes can enter the PR. |
| Keep local `main`'s current SP6 working changes untouched | Matches the user's explicit permission for SP6 to remain on local `main` while moving the PR commit to an isolated worktree. |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| Combined implementation-plan patch failed because a later `Current Phase` hunk appeared after earlier context in the patch | 1 | Split file creation and status updates into separate patches with current exact context. |
| Local `node` rejected `--experimental-default-type=module` | 1 | Check runtime versions and switch the test command to a supported ESM path rather than retrying the flag. |
| Dev server could not bind inside the filesystem/process sandbox (`listen EPERM`) | 1 | Re-ran the same local-only server with approved escalation; it is running on port 8765. |
| Browser smoke expected exactly 5,000 mesh regions but `buildSphere(5000)` adds the explicit pole region | 1 | Correct the assertion to the generator's 5,001-region contract and rerun; worker state had loaded successfully. |
| Motion suffix decoded correctly but startup dropped records before calling `generate()` | 1 | Thread records through startup/manual-load/Detail-rebuild calls and current-code encoding. |
| Browser smoke's second `page.goto()` changed only the hash, so the SPA did not reload | 2 | Add a cache-busting query parameter to force a new document for each code-load case. |
| Browser smoke compared signed legacy omega values instead of angular-speed magnitude | 3 | Compare absolute omega magnitudes; canonical user overrides may flip pole/sign while preserving identical angular motion. |
| Editor smoke could not click the Motion palette button after opening the pencil | 1 | Inspect computed visibility/layout and CSS cascade before retrying; do not bypass the UI interaction in the test. |
| Full editor workflow passed through map switching, then mobile palette target measured below 44px | 2 | Capture the exact computed mobile layout before changing CSS so the fix addresses the real cascade/layout cause. |
| Puppeteer mobile emulation flags reloaded the page, making all editor controls correctly hidden at measurement time | 3 | Resize to the 390px CSS breakpoint without changing `isMobile`/`hasTouch`; test touch initialization separately if needed. |
| Combined `git rev-parse --short main origin/main` ancestry check rejected multiple revisions | 1 | Query refs separately; adjacent successful output already confirmed both local refs point to `b0ef46a`. |
| First branch-audit planning patch referenced an error row in the wrong planning file | 1 | Split the update by file and use exact existing context; no partial change was applied. |
| Adding the `upstream` remote failed because the managed sandbox exposes `.git/config` read-only | 1 | Re-ran the exact scoped command with user-approved elevated Git-remote permission; the remote was added successfully. |
| Creating the new linked worktree failed because branch refs under `.git` are read-only in the default sandbox | 1 | Re-ran the exact scoped `git worktree add` command with approval; it completed successfully. |
| Combined post-worktree planning patch placed a later `task_plan.md` hunk before an earlier one | 1 | Reordered the hunks in file order; no partial change was applied. |
| Clean-base patch check rejected `js/generate.js` and `js/planet-worker.js` because intervening proposal commits changed their context | 1 | Exclude those files from the bulk apply and port only their SP6 behavior manually against upstream. |
| Python's local HTTP server could not bind in the default sandbox | 1 | Re-ran the local-only server with scoped approval on port 8766. |
| Puppeteer could not launch Chromium because crashpad socket setup was sandbox-blocked | 1 | Re-ran the exact browser smoke with scoped approval; it passed, followed by the editor smoke. |
| Golden-master harness generated all cases but observed `undefined` arrays | 1 | Its state-capture hook belongs to SP1 and is absent upstream; adapt only the external harness copy to import `state.js` directly and rerun. |
| Local golden-master baseline differed in all arrays after the capture fix | 2 | The ignored baseline was generated from fork-current SP1–SP3 code and was never committed; build a fresh pristine-upstream reference for a valid SP6 comparison. |
| Staged whitespace gate found extra blank lines at EOF in two new files | 1 | Removed the blank lines, restaged the files, and reran the staged check successfully. |
| Initial pull-request creation could not connect to GitHub from the default sandbox | 1 | Re-ran the scoped `gh pr create` command with approved network access; PR #58 was created. |

## Notes
- Preserve all unrelated user-owned/untracked work, especially the proposal and existing `docs/` content.
- Follow `/home/gtkacz/.codex/RTK.md`: prefix shell commands with `rtk`.
- Do not spawn sub-agents; current instructions prohibit delegation unless explicitly requested.

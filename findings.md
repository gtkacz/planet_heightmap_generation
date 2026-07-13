# Findings & Decisions: SP6 Editable Plate Motion

## Requirements
- Add user-editable plate direction and speed for individual plates.
- Use a centroid-anchored direction arrow and separate speed slider.
- Integrate with the existing pencil editing UI via `Land/Sea` and `Motion` modes.
- Preserve desktop Ctrl-click land/ocean editing and mobile touch parity.
- Preview and batch edits; apply them through Rebuild.
- Persist applied motion edits in planet codes and URL hashes.
- Keep plate topology unchanged and reuse the existing edit-recompute pipeline.
- Provide reset-to-generated-motion behavior.

## Research Findings
- `plateVec` is keyed by deterministic coarse plate seed IDs and stores `{ pole, omega }` after `applyPlatePhysics` mutates the generated values.
- `handleEditRecompute` currently reuses the retained `plateVec`; it rebuilds elevation/climate without regenerating plate topology.
- Interactive land/ocean edits update `plateIsOcean` and density but do not rerun automatic plate physics, while a planet-code reload applies toggles before physics. This can make interactive output differ from reloaded output.
- Super-plate motion is derived from constituent plate angular momentum. Initial generation applies a further super-plate physics pass, but current edit-recompute only rebuilds super plates and omits that pass.
- Initial generation expands mantle flow and plate-physics diagnostics onto the high-resolution mesh; edit-recompute currently omits both. A shared motion-state rebuild helper should return the final small-plate vectors, rebuilt super-plate data, high-resolution mantle field, and diagnostics so generate/recompute cannot drift again.
- The clean refactor insertion point is immediately after type/density setup and before `assignElevation`: one helper can accept raw coarse vectors/current types/overrides and return everything both generate and edit-recompute need.
- `generate()` can remain source-compatible by adding motion records as a fifth argument after the existing callback/skip-climate parameters; `editRecomputeViaWorker()` can serialize the applied main-thread Map through the stable seed-order helper.
- The first worker/main integration pass parses cleanly and leaves pure tests green; browser generation is still required because the worker's CDN import prevents direct Node execution.
- The repo's minimal server is `node tuning/dev-server.mjs [port]`; it serves all ES modules directly and is suitable for Puppeteer integration.
- Both manual `applyCode` and startup URL-hash generation currently pass only toggles; they must pass decoded `motionOverrides` as the fifth `generate()` argument before persistence is complete.
- README's sharing section still says unedited codes are 21 characters, while `planet-code.js` has used a 22-character current base since land coverage was added; SP6 documentation should correct that existing drift while describing `~` motion records.
- Tutorial step 2 and What's New step 3 are the natural minimal discovery points for the pencil palette and plate motion; no new modal step is necessary.
- Touch devices replace tutorial step 2 text dynamically in `main.js`, so both the desktop HTML copy and mobile override must mention the two palette tools.
- What's New currently uses version `'2'`; bumping to `'3'` is required for returning users to see the SP6 entry.
- Final status review confirms the pre-existing proposal and `docs/` tree remain untracked/user-owned; SP6 edits are confined to intended runtime/docs/tests plus the required planning artifacts.
- `git diff --check` is clean after the documentation pass.
- All eight changed/new JavaScript modules pass Node syntax checks, and both pure test files remain green after documentation/UI integration.
- Both final Puppeteer suites pass concurrently against the local dev server. The only output is Node's typeless-package ESM warning; runtime/browser behavior is clean.
- The existing golden-master harness has a checked-in `tuning/regress-baseline.json`, exposes state through the existing `__WO_CAPTURE` hook, and checks six terrain/climate cases. It is applicable to SP6's no-override byte-identity gate.
- The complete six-case golden-master passed byte-identically, confirming the raw/generated/final refactor does not change any terrain or climate output when no motion override exists.
- Core diff review found only two unused fallback/main imports/state assignments; they were removed. Worker retention/message cloning and the no-override ordering match the verified design.
- UI diff and full editor-module review found the interaction/state paths consistent with the browser tests. Two CSS `font` shorthands mixed `inherit` into an invalid shorthand, so they were expanded to explicit size/weight/family declarations.
- Final main/math review confirmed stable index mapping, reset semantics, Detail-only preservation, and tangent-vector math. The remaining stale mobile hint was updated from “reshape” to the broader pencil plate editor.
- Combined Land/Sea plus motion browser coverage also produces byte-identical generated vectors, final vectors, and elevations between interactive Rebuild and fresh code load, directly verifying the reproducibility repair that motivated the worker refactor.
- Final workspace review is clean (`git diff --check`) and all Phase 5 gates are satisfied; delivery has no known functional blocker.
- Residual limitation: the pre-existing synchronous no-Worker fallback still has no interactive edit-recompute path. It can decode and render SP6 motion records on initial load, but applying any interactive plate edit continues to require module-worker support, as before SP6.
- Node 24 prints a typeless-package ESM performance warning for the browser test scripts because `package.json` lacks `"type": "module"`; this is test-runner noise only and was left unchanged to avoid an unrelated package-semantics change.
- `planet-worker.js` imports Delaunator from a CDN, so worker internals are poorly suited to direct Node unit tests. The new representation/override/encoding logic should live in dependency-free modules and receive focused pure tests; worker integration should be browser-tested.
- Existing planet-code suffixes encode only land/ocean toggle indices as fixed two-character plate indices after `-`.
- Coarse plate seed insertion order is deterministic and already provides stable plate indices for planet-code persistence.
- Existing `edit-mode.js` has analytical globe and map hit testing, click-versus-drag discrimination, and touch-aware edit activation.
- `edit-mode.js` is compact enough to keep canvas selection/hover routing there, while a separate motion-editor module can own overlay geometry, DOM handle/panel state, and staged motion values without entangling climate hover formatting.
- Existing edit markup has no desktop positioning because the pencil is globally hidden and only styled inside the mobile media query; SP6 needs base desktop FAB styles plus mobile position overrides for the palette/panel.
- Existing wind/ocean arrow rendering provides patterns for globe/map line overlays, while the actual interactive handle needs pointer-specific hit behavior.
- Globe overlays are separate scene groups whose Y rotation is manually synchronized with `state.planetMesh` in the animation loop; a motion overlay must follow the same convention and switch globe/map children on view changes.
- The synchronous fallback generation path currently omits `applyPlatePhysics`, super-plate construction, and edit-recompute support. SP6 must not silently claim parity there; pure encoding/math can remain compatible, while interactive rebuild continues to depend on the already-required worker path unless fallback is deliberately expanded.
- There is an existing mobile pencil FAB, a pending-edit Rebuild FAB, Escape cancellation, and pending plate tint infrastructure.
- Pencil activation is currently a small isolated IIFE in `main.js`, making it straightforward to extend it with a mode palette while leaving the pointer behavior in `edit-mode.js`.
- Map-center changes translate the map mesh live during slider input and rebuild projected arrow geometry on change; the motion overlay must either share that translation or rebuild at the same points, and its DOM handle must be repositioned each animation frame.
- No conventional test files were found during the initial audit; `package.json` and tuning harnesses need closer inspection for the available verification surface.
- `package.json` has only a Puppeteer dependency and no npm scripts, so verification must call Node harnesses directly and can add focused `node:test` coverage without introducing a runtime dependency.
- The local runtimes are Node v24.14.1 and Bun 1.3.11. Node 24 removed the old experimental default-type flag and supports ESM syntax detection, so tests should use plain `node --test`.
- Existing SP implementation plans use explicit file/interface/task/checklist structure and treat the design spec as the authority; SP6 should follow that convention while avoiding instructions to use unavailable/delegated subagents.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Treat the angular-velocity vector `W = pole * omega` as the canonical math representation | Removes the redundant `(pole, omega) == (-pole, -omega)` ambiguity and simplifies direction edits and encoding. |
| Store persisted overrides against stable plate indices, not raw region IDs | Matches existing toggle encoding and survives Detail changes because coarse plate order is deterministic. |
| Keep explicit generated-baseline and applied-override maps | Enables exact reset behavior and avoids inferring intent from floating-point diffs. |
| Recompute automatic small-plate and super-plate physics from immutable raw vectors for each applied edit | Ensures deterministic interactive/reload parity and prevents repeated mutation. |
| Show editing controls only while Motion mode is active | Avoids permanent visual clutter in the normal exploration UI. |
| Persist integer bearing (0–359°) and speed (0–200%) records | The values match the UI, are compact, deterministic, and avoid quantizing redundant pole/sign representations. |
| Convert direction edits by rotating the angular-velocity vector around the plate anchor | Preserves generated angular speed and pole distance at 100%, while producing the exact requested local tangent direction. |
| Use `~` as a motion suffix marker and six base36 characters per record (`plate:2`, `bearing:2`, `speed:2`) | Old codes remain valid; records are compact, sortable, and strictly validated. |
| Use a focusable DOM handle for the selected arrow tip | It guarantees mobile hit size and keyboard focus while scene geometry remains a lightweight visual overlay. |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| A combined patch could not match the reordered `task_plan.md` context | No files from the atomic patch were changed; split the creation and phase transitions into targeted patches. |
| The local Node runtime does not support `--experimental-default-type=module` | Inspect Node/Bun versions; use package ESM metadata or Bun's compatible test runner based on what is installed. |
| Local HTTP bind is blocked by the default sandbox | Started the repository dev server with the approved `rtk node tuning/dev-server.mjs` escalation. |
| `buildSphere(N)` produces `N + 1` regions because of its explicit pole insertion | Browser smoke should assert 5,001 for a requested Detail of 5,000; this is unrelated to SP6. |
| Browser smoke confirmed the URL decoder returned motion intent but `main.js` startup discarded it | Add stable-record plumbing to all code-load/rebuild/encode call sites; the worker contract itself did not error. |
| Puppeteer navigation to the same path with only a new hash does not reload this app (there is no `hashchange` loader) | Use a unique query parameter per browser test load; normal shared-link loads open a fresh document and are unaffected. |
| Generated `plateVec` may use negative omega, while SP6 canonicalizes edited motion to non-negative omega with an equivalent flipped pole | Speed percentage and tests must compare `abs(omega)` or angular-vector magnitude, never raw signed omega. |
| First full editor smoke reached the pencil click but Puppeteer reported the Motion palette button had no clickable box | Inspect the hidden-state/CSS cascade and position rather than replacing the interaction with direct state mutation. |
- CSS has only one base definition for the palette and an explicit `[hidden]` rule; the missing box is therefore likely that the pencil click was intercepted/failed to toggle state, not a duplicate palette style.
- Generation enables the Build button before the build overlay's 500ms dismissal finishes; the first test click was intercepted during that gap. Browser interaction tests must wait for `#buildOverlay.hidden` just as a user waits for the transition.
- After waiting correctly, desktop selection/staging/Escape/Ctrl-click/Rebuild/code/Reset/map checks all passed; only the emulated-mobile Motion palette target failed the 44px gate.
- Exact dimensions showed every editor child at 0 while the pencil remained 48px: Puppeteer's `isMobile`/`hasTouch` viewport change reloaded the document and reset edit mode. This was a test-state issue, not a CSS target-size failure.

## Resources
- `PERFORMANCE_AND_ACCURACY_PROPOSAL.md`
- `js/edit-mode.js`
- `js/planet-worker.js`
- `js/generate.js`
- `js/plate-physics.js`
- `js/plates.js`
- `js/super-plates.js`
- `js/planet-code.js`
- `js/planet-mesh.js`
- `js/main.js`
- `js/state.js`
- `index.html`
- `styles.css`

## Visual/Browser Findings
- None yet.
# Branch / PR isolation findings (2026-07-12)

- The repository currently has only one configured remote, `origin`, pointing to `gtkacz/planet_heightmap_generation`; the original upstream remote must be discovered from GitHub fork metadata.
- Local `main` is at `b0ef46a` and the complete SP6 implementation is still uncommitted. Therefore, there are no SP6 commits currently embedded in `main` history to rewrite or remove.
- Separate SP1, SP2, and SP3 worktrees already exist at their own branch tips. Their commits are visible in repository history but can be excluded categorically by creating the SP6 branch from the original upstream default-branch tip.
- The golden-master harness commit (`aaa53c0`) appears below the SP1/SP2/SP3 branch divergence in the local graph. Its presence on the actual upstream base still needs to be verified before deciding whether the isolated SP6 branch can run or reference it without importing prior proposal work.
- GitHub identifies `gtkacz/planet_heightmap_generation` as a fork of `raguilar011095/planet_heightmap_generation`; both default branches are `main`.
- Local `main` and cached `origin/main` both point to merge commit `b0ef46a` (`Merge SP2 (scale-invariance correctness) into main`). Cutting the PR branch from either ref would therefore inherit at least SP2.
- Freshly fetched `upstream/main` is `cc2662b` (`Merge pull request #54 from raguilar011095/ra_climate_tuning`) and is the exact merge base with local `main`; upstream has no commits that are missing from the fork.
- The fork adds the golden-master harness commit plus SP1, SP2, and SP3 after `cc2662b`. A branch created directly at `upstream/main` will exclude all of that history by construction.
- Neither `tuning/regress.mjs` nor `package.json` exists on `upstream/main`. SP6's runtime does not require either; the isolated branch should not inherit the harness merely to preserve local-only browser/regression execution unless focused verification cannot otherwise be represented.
- The dedicated PR branch is `feat/sp6-editable-plate-motion`, checked out at `/tmp/planet-heightmap-sp6-pr` directly from `upstream/main` (`cc2662b`).
- A clean-base patch check shows all tracked SP6 edits apply directly except `js/generate.js` and `js/planet-worker.js`; those files have intervening SP1–SP3 context and must be ported manually against upstream to avoid importing it.
- Upstream has no `tests/` directory or Puppeteer dependency. The isolated PR will include dependency-free SP6 unit tests, while the fork-only browser and golden-master harnesses remain verification infrastructure rather than PR content.
- The isolated worktree currently contains exactly nine modified upstream files plus four new SP6 files (two runtime modules and two dependency-free unit tests). It contains no planning/proposal files, browser-harness scripts, or commits above `upstream/main`.
- `git diff --check` passes on the clean-base port. The manual `generate.js`/`planet-worker.js` port preserves upstream code around the SP6 integration rather than resolving conflicts from fork history.
- All eight changed/new JavaScript modules parse on the upstream-based branch, and both dependency-free SP6 unit suites pass there.
- The fork-local Puppeteer smoke scripts can test an upstream-based worktree without entering the PR: point them at a local server rooted in `/tmp/planet-heightmap-sp6-pr`. Both the worker/reload parity suite and the full editor/mobile interaction suite pass against that clean-base code.
- The SP1 golden-master script also assumes an SP1-only `window.__WO_state` capture hook. Against pristine upstream it generates worlds successfully but hashes `undefined`; an external-only copy must import `/js/state.js` directly to make the comparison meaningful without adding SP1 code to the PR.
- `tuning/regress-baseline.json` is ignored/generated and was never committed with `aaa53c0`; the local copy represents the fork's current SP1–SP3 output, not pristine upstream. Its 36 differences against the clean-base SP6 branch cannot diagnose SP6.
- A valid no-override regression check must generate a fresh baseline from pristine `upstream/main`, then run the exact same external harness against the isolated SP6 worktree.
- The direct pristine-upstream-to-SP6 comparison passes all six cases byte-identically across elevation, triangle elevation, precipitation, and temperature arrays. The clean-base port therefore preserves no-override output without including any harness or SP1–SP3 commit.
- The isolated implementation is committed as `694be73` (`feat: add editable plate motion`). Its sole parent is the upstream tip `cc2662b`; the worktree is clean after commit.
- Pull request #58 is open at `https://github.com/raguilar011095/planet_heightmap_generation/pull/58`. GitHub reports base `raguilar011095:main@cc2662b`, head `gtkacz:feat/sp6-editable-plate-motion@694be73`, one commit, 13 changed files, and a clean mergeable state.
- Local `main` remains at `b0ef46a` with its original uncommitted SP6 working changes intact. The new SP6 commit exists only in `/tmp/planet-heightmap-sp6-pr` and on the pushed feature branch.

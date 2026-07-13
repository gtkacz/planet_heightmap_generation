# Task Plan: Planet Heightmap Development

## Goal
Analyze the current planet-heightmap application for evidence-backed performance improvements, with special attention to compute-heavy areas that may benefit from Rust/WASM, without changing implementation behavior in this task.

## Current Phase
Phase 10

## Phases

### Phase 1: Repository audit and compatibility baseline
- [x] Trace detail noise, post-processing order, worker/fallback data flow, Reapply, Edit Recompute, debug layers, UI, and tests
- [x] Identify the exact baseline regression and scale/performance harnesses
- [x] Record compatibility-sensitive call sites and buffer-transfer contracts
- **Status:** complete

### Phase 2: Simplex derivatives and Morenoise
- [x] Add derivative sampler and erosive FBM without per-cell allocation
- [x] Add `fbmMode` detail-noise plumbing for both L1 and L2 passes
- [x] Add analytical derivative/value compatibility tests
- **Status:** complete

### Phase 3: Runevision erosion
- [x] Implement immutable-input gradient estimation and seeded seamless directional cells
- [x] Implement coastal/depth/hotspot/orogenic safeguards and raw-height inversion
- [x] Add synthetic-field continuity, directionality, iteration-order, and determinism tests
- **Status:** complete

### Phase 4: Pipeline, state, and transfer integration
- [x] Thread default-off flags through Generate, Reapply, Edit Recompute, worker, and fallback
- [x] Enforce the required post-processing order and non-compounding behavior
- [x] Return, attach, replace, clear, and transfer experimental debug buffers
- [x] Keep planet codes/import persistence unchanged
- **Status:** complete

### Phase 5: Hidden Terrain Lab UI and inspection
- [x] Add query-gated controls and Reapply activation behavior
- [x] Add query-gated Inspect entries for all three experimental layers
- [x] Exercise all four flag combinations through browser integration
- **Status:** complete

### Phase 6: Regression, scale, and performance verification
- [x] Run focused unit/syntax/browser tests and workspace checks
- [x] Prove flag-off byte compatibility and deterministic/non-compounding behavior
- [x] Run available regression and scale-invariance cases at requested sizes
- [x] Measure 299K timing/allocation guardrails where the harness supports it
- **Status:** complete

### Phase 7: Architecture and workload inventory
- [x] Inventory runtime entry points, worker boundaries, data sizes, build tooling, and existing benchmarks
- [x] Identify major loops, allocation/copy sites, and synchronous fallbacks
- [x] Preserve unrelated working-tree changes
- **Status:** complete

### Phase 8: Evidence and bottleneck analysis
- [x] Mine existing timing artifacts and benchmark harnesses
- [x] Run representative local measurements where practical
- [x] Separate compute cost from serialization, transfer, rendering, and startup cost
- **Status:** complete

### Phase 9: Rust/WASM suitability assessment
- [x] Rank candidates by expected speedup, integration cost, determinism risk, and boundary overhead
- [x] Compare Rust/WASM against lower-cost JavaScript and WebGPU/worker improvements
- [x] Sketch an incremental migration architecture and measurement gates
- **Status:** complete

### Phase 10: Deliverable
- [x] Produce a concise, prioritized analysis with evidence, tradeoffs, and open questions
- [x] Record the analysis in repository findings/progress artifacts
- **Status:** complete

## Decisions
| Decision | Rationale |
|----------|-----------|
| Both features default to `false` at every boundary | Preserves existing callers and output. |
| Experimental layers are nullable and replaced atomically on Reapply | Prevents stale inspection data and compounding. |
| Flags remain runtime-only UI/worker parameters | The requested experiments must not affect planet-code compatibility or imports. |
| Do not spawn sub-agents | Workspace instructions prohibit delegation unless explicitly requested. |
| Treat this turn as analysis-only | The user asked to analyze and brainstorm, not to implement performance changes. |
| Evaluate WASM at coarse pipeline boundaries | Per-element JS/WASM crossings and memory copies can erase compute gains. |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| Runevision article direct scrape returned navigation but no article body | 1 | Search indexed code/source mirrors for the distinctive formula names; keep the supplied implementation plan authoritative. |
| Firecrawl targeted searches exhausted account credits | 1 | Used the available primary-source search index for the author article and stopped further Firecrawl requests. |
| Direct open of the Blogger/Shadertoy pages returned cache/safety errors | 1 | Used the search index's primary article body and known public Shadertoy identifier; no further page interaction is required. |
| Central-difference derivative test sampled an exact simplex rank boundary | 1 | Shifted the test point by 0.003 so the finite difference stays within one differentiable tetrahedron; retained separate value-compatibility coverage. |
| Combined worker integration patch missed the edit-state field ordering | 1 | Split Generate, Reapply, and Edit Recompute into exact-context patches; no partial change occurred. |
| Combined main-thread flag patch missed the exact Edit Recompute callback context | 1 | Applied the runtime helper, generate calls, and edit callback in separate exact-context patches. |
| Import retained-state patch initially added a duplicate `r_hotspot` to Generate | 1 | Removed the misplaced null field and added it to the heightmap-import retained state with a more specific context. |
| First Terrain Lab browser run used a pre-climate-extension planet-code argument list | 1 | Added deposition, rebound, hotspots, and the seven current climate defaults before rerunning. |
| Browser sandbox blocked Chromium crashpad socket setup | 1 | Re-ran the scoped Terrain Lab browser harness with approved Chromium permission. |
| Browser harness assumed planet-code startup left Reapply disabled | 1 | Reset the button immediately before the checkbox assertion so the test isolates the checkbox change contract from existing startup slider events. |
| 5K browser case correctly skipped Runevision's 400 km octave under the 2.5-edge resolution gate | 1 | Raised the integration case to the requested ~31K rung, where the base octave is resolvable and should visibly change terrain. |
| No-Worker fallback's second 31K synchronous generation exceeded the browser harness timeout | 1 | Kept worker/combinations at 31K and isolated fallback API plumbing at 5K; Runevision's independent synthetic suite already validates active octave behavior. |
| In-page `generate-done` promise did not resolve for a second synchronous fallback generation | 2 | Switched the fallback test to the public disabled/enabled button lifecycle and captured console/page errors separately. |
| Fallback lifecycle wait raced module startup and returned while `state.curData` was still null | 3 | Require both an enabled button and non-null shared generation state in the browser wait helper. |
| Isolated fallback diagnostic exposed the legacy undefined-distance composite-erosion failure | 1 | Reuse Runevision's distances for classic erosion only in the Runevision-enabled branch; preserve the exact legacy undefined argument when the flag is off. |
| Full scale harness could not bind its local server inside the filesystem sandbox | 1 | Re-ran the repository harness with scoped approval for its local listener and Chromium. |
| Existing `planet-code-motion.test.js` uses the obsolete pre-climate-extension encoder signature | 1 | Recorded as a pre-existing test-fixture failure; current planet-code behavior is covered by the golden master and Terrain Lab browser test without altering unrelated SP6 fixtures. |
| Local performance profiler could not bind `127.0.0.1` inside the filesystem sandbox (`EPERM`) | 1 | Re-run the same read-only browser profile with scoped permission for its local listener and Chromium. |

## Notes
- Follow `/home/gtkacz/.codex/RTK.md`: prefix shell commands with `rtk`.
- Preserve unrelated user changes and avoid destructive Git operations.
- Re-read this plan before major implementation decisions.
- Ideas introduced during the requested brainstorm will be marked as AI suggestions; measured repository facts will be identified separately.

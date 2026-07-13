# Progress: Experimental Morenoise and Runevision Terrain Filters

## Session: 2026-07-13 — Performance and Rust/WASM analysis

### Phase 7: Architecture and workload inventory
- **Status:** complete
- Loaded the repository RTK instructions and the complete requested brainstorming skill.
- Loaded the complete file-based planning skill because the analysis requires a multi-surface repository audit and more than five tool calls.
- Restored the completed prior task artifacts and extended them for this analysis without discarding their history.
- Confirmed the requested scope is analysis and recommendations only; no runtime implementation changes are authorized.
- Captured the dirty working tree before inspection and marked existing source/test changes as protected.
- Inventoried repository modules, harnesses, and the minimal package toolchain.
- Read the product goals and existing performance/accuracy proposal; captured candidate optimizations but marked their code references and assumptions as requiring current-code verification.
- Captured current module sizes and the old proposal's exact profiling caveat/commit baseline.
- Mapped all current timing instrumentation and confirmed console reporting is now implemented.
- Traced current Generate worker and main-thread receive paths, including retained-state clones, transfer lists, river passes, and rendering timing.
- Verified climate-only recoloring and worker-provided mesh adjacency are current behavior, removing two stale proposal items.
- Audited current generation/climate transfer lists and separated intentionally retained caches from apparently transferable ephemeral result buffers.
- Read the Terrain Lab benchmark methodology and scoped what its measurements can and cannot establish.
- Loaded its current 299K result artifact and quantified the measured erosion/warp/detail shares and run-to-run variance.
- Inventoried terrain-post and Runevision allocation/sort surfaces and identified the representative climate-on/off resolutions for profiling.
- Read the composite erosion and final river algorithms in detail; counted default repeated sorts and recorded determinism constraints.
- Added a temporary `/tmp` browser profiler; its first run hit the expected sandbox restriction on a local HTTP listener, logged above for scoped retry.
- Re-ran the profiler with scoped localhost/Chromium permission and completed six full current-code generations (three default climate-on at ~204K, three climate-off at ~299K).
- Identified wind ITCZ as the dominant default-path hotspot (~41.5% of worker time), followed by elevation, precipitation, post-processing, temperature, and plate projection.
- Traced ITCZ to repeated fine-region cap queries and identified exact-query reuse plus dot-product distance tests as the first optimization experiments.
- Began climate-kernel audit and mapped what is bundled into precipitation's advection timing.
- Audited temperature's timed boundary and coarse→fine plate projection; identified projection as a bounded WASM proof-of-concept candidate rather than the highest end-to-end priority.
- Traced temperature continentality and found repeated per-region/per-patch scans that should be removed algorithmically before any language migration.
- Revalidated two old elevation “free wins” as already resolved and scoped elevation WASM viability to coarse, stage-sized boundaries.
- Revalidated rendering allocation recommendations and identified high-detail mesh attribute memory as a more fundamental ceiling than main-thread latency at 204–299K.
- Inventoried debug-layer production/transfer at a high level and found a large display-only memory and structured-clone surface.
- Confirmed the exact debug-layer count and audited current no-build/CDN deployment constraints for Rust/WASM integration.
- Traced Reapply and identified full climate recomputation, climate buffer cloning, river rebuilding, and render-mesh recreation as its latency surfaces.

### Phase 8: Evidence and bottleneck analysis
- **Status:** complete
- Completed representative browser profiling and source-level root-cause analysis for the dominant stages.
- Separated worker compute, result-delivery/clone estimates, main render work, and high-resolution memory scaling.

### Phase 9: Rust/WASM suitability assessment
- **Status:** complete
- Ranked algorithmic, memory, and WASM candidates against measured default and climate-off workflows.
- Drafted a reversible single-thread worker integration, acceptance gates, and future threading/WebGPU tradeoffs.

### Phase 10: Deliverable
- **Status:** complete
- Added a tagged brainstorming summary to `findings.md` with ranked candidates, measured payoff framing, incremental WASM architecture, validation gates, tradeoffs, and open questions.
- Confirmed no source implementation was changed during this analysis; temporary profiling code was removed.
- `git diff --check` passes.

## Session: 2026-07-13

### Phase 1: Repository audit and compatibility baseline
- **Status:** complete
- Read the workspace RTK instructions and the complete file-based planning skill.
- Restored and reviewed the prior completed planning artifacts; no unsynced session context was reported.
- Reinitialized the planning artifacts for the current experimental terrain-filter task.
- Located the centralized post-processing pipeline and all four worker/fallback call sites.
- Confirmed `prePostElev` is immutable retained state and Reapply already restarts from it.
- Reviewed the current Simplex implementation and the detail-noise km mapping/inversion safeguards.
- Traced the exact worker stage order, retained state, response shapes, transfer lists, and import behavior.
- Confirmed the synchronous fallback currently avoids neighbor-distance computation and intentionally passes `undefined` to classic erosion.
- Identified retained hotspot state as necessary for Runevision-equivalent Reapply output.
- Located the original Runevision erosion-filter article and confirmed the described cosine-height/sine-slope pairing.
- Direct Firecrawl extraction of the Blogger body was unavailable; retained the plan as authority and switched to targeted source-code discovery.
- Recovered indexed formula context for pretend slope and partial normalization from distinctive-phrase searches.
- Recovered the primary article's exact partial-normalization, multiplicative fade-mask, and separate internal/output derivative behavior through the search index.
- Audited the query/UI and planet-code boundaries, import page, raw-height mapping, unit-sphere neighbor distances, and available regression/scale harnesses.

### Phase 2: Simplex derivatives and Morenoise
- **Status:** complete
- Defined the compatibility-preserving sampler selection: classic domain warp remains unchanged; only the final L1/L2 FBM sample switches to derivative-aware erosive FBM.
- Added derivative/value/erosive-FBM unit tests and implemented caller-owned analytical simplex derivatives plus a fixed instance scratch buffer.
- Added `fbmMode` to `applyDetailNoise`; explicit classic mode is byte-identical to the legacy default, while Morenoise is deterministic and distinct.
- Focused Morenoise tests pass under both Node and Bun.

### Phase 3: Runevision erosion
- **Status:** complete
- Finalized a spherical 3D-lattice adaptation using physical-km least-squares gradients, partial cosine/sine normalization, stacked masks, and separate internal/output slope handling.
- Implemented `js/runevision-erosion.js` with immutable physical-height input, separate output, deterministic jittered cubic cells, coastal/depth/clamp safeguards, hotspot/orogenic scaling, and the Runevision-only raw inverse.
- Added eight focused synthetic tests; all pass under Node and Bun.

### Phase 4: Pipeline, state, and transfer integration
- **Status:** complete
- Integrated both flags into the centralized worker pipeline in the requested stage order.
- Added nullable experimental layers to Generate/Edit debug state and explicit replace-or-null Reapply handling.
- Added conditional zero-copy transfers, retained hotspot state, flag-bearing worker timing/parameter records, and import-off defaults.
- Added explicit Boolean parameters to Generate, Reapply, Edit Recompute, and synchronous fallback; main-thread callers now forward transient DOM state.
- The fallback computes neighbor distances only inside the Runevision branch and still passes `undefined` to classic composite erosion.
- Added the hidden query-gated Terrain Lab controls and Inspect group plus a browser harness for all combinations and fallback behavior.

### Phase 5: Hidden Terrain Lab UI and inspection
- **Status:** complete
- Verified the controls and experimental Inspect group remain hidden without `?terrainLab=1` and appear with the exact query flag.
- Verified either checkbox enables Reapply while leaving the planet code unchanged.
- Exercised neither, Morenoise-only, Runevision-only, and both through Generate and Reapply at ~31K regions.
- Verified repeated Reapply is byte-identical, disabling both restores the baseline from `prePostElev`, stale layers clear, Edit Recompute attaches layers, and heightmap import forces both flags off.
- Forced Worker construction to fail and verified the synchronous fallback returns finite Morenoise/Runevision layers.

### Phase 6: Regression, scale, and performance verification
- **Status:** complete
- Focused Simplex, detail-noise, Runevision, and plate-motion unit tests pass; all changed JavaScript modules pass syntax checks and `git diff --check` is clean.
- The six-case golden-master harness reports every default-off elevation and climate array byte-identical to the checked-in baseline.
- The full three-seed scale-invariance ladder passed at ~5K, ~31K, ~100K, ~299K, and ~801K; GATE aggregate was 0.2283 against the 0.2450 threshold.
- Added and ran `tuning/terrain-lab-evaluation.mjs`, which records two runs of all four combinations at 299,001 regions plus screenshots, relief/slope, pit, river/gully, Strahler, and per-stage timing statistics.
- At 299K, Morenoise measured 1.0047x baseline post-processing time (guardrail <=1.15x); Runevision measured 107.9 ms versus 403.85 ms for composite erosion.
- The final worker browser integration and forced synchronous-fallback browser test both pass without page errors.

## Test Results
| Test | Result |
|------|--------|
| `node --test` focused terrain suites + existing plate-motion suite | PASS (4 files); unrelated stale planet-code fixture separately noted |
| Changed-module `node --check` checks | PASS |
| `tuning/regress.mjs` | PASS — all six cases byte-identical |
| `tuning/scale-invariance.mjs --check` | PASS — 0.2283 <= 0.2450 |
| `tests/terrain-lab-browser.mjs` | PASS |
| `tests/terrain-lab-fallback-browser.mjs` | PASS |
| `tuning/terrain-lab-evaluation.mjs` | PASS — both 299K performance guardrails |

## Error Log
| Error | Attempt | Resolution |
|-------|---------|------------|
| Scale harness local listener returned `EPERM` in the sandbox | 1 | Re-ran with scoped browser/local-server permission; full ladder passed. |
| Existing planet-code motion unit test throws from missing newer climate arguments | 1 | Confirmed fixture predates current encoder signature and did not modify it as part of Terrain Lab; golden-master and browser serialization checks pass. |

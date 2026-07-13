# Findings: Experimental Morenoise and Runevision Terrain Filters

## Performance Analysis Scope (2026-07-13)
- User request: analyze the project for performance improvements, potentially substituting compute-heavy areas with Rust/WASM.
- This is an exploratory analysis. Existing measurements and code structure will be reported as facts; new recommendations remain proposals until benchmarked.
- No implementation change is part of this task.
- The working tree already contains extensive terrain-lab changes from the previous task; treat all non-planning-file modifications as user-owned/current work and do not alter them.
- The application is a browser-first, dependency-light JavaScript project using native ES modules, a dedicated planet worker, Delaunator, PNGJS, and Puppeteer. There is no current Rust/WASM build toolchain in `package.json`.
- Existing performance/quality infrastructure includes regression, scale-invariance, auto-tuning, browser smoke/editor tests, a terrain-lab evaluation harness, and a prior `PERFORMANCE_AND_ACCURACY_PROPOSAL.md` that must be reconciled with current code.
- Product priority is creative velocity: plausible, attractive planets generated in seconds, with artistic appeal and ease of use outranking scientific precision. Performance work should therefore target interactive generation/reapply/edit latency and mobile memory pressure before offline maximum-throughput gains.
- The documented Detail range is roughly 5K–2.56M Voronoi regions, default ~204K; automatic climate stops above 300K, indicating climate cost is already managed as a known high-resolution bottleneck.
- A prior audit proposed several strong candidates: avoid duplicate post-worker work, transfer worker adjacency rather than rebuild it, replace hotspot nearest-region brute force, lazily compute terrain metrics, eliminate color-array allocation churn, reuse coarse meshes for large-radius climate fields, reduce repeated erosion sorting, and pool full-size scratch arrays. These are hypotheses to validate against current code because the proposal predates substantial project changes.
- The prior audit also correctly warns that the main pipeline is a dependency chain; multi-worker sharding would be a substantial halo/ghost-region architecture, not a quick parallelism win.
- The proposal was grounded against old commit `cc2662b`; many of its feature observations are now stale (several proposed features have shipped), so each performance item needs revalidation rather than repetition.
- Current source concentration is high: `elevation.js` (~2.7K lines), `planet-mesh.js` (~2.65K), `main.js` (~1.57K), `planet-worker.js` (~1.4K), `generate.js` (~1.15K), `terrain-post.js` (~1.1K), `temperature.js` (~1.03K), and `wind.js` (~0.93K). These dominate the initial audit surface.
- Existing instrumentation fields include elevation substage, pipeline, post-processing, and climate timings. Reusing those timings is preferable to guessing from source size or asymptotic complexity.
- Current code already logs worker pipeline, elevation substage, post-processing, reapply, edit, climate-only, main-thread reconstruction/color/state/build, and total timings in the browser console. The old proposal's “surface timing” recommendation is obsolete.
- Terrain Lab has machine-readable post-stage timing capture, but its generated artifact directory is ignored/not visible through the repository file inventory; the harness can be rerun if broader measurements are needed.
- `computeTerrainMetrics` still exists in the Generate path, but current context around its call must be checked: the old claim that it is unconditionally computed may now be stale.
- Revalidation shows several old “free wins” have already shipped: worker adjacency is transferred and injected into `reconstructMesh`; high-resolution plate smoothing is physically scaled; terrain metrics default off behind `computeMetrics`; and diagnostic timings are surfaced.
- Generation retains full worker state for Reapply/Edit, then sends output to the main thread. Retention cloning is explicitly timed. Top-level geometry/elevation/river buffers and experimental terrain layers use zero-copy transfer, but most climate fields and ordinary `debugLayers` buffers are not in the visible transfer list and therefore appear to be structured-cloned so the worker can retain them. At large N, worker→main serialization/copy and duplicate residency may be a major cost/memory surface; confirm with measurements and exact aliasing/retention needs.
- The pipeline computes the final river drainage graph on every generation even when rivers may be hidden, then computes flow once without precipitation and a second time after climate. The first pass is necessary only for no-climate output or perhaps progress; when climate runs, it looks potentially redundant.
- Main-thread generation still calls a full `buildMesh()` after reconstruct/state setup. This is necessary for initial display, unlike climate-only recoloring; measure it separately because it can dominate interaction latency independently of worker compute.
- The old climate recolor recommendation is also already implemented: `climateDone` merges arrays, updates the river overlay, and calls `updateMeshColors()` rather than rebuilding geometry.
- `reconstructMesh` now passes the received CSR adjacency into `SphereMesh`, confirming duplicate adjacency reconstruction is gone.
- On-demand climate currently reports only worker compute timing; it does not expose worker→main clone/transfer latency or color-update latency, even though numerous N-sized climate/debug arrays cross the boundary. This is an instrumentation gap worth fixing before a WASM migration.
- `handleComputeClimate` transfers only `riverFlow`. Wind and ocean arrays are retained as worker caches, so cloning them is currently intentional; however precipitation, temperature, rain-shadow, cloud, and classification buffers are not retained and are still structured-cloned. Those ephemeral outputs are immediate low-risk transfer-list candidates.
- Climate result objects deliberately alias some arrays between top-level fields and `climateDebugLayers`; structured clone should preserve that graph identity, so duplicate object references do not necessarily mean duplicate copies. The underlying non-transferred buffers still incur one full copy each.
- A 2.56M-region `Float32Array` is ~9.8 MiB. Avoiding copies of just eight ephemeral climate/debug arrays would remove roughly 78 MiB of worker→main copying and duplicate transient residency at max Detail; exact counts/types should be enumerated before implementation.
- For Generate, `W` retains geometry, elevation baseline/final, core geology fields, and cached wind/ocean state, but it does not retain the complete `debugLayers` object. Most non-retained debug buffers are therefore candidates for zero-copy transfer, independent of Rust/WASM.
- The existing 299K Terrain Lab benchmark deliberately forces `skipClimate=true`. Its worker-total numbers are useful for mesh/plates/elevation/post/rivers/retention, but cannot rank climate kernels, transfer cost, or main-thread rendering.
- Terrain Lab evaluates four feature combinations twice and records post-stage medians. It also performs substantial in-page terrain statistics after each generation, outside the captured worker timing, so only its recorded worker/post fields should inform compute conclusions.
- Existing measured baseline at 299,001 regions with climate skipped (two runs, warm/cold variance): median worker total 3,096.6 ms; post-processing 808.5 ms (~26% of worker time). Within post-processing, composite erosion is 502.05 ms (~62% of post, ~16% of worker), terrain warp 168.75 ms (~21% of post), and the two detail-noise passes total 99.25 ms (~12% of post). These are current evidence for kernel prioritization.
- The same artifact shows large two-run variance (baseline worker 3,335.9 vs 2,857.3 ms; post 874.1 vs 742.9 ms), so tiny differences are noise. Candidate validation needs more warm runs and medians, ideally isolated stage benchmarks.
- Runevision itself is 107.9 ms at 299K, while enabling it reduced later composite-erosion time enough that total post time remained near baseline. It is compute-heavy enough to port technically, but not a first-priority optimization based on end-to-end impact.
- The Detail slider default (`600`) maps to ~204K regions; the browser skips automatic climate only above 300K. A representative profile should therefore include ~204K with climate and ~299K without climate.
- `erodeComposite` remains allocation- and sort-heavy: multiple N-sized typed arrays plus a JS `landCells` array, full elevation comparator sorts at two loop sites, and separate glacial buffers. This is an excellent coarse-grained Rust/WASM candidate from a data-layout perspective, but an algorithmic reduction in sorting may offer a larger/cheaper win.
- River graph construction performs another land-cell elevation sort after composite erosion. This might be reusable from the final erosion iteration if the required final ordering/drainage semantics can be preserved, avoiding an additional O(L log L) pass.
- Runevision uses contiguous typed arrays and mostly numerical loops, but allocates several full-size buffers (including `Float64Array` physical heights). It is WASM-friendly technically; its measured share keeps it below composite erosion and broader elevation/climate kernels in priority.
- Current `erodeComposite` sorting cost is worse than a single per-iteration sort: with defaults observed at 299K (`h=10, g=5`), the first five iterations sort once before glacial and again before hydraulic, then the remaining five hydraulic iterations sort once—15 full land-cell sorts—plus priority-flood ordering and the final river-graph sort.
- A Rust port must preserve ordering semantics explicitly. JavaScript's stable sort plus repeated `Float32Array` writes can make equal-height/tie behavior deterministic; Rust should use an explicit `(height desc, region id)` order or a stable/radix scheme, and golden-master output expectations may need to distinguish bit identity from visual/statistical equivalence.
- The final river graph cannot simply reuse an early erosion order because rebound, sharpening, soil creep, and Runevision/detail stages may change final elevations. A shared final sort helper or bucket/radix implementation is safer than reusing stale order.

## Fresh Browser Profile (2026-07-13)
- Method: headless Chromium, fixed seed 424242, three full generations per case, current dirty working tree, medians taken manually from the three recorded runs. Timings are directional rather than laboratory-grade due browser/JIT variance.
- Default path (~204K, climate on): wall 6,935 ms; worker 6,583 ms; estimated dispatch + worker-to-main clone 148 ms; main work after result arrival 78 ms.
- Default top-level worker medians: wind 2,935 ms (44.6% of worker); elevation 866 ms (13.2%); precipitation 804 ms (12.2%); terrain post 562 ms (8.5%); temperature 372 ms (5.7%); coarse→fine plate projection 331 ms (5.0%); ocean 163 ms (2.5%); sphere mesh 147 ms (2.2%). Parent and nested timing rows must not be summed together.
- The wind model's ITCZ computation is the standout substage: median 2,729 ms, ~93% of wind and ~41.5% of the entire worker time. This outranks every proposed Rust target and must be algorithmically inspected first.
- Precipitation advection is the next climate kernel: summer + winter medians total ~443 ms. Temperature's continentality-zone computation is ~249 ms. These are meaningful but much smaller than ITCZ.
- 299K climate-off path: wall 3,180 ms; worker 2,862 ms; estimated dispatch + clone 189 ms; main work after arrival 96 ms. Top-level medians: elevation 1,106 ms (38.6%); terrain post 668 ms (23.3%); coarse→fine projection 475 ms (16.6%); sphere mesh 220 ms (7.7%).
- At 299K, post median components in this profile: composite erosion ~382 ms, terrain warp ~160 ms, detail noise ~89 ms combined. These align directionally with the existing two-run Terrain Lab artifact.
- The worker timing has an uninstrumented gap (~190 ms at 204K and roughly ~270 ms at 299K) covering detail-field derivations, river graph/initial flow, debug attachment, and other glue. The river graph is a likely material share and should get its own timer before port decisions.
- Dispatch/clone estimates combine main→worker command delivery and worker→main delivery; command input is tiny, so output cloning likely dominates, but this is an inference rather than an isolated measurement.

## ITCZ Root Cause
- `computeITCZ` evaluates 72 longitude columns × ~25 latitude candidates × two seasons. For every candidate it performs both a dual-radius 5°/30° spatial query and another 30° poleward query over fine-mesh regions in intersecting bins.
- The spatial index prevents an all-N scan per query, but 30° caps still contain thousands of fine regions. Every included candidate currently evaluates `Math.cos(r_lon[r] - lon)` for a spherical-distance test. Repeating tens of millions of transcendental calls explains the measured ~2.7 s.
- Exact/low-risk JS optimization option: compute both seasonal ITCZs through one shared query grid. The local/wide geographic samples are season-independent, and the ±15° poleward samples fall on the same 2.5° grid. Precomputing all unique lat/lon queries once can eliminate duplicate seasonal and poleward sampling without changing the score formula.
- Another low-risk optimization: replace per-candidate `Math.cos(lon difference)` with a dot product against precomputed Cartesian region coordinates (or precomputed `cosLat*cosLon`, `cosLat*sinLon`, `sinLat`). This preserves the same spherical-cap test concept while removing the hottest transcendental operation.
- Higher-gain/controlled-accuracy option: aggregate land count/elevation per existing 2.5°×5° geographic bin, then query bin aggregates (or a fixed ~20K coarse mesh) instead of every fine region. Because the resulting 72-point ITCZ is heavily smoothed through seven longitude passes, fine-cell exactness is likely unnecessary, but Earth-match and scale-invariance gates must validate the approximation.
- Rust/WASM could speed the current cap-query kernel, but porting it before removing duplicate queries/transcendentals would optimize avoidable work. The algorithmic JS path has a plausible multi-second payoff with much less integration risk.
- The existing geographic index uses 36×72 five-degree bins and stores per-region indices, not aggregate statistics. That makes an aggregate-bin experiment especially localized: add count/land/elevation sums alongside the existing CSR index and compare output/quality before considering a coarser global architecture.

## Precipitation Surface
- The measured “advection” timer includes heuristic wind construction, wind-vector arrays, convergence construction/smoothing, and moisture advection—not only the final moisture loop. More granular timing is needed before choosing a port boundary.
- Moisture advection performs up to 60 full-mesh relaxation passes per season, inspecting adjacency and allocating multiple N-sized seasonal arrays. This is a reasonable Rust/WASM kernel only if invoked once per whole seasonal pass set; a per-pass or per-region boundary would be counterproductive.
- Lower-cost alternatives remain attractive: execute large-radius climate fields on a fixed coarse mesh, reuse seasonal scratch buffers, and avoid recomputing geometry-derived wind/elevation vectors. These change asymptotic or allocation cost where a straight port changes only constant factors.

## Other Measured Kernels
- Temperature's ~249 ms continentality stage is a collection of BFS/zone computations rather than the per-cell temperature formula; moving only the final formula to WASM would miss most temperature time.
- Coarse→fine plate projection (~331 ms at 204K, ~475 ms at 299K) performs multi-octave 3D simplex perturbation plus a warm-started greedy coarse-adjacency walk per fine region. It is a self-contained, typed-array numerical kernel and therefore a strong Rust/WASM proof-of-concept candidate after the larger ITCZ algorithm win.
- Plate projection is only ~5% of default climate-on worker time, so even a hypothetical 3× port saves ~220 ms. It matters more for climate-skipped generation (~16.6% at 299K), but should be judged against caching structural work when users rebuild the same seed/mesh.
- Current code already contains the reusable `r_coarseIdx` concept implicitly but discards it after looking up `coarse_r_plate`. Returning the nearest-coarse index would enable coarse climate projection and reuse without a second nearest-neighbor walk.

## Temperature Continentality Root Causes
- The ~249 ms continentality stage contains avoidable repeated grid scans. Per-region subcontinental width recomputes occupancy/largest-gap over the same 720-bin component/latitude row; compute that row's width once and look it up per region.
- North/south coast shaving scans latitude occupancy outward per qualifying region, and west-coast shaving scans up to 720 longitude bins per land region. Both can be replaced with precomputed directional-distance tables per component/grid row while preserving the same discrete rules.
- Small-patch cleanup flood-fills patches, then for every small patch scans all N regions once to find neighbors and again to rewrite cells: O(number_of_small_patches × N). Recording each patch's cell list/boundary counts during the initial flood makes this near O(N + edges).
- These are algorithm/data-structure fixes with likely larger gains and simpler regression semantics than a Rust port. After eliminating them, the remaining BFS and typed-array loops could be considered for WASM only if the stage is still material.

## Elevation Revalidation
- The old `findNearestR` O(N) hotspot complaint is obsolete: current `applyHotspotsAndLIPs` uses a warm-started greedy adjacency ascent with an exact fallback.
- The old unused skeleton domain-warp coordinates are also no longer present at the cited location; current warp coordinates in elevation stages are used. Do not carry this recommendation forward.
- Elevation time is distributed across many 80–170 ms stages (tectonic state, spatial fields, skeleton, phasor ridges, edifices, tectonic-band noise, coastal detail) rather than one dominant function. Porting a single small stage has limited end-to-end value; porting the whole elevation pipeline would be a large, determinism-sensitive rewrite.
- Simplex noise calls are embedded inside per-region stages. A JS→WASM call for every noise sample would likely lose to boundary overhead; any WASM experiment must batch an entire stage or make WASM own the full loop and noise state.

## Main-Thread Rendering and Memory
- The old per-frame `Vector3` allocation is fixed (`scene.js` reuses `_zoomVec`). Color helpers still return fresh 2/3-element arrays, and mesh loops destructure them per side; replacing these with scalar/out-parameter or packed-color APIs remains a valid GC reduction.
- Fresh profiles show post-arrival main work at only ~78 ms (204K) and ~96 ms (299K) in headless Chromium, so color/mesh work is not the first default-latency target on this machine. It remains important for mobile and maximum Detail memory.
- `buildMesh` creates `pos` and `col` as `Float32Array(numSides * 9)`. A spherical triangulation has roughly six sides per region, so the two attributes alone scale near 432 bytes/region: ~129 MiB at 299K and ~1.03 GiB at 2.56M, before GPU duplication, adjacency, state, map geometry, or debug fields.
- Rendering memory, not worker arithmetic, is likely the hard limiter at the advertised 2.56M maximum. Rust/WASM does not solve it. Practical options are normalized `Uint8` colors, a decimated display mesh while retaining full-resolution export data, deferred/disabled high-detail globe geometry, or a shader/renderer redesign that avoids duplicating three full-color floats per side vertex.
- Building the map mesh is already deferred unless map mode is active, which avoids one major simultaneous GPU allocation. Keep that policy in any redesign.
- Debug/inspection memory is another high-resolution multiplier. Elevation initializes at least 13 N-sized float layers, adds classification/snapshot layers, then the worker attaches five plate-physics layers, erosion, and roughly 15 climate layers. Several debug fields alias top-level results, but the object still exposes on the order of 35–40 full-region buffers.
- Most non-climate debug buffers are not retained in `W`, yet Generate does not transfer them. A zero-copy transfer collector can reduce serialization and duplicate transient residency immediately. Longer-term, display-only debug layers can use quantized `Uint8`/`Uint16` storage plus scale metadata or become opt-in, since full float precision is unnecessary for colormaps.
- `debugLayers.tecActivity` appears allocated up front and then overwritten by `tt.r_tectonicActivity`, creating an orphaned N-sized allocation before GC. Audit initial layer allocation versus later replacement for similar transient waste.
- Exact count: elevation starts with 15 float debug arrays, adds five new classification references plus a skeleton snapshot (21 live elevation layers), optionally super plates (22), then attaches five plate-physics arrays (27), erosion (28), and 16 climate layers (44 total with climate, before optional Terrain Lab arrays). At 2.56M, 44 Float32-equivalent buffers would be roughly 430 MiB, although Köppen/Trewartha types and aliases lower the exact total somewhat.

## WASM Deployment Constraints
- The application currently promises native ES modules with no build step and imports Three.js/Delaunator from jsDelivr, including Delaunator directly inside the module worker. A Rust/WASM addition introduces a build/release toolchain and binary asset even if the compiled `.wasm` is committed.
- No cross-origin-isolation/header configuration or `SharedArrayBuffer`/WebAssembly integration exists in the repository. Single-thread WASM is the realistic first experiment. Wasm threads would require COOP/COEP-capable hosting plus a fallback for simple local servers and hosts that do not provide those headers.
- Preserve the synchronous JavaScript fallback unless the product explicitly drops older/module-worker-limited browsers. A safe rollout is feature-detected JS vs WASM inside the existing worker, with identical message contracts.

## Interactive Reapply Path
- Reapply correctly starts from retained `prePostElev`, but when climate is enabled it recomputes the full wind→ocean→precipitation→temperature chain. At default ~204K, the fresh profile implies terrain-sculpting Reapply can repay most of the ~4.3 s climate cost, especially the 2.7 s ITCZ search.
- Reapply also reconstructs the final river graph, clones it for worker retention, and returns climate/debug arrays with the same partial transfer-list issue as Generate.
- Since ITCZ geography is driven mainly by land distribution and broad elevation, investigate computing/caching it from the pre-post terrain or a coarse land/elevation field. If visual/metric gates pass, terrain smoothing/erosion changes would not need to rerun the expensive thermal-equator search; only pressure/wind fields would update.
- Main-thread Reapply rebuilds the full render mesh even though topology and coordinates are unchanged. Updating the existing position/color buffers in place could reduce GC/GPU churn and preserve materials/scene objects, though measured default main time is far below worker climate time.

## Performance & Rust/WASM Brainstorm

### Approach
<AI>Prioritize measured end-to-end latency and memory. Remove duplicated/asymptotically avoidable work before changing languages; evaluate Rust/WASM only at one-call, stage-sized boundaries.</AI>

### Ranked directions

| Rank | Surface | Current evidence | First experiment | WASM verdict |
|---:|---|---|---|---|
| 1 | ITCZ geographic sampling | 2,729 ms; ~41.5% of default worker | Shared seasonal query grid + Cartesian dot tests; then aggregate 5° bins | Do not port first; algorithm dominates language |
| 2 | High-detail memory/result delivery | ~148–189 ms estimated delivery gap; ~1.03 GiB globe pos+color at 2.56M; ~430 MiB debug-equivalent | Transfer ephemeral/debug buffers, quantize debug/color, decimate display mesh | WASM does not solve this |
| 3 | Composite erosion + rivers | ~347 ms default / ~382 ms at 299K; 15 repeated sorts plus final river sort | Stable Float32 radix/order benchmark and explicit river timing | Best production WASM candidate after algorithm pass |
| 4 | Precipitation | 804 ms total; ~443 ms bundled seasonal advection | Split timers; coarse-mesh large-radius fields; scratch reuse | Good later stage-sized candidate |
| 5 | Temperature continentality | ~249 ms; repeated row and per-patch scans | Precompute row distances/widths and patch membership | Fix algorithms in JS first |
| 6 | Coarse→fine plate projection | 331 ms default / 475 ms at 299K | Return/cache `r_coarseIdx`; exact A/B kernel benchmark | Best contained production proof-of-concept if output matches exactly |
| 7 | Whole elevation | 866 ms default / 1,106 ms at 299K, spread across stages | Improve/cache individual algorithms first | Defer; large rewrite and determinism risk |
| 8 | Runevision | 108 ms at 299K, optional/default-off | Use only to validate toolchain/memory plumbing | Safest infrastructure pilot, weak user payoff |

### Expected payoff framing
<AI>Reducing ITCZ from ~2.73 s to ~0.30 s would cut the measured ~6.94 s default wall time by roughly 35% on its own. A 3× erosion port saves only ~0.23 s on the default climate-on path, but ~0.25 s / 9% of worker time on the 299K climate-off path. A 2× plate-projection port saves ~0.17 s default or ~0.24 s at 299K. This is why the first milestone should be algorithmic ITCZ work, not a broad Rust rewrite.</AI>

### Incremental WASM architecture
<AI>

1. Add a `terrain-core` Rust crate and commit release-built web artifacts so ordinary users still need no local Rust toolchain.
2. Initialize single-thread WASM once inside `planet-worker.js`; keep the current message protocol and JS synchronous fallback.
3. Feature-gate each kernel independently (`js`, `wasm`, optional `verify-both`) so regressions and rollout are reversible.
4. Copy immutable CSR mesh data into a reusable WASM workspace once per mesh. Invoke whole kernels, never per-cell noise/functions across the boundary.
5. Copy only final stage outputs back to transferable JS buffers; account for this copy in the benchmark because WebAssembly memory ownership can otherwise hide the true boundary cost.
6. Require a warm-kernel speedup of at least 1.5× and an end-to-end win of at least 10% in its target workflow before retaining the extra implementation.
</AI>

### Validation gates
<AI>Use 10 warm runs at ~204K climate-on and ~299K climate-off, plus ~801K memory/scale checks. Preserve JS golden masters; for WASM require exact arrays where feasible (plate projection) and otherwise deterministic WASM-specific baselines plus existing relief/slope/drainage/Earth-match gates. Record peak resident/ArrayBuffer memory, initialization time, transfer bytes, and p50/p95 latency.</AI>

### Tradeoffs
<AI>Single-thread WASM fits the current worker/static-host model. WASM threads or a seasonal worker pool could help later, but require cross-origin isolation and shared-memory-aware hosting. WebGPU is attractive for regular noise/field passes, but irregular graph traversal, BFS, stable ordering, and CPU readback make it a poorer first fit than Rust/WASM for erosion and plate projection.</AI>

### Open questions
<AI>Decide whether WASM output must remain byte-identical to JS, whether the 2.56M setting must support full interactive globe rendering or only full-resolution export, and whether production hosting can guarantee COOP/COEP headers. Those choices materially change the viable memory, threading, and determinism design.</AI>

## User Requirements Captured
- Hidden Terrain Lab controls appear only for `?terrainLab=1`; flags are default-off, independent, transient, and absent from planet codes/import persistence.
- Required order: warp/smoothing → Runevision → detail passes (classic or Morenoise) → composite erosion/rebound/sharpening/creep → final rivers.
- Flag-off generation must remain byte-for-byte compatible.
- Reapply must rebuild from `prePostElev`, replace/clear experimental debug layers, and never compound.
- Worker responses should transfer non-null experimental buffers.
- Fallback computes neighbor distances only for Runevision and must not perturb classic erosion inputs.
- Morenoise changes only L1/L2 post-processing detail noise and ignores the domain-warp Jacobian.
- Runevision reads immutable inputs, estimates all slopes first in physical kilometres, locks the first coastal land ring, and writes a separate output buffer.

## Repository Findings
- `js/simplex-noise.js` currently has value-only `noise3D`, ordinary `fbm`, and `ridgedFbm`; it has no reusable scratch storage.
- `applyDetailNoise` owns domain warp and the classic FBM sample. Its safeguards, km-space amplitude mapping, geological fields, and Newton inversion can remain untouched by selecting only the final FBM sampler.
- `runPostProcessing` is centralized in `js/planet-worker.js` and is called by Generate, Reapply, Edit Recompute, and import. The import path must continue invoking it with both experiments absent/default-off.
- `generate()` currently takes five arguments ending in motion overrides; experimental options should be appended in a source-compatible position or passed as an options object.
- `reapplyViaWorker` and `editRecomputeViaWorker` are separate main-thread entry points and both already send current sculpting values.
- The worker stores immutable `prePostElev` and reconstructs Reapply elevation from it, which is the correct anchor for non-compounding experimental toggles.
- Debug arrays are already attached to `debugLayers`; Reapply currently replaces only `erosionDelta`, so experimental fields need explicit replace-or-null handling.
- The worker uses explicit transfer lists for Generate/Edit/Reapply/import responses, so nullable experimental buffers must be conditionally appended.
- `computeNeighborDist` already exists and Generate/Edit use retained distances; the synchronous fallback/import path needs a compatibility-sensitive audit because it computes distances unconditionally today.
- `runPostProcessing` currently performs warp → ocean mask → smoothing → L1/L2 detail → composite erosion/rebound → sharpening → creep, then returns only `erosionDelta`. Runevision can be inserted between smoothing and detail without moving any classic stage.
- The land/ocean mask is snapshotted immediately after warp and before smoothing. Experimental filters must reuse it to preserve classification even if their output is clamped above zero.
- Generate and Edit Recompute can attach experimental layers directly to their newly built `debugLayers`; Reapply returns layers separately and the main thread must explicitly replace them with arrays or `null`.
- Reapply presently passes no hotspot field to post-processing. To preserve Runevision's hotspot damping on Reapply, generated/edit state must retain a private hotspot clone; imports retain `null`.
- Worker Generate currently computes neighbor distances unconditionally for the existing composite erosion. The synchronous main-thread fallback deliberately passes `undefined` to classic erosion and computes none; it should call `computeNeighborDist` only when Runevision is enabled and still pass `undefined` to classic erosion.
- Heightmap import is worker-only, already computes neighbor distances for classic processing, and should omit experimental flags so both remain off.
- Terrain Lab flags should be read separately from serialized sliders. Existing planet-code code reads only known slider IDs, so keeping them out of `readSliders` prevents accidental persistence.

## Technical Decisions
- The named Runevision technique is Rune Skovbo Johansen's March 2026 “Fast and Gorgeous Erosion Filter.” Search metadata confirms its core pairing: gully height offset follows cosine while slope follows sine. Source: https://blog.runevision.com/2026/03/fast-and-gorgeous-erosion-filter.html
- The repository implementation will use the supplied plan as authority for the experiment's constants and safeguards; the public technique check is only being used to disambiguate the cosine/sine construction.
- Direct main-content scraping of the original Blogger article returned navigation only, so the article body is not available through a static/JS scrape. Targeted source-code searches are the next non-interactive route.
- Indexed snippets from the original article clarify that the “pretend slope” is intended to approximate the typical slope of the resulting eroded terrain, and that the chosen partial normalization can introduce second-order (slope) discontinuities. This supports keeping a separate smooth derivative for blending while using a signed internal gully slope.
- The primary article's indexed body specifies partial normalization precisely: treat interpolated cosine/sine as a vector, multiply its length by `k=2`, clamp that length to one, then divide by the original length. Thus magnitudes at or above 0.5 normalize fully while smaller magnitudes are amplified by 2 without singular normalization.
- “Straight gullies” use `sign(sine)` only for the internal slope that directs later octaves. Output height and output derivatives retain the smooth sine and are faded normally, so internal direction discontinuities disappear from the visible output.
- Stacked fading uses a multiplicative combined mask. Each octave is blended toward the prior fade target; the new mask contribution updates `combiMask = pow_inv(combiMask, detail) * newMask`, where `pow_inv(t,p) = 1 - (1 - clamp(t,0,1))^p`.
- The author describes a gully-weight compensation (e.g. halve gully weight and double erosion strength) for pointier peaks. The supplied plan's “factor 2” is interpreted as the specified cosine/sine partial-normalization factor, not an additional undocumented strength compensation.
- The companion reference implementation is the author's Shadertoy `wXcfWn` under MPL-2.0; local code will be independently adapted to spherical lattice sampling and the repository's requested constants.
- `computeNeighborDist` stores unit-sphere chord lengths, so Runevision must multiply distances by 6371 km for its least-squares solve and octave-resolution gate.
- The existing `elevationToKm` mapping is `6t⁴(5−4t)` for positive raw land height. Runevision will define its own km-to-raw inverse helper; classic detail noise keeps its inlined Newton inversion unchanged.
- The hidden controls belong in `index.html` only. `import.html` has its own UI and calls `importHeightmap` without flags, naturally keeping both experiments off.
- Golden-master coverage is `tuning/regress.mjs`; scale/determinism and the requested ~31K/~100K/~299K/~801K ladder are already present in `tuning/scale-invariance.mjs`.
- The repository has Node's built-in test runner and Puppeteer but no npm scripts; focused pure tests should use `node --test`, browser integration should call its `.mjs` harness directly.

## Verification Findings
- Simplex derivative/value, classic-detail compatibility, Morenoise determinism, and all Runevision synthetic tests pass under Node; the focused Runevision suite also passes under Bun.
- Synthetic Runevision coverage verifies km/raw inversion, flat-field direction suppression, planar downhill-parallel stripes, radial hill variation, dateline/polar continuity, exact reversed-order identity, coastal locking/classification, and hotspot/orogenic attenuation.
- The existing six-case golden master is byte-identical with experimental flags omitted, proving the default-off path did not perturb elevation or climate arrays.
- Browser integration verifies all four flag combinations, deterministic Generate, non-compounding Reapply, baseline restoration, Edit Recompute, conditional layer transfer/clearing, transient planet codes, and import-off behavior.
- The full scale ladder passed at ~5K/~31K/~100K/~299K/~801K with a 0.2283 GATE aggregate versus the 0.2450 acceptance threshold.
- The 299K experimental evaluation passed both timing guardrails: Morenoise 1.0047x baseline total post time; Runevision 107.9 ms versus composite erosion at 403.85 ms.
- The 299K report records relief and slope distributions, pit counts, Runevision slope, drainage/gully correlation, Strahler branching order, worker/post-stage timings, and four screenshots in the ignored tuning artifact directories.
- The existing SP6 planet-code motion test fixture predates the encoder's added climate parameters and fails before reaching its assertions; this is unrelated to Terrain Lab and was left untouched.

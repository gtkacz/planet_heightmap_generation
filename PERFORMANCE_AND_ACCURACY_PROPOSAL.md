# World Orogen — Performance & Scientific-Accuracy Enhancement Proposal

## How this was produced

Five parallel subsystem audits, each grounded in `file:line` against the current tree
(`main`, HEAD `cc2662b`): (1) terrain/erosion, (2) tectonics/plates, (3) wind/ocean,
(4) temperature/precipitation/Köppen, (5) mesh/worker compute backbone.

**Headline context:** the codebase is far more mature than its own planning docs suggest.
Most features described as "planned" in `HEIGHTMAP_REALISM_PLAN.md` / `OCEAN_REWORK_PLAN.md` /
`WIND_SIMULATION_PLAN.md` have **shipped**: hydraulic/thermal/glacial erosion, isostasy,
hypsometric correction, phasor (Gabor-wavelet) ridges, mantle-convection plate physics,
seasonal winds with ITCZ migration + monsoons, ocean currents, 30-class Köppen with satellite
biome coloring. So the proposals below are at the frontier, not catch-up.

Two structural facts frame everything:

- **The climate system — the single most-cited differentiator — has ~100 Earth-tuned internal
  parameters (`climate-config.js`) but only *two* user knobs** (temperature offset, precipitation
  offset). Many high-value "features" are really just exposing physics that already runs.
- **Generation is one hard sequential chain on a single Web Worker.** There is no stage-level
  parallelism to harvest; the levers are cheaper algorithms, scale-invariance correctness, and
  reusing already-computed data.

All recommendations honor the project's constraints: **fast is non-negotiable**, scale-invariance
(2K–2.5M cells look equivalent), the climate system is deepened never simplified, the seven loved
strengths are preserved, and ties break artistic > usability > scientific plausibility.

> **Caveat on validation:** the climate Earth-match harness (`tuning/climate/evaluate.mjs`) could
> not be run during the audit — no `package.json`/`node_modules`, `pngjs` missing, ground-truth
> grid gitignored. Any climate-parameter change below must be validated with
> `node tuning/climate/evaluate.mjs` in a proper environment before/after, per CLAUDE.md.

---

## TL;DR — top recommendations

| # | Recommendation | Type | Effort | Payoff |
|---|---|---|---|---|
| P1 | Fix erosion flow-accumulation scale-invariance (raw hop counts ∝ N) | Perf/correctness | Med | Erosion finally looks the same at every Detail |
| P2 | Coarse-mesh reuse for large-radius climate diffusion/advection | Perf/structural | Med | Fixes O(N^1.5) blow-up **and** the moisture-advection bug |
| P3 | Free-wins bundle (dead code, `findNearestR`, climate recolor, gate metrics, GC churn) | Perf | Low | Faster generation, zero behavior change |
| P4 | Hardcoded-pass fixes (plate-smooth `3`, stress-dir `2`, soil-creep `3`) | Perf/correctness | Low | Removes 22× smoothing-radius swings across Detail |
| F1 | Axial-tilt / obliquity slider (machinery already accepts it) | Feature | Low | High artistic + scientific range, near-free |
| F2 | Greenhouse-strength slider | Feature | Low | Hot/cold worlds; no greenhouse term exists today |
| F3 | Couple ocean currents to the real wind field (currently ignored) | Feature/perf | Low | More correct **and** deletes code |
| F4 | Lithology erosion + isostatic rebound + ridge-age bathymetry | Feature | Low | Three textbook effects, all reuse computed data |
| F5 | Rivers rendered from the existing drainage graph | Feature | Med | CLAUDE.md explicitly wants this; backbone is free |
| F6 | User-editable plate velocity / Euler pole | Feature | Med (UI) | Signature "haven't-seen-this-anywhere" delight, zero compute cost |

---

# PART 1 — PERFORMANCE ENHANCEMENTS

Fast is non-negotiable, so this is organized so the free, zero-risk work comes first, then the
correctness bugs (several of which *also* speed things up), then the structural changes that buy
headroom for higher fidelity.

## 1A. Free wins — pure subtractions, no tradeoff

Do these regardless of anything else. None change output (except where noted), all reduce work.

1. **Delete dead domain-warp coordinates in `buildSkeleton`** — `elevation.js:897-898, 920-923`.
   `wx/wy/wz` are computed for **every** cell (3 fbm calls = 6–9 `noise3D` evals) and then never
   read anywhere in the function. Pure deletion. *Caveat worth a 60-second A/B first:* the comment
   at line 920 says feature noise was *meant* to be domain-warped — this may be a latent regression.
   If so, the fix is to *reinstate* (swap the rift/ridge feature-noise calls to use `wx/wy/wz`),
   which is also free and may make those shapes more organic. Verify delete-vs-reinstate visually.

2. **`climateDone` should recolor, not rebuild** — `generate.js:665` calls full `buildMesh()` where
   `updateMeshColors()` (`planet-mesh.js:981-1132`) suffices. Climate changes touch no geometry,
   winding, wireframe, borders, or grids — `buildMesh` redoes all of it. Strict win.

3. **Stop rebuilding the mesh adjacency on the main thread** — `reconstructMesh()` (`generate.js:81-83`)
   runs `new SphereMesh(...)`, rebuilding the O(numSides) CSR adjacency the worker already built.
   Transfer the worker's `adjOffset`/`adjList`/`adjTriList` typed arrays (zero-copy) and inject them
   instead of recomputing.

4. **Replace `findNearestR`'s O(N) brute force** — `elevation.js:1975-1982`, called ~50×/generation
   in `applyHotspotsAndLIPs` (`NUM_HOTSPOTS×(UPWELLING_CANDIDATES+1) + tail`), ≈128M dot-products at
   max Detail. The efficient pattern already exists in the same codebase: `projectCoarsePlates`'
   warm-started greedy adjacency walk (`coarse-plates.js:89-114`), and a lat-lon bin grid two
   functions away in the dome-uplift loop (`elevation.js:2210-2320`). Extract a shared
   `nearestRegion(...)` helper, warm-start it across the hotspot chain. ~1000× cheaper, identical output.

5. **Gate the always-on `computeTerrainMetrics`** — `planet-worker.js:412-428` runs ~19 metric
   functions (several O(N log N) sorts, BFS/connected-components) on **every** generation, whether or
   not any scorecard UI is open. Compute lazily (on panel open) or behind a debug flag.

6. **Kill color-function allocation churn** — every color fn (`elevationToColor`, `biomeColor`, …)
   returns a fresh 3-element array per call; `buildMesh`/`updateMeshColors` allocate ~15.4M of them
   at max Detail (~46M in the smooth-heightmap debug branch, which calls `colorFn(e)[0]` three times
   per side just to read one channel). Rewrite to write into an output array / return packed scalars.
   Pure GC-pressure relief — matters most on the mobile devices CLAUDE.md protects.

7. **Hoist the per-frame `Vector3` in `tickZoom`** — `scene.js:59` allocates every animation frame.
   One-line fix.

8. **Surface the timing instrumentation that already exists** — `_timing` (elevation sub-stages),
   `_pipelineTiming`, `_postTiming`, `_climateTiming` are all computed and returned but not logged by
   default (`generate.js:337-371`, `elevation.js:2518-2613`). Logging them is the zero-cost
   prerequisite to confirm the real hotspot order before investing in 1B/1C — several hotspot claims
   below are complexity-derived, not profiled, and should be checked against real numbers first.

## 1B. Scale-invariance correctness bugs

Each violates the project's own written rule ("never use raw cell-hop counts / neighbor-displacement
magnitudes without scaling by resolution"). Symptom: the *same slider value* produces a *different
result* at different Detail. Fix pattern is the project's own idiom
`Math.max(minPasses, Math.round(targetKm / avgEdgeKm))`, with one calibration pass to pick `targetKm`
so the default-Detail look is preserved.

1. **Erosion flow-accumulation (highest consequence)** — `terrain-post.js`: `flow[r]` (600-643) and
   `iceFlow[r]` (526-535) are raw per-cell counts standing in for drainage area / ice volume. For a
   fixed physical catchment the count grows ∝ numRegions; the compensating `cellDist` term (∝ 1/√N)
   only partially offsets it, so with the hardcoded `m=0.5` the net stream-power strength scales
   roughly **linear in N** — a 512× Detail range implies 2–3 orders of magnitude difference in
   erosion for the same slider. **Verify visually first** (same seed at 5K vs 2.56M, `hydraulicErosion=0.5`),
   then normalize `flow`/`iceFlow` by an expected-cells-per-area factor (or fold into `K`/`gCarveRate`).
   This is the single most consequential correctness bug found.

2. **Moisture-advection reach clamp** — `precipitation.js:211`,
   `maxHops = max(8, min(20, round(PRECIP_ADVECT_REACH_KM / avgEdgeKm)))` with `PRECIP_ADVECT_REACH_KM=3961`.
   The `min(20,…)` shrinks physical reach as Detail rises: 100% of nominal at 5K, ~50% at 40K (the
   tuning suite's *own* default), ~6% (250 km vs 3961 km) at max. Continental-interior aridity/monsoon
   penetration silently weakens with Detail. *Independently found by two audits.* Best fixed via 1C
   (coarse mesh), not by raising the cap (which would violate the speed constraint).

3. **Rain-shadow propagation is UNCLAMPED** — `precipitation.js:583` (shadow, 3363 km) and `:611`
   (windward, 1500 km) have only a floor, no ceiling: ~269 + ~120 = ~389 full-mesh passes at max
   Detail (~10⁹ cell-visits), plausibly the dominant precipitation cost. The inconsistency with #2
   (one clamped for cost, one unclamped) is accidental, not a deliberate tradeoff. Capping both via
   the coarse mesh (1C) is likely a **direct speed win with no accuracy loss**.

4. **Hardcoded plate-smoothing `3` passes on the hi-res mesh** — `planet-worker.js:232` and
   `generate.js:741` (`smoothAndReconnectPlates(mesh, r_plate, coarsePlateSeeds, 3)`). This runs on
   the Detail-sized mesh, so 3 passes = 849 km of smoothing at 5K but 37.5 km at max — a **22.6×
   radius swing** purely from the Detail slider. Fixing it makes the step *cheaper* at high Detail.
   (Note: the *other* `smoothAndReconnectPlates` call, inside `generatePlates`, runs only on the fixed
   20K coarse mesh and is correctly resolution-stable — leave it.)

5. **`STRESS_DIR_SMOOTH_PASSES = 2`** — `elevation.js:305-332`, a flat pass count with no `scaleFactor`
   (unlike the correctly-scaled stress-magnitude BFS in the same function). Same class as #4, subtler
   effect (it smooths orogen-belt *orientation coherence*, not feature width).

6. **`applySoilCreep(mesh, …, 3, 0.1125)`** — `planet-worker.js:151`, unconditional, fixed iterations
   *and* fixed strength. This is an exact structural match to CLAUDE.md's prohibited example
   (`smooth(mesh, field, 5)`). Hillslope rounding weakens with Detail.

## 1C. Structural — headroom for higher fidelity without slowdown

1. **Coarse-mesh reuse for large-radius climate fields.** The O(N^1.5) cost of holding a *physical*
   smoothing radius while N grows is dominated by ocean-warmth smoothing (900 km, `ocean.js:357`) and
   precipitation's advection + rain-shadow propagation. The plate system already proves the fix:
   generate/relax on a fixed `N_COARSE=20000` mesh, then project to hi-res via
   `projectCoarsePlates`' warm-started adjacency walk (`coarse-plates.js:53-120`). **Concrete
   mechanism:** factor out the per-region nearest-coarse-region index that `projectCoarsePlates`
   currently *discards* into a reusable `r_coarseIdx = Int32Array(N)` (computed once), run the
   large-radius diffusion/advection on the 20K coarse mesh, then `fineField[r] = coarseField[r_coarseIdx[r]]`
   (or barycentric over `coarseMesh.adjList` for smoothness — *not* the plate-average shortcut at
   `planet-worker.js:291-304`, which produces a step function). Turns O(N^1.5) → ~O(N) **and**
   dissolves bug 1B#2/#3 as a side effect, since coarse-mesh pass counts are Detail-independent.

2. **Incremental sort in `erodeComposite`** — `terrain-post.js:503` re-sorts *all* land cells every
   one of ~20–30 iterations (400–600M comparisons at max Detail) though elevations change only
   incrementally. Bucketed/partial sort or incremental reinsertion → ~O(L) per iteration. Do *after*
   1B#1, since that changes the erosion magnitudes this operates on.

3. **Incremental recompute on plate edit.** `handleEditRecompute` (`planet-worker.js:604-607`)
   correctly skips mesh/plate regeneration but reruns `assignElevation` in **full** over the whole
   hi-res mesh (plus full post-processing) on every Ctrl-click Rebuild — likely re-paying most of
   total generation cost. Restrict `assignElevation` to a dirty BFS-frontier around toggled plate
   boundaries (adjacency is already available). **Caveat:** stress/mantle fields may have long-range
   coupling that defeats naive dirtying — needs investigation of `elevation.js` internals before
   committing. High value for the cherished editing loop. (The slider "Reapply" path, `handleReapply`,
   is already a well-targeted incremental recompute — it reuses the cached `prePostElev` snapshot and
   reruns only post-processing. Leave it.)

4. **Memory / GC.** ~11 transient `Float32Array(numRegions)` smoothing buffers per generation from
   wind+ocean alone (~112 MB churn at max Detail); accept an optional shared scratch buffer. Port
   `wind.js`' four `.push()`-based BFS queues to the preallocated `Int32Array` pattern `ocean.js`
   already uses. Mobile-relevant.

5. **Parallelism (honest framing, future R&D — not a quick win).** The pipeline is one hard
   dependency chain: mesh → plates → elevation → post-processing → wind → ocean → precip → temp →
   Köppen. Temperature consumes precipitation, so even the climate stages can't run as concurrent
   siblings. No `SharedArrayBuffer`/`OffscreenCanvas` exists today. The only real lever is
   *data-parallel sharding within* a dominant stage (`assignElevation` / erosion) across a worker
   pool with halo/ghost-region exchange at shard boundaries — a genuine architectural project. Worth
   naming as the path to much higher default resolution, but scoped honestly as large.

---

# PART 2 — NEW SCIENTIFIC-ACCURACY FEATURES (user-controllable)

The organizing insight: the climate engine already computes far more than it exposes. The
highest-value/lowest-cost features are *knobs on existing physics*, not new simulation.

## 2A. Planetary controls — expose physics that already exists

1. **★ Axial tilt / obliquity slider.** `computeWind` already accepts `axialTilt` (hardcoded 23.5°)
   and `computeITCZ` already uses it (`subsolarLat = sign × tiltRad`, `wind.js:245`); the entire
   ITCZ-excursion and seasonal-contrast chain is tilt-aware. Cost is pure plumbing: a slider, thread
   the value to every `computeWind` call site, and a `planet-code.js` encoding entry. A high-obliquity
   world shows dramatically different, distinctive climate belts — big artistic range for near-zero
   compute. Best value-per-effort feature in this document.

2. **Rotation-rate → Coriolis control.** The geostrophic deflection in `pressureToWind`
   (`wind.js:504-514`) *is* the Coriolis proxy. A rotation-rate slider scaling the deflection
   angle / effective `f` would change circulation-cell and gyre structure (fast rotator = more,
   tighter bands). Light wiring, grounded in real physics.

3. **★ Greenhouse-strength slider.** Temperature today is purely geometric — there is **no** greenhouse
   term anywhere. Add one offset (uniform, or lightly latitude/altitude-scaled) in the per-region
   temperature loop (~`temperature.js:845`). One `+=` per region, zero new passes. Distinct from the
   existing per-cell temperature offset in that it can be tied to a "thick atmosphere / CO₂" concept
   and enables Venus-hot vs Mars-cold worlds.

4. **Curated existing knobs as sliders (zero new compute — pure UI + encoding).** All already tuned
   and computed, just optimizer-only today: seasonal swing (`TEMP_SWING_SCALE`), continental winters
   (`TEMP_CONT_WINTER_COOL_C`), lapse rate / "mountain chill" (`TEMP_MOIST_LAPSE_C_PER_KM`), maritime
   influence (`TEMP_OCEAN_WARMTH_DIFFUSE_KM` + `TEMP_COASTAL_WARMTH_SHIFT_C`), rain-shadow strength
   (`PRECIP_RS_APPLY_STRENGTH_SCALE`), orographic strength (`PRECIP_ORO_UPLIFT_ADD`), coastal
   upwelling (`PRECIP_COLD_CURRENT_SUPPRESS`/`PRECIP_WARM_CURRENT_BOOST`, currently near-inert on the
   warm side — likely under-tuned). Recommendation: surface the 3–4 most visually impactful as
   first-class sliders in a small "Climate" advanced group; keep the rest behind an "advanced"
   disclosure so the interface stays approachable.

## 2B. Free/cheap accuracy upgrades that reuse already-computed data

1. **★ Couple ocean currents to the real wind field.** `ocean.js` receives `windResult` but uses only
   its ITCZ shape — the zonal flow (`baseE`, `ocean.js:284-304`) is re-derived from hardcoded latitude
   bands and never reads `windResult.r_wind_east/north_*`, which `wind.js` already computes. Replace
   the band block with the actual per-season wind vector (through the existing coastal-deflection /
   circumpolar logic), recalibrating the `×2.0`/`×0.8` coast constants. **More physically correct and
   it deletes code** (cheaper). No new UI — a pure fidelity upgrade visible as currents that deflect
   around embayments and respond to seasonal pressure shifts.

2. **★ Lithology / rock-hardness erosion.** `K`/`talusSlope`/`kThermal` are global scalars applied
   identically everywhere. Derive a per-cell hardness from the **already-computed** `r_t_craton` /
   `r_t_foldBelt` / `r_t_basin` weights (`classifyTerrain`, stored at `elevation.js:2553-2555`) —
   cratons resist, basins erode fast — and multiply it into the erosion terms. One extra multiply per
   cell, no new field. Ship as a "Lithology-driven erosion" toggle (default on).

3. **★ Isostatic rebound from erosion.** `applyFinalShaping` applies one-way isostatic compression
   with no feedback, yet `dl_erosionDelta` (exact per-cell mass removed) is **already computed**
   (`planet-worker.js:155-157`). Sum it and add back a fraction (optionally hardness-weighted). One
   O(N) pass. A "Rebound strength" slider lets old orogens retain relief (Appalachians-style) — real
   geology, trivial cost.

4. **★ Ridge-age bathymetry.** Ocean depth is keyed only to `dist_coast`, never to `ridgeDist` /
   `dist_ocean` — **both already computed** (`computeSpatialFields`). Add a depth term ∝ ridge distance
   (half-space cooling, ~2500 + 350√age_Myr m). Fixes a textbook-basic omission (sea floor deepens
   away from spreading ridges); a dozen lines, zero new passes. Toggle or advanced slider.

5. **★ Rivers rendered from the drainage graph.** `erodeComposite` already builds a complete drainage
   graph (`drainTarget`, `flow`, `terrain-post.js:600-643`) purely as an erosion intermediate, then
   discards it. Retain it and render `flow` above a threshold as a river overlay. CLAUDE.md explicitly
   names "rivers fed by precipitation" as a desired feature; the backbone is essentially free and it
   leverages the crown-jewel climate system (couple river volume to precipitation). The work is the
   rendering, not the hydrology. High user delight.

6. **Cloud-cover layer.** Cloud cover is computed *implicitly* inline (`temperature.js:897-910`) then
   discarded. Extract it as a named field, expose as a debug/visual overlay (and optional strength
   knob). Near-free, and it extends the loved climate-overlay suite.

## 2C. New features that copy an existing pattern (low–medium effort)

1. **Sediment deposition / deltas.** Current deposition is a flat fraction with no transport model.
   Carry a sediment-load variable down the existing `drainTarget` graph, depositing where capacity
   drops (slope flattens) or flow reaches the ocean → deltas and braided floodplains. One O(L) pass
   per iteration. Expose `HYDRAULIC_DEPOSIT_FRAC` as a "Deposition" slider, distinct from erosion
   strength (sharp canyons = low, floodplains = high).

2. **Proper trench width/profile.** The trench is two flat constants with no spatial footprint
   (`elevation.js:1200-1202`), unlike every other boundary feature. Add a 5th BFS band (copy the
   rift/ridge/fracture/back-arc template already in `computeSpatialFields`): deep narrow axis, taper
   over `trenchHalfWidth`, optional outer-rise bulge. One more bounded BFS pass; scale-invariant by
   construction if it follows the existing idiom.

3. **Transform-fault lateral offset.** Real transforms juxtapose mismatched terrain across the fault;
   the current model is a symmetric depth scar only. Tag fracture-zone cells by side during the
   existing fracture BFS, then apply a small tangential shift (scaled by `avgEdgeKm`) to noise-sampling
   coordinates near the fault. Stylized texture-domain trick, not rigorous displacement — but visually
   distinctive and cheap.

4. **★★ User-editable plate velocity / Euler pole — the signature feature.** CLAUDE.md explicitly
   names "plate direction editing" as a desired *extension* of the cherished Ctrl-click workflow. Add
   a pending Euler-pole/omega override map alongside `state.pendingToggles`, surfaced as a drag-handle
   at the plate centroid (reuse edit-mode's ray-sphere machinery), routed through the **existing**
   `editRecompute` contract (`generate.js:942-960`). **Zero incremental compute cost** — it reuses the
   partial-recompute path that already skips plate regeneration. Effort is UI/interaction design (and a
   mobile tap-then-drag equivalent, per the mobile-parity rule), not compute. This is the most
   differentiated "haven't seen this anywhere else" delight available.

5. **Hotspot-count slider.** The whole hotspot/LIP system is built and well-grounded; only
   `NUM_HOTSPOTS = 5` is hardcoded. Read it from a slider — one-line change plus a control and encoding
   entry. Trivial.

6. **Trewartha classification toggle (cheap; low artistic priority).** A deterministic re-derivation
   from the *same* two-season temp/precip fields Köppen already uses; a parallel `classifyTrewartha`
   is one O(N) pass, negligible next to the smoothing steps. Expose as a classification-scheme
   dropdown next to Köppen. Effort-wise it belongs here with the cheap upgrades — it ranks low only
   because it serves cartographic precision over the artistic-first priority, not because it is
   expensive. (Corrected from an earlier draft that mis-filed it under "higher-effort.")

## 2D. Higher-effort / opt-in — tradeoffs flagged explicitly

1. **Full monthly (seasonal) Köppen.** Biggest fidelity lift: replace the summer/winter proxy (which
   caps how sharp monsoon and Mediterranean boundaries can be) with a 12-point (or 2–4 harmonic)
   annual cycle, and run the real monthly aridity/temperature-band tests. The expensive O(N^1.5)
   precomputes (smoothing/BFS/advection) *don't* repeat per month — only the cheap per-region formula
   does — so added cost is closer to linear-in-months than full-pipeline. Still: make it **opt-in and
   deferred**, mirroring the existing `AUTO_CLIMATE_THRESHOLD` (300K) on-demand pattern. (Confirmed:
   classification is currently annual/2-season.)

2. **Climate-coupled glacial ELA.** Tie glacial extent to *simulated temperature* instead of the
   static latitude+elevation proxy (`terrain-post.js:446-458`). But terrain runs *before* climate
   (climate is deferred >300K), so this needs either a pipeline reorder or a two-pass
   (terrain → climate → re-erode) — the one item here that genuinely risks the "instant" strength.
   Opt-in toggle only, off by default.

3. **Snow/ice albedo feedback.** Needs a two-pass temperature (compute T → derive ice mask → re-run
   the polar term with an albedo boost). The one climate item that risks the speed constraint;
   deprioritize unless a specific visual complaint ("coasts don't look cold enough") motivates it.

4. **Explicit humidity/evapotranspiration budget.** Lowest priority — the ad hoc moisture model is
   already Earth-tuned; a conserved budget adds real cost for realism the ethos deprioritizes. Not
   recommended until 2A/2B are exhausted and profiling shows the moisture *model* (not its
   scale-invariance execution) is the accuracy bottleneck. Nothing in the audit suggests it is.

---

## Cross-cutting hygiene (cheap, prevents future mis-tuning)

- **Documentation drift** (each a stale description that could misdirect a future contributor or
  optimizer run):
  - `tuning/climate/lib/score.mjs` — the objective formula is stated *two different wrong ways*
    (README and the file's own docstring) vs. the executing constants (`W_GRADED=0.60`,
    `W_MACRO_F1=0.12`, `W_GROUP_BALANCE=0.15`, `W_WATCHLIST=0.13`).
  - Stale km comments: `precipitation.js:205-207` ("~2000 km" vs `PRECIP_ADVECT_REACH_KM=3961`),
    `:582` ("~2500 km" vs `PRECIP_RS_SHADOW_PROP_KM=3363`).
  - `elevation.js:1-14` header says "12 stages"; `assignElevation` runs 13 and omits phasor ridges.
  - `detail-scale.js:2` says the range starts at 2,000; `MIN=5000`.
- **No terrain/tectonics realism harness.** Climate has `evaluate.mjs`/`optimize.mjs`; terrain and
  tectonics are eyeballed. `terrain-metrics.js` already computes ~19 metrics — wiring them into a
  scored harness would let terrain be auto-tuned the way climate is. Standing gap worth naming.
- **Every new slider triggers standing CLAUDE.md obligations:** `planet-code.js` (`SLIDERS`/`RADICES`
  + pack/unpack), README control docs, tutorial modal, What's New, mobile ≥44px touch targets + hint
  text, and a `tuning/climate/param-space.mjs` range for any new `CLIMATE` key (its load-time
  cross-check throws otherwise).

## Suggested sequencing (a pragmatic first pass)

1. **1A free-wins bundle** + surface timing (1A#8) — immediate speedups, confirms hotspot order.
2. **Verify then fix erosion scaling (1B#1)** — the biggest correctness bug; blocks 1C#2.
3. **Hardcoded-pass fixes (1B#4–6)** — one-line changes, remove Detail-dependent looks.
4. **F1 axial tilt + F2 greenhouse + F3 ocean/wind coupling** — highest-value features, all low effort.
5. **F4 bundle (lithology, rebound, ridge-age bathymetry)** — three free geology upgrades.
6. **1C#1 coarse-mesh reuse** — fixes the moisture-advection + rain-shadow scale/cost issues together.
7. **F5 rivers + F6 editable plate velocity** — the two signature user-facing features.
8. Documentation-drift + param-space hygiene, batched with any pass through the affected files.

---

## Roadmap — sub-project decomposition (agreed 2026-07-10)

The work above is being executed as a sequence of small, independent spec → plan → implement cycles
rather than one monolithic effort, so that zero-risk mechanical work is never coupled to
output-changing correctness fixes or new UI features. Each sub-project (SP) gets its own design spec
under `docs/superpowers/specs/`.

| SP | Scope | Maps to | Risk | Status |
|----|-------|---------|------|--------|
| **SP1** | Perf free wins + surface timing instrumentation + doc-drift fixes | Part 1 §1A + Cross-cutting doc-drift | Very low (no intended output change) | ▶ in progress |
| **SP2** | Scale-invariance correctness: erosion flow-accumulation, hardcoded passes (plate-smooth `3`, stress-dir `2`, soil-creep `3`) | Part 1 §1B (1, 4, 5, 6) | Medium (output changes; needs calibration) | planned |
| **SP3** | Structural: coarse-mesh reuse (+ the moisture-advection & rain-shadow scale bugs), incremental erosion sort, GC/scratch buffers, incremental edit-recompute | Part 1 §1C + §1B (2, 3) | Medium-high | planned |
| **SP4** | Expose existing physics: axial tilt, greenhouse, rotation→Coriolis, curated climate sliders | Part 2 §2A | Low-med | planned |
| **SP5** | Free/cheap data-reuse upgrades: ocean↔wind coupling, lithology erosion, isostatic rebound, ridge-age bathymetry, rivers, cloud layer, Trewartha | Part 2 §2B + §2C (1-3, 5, 6) | Low-med | planned |
| **SP6** | User-editable plate velocity / Euler pole | Part 2 §2C (4) | Medium (UI-heavy) | ✅ implemented 2026-07-12 |

Notes:
- The two moisture scale-invariance bugs (moisture-advection clamp, unclamped rain-shadow) are grouped
  into **SP3**, not SP2, because their correct fix *is* the coarse-mesh reuse work.
- Cross-cutting doc-drift fixes fold into SP1. Each new slider (SP4/SP5/SP6) carries the standing
  CLAUDE.md obligations (planet-code encoding, README, tutorial, What's New, mobile targets, param-space).
- A terrain/tectonics realism harness (paralleling the climate one) is an optional prerequisite for SP2
  — it would let terrain changes be scored rather than eyeballed. Decision deferred.
- Recommended order: SP1 → SP2 → SP3 for the perf/correctness track; the feature SPs (SP4-SP6) are
  independent of the perf work and can interleave at any point.

> SP6 is implemented; the remaining roadmap rows retain the statuses shown above. Each item is scoped
> so it can be taken on independently, smallest-blast-radius first.

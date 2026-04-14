// Temperature simulation: computes per-region surface temperature for summer
// and winter seasons based on ITCZ position, continentality, moisture-dependent
// elevation lapse rate (dry adiabatic 9.3 C/km to moist adiabatic 4.5 C/km),
// ocean current warmth, and precipitation/cloud cover moderation.
// Returns normalized 0-1 values mapped to a fixed -45 to +45 C range.

import { smoothstep } from './wind.js';
import { elevToHeightKm } from './color-map.js';
import { smoothField, makeItczLookup } from './climate-util.js';

const DEG = Math.PI / 180;

// ── BFS through land cells only ─────────────────────────────────────────────

function bfsLandDist(mesh, r_isLand, seeds) {
    const { adjOffset, adjList, numRegions } = mesh;
    const dist = new Int32Array(numRegions).fill(-1);
    const queue = new Int32Array(numRegions);
    let qLen = 0, head = 0;
    for (const r of seeds) {
        if (r_isLand[r]) {
            dist[r] = 0;
            queue[qLen++] = r;
        }
    }
    while (head < qLen) {
        const r = queue[head++];
        const d1 = dist[r] + 1;
        const end = adjOffset[r + 1];
        for (let i = adjOffset[r]; i < end; i++) {
            const nb = adjList[i];
            if (r_isLand[nb] && dist[nb] === -1) {
                dist[nb] = d1;
                queue[qLen++] = nb;
            }
        }
    }
    return dist;
}

// ── Array-based landmass flood-fill ─────────────────────────────────────────

function landComponentLabels(mesh, r_isLand) {
    const N = mesh.numRegions;
    const { adjOffset, adjList } = mesh;
    const r_label = new Int32Array(N).fill(-1);
    let nextId = 0;
    const queue = new Int32Array(N);
    const compSizes = [];

    for (let r = 0; r < N; r++) {
        if (!r_isLand[r] || r_label[r] >= 0) continue;
        const id = nextId++;
        compSizes.push(0);
        r_label[r] = id;
        let qLen = 1, head = 0;
        queue[0] = r;
        while (head < qLen) {
            const cur = queue[head++];
            compSizes[id]++;
            const end = adjOffset[cur + 1];
            for (let i = adjOffset[cur]; i < end; i++) {
                const nb = adjList[i];
                if (r_isLand[nb] && r_label[nb] === -1) {
                    r_label[nb] = id;
                    queue[qLen++] = nb;
                }
            }
        }
    }
    return { r_label, compSizes, numComponents: nextId };
}

// ── Temperature swing lookup table ──────────────────────────────────────────
// Full annual swing (Twarm - Tcold) midpoints from the guide, in °C.
// Rows = latitude bands, columns = zones (HO, OC, SC, CO, HC).

const SWING_TABLE = [
    // 0-19°    20-29°   30-39°   40-49°   50-59°   60-69°   70-90°
    [  3,  7.5, 13.5, 16.5, 19.5],  // 0-19°
    [  6, 10.5, 18,   24,   31  ],  // 20-29°
    [7.5, 15,   24,   31.5, 38.5],  // 30-39°
    [  9, 16.5, 28.5, 37.5, 46.5],  // 40-49°
    [  9, 19.5, 31.5, 42,   52.5],  // 50-59°
    [  9, 21,   36,   45,   57  ],  // 60-69°
    [  9, 22.5, 37.5, 48,   60  ],  // 70-90°
];

// Latitude midpoints for each row (used for interpolation)
const LAT_MIDS = [9.5, 24.5, 34.5, 44.5, 54.5, 64.5, 80];

/**
 * Look up half-swing amplitude (°C) from zone and latitude via bilinear interpolation.
 * @param {number} latDeg - absolute latitude in degrees
 * @param {number} zoneVal - zone value 0.0 (Hyperoceanic) to 1.0 (Hypercontinental)
 * @returns {number} half-swing in °C (apply as ± from annual mean)
 */
function lookupSwingAmplitude(latDeg, zoneVal) {
    // Latitude interpolation
    let li = 0;
    for (let i = 0; i < LAT_MIDS.length - 1; i++) {
        if (latDeg >= LAT_MIDS[i]) li = i;
    }
    const li2 = Math.min(li + 1, LAT_MIDS.length - 1);
    const latT = li === li2 ? 0
        : Math.max(0, Math.min(1, (latDeg - LAT_MIDS[li]) / (LAT_MIDS[li2] - LAT_MIDS[li])));

    // Zone interpolation (0.0 → col 0, 0.25 → col 1, ..., 1.0 → col 4)
    const zIdx = Math.max(0, Math.min(4, zoneVal * 4));
    const zi = Math.min(Math.floor(zIdx), 3);
    const zi2 = zi + 1;
    const zoneT = zIdx - zi;

    // Bilinear: interpolate across zone at both latitude rows, then across latitude
    const v00 = SWING_TABLE[li][zi],  v01 = SWING_TABLE[li][zi2];
    const v10 = SWING_TABLE[li2][zi], v11 = SWING_TABLE[li2][zi2];
    const vLo = v00 + (v01 - v00) * zoneT;
    const vHi = v10 + (v11 - v10) * zoneT;
    const fullSwing = vLo + (vHi - vLo) * latT;

    return fullSwing / 2; // half-swing (amplitude)
}

// ── Zone-based temperature continentality ───────────────────────────────────
// Follows the geographic guide: discrete zones (Hyperoceanic → Oceanic →
// Subcontinental → Continental → Hypercontinental) based on latitude,
// continent size, west-coast shave, and island size.  Used ONLY for
// temperature seasonal swing; the existing BFS-based r_continentality
// remains for precipitation and pressure.

const ZONE_HO = 0.0;    // Hyperoceanic
const ZONE_OC = 0.25;   // Oceanic
const ZONE_SC = 0.5;    // Subcontinental
const ZONE_CO = 0.75;   // Continental
const ZONE_HC = 1.0;    // Hypercontinental

function computeTempContinentality(
    mesh, r_xyz, r_isLand, r_lat, r_lon,
    r_eastX, r_eastY, r_eastZ,
    r_ocean_warmth_summer,
    avgEdgeKm
) {
    const { adjOffset, adjList, numRegions } = mesh;
    const zone = new Float32Array(numRegions);
    // Mark ocean cells as -1 so the viz layer can distinguish them
    for (let r = 0; r < numRegions; r++) {
        if (!r_isLand[r]) zone[r] = -1;
    }

    // ── Stage A: Baseline zones ─────────────────────────────────────────────

    // A1. Flood-fill connected landmasses
    const { r_label, compSizes, numComponents } = landComponentLabels(mesh, r_isLand);

    // A2. Per-component statistics, split by hemisphere.
    // The guide measures landmass area poleward of certain latitudes,
    // so a continent spanning the equator counts its north and south
    // halves independently.
    const cellAreaKm2 = avgEdgeKm * avgEdgeKm;
    // [0] = north hemisphere, [1] = south hemisphere
    const bandArea_35_70_N = new Float32Array(numComponents);
    const bandArea_35_70_S = new Float32Array(numComponents);
    const bandArea_above35_N = new Float32Array(numComponents);
    const bandArea_above35_S = new Float32Array(numComponents);

    // For E-W width: bin longitudes into 72 bins (5° each) per component
    // per hemisphere in the 35-70° band.
    const LON_BINS = 72;
    const lonBinsN = new Uint8Array(numComponents * LON_BINS);
    const lonBinsS = new Uint8Array(numComponents * LON_BINS);

    for (let r = 0; r < numRegions; r++) {
        if (!r_isLand[r]) continue;
        const id = r_label[r];
        const latDeg = r_lat[r] / DEG;
        const absLatDeg = Math.abs(latDeg);
        const isNorth = latDeg >= 0;
        if (absLatDeg >= 35 && absLatDeg <= 70) {
            if (isNorth) {
                bandArea_35_70_N[id]++;
            } else {
                bandArea_35_70_S[id]++;
            }
            const lonNorm = (r_lon[r] + Math.PI) / (2 * Math.PI);
            const bin = Math.min(LON_BINS - 1, Math.floor(lonNorm * LON_BINS));
            if (isNorth) lonBinsN[id * LON_BINS + bin] = 1;
            else lonBinsS[id * LON_BINS + bin] = 1;
        }
        if (absLatDeg >= 35) {
            if (isNorth) bandArea_above35_N[id]++;
            else bandArea_above35_S[id]++;
        }
    }

    // Compute E-W width per component per hemisphere
    function computeEWWidth(lonBinArr) {
        const widths = new Float32Array(numComponents);
        const cosLat52 = Math.cos(52.5 * DEG);
        for (let id = 0; id < numComponents; id++) {
            let occupied = 0;
            for (let b = 0; b < LON_BINS; b++) {
                if (lonBinArr[id * LON_BINS + b]) occupied++;
            }
            if (occupied < 2) continue;
            let maxGap = 0, gap = 0;
            for (let i = 0; i < LON_BINS * 2; i++) {
                if (!lonBinArr[id * LON_BINS + (i % LON_BINS)]) {
                    gap++;
                    if (gap > maxGap) maxGap = gap;
                } else {
                    gap = 0;
                }
            }
            maxGap = Math.min(maxGap, LON_BINS);
            const spanBins = LON_BINS - maxGap;
            const spanRad = spanBins * (2 * Math.PI / LON_BINS);
            widths[id] = spanRad * cosLat52 * 6371;
        }
        return widths;
    }
    const ewWidthKmN = computeEWWidth(lonBinsN);
    const ewWidthKmS = computeEWWidth(lonBinsS);

    // Convert cell counts to km²
    for (let id = 0; id < numComponents; id++) {
        bandArea_35_70_N[id] *= cellAreaKm2;
        bandArea_35_70_S[id] *= cellAreaKm2;
        bandArea_above35_N[id] *= cellAreaKm2;
        bandArea_above35_S[id] *= cellAreaKm2;
    }

    // A3-A8. Assign baseline zones
    for (let r = 0; r < numRegions; r++) {
        if (!r_isLand[r]) continue;
        const latDeg = r_lat[r] / DEG;
        const absLatDeg = Math.abs(latDeg);
        const id = r_label[r];
        const isNorth = latDeg >= 0;

        // Pick the hemisphere-appropriate stats
        const band35_70 = isNorth ? bandArea_35_70_N[id] : bandArea_35_70_S[id];
        const above35 = isNorth ? bandArea_above35_N[id] : bandArea_above35_S[id];
        const ewWidth = isNorth ? ewWidthKmN[id] : ewWidthKmS[id];

        // Default: Oceanic
        zone[r] = ZONE_OC;

        // Hyperoceanic: tropics 0-10°
        if (absLatDeg <= 10) {
            zone[r] = ZONE_HO;
            continue;
        }

        // Subcontinental: 35°+ on landmasses with enough area at 35-70° and wide enough E-W
        if (absLatDeg >= 35 &&
            band35_70 > 4_500_000 &&
            ewWidth > 2000) {
            zone[r] = ZONE_SC;
        }

        // Continental: 40°+, over subcontinental, very large landmass
        if (zone[r] >= ZONE_SC && absLatDeg >= 40 &&
            above35 > 10_000_000) {
            zone[r] = ZONE_CO;
        }

        // Hypercontinental: 50°+, over continental
        if (zone[r] >= ZONE_CO && absLatDeg >= 50) {
            zone[r] = ZONE_HC;
        }
    }

    // A4-A5. Warm-current coast extension: Hyperoceanic up to 23.5° near warm currents
    if (r_ocean_warmth_summer) {
        const warmCoastSeeds = [];
        for (let r = 0; r < numRegions; r++) {
            if (!r_isLand[r]) continue;
            const absLatDeg = Math.abs(r_lat[r]) / DEG;
            if (absLatDeg > 23.5 || zone[r] === ZONE_HO) continue;

            // Check if any ocean neighbor has warm current
            const end = adjOffset[r + 1];
            for (let i = adjOffset[r]; i < end; i++) {
                const nb = adjList[i];
                if (!r_isLand[nb] && r_ocean_warmth_summer[nb] > 0.3) {
                    warmCoastSeeds.push(r);
                    break;
                }
            }
        }

        // BFS ~150km inland from warm coast seeds
        const maxHops = Math.max(1, Math.round(150 / avgEdgeKm));
        const warmDist = bfsLandDist(mesh, r_isLand, warmCoastSeeds);
        for (let r = 0; r < numRegions; r++) {
            if (warmDist[r] >= 0 && warmDist[r] <= maxHops) {
                const absLatDeg = Math.abs(r_lat[r]) / DEG;
                if (absLatDeg <= 23.5) {
                    zone[r] = ZONE_HO;
                }
            }
        }
    }

    // Count zone distribution after Stage A
    const zoneCountsA = { HO: 0, OC: 0, SC: 0, CO: 0, HC: 0 };
    for (let r = 0; r < numRegions; r++) {
        if (!r_isLand[r]) continue;
        if (zone[r] <= 0.05) zoneCountsA.HO++;
        else if (zone[r] <= 0.3) zoneCountsA.OC++;
        else if (zone[r] <= 0.55) zoneCountsA.SC++;
        else if (zone[r] <= 0.8) zoneCountsA.CO++;
        else zoneCountsA.HC++;
    }
    console.log(`[tempCont] After Stage A: HO=${zoneCountsA.HO} OC=${zoneCountsA.OC} SC=${zoneCountsA.SC} CO=${zoneCountsA.CO} HC=${zoneCountsA.HC}`);
    console.log(`[tempCont] Component stats: ${numComponents} landmasses, avgEdgeKm=${avgEdgeKm.toFixed(1)}`);
    for (let id = 0; id < numComponents; id++) {
        const areaKm2 = compSizes[id] * cellAreaKm2;
        if (areaKm2 > 1_000_000) {
            console.log(`[tempCont]   Landmass ${id}: ${(areaKm2/1e6).toFixed(1)}M km² | N: band35-70=${(bandArea_35_70_N[id]/1e6).toFixed(1)}M, >35=${(bandArea_above35_N[id]/1e6).toFixed(1)}M, EW=${ewWidthKmN[id].toFixed(0)}km | S: band35-70=${(bandArea_35_70_S[id]/1e6).toFixed(1)}M, >35=${(bandArea_above35_S[id]/1e6).toFixed(1)}M, EW=${ewWidthKmS[id].toFixed(0)}km`);
        }
    }

    // ── Stage B: West coast shave (30-65° latitude) ─────────────────────────
    // For each land cell, scan westward from its longitude bin until hitting
    // an empty (ocean) bin at its latitude band.  The number of bins crossed
    // is the distance from the nearest west coast.  This handles irregular
    // coastlines naturally — bays and indentations create their own local
    // west coasts.

    const LAT_BAND_DEG = 5;
    const NUM_LAT_BANDS = Math.ceil(180 / LAT_BAND_DEG);

    // Fine-resolution lon bins for the shave (1° each = 360 bins)
    const SHAVE_LON_BINS = 360;
    const bandLonBins = new Uint8Array(numComponents * NUM_LAT_BANDS * SHAVE_LON_BINS);
    for (let r = 0; r < numRegions; r++) {
        if (!r_isLand[r]) continue;
        const absLatDeg = Math.abs(r_lat[r]) / DEG;
        if (absLatDeg < 30 || absLatDeg > 65) continue;
        const id = r_label[r];
        const latBand = Math.min(NUM_LAT_BANDS - 1, Math.floor(absLatDeg / LAT_BAND_DEG));
        const lonNorm = (r_lon[r] + Math.PI) / (2 * Math.PI);
        const lonBin = Math.min(SHAVE_LON_BINS - 1, Math.floor(lonNorm * SHAVE_LON_BINS));
        bandLonBins[id * NUM_LAT_BANDS * SHAVE_LON_BINS + latBand * SHAVE_LON_BINS + lonBin] = 1;
    }

    const shaveBinWidthRad = 2 * Math.PI / SHAVE_LON_BINS;

    for (let r = 0; r < numRegions; r++) {
        if (!r_isLand[r]) continue;
        const absLatDeg = Math.abs(r_lat[r]) / DEG;
        if (absLatDeg < 30 || absLatDeg > 65) continue;

        const id = r_label[r];
        const latBand = Math.min(NUM_LAT_BANDS - 1, Math.floor(absLatDeg / LAT_BAND_DEG));
        const base = id * NUM_LAT_BANDS * SHAVE_LON_BINS + latBand * SHAVE_LON_BINS;

        const lonNorm = (r_lon[r] + Math.PI) / (2 * Math.PI);
        const cellBin = Math.min(SHAVE_LON_BINS - 1, Math.floor(lonNorm * SHAVE_LON_BINS));

        // Walk westward (decreasing bin, wrapping) until hitting an empty bin
        let binsFromWest = 0;
        for (let step = 1; step < SHAVE_LON_BINS; step++) {
            const checkBin = (cellBin - step + SHAVE_LON_BINS) % SHAVE_LON_BINS;
            if (!bandLonBins[base + checkBin]) break; // hit ocean
            binsFromWest = step;
        }

        const distKm = binsFromWest * shaveBinWidthRad * Math.cos(r_lat[r]) * 6371;

        if (distKm < 400) {
            zone[r] = Math.min(zone[r], ZONE_OC);
        } else if (distKm < 2000) {
            zone[r] = Math.min(zone[r], ZONE_SC);
        } else if (distKm < 4000) {
            zone[r] = Math.min(zone[r], ZONE_CO);
        }
    }

    console.log(`[tempCont] Stage B (west shave) applied`);

    // ── Stage C: Small island override ──────────────────────────────────────

    for (let r = 0; r < numRegions; r++) {
        if (!r_isLand[r]) continue;
        const id = r_label[r];
        const areaKm2 = compSizes[id] * cellAreaKm2;
        if (areaKm2 < 50_000) {
            zone[r] = ZONE_HO;
        } else if (areaKm2 < 500_000) {
            zone[r] = Math.min(zone[r], ZONE_OC);
        }
    }

    // ── Stage D: East coast adjustment (Hypercontinental near east coast) ───

    // Identify east-coast land seeds
    const eastCoastSeeds = [];
    for (let r = 0; r < numRegions; r++) {
        if (!r_isLand[r]) continue;
        let oceanDirX = 0, oceanDirY = 0, oceanDirZ = 0;
        let hasOceanNb = false;
        const end = adjOffset[r + 1];
        for (let i = adjOffset[r]; i < end; i++) {
            const nb = adjList[i];
            if (!r_isLand[nb]) {
                hasOceanNb = true;
                oceanDirX += r_xyz[3 * nb] - r_xyz[3 * r];
                oceanDirY += r_xyz[3 * nb + 1] - r_xyz[3 * r + 1];
                oceanDirZ += r_xyz[3 * nb + 2] - r_xyz[3 * r + 2];
            }
        }
        if (!hasOceanNb) continue;
        const dotE = oceanDirX * r_eastX[r] + oceanDirY * r_eastY[r] + oceanDirZ * r_eastZ[r];
        const mag = Math.sqrt(oceanDirX*oceanDirX + oceanDirY*oceanDirY + oceanDirZ*oceanDirZ);
        const normDotE = mag > 1e-10 ? dotE / mag : 0;
        if (normDotE > 0.2) {
            eastCoastSeeds.push(r);
        }
    }

    const r_eastDist = bfsLandDist(mesh, r_isLand, eastCoastSeeds);

    // For hypercontinental cells near east coast: check ocean warmth to decide threshold
    for (let r = 0; r < numRegions; r++) {
        if (zone[r] < ZONE_HC || r_eastDist[r] < 0) continue;
        const distKm = r_eastDist[r] * avgEdgeKm;

        // Determine nearby ocean warmth: check ocean neighbors within a few hops
        let maxWarmth = 0;
        if (r_ocean_warmth_summer) {
            const end = adjOffset[r + 1];
            for (let i = adjOffset[r]; i < end; i++) {
                const nb = adjList[i];
                if (!r_isLand[nb]) {
                    maxWarmth = Math.max(maxWarmth, r_ocean_warmth_summer[nb]);
                }
            }
        }

        const threshold = maxWarmth > 0.3 ? 650 : 150;
        if (distKm < threshold) {
            zone[r] = ZONE_CO; // downgrade to Continental
        }
    }

    // ── Stage E: Smooth gradients ───────────────────────────────────────────

    // Gap prevention: ensure no neighbor pair differs by more than one zone step (0.25)
    // Run twice to propagate fixes
    for (let pass = 0; pass < 2; pass++) {
        for (let r = 0; r < numRegions; r++) {
            if (!r_isLand[r]) continue;
            const end = adjOffset[r + 1];
            for (let i = adjOffset[r]; i < end; i++) {
                const nb = adjList[i];
                if (!r_isLand[nb]) continue;
                // If this cell is much higher than neighbor, pull it down
                if (zone[r] - zone[nb] > 0.3) {
                    zone[r] = zone[nb] + 0.25;
                }
            }
        }
    }

    // Light smoothing for natural transitions (land only).
    // Temporarily set ocean to 0 for smoothing so it acts as a gentle
    // oceanic pull on coastal cells, then restore -1 for the viz layer.
    // Smooth ~200km to blend zone boundaries into natural gradients.
    // Set ocean to 0 during smoothing so it pulls coastal cells toward
    // oceanic values, then restore -1 for the viz layer.
    const contSmoothPasses = Math.max(2, Math.round(200 / avgEdgeKm));
    for (let r = 0; r < numRegions; r++) {
        if (!r_isLand[r]) zone[r] = 0;
    }
    smoothField(mesh, zone, contSmoothPasses);
    for (let r = 0; r < numRegions; r++) {
        if (!r_isLand[r]) {
            zone[r] = -1;
        } else {
            zone[r] = Math.max(0, Math.min(1, zone[r]));
        }
    }

    return zone;
}

// ── Diffuse ocean warmth onto nearby coastal land ───────────────────────────
// Uses plate-based continentality so that warmth spreads freely across
// shallow continental-shelf ocean and penetrates further inland. Ocean cells
// on continental plates (shallow seas) inherit warmth from nearby oceanic-
// plate cells first, then the warmth diffuses onto land.

function diffuseOceanWarmth(mesh, r_oceanWarmth, r_isLand, r_plateContinentality, passes) {
    const { adjOffset, adjList, numRegions } = mesh;
    const coastal = new Float32Array(numRegions);

    // Seed: all ocean cells contribute their warmth directly.
    // Continental-shelf ocean cells may have weak/no current warmth;
    // they'll pick up values from nearby oceanic-plate neighbors via diffusion.
    for (let r = 0; r < numRegions; r++) {
        if (!r_isLand[r]) {
            coastal[r] = r_oceanWarmth ? r_oceanWarmth[r] : 0;
        }
    }

    const tmp = new Float32Array(numRegions);
    for (let pass = 0; pass < passes; pass++) {
        tmp.set(coastal);
        for (let r = 0; r < numRegions; r++) {
            // Skip deep-interior continental cells (plate-based)
            if (r_plateContinentality && r_plateContinentality[r] >= 0.95) continue;

            // Ocean cells also participate in diffusion so continental-shelf
            // cells inherit warmth from nearby open-ocean neighbors
            let sum = coastal[r];
            let count = 1;
            const end = adjOffset[r + 1];
            for (let ni = adjOffset[r]; ni < end; ni++) {
                sum += coastal[adjList[ni]];
                count++;
            }
            tmp[r] = sum / count;
        }
        coastal.set(tmp);
    }

    return coastal;
}

// ── Main entry point ────────────────────────────────────────────────────────

/**
 * Compute seasonal temperature fields.
 *
 * @param {SphereMesh} mesh
 * @param {Float32Array} r_xyz - per-region 3D positions
 * @param {Float32Array} r_elevation - per-region elevation
 * @param {object} windResult - output from computeWind()
 * @param {object} oceanResult - output from computeOceanCurrents()
 * @param {object} precipResult - output from computePrecipitation()
 * @returns {{ r_temperature_summer, r_temperature_winter, _tempTiming }}
 */
export function computeTemperature(mesh, r_xyz, r_elevation, windResult, oceanResult, precipResult, temperatureOffset = 0) {
    const numRegions = mesh.numRegions;
    const timing = [];

    const { r_lat, r_lon, r_isLand, r_continentality, r_plateContinentality } = windResult;

    // Minimal smoothing: 1 pass just to blend cell-to-cell noise
    const smoothPasses = 1;

    const T_MIN = -45;
    const T_MAX = 45;
    const T_RANGE = T_MAX - T_MIN;

    const result = {};

    // Pre-compute constants shared across seasons
    const avgEdgeKm = (Math.PI * 6371) / Math.sqrt(numRegions);
    const oceanWarmthPasses = Math.max(4, Math.round(1400 / avgEdgeKm));
    const plateCont = r_plateContinentality || r_continentality;

    // Compute zone-based temperature continentality (Stages A-E)
    const tCont0 = performance.now();
    const { r_eastX, r_eastY, r_eastZ } = windResult;
    const r_tempCont = computeTempContinentality(
        mesh, r_xyz, r_isLand, r_lat, r_lon,
        r_eastX, r_eastY, r_eastZ,
        oceanResult.r_ocean_warmth_summer,
        avgEdgeKm
    );
    timing.push({ stage: 'Temp: continentality zones', ms: performance.now() - tCont0 });

    // Both ITCZ lookups needed for estimating ITCZ seasonal contribution
    const itczLookupSummer = makeItczLookup(windResult.itczLons, windResult.itczLatsSummer);
    const itczLookupWinter = makeItczLookup(windResult.itczLons, windResult.itczLatsWinter);

    const seasons = ['summer', 'winter'];

    for (const name of seasons) {
        const t0 = performance.now();

        const r_oceanWarmth = oceanResult[`r_ocean_warmth_${name}`];
        const r_oceanSpeed = oceanResult[`r_ocean_speed_${name}`];
        const r_precip = precipResult[`r_precip_${name}`];

        const itczLookup = makeItczLookup(windResult.itczLons,
            name === 'summer' ? windResult.itczLatsSummer : windResult.itczLatsWinter);

        // Pre-compute diffused ocean warmth for coastal land influence
        // Use plate-based continentality for diffusion so warmth crosses
        // continental shelves and reaches further inland
        const coastalWarmth = diffuseOceanWarmth(mesh, r_oceanWarmth, r_isLand, plateCont, oceanWarmthPasses);

        const temp = new Float32Array(numRegions);

        for (let r = 0; r < numRegions; r++) {
            const lat = r_lat[r];
            const lon = r_lon[r];
            const latDeg = lat / DEG;
            const isLand = r_isLand[r];
            const elev = r_elevation[r];
            const cont = r_continentality ? r_continentality[r] : 0;
            const pCont = r_plateContinentality ? r_plateContinentality[r] : cont;

            // ── 1. Base temperature from thermal equator (ITCZ) ──
            // Two curves blended by absolute latitude:
            //  - T_itcz: based on distance from the actual (land-warped) ITCZ
            //  - T_flat: based on distance from a fixed ITCZ at ±5° (ocean default)
            // Near the tropics the real ITCZ matters; at high latitudes the
            // ITCZ position is irrelevant and a stable zonal baseline takes over.
            const tropicalHW = 13;  // flat plateau half-width (degrees)
            const maxDist = 90 - tropicalHW;

            // Actual ITCZ curve
            const itczLat = itczLookup(lon);
            const distItcz = Math.abs(lat - itczLat) / DEG;
            const tItcz = Math.max(0, distItcz - tropicalHW) / maxDist;
            const T_itcz = 28 - 47 * Math.pow(tItcz, 1.4);

            // Flat reference curve (ITCZ at 5° in summer hemisphere)
            const flatItczLat = (name === 'summer' ? 5 : -5) * DEG;
            const distFlat = Math.abs(lat - flatItczLat) / DEG;
            const tFlat = Math.max(0, distFlat - tropicalHW) / maxDist;
            const T_flat = 28 - 47 * Math.pow(tFlat, 1.4);

            // Blend: ITCZ curve dominates tropics, flat curve dominates poles
            const absLatDeg = Math.abs(lat) / DEG;
            const blend = smoothstep(45, 90, absLatDeg);
            let T = T_itcz * (1 - blend) + T_flat * blend;

            // ── 2. Elevation lapse rate ──
            // Moisture-dependent: dry air cools at ~9.8 C/km (dry adiabatic),
            // saturated air at ~5 C/km (moist adiabatic) due to latent heat
            // release. Use precipitation as a moisture proxy to interpolate.
            const moisture = r_precip ? r_precip[r] : 0.5;
            const lapse = 4.5 + 4.8 * (1 - moisture); // 4.5 C/km (wet) to 9.3 C/km (dry)
            if (isLand && elev > 0) {
                T -= lapse * elevToHeightKm(elev);
            }

            // ── 5. Ocean current temperature influence ──
            if (!isLand && r_oceanWarmth && r_oceanSpeed) {
                // Direct ocean effect: warm/cold currents shift SST
                const warmth = r_oceanWarmth[r];
                const speed = r_oceanSpeed[r];
                T += warmth * Math.min(1, speed * 2) * 16;
            } else if (isLand) {
                // Coastal land: diffused ocean warmth fades with plate-based
                // continentality so the effect reaches further inland and
                // crosses continental shelves naturally
                const cw = coastalWarmth[r];
                if (Math.abs(cw) > 0.001) {
                    T += cw * (1 - smoothstep(0, 0.95, pCont)) * 20;
                }
            }

            // ── 6. Precipitation / cloud cover moderation ──
            if (r_precip) {
                const p = r_precip[r];
                if (p > 0.5) {
                    // High precip → clouds → moderate toward latitude baseline
                    const mod = smoothstep(0.5, 1.0, p) * 0.15;
                    // Pull toward 0 (moderate extremes)
                    T *= (1 - mod);
                } else if (p < 0.3) {
                    // Low precip → clear skies → amplify extremes
                    const amp = smoothstep(0.3, 0.0, p) * 0.15;
                    T *= (1 + amp);
                }
            }

            // ── 7. Zone-based seasonal moderation ──
            // The swing table gives the TOTAL expected half-swing for this
            // zone and latitude.  The ITCZ shift in step 1 already provides
            // some seasonal signal, so we subtract that expected ITCZ
            // contribution and only add the residual continentality boost.
            {
                const distAnn = Math.abs(lat) / DEG;

                const tc = isLand ? r_tempCont[r] : 0;
                const tableAmplitude = lookupSwingAmplitude(distAnn, tc);

                // Estimate ITCZ seasonal contribution at this cell:
                // evaluate the base temp curve for summer and winter ITCZ
                // positions and take the half-difference.
                const sumItczLat = itczLookupSummer(lon);
                const winItczLat = itczLookupWinter(lon);
                const distSummer = Math.abs(lat - sumItczLat) / DEG;
                const distWinter = Math.abs(lat - winItczLat) / DEG;
                const tS = Math.max(0, distSummer - tropicalHW) / maxDist;
                const tW = Math.max(0, distWinter - tropicalHW) / maxDist;
                const T_summer = 28 - 47 * Math.pow(tS, 1.4);
                const T_winter = 28 - 47 * Math.pow(tW, 1.4);
                const itczAmplitude = Math.abs(T_summer - T_winter) / 2;

                // The extra swing continentality adds beyond ITCZ (scaled down
                // slightly so the effect doesn't dominate other climate signals)
                const extraAmplitude = Math.max(0, tableAmplitude - itczAmplitude) * 0.7;

                const isLocalSummer = (name === 'summer') ? (lat >= 0) : (lat < 0);
                const seasonSign = isLocalSummer ? 1 : -1;
                T += seasonSign * extraAmplitude;
            }

            T += temperatureOffset;
            temp[r] = T;
        }

        const tCompute = performance.now() - t0;

        // ── 7. Laplacian smoothing ──
        const tSmooth0 = performance.now();
        smoothField(mesh, temp, smoothPasses);
        const tSmooth = performance.now() - tSmooth0;

        // ── 8. Normalize to 0-1 using fixed range ──
        const tNorm0 = performance.now();
        for (let r = 0; r < numRegions; r++) {
            temp[r] = Math.max(0, Math.min(1, (temp[r] - T_MIN) / T_RANGE));
        }
        const tNorm = performance.now() - tNorm0;

        timing.push({ stage: `Temp: compute (${name})`, ms: tCompute });
        timing.push({ stage: `Temp: smooth (${name})`, ms: tSmooth });
        timing.push({ stage: `Temp: normalize (${name})`, ms: tNorm });

        result[`r_temperature_${name}`] = temp;
    }

    result._tempTiming = timing;
    result.r_tempContinentality = r_tempCont;
    return result;
}

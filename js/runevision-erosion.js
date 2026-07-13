// Experimental spherical adaptation of Rune Skovbo Johansen's directional
// erosion-filter ideas. The implementation is mesh-native: it estimates the
// input slope once, samples a seamless 3D lattice on the unit sphere, and
// evaluates every output cell from immutable input buffers.

const PLANET_RADIUS_KM = 6371;
const TAU = Math.PI * 2;

const DEFAULTS = Object.freeze({
    strengthKm: 0.25,
    baseWavelengthKm: 400,
    octaves: 4,
    lacunarity: 2,
    gain: 0.5,
    cellToStripeRatio: 1,
    detailExponent: 1.5,
    slopeReference: 0.12,
    pretendSlope: 0.12,
    fadeLowKm: 0.25,
    fadeHighKm: 4,
    minEdgesPerOctave: 2.5,
    normalizationFactor: 2,
    pivotJitter: 0.9,
    coastalFadeKm: 0.25,
    hotspotDampen: 0.8,
    orogenicFloor: 0.35,
});

function clamp01(value) {
    return value < 0 ? 0 : (value > 1 ? 1 : value);
}

function smoothstep01(value) {
    const t = clamp01(value);
    return t * t * (3 - 2 * t);
}

function quintic(value) {
    return value * value * value * (value * (value * 6 - 15) + 10);
}

function easeOut(value) {
    const t = clamp01(value);
    const inv = 1 - t;
    return 1 - inv * inv;
}

function powInv(value, exponent) {
    return 1 - Math.pow(1 - clamp01(value), exponent);
}

function hashUint(x, y, z, seed, salt) {
    let h = (seed | 0) ^ Math.imul(x | 0, 0x9e3779b1) ^
        Math.imul(y | 0, 0x85ebca77) ^ Math.imul(z | 0, 0xc2b2ae3d) ^
        Math.imul(salt | 0, 0x27d4eb2f);
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15;
    h = Math.imul(h, 0x846ca68b);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
}

/** Convert the generator's positive raw-land elevation to physical km. */
export function rawElevationToKm(elevation) {
    if (elevation <= 0) return 0;
    const t = elevation >= 1 ? 1 : elevation;
    const t2 = t * t;
    return 6 * t2 * t2 * (5 - 4 * t);
}

/**
 * Runevision-only inverse of the raw-height quartic. The classic detail-noise
 * inversion intentionally remains in place and untouched in terrain-post.js.
 */
export function runevisionKmToElevation(heightKm) {
    const target = Math.max(0.0001, Math.min(5.999, heightKm));
    let t = Math.pow(target / 30, 0.25);
    if (t < 1e-4) t = 1e-4;
    else if (t > 0.9999) t = 0.9999;
    for (let i = 0; i < 7; i++) {
        const t2 = t * t, t3 = t2 * t, t4 = t3 * t;
        const f = 6 * t4 * (5 - 4 * t) - target;
        const fp = 120 * t3 * (1 - t);
        if (fp < 1e-9) break;
        const next = t - f / fp;
        t = next < 1e-4 ? 1e-4 : (next > 0.9999 ? 0.9999 : next);
        if (Math.abs(f) < 1e-10) break;
    }
    return t;
}

function estimateAverageEdgeKm(mesh, r_xyz, neighborDist) {
    let total = 0, count = 0;
    for (let i = 0; i < mesh.adjList.length; i++) {
        let chord = neighborDist && neighborDist[i];
        if (!(chord > 0)) {
            // Recover the source region for this adjacency slot only in the
            // uncommon test/fallback case where distances were not supplied.
            let lo = 0, hi = mesh.numRegions;
            while (lo + 1 < hi) {
                const mid = (lo + hi) >> 1;
                if (mesh.adjOffset[mid] <= i) lo = mid; else hi = mid;
            }
            const nb = mesh.adjList[i];
            const dx = r_xyz[3 * lo] - r_xyz[3 * nb];
            const dy = r_xyz[3 * lo + 1] - r_xyz[3 * nb + 1];
            const dz = r_xyz[3 * lo + 2] - r_xyz[3 * nb + 2];
            chord = Math.hypot(dx, dy, dz);
        }
        if (chord > 0) {
            total += chord * PLANET_RADIUS_KM;
            count++;
        }
    }
    return count > 0 ? total / count : (Math.PI * PLANET_RADIUS_KM) / Math.sqrt(mesh.numRegions);
}

// Quintic trilinear interpolation of directional cosine/sine stripes from
// the eight corners of a deterministically jittered 3D cubic lattice.
function sampleDirectionalCell(px, py, pz, nx, ny, nz, phaseX, phaseY, phaseZ,
    cellSizeKm, stripeRatio, seed, octave, normalizationFactor, pivotJitter, out) {
    const scale = PLANET_RADIUS_KM / cellSizeKm;
    const sx = px * scale, sy = py * scale, sz = pz * scale;
    const ix = Math.floor(sx), iy = Math.floor(sy), iz = Math.floor(sz);
    const ux = quintic(sx - ix), uy = quintic(sy - iy), uz = quintic(sz - iz);
    let cosine = 0, sine = 0;

    for (let oz = 0; oz <= 1; oz++) {
        const wz = oz ? uz : 1 - uz;
        const cz = iz + oz;
        for (let oy = 0; oy <= 1; oy++) {
            const wyz = wz * (oy ? uy : 1 - uy);
            const cy = iy + oy;
            for (let ox = 0; ox <= 1; ox++) {
                const weight = wyz * (ox ? ux : 1 - ux);
                const cx = ix + ox;
                const jx = (hashUint(cx, cy, cz, seed, octave * 17 + 1) - 0.5) * pivotJitter;
                const jy = (hashUint(cx, cy, cz, seed, octave * 17 + 2) - 0.5) * pivotJitter;
                const jz = (hashUint(cx, cy, cz, seed, octave * 17 + 3) - 0.5) * pivotJitter;
                let dx = sx - (cx + jx), dy = sy - (cy + jy), dz = sz - (cz + jz);
                const radial = dx * nx + dy * ny + dz * nz;
                dx -= radial * nx;
                dy -= radial * ny;
                dz -= radial * nz;
                const randomPhase = hashUint(cx, cy, cz, seed, octave * 17 + 4);
                const phase = TAU * ((dx * phaseX + dy * phaseY + dz * phaseZ) * stripeRatio + randomPhase);
                cosine += weight * Math.cos(phase);
                sine += weight * Math.sin(phase);
            }
        }
    }

    const length = Math.hypot(cosine, sine);
    if (length > 1e-12) {
        // Partial normalization: scale vector length by k, then clamp it to 1.
        const scaleNorm = Math.min(normalizationFactor, 1 / length);
        cosine *= scaleNorm;
        sine *= scaleNorm;
    }
    out[0] = cosine;
    out[1] = sine;
}

/**
 * Apply the experimental Runevision erosion filter in-place.
 *
 * All slope estimation and sampling read immutable physical/raw snapshots;
 * the final raw elevations are copied from a separate output buffer only after
 * every requested region has been evaluated.
 */
export function applyRunevisionErosion(mesh, r_xyz, neighborDist, r_elevation,
    r_isOcean, seed, options = {}) {
    const opts = { ...DEFAULTS, ...options };
    const N = mesh.numRegions;
    const { adjOffset, adjList } = mesh;
    const physicalHeight = new Float64Array(N);
    const gradientEast = new Float32Array(N);
    const gradientNorth = new Float32Array(N);
    const runevisionSlope = new Float32Array(N);
    const coastalLand = new Uint8Array(N);
    const output = new Float32Array(r_elevation);
    const runevisionDelta = new Float32Array(N);

    for (let r = 0; r < N; r++) {
        physicalHeight[r] = r_isOcean[r] ? 0 : rawElevationToKm(r_elevation[r]);
        if (r_isOcean[r]) continue;
        for (let i = adjOffset[r]; i < adjOffset[r + 1]; i++) {
            if (r_isOcean[adjList[i]]) { coastalLand[r] = 1; break; }
        }
    }

    // Weighted 2×2 least-squares slope in a local east/north tangent frame.
    for (let r = 0; r < N; r++) {
        const px = r_xyz[3 * r], py = r_xyz[3 * r + 1], pz = r_xyz[3 * r + 2];
        const horizontal = Math.hypot(px, pz);
        const ex = horizontal > 1e-10 ? pz / horizontal : 1;
        const ey = 0;
        const ez = horizontal > 1e-10 ? -px / horizontal : 0;
        const tx = horizontal > 1e-10 ? py * ez : 0;
        const ty = horizontal > 1e-10 ? pz * ex - px * ez : 0;
        const tz = horizontal > 1e-10 ? -py * ex : (py >= 0 ? -1 : 1);
        let a00 = 0, a01 = 0, a11 = 0, b0 = 0, b1 = 0;
        for (let i = adjOffset[r]; i < adjOffset[r + 1]; i++) {
            const nb = adjList[i];
            const dx = (r_xyz[3 * nb] - px) * PLANET_RADIUS_KM;
            const dy = (r_xyz[3 * nb + 1] - py) * PLANET_RADIUS_KM;
            const dz = (r_xyz[3 * nb + 2] - pz) * PLANET_RADIUS_KM;
            const eastKm = dx * ex + dy * ey + dz * ez;
            const northKm = dx * tx + dy * ty + dz * tz;
            const distKm = neighborDist && neighborDist[i] > 0
                ? neighborDist[i] * PLANET_RADIUS_KM
                : Math.hypot(dx, dy, dz);
            if (!(distKm > 1e-9)) continue;
            const weight = 1 / (distKm * distKm);
            const dh = physicalHeight[nb] - physicalHeight[r];
            a00 += weight * eastKm * eastKm;
            a01 += weight * eastKm * northKm;
            a11 += weight * northKm * northKm;
            b0 += weight * eastKm * dh;
            b1 += weight * northKm * dh;
        }
        const det = a00 * a11 - a01 * a01;
        if (Math.abs(det) > 1e-12) {
            gradientEast[r] = (b0 * a11 - b1 * a01) / det;
            gradientNorth[r] = (b1 * a00 - b0 * a01) / det;
            runevisionSlope[r] = Math.hypot(gradientEast[r], gradientNorth[r]);
        }
    }

    const avgEdgeKm = estimateAverageEdgeKm(mesh, r_xyz, neighborDist);
    const activeWavelengths = [];
    let wavelengthKm = opts.baseWavelengthKm;
    let amplitude = 1;
    for (let octave = 0; octave < opts.octaves; octave++) {
        if (wavelengthKm >= opts.minEdgesPerOctave * avgEdgeKm) {
            activeWavelengths.push({ octave, wavelengthKm, amplitude });
        }
        wavelengthKm /= opts.lacunarity;
        amplitude *= opts.gain;
    }

    const hotspotField = opts.hotspotField ?? null;
    const orogenicField = opts.orogenicField ?? null;
    const order = opts.regionOrder ?? null;
    const sample = new Float64Array(2);
    for (let oi = 0; oi < N; oi++) {
        const r = order ? order[oi] : oi;
        if (r_isOcean[r] || coastalLand[r]) continue;
        const slope = runevisionSlope[r];
        if (!(slope > 1e-8) || activeWavelengths.length === 0) continue;

        const px = r_xyz[3 * r], py = r_xyz[3 * r + 1], pz = r_xyz[3 * r + 2];
        const horizontal = Math.hypot(px, pz);
        const ex = horizontal > 1e-10 ? pz / horizontal : 1;
        const ey = 0;
        const ez = horizontal > 1e-10 ? -px / horizontal : 0;
        const nxLocal = horizontal > 1e-10 ? py * ez : 0;
        const nyLocal = horizontal > 1e-10 ? pz * ex - px * ez : 0;
        const nzLocal = horizontal > 1e-10 ? -py * ex : (py >= 0 ? -1 : 1);

        let gullyEast = gradientEast[r] * (opts.pretendSlope / slope);
        let gullyNorth = gradientNorth[r] * (opts.pretendSlope / slope);
        let combiMask = easeOut(slope / opts.slopeReference);
        let fadeTarget = clamp01((physicalHeight[r] - opts.fadeLowKm) /
            (opts.fadeHighKm - opts.fadeLowKm)) * 2 - 1;
        let offsetKm = 0;

        for (const octaveData of activeWavelengths) {
            const internalSlope = Math.hypot(gullyEast, gullyNorth);
            if (!(internalSlope > 1e-10)) break;
            // Phase varies perpendicular to the gradient, so the stripe lines
            // themselves run along the downhill/uphill direction.
            const phaseEast = -gullyNorth / internalSlope;
            const phaseNorth = gullyEast / internalSlope;
            const phaseX = phaseEast * ex + phaseNorth * nxLocal;
            const phaseY = phaseEast * ey + phaseNorth * nyLocal;
            const phaseZ = phaseEast * ez + phaseNorth * nzLocal;
            const cellSizeKm = octaveData.wavelengthKm * opts.cellToStripeRatio;
            sampleDirectionalCell(px, py, pz, px, py, pz,
                phaseX, phaseY, phaseZ,
                cellSizeKm, opts.cellToStripeRatio,
                seed, octaveData.octave, opts.normalizationFactor, opts.pivotJitter, sample);

            const cosine = sample[0], sine = sample[1];
            const fadedHeight = fadeTarget * (1 - combiMask) + cosine * combiMask;
            offsetKm += opts.strengthKm * octaveData.amplitude * fadedHeight;

            // Smooth sine controls the visible fade/output derivative. Only
            // the internal direction field uses sign(sine), emulating straight
            // triangle-wave sides without exposing derivative discontinuities.
            const smoothSlope = Math.abs(sine) * opts.pretendSlope;
            const newMask = easeOut(smoothSlope / opts.slopeReference);
            fadeTarget = fadedHeight;
            combiMask = powInv(combiMask, opts.detailExponent) * newMask;
            const signedSlope = sine < 0 ? -opts.pretendSlope : opts.pretendSlope;
            gullyEast += phaseEast * -signedSlope;
            gullyNorth += phaseNorth * -signedSlope;
        }

        const coastFade = smoothstep01(physicalHeight[r] / opts.coastalFadeKm);
        const hotspot = hotspotField ? clamp01(hotspotField[r]) : 0;
        const hotspotFactor = 1 - opts.hotspotDampen * hotspot;
        const orogenicFactor = orogenicField
            ? Math.max(opts.orogenicFloor, clamp01(orogenicField[r]))
            : 1;
        const targetKm = Math.max(0.0001, Math.min(5.999,
            physicalHeight[r] + offsetKm * coastFade * hotspotFactor * orogenicFactor));
        output[r] = runevisionKmToElevation(targetKm);
    }

    for (let r = 0; r < N; r++) {
        runevisionDelta[r] = output[r] - r_elevation[r];
    }
    r_elevation.set(output);
    return { runevisionDelta, runevisionSlope };
}

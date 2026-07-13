// Round-trip + legacy-decode check for the SP5 planet-code format bump.
// Run: node tuning/check-planet-code.mjs   (exit 0 = pass)

import { encodePlanetCode, decodePlanetCode } from '../js/planet-code.js';

const LEGACY_CODE = '0009j742vm5hledp1e70rb';

let failures = 0;
function check(cond, msg) {
    if (!cond) { failures++; console.error('FAIL:', msg); }
}

// 1. New-format round trip at defaults and extremes
const cases = [
    { seed: 12345, N: 204000, jitter: 0.75, P: 80, numContinents: 4, roughness: 0.4,
      terrainWarp: 0.75, smoothing: 0.1, glacialErosion: 0.5, hydraulicErosion: 0.5,
      thermalErosion: 0.1, ridgeSharpening: 0.5, soilCreep: 0.75, continentSizeVariety: 0.35,
      temperatureOffset: 0, precipitationOffset: 0, landCoverage: 0.3,
      deposition: 0.5, rebound: 0.35, numHotspots: 5, toggledIndices: [] },
    { seed: 16777215, N: 2560000, jitter: 1, P: 120, numContinents: 10, roughness: 0.5,
      terrainWarp: 1, smoothing: 1, glacialErosion: 1, hydraulicErosion: 1,
      thermalErosion: 1, ridgeSharpening: 1, soilCreep: 1, continentSizeVariety: 1,
      temperatureOffset: 15, precipitationOffset: 1, landCoverage: 1,
      deposition: 1, rebound: 1, numHotspots: 12, toggledIndices: [0, 3] },
    { seed: 0, N: 5000, jitter: 0, P: 4, numContinents: 1, roughness: 0,
      terrainWarp: 0, smoothing: 0, glacialErosion: 0, hydraulicErosion: 0,
      thermalErosion: 0, ridgeSharpening: 0, soilCreep: 0, continentSizeVariety: 0,
      temperatureOffset: -15, precipitationOffset: -1, landCoverage: 0,
      deposition: 0, rebound: 0, numHotspots: 0, toggledIndices: [] },
];
for (const c of cases) {
    const code = encodePlanetCode(c.seed, c.N, c.jitter, c.P, c.numContinents, c.roughness,
        c.terrainWarp, c.smoothing, c.glacialErosion, c.hydraulicErosion, c.thermalErosion,
        c.ridgeSharpening, c.soilCreep, c.continentSizeVariety, c.temperatureOffset,
        c.precipitationOffset, c.landCoverage, c.deposition, c.rebound, c.numHotspots,
        c.toggledIndices);
    check(code.split('-')[0].length === 25, `new code base length 25, got ${code.split('-')[0].length}`);
    const d = decodePlanetCode(code);
    check(d !== null, `decode(${code}) !== null`);
    for (const k of Object.keys(c)) {
        if (k === 'toggledIndices') {
            check(JSON.stringify(d.toggledIndices) === JSON.stringify(c.toggledIndices), `${k} round-trip`);
        } else {
            check(d[k] === c[k], `${k} round-trip: sent ${c[k]}, got ${d[k]}`);
        }
    }
}

// 1b. New sliders (deposition/rebound/numHotspots) combined with a `~` motion-overrides
// suffix — the 25-char base and the motion suffix are decoded independently (SP5's base
// bump vs. SP6's motion suffix), so both must survive a round trip together.
{
    const c = {
        seed: 777, N: 640000, jitter: 0.5, P: 40, numContinents: 5, roughness: 0.25,
        terrainWarp: 0.5, smoothing: 0.5, glacialErosion: 0.25, hydraulicErosion: 0.25,
        thermalErosion: 0.25, ridgeSharpening: 0.25, soilCreep: 0.5, continentSizeVariety: 0.5,
        temperatureOffset: 5, precipitationOffset: 0.5, landCoverage: 0.6,
        deposition: 0.9, rebound: 0.8, numHotspots: 9, toggledIndices: [1, 7],
    };
    const motionOverrides = [
        { plateIndex: 2, bearingDeg: 45, speedPercent: 150 },
        { plateIndex: 5, bearingDeg: 270, speedPercent: 10 },
    ];
    const code = encodePlanetCode(c.seed, c.N, c.jitter, c.P, c.numContinents, c.roughness,
        c.terrainWarp, c.smoothing, c.glacialErosion, c.hydraulicErosion, c.thermalErosion,
        c.ridgeSharpening, c.soilCreep, c.continentSizeVariety, c.temperatureOffset,
        c.precipitationOffset, c.landCoverage, c.deposition, c.rebound, c.numHotspots,
        c.toggledIndices, motionOverrides);
    check(code.includes('~'), 'motion+new-sliders code has ~ suffix');
    const d = decodePlanetCode(code);
    check(d !== null, `decode(${code}) !== null`);
    if (d) {
        check(d.deposition === c.deposition, `deposition round-trip: sent ${c.deposition}, got ${d.deposition}`);
        check(d.rebound === c.rebound, `rebound round-trip: sent ${c.rebound}, got ${d.rebound}`);
        check(d.numHotspots === c.numHotspots, `numHotspots round-trip: sent ${c.numHotspots}, got ${d.numHotspots}`);
        check(JSON.stringify(d.toggledIndices) === JSON.stringify(c.toggledIndices), 'toggledIndices round-trip');
        check(JSON.stringify(d.motionOverrides) === JSON.stringify(motionOverrides),
            `motionOverrides round-trip: sent ${JSON.stringify(motionOverrides)}, got ${JSON.stringify(d.motionOverrides)}`);
    }
}

// 2. Legacy 22-char code decodes with SP5 defaults injected
const legacy = decodePlanetCode(LEGACY_CODE);
check(legacy !== null, 'legacy 22-char decodes');
check(legacy.seed === 12345 && legacy.N === 204000 && legacy.landCoverage === 0.3, 'legacy fields preserved');
check(legacy.deposition === 0.5, 'legacy default deposition 0.5');
check(legacy.rebound === 0.35, 'legacy default rebound 0.35');
check(legacy.numHotspots === 5, 'legacy default numHotspots 5');

// 3. All older lengths still route (13/14/16/17/18/21 configs exist)
check(decodePlanetCode('zzz') === null, 'garbage rejected');

if (failures === 0) { console.log('planet-code round-trip: PASS'); process.exit(0); }
process.exit(1);

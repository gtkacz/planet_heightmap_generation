// Round-trip and legacy-decode checks for the unified (SP4 climate + SP5 deposition/
// rebound/hotspots + SP6 motion) planet-code format.
//   node tuning/planet-code-check.mjs
import { encodePlanetCode, decodePlanetCode } from '../js/planet-code.js';

let failures = 0;
function check(name, cond) {
    if (!cond) { failures++; console.error('FAIL', name); }
    else { console.log('ok  ', name); }
}
function near(a, b) { return Math.abs(a - b) < 1e-9; }

// [seed, N, jitter, P, numContinents, roughness, terrainWarp, smoothing, glacial,
//  hydraulic, thermal, ridge, soilCreep, csv, tempOff, precipOff, landCoverage,
//  deposition, rebound, numHotspots,
//  axialTilt, rotationRate, greenhouse, winterSeverity, orographicRain, maritimeInfluence, mountainChill]
const CASES = [
    { name: 'defaults', args: [12345, 204000, 0.75, 80, 4, 0.4, 0.75, 0.1, 0.5, 0.5, 0.5, 0.5, 0.75, 0.35, 0, 0, 0.3, 0.5, 0.35, 5, 23.5, 1, 0, 1, 1, 1, 1] },
    { name: 'minima', args: [0, 5000, 0, 4, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, -15, -1, 0, 0, 0, 0, 0, 0.5, -1, 0, 0, 0, 0] },
    { name: 'maxima', args: [16777215, 2560000, 1, 120, 10, 0.5, 1, 1, 1, 1, 1, 1, 1, 1, 15, 1, 1, 1, 1, 12, 45, 2, 1, 2, 2, 2, 2] },
    { name: 'mixed', args: [999999, 500000, 0.5, 40, 7, 0.25, 0.5, 0.5, 0.2, 0.8, 0.3, 0.6, 0.75, 0.5, -5, 0.4, 0.55, 0.45, 0.65, 8, 31.5, 1.3, -0.4, 1.7, 0.2, 1.1, 0.9] },
];
const FIELDS = ['seed', 'N', 'jitter', 'P', 'numContinents', 'roughness', 'terrainWarp', 'smoothing',
    'glacialErosion', 'hydraulicErosion', 'thermalErosion', 'ridgeSharpening', 'soilCreep',
    'continentSizeVariety', 'temperatureOffset', 'precipitationOffset', 'landCoverage',
    'deposition', 'rebound', 'numHotspots',
    'axialTilt', 'rotationRate', 'greenhouse', 'winterSeverity', 'orographicRain',
    'maritimeInfluence', 'mountainChill'];

for (const { name, args } of CASES) {
    const code = encodePlanetCode(...args);
    const d = decodePlanetCode(code);
    check(`${name}: decodes`, d !== null);
    if (!d) { continue; }
    for (let i = 0; i < FIELDS.length; i++) {
        check(`${name}: ${FIELDS[i]}`, near(d[FIELDS[i]], args[i]));
    }
    check(`${name}: base length 30`, code.split(/[-~]/)[0].length === 30);
}

// Suffixes survive the unified format
const withSuffixes = encodePlanetCode(12345, 204000, 0.75, 80, 4, 0.4, 0.75, 0.1, 0.5, 0.5, 0.5, 0.5, 0.75, 0.35, 3, -0.2, 0.3, 0.45, 0.65, 8, 30, 1.5, 0.5, 1.2, 0.8, 1.4, 0.6, [3, 7], [{ plateIndex: 1, bearingDeg: 45, speedPercent: 80 }]);
const ds = decodePlanetCode(withSuffixes);
check('suffixes: toggles', ds && ds.toggledIndices.length === 2 && ds.toggledIndices[0] === 3 && ds.toggledIndices[1] === 7);
check('suffixes: tilt', ds && near(ds.axialTilt, 30));
check('suffixes: motion', ds && ds.motionOverrides.length === 1 && ds.motionOverrides[0].plateIndex === 1 && ds.motionOverrides[0].bearingDeg === 45 && ds.motionOverrides[0].speedPercent === 80);

// Legacy 25-char codes (pre-SP4, i.e. main before this merge: deposition/rebound/hotspots
// present but no climate sliders) decode with the 7 new climate defaults filled in.
// Captured by packing seed=12345, N=50000, P=20, numContinents=4, jitter=0.5, roughness=0.1,
// smoothing=0.4, glacialErosion=0.2, hydraulicErosion=0.5, thermalErosion=0.15,
// ridgeSharpening=0.25, soilCreep=0.05, terrainWarp=0.3, continentSizeVariety=0.1,
// temperatureOffset=3, precipitationOffset=0.2, landCoverage=0.35, deposition=0.5,
// rebound=0.35, numHotspots=5 through the pre-SP4 19-field mixed-radix format.
const LEGACY_25 = '0001665y6g2kvymqhea0wuriv';
const dl = decodePlanetCode(LEGACY_25);
check('legacy25: decodes', dl !== null);
if (dl) {
    check('legacy25: seed preserved', dl.seed === 12345);
    check('legacy25: N preserved', dl.N === 50000);
    check('legacy25: deposition preserved', near(dl.deposition, 0.5));
    check('legacy25: numHotspots preserved', dl.numHotspots === 5);
    check('legacy25: tilt default', dl.axialTilt === 23.5);
    check('legacy25: rotation default', dl.rotationRate === 1);
    check('legacy25: greenhouse default', dl.greenhouse === 0);
    check('legacy25: character defaults', dl.winterSeverity === 1 && dl.orographicRain === 1 && dl.maritimeInfluence === 1 && dl.mountainChill === 1);
}

process.exit(failures ? 1 : 0);

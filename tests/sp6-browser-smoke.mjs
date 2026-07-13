import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

import { encodePlanetCode } from '../js/planet-code.js';

const BASE_ARGS = [
    424242, 5000, 0.75, 8, 4, 0.4, 0.75, 0.1,
    0.5, 0.5, 0.1, 0.35, 0.75, 0.35, 0, 0, 0.3,
];

const origin = process.env.OROGEN_TEST_ORIGIN || 'http://127.0.0.1:8765';
const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));

    async function load(code) {
        await page.goto(`${origin}/?case=${Date.now()}-${Math.random()}#${code}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
        await page.waitForFunction(() => {
            const button = document.getElementById('generate');
            return button && !button.disabled && button.textContent === 'Build New World';
        }, { timeout: 120_000 });
        return page.evaluate(async () => {
            const { state } = await import('/js/state.js');
            const { motionBearingDeg } = await import('/js/plate-motion.js');
            const data = state.curData;
            const plateId = Array.from(data.plateSeeds)[0];
            const generated = data.generatedPlateVec[plateId];
            const final = data.plateVec[plateId];
            const anchor = data.motionAnchors[plateId];
            return {
                plateId,
                generated,
                final,
                anchor,
                bearingDeg: motionBearingDeg(final, anchor),
                overrides: Array.from(data.motionOverrides.entries()),
                regionCount: data.mesh.numRegions,
                allPlateVec: data.plateVec,
                allGeneratedPlateVec: data.generatedPlateVec,
                elevations: Array.from(data.r_elevation),
            };
        });
    }

    const noOverride = await load(encodePlanetCode(...BASE_ARGS));
    assert.equal(noOverride.regionCount, 5001);
    assert.deepEqual(noOverride.final, noOverride.generated);
    assert.ok(Math.abs(Math.hypot(...noOverride.anchor) - 1) < 1e-6);
    assert.deepEqual(noOverride.overrides, []);

    const interactive = await page.evaluate(async () => {
        const { state } = await import('/js/state.js');
        const { editRecomputeViaWorker } = await import('/js/generate.js');
        const { motionBearingDeg } = await import('/js/plate-motion.js');
        const data = state.curData;
        const plateId = Array.from(data.plateSeeds)[0];
        data.motionOverrides.set(plateId, { bearingDeg: 90, speedPercent: 150 });
        await new Promise(resolve => editRecomputeViaWorker(resolve, true));
        return {
            plateId,
            bearingDeg: motionBearingDeg(data.plateVec[plateId], data.motionAnchors[plateId]),
            overrides: Array.from(data.motionOverrides.entries()),
            allPlateVec: data.plateVec,
            allGeneratedPlateVec: data.generatedPlateVec,
            elevations: Array.from(data.r_elevation),
        };
    });
    assert.equal(interactive.overrides.length, 1);
    assert.ok(Math.abs(interactive.bearingDeg - 90) < 1e-5);

    const edited = await load(encodePlanetCode(...BASE_ARGS, [], [
        { plateIndex: 0, bearingDeg: 90, speedPercent: 150 },
    ]));
    assert.equal(edited.overrides.length, 1);
    assert.equal(edited.overrides[0][0], edited.plateId);
    assert.deepEqual(edited.overrides[0][1], { bearingDeg: 90, speedPercent: 150 });
    assert.ok(Math.abs(edited.bearingDeg - 90) < 1e-5, `bearing=${edited.bearingDeg}`);
    assert.ok(Math.abs(Math.abs(edited.final.omega) / Math.abs(edited.generated.omega) - 1.5) < 1e-9);
    assert.deepEqual(interactive.allGeneratedPlateVec, edited.allGeneratedPlateVec);
    assert.deepEqual(interactive.allPlateVec, edited.allPlateVec);
    assert.deepEqual(interactive.elevations, edited.elevations);

    // Combined type + motion edits follow the same physics sequence when
    // applied interactively and when regenerated from their shared code.
    await load(encodePlanetCode(...BASE_ARGS));
    const combinedInteractive = await page.evaluate(async () => {
        const { state } = await import('/js/state.js');
        const { editRecomputeViaWorker } = await import('/js/generate.js');
        const data = state.curData;
        const plateId = Array.from(data.plateSeeds)[0];
        if (data.plateIsOcean.has(plateId)) {
            data.plateIsOcean.delete(plateId);
            data.plateDensity[plateId] = data.plateDensityLand[plateId];
        } else {
            data.plateIsOcean.add(plateId);
            data.plateDensity[plateId] = data.plateDensityOcean[plateId];
        }
        data.motionOverrides.set(plateId, { bearingDeg: 225, speedPercent: 80 });
        await new Promise(resolve => editRecomputeViaWorker(resolve, true));
        return {
            allPlateVec: data.plateVec,
            allGeneratedPlateVec: data.generatedPlateVec,
            elevations: Array.from(data.r_elevation),
        };
    });
    const combinedFresh = await load(encodePlanetCode(...BASE_ARGS, [0], [
        { plateIndex: 0, bearingDeg: 225, speedPercent: 80 },
    ]));
    assert.deepEqual(combinedInteractive.allGeneratedPlateVec, combinedFresh.allGeneratedPlateVec);
    assert.deepEqual(combinedInteractive.allPlateVec, combinedFresh.allPlateVec);
    assert.deepEqual(combinedInteractive.elevations, combinedFresh.elevations);

    assert.deepEqual(pageErrors, []);
    console.log('SP6 browser core smoke passed');
} finally {
    await browser.close();
}

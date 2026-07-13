import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

import { encodePlanetCode } from '../js/planet-code.js';

const code = encodePlanetCode(
    424242, 5000, 0.75, 8, 4, 0.4, 0.75, 0.1,
    0.5, 0.5, 0.1, 0.35, 0.75, 0.35, 0, 0, 0.3,
    0.5, 0.35, 5, 23.5, 1, 0, 1, 1, 1, 1,
);
const origin = process.env.OROGEN_TEST_ORIGIN || 'http://127.0.0.1:8767';
const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 180_000,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

try {
    const page = await browser.newPage();
    const consoleErrors = [];
    const pageErrors = [];
    page.on('console', message => {
        if (message.type() === 'error') {
            consoleErrors.push(message.text());
            console.error(`[fallback page] ${message.text()}`);
        }
    });
    page.on('pageerror', error => {
        pageErrors.push(error.message);
        console.error(`[fallback exception] ${error.message}`);
    });
    await page.evaluateOnNewDocument(() => {
        window.Worker = class UnsupportedWorker {
            constructor() { throw new Error('forced no-worker terrain-lab test'); }
        };
        const enableTerrainLab = () => {
            const morenoise = document.getElementById('ffMorenoise');
            const runevision = document.getElementById('ffRunevision');
            if (morenoise) morenoise.checked = true;
            if (runevision) runevision.checked = true;
        };
        new MutationObserver(enableTerrainLab).observe(document, { childList: true, subtree: true });
    });
    await page.goto(`${origin}/?terrainLab=1&case=fallback-only#${code}`,
        { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await page.waitForFunction(async () => {
        const { state } = await import('/js/state.js');
        return state.curData !== null;
    }, { timeout: 120_000, polling: 100 });

    const result = await page.evaluate(async () => {
        const { state } = await import('/js/state.js');
        const data = state.curData;
        return {
            morenoise: data.debugLayers.morenoiseDelta.length,
            runevision: data.debugLayers.runevisionDelta.length,
            slope: data.debugLayers.runevisionSlope.length,
            regions: data.mesh.numRegions,
            finite: data.r_elevation.every(Number.isFinite),
        };
    });
    assert.deepEqual(result, {
        morenoise: 5001,
        runevision: 5001,
        slope: 5001,
        regions: 5001,
        finite: true,
    });

    const toggled = await page.evaluate(async () => {
        const { state } = await import('/js/state.js');
        const hash = array => {
            const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
            let value = 2166136261;
            for (let i = 0; i < bytes.length; i++) value = Math.imul(value ^ bytes[i], 16777619);
            return `${array.length}:${value >>> 0}`;
        };
        const before = hash(state.curData.r_elevation);
        await new Promise((resolve, reject) => {
            const button = document.getElementById('generate');
            const timeout = setTimeout(() => reject(new Error('fallback checkbox apply timeout')), 120_000);
            button.addEventListener('generate-done', () => { clearTimeout(timeout); resolve(); }, { once: true });
            const morenoise = document.getElementById('ffMorenoise');
            morenoise.checked = false;
            morenoise.dispatchEvent(new Event('change', { bubbles: true }));
        });
        return {
            changed: hash(state.curData.r_elevation) !== before,
            morenoise: state.curData.debugLayers.morenoiseDelta ?? null,
            runevision: state.curData.debugLayers.runevisionDelta?.length,
        };
    });
    assert.deepEqual(toggled, { changed: true, morenoise: null, runevision: 5001 });
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(consoleErrors, []);
    console.log('Terrain Lab synchronous fallback passed');
} finally {
    await browser.close();
}

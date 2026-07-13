import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

import { encodePlanetCode } from '../js/planet-code.js';

const BASE_ARGS = [
    424242, 31000, 0.75, 8, 4, 0.4, 0.75, 0.1,
    0.5, 0.5, 0.1, 0.35, 0.75, 0.35, 0, 0, 0.3,
    0.5, 0.35, 5, 23.5, 1, 0, 1, 1, 1, 1,
];
const code = encodePlanetCode(...BASE_ARGS);
const origin = process.env.OROGEN_TEST_ORIGIN || 'http://127.0.0.1:8767';

const browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 180_000,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

async function waitForGeneration(page) {
    await page.waitForFunction(async () => {
        const button = document.getElementById('generate');
        const { state } = await import('/js/state.js');
        return state.curData && button && !button.disabled && button.textContent === 'Build New World';
    }, { timeout: 180_000, polling: 100 });
}

try {
    const defaultPage = await browser.newPage();
    await defaultPage.goto(`${origin}/?case=default#${code}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await waitForGeneration(defaultPage);
    const defaultState = await defaultPage.evaluate(() => ({
        controlsHidden: document.getElementById('terrainLab').hidden,
        inspectHidden: document.getElementById('terrainLabInspect').hidden,
        morenoiseChecked: document.getElementById('ffMorenoise').checked,
        runevisionChecked: document.getElementById('ffRunevision').checked,
    }));
    assert.deepEqual(defaultState, {
        controlsHidden: false,
        inspectHidden: false,
        morenoiseChecked: false,
        runevisionChecked: false,
    });
    await defaultPage.close();

    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.evaluateOnNewDocument(() => {
        window.__terrainLabWorkerRecords = [];
        const NativeWorker = window.Worker;
        window.Worker = class RecordingWorker extends NativeWorker {
            constructor(...args) {
                super(...args);
                this.addEventListener('message', event => {
                    const data = event.data;
                    if (data?._params || data?._reapplyTiming || data?._editTiming) {
                        window.__terrainLabWorkerRecords.push({
                            type: data.type,
                            params: data._params || null,
                            reapply: data._reapplyTiming || null,
                            edit: data._editTiming || null,
                        });
                    }
                });
            }
        };
    });
    await page.goto(`${origin}/?case=lab#${code}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    await waitForGeneration(page);

    const visibleState = await page.evaluate(() => ({
        controlsHidden: document.getElementById('terrainLab').hidden,
        inspectHidden: document.getElementById('terrainLabInspect').hidden,
        controlsSection: document.getElementById('terrainLab')
            .closest('details')?.querySelector(':scope > summary')?.textContent.trim(),
        optionValues: Array.from(document.querySelectorAll('#terrainLabInspect option'), option => option.value),
        reapplyDisabled: document.getElementById('reapplyBtn').disabled,
    }));
    assert.equal(visibleState.controlsHidden, false);
    assert.equal(visibleState.inspectHidden, false);
    assert.equal(visibleState.controlsSection, 'Visual Options');
    assert.deepEqual(visibleState.optionValues, ['morenoiseDelta', 'runevisionDelta', 'runevisionSlope']);

    const checkboxStart = await page.evaluate(async () => {
        const { state } = await import('/js/state.js');
        const hash = array => {
            const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
            let value = 2166136261;
            for (let i = 0; i < bytes.length; i++) value = Math.imul(value ^ bytes[i], 16777619);
            return `${array.length}:${value >>> 0}`;
        };
        const beforeCode = document.getElementById('seedCode').value;
        const beforeElevation = hash(state.curData.r_elevation);
        const recordCount = window.__terrainLabWorkerRecords.length;
        const box = document.getElementById('ffMorenoise');
        box.checked = true;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        return { beforeCode, beforeElevation, recordCount };
    });
    await page.waitForFunction(recordCount =>
        window.__terrainLabWorkerRecords.slice(recordCount)
            .some(record => record.reapply?.morenoiseEnabled === true),
    { timeout: 180_000, polling: 100 }, checkboxStart.recordCount);
    await page.waitForFunction(() => !document.getElementById('reapplyBtn').classList.contains('spinning'),
        { timeout: 180_000, polling: 100 });
    const checkboxState = await page.evaluate(async () => {
        const { state } = await import('/js/state.js');
        const hash = array => {
            const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
            let value = 2166136261;
            for (let i = 0; i < bytes.length; i++) value = Math.imul(value ^ bytes[i], 16777619);
            return `${array.length}:${value >>> 0}`;
        };
        return {
            code: document.getElementById('seedCode').value,
            elevation: hash(state.curData.r_elevation),
        };
    });
    assert.equal(checkboxState.code, checkboxStart.beforeCode);
    assert.notEqual(checkboxState.elevation, checkboxStart.beforeElevation,
        'checking Morenoise should immediately reapply and change terrain');

    const combinations = await page.evaluate(async () => {
        const { state } = await import('/js/state.js');
        const { generate } = await import('/js/generate.js');
        const hash = array => {
            if (!array) return null;
            const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
            let value = 2166136261;
            for (let i = 0; i < bytes.length; i++) value = Math.imul(value ^ bytes[i], 16777619);
            return `${array.length}:${value >>> 0}`;
        };
        const snapshot = () => {
            const data = state.curData;
            const sign = new Uint8Array(data.r_elevation.length);
            let finite = true;
            for (let i = 0; i < sign.length; i++) {
                sign[i] = data.r_elevation[i] <= 0 ? 1 : 0;
                if (!Number.isFinite(data.r_elevation[i])) finite = false;
            }
            return {
                elevation: hash(data.r_elevation),
                prePost: hash(data.prePostElev),
                classification: hash(sign),
                morenoiseDelta: hash(data.debugLayers?.morenoiseDelta),
                runevisionDelta: hash(data.debugLayers?.runevisionDelta),
                runevisionSlope: hash(data.debugLayers?.runevisionSlope),
                finite,
            };
        };
        const run = (morenoise, runevision) => new Promise((resolve, reject) => {
            const button = document.getElementById('generate');
            const timeout = setTimeout(() => reject(new Error('generate timeout')), 120_000);
            button.addEventListener('generate-done', () => {
                clearTimeout(timeout);
                resolve(snapshot());
            }, { once: true });
            generate(424242, [], () => {}, true, [], morenoise, runevision);
        });
        const results = {};
        for (const [name, morenoise, runevision] of [
            ['neither', false, false],
            ['morenoise', true, false],
            ['runevision', false, true],
            ['both', true, true],
        ]) results[name] = await run(morenoise, runevision);
        results.bothRepeat = await run(true, true);
        return results;
    });

    for (const result of Object.values(combinations)) assert.equal(result.finite, true);
    const baseline = combinations.neither;
    for (const result of Object.values(combinations)) {
        assert.equal(result.prePost, baseline.prePost);
        assert.equal(result.classification, baseline.classification);
    }
    assert.equal(baseline.morenoiseDelta, null);
    assert.equal(baseline.runevisionDelta, null);
    assert.equal(baseline.runevisionSlope, null);
    assert.ok(combinations.morenoise.morenoiseDelta);
    assert.equal(combinations.morenoise.runevisionDelta, null);
    assert.equal(combinations.runevision.morenoiseDelta, null);
    assert.ok(combinations.runevision.runevisionDelta);
    assert.ok(combinations.runevision.runevisionSlope);
    assert.ok(combinations.both.morenoiseDelta && combinations.both.runevisionDelta);
    assert.notEqual(combinations.morenoise.elevation, baseline.elevation);
    assert.notEqual(combinations.runevision.elevation, baseline.elevation);
    assert.notEqual(combinations.both.elevation, baseline.elevation);
    assert.deepEqual(combinations.bothRepeat, combinations.both);

    const reapplyResults = await page.evaluate(async () => {
        const { state } = await import('/js/state.js');
        const { reapplyViaWorker, editRecomputeViaWorker } = await import('/js/generate.js');
        const hash = array => {
            if (!array) return null;
            const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
            let value = 2166136261;
            for (let i = 0; i < bytes.length; i++) value = Math.imul(value ^ bytes[i], 16777619);
            return `${array.length}:${value >>> 0}`;
        };
        const snap = () => ({
            elevation: hash(state.curData.r_elevation),
            prePost: hash(state.curData.prePostElev),
            morenoiseDelta: hash(state.curData.debugLayers.morenoiseDelta),
            runevisionDelta: hash(state.curData.debugLayers.runevisionDelta),
            runevisionSlope: hash(state.curData.debugLayers.runevisionSlope),
        });
        const reapply = (m, r) => new Promise(resolve => reapplyViaWorker(() => resolve(snap()), true, m, r));
        const result = {};
        result.both1 = await reapply(true, true);
        result.both2 = await reapply(true, true);
        result.morenoise = await reapply(true, false);
        result.runevision = await reapply(false, true);
        result.neither = await reapply(false, false);
        result.editBoth = await new Promise(resolve => editRecomputeViaWorker(() => resolve(snap()), true, true, true));
        result.editOff = await reapply(false, false);
        result.records = window.__terrainLabWorkerRecords;
        return result;
    });
    assert.deepEqual(reapplyResults.both1, reapplyResults.both2, 'Reapply must not compound');
    assert.equal(reapplyResults.both1.elevation, combinations.both.elevation);
    assert.equal(reapplyResults.morenoise.elevation, combinations.morenoise.elevation);
    assert.equal(reapplyResults.runevision.elevation, combinations.runevision.elevation);
    assert.equal(reapplyResults.neither.elevation, combinations.neither.elevation);
    assert.equal(reapplyResults.neither.morenoiseDelta, null);
    assert.equal(reapplyResults.neither.runevisionDelta, null);
    assert.equal(reapplyResults.neither.runevisionSlope, null);
    assert.ok(reapplyResults.editBoth.morenoiseDelta);
    assert.ok(reapplyResults.editBoth.runevisionDelta);
    assert.equal(reapplyResults.editOff.elevation, combinations.neither.elevation);

    const generatedRecords = reapplyResults.records.filter(record => record.type === 'done' && record.params);
    assert.ok(generatedRecords.some(record => record.params.morenoiseEnabled === false && record.params.runevisionEnabled === false));
    assert.ok(generatedRecords.some(record => record.params.morenoiseEnabled === true && record.params.runevisionEnabled === true));
    assert.ok(reapplyResults.records.some(record => record.reapply?.morenoiseEnabled === false && record.reapply?.runevisionEnabled === false));
    assert.ok(reapplyResults.records.some(record => record.edit?.morenoiseEnabled === true && record.edit?.runevisionEnabled === true));

    const importResult = await page.evaluate(async () => {
        const { state } = await import('/js/state.js');
        const { importHeightmap } = await import('/js/generate.js');
        document.getElementById('sN').value = '0';
        await new Promise((resolve, reject) => {
            const button = document.getElementById('generate');
            const timeout = setTimeout(() => reject(new Error('heightmap import timeout')), 120_000);
            button.addEventListener('generate-done', () => { clearTimeout(timeout); resolve(); }, { once: true });
            importHeightmap(new Uint8Array([0, 255, 255, 0]), 2, 2, () => {}, true);
        });
        const params = window.__terrainLabWorkerRecords
            .filter(record => record.type === 'done' && record.params)
            .at(-1)?.params;
        return {
            morenoiseDelta: state.curData.debugLayers.morenoiseDelta ?? null,
            runevisionDelta: state.curData.debugLayers.runevisionDelta ?? null,
            runevisionSlope: state.curData.debugLayers.runevisionSlope ?? null,
            morenoiseEnabled: params?.morenoiseEnabled,
            runevisionEnabled: params?.runevisionEnabled,
            plates: params?.P,
        };
    });
    assert.deepEqual(importResult, {
        morenoiseDelta: null,
        runevisionDelta: null,
        runevisionSlope: null,
        morenoiseEnabled: false,
        runevisionEnabled: false,
        plates: 0,
    });
    assert.deepEqual(pageErrors, []);
    await page.close();

    console.log('Terrain Lab browser integration passed');
} finally {
    await browser.close();
}

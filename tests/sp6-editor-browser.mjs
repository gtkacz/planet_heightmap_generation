import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

import { encodePlanetCode } from '../js/planet-code.js';

const BASE_ARGS = [
    777777, 5000, 0.75, 8, 4, 0.4, 0.75, 0.1,
    0.5, 0.5, 0.1, 0.35, 0.75, 0.35, 0, 0, 0.3,
];
const origin = process.env.OROGEN_TEST_ORIGIN || 'http://127.0.0.1:8765';
const code = encodePlanetCode(...BASE_ARGS);

const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`${origin}/?editor=${Date.now()}#${code}`, {
        waitUntil: 'domcontentloaded', timeout: 120_000,
    });
    await page.waitForFunction(() => {
        const button = document.getElementById('generate');
        return button && !button.disabled && button.textContent === 'Build New World';
    }, { timeout: 120_000 });
    await page.waitForFunction(() => document.getElementById('buildOverlay')?.classList.contains('hidden'));
    await page.evaluate(() => {
        for (const id of ['tutorialOverlay', 'whatsNewOverlay', 'surveyOverlay']) {
            document.getElementById(id)?.classList.add('hidden');
        }
    });

    await page.click('#editToggle');
    await page.waitForFunction(() => !document.getElementById('editTools').hidden);
    await page.click('[data-edit-tool="motion"]');
    assert.equal(await page.$eval('#editTools', el => el.hidden), false);
    assert.equal(await page.$eval('[data-edit-tool="motion"]', el => el.classList.contains('active')), true);

    const canvasBox = await page.$eval('#canvas', el => {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
    });
    await page.mouse.click(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
    await page.waitForFunction(async () => {
        const { state } = await import('/js/state.js');
        return state.selectedMotionPlate >= 0;
    });
    let editorState = await page.evaluate(async () => {
        const { state } = await import('/js/state.js');
        return {
            selected: state.selectedMotionPlate,
            pendingTypes: state.pendingToggles.size,
            pendingMotion: state.pendingMotionOverrides.size,
            arrowChildren: state.plateMotionArrowGroup?.children.length || 0,
        };
    });
    assert.ok(editorState.selected >= 0);
    assert.equal(editorState.pendingTypes, 0);
    assert.equal(editorState.pendingMotion, 0);
    assert.ok(editorState.arrowChildren > 0);
    assert.equal(await page.$eval('#motionPanel', el => el.hidden), false);

    // Pick a front-facing plate anchor so its DOM handle is guaranteed visible.
    await page.evaluate(async () => {
        const THREE = await import('three');
        const { state } = await import('/js/state.js');
        const { camera } = await import('/js/scene.js');
        const { selectMotionPlate } = await import('/js/plate-motion-editor.js');
        const rotation = state.planetMesh?.rotation.y || 0;
        const yAxis = new THREE.Vector3(0, 1, 0);
        let bestPlate = -1;
        let bestFacing = -Infinity;
        for (const plateId of state.curData.plateSeeds) {
            const anchor = new THREE.Vector3(...state.curData.motionAnchors[plateId]).applyAxisAngle(yAxis, rotation);
            const facing = anchor.dot(camera.position.clone().sub(anchor));
            if (facing > bestFacing) { bestFacing = facing; bestPlate = plateId; }
        }
        selectMotionPlate(bestPlate);
    });
    await page.waitForFunction(() => !document.getElementById('motionHandle').hidden);
    const handleBox = await page.$eval('#motionHandle', el => {
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
    });
    assert.ok(handleBox.width >= 44 && handleBox.height >= 44);

    // Pointer capture on the DOM handle steers without handing the drag to OrbitControls.
    const preDragBearing = await page.$eval('#motionDirectionValue', el => parseInt(el.textContent, 10));
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(handleBox.x + handleBox.width / 2 + 28, handleBox.y + handleBox.height / 2 + 18, { steps: 4 });
    await page.mouse.up();
    await page.waitForFunction(async before => {
        const { state } = await import('/js/state.js');
        const next = state.pendingMotionOverrides.get(state.selectedMotionPlate);
        return next && next.bearingDeg !== before;
    }, {}, preDragBearing);
    await page.keyboard.press('Escape');

    const beforeBearing = await page.$eval('#motionDirectionValue', el => parseInt(el.textContent, 10));
    await page.focus('#motionHandle');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(async () => {
        const { state } = await import('/js/state.js');
        return state.pendingMotionOverrides.size === 1;
    });
    const afterBearing = await page.$eval('#motionDirectionValue', el => parseInt(el.textContent, 10));
    assert.equal(afterBearing, (beforeBearing + 5) % 360);

    await page.$eval('#motionSpeed', el => {
        el.value = '150';
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    assert.equal(await page.$eval('#motionSpeedValue', el => el.textContent), '150%');
    assert.equal(await page.$eval('#rebuildFab span', el => el.textContent), 'Rebuild (1)');

    // Escape cancels staged motion without changing applied state.
    await page.keyboard.press('Escape');
    editorState = await page.evaluate(async () => {
        const { state } = await import('/js/state.js');
        return {
            pendingMotion: state.pendingMotionOverrides.size,
            appliedMotion: state.curData.motionOverrides.size,
        };
    });
    assert.deepEqual(editorState, { pendingMotion: 0, appliedMotion: 0 });

    // Ctrl-click remains Land/Sea even while the Motion palette tool is active.
    await page.keyboard.down('Control');
    await page.mouse.click(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
    await page.keyboard.up('Control');
    await page.waitForFunction(async () => {
        const { state } = await import('/js/state.js');
        return state.pendingToggles.size === 1;
    });
    assert.equal(await page.evaluate(async () => {
        const { state } = await import('/js/state.js');
        return state.pendingMotionOverrides.size;
    }), 0);
    await page.keyboard.press('Escape');

    // Stage and apply a motion edit through the real Rebuild button.
    await page.focus('#motionHandle');
    await page.keyboard.press('ArrowRight');
    await page.$eval('#motionSpeed', el => {
        el.value = '150';
        el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.click('#rebuildFab');
    await page.waitForFunction(async () => {
        const { state } = await import('/js/state.js');
        const button = document.getElementById('generate');
        return !button.disabled && state.curData.motionOverrides.size === 1;
    }, { timeout: 120_000 });
    const appliedCode = await page.$eval('#seedCode', el => el.value);
    assert.ok(appliedCode.includes('~'));
    assert.ok(page.url().includes(`#${appliedCode}`));

    // Reset is itself staged, then removes the suffix after Rebuild.
    assert.equal(await page.$eval('#motionReset', el => el.disabled), false);
    await page.click('#motionReset');
    assert.equal(await page.evaluate(async () => {
        const { state } = await import('/js/state.js');
        return state.pendingMotionOverrides.get(state.selectedMotionPlate) === null;
    }), true);
    await page.click('#rebuildFab');
    await page.waitForFunction(async () => {
        const { state } = await import('/js/state.js');
        const button = document.getElementById('generate');
        return !button.disabled && state.curData.motionOverrides.size === 0;
    }, { timeout: 120_000 });
    assert.equal((await page.$eval('#seedCode', el => el.value)).includes('~'), false);

    // Projection switching keeps the map arrow layer and selected handle live.
    await page.select('#viewMode', 'map');
    await page.waitForFunction(async () => {
        const { state } = await import('/js/state.js');
        return state.mapMode && !!state.mapMesh;
    });
    const mapOverlay = await page.evaluate(async () => {
        const { state } = await import('/js/state.js');
        const globe = state.plateMotionArrowGroup?.getObjectByName('plateMotionGlobe');
        const map = state.plateMotionArrowGroup?.getObjectByName('plateMotionMap');
        return { globeVisible: globe?.visible, mapVisible: map?.visible };
    });
    assert.deepEqual(mapOverlay, { globeVisible: false, mapVisible: true });
    await page.waitForFunction(() => !document.getElementById('motionHandle').hidden);

    // Mobile CSS keeps every new control reachable and touch-sized.
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    const mobileLayout = await page.evaluate(() => {
        const rect = id => {
            const r = document.getElementById(id).getBoundingClientRect();
            return { left: r.left, right: r.right, width: r.width, height: r.height };
        };
        return {
            edit: rect('editToggle'),
            land: rect('editTools').height,
            motionButton: (() => {
                const r = document.querySelector('[data-edit-tool="motion"]').getBoundingClientRect();
                return { width: r.width, height: r.height };
            })(),
            handle: rect('motionHandle'),
            panel: rect('motionPanel'),
            reset: rect('motionReset'),
            viewportWidth: innerWidth,
        };
    });
    assert.ok(mobileLayout.edit.width >= 44 && mobileLayout.edit.height >= 44);
    assert.ok(mobileLayout.motionButton.height >= 44, JSON.stringify(mobileLayout));
    assert.ok(mobileLayout.handle.width >= 44 && mobileLayout.handle.height >= 44);
    assert.ok(mobileLayout.reset.height >= 44);
    assert.ok(mobileLayout.panel.left >= 0 && mobileLayout.panel.right <= mobileLayout.viewportWidth);

    const touchPage = await browser.newPage();
    await touchPage.setViewport({ width: 390, height: 844, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const touchErrors = [];
    touchPage.on('pageerror', error => touchErrors.push(error.message));
    await touchPage.goto(`${origin}/?touch=${Date.now()}#${code}`, {
        waitUntil: 'domcontentloaded', timeout: 120_000,
    });
    await touchPage.waitForFunction(() => {
        const button = document.getElementById('generate');
        return button && !button.disabled
            && document.getElementById('buildOverlay')?.classList.contains('hidden');
    }, { timeout: 120_000 });
    await touchPage.evaluate(() => {
        for (const id of ['tutorialOverlay', 'whatsNewOverlay', 'surveyOverlay']) {
            document.getElementById(id)?.classList.add('hidden');
        }
    });
    const centerOf = async selector => touchPage.$eval(selector, el => {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    let point = await centerOf('#editToggle');
    await touchPage.touchscreen.tap(point.x, point.y);
    await touchPage.waitForFunction(() => !document.getElementById('editTools').hidden);
    point = await centerOf('[data-edit-tool="motion"]');
    await touchPage.touchscreen.tap(point.x, point.y);
    point = await centerOf('#canvas');
    await touchPage.touchscreen.tap(point.x, point.y);
    await touchPage.waitForFunction(async () => {
        const { state } = await import('/js/state.js');
        return state.isTouchDevice && state.selectedMotionPlate >= 0;
    });
    const touchTargets = await touchPage.evaluate(() => {
        const size = selector => {
            const r = document.querySelector(selector).getBoundingClientRect();
            return { width: r.width, height: r.height };
        };
        return {
            edit: size('#editToggle'),
            land: size('[data-edit-tool="land"]'),
            motion: size('[data-edit-tool="motion"]'),
            reset: size('#motionReset'),
        };
    });
    for (const target of Object.values(touchTargets)) {
        assert.ok(target.width >= 44 && target.height >= 44, JSON.stringify(touchTargets));
    }
    assert.deepEqual(touchErrors, []);
    await touchPage.close();

    assert.deepEqual(pageErrors, []);
    console.log('SP6 editor browser smoke passed');
} finally {
    await browser.close();
}

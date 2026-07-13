/**
 * Terrain Lab evaluation at the performance reference resolution (~299K).
 *
 * Runs all four flag combinations twice, records worker stage timings and
 * terrain/drainage statistics, and saves one screenshot per combination.
 * The JSON and PNG outputs live in existing ignored tuning artifact folders.
 *
 *   node tuning/terrain-lab-evaluation.mjs
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const RESULT_PATH = path.join(__dirname, 'results', 'terrain-lab-299k.json');
const SHOT_DIR = path.join(__dirname, 'scale-invariance-screenshots');
const ORIGIN_PATH = '/?terrainLab=1&evaluation=299k';

const CASES = [
    { name: 'neither', morenoiseEnabled: false, runevisionEnabled: false },
    { name: 'morenoise', morenoiseEnabled: true, runevisionEnabled: false },
    { name: 'runevision', morenoiseEnabled: false, runevisionEnabled: true },
    { name: 'both', morenoiseEnabled: true, runevisionEnabled: true },
];

const MIME = {
    '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript',
    '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
    '.svg': 'image/svg+xml', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

function startServer() {
    return new Promise(resolve => {
        const server = http.createServer((req, res) => {
            let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
            if (urlPath === '/') urlPath = '/index.html';
            const filePath = path.join(PROJECT_ROOT, urlPath);
            if (!filePath.startsWith(PROJECT_ROOT)) { res.writeHead(403); res.end(); return; }
            fs.readFile(filePath, (error, data) => {
                if (error) { res.writeHead(404); res.end('Not found'); return; }
                res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
                res.end(data);
            });
        });
        server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
    });
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = sorted.length >> 1;
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function stageMs(run, prefix) {
    return run.postTiming.find(row => row.stage.startsWith(prefix))?.ms ?? 0;
}

function summarizeTimings(runs) {
    const stageNames = new Set(runs.flatMap(run => run.postTiming.map(row => row.stage)));
    const stages = {};
    for (const stage of stageNames) {
        stages[stage] = +median(runs.map(run =>
            run.postTiming.find(row => row.stage === stage)?.ms ?? 0)).toFixed(2);
    }
    return {
        postTotalMs: +median(runs.map(run => run.postTiming.reduce((sum, row) => sum + row.ms, 0))).toFixed(2),
        workerTotalMs: +median(runs.map(run => run.workerTotalMs)).toFixed(2),
        stages,
    };
}

async function waitForGeneration(page) {
    await page.waitForFunction(async () => {
        const { state } = await import('/js/state.js');
        const button = document.getElementById('generate');
        return state.curData && button && !button.disabled;
    }, { timeout: 600_000, polling: 200 });
}

async function runCase(page, testCase, takeScreenshot) {
    const result = await page.evaluate(async flags => {
        const { state } = await import('/js/state.js');
        const { generate } = await import('/js/generate.js');
        const detail = document.getElementById('sN');
        detail.value = '649'; // detailFromSlider(649) = 299,000
        detail.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('ffMorenoise').checked = flags.morenoiseEnabled;
        document.getElementById('ffRunevision').checked = flags.runevisionEnabled;
        const recordStart = window.__terrainLabEvaluationRecords.length;

        await new Promise((resolve, reject) => {
            const button = document.getElementById('generate');
            const timeout = setTimeout(() => reject(new Error(`generation timeout: ${flags.name}`)), 600_000);
            button.addEventListener('generate-done', () => {
                clearTimeout(timeout);
                resolve();
            }, { once: true });
            generate(424242, [], () => {}, true, [], flags.morenoiseEnabled, flags.runevisionEnabled);
        });

        const record = window.__terrainLabEvaluationRecords.slice(recordStart).at(-1);
        if (!record) throw new Error(`missing worker timing record: ${flags.name}`);
        const data = state.curData;
        const { mesh, r_xyz, r_elevation, riverDrainTarget, riverFlow } = data;
        const delta = data.debugLayers?.runevisionDelta ?? null;
        const rvSlope = data.debugLayers?.runevisionSlope ?? null;
        const N = mesh.numRegions;
        const radiusKm = 6371;
        const physical = new Float32Array(N);
        const slopes = [];
        const landHeights = [];
        let pitCount = 0;

        for (let r = 0; r < N; r++) {
            const elevation = r_elevation[r];
            if (elevation <= 0) continue;
            const t2 = elevation * elevation;
            const height = 6 * t2 * t2 * (5 - 4 * elevation);
            physical[r] = height;
            landHeights.push(height);
        }
        for (let r = 0; r < N; r++) {
            if (r_elevation[r] <= 0) continue;
            let maxSlope = 0;
            let hasLower = false;
            for (let i = mesh.adjOffset[r]; i < mesh.adjOffset[r + 1]; i++) {
                const nb = mesh.adjList[i];
                if (r_elevation[nb] < r_elevation[r] - 1e-8) hasLower = true;
                if (r_elevation[nb] <= 0) continue;
                const dx = r_xyz[3 * nb] - r_xyz[3 * r];
                const dy = r_xyz[3 * nb + 1] - r_xyz[3 * r + 1];
                const dz = r_xyz[3 * nb + 2] - r_xyz[3 * r + 2];
                const distanceKm = Math.hypot(dx, dy, dz) * radiusKm;
                if (distanceKm > 0) {
                    maxSlope = Math.max(maxSlope, Math.abs(physical[nb] - physical[r]) / distanceKm);
                }
            }
            slopes.push(maxSlope);
            if (!hasLower) pitCount++;
        }

        const percentile = (values, p) => {
            if (values.length === 0) return 0;
            values.sort((a, b) => a - b);
            return values[Math.min(values.length - 1, Math.floor(p * values.length))];
        };
        const landSorted = [...landHeights];
        const slopeSorted = [...slopes];
        const reliefP50Km = percentile(landSorted, 0.5);
        const reliefP95Km = percentile(landSorted, 0.95);

        // Strahler order over the final drain graph.
        const upstreamRemaining = new Int32Array(N);
        for (let r = 0; r < N; r++) {
            const target = riverDrainTarget[r];
            if (target >= 0 && target < N && target !== r) upstreamRemaining[target]++;
        }
        const order = new Uint16Array(N);
        const upstreamMax = new Uint16Array(N);
        const upstreamMaxCount = new Uint8Array(N);
        const queue = new Int32Array(N);
        let head = 0, tail = 0;
        for (let r = 0; r < N; r++) {
            if (upstreamRemaining[r] === 0) { order[r] = 1; queue[tail++] = r; }
        }
        while (head < tail) {
            const r = queue[head++];
            const target = riverDrainTarget[r];
            if (target < 0 || target >= N || target === r) continue;
            if (order[r] > upstreamMax[target]) {
                upstreamMax[target] = order[r];
                upstreamMaxCount[target] = 1;
            } else if (order[r] === upstreamMax[target]) {
                upstreamMaxCount[target]++;
            }
            if (--upstreamRemaining[target] === 0) {
                order[target] = upstreamMax[target] + (upstreamMaxCount[target] >= 2 ? 1 : 0);
                queue[tail++] = target;
            }
        }

        const positiveFlow = [];
        for (let r = 0; r < N; r++) {
            if (r_elevation[r] > 0 && riverFlow[r] > 0) positiveFlow.push(riverFlow[r]);
        }
        const flowThreshold = percentile(positiveFlow, 0.9);
        let riverCells = 0, orderSum = 0, orderMax = 0;
        let corrN = 0, sumX = 0, sumY = 0, sumXX = 0, sumYY = 0, sumXY = 0;
        for (let r = 0; r < N; r++) {
            if (r_elevation[r] <= 0 || riverFlow[r] < flowThreshold) continue;
            riverCells++;
            orderSum += order[r];
            orderMax = Math.max(orderMax, order[r]);
            if (delta) {
                const x = Math.log1p(Math.max(0, riverFlow[r]));
                const y = -delta[r];
                corrN++; sumX += x; sumY += y; sumXX += x * x; sumYY += y * y; sumXY += x * y;
            }
        }
        const covariance = corrN * sumXY - sumX * sumY;
        const variance = Math.sqrt(Math.max(0, corrN * sumXX - sumX * sumX) *
            Math.max(0, corrN * sumYY - sumY * sumY));
        const riverGullyCorrelation = variance > 0 ? covariance / variance : null;

        let rvSlopeMean = null, rvSlopeP95 = null;
        if (rvSlope) {
            const values = [];
            let sum = 0;
            for (let r = 0; r < N; r++) {
                if (r_elevation[r] > 0) { values.push(rvSlope[r]); sum += rvSlope[r]; }
            }
            rvSlopeMean = values.length ? sum / values.length : 0;
            rvSlopeP95 = percentile(values, 0.95);
        }

        return {
            flags,
            regions: N,
            params: record.params,
            postTiming: record.postTiming,
            workerTotalMs: record.workerTotalMs,
            stats: {
                landCells: landHeights.length,
                reliefP50Km, reliefP95Km, reliefP95MinusP50Km: reliefP95Km - reliefP50Km,
                slopeMean: slopes.reduce((sum, value) => sum + value, 0) / Math.max(1, slopes.length),
                slopeP95: percentile(slopeSorted, 0.95),
                pitCount,
                riverCells,
                riverStrahlerMean: riverCells ? orderSum / riverCells : 0,
                riverStrahlerMax: orderMax,
                riverGullyCorrelation,
                runevisionSlopeMean: rvSlopeMean,
                runevisionSlopeP95: rvSlopeP95,
                unresolvedDrainCells: N - tail,
            },
        };
    }, testCase);

    if (takeScreenshot) {
        const canvas = await page.$('#canvas');
        if (canvas) await canvas.screenshot({
            path: path.join(SHOT_DIR, `terrain-lab-299k-${testCase.name}.png`),
        });
    }
    return result;
}

async function main() {
    fs.mkdirSync(path.dirname(RESULT_PATH), { recursive: true });
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const { server, port } = await startServer();
    const browser = await puppeteer.launch({
        headless: true,
        protocolTimeout: 600_000,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl',
            '--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader'],
    });
    try {
        const page = await browser.newPage();
        await page.setViewport({ width: 1200, height: 900 });
        const pageErrors = [];
        page.on('pageerror', error => pageErrors.push(error.message));
        await page.evaluateOnNewDocument(() => {
            window.__terrainLabEvaluationRecords = [];
            const NativeWorker = window.Worker;
            window.Worker = class EvaluationWorker extends NativeWorker {
                constructor(...args) {
                    super(...args);
                    this.addEventListener('message', event => {
                        const data = event.data;
                        if (data?.type === 'done' && data?._postTiming) {
                            window.__terrainLabEvaluationRecords.push({
                                params: data._params,
                                postTiming: data._postTiming,
                                workerTotalMs: data._workerTotal,
                            });
                        }
                    });
                }
                postMessage(message, ...rest) {
                    if (message?.cmd === 'generate') message.skipClimate = true;
                    return super.postMessage(message, ...rest);
                }
            };
            const setFastStartup = () => {
                const detail = document.getElementById('sN');
                if (detail) detail.value = '0';
            };
            new MutationObserver(setFastStartup).observe(document, { childList: true, subtree: true });
        });
        await page.goto(`http://127.0.0.1:${port}${ORIGIN_PATH}`,
            { waitUntil: 'domcontentloaded', timeout: 120_000 });
        await waitForGeneration(page);
        await page.click('#sidebarToggle').catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 500));

        const raw = Object.fromEntries(CASES.map(testCase => [testCase.name, []]));
        for (let round = 0; round < 2; round++) {
            for (const testCase of CASES) {
                console.log(`Generating ${testCase.name}, round ${round + 1} @ ~299K...`);
                raw[testCase.name].push(await runCase(page, testCase, round === 0));
            }
        }
        if (pageErrors.length) throw new Error(`page errors: ${pageErrors.join('; ')}`);

        const cases = {};
        for (const testCase of CASES) {
            const runs = raw[testCase.name];
            cases[testCase.name] = {
                flags: testCase,
                timings: summarizeTimings(runs),
                stats: runs[0].stats,
                runs: runs.map(run => ({
                    postTotalMs: +run.postTiming.reduce((sum, row) => sum + row.ms, 0).toFixed(2),
                    workerTotalMs: +run.workerTotalMs.toFixed(2),
                })),
            };
        }

        const morenoiseRatio = cases.morenoise.timings.postTotalMs / cases.neither.timings.postTotalMs;
        const runevisionMs = median(raw.runevision.map(run => stageMs(run, 'Runevision gullies')));
        const compositeMs = median(raw.runevision.map(run => stageMs(run, 'Erosion composite')));
        const report = {
            generatedAt: new Date().toISOString(),
            resolution: 299001,
            cases,
            guardrails: {
                morenoisePostRatio: +morenoiseRatio.toFixed(4),
                morenoiseAtMost115Percent: morenoiseRatio <= 1.15,
                runevisionMs: +runevisionMs.toFixed(2),
                compositeErosionMs: +compositeMs.toFixed(2),
                runevisionNoSlowerThanComposite: runevisionMs <= compositeMs,
            },
        };
        fs.writeFileSync(RESULT_PATH, `${JSON.stringify(report, null, 2)}\n`);
        console.log(JSON.stringify(report.guardrails, null, 2));
        console.log(`Results: ${path.relative(PROJECT_ROOT, RESULT_PATH)}`);
        if (!report.guardrails.morenoiseAtMost115Percent ||
            !report.guardrails.runevisionNoSlowerThanComposite) process.exitCode = 1;
        await page.close();
    } finally {
        await browser.close();
        server.close();
    }
}

main().catch(error => { console.error(error); process.exit(1); });

/**
 * Cross-resolution scale-invariance harness for World Orogen (SP2).
 *
 * Generates the SAME seed across a Detail ladder and measures how much the
 * terrain-metrics scorecard drifts with resolution. Scale-invariant code
 * should produce near-identical metric values at every rung.
 *
 *   node tuning/scale-invariance.mjs --baseline   # record pre-fix divergence
 *   node tuning/scale-invariance.mjs              # report current vs baseline
 *   node tuning/scale-invariance.mjs --check      # exit 1 unless gated metrics
 *                                                 # improved by IMPROVE_FACTOR
 *
 * Metric groups:
 *   GATE     — land-erosion/smoothing-sensitive, resolution-independent by
 *              intent; these carry the pass/fail signal.
 *   CONTROL  — quantities that are already ~resolution-invariant (land
 *              fraction, ocean-floor stats untouched by land-only erosion).
 *              Their spread defines the achievable noise floor.
 *   RECORDED — everything else in the scorecard, reported but ungated
 *              (e.g. coast_complexity_index legitimately rises with
 *              resolution — Richardson effect — so it must not gate).
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(__dirname, 'scale-invariance-baseline.json');
const SHOT_DIR = path.join(__dirname, 'scale-invariance-screenshots');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const MODE = process.argv.includes('--baseline') ? 'baseline'
           : process.argv.includes('--check') ? 'check'
           : 'report';

// Regression tripwire, not an improvement gate. Investigation (SP2 Task 5)
// found these scalar metrics do not isolate the erosion-intensity axis the
// fixes correct — they are dominated by mesh-sampling effects (the pre-fix
// GATE already sat below the CONTROL noise floor) — and that generation is
// mildly non-deterministic run-to-run. So --check only flags a GROSS
// divergence blowup: current must stay within 1.5x the recorded baseline.
const IMPROVE_FACTOR = 1.5;

// Relative divergence (max-min)/|mean| is only meaningful when the metric's
// mean is well clear of zero. A near-zero-mean quantity — e.g.
// erosion_slope_correlation in the zero-erosion seed, where erosion is off —
// makes the ratio explode on pure measurement noise and carries no
// scale-invariance signal, so we exclude it. Every valid GATE/CONTROL metric
// here has |mean| >= 0.16; the artifact sits at ~0.004, so 0.05 separates them.
const MIN_MEAN_MAGNITUDE = 0.05;

// Detail ladder: slider positions -> ~5K / 31K / 100K / 299K / 801K regions.
// All below AUTO_CLIMATE_THRESHOLD; climate is skipped via skipClimate anyway.
// The 801K rung exercises the >300K range where the SP2 fixes actually bite.
const LADDER = [
  { pos: 0,   approxN: 5000 },
  { pos: 400, approxN: 31000 },
  { pos: 518, approxN: 100000 },
  { pos: 649, approxN: 299000 },
  { pos: 792, approxN: 801000 },
];

// Seeds: defaults (erosion at default sliders), high-erosion (maximizes the
// defect), zero-erosion (isolates the smoothing fixes from the erosion fixes).
const SEEDS = [
  { name: 'defaults',     seed: 42,  sliders: {} },
  { name: 'high-erosion', seed: 300, sliders: { sGl: 0.8, sHEr: 0.8, sTEr: 0.8 } },
  { name: 'zero-erosion', seed: 500, sliders: { sGl: 0, sHEr: 0, sTEr: 0 } },
];

// Land-erosion/smoothing-sensitive, resolution-independent by intent.
const GATE_KEYS = [
  'relief_headroom', 'peak_clustering', 'hypsometry_trough_depth',
  'land_mode_elev', 'erosion_slope_correlation',
];
// Already ~invariant: land fraction (computed below) + ocean-floor stats
// (erosion is land-only; smoothElevation locks coasts).
const CONTROL_KEYS = ['land_fraction', 'ocean_mode_elev', 'ocean_elev_stddev'];

const MIME = {
  '.html':'text/html', '.js':'application/javascript', '.mjs':'application/javascript',
  '.css':'text/css', '.json':'application/json', '.png':'image/png', '.svg':'image/svg+xml',
  '.ico':'image/x-icon', '.woff':'font/woff', '.woff2':'font/woff2',
  '.webmanifest':'application/manifest+json', '.txt':'text/plain', '.xml':'application/xml', '.wasm':'application/wasm',
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
      const filePath = path.join(PROJECT_ROOT, urlPath);
      if (!filePath.startsWith(PROJECT_ROOT)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
        res.end(data);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function generateAndMeasure(browser, baseUrl, sc, rung) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1200, height: 900 });
    page.on('dialog', (d) => d.dismiss());
    page.on('pageerror', (e) => console.log(`  [PAGE EXCEPTION] ${e.message}`));
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    // The app auto-fires a default-slider generation on load (main.js) that
    // disables #generate until it completes. Wait for that to finish before
    // driving our own run, or our click no-ops and we measure the auto-gen.
    await page.waitForFunction(
      () => window.__terrainMetrics != null && !document.getElementById('generate').disabled,
      { timeout: 600_000, polling: 250 },
    );

    await page.evaluate(() => {
      for (const id of ['tutorialOverlay', 'whatsNewOverlay']) {
        const el = document.getElementById(id); if (el) el.style.display = 'none';
      }
    });

    const setSlider = (id, value) => page.evaluate(({ id, value }) => {
      const el = document.getElementById(id); el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, { id, value: String(value) });

    await setSlider('sN', rung.pos);
    for (const [id, val] of Object.entries(sc.sliders)) await setSlider(id, val);

    // Inject fixed seed + request metrics + skip climate (not needed for
    // terrain metrics; keeps the 299K rung fast).
    await page.evaluate((seed) => {
      const orig = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (msg, ...rest) {
        if (msg && msg.cmd === 'generate' && msg.seed === undefined) {
          msg.seed = Number(seed);
          msg.computeMetrics = true;
          msg.skipClimate = true;
        }
        return orig.call(this, msg, ...rest);
      };
    }, sc.seed);

    const done = page.evaluate((timeout) => new Promise((resolve, reject) => {
      const btn = document.getElementById('generate');
      const timer = setTimeout(() => reject(new Error('gen timeout')), timeout);
      btn.addEventListener('generate-done', () => { clearTimeout(timer); resolve(); }, { once: true });
    }), 600_000);
    await new Promise((r) => setTimeout(r, 100));
    await page.evaluate(() => { window.__terrainMetrics = null; });
    await page.click('#generate');
    await done;
    await new Promise((r) => setTimeout(r, 500));

    const metrics = await page.evaluate(() => window.__terrainMetrics);
    if (!metrics || metrics._error) {
      throw new Error(`no metrics for ${sc.name}@${rung.pos}: ${metrics && metrics._error}`);
    }
    // Derived control: land fraction (land_cells is a raw count ∝ N).
    metrics.land_fraction = metrics.land_cells / (rung.approxN + 1);

    // Advisory screenshot for the visual A/B grid (sidebar collapsed first).
    await page.click('#sidebarToggle').catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
    const canvas = await page.$('#canvas');
    if (canvas) {
      await canvas.screenshot({ path: path.join(SHOT_DIR, `${sc.name}_pos${rung.pos}.png`) }).catch(() => {});
    }
    return metrics;
  } finally {
    await page.close().catch(() => {});
  }
}

// Normalized spread of one metric across the ladder.
function divergence(values) {
  const nums = values.filter((v) => Number.isFinite(v));
  if (nums.length < 2) return null;
  const mean = nums.reduce((s, v) => s + v, 0) / nums.length;
  if (Math.abs(mean) < MIN_MEAN_MAGNITUDE) return null;
  return (Math.max(...nums) - Math.min(...nums)) / (Math.abs(mean) + 1e-9);
}

async function main() {
  const { server, port } = await startServer();
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-webgl',
           '--use-gl=angle', '--use-angle=swiftshader-webgl', '--enable-unsafe-swiftshader'],
  });

  const perSeed = {};
  try {
    for (const sc of SEEDS) {
      const rows = [];
      for (const rung of LADDER) {
        console.log(`Generating ${sc.name} @ slider ${rung.pos} (~${rung.approxN.toLocaleString()} regions)...`);
        rows.push(await generateAndMeasure(browser, `http://127.0.0.1:${port}`, sc, rung));
      }
      // Divergence per metric key present in all rungs.
      const allKeys = new Set(rows.flatMap((r) => Object.keys(r)));
      const D = {};
      for (const k of allKeys) {
        if (k.startsWith('_')) continue;
        const d = divergence(rows.map((r) => r[k]));
        if (d !== null) D[k] = +d.toFixed(4);
      }
      perSeed[sc.name] = { D, rows };
    }
  } finally {
    await browser.close();
    server.close();
  }

  const agg = (keys) => {
    const vals = [];
    for (const sc of SEEDS) {
      for (const k of keys) {
        const d = perSeed[sc.name].D[k];
        if (Number.isFinite(d)) vals.push(d);
      }
    }
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  };
  const gateAgg = agg(GATE_KEYS);
  const controlAgg = agg(CONTROL_KEYS);

  console.log('\n=== Divergence across the Detail ladder (0 = perfectly scale-invariant) ===');
  for (const sc of SEEDS) {
    console.log(`\n[${sc.name}]`);
    for (const k of [...GATE_KEYS, ...CONTROL_KEYS]) {
      const tag = GATE_KEYS.includes(k) ? 'GATE   ' : 'CONTROL';
      console.log(`  ${tag} ${k}: ${perSeed[sc.name].D[k] ?? 'n/a'}`);
    }
  }
  console.log(`\nGATE aggregate:    ${gateAgg?.toFixed(4)}`);
  console.log(`CONTROL aggregate: ${controlAgg?.toFixed(4)} (noise floor)`);

  if (MODE === 'baseline') {
    fs.writeFileSync(BASELINE_PATH, JSON.stringify({ gateAgg, controlAgg, perSeed }, null, 2));
    console.log(`\nBaseline written to ${path.relative(PROJECT_ROOT, BASELINE_PATH)}`);
    return;
  }

  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  console.log(`\nBaseline GATE aggregate: ${baseline.gateAgg?.toFixed(4)}  ->  current: ${gateAgg?.toFixed(4)}`);
  const target = baseline.gateAgg * IMPROVE_FACTOR;
  const pass = gateAgg <= target;
  console.log(pass
    ? `PASS: ${gateAgg.toFixed(4)} <= ${target.toFixed(4)} (${IMPROVE_FACTOR} x baseline)`
    : `FAIL: ${gateAgg.toFixed(4)} > ${target.toFixed(4)} (${IMPROVE_FACTOR} x baseline)`);
  if (MODE === 'check' && !pass) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });

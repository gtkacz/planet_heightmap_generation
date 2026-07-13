import test from 'node:test';
import assert from 'node:assert/strict';

import { computeNeighborDist } from '../js/sphere-mesh.js';
import {
    applyRunevisionErosion,
    rawElevationToKm,
    runevisionKmToElevation,
} from '../js/runevision-erosion.js';

const RADIUS_KM = 6371;

function makePatch(rows, cols, spacingKm, heightFn, { lat0 = 0, lon0 = 0, oceanFn = null } = {}) {
    const N = rows * cols;
    const xyz = new Float32Array(N * 3);
    const elevation = new Float32Array(N);
    const ocean = new Uint8Array(N);
    const lists = Array.from({ length: N }, () => []);
    const rowMid = (rows - 1) / 2;
    const colMid = (cols - 1) / 2;
    for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
            const r = row * cols + col;
            const northKm = (row - rowMid) * spacingKm;
            const eastKm = (col - colMid) * spacingKm;
            const lat = lat0 + northKm / RADIUS_KM;
            const lon = lon0 + eastKm / (RADIUS_KM * Math.max(0.01, Math.cos(lat0)));
            const cosLat = Math.cos(lat);
            xyz[3 * r] = Math.sin(lon) * cosLat;
            xyz[3 * r + 1] = Math.sin(lat);
            xyz[3 * r + 2] = Math.cos(lon) * cosLat;
            if (oceanFn && oceanFn(eastKm, northKm, row, col)) {
                ocean[r] = 1;
                elevation[r] = -0.2;
            } else {
                elevation[r] = runevisionKmToElevation(heightFn(eastKm, northKm, row, col));
            }
            if (row > 0) lists[r].push((row - 1) * cols + col);
            if (row + 1 < rows) lists[r].push((row + 1) * cols + col);
            if (col > 0) lists[r].push(row * cols + col - 1);
            if (col + 1 < cols) lists[r].push(row * cols + col + 1);
        }
    }
    const adjOffset = new Int32Array(N + 1);
    for (let r = 0; r < N; r++) adjOffset[r + 1] = adjOffset[r] + lists[r].length;
    const adjList = new Int32Array(adjOffset[N]);
    for (let r = 0; r < N; r++) adjList.set(lists[r], adjOffset[r]);
    const mesh = { numRegions: N, adjOffset, adjList };
    return { mesh, xyz, elevation, ocean, rows, cols, neighborDist: computeNeighborDist(mesh, xyz) };
}

function apply(field, seed = 42, options = {}) {
    return applyRunevisionErosion(field.mesh, field.xyz, field.neighborDist,
        field.elevation, field.ocean, seed, {
            strengthKm: 0.1,
            baseWavelengthKm: 120,
            octaves: 4,
            slopeReference: 0.01,
            pretendSlope: 0.01,
            fadeLowKm: 0.25,
            fadeHighKm: 2,
            ...options,
        });
}

test('Runevision km/raw inverse round-trips physical land heights', () => {
    for (const km of [0.0001, 0.05, 0.25, 1, 3.5, 5.999]) {
        const raw = runevisionKmToElevation(km);
        assert.ok(Math.abs(rawElevationToKm(raw) - km) < 2e-6, `round-trip failed at ${km} km`);
    }
});

test('flat field has zero slope and no arbitrary directional gullies', () => {
    const field = makePatch(9, 9, 15, () => 1);
    const before = new Float32Array(field.elevation);
    const { runevisionDelta, runevisionSlope } = apply(field);
    assert.deepEqual(field.elevation, before);
    assert.ok(runevisionDelta.every(value => value === 0));
    assert.ok(runevisionSlope.every(value => value === 0));
});

test('planar ramp produces continuous gullies parallel to downhill', () => {
    const field = makePatch(9, 9, 15, eastKm => 1 + eastKm * 0.01);
    const { runevisionDelta, runevisionSlope } = apply(field);
    const center = 4 * field.cols + 4;
    assert.ok(Math.abs(runevisionSlope[center] - 0.01) < 3e-4);
    assert.ok(runevisionDelta.some(value => Math.abs(value) > 1e-5));
    let eastVariation = 0, northVariation = 0, samples = 0;
    for (let row = 2; row < 7; row++) {
        for (let col = 2; col < 7; col++) {
            const r = row * field.cols + col;
            eastVariation += Math.abs(runevisionDelta[r + 1] - runevisionDelta[r - 1]);
            northVariation += Math.abs(runevisionDelta[r + field.cols] - runevisionDelta[r - field.cols]);
            samples++;
        }
    }
    assert.ok(Number.isFinite(eastVariation + northVariation));
    assert.ok(northVariation > eastVariation * 1.05,
        `expected downhill-parallel stripes: north=${northVariation / samples}, east=${eastVariation / samples}`);
});

test('isolated hill develops finite radial gully variation', () => {
    const field = makePatch(13, 13, 12, (eastKm, northKm) =>
        0.5 + 2.2 * Math.exp(-(eastKm * eastKm + northKm * northKm) / (2 * 42 * 42)));
    const { runevisionDelta, runevisionSlope } = apply(field, 77);
    let active = 0, positive = 0, negative = 0;
    for (let row = 2; row < 11; row++) {
        for (let col = 2; col < 11; col++) {
            const r = row * field.cols + col;
            assert.ok(Number.isFinite(field.elevation[r]));
            assert.ok(Number.isFinite(runevisionSlope[r]));
            const d = runevisionDelta[r];
            if (Math.abs(d) > 1e-5) active++;
            if (d > 1e-5) positive++;
            if (d < -1e-5) negative++;
        }
    }
    assert.ok(active > 30);
    assert.ok(positive > 5 && negative > 5, 'radial field should contain both ridges and gullies');
});

test('3D lattice stays continuous across the dateline and finite near a pole', () => {
    const height = (eastKm, northKm) => 1.2 + eastKm * 0.004 + northKm * 0.003;
    const west = makePatch(7, 7, 10, height, { lon0: Math.PI });
    const east = makePatch(7, 7, 10, height, { lon0: -Math.PI });
    const pole = makePatch(7, 7, 4, height, { lat0: 88.5 * Math.PI / 180, lon0: Math.PI });
    const a = apply(west, 99);
    const b = apply(east, 99);
    const p = apply(pole, 99);
    for (let i = 0; i < a.runevisionDelta.length; i++) {
        assert.ok(Math.abs(a.runevisionDelta[i] - b.runevisionDelta[i]) < 2e-5,
            `dateline mismatch at ${i}`);
    }
    assert.ok(p.runevisionDelta.every(Number.isFinite));
    assert.ok(p.runevisionSlope.every(Number.isFinite));
});

test('reversing region evaluation order is byte-identical', () => {
    const height = (eastKm, northKm) => 1 + eastKm * 0.006 + northKm * 0.002;
    const forward = makePatch(9, 9, 12, height);
    const reverse = makePatch(9, 9, 12, height);
    const order = Array.from({ length: reverse.mesh.numRegions }, (_, i) => reverse.mesh.numRegions - 1 - i);
    const a = apply(forward, 123);
    const b = apply(reverse, 123, { regionOrder: order });
    assert.deepEqual(forward.elevation, reverse.elevation);
    assert.deepEqual(a.runevisionDelta, b.runevisionDelta);
    assert.deepEqual(a.runevisionSlope, b.runevisionSlope);
});

test('ocean and the first coastal land ring stay locked', () => {
    const field = makePatch(9, 9, 12, (eastKm, northKm) => 0.8 + northKm * 0.002, {
        oceanFn: (_east, _north, _row, col) => col === 0,
    });
    const before = new Float32Array(field.elevation);
    apply(field, 321);
    for (let row = 0; row < field.rows; row++) {
        const ocean = row * field.cols;
        const coast = ocean + 1;
        assert.equal(field.elevation[ocean], before[ocean]);
        assert.equal(field.elevation[coast], before[coast]);
    }
    for (let r = 0; r < field.elevation.length; r++) {
        assert.equal(field.elevation[r] <= 0, field.ocean[r] === 1, `classification changed at ${r}`);
    }
});

test('hotspot damping and the orogenic floor attenuate the effect', () => {
    const height = eastKm => 1 + eastKm * 0.006;
    const normal = makePatch(9, 9, 12, height);
    const damped = makePatch(9, 9, 12, height);
    const count = normal.mesh.numRegions;
    const a = apply(normal, 222);
    const b = apply(damped, 222, {
        hotspotField: new Float32Array(count).fill(1),
        orogenicField: new Float32Array(count),
    });
    const magnitude = arr => arr.reduce((sum, value) => sum + Math.abs(value), 0);
    assert.ok(magnitude(b.runevisionDelta) < magnitude(a.runevisionDelta) * 0.15);
});

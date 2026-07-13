import test from 'node:test';
import assert from 'node:assert/strict';

import { SimplexNoise } from '../js/simplex-noise.js';

const SAMPLE_POINTS = [
    [0.125, -0.75, 1.5],
    // Keep samples off exact simplex rank boundaries; the value is continuous
    // there, but the piecewise analytical derivative need not equal a central
    // difference that straddles two tetrahedra.
    [-2.247, 0.333, 4.75],
    [8.125, -3.5, -1.25],
    [0.001, 0.002, 0.003],
];

test('noise3DWithDerivatives preserves existing simplex values', () => {
    const noise = new SimplexNoise(12345);
    const out = new Float64Array(4);
    for (const [x, y, z] of SAMPLE_POINTS) {
        const returned = noise.noise3DWithDerivatives(x, y, z, out);
        assert.equal(returned, out, 'fills and returns the caller-owned buffer');
        assert.ok(Math.abs(out[0] - noise.noise3D(x, y, z)) < 1e-12,
            `value mismatch at ${x}, ${y}, ${z}`);
    }
});

test('analytical simplex derivatives match central differences', () => {
    const noise = new SimplexNoise(9876);
    const out = new Float64Array(4);
    const h = 1e-5;
    for (const [x, y, z] of SAMPLE_POINTS) {
        noise.noise3DWithDerivatives(x, y, z, out);
        const dx = (noise.noise3D(x + h, y, z) - noise.noise3D(x - h, y, z)) / (2 * h);
        const dy = (noise.noise3D(x, y + h, z) - noise.noise3D(x, y - h, z)) / (2 * h);
        const dz = (noise.noise3D(x, y, z + h) - noise.noise3D(x, y, z - h)) / (2 * h);
        assert.ok(Math.abs(out[1] - dx) < 2e-5, `dx mismatch at ${x}, ${y}, ${z}`);
        assert.ok(Math.abs(out[2] - dy) < 2e-5, `dy mismatch at ${x}, ${y}, ${z}`);
        assert.ok(Math.abs(out[3] - dz) < 2e-5, `dz mismatch at ${x}, ${y}, ${z}`);
    }
});

test('erosiveFbm with zero gradient strength matches ordinary fbm', () => {
    const noise = new SimplexNoise(2468);
    for (const [x, y, z] of SAMPLE_POINTS) {
        const nx = x || 1, ny = y, nz = z;
        const invLen = 1 / Math.hypot(nx, ny, nz);
        const erosive = noise.erosiveFbm(
            x, y, z,
            nx * invLen, ny * invLen, nz * invLen,
            5, 2 / 3, 0,
        );
        assert.ok(Math.abs(erosive - noise.fbm(x, y, z, 5, 2 / 3)) < 1e-12);
    }
});

test('erosiveFbm is deterministic, finite, and visibly derivative-suppressed', () => {
    const noise = new SimplexNoise(1357);
    const args = [2.7, -1.2, 4.4, 0.4, -0.2, 0.8944271909999159, 6, 2 / 3, 1];
    const first = noise.erosiveFbm(...args);
    const second = noise.erosiveFbm(...args);
    assert.equal(first, second);
    assert.ok(Number.isFinite(first));
    assert.notEqual(first, noise.fbm(args[0], args[1], args[2], args[6], args[7]));
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { applyDetailNoise } from '../js/terrain-post.js';

function sampleInput() {
    const points = [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
        [-Math.SQRT1_2, 0, Math.SQRT1_2],
        [0.3, -0.4, Math.sqrt(0.75)],
    ];
    return {
        mesh: { numRegions: points.length },
        xyz: new Float32Array(points.flat()),
        elevation: new Float32Array([0.25, 0.4, 0.55, 0.7, 0.85]),
        ocean: new Uint8Array(points.length),
    };
}

test('explicit classic detail mode is byte-identical to the legacy default', () => {
    const a = sampleInput();
    const b = sampleInput();
    applyDetailNoise(a.mesh, a.xyz, a.elevation, a.ocean, 42);
    applyDetailNoise(b.mesh, b.xyz, b.elevation, b.ocean, 42, { fbmMode: 'classic' });
    assert.deepEqual(a.elevation, b.elevation);
});

test('Morenoise detail mode is deterministic, finite, and distinct', () => {
    const classic = sampleInput();
    const first = sampleInput();
    const second = sampleInput();
    applyDetailNoise(classic.mesh, classic.xyz, classic.elevation, classic.ocean, 42);
    applyDetailNoise(first.mesh, first.xyz, first.elevation, first.ocean, 42, { fbmMode: 'morenoise' });
    applyDetailNoise(second.mesh, second.xyz, second.elevation, second.ocean, 42, { fbmMode: 'morenoise' });
    assert.deepEqual(first.elevation, second.elevation);
    assert.notDeepEqual(first.elevation, classic.elevation);
    for (const value of first.elevation) assert.ok(Number.isFinite(value));
});

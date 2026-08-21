// The derived link grid, checked against the manual's rules and against the
// capture from the real Aquilon C.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildLinkGrid,
  deriveLinkGrid,
  capacityToLinks,
  LINKS_PER_VPU,
  SCALING_ENGINE_BOUNDARY,
} from '../public/vpu.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const snapshot = JSON.parse(
  fs.readFileSync(path.join(HERE, '..', 'data', 'aquilon-c-snapshot.json'), 'utf8'),
);

test('capacity maps to block size in links (manual 5.5.1)', () => {
  assert.equal(capacityToLinks('DUAL'), 1, 'capacity 1 is one link square');
  assert.equal(capacityToLinks('4K'), 2, 'capacity 2 is 2x2 links');
  assert.equal(capacityToLinks('8K'), 4, 'capacity 4 is 4x4 links');
  assert.equal(capacityToLinks('OFF'), 0);
});

test('a full VPU of capacity-2 layers is 16 blocks of 2x2 links', () => {
  const perVpu = (LINKS_PER_VPU / capacityToLinks('4K')) ** 2;
  assert.equal(perVpu, 16, '8x8 links / 2x2 per block = 16 blocks');
});

test('the captured Aquilon C fills PROC 1 exactly', () => {
  const grid = deriveLinkGrid(snapshot.current);
  const p1 = grid.find((g) => g.vpu === 1);

  assert.equal(p1.fitted, true);
  assert.equal(p1.blocks.length, 16, 'all 16 mixers placed');
  assert.equal(p1.rowsUsed, LINKS_PER_VPU, 'exactly fills the 8 layer links');
  assert.equal(p1.overflow, false);
});

test('no VPU overflows its 8 layer links', () => {
  for (const g of deriveLinkGrid(snapshot.current)) {
    assert.equal(g.overflow, false, `VPU ${g.vpu} fits`);
    assert.ok(g.rowsUsed <= LINKS_PER_VPU, `VPU ${g.vpu} rowsUsed ${g.rowsUsed}`);
  }
});

test('blocks stay inside the 8x8 field', () => {
  for (const g of deriveLinkGrid(snapshot.current)) {
    for (const b of g.blocks) {
      assert.ok(b.col >= 0 && b.col + b.size <= LINKS_PER_VPU, `${b.mixer} col ${b.col}+${b.size}`);
      assert.ok(b.row >= 0 && b.row + b.size <= LINKS_PER_VPU, `${b.mixer} row ${b.row}+${b.size}`);
    }
  }
});

test('no two blocks overlap within a VPU', () => {
  for (const g of deriveLinkGrid(snapshot.current)) {
    const occupied = new Set();
    for (const b of g.blocks) {
      for (let r = b.row; r < b.row + b.size; r++) {
        for (let c = b.col; c < b.col + b.size; c++) {
          const key = `${r},${c}`;
          assert.ok(!occupied.has(key), `VPU ${g.vpu}: ${b.mixer} overlaps at ${key}`);
          occupied.add(key);
        }
      }
    }
  }
});

test('a run wider than the scaling-engine boundary wraps (manual 5.5.4)', () => {
  const grid = deriveLinkGrid(snapshot.current);
  const p1 = grid.find((g) => g.vpu === 1);

  // S3's native background is 8 slices at capacity 2. Four 2x2 blocks fill one
  // layer link, so it must occupy a second one.
  const s3 = p1.blocks.filter((b) => b.screen === 'S3' && b.layer === 'NATIVE');
  assert.equal(s3.length, 8);
  assert.ok(s3.some((b) => b.wrapped), 'S3 native wraps onto another layer link');
  assert.equal(new Set(s3.map((b) => b.row)).size, 2, 'across exactly two layer links');

  // Half of it sits beyond the 4-output scaling-engine boundary.
  assert.equal(SCALING_ENGINE_BOUNDARY, 4);
  assert.equal(s3.filter((b) => b.crossesBoundary).length, 4);

  // S1's native is 4 slices at capacity 2 — exactly one layer link, no wrap.
  const s1 = p1.blocks.filter((b) => b.screen === 'S1' && b.layer === 'NATIVE');
  assert.equal(s1.length, 4);
  assert.ok(!s1.some((b) => b.wrapped), 'S1 native fits on one layer link');
});

test('unfitted processors produce an empty, non-overflowing grid', () => {
  const grid = deriveLinkGrid(snapshot.current);
  for (const p of [3, 4]) {
    const g = grid.find((x) => x.vpu === p);
    assert.equal(g.fitted, false);
    assert.deepEqual(g.blocks, []);
    assert.equal(g.rowsUsed, 0);
  }
});

test('spare mixers are counted but not placed', () => {
  const g = deriveLinkGrid(snapshot.current).find((x) => x.vpu === 2);
  assert.equal(g.spare, 4, 'PROC 2 has 4 available-but-disabled mixers');
  assert.ok(!g.blocks.some((b) => b.mixer.endsWith('MIXER_13')), 'spare not drawn');
});

test('deriveLinkGrid tolerates empty input', () => {
  const grid = deriveLinkGrid({});
  assert.equal(grid.length, 4);
  assert.ok(grid.every((g) => g.blocks.length === 0 && !g.overflow));
  assert.doesNotThrow(() => deriveLinkGrid(null));
});

/* ---------- reported columns (hardware, 2026-08-21) ---------- */

test('buildLinkGrid uses the device’s own output links for columns', () => {
  const grid = buildLinkGrid(snapshot.current);
  const p1 = grid.find((g) => g.vpu === 1);
  assert.equal(p1.placement, 'reported-columns');

  const runCols = (g, screen, layer) => {
    const b = g.blocks.find((x) => x.screen === screen && x.layer === layer);
    return b.cols.map((c) => c + 1);
  };
  // Interleaved, exactly as the hardware reports it.
  assert.deepEqual(runCols(p1, 'S1', 'NATIVE'), [1, 3]);
  assert.deepEqual(runCols(p1, 'S3', 'NATIVE'), [2, 4]);
  assert.deepEqual(runCols(p1, 'S2', 'NATIVE'), [5, 7]);
});

test('runs on disjoint links share rows; runs that collide stack', () => {
  const grid = buildLinkGrid(snapshot.current);

  const rows = (g, screen, layer) => {
    const rs = g.blocks.filter((b) => b.screen === screen && b.layer === layer).map((b) => b.row);
    return [Math.min(...rs), Math.max(...rs)];
  };

  // VPU 1: three runs, none sharing a link, so all start at row 0.
  const p1 = grid.find((g) => g.vpu === 1);
  assert.deepEqual(rows(p1, 'S1', 'NATIVE'), [0, 3]);
  assert.deepEqual(rows(p1, 'S2', 'NATIVE'), [0, 3]);
  assert.deepEqual(rows(p1, 'S3', 'NATIVE'), [0, 7]);

  // VPU 2: S4's native and layer 1 share links 5 and 7, so layer 1 stacks below.
  const p2 = grid.find((g) => g.vpu === 2);
  assert.deepEqual(rows(p2, 'S4', 'NATIVE'), [0, 3]);
  assert.deepEqual(rows(p2, 'S4', '1'), [4, 7]);
});

test('no cell is claimed twice, and nothing overflows', () => {
  for (const g of buildLinkGrid(snapshot.current)) {
    const taken = new Set();
    for (const b of g.blocks) {
      for (const c of b.cols) {
        const k = `${b.row},${c}`;
        assert.ok(!taken.has(k), `VPU ${g.vpu}: ${b.mixer} collides at ${k}`);
        taken.add(k);
      }
    }
    assert.equal(g.overflow, false, `VPU ${g.vpu} fits in ${LINKS_PER_VPU} layer links`);
  }
});

test('falls back to the derived layout when no pipes are reported', () => {
  const stripped = {};
  for (const [id, r] of Object.entries(snapshot.current)) stripped[id] = { ...r, mixerAllocation: {} };
  const grid = buildLinkGrid(stripped);
  assert.ok(grid.every((g) => g.placement === 'derived'));
  assert.equal(grid.find((g) => g.vpu === 1).blocks.length, 16);
});

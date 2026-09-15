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
  reportedColumns,
  reportedOutputs,
  optimizedVpus,
  capacityToLinks,
  stackVpus,
  screenOutputLinks,
  diff,
  LINKS_PER_VPU,
  SCALING_ENGINE_BOUNDARY,
} from '../public/vpu.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const snapshot = JSON.parse(
  fs.readFileSync(path.join(HERE, '..', 'data', 'aquilon-c-snapshot.json'), 'utf8'),
);

test('capacity comes from the position in the device’s own enum', () => {
  // LAYER_CAPABILITIES is OFF, DUAL, 4K, 3, 5K, 5, 6, 7, 8K — the bare numbers
  // sit at their own index, so position is the capacity and the named entries
  // are simply the capacities that got names.
  assert.equal(capacityToLinks('DUAL'), 1, 'capacity 1');
  assert.equal(capacityToLinks('4K'), 2, 'capacity 2');
  assert.equal(capacityToLinks('5K'), 4, 'capacity 4 — seen on hardware');
  assert.equal(capacityToLinks('8K'), 8, 'capacity 8');
  assert.equal(capacityToLinks('OFF'), 0);
  assert.equal(capacityToLinks(undefined), 0);
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


/* ---------- second real configuration: 6-output screen + a 5K layer ---------- */

const sixOut = JSON.parse(
  fs.readFileSync(path.join(HERE, '..', 'data', 'aquilon-c-6output-5k.json'), 'utf8'),
);

test('a run can have several mixers per slice, on different links', () => {
  // S1 here is a SIX-output screen. Manual 5.5.4: a layer spread over more than
  // four output links uses another layer link — so each slice is carried by two
  // mixers, one on links 1,3,5,7 (outputs 1-4) and one on links 2,4 (outputs
  // 5,6). Slice therefore does NOT uniquely identify a mixer within a run, and
  // columns are per mixer rather than per run.
  const enabled = Object.entries(sixOut.current).filter(([, m]) => m.isEnabled);
  const s1native = enabled.filter(([, m]) => m.usedInScreen === 'S1' && m.usedInLayer === 'NATIVE');

  assert.equal(s1native.length, 4, 'four mixers');
  assert.deepEqual(s1native.map(([, m]) => m.slice).sort(), [0, 0, 1, 1], 'two per slice');

  const colsBySlice = new Map();
  for (const [, m] of s1native) {
    const cols = reportedColumns(m).map((c) => c + 1);
    if (!colsBySlice.has(m.slice)) colsBySlice.set(m.slice, []);
    colsBySlice.get(m.slice).push(cols);
  }
  for (const [slice, sets] of colsBySlice) {
    assert.equal(sets.length, 2, `slice ${slice} carried by two mixers`);
    const flat = sets.flat();
    assert.equal(new Set(flat).size, flat.length, 'their links do not overlap');
    assert.equal(flat.length, 6, 'six output links between them');
  }
});


test('both real captures pack without collisions', () => {
  for (const snap of [snapshot, sixOut]) {
    for (const g of buildLinkGrid(snap.current)) {
      const taken = new Set();
      for (const b of g.blocks) {
        for (const c of b.cols) {
          const k = `${b.row},${c}`;
          assert.ok(!taken.has(k), `VPU ${g.vpu}: ${b.mixer} collides at ${k}`);
          taken.add(k);
        }
      }
      assert.equal(g.overflow, false);
    }
  }
});

test('a mixed-capability chassis keeps each mixer’s own capability', () => {
  const p1 = buildLinkGrid(sixOut.current).find((g) => g.vpu === 1);
  const caps = new Set(p1.blocks.map((b) => b.capability));
  assert.deepEqual([...caps].sort(), ['4K', '5K'], 'both appear, per mixer');
});

/* ---------- Optimized mode (hardware, 2026-08-21) ---------- */

const optimized = JSON.parse(
  fs.readFileSync(path.join(HERE, '..', 'data', 'aquilon-c-optimized.json'), 'utf8'),
);

test('a screen in Optimized mode makes its whole VPU optimized', () => {
  const st = optimized.screenStatus.current;
  assert.equal(st.S1.isOptimized, true, 'S1 reports it');
  assert.equal(st.S2.isOptimized, false);

  // 5.5.6: at least 5 output links and a capacity-2 layer. S1 spends 6.
  assert.ok(st.S1.usedOutputCapabilities >= 5, 'S1 spends 6 output capabilities');

  // It is a property of the VPU, not the screen: S1's mixers are on PROC 1.
  const vpus = optimizedVpus(optimized.current, st);
  assert.deepEqual([...vpus], [1]);
});

test('the boundary applies to every VPU when nothing is optimized', () => {
  // The other two captures have no optimized screen at all.
  assert.deepEqual([...optimizedVpus(snapshot.current, {})], []);
  assert.deepEqual([...optimizedVpus(sixOut.current, undefined)], [], 'tolerates no status');
});

test('the device reports headroom and overflow directly', () => {
  const staged = optimized.screenStatus.new;
  assert.equal(staged.S1.remainingOutputCapabilities, 2, 'two output links spare');
  assert.equal(staged.S1.exceedingOutputCapabilities, 0);
  assert.equal(staged.S1.exceedingLayerCapabilities, 0);
  // Nothing on this chassis is over budget.
  for (const [id, st] of Object.entries(staged)) {
    assert.equal(
      (st.exceedingOutputCapabilities || 0) + (st.exceedingLayerCapabilities || 0), 0, id,
    );
  }
});

/* ---------- fourth real configuration: single-output screens, WITH the outputs ---------- */

const duals = JSON.parse(
  fs.readFileSync(path.join(HERE, '..', 'data', 'aquilon-c-dual-outputs.json'), 'utf8'),
);

test('screen names and output labels are never committed to the captures', () => {
  // They are show data — the live view only. Guard it, because a capture
  // refreshed from a live read would otherwise carry them in silently.
  for (const snap of [snapshot, sixOut, optimized, duals]) {
    assert.equal(snap.screens, undefined, `${snap.note?.slice(0, 24)}… has no screen names`);
    assert.equal(snap.source.host, 'redacted');
    for (const o of Object.values(snap.outputs || {})) assert.equal(o.label, undefined, 'no output labels');
  }
});

/* ---------- the manual's grid, §5.5.2 to §5.5.6 ---------- */

const optimisedVpusOf = (snap) => optimizedVpus(snap.current, (snap.screenStatus || {}).current);
const gridOf = (snap) => buildLinkGrid(snap.current, optimisedVpusOf(snap));

test('a screen owns a contiguous run of output links', () => {
  // §5.5.4: two four-output screens fill a VPU as links 1-4 and 5-8. The device's
  // usedOnOutPipe KEYS are interleaved and are not that order — its VALUES are.
  const p1 = gridOf(sixOut).find((g) => g.vpu === 1);
  assert.deepEqual(
    p1.screens.map((s) => [s.screen, s.col, s.width]),
    [['S1', 0, 6], ['S2', 6, 2]],
    'the six-output screen takes links 1-6, the two-output screen 7-8',
  );
  assert.equal(p1.columnsUsed, 8, 'exactly full');

  // Every block sits inside its own screen's run, and every screen's layers
  // start at the same link.
  for (const snap of [snapshot, sixOut, optimized]) {
    for (const g of gridOf(snap)) {
      for (const b of g.blocks) {
        const s = g.screens.find((x) => x.screen === b.screen);
        assert.ok(
          b.cols.every((c) => c >= s.col && c < s.col + s.width),
          `${b.mixer} outside ${b.screen}'s links`,
        );
      }
    }
  }
});

test('a layer’s bar is continuous', () => {
  for (const snap of [snapshot, sixOut, optimized]) {
    for (const g of gridOf(snap)) {
      for (const b of g.blocks) {
        for (let i = 1; i < b.cols.length; i++) {
          assert.equal(b.cols[i], b.cols[i - 1] + 1, `${b.mixer} has a gap: ${b.cols}`);
        }
      }
    }
  }
});

test('no two layers ever share a layer link', () => {
  // The rule the whole grid rests on: a row is one layer-capacity link and it
  // carries ONE layer. This is what the old row-packing broke — it put S1, S2 and
  // S3 all on layer link 1 of the captured VPU 1.
  for (const snap of [snapshot, sixOut, optimized]) {
    for (const g of gridOf(snap)) {
      const owner = new Map();
      for (const b of g.blocks) {
        for (let r = b.row; r < b.row + b.height; r++) {
          const who = `${b.screen} ${b.layer}`;
          const already = owner.get(r);
          assert.ok(
            already === undefined || already === who,
            `VPU ${g.vpu} link ${r}: ${already} and ${who} on one row`,
          );
          owner.set(r, who);
        }
      }
    }
  }
});

test('a layer is as tall as its capability, and slices do not add rows', () => {
  const p2 = gridOf(snapshot).find((g) => g.vpu === 2);

  // S3's layer 1 is four slices of one 4K layer. 4K is capacity 2 — two layer
  // links — and the four slices share them.
  const s3 = p2.blocks.filter((b) => b.screen === 'S3' && b.layer === '1');
  assert.equal(s3.length, 1, 'one block, not one per slice');
  assert.equal(s3[0].height, capacityToLinks('4K'));
  assert.equal(capacityToLinks('4K'), 2, 'dual link is capacity 1; 4K60 is capacity 2');
  assert.deepEqual(s3[0].slices, [0, 1, 2, 3]);
  assert.equal(s3[0].mixers.length, 4);

  // A 5K layer is four links tall.
  const s2 = gridOf(sixOut)
    .find((g) => g.vpu === 1)
    .blocks.find((b) => b.screen === 'S2' && b.layer === 'NATIVE');
  assert.equal(s2.capability, '5K');
  assert.equal(s2.height, 4);
});

test('a layer past four output links wraps onto another layer link (§5.5.4)', () => {
  // The manual's own figure: a six-output screen's layer is links 1-4 on one row
  // and 5-6 on the next, with the hook. Nothing crosses the centre line.
  const p1 = gridOf(sixOut).find((g) => g.vpu === 1);
  const l1 = p1.blocks.filter((b) => b.screen === 'S1' && b.layer === '1');

  assert.equal(l1.length, 2, 'two pieces');
  assert.deepEqual(l1.map((b) => b.cols.map((c) => c + 1)), [[1, 2, 3, 4], [5, 6]]);
  assert.deepEqual(l1.map((b) => b.row), [l1[0].row, l1[0].row + 2], 'the next links down');
  assert.ok(!l1[0].wrapped && l1[1].wrapped, 'the second piece is the wrap');
  assert.ok(l1.every((b) => b.height === 2), 'each piece is a whole capacity-2 layer');

  for (const snap of [snapshot, sixOut, optimized]) {
    for (const g of gridOf(snap)) {
      for (const b of g.blocks) {
        if (optimisedVpusOf(snap).has(g.vpu) && b.height >= 2) continue;
        const left = b.cols.some((c) => c < SCALING_ENGINE_BOUNDARY);
        const right = b.cols.some((c) => c >= SCALING_ENGINE_BOUNDARY);
        assert.ok(!(left && right), `${b.mixer} crosses the centre line`);
      }
    }
  }
});

test('Optimized mode lifts the boundary for capacity-2 layers (§5.5.6)', () => {
  // Same six-output shape as above, but this VPU reports Optimized, so the layer
  // is one unbroken bar over all six links instead of wrapping.
  const opt = optimisedVpusOf(optimized);
  assert.deepEqual([...opt], [1]);

  const p1 = gridOf(optimized).find((g) => g.vpu === 1);
  const l1 = p1.blocks.filter((b) => b.screen === 'S1' && b.layer === '1');
  assert.equal(l1.length, 1, 'no wrap');
  assert.deepEqual(l1[0].cols.map((c) => c + 1), [1, 2, 3, 4, 5, 6]);

  // ...and S2's layer starts below S1's two, not beside them.
  const s2 = p1.blocks.find((b) => b.screen === 'S2' && b.layer === '1');
  assert.equal(s2.row, 4, 'after S1 layer 1 and layer 2, two links each');
  assert.deepEqual(s2.cols.map((c) => c + 1), [7, 8]);

  // Without the Optimized set it wraps, which is the same VPU read wrongly.
  const naive = buildLinkGrid(optimized.current).find((g) => g.vpu === 1);
  assert.equal(naive.blocks.filter((b) => b.screen === 'S1' && b.layer === '1').length, 2);
});

test('native backgrounds sit in their own band, out of the eight layer links', () => {
  // They hold mixers and drive output links, but they are not layer capacity —
  // so they are laid out in their own band (rows numbered from LINKS_PER_VPU up,
  // which a renderer draws above the field) and left out of rowsUsed.
  for (const snap of [snapshot, sixOut, optimized]) {
    for (const g of gridOf(snap)) {
      for (const b of g.blocks) {
        if (b.layer === 'NATIVE') {
          assert.equal(b.section, 'background');
          assert.ok(b.row >= LINKS_PER_VPU, `${b.mixer} at row ${b.row}`);
        } else {
          assert.equal(b.section, 'layer');
          assert.ok(b.row < LINKS_PER_VPU, `${b.mixer} at row ${b.row}`);
        }
      }
      const bg = g.blocks.filter((b) => b.section === 'background');
      assert.equal(g.backgroundRows, bg.reduce((n, b) => n + b.height, 0));
    }
  }
});

test('every real capture fits its eight layer links', () => {
  // The base capture spends none at all: all 16 of VPU 1's mixers are natives.
  // The six-output capture fills VPU 1 exactly — two layers, wrapped, 8 of 8.
  const rows = (snap) => gridOf(snap).filter((g) => g.fitted).map((g) => g.rowsUsed);
  assert.deepEqual(rows(snapshot), [0, 4]);
  assert.deepEqual(rows(sixOut), [8, 0]);
  assert.deepEqual(rows(optimized), [6, 2]);

  for (const snap of [snapshot, sixOut, optimized]) {
    for (const g of gridOf(snap)) {
      assert.equal(g.overflow, false, `VPU ${g.vpu} fits`);
      assert.ok(g.rowsUsed <= LINKS_PER_VPU);
      assert.ok(g.columnsUsed <= LINKS_PER_VPU, `VPU ${g.vpu} columns ${g.columnsUsed}`);
    }
  }
});

/* ---------- a screen continuing onto another VPU ---------- */

test('a screen continuing on another VPU keeps its columns, and the VPUs stack', () => {
  // The base capture: S3's native is on VPU 1 and its layer 1 on VPU 2, on the
  // same two output links. The link runs down out of VPU 1 into VPU 2, so S3
  // keeps links 5-6 on both and the two cards are stacked in that order.
  const grids = gridOf(snapshot);
  const p1 = grids.find((g) => g.vpu === 1);
  const p2 = grids.find((g) => g.vpu === 2);
  const s3on1 = p1.screens.find((s) => s.screen === 'S3');
  const s3on2 = p2.screens.find((s) => s.screen === 'S3');
  assert.deepEqual([s3on1.col, s3on1.width, s3on1.to], [4, 2, 2], 'VPU 1 hands S3 on to VPU 2');
  assert.deepEqual([s3on2.col, s3on2.width, s3on2.from], [4, 2, 1], 'the same columns on VPU 2');
  assert.deepEqual(s3on1.outputs, [1, 2]);
  assert.deepEqual(s3on2.outputs, [1, 2], 'the same output links');
  assert.equal(s3on1.from, undefined);
  assert.equal(s3on2.to, undefined);

  // S4 has VPU 2 to itself otherwise, and takes the first free columns.
  const s4 = p2.screens.find((s) => s.screen === 'S4');
  assert.deepEqual([s4.col, s4.width, s4.from, s4.to], [0, 2, undefined, undefined]);
  for (const b of p2.blocks) {
    const s = p2.screens.find((x) => x.screen === b.screen);
    assert.ok(b.cols.every((c) => c >= s.col && c < s.col + s.width), `${b.mixer} on its screen's links`);
  }
  assert.deepEqual(stackVpus(grids), [[1, 2], [3], [4]]);

  // The optimized capture does the same with S2: native and layer 1 on VPU 1's
  // links 7-8, layer 2 on VPU 2.
  const opt = gridOf(optimized);
  const s2on1 = opt.find((g) => g.vpu === 1).screens.find((s) => s.screen === 'S2');
  const s2on2 = opt.find((g) => g.vpu === 2).screens.find((s) => s.screen === 'S2');
  assert.deepEqual([s2on1.col, s2on1.to], [6, 2]);
  assert.deepEqual([s2on2.col, s2on2.from], [6, 1]);
  assert.deepEqual(stackVpus(opt), [[1, 2], [3], [4]]);

  // With nothing continuing, every VPU stands alone and the columns are the old
  // side-by-side order.
  assert.deepEqual(stackVpus(gridOf(sixOut)), [[1], [2], [3], [4]]);
  assert.ok(gridOf(sixOut).every((g) => g.screens.every((s) => s.from === undefined && s.to === undefined)));
});

test('a screen on other output links of a later VPU is not a continuation', () => {
  // §5.5.5's wider screen: the later VPU carries FURTHER links of the screen,
  // so the link does not run from one VPU into the other and nothing stacks.
  const mixer = (screen, layer, slice, pipes) => ({
    isAvailable: true, isEnabled: true, usedInScreen: screen, usedInLayer: layer,
    slice, capability: 'DUAL', cutnfillCapa: 'OFF',
    mixerAllocation: Object.fromEntries(pipes.map(([k, v]) => [`usedOnOutPipe${k}`, String(v)])),
  });
  const mixers = {
    PROC_1_MIXER_1: mixer('S1', '1', 0, [[1, 1], [2, 2]]),
    PROC_2_MIXER_1: mixer('S1', '1', 1, [[1, 3], [2, 4]]),
  };
  const grids = buildLinkGrid(mixers);
  const on1 = grids.find((g) => g.vpu === 1).screens.find((s) => s.screen === 'S1');
  const on2 = grids.find((g) => g.vpu === 2).screens.find((s) => s.screen === 'S1');
  assert.deepEqual(on1.outputs, [1, 2]);
  assert.deepEqual(on2.outputs, [3, 4]);
  assert.equal(on1.to, undefined);
  assert.equal(on2.from, undefined);
  assert.deepEqual(stackVpus(grids), [[1], [2], [3], [4]]);
});

test('two screens continuing onto the same columns: the second is placed first fit', () => {
  // A continuing screen reserves the columns it had upstream before anything
  // else is placed, so only ANOTHER continuing screen can be in its way. S1 sits
  // on links 1-2 of VPU 1, S2 on links 1-2 of VPU 2, and both continue onto VPU 3:
  // S1 keeps 1-2, S2 cannot and takes the next free run. Both continuations are
  // still recorded, and all three VPUs stack.
  const mixer = (screen, layer, pipes) => ({
    isAvailable: true, isEnabled: true, usedInScreen: screen, usedInLayer: layer,
    slice: 0, capability: 'DUAL', cutnfillCapa: 'OFF',
    mixerAllocation: Object.fromEntries(pipes.map(([k, v]) => [`usedOnOutPipe${k}`, String(v)])),
  });
  const mixers = {
    PROC_1_MIXER_1: mixer('S1', 'NATIVE', [[1, 1], [2, 2]]),
    PROC_2_MIXER_1: mixer('S2', 'NATIVE', [[1, 1], [2, 2]]),
    PROC_3_MIXER_1: mixer('S1', '1', [[1, 1], [2, 2]]),
    PROC_3_MIXER_2: mixer('S2', '1', [[3, 1], [4, 2]]),
  };
  const grids = buildLinkGrid(mixers);
  const p3 = grids.find((g) => g.vpu === 3);
  const s1 = p3.screens.find((s) => s.screen === 'S1');
  const s2 = p3.screens.find((s) => s.screen === 'S2');
  assert.deepEqual([s1.col, s1.from], [0, 1], 'S1 keeps its columns');
  assert.deepEqual([s2.col, s2.from], [2, 2], 'S2 is placed first fit, and still continues from VPU 2');
  assert.equal(grids.find((g) => g.vpu === 1).screens[0].to, 3);
  assert.equal(grids.find((g) => g.vpu === 2).screens[0].to, 3);
  assert.equal(p3.overflow, false);
  assert.deepEqual(stackVpus(grids), [[1, 2, 3], [4]]);
});

/* ---------- the header: which output each link is ---------- */

test('the header deals a screen’s links out over its outputs, in output order', () => {
  // Against the optimized capture's own figures: S1 is three 4K outputs (six
  // links), S2, S3 and S4 one each. The table is synthetic — the outputs were
  // never read off the Aquilon C — but the check against the screen's figures
  // is what makes it safe to draw.
  const outputs = {
    3: { screen: 'S1', region: '1', capability: '4K', type: 'HDMI', card: 'OUT_1', physical: '3' },
    1: { screen: 'S1', region: '1', capability: '4K', type: 'HDMI', card: 'OUT_1', physical: '1' },
    2: { screen: 'S1', region: '2', capability: '4K', label: 'LED right', type: 'HDMI', card: 'OUT_1', physical: '2' },
    4: { screen: 'S2', region: '1', capability: '4K' },
    5: { screen: 'NONE', region: '1', capability: 'DUAL' },
    6: { screen: 'S3', region: '1', capability: '4K' },
    7: { screen: 'S4', region: '1', capability: 'DUAL' },
    8: { screen: 'S4', region: '1', capability: 'DUAL' },
    9: { screen: 'A1', region: '1', capability: 'DUAL' },
  };
  const links = screenOutputLinks(outputs, optimized.screenStatus.current);

  const s1 = links.get('S1');
  assert.equal(s1.consistent, true);
  assert.equal(s1.links, 6);
  assert.deepEqual(
    s1.runs.map((r) => [r.output, r.region, r.first, r.last]),
    [['1', '1', 1, 2], ['2', '2', 3, 4], ['3', '1', 5, 6]],
    'output order, two links per 4K output — not the order the table was written in',
  );
  assert.equal(s1.runs[1].label, 'LED right');
  assert.deepEqual([s1.runs[0].type, s1.runs[0].card, s1.runs[0].physical], ['HDMI', 'OUT_1', '1']);

  assert.deepEqual(links.get('S2').runs.map((r) => [r.output, r.first, r.last]), [['4', 1, 2]]);
  assert.equal(links.get('S2').consistent, true);
  assert.equal(links.get('S3').consistent, true);

  // Two dual outputs add up to S4's two links but not to its one output.
  assert.equal(links.get('S4').consistent, false, 'outputCount says one output');

  assert.equal(links.has('NONE'), false, 'unassigned outputs are nobody’s');
  assert.equal(links.has('A1'), false, 'auxes do not use the VPU');

  // Without the device's figures there is nothing to check against, and the
  // table is taken as read.
  assert.equal(screenOutputLinks(outputs).get('S4').consistent, true);
  assert.equal(screenOutputLinks(undefined).size, 0);
});

test('the header holds on the real outputs: each screen’s one output is its one link', () => {
  // The dual-outputs capture is lifted from the whole-store pull of the real
  // Aquilon C on 2026-09-09 — the only hardware reading of the outputs. Three
  // screens, one dual-link HDMI output each, and the device's own figures agree
  // with the accounting: this is the paths and the sums settled on hardware.
  // With one output per screen it says nothing about the ORDER of several.
  const links = screenOutputLinks(duals.outputs, duals.screenStatus.current);
  assert.deepEqual(
    [...links.entries()].map(([s, v]) => [s, v.consistent, v.links, v.runs.map((r) => [r.output, r.region, r.capability, r.type, r.card, r.physical, r.first, r.last])]),
    [
      ['S3', true, 1, [['5', '1', 'DUAL', 'HDMI', 'OUT_2', '5', 1, 1]]],
      ['S1', true, 1, [['7', '1', 'DUAL', 'HDMI', 'OUT_2', '7', 1, 1]]],
      ['S2', true, 1, [['8', '1', 'DUAL', 'HDMI', 'OUT_2', '8', 1, 1]]],
    ],
  );
  // The auxes on the SDI card cost no VPU and get no header.
  for (const n of ['1', '2', '3', '4']) assert.match(duals.outputs[n].screen, /^A\d$/);
  assert.equal(links.has('A1'), false);

  // The grid agrees: every screen's one link is its column, and a 4K layer on a
  // dual-link output is two rows tall on one column — a layer need not match the
  // capacity of the output it feeds.
  for (const g of gridOf(duals)) {
    for (const sc of g.screens) assert.deepEqual([sc.width, sc.outputs], [1, [1]]);
    for (const b of g.blocks) assert.deepEqual([b.height, b.cols.length], [2, 1], `${b.mixer}`);
  }
  assert.deepEqual(gridOf(duals).filter((g) => g.fitted).map((g) => g.rowsUsed), [4, 2]);
  assert.deepEqual(stackVpus(gridOf(duals)), [[1], [2], [3], [4]], 'nothing continues');

  // The staged side is the same kind of change the optimized capture showed:
  // S2's link moves from pipe 3 to pipe 2, nothing else.
  const changed = diff(duals.current, duals.new);
  assert.ok(changed.length, 'the staged side differs');
  for (const c of changed) {
    assert.equal(duals.current[c.mixer].usedInScreen, 'S2');
    assert.ok(c.changed.every((d) => d.prop.startsWith('link ')), `${c.mixer}: links only`);
  }
});

test('the reported pipe keys are not the columns', () => {
  // Keeping the distinction honest: a six-output screen's first mixer is wired to
  // pipes 1,3,5,7 and carries the screen's links 1,2,3,4.
  const m = sixOut.current.PROC_1_MIXER_1;
  assert.deepEqual(reportedColumns(m), [0, 2, 4, 6], 'VPU pipes, interleaved');
  assert.deepEqual(reportedOutputs(m), [1, 2, 3, 4], 'the screen’s own links, in order');
});

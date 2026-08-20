// The VPU-mixer model, and the derivations built on it.
//
// Pure: no Node APIs, no DOM. The browser imports this directly and the server
// imports it too, so a live read and a recorded capture go through identical
// code on their way to the screen.
//
// A "VPU" on a LivePremier is a *VPU mixer*: the physical mixing/scaling
// resource the device allocates to a (screen, layer) pair. A layer too wide for
// one mixer is split across several, each carrying one `slice`. That is why the
// mixer table — not the layer count — is the real answer to "will this fit".

export const PROCESSORS = 4;
export const MIXERS_PER_PROCESSOR = 16;
export const MAX_MIXERS = PROCESSORS * MIXERS_PER_PROCESSOR; // 64

/** Every mixer id the model allows, in chassis order. */
export const MIXER_IDS = (() => {
  const ids = [];
  for (let p = 1; p <= PROCESSORS; p++) {
    for (let m = 1; m <= MIXERS_PER_PROCESSOR; m++) ids.push(`PROC_${p}_MIXER_${m}`);
  }
  return ids;
})();

export const SCALERS = ['A', 'B'];

/** Props read from each mixer. All are readOnly in the device's own model. */
export const MIXER_PROPS = [
  'isEnabled',
  'usedInScreen',
  'usedInLayer',
  'channel',
  'slice',
  'capability',
  'seamlessCapa',
];

export const LAYER_CAPABILITIES = ['OFF', 'DUAL', '4K', '3', '5K', '5', '6', '7', '8K'];

export function parseMixerId(id) {
  const m = /^PROC_(\d+)_MIXER_(\d+)$/.exec(id);
  if (!m) return null;
  return { processor: Number(m[1]), index: Number(m[2]) };
}

/**
 * Derive the summary the UI leads with: how much hardware is fitted, how much
 * is spent, and which (screen, layer) runs it was spent on.
 */
export function summarise(mixers) {
  const entries = Object.entries(mixers || {});
  const fitted = entries.filter(([, r]) => r && r.isAvailable);
  const enabled = fitted.filter(([, r]) => r.isEnabled);

  const processors = new Map();
  for (const [id, rec] of entries) {
    const parsed = parseMixerId(id);
    if (!parsed) continue;
    if (!processors.has(parsed.processor)) {
      processors.set(parsed.processor, { processor: parsed.processor, fitted: 0, enabled: 0 });
    }
    const bucket = processors.get(parsed.processor);
    if (rec && rec.isAvailable) bucket.fitted++;
    if (rec && rec.isEnabled) bucket.enabled++;
  }

  // Group enabled mixers into the (screen, layer) runs a layer actually costs.
  const groups = new Map();
  for (const [id, rec] of enabled) {
    const key = `${rec.usedInScreen} ${rec.usedInLayer}`;
    if (!groups.has(key)) {
      groups.set(key, {
        screen: rec.usedInScreen,
        layer: rec.usedInLayer,
        capability: rec.capability,
        mixers: [],
        slices: [],
        pipes: new Set(),
      });
    }
    const g = groups.get(key);
    g.mixers.push(id);
    g.slices.push(rec.slice);
    const a = rec.mixerAllocation || {};
    for (const [name, v] of [['pipe1', a.usedOnOutPipe1], ['pipe2', a.usedOnOutPipe2]]) {
      if (v !== undefined && v !== null && v !== 'NONE') g.pipes.add(`${name} ${v}`);
    }
  }

  const allocations = [...groups.values()]
    .map((g) => ({ ...g, slices: [...g.slices].sort((a, b) => a - b), pipes: [...g.pipes] }))
    .sort((a, b) => {
      const sa = String(a.screen);
      const sb = String(b.screen);
      if (sa !== sb) return sa.localeCompare(sb, undefined, { numeric: true });
      if (a.layer === 'NATIVE') return -1;
      if (b.layer === 'NATIVE') return 1;
      return String(a.layer).localeCompare(String(b.layer), undefined, { numeric: true });
    });

  return {
    fitted: fitted.length,
    enabled: enabled.length,
    spare: fitted.length - enabled.length,
    max: MAX_MIXERS,
    screens: new Set(allocations.map((a) => a.screen)).size,
    processors: [...processors.values()].sort((a, b) => a.processor - b.processor),
    allocations,
  };
}

/* ------------------------------------------------------------------------ *
 * The link grid — the way Analog Way's own manual draws a VPU.
 *
 * A VPU is an 8x8 field of links: 8 layer links in on the left, 8 output links
 * out through the top and bottom (User Manual v6.0 §5.5). A layer occupies a
 * square block sized by its capacity — capacity 1 is 1x1 links, capacity 2 is
 * 2x2, capacity 4 is 4x4 — so a VPU holds 64 capacity-1 layers, 16 capacity-2
 * ones, or 4 capacity-4 ones.
 *
 * §5.5.4: a VPU spreads a layer over at most 4 output links. A layer wider than
 * that consumes a second layer link and wraps onto it.
 *
 * ---------------------------------------------------------------------------
 * IMPORTANT: this is a DERIVED layout, not reported placement.
 *
 * The device tells us what each mixer serves — screen, layer, slice, capability
 * — but not which row and column it sits in. `$vpuLayer` (8 scalers per VPU,
 * each declaring which of 8 output pipes it drives) looks like the reported
 * grid, but it reads empty on the simulator and has never been seen populated.
 * See docs/HARDWARE-PROBE.md. Until it is, blocks are placed by the rule below.
 *
 * The rule: within a VPU, take each (screen, layer) run in order, sort its
 * mixers by slice, and lay them left to right in capacity-sized blocks. A run
 * longer than the scaling-engine boundary wraps onto the next layer link. Runs
 * stack downwards in the order the device lists them.
 * ------------------------------------------------------------------------ */

export const LINKS_PER_VPU = 8;
export const SCALING_ENGINE_BOUNDARY = 4; // output links, §5.5.4

/** How many links square one layer of a given capability occupies. */
export function capacityToLinks(capability) {
  switch (capability) {
    case 'OFF': return 0;
    case 'DUAL': return 1;   // capacity 1
    case '4K': return 2;     // capacity 2
    case '8K': return 4;     // capacity 4
    default: {
      const n = Number(capability);
      return Number.isFinite(n) && n > 0 ? Math.min(4, n) : 2;
    }
  }
}

/**
 * Lay the enabled mixers of every processor onto its 8x8 link field.
 *
 * @returns {{vpu:number, fitted:boolean, blocks:Array, rowsUsed:number}[]}
 *   blocks are `{screen, layer, slice, capability, col, row, size, wrapped}`
 *   in LINK units, so a renderer can draw straight onto an 8x8 field.
 */
export function deriveLinkGrid(mixers) {
  const out = [];

  for (let p = 1; p <= PROCESSORS; p++) {
    const ids = MIXER_IDS.filter((id) => parseMixerId(id).processor === p);
    const fitted = ids.some((id) => mixers?.[id]?.isAvailable);
    const enabled = ids.filter((id) => mixers?.[id]?.isEnabled);

    // Preserve the device's own ordering of (screen, layer) runs.
    const runs = [];
    const index = new Map();
    for (const id of enabled) {
      const m = mixers[id];
      const key = `${m.usedInScreen} ${m.usedInLayer}`;
      if (!index.has(key)) {
        index.set(key, runs.length);
        runs.push({ screen: m.usedInScreen, layer: m.usedInLayer, capability: m.capability, cells: [] });
      }
      runs[index.get(key)].cells.push({ id, slice: m.slice });
    }
    for (const r of runs) r.cells.sort((a, b) => a.slice - b.slice);

    const blocks = [];
    let row = 0;
    for (const run of runs) {
      const size = capacityToLinks(run.capability) || 1;
      // The field is 8 links wide, so this many blocks sit on one layer link.
      const perBand = Math.max(1, Math.floor(LINKS_PER_VPU / size));
      run.cells.forEach((cell, i) => {
        const band = Math.floor(i / perBand);
        const col = (i % perBand) * size;
        blocks.push({
          mixer: cell.id,
          screen: run.screen,
          layer: run.layer,
          capability: run.capability,
          slice: cell.slice,
          col,
          row: row + band * size,
          size,
          // Occupies an additional layer link beyond the run's first (§5.5.4).
          wrapped: band > 0,
          // Sits past the scaling-engine boundary of 4 output links.
          crossesBoundary: col >= SCALING_ENGINE_BOUNDARY,
        });
      });
      const bands = Math.max(1, Math.ceil(run.cells.length / perBand));
      row += bands * size;
    }

    out.push({
      vpu: p,
      fitted,
      blocks,
      rowsUsed: row,
      overflow: row > LINKS_PER_VPU,
      spare: ids.filter((id) => mixers?.[id]?.isAvailable && !mixers[id].isEnabled).length,
    });
  }

  return out;
}

/** Which mixers differ between the running mapping and the staged one. */
export function diff(current, next) {
  const out = [];
  for (const id of MIXER_IDS) {
    const a = (current || {})[id];
    const b = (next || {})[id];
    if (!a && !b) continue;
    const changed = [];
    for (const p of ['isAvailable', ...MIXER_PROPS]) {
      const av = a ? a[p] : undefined;
      const bv = b ? b[p] : undefined;
      if (av !== bv) changed.push({ prop: p, from: av, to: bv });
    }
    if (changed.length) out.push({ mixer: id, changed });
  }
  return out;
}

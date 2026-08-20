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

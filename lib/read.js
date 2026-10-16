// Reading the VPU mixer map off a device over AWJ. Server-side only.
//
// Path shape (firmware 6.2; verified against a real Aquilon C):
//
//   DeviceObject/preconfig/resources/{current|new}/status/mapping
//     /$device/@items/<1-4>                 1 = master, 2-4 = Link followers
//     /$vpuMixer/@items/PROC_<1-4>_MIXER_<1-16>
//       /@props/<prop>
//       /mixerAllocation/@props/usedOnOutPipe{1,2}
//       /$scaler/@items/{A,B}/@props/{memoryFill,memoryCut}
//
// The collection segment is `$vpuMixer`, camelCase. `$vpu-mixer` and `$mixer`
// both answer E12.
//
// Firmware 6.1.x has no mixer map at all: an Aquilon RS4 on 6.1.60 with its
// screens on air answers E12 for `$vpuMixer` (2026-10-16). What it reports
// instead is per screen — see readScreenLayers.

import { MIXER_IDS, MIXER_PROPS, SCALERS, OUT_PIPES, LAYER_CAPABILITIES } from '../public/vpu.js';

const base = (which, device, mixer) =>
  `DeviceObject/preconfig/resources/${which}/status/mapping` +
  `/$device/@items/${device}/$vpuMixer/@items/${mixer}`;

/**
 * Read one side of the mapping ("current" = running, "new" = staged).
 *
 * Mixers that are not fitted answer isAvailable=false; their detail reads are
 * skipped, which roughly halves the traffic on a part-populated chassis.
 *
 * Throws with code NO_VPU_SUBTREE if the very first probe finds no $vpuMixer
 * collection — that is a device without a VPU map, and is worth telling the
 * user plainly rather than showing an empty grid. A simulator answers this way,
 * and so does an Aquilon on firmware 6.1.x with its screens on air; which one
 * it is is the device's own identity to say (`noMixerMap`), never this probe's.
 *
 * @param {import('./awj.js').AwjClient} client
 * @param {{which:'current'|'new', device?:string|number}} opts
 */
export async function readMapping(client, { which, device = '1' } = {}) {
  const mixers = {};
  let first = true;

  for (const id of MIXER_IDS) {
    const b = base(which, device, id);
    const isAvailable = await client.tryGet(`${b}/@props/isAvailable`);

    if (isAvailable === undefined) {
      if (first) {
        const err = new Error(`no $vpuMixer collection under ${which} mapping`);
        err.code = 'NO_VPU_SUBTREE';
        throw err;
      }
      mixers[id] = { isAvailable: false };
    } else if (isAvailable !== true) {
      mixers[id] = { isAvailable: false };
    } else {
      const rec = { isAvailable: true };
      for (const p of MIXER_PROPS) rec[p] = await client.tryGet(`${b}/@props/${p}`);
      // There are EIGHT output pipes, one per output link — not two. Reading only
      // the first two hid three quarters of the device's own placement data.
      rec.mixerAllocation = {};
      for (let k = 1; k <= OUT_PIPES; k++) {
        rec.mixerAllocation[`usedOnOutPipe${k}`] =
          await client.tryGet(`${b}/mixerAllocation/@props/usedOnOutPipe${k}`);
      }
      rec.scalers = {};
      for (const s of SCALERS) {
        rec.scalers[s] = {
          memoryFill: await client.tryGet(`${b}/$scaler/@items/${s}/@props/memoryFill`),
          memoryCut: await client.tryGet(`${b}/$scaler/@items/${s}/@props/memoryCut`),
        };
      }
      mixers[id] = rec;
    }
    first = false;
  }

  return mixers;
}

/**
 * Device identity. Cheap, and confirms we are talking to a LivePremier.
 *
 *   DeviceObject/system/$device/@items/1/@props/{dev,label,isSimulated}
 *   DeviceObject/system/$device/@items/1/version/@props/updater
 *
 * `isSimulated` is the simulator telling on itself, and it is the only thing
 * that can: a 6.1.60 Aquilon reports no mixer map exactly as a simulator does.
 * `version/@props/updater` is the firmware — "6.2.73" on the Aquilon C,
 * "6.1.60" on the RS4. (`@props/updater` without `version/` is the simulator's
 * alone; hardware answers E12.) Absent fields are left out, never guessed.
 */
export async function readIdentity(client) {
  const p = 'DeviceObject/system/$device/@items/1';
  const out = {
    dev: await client.tryGet(`${p}/@props/dev`),
    label: await client.tryGet(`${p}/@props/label`),
  };
  const isSimulated = await client.tryGet(`${p}/@props/isSimulated`);
  if (typeof isSimulated === 'boolean') out.isSimulated = isSimulated;
  const firmware = await client.tryGet(`${p}/version/@props/updater`);
  if (typeof firmware === 'string' && firmware) out.firmware = firmware;
  return out;
}

/** Firmware 6.1.x: no mixer map, per-screen layer figures instead. */
export const isFirmware61 = (firmware) => /^6\.1\./.test(String(firmware || ''));

/**
 * What to tell the operator when there is no mixer map: `{title, hint}`.
 *
 * The sentence is the device's identity to choose, never the shape of the
 * answer. The old one called every such device a simulator, and an Aquilon RS4
 * on 6.1.60 with three screens on air was told it had "no processor boards to
 * map". `inService` says the screens' own figures follow, so a box that
 * reports them is not told there is nothing to look at.
 *
 * `src-tauri/src/read.rs` (`no_mixer_map`) words it the same; change both.
 */
export function noMixerMap(identity = {}, { inService = false } = {}) {
  const { dev, label, isSimulated, firmware } = identity;
  const name = [label, dev].filter(Boolean).join(' ');
  const below = inService
    ? ' What it does report is each screen’s layer sizes and the room left, below.'
    : '';

  if (isSimulated === true) {
    return {
      title: 'No VPU on this simulator',
      hint:
        `The device says it is a simulator${name ? ` (${name}${firmware ? `, firmware ${firmware}` : ''})` : ''}, ` +
        'and it exposes no $vpuMixer collection. This simulator allocates nothing, so there is ' +
        'no mixer map to draw — the tool is working.',
    };
  }
  if (isSimulated === false || name) {
    const box = `${name || 'The device'}${firmware ? ` on firmware ${firmware}` : ''}`;
    if (isFirmware61(firmware)) {
      return {
        title: 'This firmware does not report its VPU allocation',
        hint:
          `${box} answers E12 for $vpuMixer. The VPU is there; firmware 6.1.x just does not say ` +
          'how its mixers are allocated, so there is no mixer map to draw — the tool is working.' +
          below,
      };
    }
    return {
      title: 'No VPU mixer map on this device',
      hint:
        `${box} answers E12 for $vpuMixer, so there is no mixer map to draw. An Aquilon C on ` +
        '6.2.73 reports one; an Aquilon RS4 on 6.1.60 does not.' + below,
    };
  }
  return {
    title: 'No VPU mixer map reported',
    hint:
      'Reached the device, but it exposes no $vpuMixer collection, so there is no mixer map to ' +
      'draw. A simulator answers this way, and so does LivePremier firmware 6.1.60 on hardware.' +
      below,
  };
}

/** Props on a screen's resource status. All readOnly. */
const SCREEN_STATUS_PROPS = [
  'mode',
  'mixingMode',
  'outputCount',
  'usedOutputCapabilities',
  'remainingOutputCapabilities',
  'exceedingOutputCapabilities',
  'layerCount',
  'exceedingLayerCapabilities',
  'isOptimized',
  'regionValidity',
  'isStereo3d',
];

/**
 * Per-screen resource status — how much of the box each screen is spending, and
 * whether it fits.
 *
 *   preconfig/resources/{current|new}/$screen/@items/S<n>/status/@props/…
 *
 * The two sides carry different props: only `new` has the `remaining…` and
 * `exceeding…` figures, because they are the answer to "would this configuration
 * fit", which is a question about the staged one.
 *
 * `isOptimized` is the one that changes how the link grid should be DRAWN.
 * Optimized mode is enabled when a screen uses at least 5 output links and at
 * least one layer of capacity 2 (§5.5.6), and it **removes the 4-link
 * scaling-engine boundary** — so the boundary line must not be drawn for a VPU
 * hosting an optimized screen. On the captured Aquilon C, S1 spends 6 output
 * capabilities and duly reports `isOptimized: true`.
 *
 * Screens that are not configured report `mode: 'DISABLED'` and are skipped, so
 * a typical box costs 24 reads plus a handful of full ones.
 */
export async function readScreenStatus(client, { which = 'current', max = 24 } = {}) {
  const out = {};
  for (let i = 1; i <= max; i++) {
    const id = `S${i}`;
    const b = `DeviceObject/preconfig/resources/${which}/$screen/@items/${id}/status/@props`;
    const mode = await client.tryGet(`${b}/mode`);
    if (mode === undefined) break;          // past the end of the model
    if (mode === 'DISABLED') continue;      // configured screens only
    const rec = { mode };
    for (const p of SCREEN_STATUS_PROPS) {
      if (p === 'mode') continue;
      const v = await client.tryGet(`${b}/${p}`);
      if (v !== undefined) rec[p] = v;
    }
    out[id] = rec;
  }
  return out;
}

/** NATIVE and layers 1-256: the slots a screen's resource layer list holds on 6.1.60. */
const RESOURCE_LAYER_KEYS = ['NATIVE', ...Array.from({ length: 256 }, (_, i) => String(i + 1))];

/**
 * What each screen in service spends, layer by layer, and what room it has
 * left — all that firmware 6.1.x says about its VPU.
 *
 *   preconfig/resources/{current|new}/$screen/@items/S<n>/$layer/@items/<k>/status/@props/capability
 *   preconfig/resources/new/$screen/@items/S<n>/$layerCapability/@items/<capa>
 *     /status/@props/{remainingLayerCapabilities,remainingLayerWithMaskCapabilities}
 *
 * An Aquilon RS4 on 6.1.60 (2026-10-16) answers E12 for `$vpuMixer`, and its
 * `$vpuLayer` scalers and `$pipe`s all read their enums' first values — the
 * vendor's own page never reads them. These per-screen figures are what it
 * does report: S1 two 4K layers, and staged, room for 19 more DUAL, 9 4K or
 * 4 5K. Every screen in service reported the same room, at two reads hours
 * apart, so it is the box's pool seen from that screen, not a share held for
 * it — the page says it once when every screen agrees. `room` is the staged
 * side's alone, like the other "would it fit" figures, and keeps the device's
 * order; it is `null` where the screen reports none (the running side, or no
 * `$layerCapability` at all), so "no figure" never reads as "no room". A
 * capability with no room is dropped: the RS4 lists `3` at 0 every time, a
 * capacity-3 layer (position is capacity in LAYER_CAPABILITIES) that 6.1.60
 * does not offer.
 *
 * A screen's list has 257 slots and few are on, so it is read only until
 * `layerCount` of them are found; NATIVE counts as one, as it does there.
 * The 6.1.60 simulator answers the same spellings (257 E12s). A 6.2.73 Aquilon
 * C carries these lists too; they are read only without a mixer map because
 * the map says more.
 *
 * @param {object} status this side's screenStatus (screens in service only)
 * @returns {object} by screen: `{layers: [{layer, capability}], room: null | [{capability, layers, withMask}]}`
 */
export async function readScreenLayers(client, { which = 'current', status = {} } = {}) {
  const out = {};
  for (const [id, st] of Object.entries(status)) {
    const b = `DeviceObject/preconfig/resources/${which}/$screen/@items/${id}`;
    const want = Number(st && st.layerCount);
    const layers = [];
    for (const key of RESOURCE_LAYER_KEYS) {
      if (Number.isFinite(want) && layers.length >= want) break;
      const capability = await client.tryGet(`${b}/$layer/@items/${key}/status/@props/capability`);
      if (capability === undefined) break; // past the end, or not this firmware's spelling
      if (capability && capability !== 'OFF') layers.push({ layer: key, capability: String(capability) });
    }
    let room = null;
    if (which === 'new') {
      for (const capability of LAYER_CAPABILITIES) {
        if (capability === 'OFF') continue;
        const c = `${b}/$layerCapability/@items/${capability}/status/@props`;
        const raw = await client.tryGet(`${c}/remainingLayerCapabilities`);
        if (raw === undefined) continue; // not a capability this box lists
        room ??= [];
        const count = Number(raw);
        if (!(count > 0)) continue;
        const withMask = Number(await client.tryGet(`${c}/remainingLayerWithMaskCapabilities`)) || 0;
        room.push({ capability, layers: count, withMask });
      }
    }
    out[id] = { layers, room };
  }
  return out;
}

/**
 * The operator's own names for each screen — "Main LED", "Stream ENG" — which
 * make every other view readable. 24 cheap reads.
 *
 *   DeviceObject/$screen/@items/S<1-24>/control/@props/label
 *
 * Note it is `$screen`, not `$screenAuxGroup`: the latter has a `control` node
 * but no `label` on it (that one answers E12). Unconfigured screens return an
 * empty string, and S25 answers E12, which is how the range is known.
 *
 * These are show data — a client's screen names — so they belong in the live
 * view only. They are deliberately absent from the recorded captures in `data/`
 * and from `scripts/profile-vpu.mjs`, both of which are public.
 */
export async function readScreenNames(client, max = 24) {
  const names = {};
  for (let i = 1; i <= max; i++) {
    const label = await client.tryGet(`DeviceObject/$screen/@items/S${i}/control/@props/label`);
    if (typeof label === 'string' && label.trim()) names[`S${i}`] = label.trim();
  }
  return names;
}

/** What is read off each output — the header over the grid's columns. */
const OUTPUT_PROPS = {
  screen: 'canvas/status/@props/usedInScreenAux',
  region: 'canvas/status/@props/usedInRegion',
  capability: 'canvas/status/@props/capability',
  label: 'control/@props/label',
  card: 'mapping/@props/card',
  physical: 'mapping/@props/physical',
  type: '$plug/@items/1/status/@props/type',
};

/**
 * Every output the device has, and which screen, region and plug it is — so the
 * grid can say which output each of a screen's links is (`screenOutputLinks`).
 *
 *   DeviceObject/$output/@items/<n>/canvas/status/@props/{usedInScreenAux,usedInRegion,capability}
 *   DeviceObject/$output/@items/<n>/control/@props/label
 *   DeviceObject/$output/@items/<n>/mapping/@props/{card,physical}
 *   DeviceObject/$output/@items/<n>/$plug/@items/1/status/@props/type
 *
 * These spellings are the store's (`outputList` is `$output`, `plugList` is
 * `$plug`, `pp` is `@props`), the same correspondence the mixer paths above
 * follow — but unlike those, they have NOT been answered by hardware: the
 * Aquilon C was gone before the outputs were read. Every read is a tryGet, so a
 * firmware that spells them differently costs one E12 per output and the header
 * is simply absent. An output assigned to no screen is one cheap read; only the
 * assigned ones are read in full.
 *
 * @returns {object} by output number: `{screen, region, capability, label, card, physical, type}`
 */
export async function readOutputs(client, { max = 24 } = {}) {
  const out = {};
  for (let i = 1; i <= max; i++) {
    const b = `DeviceObject/$output/@items/${i}`;
    const screen = await client.tryGet(`${b}/${OUTPUT_PROPS.screen}`);
    if (screen === undefined) continue; // not fitted, or not this firmware's spelling
    const rec = { screen };
    if (!/^S\d+$/.test(String(screen))) {
      out[i] = rec; // unassigned, or an aux: costs no VPU, so nothing more to know
      continue;
    }
    for (const [k, rel] of Object.entries(OUTPUT_PROPS)) {
      if (k === 'screen') continue;
      const v = await client.tryGet(`${b}/${rel}`);
      if (v !== undefined && v !== null && v !== '') rec[k] = v;
    }
    out[i] = rec;
  }
  return out;
}

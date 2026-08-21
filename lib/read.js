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

import { MIXER_IDS, MIXER_PROPS, SCALERS, OUT_PIPES } from '../public/vpu.js';

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
 * collection — that is a device without a VPU map (the simulator behaves this
 * way), and is worth telling the user plainly rather than showing an empty grid.
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

/** Device identity. Cheap, and confirms we are talking to a LivePremier. */
export async function readIdentity(client) {
  const p = 'DeviceObject/system/$device/@items/1/@props';
  return {
    dev: await client.tryGet(`${p}/dev`),
    label: await client.tryGet(`${p}/label`),
  };
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

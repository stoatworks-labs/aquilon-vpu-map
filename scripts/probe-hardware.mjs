#!/usr/bin/env node
//
// Hardware probe — how much of the 8x8 link grid does the device actually report?
//
// Answered 2026-08-21 on an Aquilon C: COLUMNS yes (mixerAllocation.usedOnOutPipe1..8),
// ROWS no. Re-run it on new firmware, a Link setup, or a busier chassis.
//
// READS ONLY. Two HTTP GETs and a set of AWJ `get`s. Nothing is written to the
// device — no `replace`, no Subscriptions, no HTTP verb other than GET.
//
//   node scripts/probe-hardware.mjs 192.168.2.140 [--out probe-out]
//
// Leaves a directory of artefacts behind; attach it to the session and the
// analysis can be done offline.

import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';

import { AwjClient } from '../lib/awj.js';
import { MIXER_IDS } from '../public/vpu.js';

const arg = process.argv[2];
const outIdx = process.argv.indexOf('--out');
const OUT = outIdx > -1 ? process.argv[outIdx + 1] : 'probe-out';

if (!arg || arg.startsWith('--')) {
  console.error('usage: node scripts/probe-hardware.mjs <ip>[:httpPort] [--out dir]');
  console.error('  a real device serves HTTP on 80; the simulator uses 3000');
  process.exit(2);
}

// AWJ is always 10606; only the HTTP port varies (80 on hardware, 3000 on the sim).
const [host, httpPortRaw] = arg.split(':');
const httpPort = httpPortRaw ? Number(httpPortRaw) : 80;
const httpBase = `http://${host}${httpPort === 80 ? '' : ':' + httpPort}`;

const log = (...a) => console.log(...a);
const save = async (name, data) => {
  const p = path.join(OUT, name);
  await fs.writeFile(p, typeof data === 'string' ? data : JSON.stringify(data, null, 1));
  const { size } = await fs.stat(p);
  log(`    saved ${name} (${(size / 1024).toFixed(1)} KB)`);
};

await fs.mkdir(OUT, { recursive: true });

/* ------------------------------------------------------------------ */
/* STEP 1 — the whole device store over HTTP.                          */
/* This is the highest-value probe: it contains the entire resources    */
/* subtree in one response, so nothing has to be guessed path by path.  */
/* On the simulator the full store is ~124 MB, of which resources is    */
/* ~3 MB, so we stream it and keep only the part we need.               */
/* ------------------------------------------------------------------ */

log(`\n[1/5] GET ${httpBase}/api/stores/device  (large — streaming)`);
let store = null;
try {
  const res = await fetch(`${httpBase}/api/stores/device`, {
    headers: { accept: 'application/json' },
  });
  log(`    HTTP ${res.status}, content-length ${res.headers.get('content-length') || '?'}`);
  const text = await res.text();
  log(`    received ${(text.length / 1048576).toFixed(1)} MB`);
  store = JSON.parse(text);
  const resources = store?.device?.preconfig?.resources;
  if (resources) {
    await save('resources-subtree.json', resources);
    log('    ✓ resources subtree captured — THIS IS THE KEY ARTEFACT');
  } else {
    log('    ✗ no device.preconfig.resources in the store');
    await save('store-toplevel-keys.json', Object.keys(store?.device || store || {}));
  }
} catch (err) {
  log(`    ✗ failed: ${err.message}`);
  log('      (if this fails, steps 2-4 still stand on their own)');
}

/* What sits alongside vpuMixerList? The answer differs by implementation:
   hardware has ONLY `vpuMixerList`; the simulator has `pipeList` and
   `vpuLayerList` and no mixer list. Worth re-checking on every new firmware —
   a collection appearing here is the cheapest possible discovery. */
if (store) {
  try {
    const items = store.device.preconfig.resources.current.status.mapping.deviceList.items;
    const summary = {};
    for (const [dev, obj] of Object.entries(items)) {
      summary[dev] = {};
      for (const [k, v] of Object.entries(obj)) {
        const inner = v && v.items ? Object.keys(v.items) : null;
        summary[dev][k] = {
          keys: v && typeof v === 'object' ? Object.keys(v) : typeof v,
          itemCount: inner ? inner.length : null,
          firstItems: inner ? inner.slice(0, 4) : null,
          firstItemShape:
            inner && inner.length ? Object.keys(v.items[inner[0]] || {}) : null,
        };
      }
    }
    await save('mapping-shape.json', summary);
    log('    collections under mapping/deviceList/items:');
    for (const [dev, cols] of Object.entries(summary)) {
      log(`      device ${dev}: ${Object.keys(cols).join(', ')}`);
    }
  } catch (err) {
    log(`    (could not summarise mapping: ${err.message})`);
  }
}

/* ------------------------------------------------------------------ */
/* STEP 2 — does the HTTP API send CORS headers on real hardware?       */
/* Settles whether a browser-hosted tool is possible. Measured on the   */
/* simulator as "no ACAO"; confirm on the box.                          */
/* ------------------------------------------------------------------ */

log(`\n[2/5] CORS check (does a hosted page stand any chance?)`);
for (const p of ['/api/stores/device', '/api/device/snapshots/inputs/1']) {
  try {
    const res = await fetch(`${httpBase}${p}`, {
      method: 'HEAD',
      headers: { Origin: 'https://vpu.stoatworks-labs.com' },
    });
    const acao = res.headers.get('access-control-allow-origin');
    log(`    ${p}  HTTP ${res.status}  ACAO=${acao ?? 'ABSENT'}  Vary=${res.headers.get('vary') ?? '-'}`);
  } catch (err) {
    log(`    ${p}  failed: ${err.message}`);
  }
}
// Does the device offer HTTPS at all? If 443 answers, a hosted page becomes possible.
await new Promise((resolve) => {
  const s = net.createConnection({ host, port: 443, timeout: 3000 });
  s.on('connect', () => { log('    port 443: OPEN  → wss:// may be possible'); s.destroy(); resolve(); });
  s.on('timeout', () => { log('    port 443: no answer'); s.destroy(); resolve(); });
  s.on('error', () => { log('    port 443: CLOSED → no HTTPS, no wss://'); resolve(); });
});

/* ------------------------------------------------------------------ */
/* STEP 3 — AWJ existence sweep for the collections we have never read. */
/* E12 is a free path-existence oracle.                                 */
/* ------------------------------------------------------------------ */

log(`\n[3/5] AWJ path-existence sweep on ${host}:10606`);
const M = 'DeviceObject/preconfig/resources/current/status/mapping/$device/@items/1';
const R = 'DeviceObject/preconfig/resources/current';

const candidates = [
  // $vpuLayer looked like the 8x8 grid but is a dead end: E12 on hardware,
  // present-but-empty on the simulator. Kept in the sweep so a future firmware
  // that starts populating it shows up immediately.
  `${M}/$vpuLayer/@items/PROC_1_SCALER_1/@props/isAvailable`,
  `${M}/$vpuLayer/@items/PROC_1_SCALER_1/@props/capability`,
  `${M}/$vpuLayer/@items/PROC_1_SCALER_1/@props/usedInScreen`,
  `${M}/$vpuLayer/@items/PROC_1_SCALER_1/@props/usedInLayer`,
  `${M}/$vpuLayer/@items/PROC_1_SCALER_1/scalerAllocation/@props/usedOnOutPipe1`,
  `${M}/$vpuLayer/@items/PROC_1_SCALER_1/scalerAllocation/@props/usedOnOutPipe8`,
  `${M}/$pipe/@items/1/@props/isUsed`,
  `${M}/$pipe/@items/64/@props/isUsed`,
  // Grid coordinates we hope exist on the mixer itself.
  `${M}/$vpuMixer/@items/PROC_1_MIXER_1/@props/row`,
  `${M}/$vpuMixer/@items/PROC_1_MIXER_1/@props/column`,
  `${M}/$vpuMixer/@items/PROC_1_MIXER_1/@props/position`,
  `${M}/$vpuMixer/@items/PROC_1_MIXER_1/@props/linkIndex`,
  `${M}/$vpuMixer/@items/PROC_1_MIXER_1/@props/inputLink`,
  `${M}/$vpuMixer/@items/PROC_1_MIXER_1/@props/outputLink`,
  `${M}/$vpuMixer/@items/PROC_1_MIXER_1/@props/vpu`,
  `${M}/$vpuMixer/@items/PROC_1_MIXER_1/@props/scalingEngine`,
  `${M}/$vpuMixer/@items/PROC_1_MIXER_1/@props/optimized`,
  // Per-output, per-layer status: an output x layer matrix would BE the grid.
  `${R}/$output/@items/1/status/$layer/@items/1/@props`,
  `${R}/$output/@items/1/status/@props`,
  `${R}/$output/@items/1/status/helper/@props`,
  // Per-screen, per-layer.
  `${R}/$screen/@items/S1/$layer/@items/1/status/@props`,
  `${R}/$screen/@items/S1/status/@props`,
  `${R}/status/@props`,
  // Optimized mode / capability counts (manual 5.5.6).
  `DeviceObject/preconfig/resources/new/$screen/@items/S1/$layerCapability/@items/1/status/@props`,
];

const client = new AwjClient({ host, port: 10606, timeout: 5000 });
const sweep = {};
try {
  await client.connect();
  log('    connected');
  for (const p of candidates) {
    try {
      const v = await client.get(p);
      sweep[p] = { exists: true, value: v };
      log(`    ✓ ${p.replace('DeviceObject/preconfig/resources/', '…/')} = ${JSON.stringify(v).slice(0, 90)}`);
    } catch (err) {
      sweep[p] = { exists: false, code: err.code };
      if (err.code !== 'E12') log(`    ? ${p} → ${err.code || err.message}`);
    }
  }
  const found = Object.entries(sweep).filter(([, v]) => v.exists);
  log(`    ${found.length} of ${candidates.length} candidate paths exist`);

  /* ---------------------------------------------------------------- */
  /* STEP 4 — full re-capture of the mixer table, including `channel`.  */
  /* On the captured Aquilon C every mixer read channel=0; if a busier  */
  /* box shows channel varying, channel is likely the grid row.         */
  /* ---------------------------------------------------------------- */
  log(`\n[4/5] Re-reading the mixer table (channel/slice distribution)`);
  const mixers = {};
  for (const id of MIXER_IDS) {
    const b = `${M}/$vpuMixer/@items/${id}`;
    const avail = await client.tryGet(`${b}/@props/isAvailable`);
    if (avail !== true) { mixers[id] = { isAvailable: false }; continue; }
    mixers[id] = {
      isAvailable: true,
      isEnabled: await client.tryGet(`${b}/@props/isEnabled`),
      usedInScreen: await client.tryGet(`${b}/@props/usedInScreen`),
      usedInLayer: await client.tryGet(`${b}/@props/usedInLayer`),
      channel: await client.tryGet(`${b}/@props/channel`),
      slice: await client.tryGet(`${b}/@props/slice`),
      capability: await client.tryGet(`${b}/@props/capability`),
      seamlessCapa: await client.tryGet(`${b}/@props/seamlessCapa`),
      pipe1: await client.tryGet(`${b}/mixerAllocation/@props/usedOnOutPipe1`),
      pipe2: await client.tryGet(`${b}/mixerAllocation/@props/usedOnOutPipe2`),
    };
  }
  await save('mixers.json', mixers);
  await save('awj-sweep.json', sweep);

  const en = Object.values(mixers).filter((m) => m.isEnabled);
  const uniq = (k) => [...new Set(en.map((m) => m[k]))].sort();
  log(`    fitted ${Object.values(mixers).filter((m) => m.isAvailable).length}, enabled ${en.length}`);
  log(`    distinct channel values : ${JSON.stringify(uniq('channel'))}`);
  log(`    distinct slice values   : ${JSON.stringify(uniq('slice'))}`);
  log(`    distinct capability     : ${JSON.stringify(uniq('capability'))}`);
  log(`    distinct pipe1 / pipe2  : ${JSON.stringify(uniq('pipe1'))} / ${JSON.stringify(uniq('pipe2'))}`);

  /* ---------------------------------------------------------------- */
  /* STEP 5 — THE ONE THAT MATTERS.                                    */
  /* $vpuLayer is the 8x8 link grid: 8 scalers per VPU (the rows) each  */
  /* declaring which of 8 output pipes it drives (the columns). If      */
  /* these populate on hardware, the grid view is reported data rather  */
  /* than a derived guess.                                              */
  /* ---------------------------------------------------------------- */
  log(`\n[5/5] Reading the $vpuLayer link grid (32 scalers x 8 pipes)`);
  const scalers = {};
  for (let p = 1; p <= 4; p++) {
    for (let s = 1; s <= 8; s++) {
      const id = `PROC_${p}_SCALER_${s}`;
      const b = `${M}/$vpuLayer/@items/${id}`;
      const rec = {
        isAvailable: await client.tryGet(`${b}/@props/isAvailable`),
        isEnabled: await client.tryGet(`${b}/@props/isEnabled`),
        capability: await client.tryGet(`${b}/@props/capability`),
        usedInScreen: await client.tryGet(`${b}/@props/usedInScreen`),
        usedInLayer: await client.tryGet(`${b}/@props/usedInLayer`),
        pipes: {},
      };
      for (let k = 1; k <= 8; k++) {
        rec.pipes[k] = await client.tryGet(`${b}/scalerAllocation/@props/usedOnOutPipe${k}`);
      }
      scalers[id] = rec;
    }
  }
  await save('vpu-layers.json', scalers);

  const pipes = {};
  for (let i = 1; i <= 64; i++) {
    pipes[i] = await client.tryGet(`${M}/$pipe/@items/${i}/@props/isUsed`);
  }
  await save('pipes.json', pipes);

  const live = Object.entries(scalers).filter(([, s]) => s.isAvailable === true);
  const on = live.filter(([, s]) => s.isEnabled === true);
  const withPipes = Object.entries(scalers).filter(([, s]) =>
    Object.values(s.pipes).some((v) => v && v !== 'NONE'),
  );
  log(`    scalers available : ${live.length} / 32`);
  log(`    scalers enabled   : ${on.length}`);
  log(`    scalers driving >=1 output pipe : ${withPipes.length}`);
  log(`    pipes marked isUsed : ${Object.values(pipes).filter(Boolean).length} / 64`);
  log('');
  if (withPipes.length) {
    log('    *** POPULATED — the device reports real link placement. ***');
    log('    row = scaler (layer link), columns = output pipes it drives:');
    for (const [id, s] of withPipes.slice(0, 12)) {
      const cols = Object.entries(s.pipes)
        .filter(([, v]) => v && v !== 'NONE')
        .map(([k, v]) => `${k}->${v}`)
        .join(' ');
      log(`      ${id.padEnd(18)} ${String(s.usedInScreen).padEnd(4)} ${String(s.usedInLayer).padEnd(7)} cap ${String(s.capability).padEnd(5)} ${cols}`);
    }
    if (withPipes.length > 12) log(`      … and ${withPipes.length - 12} more (see vpu-layers.json)`);
  } else {
    log('    *** NO $vpuLayer DATA. ***');
    log('    On hardware this collection does not exist at all (E12); on the simulator');
    log('    it exists but is permanently empty. Either way it is not the grid.');
    log('    Columns come from mixerAllocation.usedOnOutPipe1..8 instead — see step 4.');
  }
} catch (err) {
  log(`    ✗ ${err.message}`);
} finally {
  client.close();
}

log(`\nDone. Artefacts in ./${OUT}/`);
log('Nothing was written to the device.');

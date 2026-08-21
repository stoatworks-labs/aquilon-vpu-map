#!/usr/bin/env node
/*
 * ============================================================================
 *  LivePremier VPU profiler                      github.com/stoatworks-labs
 *                                                    /aquilon-vpu-map
 *
 *  Records how YOUR Aquilon has allocated its VPU mixers, so that the shape of
 *  real-world configurations can be understood across more than one chassis.
 *
 *  ------------------------------------------------------------------------
 *  THIS SCRIPT ONLY READS. It cannot change anything on your device.
 *
 *  It speaks Analog Way's AWJ protocol, which has exactly two verbs: `get` and
 *  the writing one. This script never sends the writing one.
 *
 *  You do not have to take that on trust. There is exactly ONE line in this
 *  file that sends anything to your device — search for `sock.write` and you
 *  will find a single hit, hard-coded to `op: 'get'`. There is no code path
 *  that builds any other verb. It does not subscribe, it uploads nothing
 *  anywhere, and the only file it writes is a .json in this directory.
 *
 *  It is safe to run on a live system, though if you are mid-show you may as
 *  well wait for a gap. It makes a few thousand small reads over about five
 *  seconds.
 *  ------------------------------------------------------------------------
 *
 *  USAGE
 *      node profile-vpu.mjs 192.168.1.50
 *      node profile-vpu.mjs 192.168.1.50 --note "Aquilon RS4, 2 screens 4K"
 *
 *  Needs Node 18 or newer. No installation, no dependencies, one file.
 *
 *  It writes  vpu-profile-<model>-<timestamp>.json  and prints a summary.
 *  Read the file, then attach it to an issue if you are happy to share it:
 *      https://github.com/stoatworks-labs/aquilon-vpu-map/issues
 *
 *  WHAT IT RECORDS
 *      device model (e.g. NLC_C), and how many VPUs are fitted
 *      for each VPU mixer: which screen and layer it serves, its slice,
 *          capability, channel, cut & fill, and which output links it drives
 *      the same for the staged ("new") configuration, if one differs
 *      whether a handful of protocol paths exist on your firmware
 *
 *  WHAT IT DOES NOT RECORD
 *      your device's address, serial number or hostname
 *      screen names, input names, labels, or anything else you have typed
 *      any picture, any signal, any audio
 *
 *  Screens appear only as S1..S24 and mixers as PROC_n_MIXER_n. There is
 *  nothing in the output that identifies you, your client, or your show.
 * ============================================================================
 */

import net from 'node:net';
import fs from 'node:fs/promises';

/* --------------------------------------------------------------- arguments */

const args = process.argv.slice(2);
const host = args.find((a) => !a.startsWith('--'));
const noteIdx = args.indexOf('--note');
const note = noteIdx > -1 ? args[noteIdx + 1] : '';
const full = args.includes('--full');

if (!host || args.includes('--help') || args.includes('-h')) {
  console.log(`
LivePremier VPU profiler — reads only, never writes.

  node profile-vpu.mjs <ip> [--note "what this box is"] [--full]

  --note   a line of context, e.g. "Aquilon RS4, 3 screens, one 8K layer".
           Helpful, entirely optional, and included verbatim in the output.
  --full   also fetch the device's whole configuration store over HTTP.
           This is a LARGE download (~120 MB) — off by default. Only use it
           on a quiet network, and only if asked for it.
`);
  process.exit(host ? 0 : 2);
}

/* -------------------------------------------------- minimal AWJ get client */
/* AWJ: TCP 10606, one JSON object per message, terminated by the byte 0x04.  */

const EOT = 0x04;

class Awj {
  constructor(hostname, port = 10606, timeout = 8000) {
    Object.assign(this, { hostname, port, timeout, buf: Buffer.alloc(0), queue: [] });
  }

  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.hostname, port: this.port });
      sock.setNoDelay(true);
      const fail = (e) => { sock.destroy(); reject(e); };
      const timer = setTimeout(() => fail(new Error('timed out connecting')), this.timeout);

      sock.once('connect', () => {
        clearTimeout(timer);
        sock.removeListener('error', fail);
        this.sock = sock;
        sock.on('data', (chunk) => {
          this.buf = Buffer.concat([this.buf, chunk]);
          let i;
          while ((i = this.buf.indexOf(EOT)) !== -1) {
            const raw = this.buf.subarray(0, i).toString('utf8');
            this.buf = this.buf.subarray(i + 1);
            const waiter = this.queue.shift();
            if (!waiter) continue;
            clearTimeout(waiter.timer);
            try {
              const msg = JSON.parse(raw);
              if (msg.error) waiter.resolve({ error: msg.error.code });
              else waiter.resolve({ value: msg.value });
            } catch {
              waiter.resolve({ error: 'BADFRAME' });
            }
          }
        });
        sock.on('error', () => this.flush('SOCKET'));
        sock.on('close', () => this.flush('CLOSED'));
        resolve(this);
      });
      sock.once('error', fail);
    });
  }

  flush(code) {
    const q = this.queue; this.queue = [];
    for (const w of q) { clearTimeout(w.timer); w.resolve({ error: code }); }
  }

  /** Send one `get`. Never anything else. */
  get(path) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ error: 'TIMEOUT' }), this.timeout);
      this.queue.push({ resolve, timer });
      this.sock.write(JSON.stringify({ op: 'get', path }) + '\x04');
    });
  }

  async value(path) {
    const r = await this.get(path);
    return r.error ? undefined : r.value;
  }

  close() { if (this.sock) this.sock.destroy(); }
}

/* ------------------------------------------------------------------- model */

const PROCS = 4;
const MIXERS = 16;
const PIPES = 8;
const PROPS = [
  'isEnabled', 'usedInScreen', 'usedInLayer',
  'channel', 'slice', 'capability', 'cutnfillCapa', 'seamlessCapa',
];

const mapping = (which, dev) =>
  `DeviceObject/preconfig/resources/${which}/status/mapping/$device/@items/${dev}`;

async function readDevice(awj, dev, which) {
  const mixers = {};
  let sawAny = false;

  for (let p = 1; p <= PROCS; p++) {
    for (let m = 1; m <= MIXERS; m++) {
      const id = `PROC_${p}_MIXER_${m}`;
      const b = `${mapping(which, dev)}/$vpuMixer/@items/${id}`;
      const avail = await awj.value(`${b}/@props/isAvailable`);
      if (avail === undefined) return sawAny ? mixers : null; // no subtree here
      sawAny = true;
      if (avail !== true) { mixers[id] = { isAvailable: false }; continue; }

      const rec = { isAvailable: true };
      for (const prop of PROPS) rec[prop] = await awj.value(`${b}/@props/${prop}`);
      rec.pipes = {};
      for (let k = 1; k <= PIPES; k++) {
        const v = await awj.value(`${b}/mixerAllocation/@props/usedOnOutPipe${k}`);
        if (v !== undefined && v !== 'NONE') rec.pipes[k] = v;
      }
      mixers[id] = rec;
    }
  }
  return mixers;
}

/* ----------------------------------------------------------------- summary */

function describe(mixers) {
  const all = Object.values(mixers || {});
  const on = all.filter((m) => m.isEnabled);
  const uniq = (k) => [...new Set(on.map((m) => m[k]))].sort();

  const runs = new Map();
  for (const m of on) {
    const key = `${m.usedInScreen} ${m.usedInLayer}`;
    if (!runs.has(key)) runs.set(key, { screen: m.usedInScreen, layer: m.usedInLayer, n: 0, links: Object.keys(m.pipes).map(Number) });
    runs.get(key).n++;
  }

  return {
    fitted: all.filter((m) => m.isAvailable).length,
    enabled: on.length,
    screens: [...new Set(on.map((m) => m.usedInScreen))].sort(),
    capabilities: uniq('capability'),
    channels: uniq('channel'),
    slices: uniq('slice'),
    cutnfill: uniq('cutnfillCapa'),
    runs: [...runs.values()],
  };
}

/* -------------------------------------------------------------------- main */

console.log(`\nLivePremier VPU profiler — reads only, never writes.`);
console.log(`Connecting to ${host}:10606 …`);

const awj = new Awj(host);
try {
  await awj.connect();
} catch (err) {
  console.error(`\n  Could not connect: ${err.message}`);
  console.error('  • Is the address right, and the device on this network?');
  console.error('  • AWJ (TCP 10606) can be switched off in the Web RCS security');
  console.error('    settings — check there before assuming the script is broken.');
  process.exit(1);
}

const sys = 'DeviceObject/system/$device/@items/1/@props';
const model = await awj.value(`${sys}/dev`);
console.log(`  connected — model ${model ?? 'unknown'}`);

if (model === undefined) {
  console.log('\n  This does not answer like a LivePremier. Profiling anyway.');
}

// Which of the collections that are known to vary exist on this firmware?
const probe = {};
for (const [name, path] of [
  ['vpuMixer', `${mapping('current', 1)}/$vpuMixer/@items/PROC_1_MIXER_1/@props/isAvailable`],
  ['vpuLayer', `${mapping('current', 1)}/$vpuLayer/@items/PROC_1_SCALER_1/@props/isAvailable`],
  ['pipe', `${mapping('current', 1)}/$pipe/@items/1/@props/isUsed`],
]) {
  probe[name] = (await awj.get(path)).error ? false : true;
}

const devices = {};
for (let dev = 1; dev <= 4; dev++) {
  process.stdout.write(`  reading device ${dev} … `);
  const current = await readDevice(awj, dev, 'current');
  if (!current) { console.log('no such device'); continue; }
  const d = describe(current);
  // Followers that are not fitted still answer every path, with isAvailable
  // false throughout. That is an absent device, not a Link member.
  if (d.fitted === 0) { console.log('nothing fitted'); continue; }
  const staged = await readDevice(awj, dev, 'new');
  devices[dev] = { current, new: staged };
  console.log(`${d.fitted} mixers fitted, ${d.enabled} in use`);
}
awj.close();

if (!Object.keys(devices).length) {
  console.log('\n  No VPU mixer map on this device.');
  console.log('  The LivePremier simulator behaves this way — it has no processor');
  console.log('  boards to map. On real hardware this would be unexpected; a profile');
  console.log('  recording that is still worth sending.');
}

/* Optional, off by default: the whole configuration store over HTTP. Large. */
let store;
if (full) {
  console.log('\n  --full: downloading the configuration store (this is large) …');
  try {
    const res = await fetch(`http://${host}/api/stores/device`);
    const text = await res.text();
    console.log(`  received ${(text.length / 1048576).toFixed(1)} MB`);
    store = JSON.parse(text)?.device?.preconfig?.resources;
  } catch (err) {
    console.log(`  could not fetch it: ${err.message}`);
  }
}

const profile = {
  $schema: 'aquilon-vpu-map/profile/1',
  generatedAt: new Date().toISOString(),
  note,
  model: model ?? null,
  pathsPresent: probe,
  devices,
  ...(store ? { resources: store } : {}),
};

const stamp = new Date().toISOString().slice(0, 19).split(':').join('-');
const file = `vpu-profile-${(model ?? 'unknown').toLowerCase()}-${stamp}.json`;
await fs.writeFile(file, JSON.stringify(profile, null, 1));

/* ----------------------------------------------------------------- report */

console.log(`\n${'='.repeat(68)}`);
console.log(`Saved ${file}`);
console.log('='.repeat(68));

for (const [dev, d] of Object.entries(devices)) {
  const s = describe(d.current);
  console.log(`\nDevice ${dev}${dev === '1' ? ' (master)' : ' (follower)'}`);
  console.log(`  mixers fitted   ${s.fitted} of 64   in use ${s.enabled}`);
  console.log(`  screens         ${s.screens.join(', ') || '—'}`);
  console.log(`  capabilities    ${s.capabilities.join(', ') || '—'}`);
  console.log(`  channel values  ${JSON.stringify(s.channels)}`);
  console.log(`  cut & fill capa ${s.cutnfill.join(', ') || '—'}`);
  for (const r of s.runs) {
    console.log(`    ${String(r.screen).padEnd(4)} ${String(r.layer).padEnd(7)} ` +
      `${String(r.n).padStart(2)} mixers   output links ${JSON.stringify(r.links)}`);
  }
  // A staged config often differs ONLY in which links it uses, so compare the
  // whole record rather than just the properties.
  const n = Object.keys(d.current).filter(
    (k) => JSON.stringify(d.current[k]) !== JSON.stringify((d.new || {})[k]),
  ).length;
  console.log(`  staged config   ${n ? `DIFFERS from running (${n} mixers)` : 'matches running'}`);
}

// Call out the things that are genuinely unknown, so a contributor can see
// at a glance whether their box tells us something new.
const every = Object.values(devices).map((d) => describe(d.current));
const caps = [...new Set(every.flatMap((d) => d.capabilities))];
const chans = [...new Set(every.flatMap((d) => d.channels))];
const notable = [];
if (Object.keys(devices).length > 1) notable.push(`a Link setup: ${Object.keys(devices).length} devices fitted`);
if (caps.some((c) => c !== '4K')) notable.push(`capabilities beyond 4K: ${caps.join(', ')}`);
if (chans.some((c) => c !== 0)) notable.push(`channel values other than 0: ${JSON.stringify(chans)}`);
const cnf = [...new Set(every.flatMap((d) => d.cutnfill).filter((c) => c && c !== 'OFF'))];
if (cnf.length && cnf.some((c) => c !== '4K')) notable.push(`cutnfillCapa values beyond 4K: ${cnf.join(', ')}`);
if (every.some((d) => d.runs.some((r) => r.links.length > 4))) notable.push('a layer over more than 4 output links');
if (probe.vpuLayer) notable.push('a populated $vpuLayer collection');

console.log(`\n${'='.repeat(68)}`);
if (notable.length) {
  console.log('This configuration shows something not seen before:');
  for (const n of notable) console.log(`  • ${n}`);
} else {
  console.log('This configuration looks like the one already recorded.');
  console.log('Still useful — it confirms the common case on another chassis.');
}
console.log(`
The file above contains no addresses, names or labels — only the structure
printed here. Have a look at it, and if you are happy to share:

  https://github.com/stoatworks-labs/aquilon-vpu-map/issues

Nothing was written to your device.`);

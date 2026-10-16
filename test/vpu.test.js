// Tests run against the recorded capture from a real Aquilon C, so the numbers
// asserted here are the ones the hardware actually reported.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { summarise, diff, MIXER_IDS, MAX_MIXERS, parseMixerId } from '../public/vpu.js';
import { AwjClient } from '../lib/awj.js';
import {
  readMapping, readIdentity, readOutputs, readScreenStatus, readScreenLayers, noMixerMap,
} from '../lib/read.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const snapshot = JSON.parse(
  fs.readFileSync(path.join(HERE, '..', 'data', 'aquilon-c-snapshot.json'), 'utf8'),
);

test('the model describes 4 processors of 16 mixers', () => {
  assert.equal(MAX_MIXERS, 64);
  assert.equal(MIXER_IDS.length, 64);
  assert.deepEqual(parseMixerId('PROC_3_MIXER_12'), { processor: 3, index: 12 });
  assert.equal(parseMixerId('nonsense'), null);
});

test('summarise reproduces the captured Aquilon C', () => {
  const s = summarise(snapshot.current);
  assert.equal(s.fitted, 32, '32 of 64 mixers fitted');
  assert.equal(s.enabled, 28, '28 enabled');
  assert.equal(s.spare, 4, '4 spare');
  assert.equal(s.screens, 4, 'S1..S4');

  // Two processor boards fitted, two absent.
  assert.deepEqual(
    s.processors.map((p) => p.fitted),
    [16, 16, 0, 0],
  );
});

test('a layer costs a run of mixers, one per slice', () => {
  const s = summarise(snapshot.current);
  const byKey = new Map(s.allocations.map((a) => [`${a.screen} ${a.layer}`, a]));

  const s3native = byKey.get('S3 NATIVE');
  assert.ok(s3native, 'S3 native background is allocated');
  assert.equal(s3native.mixers.length, 8, 'S3 native spans 8 mixers');
  assert.deepEqual(s3native.slices, [0, 1, 2, 3, 4, 5, 6, 7], 'one per slice, in order');

  const s3layer1 = byKey.get('S3 1');
  assert.equal(s3layer1.mixers.length, 4, 'S3 layer 1 spans 4');

  // Every allocation has exactly one mixer per slice.
  for (const a of s.allocations) {
    assert.equal(new Set(a.slices).size, a.slices.length, `${a.screen} ${a.layer}: slices unique`);
  }
});

test('all eight output pipes are read, and NONE is not a pipe', () => {
  const s = summarise(snapshot.current);
  const byKey = new Map(s.allocations.map((a) => [`${a.screen} ${a.layer}`, a]));

  // Straight off the hardware: runs sit on non-adjacent, interleaved links.
  assert.deepEqual(byKey.get('S1 NATIVE').pipes, ['link 1\u2192out 1', 'link 3\u2192out 2']);
  assert.deepEqual(byKey.get('S3 NATIVE').pipes, ['link 2\u2192out 1', 'link 4\u2192out 2']);
  assert.deepEqual(byKey.get('S2 NATIVE').pipes, ['link 5\u2192out 1', 'link 7\u2192out 2']);

  // Every run reports exactly two links here, never eight — NONE is skipped.
  for (const a of s.allocations) assert.equal(a.pipes.length, 2, `${a.screen} ${a.layer}`);
});

test('diff catches a staged change that is only in the output links', () => {
  // The captured device has a real pending re-allocation: the running map puts
  // screen output 2 on link 3, the staged one moves it to link 2. Nothing else
  // differs — no property changes at all — so comparing only @props reports
  // "no staged changes", which is exactly the bug this guards.
  const changes = diff(snapshot.current, snapshot.new);
  assert.equal(changes.length, 28, 'every enabled mixer moves');

  const first = changes.find((c) => c.mixer === 'PROC_1_MIXER_1');
  assert.deepEqual(first.changed, [
    { prop: 'link 2', from: '\u2014', to: '2' },
    { prop: 'link 3', from: '2', to: '\u2014' },
  ]);

  // No mixer changes a property; the whole difference is link allocation.
  const props = changes.flatMap((c) => c.changed).filter((d) => !d.prop.startsWith('link '));
  assert.deepEqual(props, [], 'the staged change is links only');
});

test('diff is empty when the two mappings match, and finds property changes', () => {
  assert.deepEqual(diff(snapshot.current, snapshot.current), []);

  const staged = structuredClone(snapshot.current);
  staged.PROC_1_MIXER_1.usedInScreen = 'S7';
  staged.PROC_2_MIXER_13.isEnabled = true;

  const changes = diff(snapshot.current, staged);
  assert.equal(changes.length, 2);
  const first = changes.find((c) => c.mixer === 'PROC_1_MIXER_1');
  assert.deepEqual(first.changed, [{ prop: 'usedInScreen', from: 'S1', to: 'S7' }]);
});

test('summarise tolerates an empty or absent mapping', () => {
  const s = summarise({});
  assert.equal(s.fitted, 0);
  assert.equal(s.enabled, 0);
  assert.deepEqual(s.allocations, []);
  assert.doesNotThrow(() => summarise(null));
});

/* ---------- AWJ transport, against a scripted stand-in device ---------- */

/**
 * A minimal AWJ responder: reads 0x04-terminated JSON, answers from a table.
 * This exercises the real framing code, not a mock of it.
 */
function fakeDevice(table) {
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let i;
      while ((i = buf.indexOf(0x04)) !== -1) {
        const msg = JSON.parse(buf.subarray(0, i).toString('utf8'));
        buf = buf.subarray(i + 1);
        const reply = Object.prototype.hasOwnProperty.call(table, msg.path)
          ? { path: msg.path, value: table[msg.path] }
          : { error: { code: 'E12', message: `Unexpected path "${msg.path}"` } };
        sock.write(JSON.stringify(reply) + '\x04');
      }
    });
  });
  return server;
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

test('AWJ client frames requests and parses replies', async () => {
  const P = 'DeviceObject/system/$device/@items/1/@props';
  const server = fakeDevice({ [`${P}/dev`]: 'NLC_C', [`${P}/label`]: 'AQUILON' });
  const port = await listen(server);

  const client = new AwjClient({ host: '127.0.0.1', port, timeout: 2000 });
  await client.connect();
  try {
    assert.deepEqual(await readIdentity(client), { dev: 'NLC_C', label: 'AQUILON' });
    assert.equal(await client.tryGet('DeviceObject/nope'), undefined, 'E12 becomes undefined');
    await assert.rejects(() => client.get('DeviceObject/nope'), { code: 'E12' });
  } finally {
    client.close();
    server.close();
  }
});

test('readMapping reports NO_VPU_SUBTREE when $vpuMixer is absent', async () => {
  // A simulator answers this way — and so does an Aquilon RS4 on 6.1.60.
  const server = fakeDevice({});
  const port = await listen(server);
  const client = new AwjClient({ host: '127.0.0.1', port, timeout: 2000 });
  await client.connect();
  try {
    await assert.rejects(() => readMapping(client, { which: 'current' }), {
      code: 'NO_VPU_SUBTREE',
    });
  } finally {
    client.close();
    server.close();
  }
});

test('readMapping round-trips the captured device through the wire', async () => {
  // Serve the recorded capture back over a real socket, then read it with the
  // real client: proves the path builder and the framing agree end to end.
  const table = {};
  const B = (m) =>
    'DeviceObject/preconfig/resources/current/status/mapping' +
    `/$device/@items/1/$vpuMixer/@items/${m}`;

  for (const [id, rec] of Object.entries(snapshot.current)) {
    table[`${B(id)}/@props/isAvailable`] = rec.isAvailable;
    if (!rec.isAvailable) continue;
    for (const p of ['isEnabled', 'cutnfillCapa', 'usedInScreen', 'usedInLayer', 'channel', 'slice', 'capability', 'seamlessCapa']) {
      table[`${B(id)}/@props/${p}`] = rec[p];
    }
    for (let k = 1; k <= 8; k++) {
      table[`${B(id)}/mixerAllocation/@props/usedOnOutPipe${k}`] = rec.mixerAllocation[`usedOnOutPipe${k}`];
    }
    for (const s of ['A', 'B']) {
      table[`${B(id)}/$scaler/@items/${s}/@props/memoryFill`] = rec.scalers[s].memoryFill;
      table[`${B(id)}/$scaler/@items/${s}/@props/memoryCut`] = rec.scalers[s].memoryCut;
    }
  }

  const server = fakeDevice(table);
  const port = await listen(server);
  const client = new AwjClient({ host: '127.0.0.1', port, timeout: 4000 });
  await client.connect();
  try {
    const mixers = await readMapping(client, { which: 'current', device: '1' });
    const s = summarise(mixers);
    assert.equal(s.fitted, 32);
    assert.equal(s.enabled, 28);
    assert.deepEqual(mixers.PROC_1_MIXER_9.usedInScreen, 'S3');
    assert.equal(mixers.PROC_1_MIXER_9.slice, 0);
    assert.equal(mixers.PROC_3_MIXER_1.isAvailable, false);
    // All eight pipes survive the round trip, interleaved as the hardware sent them.
    assert.equal(mixers.PROC_1_MIXER_1.mixerAllocation.usedOnOutPipe3, '2');
    assert.equal(mixers.PROC_1_MIXER_1.mixerAllocation.usedOnOutPipe2, 'NONE');
  } finally {
    client.close();
    server.close();
  }
});

test('readOutputs reads the assigned outputs in full and the rest by name only', async () => {
  // The table is what the object model says an output looks like (the store's
  // outputList, in AWJ spelling); no Aquilon has answered these paths yet.
  const O = (n) => `DeviceObject/$output/@items/${n}`;
  const table = {
    [`${O(1)}/canvas/status/@props/usedInScreenAux`]: 'S1',
    [`${O(1)}/canvas/status/@props/usedInRegion`]: '1',
    [`${O(1)}/canvas/status/@props/capability`]: '4K',
    [`${O(1)}/control/@props/label`]: 'LED left',
    [`${O(1)}/mapping/@props/card`]: 'OUT_1',
    [`${O(1)}/mapping/@props/physical`]: '1',
    [`${O(1)}/$plug/@items/1/status/@props/type`]: 'HDMI',
    [`${O(2)}/canvas/status/@props/usedInScreenAux`]: 'NONE',
    [`${O(2)}/canvas/status/@props/usedInRegion`]: '1',
    [`${O(3)}/canvas/status/@props/usedInScreenAux`]: 'A1',
    [`${O(3)}/canvas/status/@props/capability`]: 'DUAL',
    // 4 is not fitted (E12); 5 has an empty label and no plug type
    [`${O(5)}/canvas/status/@props/usedInScreenAux`]: 'S2',
    [`${O(5)}/canvas/status/@props/usedInRegion`]: '2',
    [`${O(5)}/canvas/status/@props/capability`]: 'DUAL',
    [`${O(5)}/control/@props/label`]: '',
  };
  const server = fakeDevice(table);
  const port = await listen(server);
  const client = new AwjClient({ host: '127.0.0.1', port, timeout: 4000 });
  await client.connect();
  try {
    const outputs = await readOutputs(client, { max: 6 });
    assert.deepEqual(Object.keys(outputs), ['1', '2', '3', '5'], 'a missing output is skipped, not the end');
    assert.deepEqual(outputs[1], {
      screen: 'S1', region: '1', capability: '4K', label: 'LED left', card: 'OUT_1', physical: '1', type: 'HDMI',
    });
    assert.deepEqual(outputs[2], { screen: 'NONE' }, 'unassigned: one read, nothing more');
    assert.deepEqual(outputs[3], { screen: 'A1' }, 'an aux costs no VPU');
    assert.deepEqual(outputs[5], { screen: 'S2', region: '2', capability: 'DUAL' }, 'blanks are left out');
  } finally {
    client.close();
    server.close();
  }
});

/* ---------- firmware 6.1.x: no mixer map, per-screen figures instead ---------- */

/**
 * An Aquilon RS4 on 6.1.60, in AWJ spelling, as its store read on 2026-10-16
 * at 11:32: identity, three screens in service, and each screen's resource
 * layers and staged room. `$vpuMixer` is absent, as it is over AWJ on the box.
 */
function rs4Table() {
  const D = 'DeviceObject/system/$device/@items/1';
  const t = {
    [`${D}/@props/dev`]: 'NLC_RS4',
    [`${D}/@props/label`]: 'AQUILON',
    [`${D}/@props/isSimulated`]: false,
    [`${D}/version/@props/updater`]: '6.1.60',
  };
  const R = (side, id) => `DeviceObject/preconfig/resources/${side}/$screen/@items/${id}`;
  const screens = { S1: ['4K', '4K'], S2: ['4K', '4K'], S3: ['DUAL'] };
  for (const side of ['current', 'new']) {
    for (let n = 1; n <= 24; n++) {
      const id = `S${n}`;
      const layers = screens[id];
      t[`${R(side, id)}/status/@props/mode`] = layers ? 'FREESTYLE' : 'DISABLED';
      if (!layers) continue;
      Object.assign(t, {
        [`${R(side, id)}/status/@props/layerCount`]: layers.length,
        [`${R(side, id)}/status/@props/outputCount`]: 1,
        [`${R(side, id)}/status/@props/usedOutputCapabilities`]: 1,
        [`${R(side, id)}/status/@props/isOptimized`]: false,
      });
      // 257 slots, NATIVE first; only 1..n are on.
      for (const k of ['NATIVE', ...Array.from({ length: 256 }, (_, i) => String(i + 1))]) {
        const i = Number(k);
        t[`${R(side, id)}/$layer/@items/${k}/status/@props/capability`] =
          i >= 1 && i <= layers.length ? layers[i - 1] : 'OFF';
      }
      if (side !== 'new') continue;
      for (const [capa, n, m] of [['DUAL', 15, 7], ['4K', 7, 3], ['3', 0, 0], ['5K', 3, 0]]) {
        const c = `${R(side, id)}/$layerCapability/@items/${capa}/status/@props`;
        t[`${c}/remainingLayerCapabilities`] = n;
        t[`${c}/remainingLayerWithMaskCapabilities`] = m;
      }
    }
  }
  return t;
}

test('readIdentity reads isSimulated and the firmware, and leaves out what is absent', async () => {
  const server = fakeDevice(rs4Table());
  const port = await listen(server);
  const client = new AwjClient({ host: '127.0.0.1', port, timeout: 2000 });
  await client.connect();
  try {
    assert.deepEqual(await readIdentity(client), {
      dev: 'NLC_RS4', label: 'AQUILON', isSimulated: false, firmware: '6.1.60',
    });
  } finally {
    client.close();
    server.close();
  }
});

test('readScreenLayers reads each screen’s layer sizes, and the staged room', async () => {
  const server = fakeDevice(rs4Table());
  const port = await listen(server);
  const client = new AwjClient({ host: '127.0.0.1', port, timeout: 4000 });
  await client.connect();
  try {
    const running = await readScreenStatus(client, { which: 'current' });
    const staged = await readScreenStatus(client, { which: 'new' });
    assert.deepEqual(Object.keys(running), ['S1', 'S2', 'S3'], 'screens in service only');

    const cur = await readScreenLayers(client, { which: 'current', status: running });
    assert.deepEqual(cur.S1, {
      layers: [{ layer: '1', capability: '4K' }, { layer: '2', capability: '4K' }],
      room: null,
    }, 'room is the staged side’s alone, and no figure is null, not "no room"');
    assert.deepEqual(cur.S3.layers, [{ layer: '1', capability: 'DUAL' }]);

    const nw = await readScreenLayers(client, { which: 'new', status: staged });
    assert.deepEqual(nw.S1.room, [
      { capability: 'DUAL', layers: 15, withMask: 7 },
      { capability: '4K', layers: 7, withMask: 3 },
      { capability: '5K', layers: 3, withMask: 0 },
    ], 'device order, and the always-empty `3` is dropped rather than named');
    assert.deepEqual(nw.S3.room, nw.S1.room, 'every screen sees the box’s one pool');
  } finally {
    client.close();
    server.close();
  }
});

test('readScreenLayers stops at layerCount rather than reading 257 slots', async () => {
  const table = rs4Table();
  let reads = 0;
  const counting = new Proxy(table, {
    getOwnPropertyDescriptor(t, k) {
      if (String(k).includes('/$layer/@items/')) reads += 1;
      return Reflect.getOwnPropertyDescriptor(t, k);
    },
  });
  const server = fakeDevice(counting);
  const port = await listen(server);
  const client = new AwjClient({ host: '127.0.0.1', port, timeout: 4000 });
  await client.connect();
  try {
    const status = await readScreenStatus(client, { which: 'current' });
    await readScreenLayers(client, { which: 'current', status });
    // S1 and S2: NATIVE, 1, 2. S3: NATIVE, 1.
    assert.equal(reads, 3 + 3 + 2);
  } finally {
    client.close();
    server.close();
  }
});

test('a device with no mixer map is worded from its own identity, never called a simulator by shape', () => {
  const rs4 = noMixerMap(
    { dev: 'NLC_RS4', label: 'AQUILON', isSimulated: false, firmware: '6.1.60' },
    { inService: true },
  );
  assert.equal(rs4.title, 'This firmware does not report its VPU allocation');
  // Word for word what src-tauri/src/read.rs says; its test pins the same string.
  assert.equal(rs4.hint,
    'AQUILON NLC_RS4 on firmware 6.1.60 answers E12 for $vpuMixer. The VPU is there; ' +
    'firmware 6.1.x just does not say how its mixers are allocated, so there is no mixer ' +
    'map to draw — the tool is working. What it does report is each screen’s ' +
    'layer sizes and the room left, below.');
  assert.match(rs4.hint, /below\.$/, 'points at the screens’ own figures');
  assert.doesNotMatch(rs4.hint + rs4.title, /simulat/i, 'a live Aquilon is not a simulator');
  assert.doesNotMatch(noMixerMap({ dev: 'NLC_RS4', firmware: '6.1.60' }).hint, /below/,
    'no pointer when no screen is in service');

  const sim = noMixerMap({ dev: 'NLC_CPLUS', label: 'AQUILON', isSimulated: true, firmware: '6.1.60' });
  assert.equal(sim.title, 'No VPU on this simulator');
  assert.match(sim.hint, /says it is a simulator \(AQUILON NLC_CPLUS, firmware 6\.1\.60\)/);

  const c = noMixerMap({ dev: 'NLC_C', label: 'AQUILON', isSimulated: false, firmware: '6.2.73' });
  assert.equal(c.title, 'No VPU mixer map on this device');
  assert.match(c.hint, /AQUILON NLC_C on firmware 6\.2\.73 answers E12.*Aquilon C on 6\.2\.73 reports one/);
  assert.doesNotMatch(c.hint, /simulator/);

  const unknown = noMixerMap({});
  assert.equal(unknown.title, 'No VPU mixer map reported');
  assert.match(unknown.hint, /A simulator answers this way, and so does LivePremier firmware 6\.1\.60 on hardware/);
});

test('the bridge answers a 6.1.60 Aquilon with its identity’s sentence and the screens’ figures', async () => {
  const device = fakeDevice(rs4Table());
  const awjPort = await listen(device);
  const probe = net.createServer();
  const httpPort = await listen(probe);
  await new Promise((r) => probe.close(r));

  const child = spawn(process.execPath, [path.join(HERE, '..', 'server.js')], {
    env: { ...process.env, PORT: String(httpPort), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once('data', resolve);
      child.once('exit', (code) => reject(new Error(`server exited ${code}`)));
    });
    const res = await fetch(`http://127.0.0.1:${httpPort}/api/vpu?ip=127.0.0.1&port=${awjPort}`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'NO_VPU_SUBTREE');
    assert.equal(body.title, 'This firmware does not report its VPU allocation');
    assert.doesNotMatch(body.hint, /simulat/i);
    assert.equal(body.source.firmware, '6.1.60');
    assert.equal(body.source.isSimulated, false);
    assert.deepEqual(Object.keys(body.screenStatus.current), ['S1', 'S2', 'S3']);
    assert.deepEqual(body.screenLayers.current.S1.layers.map((l) => l.capability), ['4K', '4K']);
    assert.deepEqual(body.screenLayers.new.S2.room.map((r) => `${r.layers} ${r.capability}`),
      ['15 DUAL', '7 4K', '3 5K']);
  } finally {
    child.kill();
    device.close();
  }
});

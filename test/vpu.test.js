// Tests run against the recorded capture from a real Aquilon C, so the numbers
// asserted here are the ones the hardware actually reported.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

import { summarise, diff, MIXER_IDS, MAX_MIXERS, parseMixerId } from '../public/vpu.js';
import { AwjClient } from '../lib/awj.js';
import { readMapping, readIdentity } from '../lib/read.js';

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
  // This is exactly how the LivePremier simulator behaves.
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

// scripts/capture-config.mjs — the tool that records a configuration once there
// is no longer an Aquilon to record it from.
//
// It cannot be tried against hardware any more, which is the whole reason it
// exists, so it is tested against the same scripted stand-in device the transport
// tests use: the recorded capture is served back over a real socket and the
// script is run as a subprocess, exactly as whoever has device access would run
// it. That covers the two things most likely to rot — the redaction, and the
// report throwing on a capture shape it did not expect.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'capture-config.mjs');

const snapshot = JSON.parse(
  await fs.readFile(path.join(ROOT, 'data', 'aquilon-c-snapshot.json'), 'utf8'),
);

/** The same minimal AWJ responder as the transport tests. */
function fakeDevice(table) {
  return net.createServer((sock) => {
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
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

function deviceTable() {
  const table = {
    'DeviceObject/system/$device/@items/1/@props/dev': 'NLC_C',
    'DeviceObject/system/$device/@items/1/@props/label': 'AQUILON',
    // One configured screen, so screenStatus is exercised rather than skipped.
    'DeviceObject/preconfig/resources/current/$screen/@items/S1/status/@props/mode': 'MIXING',
    'DeviceObject/preconfig/resources/current/$screen/@items/S1/status/@props/outputCount': 1,
    'DeviceObject/preconfig/resources/current/$screen/@items/S1/status/@props/isOptimized': false,
    'DeviceObject/preconfig/resources/current/$screen/@items/S2/status/@props/mode': undefined,
    // The operator's screen names. They must NOT reach the file.
    'DeviceObject/$screen/@items/S1/control/@props/label': 'Main LED',
  };
  const B = (m) =>
    'DeviceObject/preconfig/resources/current/status/mapping' +
    `/$device/@items/1/$vpuMixer/@items/${m}`;

  for (const [id, rec] of Object.entries(snapshot.current)) {
    table[`${B(id)}/@props/isAvailable`] = rec.isAvailable;
    if (!rec.isAvailable) continue;
    for (const p of [
      'isEnabled', 'cutnfillCapa', 'usedInScreen', 'usedInLayer',
      'channel', 'slice', 'capability', 'seamlessCapa',
    ]) {
      table[`${B(id)}/@props/${p}`] = rec[p];
    }
    for (let k = 1; k <= 8; k++) {
      table[`${B(id)}/mixerAllocation/@props/usedOnOutPipe${k}`] =
        rec.mixerAllocation[`usedOnOutPipe${k}`];
    }
    for (const s of ['A', 'B']) {
      table[`${B(id)}/$scaler/@items/${s}/@props/memoryFill`] = rec.scalers[s].memoryFill;
      table[`${B(id)}/$scaler/@items/${s}/@props/memoryCut`] = rec.scalers[s].memoryCut;
    }
  }
  // No `new` mapping is served, so the staged-side read finds nothing — which is
  // the path a device with nothing staged takes.
  return table;
}

test('--report audits the committed captures without a device', async () => {
  const { stdout } = await run('node', [SCRIPT, '--report'], { cwd: ROOT });

  for (const f of ['aquilon-c-snapshot.json', 'aquilon-c-6output-5k.json', 'aquilon-c-optimized.json']) {
    assert.ok(stdout.includes(f), `names ${f}`);
  }
  // Every gap predicate ran over every capture: a shape change that breaks one
  // shows up as a thrown error, not a quietly false row.
  assert.match(stdout, /\d+ answered, \d+ open\./);
  assert.ok(stdout.includes('A layer spread over more than four output links'));
  // The wrap is answered; a capacity-1 layer has never been seen.
  assert.match(stdout, /✓ A layer spread over more than four output links/);
  assert.match(stdout, /✗ A capacity-1 layer/);
});

test('a capture is written, redacted, and offered in the picker', async () => {
  const server = fakeDevice(deviceTable());
  const port = await listen(server);
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'vpu-capture-'));

  try {
    const { stdout } = await run(
      'node',
      [SCRIPT, '127.0.0.1', '--name', 'testcap', '--port', String(port),
       '--out', out, '--label', 'Test capture'],
      { cwd: ROOT },
    );
    assert.ok(stdout.includes('NLC_C'), 'reports what it found');
    assert.ok(stdout.includes('no staged mapping'), 'tolerates a device with nothing staged');

    const file = path.join(out, 'aquilon-nlc-c-testcap.json');
    const body = JSON.parse(await fs.readFile(file, 'utf8'));

    // Show data never reaches a capture: the host is redacted and the operator's
    // screen names are dropped. test/grid.test.js guards the committed ones; this
    // guards the tool that writes them.
    assert.equal(body.source.host, 'redacted');
    assert.equal(body.screens, undefined, 'no screen names');
    assert.ok(!JSON.stringify(body).includes('Main LED'));

    assert.equal(body.source.dev, 'NLC_C');
    assert.equal(body.source.device, '1');
    assert.equal(body.new, null, 'nothing staged');
    assert.equal(Object.keys(body.current).length, 64, 'every mixer id');
    assert.equal(
      Object.values(body.current).filter((m) => m.isEnabled).length,
      28,
      'the same 28 enabled mixers came back off the wire',
    );
    assert.equal(body.screenStatus.current.S1.mode, 'MIXING');

    const index = JSON.parse(await fs.readFile(path.join(out, 'captures.json'), 'utf8'));
    assert.ok(
      index.captures.some((c) => c.file === 'aquilon-nlc-c-testcap.json' && c.label === 'Test capture'),
      'listed for the app’s capture picker',
    );
  } finally {
    server.close();
    await fs.rm(out, { recursive: true, force: true });
  }
});

test('--keep-names keeps them, and says so', async () => {
  // The escape hatch for a capture you are not committing. It must be loud.
  const server = fakeDevice(deviceTable());
  const port = await listen(server);
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'vpu-capture-'));

  try {
    const { stdout } = await run(
      'node',
      [SCRIPT, '127.0.0.1', '--name', 'private', '--port', String(port), '--out', out, '--keep-names'],
      { cwd: ROOT },
    );
    assert.match(stdout, /do NOT commit/);

    const body = JSON.parse(await fs.readFile(path.join(out, 'aquilon-nlc-c-private.json'), 'utf8'));
    assert.deepEqual(body.screens, { S1: 'Main LED' });
    assert.equal(body.source.host, 'redacted', 'the address is redacted even so');

    // ...and it is not offered in the picker, so it cannot be committed by habit.
    await assert.rejects(() => fs.readFile(path.join(out, 'captures.json'), 'utf8'));
  } finally {
    server.close();
    await fs.rm(out, { recursive: true, force: true });
  }
});

test('a bad name or device is refused before anything connects', async () => {
  for (const args of [
    ['127.0.0.1', '--name', 'Not A Slug'],
    ['127.0.0.1', '--name', 'ok', '--device', '9'],
    ['127.0.0.1'],
  ]) {
    await assert.rejects(() => run('node', [SCRIPT, ...args], { cwd: ROOT }), (err) => {
      assert.equal(err.code, 2, `${args.join(' ')} exits 2`);
      return true;
    });
  }
});

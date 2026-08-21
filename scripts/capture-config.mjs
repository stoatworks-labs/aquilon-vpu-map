#!/usr/bin/env node
//
// Record one Aquilon configuration as a capture this tool can load, and report
// which of the unanswered questions that capture closes.
//
// WHY THIS EXISTS. From 2026-08-21 there is no Aquilon to read. Everything the
// grid claims is now backed by three recorded configurations in data/, and the
// gaps between them can only be closed by someone with a box in front of them.
// This script is what you hand that person: it needs nothing from the session
// that wrote it, no checkout knowledge, and no understanding of AWJ.
//
//   node scripts/capture-config.mjs --report
//       No device needed. Audits the captures in data/ and prints what is
//       covered and what is still missing. Run this first.
//
//   node scripts/capture-config.mjs <ip> --name <slug> [options]
//       Reads a device and writes data/aquilon-<dev>-<slug>.json, then prints
//       the same report with the new capture included.
//
//         --label "Six-output screen"   what the app's picker should call it
//         --note  "why this one matters"
//         --device 1                    1 = master, 2-4 = Link followers
//         --port 10606                  AWJ port; only change it if you must
//         --out data                    where to write
//         --keep-names                  KEEP the operator's screen names.
//                                       Off by default: they are show data and
//                                       these files are public. See below.
//
// READS ONLY. Every AWJ frame this can send carries op:"get" — it uses the same
// client the app does, and never calls anything that writes. Nothing is staged,
// nothing is taken, no Subscriptions are touched. It is safe on a live show
// machine, though it is still 500-odd round trips, so do not run it mid-cue.
//
// The captures in data/ are PUBLIC — they ship in a public repo. The host is
// written as "redacted" and the operator's screen names are dropped, which a
// test in test/grid.test.js enforces. --keep-names exists for a capture you are
// keeping to yourself; do not commit one.
//
// See docs/CAPTURE-GUIDE.md for what to build on the device before running this.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AwjClient } from '../lib/awj.js';
import { readIdentity, readMapping, readScreenStatus, readScreenNames } from '../lib/read.js';
import {
  buildLinkGrid,
  optimizedVpus,
  parseMixerId,
  reportedOutputs,
  LINKS_PER_VPU,
  SCALING_ENGINE_BOUNDARY,
} from '../public/vpu.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/* ------------------------------------------------------------------ *
 * The questions the captures cannot answer yet.
 *
 * Each one is a `covered(capture)` predicate over a loaded capture plus the
 * setup that would produce it. Add to this list rather than keeping a mental
 * one — an unanswered question that is not written down here is one nobody
 * else can close.
 * ------------------------------------------------------------------ */

const GAPS = [
  {
    id: 'capacity-1',
    what: 'A capacity-1 layer (dual link, up to 4K30)',
    why:
      'Everything captured is 4K60 or 5K60, so capacity 1 — the unit the whole grid ' +
      'is measured in — has never actually been seen reported. The wrap rule for a ' +
      'capacity-1 layer is taken from the manual, not from the device.',
    setup: 'One screen with an HD/4K30 layer on it. `capability` should read DUAL.',
    covered: (c) => capabilities(c).has('DUAL'),
  },
  {
    id: 'capacity-8',
    what: 'An 8K layer',
    why: '`capacityToLinks` maps 8K to eight links from the enum position alone.',
    setup: 'An 8K layer, on a chassis that supports one.',
    covered: (c) => capabilities(c).has('8K'),
  },
  {
    id: 'cut-and-fill',
    what: 'Cut & Fill actually enabled on a layer',
    why:
      'Manual §5.5.7 says the effect DOUBLES the resources a layer needs, which would ' +
      'change its height on the grid. `cutnfillCapa` has only ever read as a ' +
      'capability (OFF or 4K), never with the effect switched on, so the view does ' +
      'nothing with it.',
    setup:
      'Enable Cut & Fill on one layer, leave an identical layer without it, and ' +
      'capture both. The difference in mixer count is the answer.',
    covered: (c) => {
      // The signature is a run holding more mixers than its slices and its output
      // links can explain: normally one mixer per slice per group of links, so a
      // ratio of 2 is the doubling. Every capture so far sits at exactly 1.
      const runs = new Map();
      for (const [id, m] of enabled(c)) {
        const k = `${id.split('_MIXER_')[0]} ${m.usedInScreen} ${m.usedInLayer}`;
        if (!runs.has(k)) runs.set(k, []);
        runs.get(k).push(m);
      }
      return [...runs.values()].some((ms) => {
        const slices = new Set(ms.map((m) => m.slice)).size || 1;
        const groups = new Set(ms.map((m) => reportedOutputs(m).join(','))).size || 1;
        return ms.length >= slices * groups * 2;
      });
    },
  },
  {
    id: 'wrap',
    what: 'A layer spread over more than four output links (§5.5.4)',
    why: 'The wrap onto a second layer link — the manual’s hook.',
    setup: 'A screen with 5 or more outputs and at least one layer.',
    covered: (c) => screenWidths(c).some((w) => w > SCALING_ENGINE_BOUNDARY),
  },
  {
    id: 'combined-vpus',
    what: 'A screen spilling into a second VPU (§5.5.5)',
    why:
      'A screen over more than 8 outputs uses another VPU, and its layers cost three ' +
      'layer links. The grid draws each VPU independently and has never seen a screen ' +
      'that spans two, so the column allocation for the second one is untested.',
    setup: 'One screen with 9 or more outputs — 12 is the manual’s example.',
    covered: (c) => {
      // NOT "a screen with mixers on two boards" — that is ordinary, and the base
      // capture already does it (S3's native is on VPU 1, its layer 1 on VPU 2).
      // §5.5.5 is a screen too WIDE for one VPU: one of its LAYERS split across
      // boards, or more than eight output links in total.
      const links = new Map();
      const layers = new Map();
      for (const [id, m] of enabled(c)) {
        const p = parseMixerId(id).processor;
        const w = Math.max(0, ...reportedOutputs(m));
        links.set(m.usedInScreen, Math.max(links.get(m.usedInScreen) || 0, w));
        const k = `${m.usedInScreen} ${m.usedInLayer}`;
        if (!layers.has(k)) layers.set(k, new Set());
        layers.get(k).add(p);
      }
      return (
        [...links.values()].some((w) => w > LINKS_PER_VPU) ||
        [...layers.values()].some((s) => s.size > 1)
      );
    },
  },
  {
    id: 'unaligned-screen',
    what: 'A screen whose links do not start at 1 or 5',
    why:
      'Every capture has screens landing neatly on a scaling-engine half, so ' +
      '"break at the centre line" and "chunk every four links" agree. A screen ' +
      'starting mid-half is the case where they could disagree.',
    setup:
      'Three screens on one VPU with an odd spread of outputs — 3, 3 and 2, say — ' +
      'so the middle one straddles the centre line.',
    covered: (c) =>
      gridOf(c).some((g) =>
        (g.screens || []).some(
          (s) =>
            s.col % SCALING_ENGINE_BOUNDARY !== 0 &&
            s.col < SCALING_ENGINE_BOUNDARY &&
            s.col + s.width > SCALING_ENGINE_BOUNDARY,
        ),
      ),
  },
  {
    id: 'proc-3-4',
    what: 'A chassis with VPU 3 or 4 fitted',
    why:
      'The captured box has two processor boards. PROC_3 and PROC_4 answer ' +
      'isAvailable:false throughout, so half the model has never been exercised.',
    setup: 'Any Aquilon C+ / Cmax with three or four processor boards.',
    covered: (c) =>
      Object.entries(c.current || {}).some(
        ([id, m]) => m && m.isAvailable && parseMixerId(id).processor > 2,
      ),
  },
  {
    id: 'link-follower',
    what: 'A Link setup — devices 2 to 4',
    why:
      'On a standalone box every follower answers isAvailable:false. Whether ' +
      '`channel` indexes the Link device is a guess, and `channel` has read 0 on ' +
      'every mixer ever captured.',
    setup:
      'A Link master with at least one follower. Capture each device separately ' +
      'with --device 2, --device 3 …',
    covered: (c) => String(c.source?.device || '1') !== '1',
  },
  {
    id: 'channel-varies',
    what: 'A mixer reporting channel other than 0',
    why:
      'If `channel` ever varies it may be the missing row index, which would make ' +
      'the grid reported rather than derived. Worth checking on every new firmware.',
    setup: 'Any capture — this is a free check, not a configuration.',
    covered: (c) => enabled(c).some(([, m]) => m.channel !== 0 && m.channel !== undefined),
  },
  {
    id: 'screen-status',
    what: 'The device’s own capability figures',
    why:
      '`screenStatus` carries outputCount, layerCount, used/remaining/exceeding ' +
      'capabilities and isOptimized — the device answering "does this fit" itself. ' +
      'Only one capture has it, so the numbers cannot be cross-checked.',
    setup: 'Nothing special; this script always reads it.',
    covered: (c) => Boolean(c.screenStatus && Object.keys(c.screenStatus.current || {}).length),
  },
  {
    id: 'over-budget',
    what: 'A configuration that does NOT fit',
    why:
      'Every capture fits comfortably. `exceedingOutputCapabilities` and ' +
      '`exceedingLayerCapabilities` have only ever read 0, so the one number a tech ' +
      'most wants — "what does over-budget look like?" — is unverified, as is the ' +
      'grid’s own overflow flag.',
    setup:
      'Stage (do not take) a configuration the box refuses: more layers than the ' +
      'VPU can hold. The `new` side reports the excess while `current` still runs.',
    covered: (c) => {
      const st = (c.screenStatus || {}).new || {};
      return Object.values(st).some(
        (s) => (s.exceedingOutputCapabilities || 0) + (s.exceedingLayerCapabilities || 0) > 0,
      );
    },
  },
  {
    id: 'vpu-layer-populated',
    what: '$vpuLayer populated by a newer firmware',
    why:
      'It would name the layer link directly and make the rows reported rather than ' +
      'ordered. It answers E12 on 6.2 hardware. scripts/probe-hardware.mjs sweeps ' +
      'for it; re-run that after any firmware update.',
    setup: 'Run scripts/probe-hardware.mjs <ip> on the new firmware.',
    covered: () => false,
    external: true,
  },
];

/* ---------------- reading a capture ---------------- */

const enabled = (c) => Object.entries(c.current || {}).filter(([, m]) => m && m.isEnabled);
const capabilities = (c) => new Set(enabled(c).map(([, m]) => m.capability));
const gridOf = (c) =>
  buildLinkGrid(c.current, optimizedVpus(c.current, (c.screenStatus || {}).current));
const screenWidths = (c) =>
  gridOf(c).flatMap((g) => (g.screens || []).map((s) => s.width));

async function loadCaptures(dir) {
  const out = [];
  for (const f of (await fs.readdir(dir)).sort()) {
    if (!f.endsWith('.json') || f === 'captures.json') continue;
    try {
      const body = JSON.parse(await fs.readFile(path.join(dir, f), 'utf8'));
      if (body && body.current) out.push({ file: f, body });
    } catch {
      console.log(`  (skipping ${f}: not readable as a capture)`);
    }
  }
  return out;
}

/* ---------------- the report ---------------- */

function describe(cap) {
  const { file, body } = cap;
  const grid = gridOf(body);
  const fitted = grid.filter((g) => g.fitted);
  const caps = [...capabilities(body)].sort().join(', ') || 'none';
  const screens = fitted.map(
    (g) => `VPU${g.vpu} ${(g.screens || []).map((s) => `${s.screen}×${s.width}`).join(' ') || '—'}`,
  );
  console.log(`\n  ${file}`);
  console.log(`    ${body.note ? body.note.slice(0, 96) : '(no note)'}`);
  console.log(
    `    ${enabled(body).length} mixers enabled · VPUs ${fitted.map((g) => g.vpu).join(',') || '—'}` +
      ` · capabilities ${caps}`,
  );
  console.log(`    screens, output links each: ${screens.join('  ·  ') || '—'}`);
  console.log(
    `    layer links used: ${fitted.map((g) => `VPU${g.vpu} ${g.rowsUsed}/${LINKS_PER_VPU}`).join('  ')}`,
  );
}

function report(captures) {
  console.log(`\nCaptures in data/ — ${captures.length}`);
  for (const c of captures) describe(c);

  console.log('\n\nWhat they answer, and what they do not\n');
  const rows = GAPS.map((gap) => {
    const by = captures.filter((c) => {
      try {
        return gap.covered(c.body);
      } catch {
        return false;
      }
    });
    return { gap, by };
  });

  const done = rows.filter((r) => r.by.length);
  const todo = rows.filter((r) => !r.by.length);

  for (const { gap, by } of done) {
    console.log(`  ✓ ${gap.what}`);
    console.log(`      answered by ${by.map((c) => c.file).join(', ')}`);
  }
  console.log('');
  for (const { gap } of todo) {
    console.log(`  ✗ ${gap.what}${gap.external ? '  (needs probe-hardware.mjs, not this)' : ''}`);
    console.log(`      why it matters : ${wrap(gap.why, 22)}`);
    console.log(`      to capture it  : ${wrap(gap.setup, 22)}`);
    if (!gap.external) console.log(`      then           : node scripts/capture-config.mjs <ip> --name ${gap.id}`);
    console.log('');
  }

  console.log(`  ${done.length} answered, ${todo.length} open.`);
  console.log('  Priority order if device time is short: capacity-1, over-budget, cut-and-fill.');
  console.log('  See docs/CAPTURE-GUIDE.md for the whole procedure.\n');
}

/** Wrap a sentence to the terminal, indenting continuations. */
function wrap(text, indent, width = 92) {
  const pad = ' '.repeat(indent);
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > width - indent) {
      lines.push(line.trim());
      line = w;
    } else line += ' ' + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join('\n' + pad);
}

/* ---------------- capturing ---------------- */

async function capture(opts) {
  const client = new AwjClient({ host: opts.host, port: opts.port, timeout: 5000 });
  const started = Date.now();
  console.log(`\nReading ${opts.host}:${opts.port} — device ${opts.device}. Reads only.`);
  try {
    await client.connect();
    const identity = await readIdentity(client);
    console.log(`  ${identity.dev || '?'} · ${identity.label || '?'}`);

    const screenStatus = {
      current: await readScreenStatus(client, { which: 'current' }),
      new: await readScreenStatus(client, { which: 'new' }),
    };
    console.log(`  screen status: ${Object.keys(screenStatus.current).length} configured screens`);

    const current = await readMapping(client, { which: 'current', device: opts.device });
    let next = null;
    try {
      next = await readMapping(client, { which: 'new', device: opts.device });
    } catch (err) {
      if (err.code !== 'NO_VPU_SUBTREE') throw err;
      console.log('  no staged mapping');
    }

    // Show data. Off unless asked for, and never in a committed capture.
    const screens = opts.keepNames ? await readScreenNames(client) : undefined;
    if (opts.keepNames) {
      console.log(`  ⚠️  screen names kept — do NOT commit ${opts.name}; it carries show data`);
    }

    const body = {
      $schema: './capture.schema.json',
      capturedAt: new Date().toISOString(),
      source: {
        kind: 'device',
        dev: identity.dev,
        label: identity.label,
        // The address is redacted, always: these files are public.
        host: 'redacted',
        device: String(opts.device),
        firmware: opts.firmware || '6.2.x',
      },
      note: opts.note || `Aquilon capture: ${opts.label || opts.name}. Reads only; no writes were issued.`,
      device: identity.dev,
      ...(screens ? { screens } : {}),
      screenStatus,
      current,
      new: next,
    };

    const file = `aquilon-${String(identity.dev || 'device').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${opts.name}.json`;
    const dest = path.join(opts.out, file);
    await fs.writeFile(dest, JSON.stringify(body, null, 1));
    const { size } = await fs.stat(dest);
    console.log(
      `\n  wrote ${path.relative(ROOT, dest)} (${(size / 1024).toFixed(0)} KB, ${
        ((Date.now() - started) / 1000).toFixed(1)
      }s)`,
    );

    if (!opts.keepNames) await addToIndex(opts.out, file, opts.label || opts.name, opts.note);
    return { file, body };
  } finally {
    client.close();
  }
}

/** Offer the new capture in the app's picker. */
async function addToIndex(dir, file, label, summary) {
  const p = path.join(dir, 'captures.json');
  let index;
  try {
    index = JSON.parse(await fs.readFile(p, 'utf8'));
  } catch {
    index = { captures: [] };
  }
  index.captures = (index.captures || []).filter((c) => c.file !== file);
  index.captures.push({
    id: file.replace(/^aquilon-[^-]+-/, '').replace(/\.json$/, ''),
    file,
    label,
    summary: summary || '',
  });
  await fs.writeFile(p, JSON.stringify(index, null, 2) + '\n');
  console.log(`  listed it in ${path.relative(ROOT, p)} — the app's picker will offer it`);
}

/* ---------------- arguments ---------------- */

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

const host = argv[0] && !argv[0].startsWith('--') ? argv[0] : null;
const out = path.resolve(ROOT, flag('out', 'data'));

if (has('help') || (!host && !has('report'))) {
  console.log(`
Record one Aquilon configuration, and report what the captures still cannot answer.

  node scripts/capture-config.mjs --report
      No device needed. Audit data/ and list the open questions.

  node scripts/capture-config.mjs <ip> --name <slug> [--label "..."] [--note "..."]
                                       [--device 1] [--port 10606] [--out data]
                                       [--keep-names]

Reads only — every frame carries op:"get". See docs/CAPTURE-GUIDE.md.
`);
  process.exit(has('help') ? 0 : 2);
}

if (host) {
  const name = flag('name');
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    console.error('--name <slug> is required: lower case, digits and dashes.');
    process.exit(2);
  }
  const device = flag('device', '1');
  if (!/^[1-4]$/.test(device)) {
    console.error('--device must be 1-4 (1 = master).');
    process.exit(2);
  }
  try {
    await capture({
      host,
      port: Number(flag('port', 10606)),
      device,
      name,
      label: flag('label'),
      note: flag('note'),
      firmware: flag('firmware'),
      out,
      keepNames: has('keep-names'),
    });
  } catch (err) {
    console.error(`\n  ✗ read failed: ${err.message}`);
    console.error('    Nothing was written to the device.');
    process.exit(1);
  }
}

report(await loadCaptures(out));

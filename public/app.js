// Aquilon VPU Map — UI.
//
// The rendering is fed by one shape, whether it came from a live read or from a
// recorded capture, so there is no live/offline branching below the fetch.

import {
  MIXER_IDS,
  PROCESSORS,
  MIXERS_PER_PROCESSOR,
  LINKS_PER_VPU,
  SCALING_ENGINE_BOUNDARY,
  parseMixerId,
  summarise,
  diff,
  buildLinkGrid,
} from './vpu.js';

const $ = (id) => document.getElementById(id);

const els = {
  form: $('connForm'),
  ip: $('ip'),
  device: $('device'),
  readBtn: $('readBtn'),
  sampleBtn: $('sampleBtn'),
  dot: $('statusDot'),
  status: $('statusText'),
  source: $('sourceText'),
  banner: $('banner'),
  results: $('results'),
  stats: $('stats'),
  chassis: $('chassis'),
  budget: $('budget'),
  grids: $('grids'),
  derivedNote: $('derivedNote'),
  detail: $('detail'),
  diffSection: $('diffSection'),
  diff: $('diff'),
};

const SAMPLE_URL = './data/aquilon-c-snapshot.json';
const IP_KEY = 'aquilon-vpu-map.ip';

/* ---------------- helpers ---------------- */

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c);
  }
  return node;
}

function setStatus(state, text, source) {
  els.dot.dataset.state = state;
  els.status.textContent = text;
  if (source) {
    els.source.textContent = source;
    els.source.hidden = false;
  } else {
    els.source.hidden = true;
  }
}

function showBanner(kind, title, detail) {
  els.banner.hidden = false;
  els.banner.dataset.kind = kind;
  els.banner.replaceChildren(
    el('b', { text: title }),
    detail ? el('span', { text: detail }) : null,
  );
}

function clearBanner() {
  els.banner.hidden = true;
  els.banner.replaceChildren();
}

/** Stable colour class per screen, in first-seen order — supports S1..S24. */
function screenColourMap(allocations) {
  const map = new Map();
  let n = 0;
  for (const a of allocations) {
    if (!map.has(a.screen)) map.set(a.screen, `c${(n++ % 6) + 1}`);
  }
  return map;
}

const layerLabel = (layer) => (layer === 'NATIVE' ? 'NATIVE' : `LAYER ${layer}`);

/* ---------------- rendering ---------------- */

function renderStats(sum, meta) {
  const fittedProcs = sum.processors.filter((p) => p.fitted > 0).length;
  const stats = [
    {
      k: 'Mixers fitted',
      v: `${sum.fitted}`,
      small: ` / ${sum.max}`,
      n: `${fittedProcs} processor board${fittedProcs === 1 ? '' : 's'} of ${PROCESSORS}`,
    },
    {
      k: 'In use',
      v: `${sum.enabled}`,
      n: `${sum.spare} spare, available but not enabled`,
    },
    {
      k: 'Screens served',
      v: `${sum.screens}`,
      n: `${sum.allocations.length} layer${sum.allocations.length === 1 ? '' : 's'} allocated`,
    },
    {
      k: 'Staged changes',
      v: `${meta.diffCount}`,
      n: meta.diffCount === 0 ? 'Staged config matches running' : 'Mixers differ from running',
    },
  ];

  els.stats.replaceChildren(
    ...stats.map((s) =>
      el(
        'div',
        { class: 'stat' },
        el('span', { class: 'k', text: s.k }),
        el('span', { class: 'v' }, s.v, s.small ? el('small', { text: s.small }) : null),
        el('span', { class: 'n', text: s.n }),
      ),
    ),
  );
}

function renderChassis(mixers, colours, changedIds) {
  const ruler = el(
    'div',
    { class: 'ruler' },
    el('span', { class: 'corner', text: 'Mixer' }),
    ...Array.from({ length: MIXERS_PER_PROCESSOR }, (_, i) => el('span', { text: String(i + 1) })),
  );

  const rows = [];
  for (let p = 1; p <= PROCESSORS; p++) {
    const ids = MIXER_IDS.filter((id) => parseMixerId(id).processor === p);
    const fitted = ids.some((id) => mixers[id] && mixers[id].isAvailable);

    const cells = ids.map((id) => {
      const rec = mixers[id];
      const changed = changedIds.has(id) ? ' changed' : '';

      if (!rec || !rec.isAvailable) {
        return el('div', { class: `cell absent${changed}`, title: `${id} — not fitted` });
      }
      if (!rec.isEnabled) {
        return el(
          'div',
          { class: `cell spare${changed}`, title: `${id} — available, not enabled` },
          el('span', { class: 'scr', text: '—' }),
          el('span', { class: 'ly', text: 'SPARE' }),
        );
      }
      const colour = colours.get(rec.usedInScreen) || 'c1';
      const layered = rec.usedInLayer === 'NATIVE' ? '' : ' layered';
      const alloc = rec.mixerAllocation || {};
      const pipes = Object.keys(alloc)
        .map((k) => {
          const n = Number(k.replace('usedOnOutPipe', ''));
          const v = alloc[k];
          return v && v !== 'NONE' ? `link ${n}\u2192out ${v}` : null;
        })
        .filter(Boolean)
        .join(', ');

      return el(
        'div',
        {
          class: `cell ${colour}${layered}${changed}`,
          title:
            `${id}\n${rec.usedInScreen} · ${layerLabel(rec.usedInLayer)} · slice ${rec.slice}` +
            `\ncapability ${rec.capability}, channel ${rec.channel}` +
            (pipes ? `\n${pipes}` : ''),
        },
        el('span', { class: 'scr', text: String(rec.usedInScreen) }),
        el('span', { class: 'ly', text: layerLabel(rec.usedInLayer) }),
        el('span', { class: 'sl', text: String(rec.slice) }),
      );
    });

    rows.push(
      el(
        'div',
        { class: `proc${fitted ? '' : ' empty'}` },
        el(
          'div',
          { class: 'proc-label' },
          el('b', { text: `PROC ${p}` }),
          el('i', { text: fitted ? 'fitted' : 'not fitted' }),
        ),
        ...cells,
      ),
    );
  }

  const legend = el(
    'div',
    { class: 'legend' },
    el('span', { class: 'key' }, el('span', { class: 'swatch solid' }), 'Native background'),
    el('span', { class: 'key' }, el('span', { class: 'swatch lay' }), 'Numbered layer'),
    el('span', { class: 'key' }, el('span', { class: 'swatch sp' }), 'Spare — available, not enabled'),
    el('span', { class: 'key' }, el('span', { class: 'swatch ab' }), 'Not fitted'),
  );

  els.chassis.replaceChildren(ruler, ...rows, legend);
}

/* ---------------- link grid (manual §5.5) ---------------- */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svg(tag, props = {}, ...children) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    node.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c);
  }
  return node;
}

const CELL = 30;
const PAD_L = 34; // room for the layer-link arrows
const PAD_T = 22; // room for the output-link arrows
const FIELD = CELL * LINKS_PER_VPU;

function renderVpu(grid, colours) {
  const W = PAD_L + FIELD + 14;
  const H = PAD_T + FIELD + PAD_T;
  const root = svg('svg', {
    class: `vpu${grid.fitted ? '' : ' unfitted'}`,
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': `VPU ${grid.vpu}, ${grid.blocks.length} layer blocks`,
  });

  const x0 = PAD_L;
  const y0 = PAD_T;

  // chassis
  root.append(
    svg('rect', {
      class: 'field', x: x0, y: y0, width: FIELD, height: FIELD, rx: 2,
    }),
  );

  // link lattice
  for (let i = 1; i < LINKS_PER_VPU; i++) {
    root.append(
      svg('line', { class: 'lattice', x1: x0 + i * CELL, y1: y0, x2: x0 + i * CELL, y2: y0 + FIELD }),
      svg('line', { class: 'lattice', x1: x0, y1: y0 + i * CELL, x2: x0 + FIELD, y2: y0 + i * CELL }),
    );
  }

  // layer links in (left), output links out (top and bottom)
  for (let i = 0; i < LINKS_PER_VPU; i++) {
    const cy = y0 + i * CELL + CELL / 2;
    root.append(
      svg('line', { class: 'in', x1: x0 - 26, y1: cy, x2: x0 - 4, y2: cy, 'marker-end': `url(#in-${grid.vpu})` }),
    );
    const cx = x0 + i * CELL + CELL / 2;
    root.append(
      svg('line', { class: 'out', x1: cx, y1: y0 - 16, x2: cx, y2: y0 - 3, 'marker-end': `url(#out-${grid.vpu})` }),
      svg('line', { class: 'out', x1: cx, y1: y0 + FIELD + 3, x2: cx, y2: y0 + FIELD + 16, 'marker-end': `url(#out-${grid.vpu})` }),
    );
  }

  // arrowheads
  const marker = (id, cls) =>
    svg('marker', { id, viewBox: '0 0 8 8', refX: 6, refY: 4, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' },
      svg('path', { class: cls, d: 'M0,1 L7,4 L0,7 z' }));
  root.append(svg('defs', {}, marker(`in-${grid.vpu}`, 'ah-in'), marker(`out-${grid.vpu}`, 'ah-out')));

  // layer blocks — a mixer occupies one cell per output link it drives, and the
  // device reports those columns, so non-adjacent columns are drawn as they are
  // rather than forced into a contiguous square.
  for (const b of grid.blocks) {
    const colour = colours.get(b.screen) || 'c1';
    const isNative = b.layer === 'NATIVE';
    const cols = b.cols || [b.col];
    const span = b.size || 1;
    const by = y0 + b.row * CELL;
    const bh = span * CELL;

    const g = svg('g', { class: `blk ${colour}${isNative ? '' : ' layered'}` });
    g.append(
      svg('title', {}, document.createTextNode(
        `${b.mixer}\n${b.screen} · ${layerLabel(b.layer)} · slice ${b.slice}` +
        `\ncapability ${b.capability}` +
        (b.cutnfill && b.cutnfill !== 'OFF' ? `\ncut & fill ${b.cutnfill}` : '') +
        `\noutput link${cols.length === 1 ? '' : 's'} ${cols.map((c) => c + 1).join(', ')}` +
        (b.spansBoundary ? '\nspans the scaling-engine boundary' : ''),
      )),
    );

    // Tie a mixer's separated cells together so it reads as one allocation.
    // Drawn before the cells so it passes behind them, not across their labels.
    if (cols.length > 1) {
      const a = x0 + cols[0] * CELL + (span * CELL) / 2;
      const z = x0 + cols[cols.length - 1] * CELL + (span * CELL) / 2;
      g.append(svg('line', { class: 'tie', x1: a, y1: by + bh / 2, x2: z, y2: by + bh / 2 }));
    }

    cols.forEach((c, i) => {
      const bx = x0 + c * CELL;
      const bw = span * CELL;
      g.append(svg('rect', { x: bx + 1.5, y: by + 1.5, width: bw - 3, height: bh - 3, rx: 2 }));
      // Label the first cell only; the rest are the same mixer.
      if (i === 0) {
        if (bw >= 46 && bh >= 40) {
          g.append(
            svg('text', { class: 'b-scr', x: bx + bw / 2, y: by + bh / 2 - 4 },
              document.createTextNode(String(b.screen))),
            svg('text', { class: 'b-ly', x: bx + bw / 2, y: by + bh / 2 + 8 },
              document.createTextNode(isNative ? 'NAT' : `L${b.layer}`)),
          );
        } else {
          g.append(svg('text', { class: 'b-scr sm', x: bx + bw / 2, y: by + bh / 2 + 3.5 },
            document.createTextNode(String(b.screen))));
        }
      }
    });

    // the manual's wrap hook, for the derived fallback layout
    if (b.wrapped && (b.col === 0 || cols[0] === 0)) {
      g.append(svg('path', {
        class: 'hook',
        d: `M${x0 - 9},${by - CELL + bh / 2} q0,${CELL / 2} 7,${CELL / 2}`,
      }));
    }
    root.append(g);
  }

  // scaling-engine boundary — 4 output links (§5.5.4). Drawn last so it reads
  // across the blocks it constrains rather than hiding behind them.
  root.append(
    svg('line', {
      class: 'boundary',
      x1: x0 + SCALING_ENGINE_BOUNDARY * CELL, y1: y0,
      x2: x0 + SCALING_ENGINE_BOUNDARY * CELL, y2: y0 + FIELD,
    }),
  );

  return root;
}

function renderGrids(mixers, colours) {
  const grids = buildLinkGrid(mixers);
  els.grids.replaceChildren(
    ...grids.map((g) =>
      el(
        'figure',
        { class: `vpu-card${g.fitted ? '' : ' unfitted'}` },
        renderVpu(g, colours),
        el(
          'figcaption',
          {},
          el('b', { text: `VPU ${g.vpu}` }),
          el('span', {
            text: g.fitted
              ? `${g.blocks.length} block${g.blocks.length === 1 ? '' : 's'} · ${g.rowsUsed}/${LINKS_PER_VPU} layer links` +
                (g.spare ? ` · ${g.spare} spare` : '')
              : 'not fitted',
          }),
        ),
      ),
    ),
  );

  const placed = grids.reduce((n, g) => n + g.blocks.length, 0);
  const reported = grids.some((g) => g.placement === 'reported-columns');

  els.derivedNote.dataset.kind = reported ? 'partial' : 'derived';
  els.derivedNote.replaceChildren(
    el('b', {
      text: reported
        ? 'Columns are the device\u2019s own; rows are derived.'
        : 'Derived layout \u2014 position is not reported by the device.',
    }),
    el('span', {
      text: reported
        ? `Each of these ${placed} mixers reports exactly which output links it drives, so horizontal ` +
          'position is the device\u2019s. Nothing identifies the layer link, though \u2014 two layers of one ' +
          'screen share both their output links and their slice numbers \u2014 so rows are packed: one row per ' +
          'slice, starting at the first row where the run\u2019s columns are free. Runs on separate links share ' +
          'rows; runs that collide stack.'
        : `The device says what each of these ${placed} blocks serves (screen, layer, slice, capability) ` +
          'but not which link it occupies. Blocks are placed by laying each screen-and-layer run left to right ' +
          'in capacity-sized squares, wrapping onto another layer link when a run fills one. ' +
          'Sizes, counts and grouping are real; exact row and column are not.',
    }),
  );
}

function renderBudget(sum, colours) {
  if (!sum.allocations.length) {
    els.budget.replaceChildren(
      el('div', { class: 'row' }, el('span', { class: 'kind', text: 'No mixers enabled' })),
    );
    return;
  }

  els.budget.replaceChildren(
    ...sum.allocations.map((a) => {
      const colour = colours.get(a.screen) || 'c1';
      return el(
        'div',
        { class: `row ${colour}` },
        el('span', { class: 'name', text: String(a.screen) }),
        el('span', { class: 'kind', text: a.layer === 'NATIVE' ? 'Native' : `Layer ${a.layer}` }),
        el(
          'span',
          { class: 'slices' },
          ...a.slices.map((s) => el('span', { class: 'slice', text: String(s) })),
        ),
        el(
          'span',
          { class: 'cost' },
          `${a.mixers.length} mixer${a.mixers.length === 1 ? '' : 's'}`,
          a.pipes.length ? el('em', { text: a.pipes.join(', ') }) : null,
        ),
      );
    }),
  );
}

function renderDiff(changes, mixers, colours) {
  if (!changes.length) {
    els.diffSection.hidden = true;
    return;
  }
  els.diffSection.hidden = false;
  els.diff.replaceChildren(
    ...changes.map((c) => {
      const rec = (mixers || {})[c.mixer] || {};
      const colour = colours.get(rec.usedInScreen) || '';
      const links = c.changed.filter((d) => d.prop.startsWith('link ')).length;
      const props = c.changed.length - links;
      const cost = [
        links ? `${links} link${links === 1 ? '' : 's'}` : null,
        props ? `${props} prop${props === 1 ? '' : 's'}` : null,
      ].filter(Boolean).join(' · ');

      return el(
        'div',
        { class: `row ${colour}` },
        el('span', { class: 'name', text: c.mixer.replace(/^PROC_(\d+)_MIXER_(\d+)$/, 'P$1·$2') }),
        el('span', {
          class: 'kind',
          text: rec.usedInScreen
            ? `${rec.usedInScreen} ${rec.usedInLayer === 'NATIVE' ? 'native' : `layer ${rec.usedInLayer}`}`
            : 'not in use',
        }),
        el(
          'span',
          { class: 'slices' },
          el('span', {
            class: 'kind',
            text: c.changed.map((d) => `${d.prop}: ${d.from} → ${d.to}`).join('   '),
          }),
        ),
        el('span', { class: 'cost', text: cost }),
      );
    }),
  );
}

function renderDetail(mixers) {
  const cols = [
    'mixer', 'enabled', 'screen', 'layer', 'slice', 'ch',
    'capability', 'seamless', 'pipe 1', 'pipe 2', 'scaler A', 'scaler B',
  ];
  const head = el('thead', {}, el('tr', {}, ...cols.map((c) => el('th', { text: c }))));

  const rows = MIXER_IDS.filter((id) => mixers[id] && mixers[id].isAvailable).map((id) => {
    const r = mixers[id];
    const sc = (s) => (r.scalers?.[s] ? `${r.scalers[s].memoryFill}/${r.scalers[s].memoryCut}` : '—');
    const cells = [
      el('td', { class: 'm', text: id }),
      el('td', { text: r.isEnabled ? 'yes' : 'no' }),
      el('td', { text: r.isEnabled ? String(r.usedInScreen) : '—' }),
      el('td', { text: r.isEnabled ? layerLabel(r.usedInLayer) : '—' }),
      el('td', { text: r.isEnabled ? String(r.slice) : '—' }),
      el('td', { text: String(r.channel ?? '—') }),
      el('td', { text: String(r.capability ?? '—') }),
      el('td', { text: r.seamlessCapa ? 'yes' : 'no' }),
      el('td', { text: String(r.mixerAllocation?.usedOnOutPipe1 ?? '—') }),
      el('td', { text: String(r.mixerAllocation?.usedOnOutPipe2 ?? '—') }),
      el('td', { text: sc('A') }),
      el('td', { text: sc('B') }),
    ];
    return el('tr', {}, ...cells);
  });

  els.detail.replaceChildren(head, el('tbody', {}, ...rows));
}

function render(payload) {
  const current = payload.current || {};
  const staged = payload.new || null;
  const changes = staged ? diff(current, staged) : [];
  const sum = summarise(current);
  const colours = screenColourMap(sum.allocations);
  const changedIds = new Set(changes.map((c) => c.mixer));

  renderStats(sum, { diffCount: changes.length });
  renderChassis(current, colours, changedIds);
  renderGrids(current, colours);
  renderBudget(sum, colours);
  renderDiff(changes, current, colours);
  renderDetail(current);

  els.results.hidden = false;
}

/* ---------------- data ---------------- */

function describeSource(src, capturedAt) {
  const when = capturedAt ? new Date(capturedAt).toLocaleString() : '';
  if (!src) return when;
  const name = [src.dev, src.label].filter(Boolean).join(' · ');
  const where = src.kind === 'device' ? src.host : 'recorded capture';
  return [name, where, when].filter(Boolean).join(' — ');
}

async function readDevice(ip, device) {
  setStatus('busy', 'Reading…', `${ip} · device ${device}`);
  els.readBtn.disabled = true;
  els.sampleBtn.disabled = true;
  clearBanner();

  try {
    const res = await fetch(
      `./api/vpu?ip=${encodeURIComponent(ip)}&device=${encodeURIComponent(device)}`,
    );
    const body = await res.json();

    if (!body.ok) {
      if (body.code === 'NO_VPU_SUBTREE') {
        setStatus('error', 'No VPU map on this device');
        showBanner(
          'warn',
          'Connected, but this device exposes no VPU mixer map.',
          body.hint || 'The $vpuMixer collection is absent.',
        );
      } else {
        setStatus('error', 'Read failed');
        showBanner('error', `Could not read ${ip}.`, body.error || 'Unknown error.');
      }
      return;
    }

    localStorage.setItem(IP_KEY, ip);
    setStatus('live', 'Live', describeSource(body.source, body.capturedAt));
    render(body);
  } catch (err) {
    setStatus('error', 'Read failed');
    showBanner('error', 'Could not reach the app server.', String(err.message || err));
  } finally {
    els.readBtn.disabled = false;
    els.sampleBtn.disabled = false;
  }
}

async function loadSample() {
  setStatus('busy', 'Loading capture…');
  clearBanner();
  try {
    const res = await fetch(SAMPLE_URL);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const body = await res.json();
    setStatus('sample', 'Recorded capture', describeSource(body.source, body.capturedAt));
    showBanner(
      'info',
      'Showing a recorded capture, not a live device.',
      body.note || 'Recorded from a real Aquilon C.',
    );
    render(body);
  } catch (err) {
    setStatus('error', 'Could not load capture');
    showBanner('error', 'Could not load the recorded capture.', String(err.message || err));
  }
}

/* ---------------- boot ---------------- */

els.form.addEventListener('submit', (e) => {
  e.preventDefault();
  const ip = els.ip.value.trim();
  if (!ip) return;
  readDevice(ip, els.device.value);
});

els.sampleBtn.addEventListener('click', loadSample);

(async function init() {
  const saved = localStorage.getItem(IP_KEY);
  if (saved) {
    els.ip.value = saved;
  } else {
    try {
      const res = await fetch('./api/config');
      if (res.ok) {
        const cfg = await res.json();
        if (cfg.defaultIp) els.ip.value = cfg.defaultIp;
      }
    } catch {
      /* static hosting has no /api/config; the markup default stands */
    }
  }
})();

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
  optimizedVpus,
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
  screenStatus: $('screenStatus'),
  detail: $('detail'),
  diffSection: $('diffSection'),
  diff: $('diff'),
  diffTitle: $('diffTitle'),
  diffLede: $('diffLede'),
  poll: $('poll'),
  tools: $('tools'),
  saveBtn: $('saveBtn'),
  compareFile: $('compareFile'),
  clearCompare: $('clearCompare'),
  toolsNote: $('toolsNote'),
};

/** Whatever is on screen, and anything we are comparing it against. */
const state = { payload: null, baseline: null, baselineName: '', timer: null };

/** The operator's own screen names, when a live read supplied them. */
let SCREEN_NAMES = {};
const screenLabel = (s) => SCREEN_NAMES[s] || '';

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

function setStatus(dotState, text, source) {
  els.dot.dataset.state = dotState;
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

/** "S1 · Main LED" where a name is known, otherwise just "S1". */
const screenWithName = (s) => {
  const n = screenLabel(s);
  return n ? `${s} \u00b7 ${n}` : String(s);
};

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
    meta.comparing
      ? {
          k: 'Vs saved reading',
          v: `${meta.diffCount}`,
          n: meta.diffCount === 0 ? 'Identical to the saved reading' : 'Mixers differ from the saved reading',
        }
      : {
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
            `${id}\n${screenWithName(rec.usedInScreen)} · ${layerLabel(rec.usedInLayer)} · slice ${rec.slice}` +
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

function renderVpu(grid, colours, optimized) {
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
        `${b.mixer}\n${screenWithName(b.screen)} · ${layerLabel(b.layer)} · slice ${b.slice}` +
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

  // Scaling-engine boundary — 4 output links (§5.5.4). Drawn last so it reads
  // across the blocks it constrains rather than hiding behind them.
  //
  // Optimized mode REMOVES this boundary for the whole VPU (§5.5.6), so drawing
  // it there would show a constraint the device is not applying.
  if (!optimized) {
    root.append(
      svg('line', {
        class: 'boundary',
        x1: x0 + SCALING_ENGINE_BOUNDARY * CELL, y1: y0,
        x2: x0 + SCALING_ENGINE_BOUNDARY * CELL, y2: y0 + FIELD,
      }),
    );
  }

  return root;
}

function renderGrids(mixers, colours, screenStatus) {
  const grids = buildLinkGrid(mixers);
  const optimised = optimizedVpus(mixers, screenStatus);
  els.grids.replaceChildren(
    ...grids.map((g) =>
      el(
        'figure',
        { class: `vpu-card${g.fitted ? '' : ' unfitted'}` },
        renderVpu(g, colours, optimised.has(g.vpu)),
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
          optimised.has(g.vpu)
            ? el('span', {
                class: 'badge',
                title: 'Optimized mode: the 4-link scaling-engine boundary does not apply to this VPU (manual §5.5.6)',
                text: 'optimized',
              })
            : null,
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

function renderBudget(sum, colours, screenStatus, stagedStatus) {
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
        // The screen-status strip above already names every screen; repeating it
        // here only made these rows wrap.
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

/**
 * What the device itself says each screen is spending, and what is left.
 * These are reported figures, not derived from the mixer table.
 */
function renderScreenStatus(screenStatus, stagedStatus, colours) {
  const entries = Object.entries(screenStatus || {});
  if (!entries.length) {
    els.screenStatus.hidden = true;
    return { exceeding: [] };
  }
  els.screenStatus.hidden = false;

  const exceeding = [];
  els.screenStatus.replaceChildren(
    ...entries.map(([id, st]) => {
      const staged = (stagedStatus || {})[id] || {};
      const over =
        (staged.exceedingOutputCapabilities || 0) + (staged.exceedingLayerCapabilities || 0);
      if (over > 0) exceeding.push(id);
      const remaining = staged.remainingOutputCapabilities;

      return el(
        'div',
        { class: `sstat ${colours.get(id) || ''}${over ? ' over' : ''}` },
        el('span', { class: 'sid', text: screenWithName(id) }),
        el('span', { class: 'sfig' },
          el('b', { text: String(st.usedOutputCapabilities ?? '—') }),
          ' output links',
        ),
        el('span', { class: 'sfig' },
          el('b', { text: String(st.layerCount ?? '—') }),
          ` layer${st.layerCount === 1 ? '' : 's'} over `,
          el('b', { text: String(st.outputCount ?? '—') }),
          ` output${st.outputCount === 1 ? '' : 's'}`,
        ),
        el('span', {
          class: 'snote',
          text: over
            ? `over capacity by ${over}`
            : remaining !== undefined
              ? `${remaining} output link${remaining === 1 ? '' : 's'} spare`
              : '',
        }),
        st.isOptimized ? el('span', { class: 'badge', text: 'optimized' }) : null,
      );
    }),
  );
  return { exceeding };
}

function renderDiff(changes, mixers, colours, comparing) {
  els.diffTitle.textContent = comparing ? 'Changed since the saved reading' : 'Staged changes';
  els.diffLede.textContent = comparing
    ? `These mixers differ from ${state.baselineName || 'the saved reading'} \u2014 what has moved since.`
    : 'The device keeps a running allocation and a staged one. These mixers differ '
      + 'between the two \u2014 this is what applying the pending configuration would cost.';
  if (!changes.length) {
    els.diffSection.hidden = true;
    els.diff.replaceChildren(); // do not leave the previous comparison behind
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
            ? `${screenWithName(rec.usedInScreen)} ${rec.usedInLayer === 'NATIVE' ? 'native' : `layer ${rec.usedInLayer}`}`
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
      el('td', { text: r.isEnabled ? screenWithName(r.usedInScreen) : '—' }),
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
  state.payload = payload;
  SCREEN_NAMES = payload.screens || {};

  const current = payload.current || {};

  // Compare against a saved reading when one is loaded, otherwise against the
  // device's own staged mapping. Same machinery either way.
  const comparing = !!state.baseline;
  const against = comparing ? state.baseline.current || {} : payload.new;
  const changes = against ? diff(comparing ? against : current, comparing ? current : against) : [];

  const sum = summarise(current);
  const colours = screenColourMap(sum.allocations);
  const changedIds = new Set(changes.map((c) => c.mixer));

  renderStats(sum, { diffCount: changes.length, comparing });
  renderChassis(current, colours, changedIds);
  renderGrids(current, colours, (payload.screenStatus || {}).current);
  renderBudget(sum, colours);
  const status = (payload.screenStatus || {}).current;
  const staged = (payload.screenStatus || {}).new;
  const { exceeding } = renderScreenStatus(status, staged, colours);
  if (exceeding.length) {
    showBanner(
      'warn',
      `${exceeding.length} screen${exceeding.length === 1 ? '' : 's'} exceed available capacity.`,
      `${exceeding.join(', ')} — the device reports the staged configuration as over budget. ` +
        'It will not fit as configured.',
    );
  }
  renderDiff(changes, current, colours, comparing);
  renderDetail(current);

  els.results.hidden = false;
  els.tools.hidden = false;
}

/* ---------------- data ---------------- */

function describeSource(src, capturedAt) {
  const when = capturedAt ? new Date(capturedAt).toLocaleString() : '';
  if (!src) return when;
  const name = [src.dev, src.label].filter(Boolean).join(' · ');
  const where = src.kind === 'device' ? src.host : 'recorded capture';
  return [name, where, when].filter(Boolean).join(' — ');
}

async function readDevice(ip, device, { quiet = false } = {}) {
  if (!quiet) {
    setStatus('busy', 'Reading…', `${ip} · device ${device}`);
    els.readBtn.disabled = true;
    els.sampleBtn.disabled = true;
    clearBanner();
  }

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
        stopPolling('a read failed');
      }
      return;
    }

    localStorage.setItem(IP_KEY, ip);
    setStatus('live', pollSeconds() ? `Live \u00b7 every ${pollSeconds()}s` : 'Live',
      describeSource(body.source, body.capturedAt));
    render(body);
  } catch (err) {
    setStatus('error', 'Read failed');
    showBanner('error', 'Could not reach the app server.', String(err.message || err));
    stopPolling('the app server could not be reached');
  } finally {
    els.readBtn.disabled = false;
    els.sampleBtn.disabled = false;
  }
}

async function loadSample() {
  stopPolling();
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

/* ---------------- keep watching, save, compare ---------------- */

const pollSeconds = () => Number(els.poll.value) || 0;

function stopPolling(why) {
  if (!state.timer) return;
  clearInterval(state.timer);
  state.timer = null;
  els.poll.value = '0';
  if (why) els.toolsNote.textContent = `stopped watching \u2014 ${why}`;
}

function startPolling() {
  stopPolling();
  const secs = pollSeconds();
  if (!secs) return;
  // Only ever re-reads what is already on screen; never starts a read by itself.
  state.timer = setInterval(() => {
    const ip = els.ip.value.trim();
    if (ip) readDevice(ip, els.device.value, { quiet: true });
  }, secs * 1000);
}

function saveReading() {
  if (!state.payload) return;
  const src = state.payload.source || {};
  const stamp = new Date().toISOString().slice(0, 19).split(':').join('-');
  const name = `vpu-reading-${(src.dev || 'device').toLowerCase()}-${stamp}.json`;
  const blob = new Blob([JSON.stringify(state.payload, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
  els.toolsNote.textContent = `saved ${name}`;
}

async function loadBaseline(file) {
  try {
    const text = await file.text();
    const body = JSON.parse(text);
    if (!body || !body.current) throw new Error('not a VPU reading — no "current" mapping');
    state.baseline = body;
    state.baselineName = file.name;
    els.clearCompare.hidden = false;
    els.toolsNote.textContent = `comparing against ${file.name}`;
    if (state.payload) render(state.payload);
    else showBanner('info', 'Saved reading loaded.', 'Read a device to compare it against.');
  } catch (err) {
    showBanner('error', 'Could not read that file.', String(err.message || err));
  }
}

function clearBaseline() {
  state.baseline = null;
  state.baselineName = '';
  els.clearCompare.hidden = true;
  els.compareFile.value = '';
  els.toolsNote.textContent = '';
  if (state.payload) render(state.payload);
}

els.poll.addEventListener('change', () => {
  els.toolsNote.textContent = '';
  if (!pollSeconds()) { stopPolling(); return; }
  if (state.payload && state.payload.mode === 'live') startPolling();
});
els.saveBtn.addEventListener('click', saveReading);
els.compareFile.addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0];
  if (f) loadBaseline(f);
});
els.clearCompare.addEventListener('click', clearBaseline);

/* ---------------- boot ---------------- */

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const ip = els.ip.value.trim();
  if (!ip) return;
  await readDevice(ip, els.device.value);
  if (state.payload && state.payload.mode === 'live') startPolling();
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

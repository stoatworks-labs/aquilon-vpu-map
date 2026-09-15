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
  stackVpus,
  screenOutputLinks,
} from './vpu.js';

const $ = (id) => document.getElementById(id);

const els = {
  form: $('connForm'),
  ip: $('ip'),
  device: $('device'),
  readBtn: $('readBtn'),
  sampleBtn: $('sampleBtn'),
  sample: $('sample'),
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

// The recorded captures, listed in data/captures.json. They are the only way to
// exercise the tool without a device in front of you — which is now the normal
// case — so every committed capture is offered, not just the first.
const CAPTURE_INDEX = './data/captures.json';
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
    el('span', { class: 'key' }, el('span', { class: 'swatch solid' }), 'Native layer'),
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
const BAND_GAP = 12; // between the background band and the layer field
const HEAD = 15; // the screen bar over the output links, as the manual draws it
const HDR = 12; // one header row: the region, then the output, of each link
const TAIL = 11; // room under the output arrows for "↓ VPU n"
const FIELD = CELL * LINKS_PER_VPU;

/**
 * One VPU, as the manual draws it (§5.5), read top to bottom the way an output
 * link runs through it: in at the top, through the native background first,
 * then down the eight layer links, and out at the bottom — into the next VPU
 * when the screen continues there.
 *
 * @param {object} grid one of `buildLinkGrid`'s
 * @param {Map} colours screen -> colour class
 * @param {boolean} optimized whether this VPU is in Optimized mode
 * @param {Map} [outputLinks] `screenOutputLinks`, for the header over the columns
 */
function renderVpu(grid, colours, optimized, outputLinks) {
  const bandRows = grid.backgroundRows || 0;
  const screens = grid.screens || [];
  // The header: the screen bar, then — when the device's outputs are known —
  // which region and which output plug each of its links is.
  const known = screens.filter((s) => outputLinks?.get(s.screen)?.consistent);
  const headerRows = known.length ? 2 : 0;
  const head = screens.length ? HEAD + 4 + headerRows * (HDR + 2) : 0;
  const continues = screens.some((s) => s.to !== undefined);

  // Native backgrounds spend output capacity but not layer capacity, so they
  // are drawn in a band of their own — above the field, because a native is
  // the bottom of the stack and so the first thing on the output link.
  const top = head + PAD_T;
  const bandTop = top;
  const bandH = bandRows * CELL;
  const y0 = top + (bandRows ? bandH + BAND_GAP : 0);
  const bottom = y0 + FIELD;

  const W = PAD_L + FIELD + 14;
  const H = bottom + PAD_T + (continues ? TAIL : 0);
  const root = svg('svg', {
    class: `vpu${grid.fitted ? '' : ' unfitted'}`,
    viewBox: `0 0 ${W} ${H}`,
    role: 'img',
    'aria-label': `VPU ${grid.vpu}, ${grid.blocks.length} layer blocks`,
  });

  const x0 = PAD_L;
  // Where a block's row sits: the field for layers, the band for backgrounds.
  const yOf = (row) =>
    row >= LINKS_PER_VPU ? bandTop + (row - LINKS_PER_VPU) * CELL : y0 + row * CELL;

  // Which output links belong to which screen. The manual puts this bar over the
  // field (§5.5.5) and it is the thing that makes the columns readable: a screen
  // owns a contiguous run of links, and its layers all start at the same one.
  for (const s of screens) {
    const sx = x0 + s.col * CELL;
    const sw = s.width * CELL;
    const colour = colours.get(s.screen) || 'c1';
    const g = svg('g', { class: `screen-bar ${colour}${s.from !== undefined ? ' cont' : ''}` });
    g.append(
      svg('title', {}, document.createTextNode(
        `${screenWithName(s.screen)} · output link${s.width === 1 ? '' : 's'} 1-${s.width}` +
        (s.from !== undefined ? `\ncontinues from VPU ${s.from} — the same output links, more layers` : '') +
        (s.to !== undefined ? `\ncontinues onto VPU ${s.to}` : ''),
      )),
      svg('rect', { x: sx + 1.5, y: 2, width: sw - 3, height: HEAD, rx: 2 }),
      svg('text', { x: sx + sw / 2, y: 2 + HEAD - 4 }, document.createTextNode(String(s.screen))),
    );
    root.append(g);

    // The header proper: a cell per region run, then one per output, each on
    // the links it carries. Only for screens whose outputs add up to what the
    // screen itself reports — see `screenOutputLinks`.
    const info = outputLinks?.get(s.screen);
    if (!info?.consistent) continue;
    const cell = (row, first, last, text, title) => {
      const cx = x0 + (s.col + first - 1) * CELL;
      const cw = (last - first + 1) * CELL;
      const cy = 2 + HEAD + 2 + row * (HDR + 2);
      const c = svg('g', { class: `hdr ${colour}` });
      c.append(
        svg('title', {}, document.createTextNode(title)),
        svg('rect', { x: cx + 1.5, y: cy, width: cw - 3, height: HDR, rx: 1.5 }),
        svg('text', { x: cx + cw / 2, y: cy + HDR - 3 }, document.createTextNode(text)),
      );
      root.append(c);
    };
    // Regions: adjacent outputs in the same region share one cell. Links past
    // this VPU's run of the screen are not drawn here.
    const runs = info.runs.filter((r) => r.first <= s.width);
    const regions = [];
    for (const r of runs) {
      const last = Math.min(r.last, s.width);
      const tail = regions[regions.length - 1];
      if (tail && tail.name === r.region) tail.last = last;
      else regions.push({ name: r.region, first: r.first, last });
    }
    for (const r of regions) {
      cell(0, r.first, r.last, r.name === null ? '—' : `R${r.name}`,
        `${screenWithName(s.screen)} · region ${r.name ?? '?'} · output link${r.last === r.first ? '' : 's'} ` +
        (r.last === r.first ? `${r.first}` : `${r.first}-${r.last}`));
    }
    for (const r of runs) {
      const last = Math.min(r.last, s.width);
      const wide = last - r.first + 1 >= 2;
      cell(1, r.first, last, wide ? `Out ${r.output}` : String(r.output),
        `Output ${r.output}${r.label ? ` · ${r.label}` : ''}` +
        `\n${screenWithName(s.screen)} · region ${r.region ?? '?'} · link${last === r.first ? '' : 's'} ` +
        (last === r.first ? `${r.first}` : `${r.first}-${last}`) +
        `\ncapability ${r.capability ?? '?'}` +
        (r.type ? ` · ${r.type}` : '') +
        (r.card ? `\n${r.card}${r.physical ? ` plug ${r.physical}` : ''}` : ''));
    }
  }

  // chassis — the band first, then the field
  if (bandRows) {
    root.append(
      svg('rect', {
        class: 'field band', x: x0, y: bandTop, width: FIELD, height: bandH, rx: 2,
      }),
      svg('text', { class: 'band-label', x: x0 - 6, y: bandTop + bandH / 2 + 3.5 },
        document.createTextNode('bg')),
    );
  }
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
    if (bandRows) {
      root.append(
        svg('line', { class: 'lattice', x1: x0 + i * CELL, y1: bandTop, x2: x0 + i * CELL, y2: bandTop + bandH }),
      );
    }
  }
  for (let i = 1; i < bandRows; i++) {
    root.append(
      svg('line', { class: 'lattice', x1: x0, y1: bandTop + i * CELL, x2: x0 + FIELD, y2: bandTop + i * CELL }),
    );
  }

  // Which output links arrive from an earlier VPU, and which carry on to a later
  // one: those arrows take the screen's colour, and the ones leaving say where.
  const arriving = new Map();
  const leaving = new Map();
  for (const s of screens) {
    for (let c = s.col; c < s.col + s.width && c < LINKS_PER_VPU; c++) {
      if (s.from !== undefined) arriving.set(c, s);
      if (s.to !== undefined) leaving.set(c, s);
    }
  }

  // layer links in (left) — eight of them, and only for the field: a background
  // is not on a layer link. Output links in through the top of whichever section
  // is first and out through the bottom of the field.
  for (let i = 0; i < LINKS_PER_VPU; i++) {
    const cy = y0 + i * CELL + CELL / 2;
    root.append(
      svg('line', { class: 'in', x1: x0 - 26, y1: cy, x2: x0 - 4, y2: cy, 'marker-end': `url(#in-${grid.vpu})` }),
    );
    const cx = x0 + i * CELL + CELL / 2;
    const inFrom = arriving.get(i);
    const outTo = leaving.get(i);
    const inCls = inFrom ? `out cascade ${colours.get(inFrom.screen) || 'c1'}` : 'out';
    const outCls = outTo ? `out cascade ${colours.get(outTo.screen) || 'c1'}` : 'out';
    root.append(
      svg('line', {
        class: inCls, x1: cx, y1: top - 16, x2: cx, y2: top - 3,
        'marker-end': `url(#out-${inFrom ? colours.get(inFrom.screen) || 'c1' : ''}${grid.vpu})`,
      }),
      svg('line', {
        class: outCls, x1: cx, y1: bottom + 3, x2: cx, y2: bottom + 16,
        'marker-end': `url(#out-${outTo ? colours.get(outTo.screen) || 'c1' : ''}${grid.vpu})`,
      }),
    );
  }
  for (const s of screens) {
    if (s.to === undefined) continue;
    root.append(
      svg('text', {
        class: `cascade-label ${colours.get(s.screen) || 'c1'}`,
        x: x0 + (s.col + Math.min(s.width, LINKS_PER_VPU - s.col) / 2) * CELL,
        y: bottom + PAD_T + TAIL - 4,
      }, document.createTextNode(`↓ VPU ${s.to}`)),
    );
  }

  // arrowheads — one per colour a cascade needs, on top of the two plain ones
  const marker = (id, cls) =>
    svg('marker', { id, viewBox: '0 0 8 8', refX: 6, refY: 4, markerWidth: 5, markerHeight: 5, orient: 'auto-start-reverse' },
      svg('path', { class: cls, d: 'M0,1 L7,4 L0,7 z' }));
  const cascadeColours = new Set(
    [...arriving.values(), ...leaving.values()].map((s) => colours.get(s.screen) || 'c1'),
  );
  root.append(svg('defs', {},
    marker(`in-${grid.vpu}`, 'ah-in'),
    marker(`out-${grid.vpu}`, 'ah-out'),
    ...[...cascadeColours].map((c) => marker(`out-${c}${grid.vpu}`, `ah-out ${c}`)),
  ));

  // Layer blocks. A block is one layer: its own rows, no other layer on them, and
  // one continuous bar across the output links it feeds. The device reports those
  // links INTERLEAVED — S1 on 1 and 3, S3 on 2 and 4 — so the bar spans from the
  // first to the last, and a crosspoint mark on each link it actually drives says
  // which are its own. Rows are exclusive, so S3's bar sitting under S1's over the
  // same columns is not a collision. The slices are inside the bar, on those links.
  for (const b of grid.blocks) {
    const colour = colours.get(b.screen) || 'c1';
    const isNative = b.background || b.layer === 'NATIVE';
    const cols = b.cols || [b.col];
    const span = b.size || 1;
    const rows = b.height || span;
    const by = yOf(b.row);
    const bh = rows * CELL;
    const mixers = b.mixers || [b.mixer];
    const slices = b.slices || [b.slice];

    const first = cols[0];
    const last = cols[cols.length - 1];
    const bx = x0 + first * CELL;
    const bw = (last - first + span) * CELL;
    // Links inside the bar that this layer does not drive — the interleave.
    const skipped = [];
    for (let c = first; c <= last; c++) if (!cols.includes(c)) skipped.push(c);

    const g = svg('g', { class: `blk ${colour}${isNative ? ' bg' : ' layered'}` });
    g.append(
      svg('title', {}, document.createTextNode(
        `${mixers.join(', ')}\n${screenWithName(b.screen)} · ${layerLabel(b.layer)}` +
        `\nslice${slices.length === 1 ? '' : 's'} ${slices.join(', ')}` +
        `\ncapability ${b.capability}` +
        (isNative
          ? '\nnative background — spends output capacity, not layer capacity'
          : `\n${rows} layer-capacity link${rows === 1 ? '' : 's'}`) +
        (b.cutnfill && b.cutnfill !== 'OFF' ? `\ncut & fill ${b.cutnfill}` : '') +
        `\n${screenWithName(b.screen)} output link${
          (b.outputs || cols).length === 1 ? '' : 's'
        } ${(b.outputs || cols.map((c) => c + 1)).join(', ')}` +
        (b.wrapped ? '\nwrapped onto another layer link at the centre line (§5.5.4)' : ''),
      )),
    );

    // Adjacent links are one continuous crosspoint, not a row of cells: only a
    // gap in what the device reports breaks the block.
    const runs = [];
    for (const c of cols) {
      const tail = runs[runs.length - 1];
      if (tail && c === tail[1] + 1) tail[1] = c;
      else runs.push([c, c]);
    }

    // When the device interleaves a layer's links — S1 on 1 and 3, S3 on 2 and 4 —
    // a dashed outline over the whole reach says the pieces are one layer. With
    // nothing skipped the block is already continuous and needs no outline.
    if (runs.length > 1) {
      g.append(svg('rect', {
        class: 'span', x: bx + 1.5, y: by + 1.5, width: bw - 3, height: bh - 3, rx: 2,
      }));
    }

    for (const [from, to] of runs) {
      g.append(svg('rect', {
        class: 'xp',
        x: x0 + from * CELL + 1.5,
        y: by + 1.5,
        width: (to - from + span) * CELL - 3,
        height: bh - 3,
        rx: 2,
      }));
    }

    // The label sits in the block's first crosspoint. Rows separate layers now, so
    // the layer has to be on it — four bars all reading "S1" says nothing.
    const layerLabelShort = isNative ? 'NAT' : `L${b.layer}`;
    if (bh >= 40) {
      g.append(
        svg('text', { class: 'b-scr', x: bx + CELL / 2, y: by + bh / 2 - 4 },
          document.createTextNode(String(b.screen))),
        svg('text', { class: 'b-ly', x: bx + CELL / 2, y: by + bh / 2 + 8 },
          document.createTextNode(layerLabelShort)),
      );
    } else {
      g.append(svg('text', { class: 'b-scr sm', x: bx + 5, y: by + bh / 2 + 3.5 },
        document.createTextNode(`${b.screen} ${layerLabelShort}`)));
    }
    // Several slices ride one set of links — the count says how many.
    if (slices.length > 1 && bh >= 24) {
      g.append(svg('text', { class: 'b-sl', x: bx + bw - 4, y: by + bh - 4 },
        document.createTextNode(`×${slices.length}`)));
    }

    // The manual's ↳ hook, at the start of a piece that had to take another layer
    // link because the layer reached past the centre line (§5.5.4).
    if (b.wrapped) {
      const hx = bx - 9;
      g.append(svg('path', {
        class: 'hook',
        d: `M${hx},${by - 9} L${hx},${by + bh / 2 - 4} q0,4 4,4 L${bx - 1},${by + bh / 2}`,
      }));
    }
    root.append(g);
  }


  // Scaling-engine boundary — the centre line at 4 output links (§5.5.4). Drawn
  // last so it reads across the blocks it constrains rather than hiding behind
  // them, and drawn on every VPU: a layer-capacity link cannot cross it, which is
  // why layers reaching both halves are split into two rows. Optimized mode is
  // marked by the badge instead of by hiding the line, since the blocks either
  // side of it are split there too.
  const cls = `boundary${optimized ? ' soft' : ''}`;
  const bnd = x0 + SCALING_ENGINE_BOUNDARY * CELL;
  root.append(svg('line', { class: cls, x1: bnd, y1: y0, x2: bnd, y2: y0 + FIELD }));
  if (bandRows) {
    root.append(svg('line', { class: cls, x1: bnd, y1: bandTop, x2: bnd, y2: bandTop + bandH }));
  }

  return root;
}

function renderGrids(mixers, colours, screenStatus, outputs) {
  const optimised = optimizedVpus(mixers, screenStatus);
  const grids = buildLinkGrid(mixers, optimised);
  const outputLinks = screenOutputLinks(outputs, screenStatus);

  const card = (g) =>
    el(
      'figure',
      { class: `vpu-card${g.fitted ? '' : ' unfitted'}` },
      el(
        'figcaption',
        {},
        el('b', { text: `VPU ${g.vpu}` }),
        el('span', {
          text: g.fitted
            ? `${g.blocks.length} block${g.blocks.length === 1 ? '' : 's'} · ${g.rowsUsed}/${LINKS_PER_VPU} layer links` +
              (g.backgroundRows ? ` · ${g.backgroundRows} background` : '') +
              (g.spare ? ` · ${g.spare} spare` : '')
            : 'not fitted',
        }),
        optimised.has(g.vpu)
          ? el('span', {
              class: 'badge',
              title: 'Optimized mode is on for this VPU (manual §5.5.6) — one of its screens uses at least 5 output links and a capacity-2 layer',
              text: 'optimized',
            })
          : null,
        ...(g.screens || [])
          .filter((s) => s.from !== undefined)
          .map((s) =>
            el('span', {
              class: `badge cont ${colours.get(s.screen) || 'c1'}`,
              title: `${screenWithName(s.screen)} ran out of mixers on VPU ${s.from}: its next layer is here, on the same output links`,
              text: `${s.screen} continues from VPU ${s.from}`,
            }),
          ),
      ),
      renderVpu(g, colours, optimised.has(g.vpu), outputLinks),
    );

  // A screen that continues onto another VPU has its output links running out
  // of the bottom of one card and into the top of the next, so those cards are
  // stacked, in signal order, rather than sat side by side.
  const byVpu = new Map(grids.map((g) => [g.vpu, g]));
  els.grids.replaceChildren(
    ...stackVpus(grids).map((members) => {
      const cards = members.map((v) => card(byVpu.get(v)));
      if (cards.length === 1) return cards[0];
      return el('div', { class: 'vpu-stack', style: `grid-row: span ${cards.length}` }, ...cards);
    }),
  );

  const placed = grids.reduce((n, g) => n + g.blocks.length, 0);
  const reported = grids.some((g) => g.placement === 'reported-columns');
  const headed = outputLinks.size > 0;

  els.derivedNote.dataset.kind = reported ? 'partial' : 'derived';
  els.derivedNote.replaceChildren(
    el('b', {
      text: reported
        ? 'Laid out the way the manual draws a VPU.'
        : 'Derived layout \u2014 position is not reported by the device.',
    }),
    el('span', {
      text: reported
        ? `Each of these ${placed} bars is one layer on the output links it drives. A screen owns a ` +
          'contiguous run of links \u2014 the device reports which, in the value of each output pipe \u2014 so ' +
          'all of a screen\u2019s layers start at the same one. A row is one layer-capacity link and carries ' +
          'one layer, as many rows as the layer\u2019s capacity, so no two layers share a row and slices of ' +
          'one layer share its bar. A layer past four output links wraps onto another link at the centre ' +
          'line (\u00a75.5.4) unless Optimized mode lifts that for it (\u00a75.5.6). Native backgrounds spend ' +
          'output capacity but not layer capacity, so they sit in the band above the eight links \u2014 first ' +
          'on the output link, as the bottom of the stack. A screen that runs out of mixers continues on the ' +
          'next VPU, on the same output links, so those VPUs are stacked and the links run straight down. ' +
          (headed
            ? 'The header over each link names its region and output plug, dealt out in output order, ' +
              'which the device\u2019s own figures agree with. '
            : 'Nothing in this capture says which output plug each link is, so the header stops at the screen. ') +
          'Nothing names the layer link itself, so only the order down the field is derived.'
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
  renderGrids(current, colours, (payload.screenStatus || {}).current, payload.outputs);
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

/**
 * The one place that differs between the two builds.
 *
 * Desktop (Tauri): Rust makes the AWJ connection and `read_vpu` returns the
 * same JSON shape the server's /api/vpu returns.
 * Server (Node): the bridge does it, because a browser cannot open a TCP socket.
 *
 * Everything below this line is identical either way, which is the point —
 * one UI, and no branch inside the rendering.
 */
const isDesktop = () => typeof window !== 'undefined' && !!window.__TAURI__;

async function readVpu(ip, device) {
  if (isDesktop()) {
    try {
      return await window.__TAURI__.core.invoke('read_vpu', { ip, device });
    } catch (err) {
      // A rejected command carries the reason as a plain string.
      return { ok: false, code: 'READ_FAILED', error: String(err), source: { host: ip, device } };
    }
  }
  const res = await fetch(
    `./api/vpu?ip=${encodeURIComponent(ip)}&device=${encodeURIComponent(device)}`,
  );
  return res.json();
}


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
    const body = await readVpu(ip, device);

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

/**
 * Fill the capture picker from data/captures.json.
 *
 * A missing or broken index is not an error worth showing: the tool still has
 * the capture it has always had, so fall back to that one silently.
 */
async function loadCaptureIndex() {
  try {
    const res = await fetch(CAPTURE_INDEX);
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    const list = Array.isArray(body && body.captures) ? body.captures : [];
    if (!list.length) throw new Error('empty index');
    els.sample.replaceChildren(
      ...list.map((c) =>
        el('option', { value: `./data/${c.file}`, title: c.summary || '', text: c.label || c.file }),
      ),
    );
    return true;
  } catch {
    els.sample.replaceChildren(el('option', { value: SAMPLE_URL, text: 'Recorded capture' }));
    return false;
  }
}

async function loadSample() {
  stopPolling();
  setStatus('busy', 'Loading capture…');
  clearBanner();
  try {
    const res = await fetch(els.sample.value || SAMPLE_URL);
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
  await loadCaptureIndex();
  if (isDesktop()) {
    const note = document.getElementById('connNote');
    if (note) {
      note.textContent =
        'Reads only \u2014 this app never writes to the device. It speaks AWJ on TCP 10606 directly.';
    }
  }

  const saved = localStorage.getItem(IP_KEY);
  if (saved) {
    els.ip.value = saved;
  } else if (!isDesktop()) {
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

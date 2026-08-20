// Aquilon VPU Map — UI.
//
// The rendering is fed by one shape, whether it came from a live read or from a
// recorded capture, so there is no live/offline branching below the fetch.

import {
  MIXER_IDS,
  PROCESSORS,
  MIXERS_PER_PROCESSOR,
  parseMixerId,
  summarise,
  diff,
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
      const pipes = [rec.mixerAllocation?.usedOnOutPipe1, rec.mixerAllocation?.usedOnOutPipe2]
        .map((v, i) => (v && v !== 'NONE' ? `pipe${i + 1} ${v}` : null))
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

function renderDiff(changes) {
  if (!changes.length) {
    els.diffSection.hidden = true;
    return;
  }
  els.diffSection.hidden = false;
  els.diff.replaceChildren(
    ...changes.map((c) =>
      el(
        'div',
        { class: 'row' },
        el('span', { class: 'name', text: c.mixer.replace(/^PROC_(\d+)_MIXER_(\d+)$/, 'P$1·$2') }),
        el('span', { class: 'kind', text: 'changed' }),
        el(
          'span',
          { class: 'slices' },
          el('span', {
            class: 'kind',
            text: c.changed.map((d) => `${d.prop}: ${d.from} → ${d.to}`).join('   '),
          }),
        ),
        el('span', { class: 'cost', text: `${c.changed.length} prop${c.changed.length === 1 ? '' : 's'}` }),
      ),
    ),
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
  renderBudget(sum, colours);
  renderDiff(changes);
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

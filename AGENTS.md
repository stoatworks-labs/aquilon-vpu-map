# AGENTS.md — Aquilon VPU Map

Onboarding for an LLM or a newcomer. The *why*; [README.md](README.md) is the *what*.

## The one-paragraph version

An Analog Way LivePremier allocates physical mixing resources — **VPU mixers** — to
(screen, layer) pairs, splitting wide layers across several mixers as **slices**. The
device reports that allocation read-only over AWJ. This app reads it and draws it.

## Mental model

- **A VPU is a VPU *mixer*.** Not a GPU, not a video-processing card. It is the mixing
  and scaling resource the device assigns to one slice of one layer of one screen.
- **4 processors × 16 mixers = 64 maximum.** Most chassis are part-populated;
  `isAvailable` distinguishes fitted from absent, `isEnabled` distinguishes in-use from
  spare. Those are different questions and the UI keeps them visually distinct.
- **A layer costs a run of mixers, one per slice.** This is the whole point of the tool.
  Counting layers tells you nothing about whether a show fits; counting mixers does.
- **`current` vs `new`.** The device holds a running mapping and a staged one. Diffing
  them shows what applying a pending configuration would cost, before anyone applies it.
- **The link grid is the manual's model, and it is a different thing.** User Manual
  v6.2 §5.5 draws a VPU as an 8×8 field of *links* — 8 layer links in, 8 output links
  out. **Read those pages before touching the grid** (`Aquilon_User_Manual_v6.2.pdf`,
  §5.5.1–§5.5.7, PDF pages 66–70): the diagrams carry the model and the prose does not.
  A row is one layer-capacity link carrying **one** layer, as many rows as the layer's
  capacity (dual link 1, 4K60 2, 5K60 4); a column is one output link, and each screen
  owns a **contiguous** run of them. A layer past four output links wraps onto another
  layer link (§5.5.4) unless Optimized mode lifts that for capacity-2 layers (§5.5.6).
  Squares are not the model — that was an early guess, and it was wrong.

## Load-bearing invariants

- **Reads only. Never emit `replace`.** Not to device properties, not to
  `Subscriptions`. Every property here is `readOnly` in the device's own model, and the
  tool's value proposition on a live show floor depends on being provably harmless.
  `lib/awj.js` deliberately exposes no write method — keep it that way.
- **`$vpuMixer` is camelCase.** `$vpu-mixer` (matching the vendor's own source
  filenames) and `$mixer` both answer `E12`. Easy to get wrong, silent when wrong.
- **AWJ framing is `0x04`, not newline.** One JSON object per message. The terminator is
  written as the `EOT_STR` constant rather than a literal control character in source,
  because a raw `0x04` in a file is fragile across editors and tooling.
- **`public/vpu.js` must stay pure.** No Node APIs, no DOM. Both the browser and the
  server import it, so a live read and a recorded capture reach the screen through
  identical code. Device I/O belongs in `lib/read.js`.
- **`diff()` must compare `mixerAllocation`, not just `@props`.** A staged
  configuration can differ *only* in which output links it uses — on the captured
  Aquilon C that is exactly what it does, moving output 2 from link 3 to link 2 across
  28 mixers while every property stays identical. Comparing properties alone reported
  "staged config matches running", which was wrong and looked right. Caught by running
  the profiler against hardware, not by any test.
- **Backgrounds do not use the VPU either, and `NATIVE` is not the background.**
  Two different things, easily conflated. *Backgrounds* — background sets, stills,
  per-screen assignment — live in `preconfig/backgrounds/`, an entirely separate
  subtree from `preconfig/resources/`, and cost no mixer. `usedInLayer: 'NATIVE'` is
  something else: the first entry of the `PRECONFIG_SCREEN_LAYER` enum ("Native",
  then 1..256), a layer slot that demonstrably consumes mixers and is counted by
  `layerCount` (S1 reads 3 for NATIVE + 1 + 2). Call it the **native layer**; calling
  it a "background" in the UI was wrong and is exactly the confusion to avoid.
- **Auxiliaries do not use the VPU.** Settled with the operator: there is no aux
  resource to count, and the object model agrees (`usedInScreen` draws on a S1–S24
  enum with no `A*` entries; `preconfig/resources` has no aux module). Auxes do have
  labels, which is the only thing that makes their absence look like an oversight.
  Do not add aux handling to the resource views.
- **Screen names are show data.** `readScreenNames()` reads the operator's own
  labels (`$screen/@items/S<n>/control/@props/label` — note `$screen`, not
  `$screenAuxGroup`, whose `control` has no `label`). They make every view readable
  and belong in the live view only: keep them out of `data/`, out of
  `scripts/profile-vpu.mjs`, and out of screenshots destined for the public README.
- **Polling must fail closed.** `stopPolling()` runs on any failed read, so a device
  that goes away is not hammered every interval. It also leaves the last good reading
  rendered — losing the view on a blip is worse than stale data clearly labelled.
- **`[hidden]` needs restating in author CSS.** `styles.css` sets `display:flex` on
  `section` and `main`; author rules beat the UA stylesheet's `[hidden]{display:none}`
  regardless of specificity, so without the explicit `[hidden]{display:none!important}`
  nothing ever hides. This bit once — the staged-changes panel rendered empty at zero
  changes.

## How much placement is reported — settled on hardware, 2026-08-21

**Columns: reported.** `mixerAllocation.usedOnOutPipe1..8` names exactly which output
links a mixer drives. There are **eight** of these, not two — an earlier read fetched
only pipes 1 and 2 and so saw a quarter of the device's own placement data. Every mixer
in a (screen, layer) run shares the same set.

**The pipe KEYS are interleaved; the VALUES are the columns.** `usedOnOutPipe<k>:
'<n>'` is a pair whose halves disagree. The key is the VPU pipe the mixer is wired to,
and those interleave: on the captured Aquilon C, S1 on pipes 1 and 3, S3 on 2 and 4,
S2 on 5 and 7. The **value** is which of the *screen's* own output links that pipe
carries — 1..n, in order. A six-output screen's first mixer reads pipes 1,3,5,7
carrying links 1,2,3,4, and its second reads pipes 2,4 carrying links 5,6.

Draw the values. `reportedOutputs()` reads them; `reportedColumns()` still reads the
keys, which are only the wiring. Drawing the keys scatters a screen's layers across the
field and lets a bar reach across the centre line, which the hardware cannot do — the
grid did exactly that until 2026-08-21, and it looked plausible.

**Slice does NOT uniquely identify a mixer within a run.** A layer spread over more
than four output links is carried by a *second* mixer on a different set of links
(§5.5.4) — the same slice, different pipes. A six-output screen shows as slices
`[0,0,1,1]`: two mixers per slice. Slices do **not** add rows, though: the mixers of one
slice-run are the same layer on the same links, so they share a bar and the count is
drawn in its corner.

**Rows: not reported, but not free either.** Nothing names the layer link — two layers
of one screen share both their output links and their slice numbers, and `channel` reads
0 everywhere. The rules fix everything except the order: a row carries one layer, a
layer spends as many rows as its capacity, and a layer reaching past four output links
takes another. So only the order down the field is ours, and it follows the device's own
mixer allocation order. `buildLinkGrid()` used to *pack* rows instead — one per slice, at
the first row where the columns were free — which put three different layers on layer
link 1 of the captured VPU 1. It cannot happen; do not reintroduce it.

**A screen's native layer is not layer capacity.** It is reported like a layer and holds
mixers, but it spends output capacity only, so it is drawn in a band below the eight
links and left out of `rowsUsed`.

**`$vpuLayer` does not exist on hardware.** It answers `E12`, as does `$pipe`. Both are
present-but-permanently-empty on the *simulator*. This is the general lesson:

> ⚠️ **The simulator and real hardware expose different collections.** Hardware has
> `vpuMixerList` and no `pipeList`/`vpuLayerList`; the simulator has exactly the
> opposite. Anything verified only against the simulator must be re-verified on a
> device before it is trusted.

`deriveLinkGrid()` remains as the fallback for data with no pipe allocation, and
`buildLinkGrid()` reports which of the two it used via `placement`. The UI's wording
follows that flag — keep it honest if the rule changes.

## Where the model came from

Not from the protocol. **AWJ cannot enumerate anything** — every container read returns
`{"value":{}}`, so there is no walking the tree.

The Web RCS bundle is the map. `http://<device>/app.<hash>.js` is a ~22 MB **unminified
webpack build** that retains original TypeScript module paths and
`// __Generated__: by aw-generate-do script` headers. It contains **2040 device-object
module paths** and a typed `_ATTRIBUTES` table for each — type, min, max, default,
`readOnly`, enum — which is the entire object model, not just VPU.

To recover more of it:

1. Fetch `app.<hash>.js` from the device (the hash is in the served `index.html`).
2. Find `const <NAME>_ATTRIBUTES = {` and walk balanced braces.
3. Enum values live in a `VAR_ENUMS` module; look for `{key:'MIXER',items:{…}}`.

**Use Python, not grep.** BSD grep silently fails on the multi-megabyte lines.

Take the map from the bundle, then read leaves over AWJ. That combination defeats the
leaf-read-only limitation entirely.

## What is genuinely verified, and what is not

**Verified:**

- The path table, the enums, and every value in `data/aquilon-c-snapshot.json` were read
  from a **real Aquilon C** (`dev` = `NLC_C`, 32/64 mixers fitted, 28 enabled).
- Parsing, summarising, diffing and the derived link layout: 19 tests, run against
  that capture.
- The AWJ transport — framing, `E12` handling, path construction — against a scripted
  responder replaying the capture over a real socket.
- The live request path end to end against the **LivePremier simulator**: connects,
  reads identity, probes the VPU subtree, and reports its absence correctly.
- **A full live read from a real Aquilon C through this code** (2026-08-21): the server
  bridge, the UI, the link grid and the budget view, ~750 ms for 64 mixers over AWJ.
- Both themes, and the failure states (unreachable host, device without a VPU map).

**Not verified:**

- **Which layer link (row) anything sits on.** How many links a layer spends is fixed by
  the manual's rules; the order down the field is ours.
- **Everything in the gap list.** `node scripts/capture-config.mjs --report` prints it:
  a capacity-1 (`DUAL`) layer has never been seen, nothing has ever been over budget,
  and Cut & Fill has never been captured with the effect actually on. There is no longer
  an Aquilon here, so closing those needs somebody else's device —
  [docs/CAPTURE-GUIDE.md](docs/CAPTURE-GUIDE.md) is written for them.
- Capacities other than `4K` and `5K`. `capacityToLinks()` now reads the position in
  the device's own `LAYER_CAPABILITIES` enum (`OFF, DUAL, 4K, 3, 5K, 5, 6, 7, 8K`),
  where the bare numbers sit at their own index — so DUAL is 1, 4K is 2, 5K is 4, 8K
  is 8. It was previously hard-coded with 8K at 4 and no entry for 5K at all, which a
  chassis reporting `5K` exposed. `DUAL` and `8K` themselves are still unseen.
- **Combined VPUs** (§5.5.5, a screen over more than 8 outputs) and **Optimized mode**
  (§5.5.6, which removes the 4-link boundary and would make the view's boundary line
  wrong for that VPU). Neither has been seen; neither is handled.
- Nothing has been tested on a **Link** setup, so devices 2–4 are untried. Note they
  are not absent from the protocol — they answer every path with `isAvailable:false`,
  so "does device 2 exist" has to be asked as "does it have any mixer fitted".
- **`channel` is assumed to index the Link device.** It reads 0 on every mixer of a
  standalone chassis, and `DEVICE` is an enum of 1–4 (master + 3 followers), so that is
  the obvious reading — but it is an assumption, not a finding. `scripts/profile-vpu.mjs`
  exists partly to collect a Link profile that would settle it.
- One **transient `EHOSTUNREACH`** was seen mid-session on an otherwise healthy link
  (ICMP fine, three retries immediately after all succeeded). Cause unknown — possibly
  the AWJ 5-client cap. The app surfaces it and re-enables the button; worth watching
  rather than chasing.
- `capability` values other than `4K`, and `channel` other than `0`, have never been
  seen — the captured device reports the same values throughout.
- Whether `slice` count tracks canvas width is **inferred from one configuration**, not
  proven.
- The tool has never run on an Alta 4K or Midra 4K.

## The simulator is not a test target for VPU

`AW LivePremier Simulator.app` speaks AWJ correctly on 10606 and is genuinely useful for
transport work, but it exposes **no `$vpuMixer` collection**. The path resolves to
`$device/@items/1` and then answers `E12`. It has no processor boards to map.

Reproduce with `{"op":"get","path":"…/$device/@items/1/$vpuMixer"}` + `0x04`.

## Two real captures, deliberately different

`data/aquilon-c-snapshot.json` — four screens, one layer each, every mixer `4K`, one
eight-slice native layer. `data/aquilon-c-6output-5k.json` — the same chassis
reconfigured: **S1 is a six-output screen** with native plus two layers (two mixers per
slice), and **S2 is `5K`**. The tests run against both, because the first one alone
supports assumptions the second disproves. If a third configuration turns up, add it
rather than editing either.

## Two builds, one UI

`public/` is the whole interface and is shared. The only thing that differs is how
a reading is fetched, and it is isolated to `readVpu()` in `public/app.js`:

- **Desktop (Tauri):** `invoke('read_vpu')` — `src-tauri/src/read.rs` makes the AWJ
  connection in Rust.
- **Server (Node):** `fetch('./api/vpu')` — `lib/read.js` does it, because a browser
  cannot open a TCP socket.

**Both must return the same JSON shape.** Change a field in one and change it in the
other, or the UI silently renders half a view on one build only. There is no branch
below `readVpu()` and there should not be.

`scripts/stage-frontend.mjs` assembles `dist-frontend/` for Tauri (public/ at the root,
data/ beneath) rather than duplicating any file in the repo.

The Rust side has its own tests against a scripted AWJ responder, including
`only_ever_sends_get`, which asserts the safety claim rather than commenting it.

## Layout

```
server.js          static host + /api/vpu bridge (the only thing that opens a socket)
lib/awj.js         AWJ client — TCP, 0x04 framing, get-only
lib/read.js        path builder + the read routine
public/vpu.js      pure model: constants, summarise(), diff(), deriveLinkGrid()
                   — shared with the browser
public/app.js      UI
public/styles.css  instrument-panel palette, cyan-biased neutrals, both themes
public/support-footer.js   vendored; see below
data/*.json        recorded captures
test/              node:test, no runner
```

**`public/support-footer.js` is vendored — do not edit it here.** The master lives in
`stoatworks-backend/support-footer/support-footer.js` and is pushed out by
`stoatworks-backend/scripts/sync-support-footer.sh`. Local edits get overwritten. The
`data-*` attributes on the script tag in `index.html` are this repo's to set.

## Sibling work

The older Analog Way platforms — LiveCore and Midra classic — speak a completely
different mnemonics-over-TCP-10500 protocol and are handled by **openrcs**, which is
unrelated to this code beyond both talking to Analog Way gear.

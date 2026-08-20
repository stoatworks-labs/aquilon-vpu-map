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
  v6.0 §5.5 draws a VPU as an 8×8 field of *links* — 8 layer links in, 8 output links
  out — where a layer occupies a square sized by its capacity (1→1×1, 2→2×2, 4→4×4).
  The two views agree numerically: 16 mixers per VPU is exactly a 4×4 packing of
  capacity-2 blocks over 64 links, and the captured Aquilon C reports precisely that.

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
- **`[hidden]` needs restating in author CSS.** `styles.css` sets `display:flex` on
  `section` and `main`; author rules beat the UA stylesheet's `[hidden]{display:none}`
  regardless of specificity, so without the explicit `[hidden]{display:none!important}`
  nothing ever hides. This bit once — the staged-changes panel rendered empty at zero
  changes.

## Placement is derived, and that is the open question

`deriveLinkGrid()` places blocks by an explicit rule because **the device reports what
each mixer serves, not where it sits**: screen, layer, slice and capability, but no row
or column. Sizes, counts and grouping in the Link grid view are real; row and column
are not, and the UI says so.

**`$vpuLayer` is almost certainly the reported grid:**

```
…/mapping/$device/@items/1/$vpuLayer/@items/PROC_<1-4>_SCALER_<1-8>
    /@props/{isAvailable,isEnabled,capability,usedInScreen,usedInLayer}
    /scalerAllocation/@props/usedOnOutPipe<1-8>
```

8 scalers per VPU (the rows — `PROC_1_SCALER_9` answers `E12`), each declaring which
of 8 output pipes it drives (the columns). Alongside it sits `$pipe/@items/1..64` with
`isUsed`. **The simulator has this collection but leaves it entirely unpopulated**
(`isAvailable:false`, `capability:'OFF'`, every pipe `'NONE'`), and it has never been
seen on hardware — the capture predates finding it.

`scripts/probe-hardware.mjs` exists to settle this; `docs/HARDWARE-PROBE.md` says what
each outcome means. **If it comes back populated, replace the derived layout with the
reported one** and keep `deriveLinkGrid()` as the fallback.

Do not quietly upgrade the wording in the UI before that evidence exists.

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
- Both themes, and the failure states (unreachable host, device without a VPU map).

**Not verified:**

- **Where any layer actually sits in the link grid.** See above. The Link grid view is
  a derived layout and must keep saying so until `$vpuLayer` proves otherwise.
- Mixed capabilities. Every mixer on the captured box was `4K` (capacity 2), so the
  1×1 and 4×4 block paths in `deriveLinkGrid()` have only ever run in tests.
- **Combined VPUs** (§5.5.5, a screen over more than 8 outputs) and **Optimized mode**
  (§5.5.6, which removes the 4-link boundary and would make the view's boundary line
  wrong for that VPU). Neither has been seen; neither is handled.
- **This code has never completed a VPU read from real hardware.** The capture was taken
  with a separate Python probe, before this client existed. The paths are identical, but
  a first run against a real Aquilon is still a first run.
- Nothing has been tested on a **Link** setup, so devices 2–4 are untried.
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

# Changelog

## 1.2.0 — 2026-08-21

**The desktop app could not see the network once it was double-clicked.** Since
macOS 15 an app must declare why it uses the local network, and on 26 the
enforcement is thorough: without `NSLocalNetworkUsageDescription` a GUI-launched
app is denied LAN traffic silently, so `read_vpu`'s TCP connect to the processor
failed and the map stayed empty. The key was already in `Info.ios.plist`, which
does not feed the macOS bundle; there is now a macOS `Info.plist` beside it. It
was invisible in development because a process started from a terminal inherits
the terminal's own permission.


**The link grid is the manual's grid again.** It was drawing rows by packing — a run
took one row per slice, placed at the first row where its output links were free, so
runs on disjoint links shared rows. That put S1, S2 and S3 all on layer link 1 of the
captured VPU 1: three layers on one link, which the hardware cannot do. Checked against
the figures in Aquilon User Manual v6.2 §5.5, two things were wrong — the rows, and the
columns underneath them.

- **A row is one layer-capacity link and carries one layer.** Every layer now gets rows
  of its own, as many as its capacity (dual link 1, 4K60 2, 5K60 4), in the device's own
  mixer order. Slices no longer add rows: the mixers of one slice-run are the same layer
  on the same links, so they share a bar and the count sits in its corner.
- **Columns belong to screens.** `usedOnOutPipe<k>: '<n>'` is a pair whose halves
  disagree: the key is the interleaved VPU pipe, the value is which of the *screen's*
  output links it carries. The value is the column. Each screen now owns a contiguous
  run of links, as wide as its output count, and its layers all start at the same one —
  §5.5.4's two four-output screens filling a VPU as links 1–4 and 5–8. A bar is
  continuous, and the screen bar over the field says which links are whose.
- **A layer past four output links wraps** onto another layer link with the manual's
  hook (§5.5.4), because a link cannot cross the centre line. **Optimized mode lifts
  that for capacity-2 layers and only those** (§5.5.6), so the grid takes the optimized
  set as an argument and draws their bars unbroken; the boundary is now drawn on every
  VPU, quieter on an optimized one.
- **Native backgrounds are out of the eight.** A screen's native is reported like a
  layer and holds mixers, but it spends output capacity, not layer capacity. It is drawn
  dimmed in a band below the field and left out of `rowsUsed`.

The six-output capture now reads as §5.5.4's own figure: S1's two layers each cover
links 1–4 and wrap onto 5–6, S2 sits on 7–8, and VPU 1 is exactly 8/8 layer links and
8/8 output links.

**Working without a device.** Hardware access ended, so the recorded captures are
now the only ground truth and the tool treats them that way.

- The app offers **every** capture, not just the first — a picker fed by
  `data/captures.json`. The other two were previously reachable only from tests.
- New `scripts/capture-config.mjs`. `--report` needs no device and audits the
  captures: what each proves, and which questions none of them answer, each with
  the configuration that would close it. Given an address it records a new
  capture, redacted, and lists it in the picker. Reads only.
- New [docs/CAPTURE-GUIDE.md](docs/CAPTURE-GUIDE.md), written for whoever next has
  an Aquilon and knows nothing about this tool.
- The capture path is tested end to end against the scripted stand-in device, so
  it stays honest with no hardware to try it on: the redaction, the picker entry,
  and the report running every gap check over every capture.

`buildLinkGrid(mixers, optimizedVpus)` blocks now carry `mixers`, `slices`, `height`,
`outputs`, `section`, `background` and `wrapped`, and each grid carries `screens`,
`columnsUsed` and `backgroundRows`; `mixer`, `slice` and `size` are kept as first-of
aliases. New `reportedOutputs()` reads the values; `reportedColumns()` still reads the
keys, which are now only the wiring. The vendored copy in webrcs-unleashed needs
`npm run sync:vpu-model` there, and its renderer wants the same treatment.

## 1.1.0 — 2026-08-21

**A desktop app.** Double-click, no Node, no Docker, no checkout — which is what
a tech on a show actually needs.

It is the same UI. The only difference is how it reaches the switcher: on the
desktop, Rust makes the AWJ connection and returns the identical shape the Node
bridge's `/api/vpu` returns, so `public/app.js` renders either without a branch
anywhere in the rendering.

- macOS (Apple silicon and Intel), Windows and Linux, built in CI.
- ~2 MB on macOS: Tauri uses the system WebView rather than bundling a browser.
- Reads only, and now tested as such — `only_ever_sends_get` asserts that every
  frame this app can put on the wire carries `op: "get"`.
- Verified against a real Aquilon C: reads identity, screen names and the full
  mixer table, matching the server build exactly.

### Not signed yet

The macOS build is **unsigned**. Gatekeeper refuses an unsigned app downloaded
from the internet with a message that reads like the file is damaged rather than
a permission prompt. Right-click → Open, once, to get past it. Signing goes
through the fleet's Apple path when that is wired up here.

### Also

- The Node server, the container and the Unraid template are unchanged and still
  work. The desktop app does not replace them; it is the third way in.

## 1.0.0 — 2026-08-21

First release. Reads an Analog Way LivePremier's VPU mixer allocation and draws it,
so you can see what a configuration is actually spending without walking the Web RCS
a panel at a time.

Everything here was built against a real Aquilon C, read in three different
configurations. Each one broke an assumption the previous had made look settled, which
is why the captures are kept rather than tidied.

### What it does

- **Reads a live device** over AWJ in about a second — 64 mixers, both the running and
  the staged mapping.
- **Chassis view**: every mixer, what it serves, what is spare, what is not fitted.
- **Link grid**: each VPU as the manual draws it (User Manual v6.0 §5.5) — eight layer
  links in, eight output links out. Columns are the device's own; rows are packed.
- **What each screen costs**, and whether it fits: output links spent, layers over
  outputs, links spare, and a warning when a screen is over budget. Reported by the
  device, not inferred.
- **Optimized mode** is detected, and the scaling-engine boundary is not drawn on a VPU
  where it does not apply.
- **Staged changes**: what applying the device's pending configuration would do —
  including link re-allocations that change no property at all.
- **Screens are named** the way you named them.
- **Keep watching** re-reads on an interval, stops itself on failure, and leaves the
  last good reading on screen.
- **Save a reading** and **compare** a live device against it.

### Reads only

It issues AWJ `get` and nothing else — not even the `Subscriptions` write a push-based
client would need. Every property it reads is `readOnly` in the device's own model.
`lib/awj.js` has no code path that emits a write.

### Also included

- `scripts/profile-vpu.mjs` — a single self-contained file another operator can run
  against their own LivePremier to contribute a configuration. Records structure only:
  no addresses, serials, device names or screen names.
- `scripts/probe-hardware.mjs` — the procedure for exploring a device you have.
- Three recorded captures, so the app is useful with no device present.

### Known limitations

Row positions in the link grid are packed rather than reported; `channel` is assumed to
index the Link device; Link setups, `DUAL`/`8K` capacities, combined VPUs and Cut & Fill
have never been observed. See [docs/ROADMAP.md](docs/ROADMAP.md).

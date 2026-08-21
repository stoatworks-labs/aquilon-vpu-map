# Where this is, and what would move it on

Written 2026-08-21, after reading a real Aquilon C in three different
configurations over two days.

## What it does now

Enough to use.

- **Reads a live device** over AWJ in about a second, and shows the whole chassis
  at once instead of a panel at a time.
- **Names screens the way you named them** — "S1 · Main LED", not "S1".
- **Keep watching** re-reads on an interval. It stops itself if a read fails,
  and keeps the last good reading on screen rather than blanking.
- **Save this reading** writes the whole thing to a file; **Compare with a saved
  reading** diffs the live device against it and lists what moved. That is the
  before-the-show / during-the-show workflow.
- **Staged changes** shows what applying the device's pending configuration
  would do, including link re-allocations that change no property at all.
- **Answers "will it fit"** from the device's own figures, not by inference:
  output links spent, layers over outputs, links spare, and a warning if a
  screen is over budget.
- **Knows when the scaling-engine boundary does not apply**, so the grid stops
  drawing a constraint the device is not enforcing.
- Works with no device in front of you, from three recorded captures.

## What it cannot do, and why

| Limitation | Why | What would fix it |
| --- | --- | --- |
| Row positions in the link grid are packed, not reported | The device names the output links a mixer drives, but nothing names the layer link | A firmware that populates `$vpuLayer`, or any property that indexes the row |
| `channel` is assumed to index the Link device | Reads 0 on every mixer of a standalone chassis | One profile from a Link setup |
| No Link support in anger | Devices 2–4 answer every path with `isAvailable:false` on a standalone box; never seen populated | The same Link profile |
| `DUAL` and `8K` capacities untested | Only `4K` and `5K` have ever been seen | A chassis using them |
| Combined VPUs (§5.5.5) not handled | A screen over more than 8 outputs spills into another VPU; never observed | A configuration with a 9+ output screen |
| ~~Optimized mode not detected~~ | **Done.** `isOptimized` is reported per screen; the boundary is now suppressed on any VPU hosting one | — |
| Cut & Fill effect on allocation unknown | `cutnfillCapa` is a *capability* and has read `OFF`/`4K`; what happens when the effect is actually enabled is unseen | A layer with Cut & Fill on |
| ~~No aux screens~~ | **Settled: auxiliaries do not use the VPU, so there is nothing to count.** Confirmed by the operator, and matching the object model — the `SCREEN` enum behind `usedInScreen` is S1–S24 with no `A*` entries, and `preconfig/resources` has no aux module | — |

## Done since this was written

**Aux screens — settled, not a gap.** Auxiliaries **do not use the VPU**, so
there is no resource of theirs to show. Confirmed by the operator, and the
object model agrees: the enum behind `usedInScreen` is S1–S24 with no aux
entries, and `preconfig/resources` has no aux module. They do have labels
(`$auxiliary/@items/A1/control/@props/label`), which is the only reason this
ever looked like an omission. Treat it as closed rather than unexplored.

**Optimized mode — done, and it was making the view wrong.** `isOptimized` is
reported per screen under `resources/{current|new}/$screen/@items/S<n>/status`.
It is a property of the whole VPU (§5.5.6), so `optimizedVpus()` maps screen →
mixers → processor, and the scaling-engine boundary is no longer drawn there.
On the captured chassis S1 spends 6 output capabilities and reports true, so
VPU 1 correctly loses its boundary line.

The same status node gave more than was being looked for: `outputCount`,
`usedOutputCapabilities`, `layerCount`, and — on the `new` side —
`remainingOutputCapabilities`, `exceedingOutputCapabilities` and
`exceedingLayerCapabilities`. That is **"will it fit" answered by the device**
rather than inferred, and it now drives the per-screen strip and an over-budget
warning.

## What is left

**1. A Link capture.** Unlocks `channel`, devices 2–4, and combined VPUs in one
go — the biggest single step, and the only one needing hardware we do not have.

**2. Everything else** as configurations turn up. `scripts/profile-vpu.mjs`
exists so other operators can contribute those without needing this repo or any
knowledge of it.

## How to extend it safely

Every configuration seen so far has broken an assumption the previous one made
look settled — three for three:

- one capture said a slice identifies one mixer — the second disproved it
- one said every mixer is `4K` — the second reported `5K`, which `capacityToLinks`
  had no entry for at all
- one said the staged mapping matched the running one — it differed only in
  links, which `diff()` was not comparing
- two said the 4-link boundary always applies — the third reported
  `isOptimized`, under which it does not

So: **add a capture to `data/` rather than editing an existing one**, and make
the tests assert against all of them. Two disagreeing captures are worth far
more than one tidy one. There are three now; keep them all.

**Never commit screen names.** They are the operator's own labels and this repo
is public. A capture refreshed from a live read would carry them in silently, so
there is a test that fails if any capture grows a `screens` field.

`docs/HARDWARE-PROBE.md` is the procedure for a device you have; the profiler is
for devices you do not.

## Getting it to a tech on a show

Shipped in 1.0.0: `npm start`, and a container
(`ghcr.io/stoatworks-labs/aquilon-vpu-map`) with an Unraid Community Applications
template. **Neither is the answer for someone on site** — a tech cannot be assumed
to have Docker, or Node, or a checkout.

The options, and what the evidence says about each:

### A desktop launcher — the one to build

Bundle the server and open a browser at it. Double-click, nothing installed.
This keeps the architecture exactly as it is, which matters: AWJ gives a
complete read in ~700 ms of small targeted requests.

Either a single Node executable (`node --experimental-sea-config`, no extra
toolchain) or Tauri, which the fleet already uses elsewhere and which gives a
real app bundle. Unsigned macOS binaries are refused by Gatekeeper, so this needs
the fleet's existing signing path rather than a bare `.tar.gz`.

### A Chrome extension — possible, but worse, and now measured

Attractive because an extension on the Web RCS page runs on the device's **own
origin**, so CORS and mixed content simply do not apply. But:

- **An extension still cannot open a TCP socket**, so it cannot speak AWJ at all.
- Its only same-origin route to the VPU map is `GET /api/stores/device` — the
  whole device object, **~124 MB**. Probed 2026-08-21: `?path=`, `?filter=` and
  every `/api/stores/device/<subpath>` variant are ignored or 404. There is no
  narrower endpoint.
- That is also the one transfer the fleet flags as risky to interrupt.

So an extension could manage a one-shot view at 124 MB a refresh, and could not
sensibly do *Keep watching* at all. Worth revisiting only if a future firmware
adds a scoped read.

### Direct Sockets / `TCPSocket` — checked, not a way out

Chromium does implement it, but only inside an **Isolated Web App**: a signed web
bundle, an `isolated-app://` origin, and Chrome started with
`--enable-features=IsolatedWebApps,IsolatedWebAppDevMode` or enterprise policy —
plus a WebRTC data channel to reach it from an ordinary page. That is a heavier
install than the launcher, for the same result.

### Still open

- A website entry on `/software`.
- A hosted demo, which can only ever show the recorded captures: a page served
  over HTTPS cannot reach a device on a private address, and the device has 443
  closed.

# Changelog

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

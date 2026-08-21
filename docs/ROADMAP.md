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
- Works with no device in front of you, from the recorded captures.

## What it cannot do, and why

| Limitation | Why | What would fix it |
| --- | --- | --- |
| Row positions in the link grid are packed, not reported | The device names the output links a mixer drives, but nothing names the layer link | A firmware that populates `$vpuLayer`, or any property that indexes the row |
| `channel` is assumed to index the Link device | Reads 0 on every mixer of a standalone chassis | One profile from a Link setup |
| No Link support in anger | Devices 2–4 answer every path with `isAvailable:false` on a standalone box; never seen populated | The same Link profile |
| `DUAL` and `8K` capacities untested | Only `4K` and `5K` have ever been seen | A chassis using them |
| Combined VPUs (§5.5.5) not handled | A screen over more than 8 outputs spills into another VPU; never observed | A configuration with a 9+ output screen |
| Optimized mode (§5.5.6) not detected | It removes the 4-link scaling-engine boundary, so the boundary line would be **wrong** for that VPU | Finding a property that reports it, then hiding the line |
| Cut & Fill effect on allocation unknown | `cutnfillCapa` is a *capability* and has read `OFF`/`4K`; what happens when the effect is actually enabled is unseen | A layer with Cut & Fill on |
| No aux screens | Auxiliaries have labels (`$auxiliary/@items/A1/control/@props/label` reads "DSM") but their VPU cost has not been looked at | An afternoon, no new hardware needed |

## The order I would do them in

**1. Aux screens.** No new capture needed — the paths are there, it is only
work. Auxiliaries consume resource too, and the tool currently pretends they do
not exist.

**2. Optimized mode.** The one limitation that makes the view actively *wrong*
rather than merely incomplete. Worth finding the property even before a
configuration that uses it, so the boundary line can be suppressed.

**3. A Link capture.** Unlocks `channel`, devices 2–4, and combined VPUs in one
go — the biggest single step, and the only one that needs hardware we do not
have.

**4. Everything else** as configurations turn up. `scripts/profile-vpu.mjs`
exists so other operators can contribute those without needing this repo or any
knowledge of it.

## How to extend it safely

Every configuration seen so far has broken an assumption the previous one made
look settled:

- one capture said a slice identifies one mixer — the second disproved it
- one said every mixer is `4K` — the second reported `5K`, which `capacityToLinks`
  had no entry for at all
- one said the staged mapping matched the running one — it differed only in
  links, which `diff()` was not comparing

So: **add a capture to `data/` rather than editing an existing one**, and make
the tests assert against all of them. Two disagreeing captures are worth far
more than one tidy one. If a third arrives, keep all three.

`docs/HARDWARE-PROBE.md` is the procedure for a device you have; the profiler is
for devices you do not.

## Deployment, still open

It runs with `npm start`, and there is a Dockerfile that CI builds and smoke-tests
on every push. Not yet done, and all needing a decision rather than work:

- an Unraid CA template and a `fleet.json` entry (port 8531 is unclaimed)
- a website entry on `/software`
- a hosted demo — which can only ever show the recorded captures, since a page
  served over HTTPS cannot reach a device on a private address

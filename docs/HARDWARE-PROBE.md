# Hardware probe procedure

**The question:** does an Aquilon report *where* each layer sits in the 8×8 link
grid, or only *what* each mixer serves?

## Answered — Aquilon C, firmware 6.2, 2026-08-21

**Columns yes, rows no.**

- `mixerAllocation.usedOnOutPipe1..8` names exactly which output links each mixer
  drives. There are **eight**, not two. Runs are **interleaved**: S1 on links 1 and 3,
  S3 on 2 and 4, S2 on 5 and 7.
- Nothing names the layer link. Two layers of one screen share their links *and* their
  slice numbers, and `channel` is 0 on every mixer.
- **`$vpuLayer` and `$pipe` answer `E12` on hardware.** They exist but are permanently
  empty on the simulator — the two implementations expose different collections
  (hardware: `vpuMixerList` only; simulator: `pipeList` + `vpuLayerList` only).
- CORS: no `Access-Control-Allow-Origin`, port 443 closed. The hosting question is
  closed — a browser-only tool cannot reach a device.
- New prop found in passing: **`cutnfillCapa`** (`OFF` throughout on this chassis).

The rest of this document is the procedure, still worth re-running on new firmware, a
**Link** setup, or a busier chassis.

The Link grid view uses the reported columns and packs the rows. Re-running this
tells you whether a different device, firmware or configuration reports more.

Everything below is **read-only**: HTTP `GET` and AWJ `get`. Nothing writes.

---

## Before you start

- The device must be reachable on the LAN. Note its address.
- AWJ is TCP **10606**; the Web RCS is HTTP **80**. Both are needed.
- If AWJ has been disabled in the Web RCS security settings, step 3–5 will fail to
  connect — check there before blaming the script.
- ~2 minutes to run. It is idle-safe, but if the box is in a show, run it between
  sessions rather than during one.

## Run it

```bash
node scripts/probe-hardware.mjs 192.168.2.140 --out probe-$(date +%Y%m%d)
```

Then attach the output directory to the session. Everything else here is analysis
that can be done offline from those files.

---

## What it does, and what each step decides

### Step 1 — `GET /api/stores/device`

The entire device object in one response. This is the highest-value artefact: it
contains the whole `preconfig/resources` subtree, so nothing has to be guessed path
by path. Saved as `resources-subtree.json`.

Expect a large download — **124 MB on the simulator**, of which resources is ~5 MB.
The script keeps only the resources part.

`mapping-shape.json` then lists which collections exist under
`mapping/deviceList/items/<device>`. **This is the money shot**, and the two
implementations disagree completely:

```
hardware   device 1: vpuMixerList
simulator  device 1: pipeList, vpuLayerList
```

Anything new appearing here is worth reading in full — it is the cheapest discovery
available. It is also how the eight-pipe `mixerAllocation` was found, after the AWJ
reader had been fetching only two of them.

### Step 2 — CORS and HTTPS

Settles whether a browser-hosted version is possible at all. Measured on the
simulator as no `Access-Control-Allow-Origin` and port 443 closed. Confirming that
on hardware closes the question permanently; if either differs, the tool could drop
its server. See `reference_webrcs_websocket_transport` for the full reasoning.

### Step 3 — AWJ path-existence sweep

`E12` is a free existence oracle. The sweep tries speculative placement properties
on the mixer (`row`, `column`, `linkIndex`, `inputLink`, `outputLink`, …) plus the
per-output and per-screen layer status paths. Anything that answers instead of
`E12` is a path we did not know about.

### Step 4 — mixer table

Re-reads all 64 mixers. The line to read is:

```
distinct channel values : [...]
```

On the captured Aquilon C **every** mixer reported `channel: 0`, which makes
`channel` useless for placement. If a busier box shows `0..3`, `channel` is probably
the scaling-engine or quadrant index and would become a real placement input — that
is the single most valuable thing a different chassis could reveal.

### Step 5 — `$vpuLayer`, a dead end worth re-checking

```
DeviceObject/preconfig/resources/current/status/mapping/$device/@items/1
  /$vpuLayer/@items/PROC_<1-4>_SCALER_<1-8>
    /@props/{isAvailable,isEnabled,capability,usedInScreen,usedInLayer}
    /scalerAllocation/@props/usedOnOutPipe<1-8>
```

This *looked* like the grid: eight scalers per VPU (the layer links, the rows), each
declaring which of eight output pipes it drives (the columns), with
`PROC_1_SCALER_9` answering `E12` to confirm 8 per VPU.

It is not. **On hardware the whole collection answers `E12`** — it does not exist. On
the simulator it exists and is permanently empty. The step is kept so that a firmware
which starts populating it announces itself.

**If it ever does populate**, it supersedes the packed rows: map scaler → row,
`usedOnOutPipe<n>` → columns, and drop the row-packing in `buildLinkGrid()` to a
fallback. That would also settle §5.5.4 directly — whether a wrapped layer really
does occupy two scalers — instead of by inference.

---

## Worth grabbing while there

Cheap, and expensive to come back for:

- **A busier configuration.** The capture we have is uniform — every mixer `4K`,
  every `channel` 0, one layer per screen beyond native. A box with mixed
  capabilities (`DUAL`, `8K`), several numbered layers, or a screen using more than
  8 outputs (**combined VPUs**, §5.5.5) would exercise paths nothing has tested.
- **A staged change.** Make a preconfig edit in the Web RCS but **do not apply it**,
  then re-run. That populates the `new` mapping differently from `current` and is
  the only way to see the diff view do real work.
- **Cut & Fill on a layer** (§5.5.7) — it doubles a layer's resources, so it should
  show as extra mixers. Nothing has confirmed how it appears.
- **Optimized mode** (§5.5.6) — enabled when a screen uses ≥5 output links and ≥1
  layer of capacity 2. It removes the 4-link boundary, so the grid view's boundary
  line would be wrong for that VPU. Worth knowing whether any property reports it.
- The **REST API** guide (`livepremier_rest_api_programmers_guide_v4.1.pdf`) shipped
  in the AW training bundle describes an interface this tool has never tried. If it
  exposes the resources tree and sends CORS headers, it changes the hosting answer.

## Reminder

Reads only. If any step ever needs a write to prove something, stop and ask first —
this tool's whole claim is that it cannot disturb a show.

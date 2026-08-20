# Hardware probe procedure

**The question:** does an Aquilon report *where* each layer sits in the 8×8 link
grid, or only *what* each mixer serves?

Right now the Link grid view places blocks by a derived rule. If the device reports
real placement, that view becomes reported fact instead — a meaningful upgrade, and
the only thing standing between this tool and being trustworthy for planning.

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
`mapping/deviceList/items/<device>`. **This is the money shot.** On the simulator
there are exactly two:

```
device 1: pipeList, vpuLayerList
```

On hardware there should be **three** — `vpuMixerList` as well. If a collection
appears that we have not seen, it is worth reading in full.

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
the scaling-engine or quadrant index and becomes a real placement input.

### Step 5 — the one that matters: `$vpuLayer`

```
DeviceObject/preconfig/resources/current/status/mapping/$device/@items/1
  /$vpuLayer/@items/PROC_<1-4>_SCALER_<1-8>
    /@props/{isAvailable,isEnabled,capability,usedInScreen,usedInLayer}
    /scalerAllocation/@props/usedOnOutPipe<1-8>
```

**This is the grid.** Eight scalers per VPU — the eight *layer links*, the rows —
each declaring which of eight *output pipes* it drives, the columns. 32 scalers per
device; `PROC_1_SCALER_9` answers `E12`, confirming 8 per VPU.

Confirmed present on the simulator, but **entirely unpopulated** there:
`isAvailable:false`, `capability:'OFF'`, every pipe `'NONE'`.

The script prints one of two verdicts.

---

## Reading the verdict

### `*** POPULATED — the device reports real link placement. ***`

Best case. Each row printed is a layer link and the pipes it drives:

```
PROC_1_SCALER_1    S1   NATIVE  cap 4K   1->1 2->1 3->1 4->1
```

That is screen S1's native layer on layer-link 1, spanning output pipes 1–4.

**Then:** the derived layout is replaced by reported data. `deriveLinkGrid()` in
`public/vpu.js` keeps its place as a fallback for devices that report nothing, and a
new reader maps scaler → row, `usedOnOutPipe<n>` → columns. The "Derived layout"
warning in the UI is replaced with the source. Also worth capturing at that point:
whether a wrapped layer really does occupy two scalers, which would confirm §5.5.4
directly rather than by inference.

### `*** EMPTY — every scaler reports NONE on all 8 pipes. ***`

Same as the simulator. Then either the collection only populates under conditions we
have not hit, or it is genuinely unused and placement is not reported.

**Then, before concluding:** check `resources-subtree.json` by hand for the
`new` side as well as `current`, and check `pipeList` — if pipes show `isUsed:true`
while scalers show `NONE`, something else is driving them and is worth finding.
Also check whether `vpuMixerList` exists there with fields the AWJ read does not
expose.

If it is genuinely empty, the derived layout stays, and the honest wording in the UI
stays with it.

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

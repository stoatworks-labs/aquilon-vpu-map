# Notes

Working notes for this repo: status, decisions, and the traps that have actually bitten.
Migrated out of Claude Code's memory on 2026-08-24, so they are written in the first
person and dated by when each thing was learned — that date is usually the useful part.

Cross-cutting notes that are not specific to this repo live in
[fleet-notes](https://github.com/stoatworks-labs/fleet-notes).

*aquilon-vpu-map — PUBLIC web tool reading a LivePremier's VPU mixer allocation over AWJ; built and pushed 2026-08-20, but has NEVER completed a real-hardware read*

Placeholder raised 2026-08-20. **Scope now CONFIRMED against real hardware** the
same day — the earlier "what does VPU mean" question is answered, don't re-ask it.

**VPU = VPU *mixer*** — the Aquilon's physical mixing/scaling resource. The device
allocates mixers to (screen, layer) pairs, splitting each layer across several
mixers as **slices**. This is the resource budget that makes a config fit or not
fit, so the visualizer is a **resource-allocation map**, exactly as first guessed.

## Object model (from the Web RCS bundle, `aw-generate-do`-generated)

AWJ path, `current` and `new` both exist (see below):
```
DeviceObject/preconfig/resources/{current|new}/status/mapping
  /$device/@items/{1..4}          # 1=Master, 2-4=Followers (Link)
  /$vpuMixer/@items/PROC_<1-4>_MIXER_<1-16>
    /@props/{isAvailable,isEnabled,usedInScreen,usedInLayer,channel,slice,capability,seamlessCapa}
    /mixerAllocation/@props/{usedOnOutPipe1,usedOnOutPipe2}      # enum PIPE_SELECT NONE..64
    /$scaler/@items/{A|B}/@props/{memoryFill,memoryCut}          # enum SCALER_MEMORY SM1..SM8
```
**Every one of these props is `readOnly`** — it is reported allocation, not a knob.
The collection segment is **`$vpuMixer`** (camelCase); `$vpu-mixer` and `$mixer`
both return E12. Enums: **MIXER** = 4 procs x 16 = **64 max**; **SCALER** = A,B;
**LAYER_CAPABILITIES** = `OFF,DUAL,4K,3,5K,5,6,7,8K`; **DEVICE** = 1..4;
`usedInLayer` is enum PRECONFIG_SCREEN_LAYER = `NATIVE` then 1..256;
`usedInScreen` = S1..S24; `channel` int 0-3; `slice` int 0-8.

`current` = running config, `new` = the staged/pending one. **Diffing the two is
the visualizer's whole point** (the vendor UI's Preconfig "apply" model). On the
box read they were identical — nothing staged.

## THE BIG FIND — the Web RCS bundle is unminified with TS paths

`http://<ip>/app.<hash>.js` (22 MB) is an **unminified webpack build** that keeps
original TypeScript module paths and `// __Generated__: by aw-generate-do script`
headers. **2040 device-object module paths** are recoverable from it, i.e. the
*entire* object model — every collection, every `_attributes` table with type,
min, max, default, readOnly and enum for each prop.

**This defeats the AWJ leaf-read-only limit** recorded in [awj protocol](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_awj_protocol.md):
AWJ still cannot enumerate (containers return `{}`) and that stays true, but you
no longer need it to — take the model from the bundle, then read leaves over AWJ.
Extraction recipe: fetch app.js, find `const <NAME>_ATTRIBUTES = {`, walk balanced
braces. **BSD grep chokes on the multi-MB lines — use Python**, not grep.

## Live device read, 2026-08-20 — Aquilon C at 192.168.2.142

`dev` = **`NLC_C`**, `label` = `AQUILON`. Ports open: **80** (Web RCS), **10606**
(AWJ), **10500**, 10691, 10791. Snapshot HTTP endpoint works unauthenticated and
returns real live content (`/api/device/snapshots/inputs/1` -> 256x144 PNG, ~148 KB
vs the simulator's ~1.6 KB).

**32 of 64 mixers present** (PROC_1 + PROC_2 fitted, PROC_3/4 absent), **28 enabled**.
Every present mixer: `capability`=4K, `seamlessCapa`=true, `channel`=0.
```
S1 NATIVE  slices 0-3   PROC_1_MIXER_1-4     pipe1=1
S2 NATIVE  slices 0-3   PROC_1_MIXER_5-8     no pipe
S3 NATIVE  slices 0-7   PROC_1_MIXER_9-16    pipe2=1     <- 8 slices, widest
S3 layer 1 slices 0-3   PROC_2_MIXER_1-4     pipe1=1
S4 NATIVE  slices 0-3   PROC_2_MIXER_5-8     no pipe
S4 layer 1 slices 0-3   PROC_2_MIXER_9-12    no pipe
spare (isEnabled=false) PROC_2_MIXER_13-16   default to S1/NATIVE/slice 0
```
So: slice count scales with canvas width, a layer costs a *set* of mixers, and
spare capacity is visible as available-but-not-enabled. Raw dumps live in the
session scratchpad (`vpu_current.json`, `vpu_new.json`, `vpu_extra.json`,
`awj.py` probe helper).

**Read-only discipline held** — only `get` was issued, never `replace`, not even
to `Subscriptions`. Keep it that way on this box: same standing rule as
[openrcs](https://github.com/stoatworks-labs/openrcs/blob/main/docs/NOTES.md) (`openrcs`). User's words: "be delicate, nothing that could damage the system."

Sibling placeholder on the same platform: [webrcs timeline](https://github.com/stoatworks-labs/webrcs-timeline/blob/main/docs/NOTES.md) (`webrcs-timeline`). Wire format,
subscriptions trap and firmware path drift: [awj protocol](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_awj_protocol.md). Not related
to [openrcs](https://github.com/stoatworks-labs/openrcs/blob/main/docs/NOTES.md) (`openrcs`) (older LiveCore/Midra-classic mnemonics).

## SHIPPED 2026-08-20 — `stoatworks-labs/aquilon-vpu-map`, PUBLIC

`~/projects/video/aquilon-vpu-map`. Zero-dependency Node server + vanilla ES-module
UI, no build step (the openrcs shape). Runs on **:8531**.

**Why it needs a server at all — this is the load-bearing constraint.** AWJ is raw
TCP 10606; a browser tab cannot open a TCP socket, and an HTTPS-hosted page could not
reach a LAN device anyway (mixed content). So this can NOT be a static hosted page
like the other 8 browser tools — they are all offline calculators. The app's own
server makes the read. A hosted build can only ever show the recorded capture.

- `lib/awj.js` AWJ client, **get-only by construction** — no `replace` code path
  exists, not even for `Subscriptions`. Keep it that way.
- `lib/read.js` path builder + read routine; `public/vpu.js` **pure** model shared by
  browser AND server so live and recorded data render through identical code.
- `data/aquilon-c-snapshot.json` the real Aquilon C capture (host redacted), which the
  tests assert against. 9 tests pass, incl. a scripted AWJ responder over a real socket.
- IP field defaults to **192.168.2.140** (user's choice), overridable by `AQUILON_IP`,
  last-used address kept in localStorage.
- Support footer wired WITH `data-repo` set — unlike the 5 tools in
  [support footer](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_support_footer.md) that omit it.

**NOT verified: this code has never completed a VPU read from real hardware.** The
capture was taken with a separate Python probe before the client existed. Its live path
has only run against the simulator (which E12s) and a scripted responder. Link devices
2-4, capabilities other than 4K, and channel != 0 have never been seen.

**CSS trap worth remembering fleet-wide:** author `display:flex` on `section`/`main`
**beats the UA stylesheet's `[hidden]{display:none}`** — origin wins over specificity —
so `el.hidden = true` silently does nothing. Restate `[hidden]{display:none!important}`
in author CSS. This shipped a visible-but-empty panel until caught by looking at it.

**Still to wire (NOT done, needs the user's call):** website `projects.json` entry,
Unraid CA template + `fleet.json`/`unraid.json` hostPort, GHCR publishing, and the
`sync-support-footer.sh` TARGETS table (which must list every hosted app by hand).

## Link-grid view + the $vpuLayer discovery (2026-08-20)

**The manual's model (User Manual v6.0 §5.5, pp.65-68) is an 8x8 field of LINKS** —
8 layer links in on the left, 8 output links out top and bottom. A layer occupies a
square sized by capacity: **1→1x1, 2→2x2, 4→4x4**, so a VPU holds 64/16/4 layers.
**Scaling-engine boundary = 4 output links**; a layer wider than that takes a second
layer link and wraps (the manual's ↳ hook). >8 outputs spills into another VPU
(§5.5.5). **Optimized mode** (§5.5.6) REMOVES the 4-link boundary — the view's
boundary line would be wrong for such a VPU; unhandled. **Cut & Fill doubles** a
layer's resources (§5.5.7), unhandled.

**The two models corroborate:** 16 mixers/VPU is exactly a 4x4 packing of capacity-2
blocks over 64 links, and the captured Aquilon C (all `4K` = capacity 2) fills PROC 1's
8 layer links precisely. Good cross-check that the mixer table was read correctly.

**⚠️ `$vpuLayer` IS THE REPORTED GRID — found late, never seen populated.**
```
…/mapping/$device/@items/1/$vpuLayer/@items/PROC_<1-4>_SCALER_<1-8>
    /@props/{isAvailable,isEnabled,capability,usedInScreen,usedInLayer}
    /scalerAllocation/@props/usedOnOutPipe<1-8>      <- EIGHT pipes, not two
  …/$pipe/@items/1..64/@props/isUsed
```
**8 scalers per VPU = the rows**, `usedOnOutPipe1..8` = **the columns**. Paths CONFIRMED
to exist (SCALER_9 and pipe 65 both E12) — and unlike `$vpuMixer`, **the simulator HAS
this collection**, just entirely unpopulated (`isAvailable:false`, capability `OFF`, all
pipes `NONE`). The Aquilon C capture predates finding it, so it is untested on hardware.
Note the mixer's `mixerAllocation` has only `usedOnOutPipe1..2` — the scaler's 1..8 is
the richer one.

Until that is proven, the Link grid view uses `deriveLinkGrid()` — an explicit packing
rule — and **says plainly in the UI that position is derived, not reported**. Do not
soften that wording without evidence.

**`scripts/probe-hardware.mjs` + `docs/HARDWARE-PROBE.md`** exist for the next hardware
session (user has access 2026-08-21). Read-only; 5 steps; the verdict line is whether
any scaler drives a pipe. Also grabs `/api/stores/device` whole (124 MB on the sim,
~5 MB of resources) which is far cheaper than guessing AWJ paths one at a time.
Worth capturing then: a **busier config** (mixed capabilities, combined VPUs, several
numbered layers), a **staged-but-unapplied** preconfig edit (the only way to exercise
the diff view), Cut & Fill, and Optimized mode.

**AW's own `VPU Training.app` v1.7.7** (`~/Desktop/aw training/VPU_Training_v1.7.7-complete/`)
is a **free-form teaching tool**, not data-driven — its own text says users may draw
technically impossible configurations. The macOS build is a native arm64 binary with no
web assets; **the webapp is `Windows-HTML/VPU_Training.html`** (single file, canvas,
8x8 grid at cell=40/S=320, Cap #1/#2/#4 tools, draggable SCREEN outlines, edge-snapping
VPUs for combined mode, 11 languages). Useful as a visual reference only.
That folder also holds the **REST API programmer's guide v4.1** (`DOCUMENTATION/`).
**That door is now CLOSED, checked on the live Aquilon C 2026-08-21** — see below.

## HARDWARE SESSION 2026-08-21 — placement partly SOLVED

**First full live read through the tool itself**: Aquilon C at 192.168.2.142,
32/64 fitted, 28 enabled, **~750 ms** for 64 mixers over AWJ. The README's
"never read real hardware" caveat is CLEARED.

**⚠️ THE BUG: `mixerAllocation` has `usedOnOutPipe1..8`, NOT 1..2.** The reader was
fetching two of eight, so three quarters of the device's own placement data was
invisible. With all eight, **the link-grid COLUMNS are reported**, and they are NOT
what the derived layout assumed — runs are **INTERLEAVED, not contiguous**:
S1 on links 1+3, S3 on 2+4, S2 on 5+7. The derived version looked plausible and was
wrong; a good reminder that a plausible-looking derivation is not evidence.

**Rows are still NOT reported.** Two layers of one screen share their output links AND
their slice numbers (S4 native vs S4 L1 are identical on both), and `channel` is 0 on
every mixer. `buildLinkGrid()` packs rows: one per slice, at the first row where the
run's columns are free; disjoint runs share rows, colliding runs stack. UI states which
half is the device's.

**`$vpuLayer` was a dead end — `E12` on hardware**, along with `$pipe`.

> **⚠️ THE SIMULATOR AND HARDWARE EXPOSE DIFFERENT COLLECTIONS.**
> Hardware: `vpuMixerList` ONLY. Simulator: `pipeList` + `vpuLayerList` ONLY.
> Anything verified only on the sim MUST be re-verified on a device. This inverted
> a confident prediction made the day before.

Also: **`cutnfillCapa`** is a real mixer prop (OFF throughout on this chassis).
**CORS confirmed ABSENT and 443 CLOSED on real hardware** — the hosted-app question
from [webrcs websocket transport](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_webrcs_websocket_transport.md) is closed for good.

**Transient `EHOSTUNREACH`** seen once mid-session on a healthy link (ICMP fine, three
immediate retries all succeeded). Possibly the AWJ 5-client cap. App surfaces it and
re-enables; watch rather than chase.

**Still untested:** Link setups (devices 2-4), capabilities other than `4K`, combined
VPUs (§5.5.5), Optimized mode (§5.5.6 — would make the boundary line wrong), Cut & Fill.
A busier chassis showing `channel` != 0 would be the single most valuable next capture.
`scripts/probe-hardware.mjs` + `docs/HARDWARE-PROBE.md` carry the procedure and results.

## Profiler + a diff bug it caught (2026-08-21)

**`scripts/profile-vpu.mjs`** — single self-contained file for OTHER operators to run
on THEIR LivePremier and send back. No deps, Node 18+, ~5 s, reads only; the 120 MB
config-store fetch is opt-in behind `--full`. Records **structure only** (S1..S24,
PROC_n_MIXER_n) — no addresses, serials, device/screen names or labels. Its header
points at the single `sock.write` line hard-coded to `get` so a stranger can verify the
safety claim by grep. **An earlier draft claimed "the word replace appears nowhere" —
which was FALSE** because of `String.replace`; a claim a sceptic can disprove with grep
is worse than no claim. Reworded, and the code avoids `.replace` so it survives.

**⚠️ BUG IT FOUND IN THE SHIPPED APP: `diff()` compared only `@props`, never
`mixerAllocation`.** The Aquilon C has a REAL pending re-allocation — output 2 moves
from **link 3 to link 2 across 28 mixers**, every property identical — so the tool said
"staged config matches running". Wrong, and it looked right. Now diffs all 8 links.
Note the shape: **running is INTERLEAVED (1+3), staged is CONTIGUOUS (1+2)** — the
device recomputes a tidy allocation while the running one has drifted.

Two profiler mistakes the same run caught, both worth remembering:
- **Absent Link followers answer every path with `isAvailable:false`, NOT E12** — so
  "device 2 exists" must be asked as "has device 2 any mixer fitted".
- **`cutnfillCapa` is a CAPABILITY, not a switch** (`4K` on S3's native run, `OFF`
  elsewhere) — do not read a non-OFF value as "Cut & Fill is on".

**`channel` is an ASSUMPTION, not a finding**: assumed to index the Link device
(DEVICE is an enum 1-4, and channel reads 0 throughout a standalone chassis). User
cannot set it without a linked system; agreed to assume and backfill later.

## Second real configuration, 2026-08-21 — two assumptions broken

The box was reconfigured between reads, which was worth more than any amount of
theorising. Captured as a SECOND fixture (`data/aquilon-c-6output-5k.json`); the tests
now run against both, because the first capture alone supports assumptions the second
disproves. **Keep both; add a third rather than editing either.**

**1. `slice` is NOT unique within a run.** S1 became a **six-output screen** and its
runs read slices `[0,0,1,1]` — TWO mixers per slice, on different links: one on
1,3,5,7 (outputs 1-4), one on 2,4 (outputs 5,6). That second mixer IS manual §5.5.4's
"a layer over more than 4 output links uses another layer link", and it is *reported*,
not inferred. So **columns are per MIXER, never per run** (the code had one column set
per run — a real bug), and rows come from the run's *distinct slices*, with mixers
sharing a slice sharing a row since their links do not overlap.

**2. `capacityToLinks` was wrong.** `5K` appeared and had no entry at all (fell through
to 2), and `8K` was hard-coded to 4. The device's own `LAYER_CAPABILITIES` enum is
`OFF, DUAL, 4K, 3, 5K, 5, 6, 7, 8K` — **the bare numbers sit at their own index, so
position IS the capacity**: DUAL=1, 4K=2, **5K=4**, 8K=8. Now derived from the enum.
`DUAL` and `8K` still never seen.

Also fixed: `probe-hardware.mjs` step 4 recorded only pipes 1-2, which is exactly how
the six-output structure stayed invisible in its output; now all 8. And the 124 MB
`/api/stores/device` pull is **opt-in behind `--store`** — it is the one heavy thing,
and per **aquilon read only rule** (working-practice note, kept in Claude memory) an early-closed pipe half-cues the device.

⚠️ **I hit that trap myself**: ran `probe-hardware.mjs <real ip> | head -28`, which
SIGPIPEs the script mid-run while it holds an AWJ connection. No visible harm, later
reads clean. **Use `--out` and read the file; never pipe a device-connected script
through `head`.**

## Usable tool as of 2026-08-21 — see `docs/ROADMAP.md`

Now a thing to keep open, not just a viewer:
- **Screen names**: `DeviceObject/$screen/@items/S<1-24>/control/@props/label` →
  "Main LED", "Stream ENG". **It is `$screen`, NOT `$screenAuxGroup`** — the latter has
  a `control` node but no `label` (E12). S25 is E12, which fixes the range. Aux labels
  live at `$auxiliary/@items/A1/control/@props/label` ("DSM"). **These are SHOW DATA —
  live view only, kept out of `data/` and `profile-vpu.mjs`, both public.**
- **Keep watching** (interval poll, off by default) — **fails closed**: stops on any
  failed read, says why, and leaves the last good reading rendered.
- **Save reading / Compare with a saved reading** — reuses `diff()`; the
  before-the-show vs during-the-show workflow.

**Known-wrong, not just incomplete:** Optimized mode (§5.5.6) removes the 4-link
scaling-engine boundary, so the grid's boundary line is WRONG for such a VPU. Highest
priority after aux screens (which need no new hardware — just work).

**A Link capture unlocks three things at once**: `channel`, devices 2-4, combined VPUs.

**Standing rule: ADD a capture to `data/`, never edit one.** Every configuration so far
has broken an assumption the previous made look settled — slice-uniqueness, 4K-only,
staged-matches-running. Two disagreeing captures beat one tidy one.

## Roadmap items 1+2 CLOSED 2026-08-21 — screen resource status found

**Auxiliaries DO NOT USE THE VPU — settled by Allan, not just inferred.** So there is
no aux resource to count and nothing to add to the resource views. The object model
agreed anyway: `usedInScreen` draws on a **S1..S24 enum with no `A*` entries**, and
`preconfig/resources` has no aux module. Auxes DO have labels
(`$auxiliary/@items/A1/control/@props/label` = "DSM"), which is the only reason their
absence ever looked like an oversight. **Closed — do not re-open or add aux handling.**

**⭐ `preconfig/resources/{current|new}/$screen/@items/S<n>/status/@props` is the
"will it fit" node** — the best find of the session, and it was three paths away the
whole time:
```
mode (FREESTYLE|DISABLED)  mixingMode  outputCount  usedOutputCapabilities
layerCount  isOptimized  regionValidity  isStereo3d
new side ALSO: remainingOutputCapabilities exceedingOutputCapabilities
               exceedingLayerCapabilities
```
So headroom and overflow are **REPORTED**, not inferred. `mode` distinguishes
configured screens from `DISABLED` ones.

**`isOptimized` fixed the one actively-WRONG thing.** §5.5.6 optimized mode removes the
4-link scaling-engine boundary, and it is a property of the **whole VPU**, reported per
**screen** — so map screen → mixers → processor (`optimizedVpus()`). On the captured
box S1 spends 6 output capabilities → true → VPU 1 draws **no** boundary (3 lines, not 4).
Matches the manual's rule (>=5 output links + a capacity-2 layer) exactly.

**Third capture** `data/aquilon-c-optimized.json` (screen names stripped). Three for
three: every config has broken an assumption the previous made look settled. There is
now a **test that fails if any capture grows a `screens` field** — a refresh from a live
read would carry show data into a PUBLIC repo silently.

⚠️ **Process note:** `optimizedVpus` silently failed to be added first time — a Python
`str.replace` whose anchor had already been rewritten, which printed "ok" and shipped a
broken import. **A replace that cannot fail is a replace that will silently no-op:
assert the anchor, and actually read the verifying grep.**

**Only Link work remains** (channel, devices 2-4, combined VPUs) — needs hardware we do
not have.

## v1.0.0 RELEASED 2026-08-21 + how it actually reaches a tech

**Released**: tag `v1.0.0`, GitHub release, `ghcr.io/stoatworks-labs/aquilon-vpu-map`
verified **anonymously pullable**, added to `stoatworks-unraid` fleet.json + unraid.json
(node-service, port/hostPort **8531**, public, `hasOwnDocker`, **`hostNetwork:false`** —
it discovers nothing, just one outbound TCP to a typed address). **The fleet generators
WORK again** (`gen-docker.mjs`, `gen-templates.mjs`) — not dead as previously recorded.

**⚠️ `BACKGROUNDS` ≠ `NATIVE` — I had this mislabelled in the UI.** *Backgrounds*
(background sets/stills, `preconfig/backgrounds/`) are a separate subtree outside
`preconfig/resources` and cost **no VPU** — Allan is right. But `usedInLayer: 'NATIVE'`
is the first entry of `PRECONFIG_SCREEN_LAYER` ("Native", then 1..256): a **layer slot**
that DOES consume mixers and IS counted by `layerCount`. Call it the **native layer**.

**Distribution — Docker is NOT the answer** (a tech may not have Docker/Node/a checkout):
- **Desktop launcher = the one to build.** Keeps AWJ (~700 ms, small targeted reads).
  Node SEA or Tauri; **unsigned macOS binaries are Gatekeeper-refused**, so use the
  fleet signing path.
- **Chrome extension = possible but WORSE, now measured.** It runs on the device's own
  origin so CORS/mixed-content vanish — **but an extension still cannot open a TCP
  socket**, so no AWJ. Its only same-origin route is the **124 MB** `/api/stores/device`;
  probed 2026-08-21 that `?path=`, `?filter=` and every `/api/stores/device/<subpath>`
  are **ignored or 404 — no narrower endpoint exists**. One-shot only; cannot poll.
- **Direct Sockets `TCPSocket()` is REAL but Isolated-Web-App only** — signed `.swbn`
  bundle, `isolated-app://` origin, Chrome flags or enterprise policy, plus a WebRTC
  bridge to reach it from a normal page. Heavier than the launcher for the same result.

**Fleet finding, spun off as a task:** `otter-edid-editor` and `atem-scopes` ship a
**stale `docker/stoatworks-headers.conf`** whose CSP `connect-src` lacks
`https://intake.stoatworks-labs.com` — their in-app feedback reports are being **silently
dropped in PROD only**. Regenerating fixes it; I reverted rather than commit to other repos.

**Trap:** `json.dumps(..., ensure_ascii=False)` on `fleet.json`/`unraid.json` rewrites
every `\u2014` escape to a literal em-dash across the WHOLE file. Use the default
`ensure_ascii=True`. Also `gen-templates.mjs` appends fleet.json's `note` into the
**user-facing CA Overview** (9 of 20 templates leak internal rationale) — write that
note for users, keep build rationale in AGENTS.md.

## The vendor REST API is NOT a route to a browser port (checked on hardware 2026-08-21)

`/api/tpp/v1/...`, guide v4.1, unauthenticated on port 80 of the real Aquilon C. Two
independent reasons it cannot host this tool, either one fatal:

1. **It carries no VPU data at all.** The whole surface is live operation: system,
   screens (`{isEnabled,label}` only), layers/sources, aux (its `capacity` is a *layer*
   count, not mixers), multiviewer, audio, sources, thumbnails, WOL, auth. `vpu`,
   `mixers`, `resources`, `preconfig`, `system/resources` all **404** — the doc is not
   understating the surface. Nothing under `preconfig/resources` is exposed.
2. **No CORS on this route either.** `GET /api/tpp/v1/system` with a foreign `Origin`
   returns 200 + `Vary: Origin` and **no `Access-Control-Allow-Origin`** — identical to
   `/api/stores/device`. With 443 still closed, a hosted page is dead on both counts.

**The one thing worth taking from it:** `GET /api/tpp/v1/system` → 121 bytes of
`{type:"AQL C", label, isLinked, linkName, version:{6.2.73}}` — chassis model and
firmware, which the app currently only *infers* from `isAvailable`. Cheap, documented,
stable, and it would let the UI name the chassis; add it to BOTH transports if added.
Undocumented but working: `GET /api/tpp/v1/screens` returns the whole 1..24 collection
in one call. Docs live at `~/Desktop/aw training/DOCUMENTATION/`.

## v1.1.0 — DESKTOP APP (Tauri 2 + Rust), 2026-08-21

The answer to "how does a tech actually run this": double-click, no Node, no Docker,
no checkout. **~2 MB dmg** — Tauri uses the system WebView, not a bundled browser.
Follows av-launcher's conventions (Tauri 2, static `frontendDist`, no bundler).
**av-launcher itself is NOT a distribution route** — it wraps server binaries by
absolute path on Allan's machine, so it is a dev/ops tool.

**ONE UI, two transports** — isolated to `readVpu()` in `public/app.js`:
desktop `invoke('read_vpu')` (Rust, `src-tauri/src/read.rs`) vs server
`fetch('/api/vpu')` (`lib/read.js`). **Both MUST return the identical JSON shape**;
there is no branch below that point. Change a field in one → change it in the other.
`scripts/stage-frontend.mjs` assembles `dist-frontend/` (public/ at root, data/ beneath)
so nothing is duplicated in the repo.

Rust side is **get-only by construction** (one socket write, builds `{"op":"get"}` from
a literal) and now has **`only_ever_sends_get`** — a test that drives the client and
asserts every frame carries `op:"get"` with no value. 6 Rust tests + an `#[ignore]`
`reads_a_real_device` (`AQUILON_IP=… cargo test -- --ignored`), run today on the
Aquilon C: NLC_C, screen names, 32 fitted / 26 enabled — matching the Node build.

**⚠️ macOS build is UNSIGNED** → Gatekeeper refuses it with a "damaged" message that
reads like corruption, not permission. Right-click → Open. Stated in README + release
notes; fleet Apple signing path not yet wired here ([apple codesigning](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/project_apple_codesigning.md)).

**Verifying a Tauri window on macOS:** `System Events … window 1` returns
"Invalid index (-1719)" and `count of windows` = 0 **even with Accessibility enabled** —
it is wrong for this app. Use **CoreGraphics** instead: a tiny `swift` script over
`CGWindowListCopyWindowInfo` filtered by pid listed the real window
("Aquilon VPU Map" 1216x882). `screencapture -R` then failed with "could not create
image from rect" — Screen Recording not granted to the terminal. So: CG for existence,
do not chase the picture (**screenshot capture** (working-practice note, kept in Claude memory) two-miss rule).

Icon: generated by a hand-written **minimal PNG encoder in `scripts`-style Python**
(zlib + struct, ~30 lines) drawing the 8x8 link field — no image library added for one
asset; `npx tauri icon` expands it to the full set.

### Desktop CI — three failures worth not repeating

1. **`generate_context!` embeds the frontend at COMPILE time**, so `dist-frontend/`
   must exist before ANY cargo command including `cargo test`. It is generated, not
   committed, and tauri-action's `beforeBuildCommand` runs too late for a preceding
   test step. It passed locally only because the dir was already staged — a green
   that meant nothing.
2. **tauri-action drives the repo's own `tauri` npm script**, so `@tauri-apps/cli`
   must actually be installed: needs a committed `package-lock.json` + `npm ci`.
   Without it every platform dies with `sh: tauri: command not found` (exit 127).
3. **`macos-13` is capacity-dead** — I used it for the Intel build and it queued
   while all three others finished. **ci intel mac runners** (working-practice note, kept in Claude memory) already says
   to cross-compile x86_64 on Apple Silicon (`macos-14` + `--target
   x86_64-apple-darwin`). **Check that memory BEFORE writing any release matrix.**

Release assets (all 4 platforms green): aarch64/x64 `.dmg`, `.app.tar.gz`,
`x64-setup.exe`, `.deb`, `.rpm` — largest is 2.26 MB.

**Still open:** whether it should poll live rather than read on demand;
whether it merges with the timeline tool; PROC_3/4 behaviour on a fuller chassis;
what drives slice count exactly (canvas width assumed, not proven).

## THE MAPPING HAS TWO FIRMWARE SPELLINGS — both are in the field

Established 2026-08-20 from `GET /api/stores/device` on the simulator, against the
Aquilon C read recorded above. `aquilon-vpu-map` only handles the first:

| | collection | ids | per device | out-pipes | `slice` |
| --- | --- | --- | --- | --- | --- |
| **mixer model** (Aquilon C) | `$vpuMixer` / `vpuMixerList` | `PROC_n_MIXER_m` | 64 | 2 (+ `$scaler` A/B with `memoryFill`/`memoryCut`) | yes |
| **scaler model** (sim 6.2.73) | `vpuLayerList` | `PROC_n_SCALER_m` | 32 | 8, on `scalerAllocation` | **no** |

So a firmware answering `E12` for `$vpuMixer` is **not necessarily** a device
without a VPU map — it may be reporting the other model. `slice` absent means "not
reported", never slice 0. [livepremier plus](https://github.com/stoatworks-labs/livepremier-plus/blob/main/docs/NOTES.md) (`livepremier-plus`)'s `core/vpu.js` normalises
both into one shape and is the reference implementation for the second.

**The simulator reports 128 units with `isAvailable:false` on every one** — a
simulated Cmax has no fitted VPU. Correct, and easily mistaken for a broken read.

## A second front-end exists

[livepremier plus](https://github.com/stoatworks-labs/livepremier-plus/blob/main/docs/NOTES.md) (`livepremier-plus`) draws the same map inside the vendor Web RCS itself,
getting the whole mapping free from the same-origin store rather than ~500 AWJ
gets. Its `toMixerRecords()` emits this tool's exact record shape, so captures
cross between them. Deliberately an adapter, not a shared import — a browser
extension cannot speak TCP 10606, and a vendored copy would drift
([analytics tool vendoring](https://github.com/stoatworks-labs/fleet-notes/blob/main/notes/reference_analytics_tool_vendoring.md)).

## `public/vpu.js` is now VENDORED into the extension — 2026-08-21

[livepremier plus](https://github.com/stoatworks-labs/livepremier-plus/blob/main/docs/NOTES.md) (`livepremier-plus`) carries a **copy** of `public/vpu.js` at
`src/vendor/vpu-model.js`, with `npm run sync:vpu-model` to re-copy and a drift
test that fails when the two diverge. A Chrome extension has to contain every
file it loads, so a copy was unavoidable; the drift test is what keeps it safe.

**Treat this file as the shared model of two projects now.** Edits belong here,
and the extension pulls them across — but a change to the record shape or to
`summarise`/`buildLinkGrid`/`diff` breaks the extension's adapter, so mention it
when changing them. The extension's `core/vpu.js` is only the store adapter: it
reads `vpuMixerList` out of `/api/stores/device` instead of over AWJ, and gets
the per-screen status free where this tool spends 24 round trips.

That adoption **corrected three errors** in the extension's own earlier model —
`NATIVE` mislabelled "Background", mixers read as having 2 out-pipes not 8, and
a claimed second firmware model that does not exist. Worth knowing the shared
model earns its keep.

## THE GRID WAS WRONG TWICE OVER — fixed 2026-08-21

Settled against the real figures in **`~/Desktop/aw training/DOCUMENTATION/
Aquilon_User_Manual_v6.2.pdf` §5.5 (PDF pages 66-70)**. Read those pages before
touching the grid again; the diagrams carry the model and the prose does not.

**`usedOnOutPipe<k>: '<n>'` is a PAIR whose halves disagree.** The KEY is the VPU
pipe the mixer is wired to and those are interleaved (a six-output screen's first
mixer is on pipes 1,3,5,7). The **VALUE is the column** — which of the *screen's*
own output links that pipe carries, 1..n in order. The grid had been drawing the
keys, which scatters a screen's layers across the field. A screen owns a
**contiguous** run of links, screens side by side (§5.5.4).

Rows: one layer-capacity link, carrying **one layer** — the old code packed runs
onto shared rows. Height = capacity: **dual link (≤4K30) = 1, 4K60 = 2, 5K60 = 4**
(so the LAYER_CAPABILITIES enum position IS the capacity). A layer past 4 output
links wraps onto another link (§5.5.4); **Optimized mode lifts that for capacity-2
layers only** (§5.5.6), so `buildLinkGrid(mixers, optimizedVpus)` now takes the
optimized set. A screen's **native background is not layer capacity** — own band
below the field, out of `rowsUsed`.

Six-output capture now reproduces §5.5.4's figure exactly: 8/8 rows, 8/8 columns.
Block shape gained `mixers/slices/height/outputs/section/background/wrapped`, grids
gained `screens/columnsUsed/backgroundRows`. **Shipped 2026-08-21**: `2eb9a1d` here,
and [livepremier plus](https://github.com/stoatworks-labs/livepremier-plus/blob/main/docs/NOTES.md) (`livepremier-plus`) `497c012` — synced, renderer ported, and it now has
`tools/preview.html`, which renders the panel from a recorded capture because
`tools/serve.mjs` needs a live Web RCS tab and there is no longer a device.

## NO MORE HARDWARE from 2026-08-21 — captures are the ground truth

The Aquilon C is gone. The three redacted captures in `data/` are all there is,
and the app now offers **all three** in a picker (`data/captures.json`); before,
only the base one was reachable outside the tests.

`scripts/capture-config.mjs --report` **needs no device** and prints what the
captures prove vs what is still open — currently **2 answered, 10 open**. The
big ones: **a capacity-1 (DUAL) layer has NEVER been seen** (so the unit the
whole grid is measured in is manual-only), **nothing over-budget** (every
`exceeding*` has read 0), and **Cut & Fill never actually enabled** (§5.5.7 says
it doubles a layer's resources; the view ignores it). Given an IP it records a
new capture, redacted, and lists it in the picker — reads only.
`docs/CAPTURE-GUIDE.md` is the hand-to-a-stranger version. Tested end to end
against the repo's scripted stand-in device, so it stays honest with no box.


**On the site since 2026-08-22** at `/software/aquilon-vpu-map/`, and as a member of the new `/analog-way/` family page — see [analog way page](https://github.com/stoatworks-labs/stoatworks-website/blob/main/docs/NOTES.md) (`stoatworks-website`). `docs/screenshot.png` is registered in the website's `scripts/shots.json` as its hero. Not hosted: there is no subdomain, and there should not be — it reads a frame on your network.

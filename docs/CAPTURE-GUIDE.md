# Capturing a configuration

**For whoever next has an Aquilon in front of them.** You do not need to know
anything about this tool, about AWJ, or about how the grid is drawn. You need
about ten minutes on the device and a laptop on the same network.

Since 2026-08-21 there is no Aquilon to read here. Everything the link grid
claims is backed by three recorded configurations in [`../data`](../data), and
the questions those three cannot answer are listed below. Each one is a
configuration somebody has to build on a real box.

---

## What you need

- Node 18 or newer. `node --version`.
- This checkout. There are no dependencies to install.
- An IP route to the Aquilon. AWJ is TCP **10606**; nothing else is needed.

## Is this safe on a live machine?

It reads. Every AWJ frame it can send carries `op: "get"` — it goes through the
same client the app uses, calling only `get` and `tryGet`, and there is no code
path in it that writes, stages, takes, or subscribes. (The desktop build asserts
the same property of its own transport in `only_ever_sends_get`.)

It is still around 500 round trips and takes a few seconds. Do not fire it
mid-cue on a show; between sessions, or on a rehearsal box, is fine.

## First, see what is already answered

```
node scripts/capture-config.mjs --report
```

No device needed. It lists the captures in `data/`, what each one covers, and
every open question with the setup that would close it. Run it again after each
capture to watch the list shrink.

---

## Recording one

Build the configuration on the device, **apply it** so it is the running one
(unless the question says otherwise), then:

```
node scripts/capture-config.mjs 192.168.2.140 --name capacity-1 --label "Dual-link layer"
```

That writes `data/aquilon-<dev>-capacity-1.json` and adds it to the app's capture
picker. Commit it, or send the file back — it is self-contained.

**Screen names are dropped, and the address is written as `redacted`.** These
files ship in a public repo, so the operator's names for their screens ("Main
LED", a client's name) are show data and never go in. `--keep-names` overrides
that for a capture you are keeping to yourself; do not commit one.

---

## The configurations that are wanted

In priority order. If you only get one shot at the device, do the first three.

### 1. A capacity-1 layer — `--name capacity-1`

**Build:** any screen with an HD or 4K30 layer on it, alongside the 4K60 layers
you would normally use. `capability` should read `DUAL` rather than `4K`.

**Why:** capacity 1 is the unit the entire grid is measured in — one layer link,
one output link — and it has never once been seen reported. Everything captured
is 4K60 (capacity 2) or 5K60 (capacity 4). The rule that a capacity-1 layer
cannot cross the centre line comes from the manual, not from the device.

### 2. A configuration that does not fit — `--name over-budget`

**Build:** stage — do **not** take — a configuration the box refuses. More layers
on one screen than the VPU can hold is the easiest: keep adding until the Web RCS
complains. Leave it staged and capture; the running configuration is untouched.

**Why:** `exceedingOutputCapabilities` and `exceedingLayerCapabilities` have only
ever read `0`. The one number a tech actually wants from this tool — what
over-budget looks like, and which screen caused it — is unverified, as is the
grid's own overflow marking.

### 3. Cut & Fill switched on — `--name cut-and-fill`

**Build:** two comparable layers on one screen, Cut & Fill enabled on one of
them and not the other.

**Why:** manual §5.5.7 says the effect *doubles* the resources a layer needs,
which would make it twice as tall on the grid. `cutnfillCapa` has only ever been
read as a capability (`OFF` or `4K`), never with the effect actually on, so the
view currently ignores it. The difference in mixer count between the two layers
is the answer.

### 4. A screen too wide for one VPU — `--name combined-vpus`

**Build:** one screen with 9 or more outputs. The manual's example is 12.

**Why:** §5.5.5 — the screen spills into the next VPU and each of its layers then
costs three layer links. The grid lays out each VPU independently and has never
seen a screen that spans two, so how the columns should continue on the second
board is untested.

### 5. A screen straddling the centre line — `--name unaligned-screen`

**Build:** three screens on one VPU with an awkward spread of outputs — 3, 3 and
2 — so that the middle screen starts at output link 4 and runs past link 5.

**Why:** in every capture so far the screens land neatly on a scaling-engine
half, so "break at the centre line" and "chunk every four links" give the same
answer. This is the configuration where they could disagree.

### 6. Whatever chassis you have — `--name proc-3-4`, `--name link-follower`

If the box has **three or four processor boards**, capture anything at all: VPU 3
and 4 have never been seen fitted. If it is a **Link** setup, capture each device
separately:

```
node scripts/capture-config.mjs <ip> --name link-follower-2 --device 2
```

Whether `channel` indexes the Link device is a guess — it has read `0` on every
mixer ever captured. A follower with a populated map settles it.

### 7. An 8K layer — `--name capacity-8`

If the chassis can make one. `capacityToLinks` maps `8K` to eight links from the
position in the device's own enum, and has never been checked against a device.

---

## After a firmware update

Different question, different tool:

```
node scripts/probe-hardware.mjs <ip>
```

It sweeps for paths that do not exist yet. The one that matters is **`$vpuLayer`**
— eight scalers per VPU, each declaring which output pipes it drives. That is
the grid itself, reported rather than derived. On 6.2 hardware it answers `E12`;
on the simulator it exists but is permanently empty. If a firmware ever populates
it, the rows stop being our ordering and become the device's, and the probe says
so in capitals.

---

## If it fails

- **`ECONNREFUSED`** — wrong address, or AWJ is not on 10606. Check you can reach
  the device's web interface first.
- **`NO_VPU_SUBTREE`** — it connected, but the device exposes no `$vpuMixer`
  collection. The LivePremier simulator behaves exactly this way: it has no
  processor boards to map. Not a bug, and not something a capture can fix.
- **Anything else** — the error is printed and nothing is written, on either side.
  The device is not left in a different state than you found it.

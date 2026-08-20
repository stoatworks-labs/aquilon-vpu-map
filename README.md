# Aquilon VPU Map

> **AI-assisted project.** This codebase was created with [Claude](https://claude.com/claude-code)
> (Anthropic), directed and reviewed by a human author. The VPU mixer model and every
> path in it were **captured from a real Aquilon C**, and the parsing, summarising and
> diffing are covered by tests that run against that capture. But **this code has never
> completed a VPU read from real hardware** — its live path has only been exercised
> against the LivePremier simulator (which exposes no VPU map at all) and against a
> scripted AWJ responder replaying the capture. Treat a first run on a real device as
> the real test.

See how an Analog Way **LivePremier** allocates its VPU mixers across screens, layers
and slices.

Every layer on a LivePremier costs physical mixing hardware. The device knows exactly
where that hardware went and will tell you — but the stock Web RCS shows it a panel at
a time. This puts the whole chassis on one screen.

![The chassis map, read from a real Aquilon C](docs/screenshot.png)

## What a VPU mixer is

A **VPU mixer** is the physical mixing and scaling resource the device allocates to a
(screen, layer) pair. An Aquilon has up to four processors of sixteen mixers — **64**
in total, though most chassis are part-populated.

A layer too wide for a single mixer is split across several, each carrying one
**slice**. That is why an eight-slice background can consume an entire processor board
on its own, and why counting layers never tells you whether a configuration will fit.

The device reports the map read-only, and keeps two copies of it: `current` (running)
and `new` (staged). This tool shows the running map and highlights anything the staged
one would change.

## Running it

```bash
npm start
```

Then open <http://localhost:8531> and enter your Aquilon's address.

```bash
PORT=9000 AQUILON_IP=192.168.1.50 npm start
```

`AQUILON_IP` only sets the address the form starts on; the field is editable and the
last address you used is remembered in the browser.

### Docker

```bash
docker compose up -d
```

## Why it needs a server

AWJ is a raw TCP protocol on port **10606**. A browser tab cannot open a TCP socket, so
the page cannot talk to the device directly however it is hosted. This app's own server
makes the read and hands back JSON.

That is also why there is no useful "just open the HTML file" mode: without the server
you get the recorded capture and nothing else.

## Reads only

This tool **never writes to the device**. It issues AWJ `get` and nothing else — not
even the `Subscriptions` write that a push-based client would need. Every property it
reads is declared `readOnly` in the device's own model, so there is no state here that
could be changed by accident.

If you want to be sure, `lib/awj.js` has no code path that emits `replace`.

## The recorded capture

`data/aquilon-c-snapshot.json` is a real read from a real Aquilon C — 32 of 64 mixers
fitted, 28 in use across four screens. **Load recorded capture** shows it, which is
useful for seeing what the tool does without a device in front of you, and it is what
the test suite asserts against.

The host it came from is redacted; nothing else is edited.

## Supported devices

Built for **LivePremier** (Aquilon). AWJ is also spoken by Alta 4K and Midra 4K, and
the client here will connect to them, but the VPU mixer map is a LivePremier structure
and other platforms answer `E12` for it — the app says so plainly rather than showing
an empty chassis.

**The LivePremier simulator has no VPU map.** The path resolves as far as
`$device/@items/1` and then stops. This is not a bug in the tool; the simulator has no
processor boards to map.

## Paths

Firmware 6.2, verified on hardware. The collection segment is `$vpuMixer`, camelCase —
`$vpu-mixer` and `$mixer` both answer `E12`.

```
DeviceObject/preconfig/resources/{current|new}/status/mapping
  /$device/@items/<1-4>                       1 = master, 2-4 = Link followers
  /$vpuMixer/@items/PROC_<1-4>_MIXER_<1-16>
    /@props/isAvailable                       fitted?
    /@props/isEnabled                         in use?
    /@props/usedInScreen                      S1..S24
    /@props/usedInLayer                       NATIVE, then 1..256
    /@props/slice                             0..8
    /@props/capability                        OFF DUAL 4K 3 5K 5 6 7 8K
    /@props/{channel,seamlessCapa}
    /mixerAllocation/@props/usedOnOutPipe{1,2} NONE..64
    /$scaler/@items/{A,B}/@props/{memoryFill,memoryCut}  SM1..SM8
```

AWJ cannot enumerate: every container read returns `{}`. See [AGENTS.md](AGENTS.md) for
where the model came from and how to recover the rest of it.

## Tests

```bash
npm test
```

No dependencies, no build step. Node 18+.

## Licence

MIT — see [LICENSE](LICENSE).

Not affiliated with Analog Way. "LivePremier", "Aquilon" and "Alta" are their marks.

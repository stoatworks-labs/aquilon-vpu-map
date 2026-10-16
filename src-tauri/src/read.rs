//! Reading the VPU map off a device — the desktop equivalent of `lib/read.js`.
//!
//! This deliberately produces the SAME JSON shape as the Node bridge's
//! `/api/vpu`, so `public/app.js` renders either without knowing which it got.
//! If you change a field here, change it there too.

use crate::awj::Awj;
use serde_json::{json, Map, Value};

const MIXER_PROPS: [&str; 8] = [
    "isEnabled",
    "cutnfillCapa",
    "usedInScreen",
    "usedInLayer",
    "channel",
    "slice",
    "capability",
    "seamlessCapa",
];

const SCREEN_STATUS_PROPS: [&str; 11] = [
    "mode",
    "mixingMode",
    "outputCount",
    "usedOutputCapabilities",
    "remainingOutputCapabilities",
    "exceedingOutputCapabilities",
    "layerCount",
    "exceedingLayerCapabilities",
    "isOptimized",
    "regionValidity",
    "isStereo3d",
];

const OUT_PIPES: u8 = 8;
const PROCESSORS: u8 = 4;
const MIXERS_PER_PROCESSOR: u8 = 16;

fn mapping(which: &str, device: &str) -> String {
    format!(
        "DeviceObject/preconfig/resources/{which}/status/mapping/$device/@items/{device}"
    )
}

/// Device identity — cheap, and confirms this is a LivePremier.
///
/// `isSimulated` is the simulator telling on itself, and the only thing that
/// can: a 6.1.60 Aquilon reports no mixer map exactly as a simulator does.
/// `version/@props/updater` is the firmware ("6.2.73", "6.1.60"). Absent
/// fields are left out, never guessed.
pub fn identity(a: &mut Awj) -> Value {
    let p = "DeviceObject/system/$device/@items/1";
    let mut out = Map::new();
    out.insert("dev".into(), a.try_get(&format!("{p}/@props/dev")).unwrap_or(Value::Null));
    out.insert("label".into(), a.try_get(&format!("{p}/@props/label")).unwrap_or(Value::Null));
    if let Some(Value::Bool(b)) = a.try_get(&format!("{p}/@props/isSimulated")) {
        out.insert("isSimulated".into(), Value::Bool(b));
    }
    if let Some(Value::String(f)) = a.try_get(&format!("{p}/version/@props/updater")) {
        if !f.is_empty() {
            out.insert("firmware".into(), Value::String(f));
        }
    }
    Value::Object(out)
}

/// Firmware 6.1.x: no mixer map, per-screen layer figures instead.
pub fn is_firmware_61(firmware: Option<&str>) -> bool {
    firmware.map(|f| f.starts_with("6.1.")).unwrap_or(false)
}

/// What to tell the operator when there is no mixer map: `(title, hint)`.
///
/// The device's identity chooses the sentence, never the shape of the answer:
/// an Aquilon RS4 on 6.1.60 with its screens on air was once told it was a
/// simulator. Word-for-word the same as `noMixerMap` in `lib/read.js`; change
/// both.
pub fn no_mixer_map(identity: &Value, in_service: bool) -> (String, String) {
    let s = |k: &str| identity.get(k).and_then(Value::as_str).filter(|v| !v.is_empty());
    let simulated = identity.get("isSimulated").and_then(Value::as_bool);
    let firmware = s("firmware");
    let name = [s("label"), s("dev")].iter().flatten().cloned().collect::<Vec<_>>().join(" ");
    let below = if in_service {
        " What it does report is each screen\u{2019}s layer sizes and the room left, below."
    } else {
        ""
    };

    if simulated == Some(true) {
        let who = if name.is_empty() {
            String::new()
        } else {
            match firmware {
                Some(f) => format!(" ({name}, firmware {f})"),
                None => format!(" ({name})"),
            }
        };
        return (
            "No VPU on this simulator".into(),
            format!(
                "The device says it is a simulator{who}, and it exposes no $vpuMixer collection. \
                 This simulator allocates nothing, so there is no mixer map to draw \u{2014} \
                 the tool is working."
            ),
        );
    }
    if simulated == Some(false) || !name.is_empty() {
        let mut bx = if name.is_empty() { "The device".to_string() } else { name };
        if let Some(f) = firmware {
            bx = format!("{bx} on firmware {f}");
        }
        if is_firmware_61(firmware) {
            return (
                "This firmware does not report its VPU allocation".into(),
                format!(
                    "{bx} answers E12 for $vpuMixer. The VPU is there; firmware 6.1.x just does \
                     not say how its mixers are allocated, so there is no mixer map to draw \
                     \u{2014} the tool is working.{below}"
                ),
            );
        }
        return (
            "No VPU mixer map on this device".into(),
            format!(
                "{bx} answers E12 for $vpuMixer, so there is no mixer map to draw. An Aquilon C \
                 on 6.2.73 reports one; an Aquilon RS4 on 6.1.60 does not.{below}"
            ),
        );
    }
    (
        "No VPU mixer map reported".into(),
        format!(
            "Reached the device, but it exposes no $vpuMixer collection, so there is no mixer \
             map to draw. A simulator answers this way, and so does LivePremier firmware 6.1.60 \
             on hardware.{below}"
        ),
    )
}

/// The device's LAYER_CAPABILITIES enum, less OFF — `public/vpu.js` has the list.
const LAYER_CAPABILITIES: [&str; 8] = ["DUAL", "4K", "3", "5K", "5", "6", "7", "8K"];

/// What each screen in service spends, layer by layer, and (staged) the room
/// left by size — all that firmware 6.1.x says about its VPU. The desktop
/// equivalent of `readScreenLayers` in `lib/read.js`, which has the paths and
/// the reasoning. A screen's list has 257 slots (NATIVE, 1-256), so it is read
/// only until `layerCount` of them are found.
pub fn screen_layers(a: &mut Awj, which: &str, status: &Value) -> Value {
    let mut out = Map::new();
    let empty = Map::new();
    for (id, st) in status.as_object().unwrap_or(&empty) {
        let b = format!("DeviceObject/preconfig/resources/{which}/$screen/@items/{id}");
        let want = st.get("layerCount").and_then(Value::as_u64);
        let mut layers = Vec::new();
        let keys = std::iter::once("NATIVE".to_string()).chain((1..=256).map(|n| n.to_string()));
        for key in keys {
            if want.map(|w| layers.len() as u64 >= w).unwrap_or(false) {
                break;
            }
            match a.try_get(&format!("{b}/$layer/@items/{key}/status/@props/capability")) {
                None => break, // past the end, or not this firmware's spelling
                Some(Value::String(c)) if c != "OFF" && !c.is_empty() => {
                    layers.push(json!({ "layer": key, "capability": c }));
                }
                Some(_) => {}
            }
        }
        // None where the screen reports no room at all, so "no figure" never
        // reads as "no room" — the running side, or no `$layerCapability`.
        let mut room: Option<Vec<Value>> = None;
        if which == "new" {
            for capa in LAYER_CAPABILITIES {
                let c = format!("{b}/$layerCapability/@items/{capa}/status/@props");
                let Some(raw) = a.try_get(&format!("{c}/remainingLayerCapabilities")) else {
                    continue; // not a capability this box lists
                };
                let room = room.get_or_insert_with(Vec::new);
                let count = raw.as_u64().unwrap_or(0);
                if count == 0 {
                    continue;
                }
                let with_mask = a
                    .try_get(&format!("{c}/remainingLayerWithMaskCapabilities"))
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                room.push(json!({ "capability": capa, "layers": count, "withMask": with_mask }));
            }
        }
        out.insert(id.clone(), json!({ "layers": layers, "room": room }));
    }
    Value::Object(out)
}

/// The operator's own screen names. `$screen`, NOT `$screenAuxGroup` — the
/// latter has a `control` node with no `label` on it.
pub fn screen_names(a: &mut Awj) -> Value {
    let mut out = Map::new();
    for i in 1..=24 {
        let path = format!("DeviceObject/$screen/@items/S{i}/control/@props/label");
        if let Some(Value::String(s)) = a.try_get(&path) {
            if !s.trim().is_empty() {
                out.insert(format!("S{i}"), Value::String(s.trim().to_string()));
            }
        }
    }
    Value::Object(out)
}

/// Per-screen resource status: spend, headroom, and whether Optimized mode is
/// on. Screens that are not configured report `DISABLED` and are skipped.
pub fn screen_status(a: &mut Awj, which: &str) -> Value {
    let mut out = Map::new();
    for i in 1..=24 {
        let base = format!(
            "DeviceObject/preconfig/resources/{which}/$screen/@items/S{i}/status/@props"
        );
        let mode = match a.try_get(&format!("{base}/mode")) {
            None => break, // past the end of the model
            Some(m) => m,
        };
        if mode.as_str() == Some("DISABLED") {
            continue;
        }
        let mut rec = Map::new();
        rec.insert("mode".into(), mode);
        for p in SCREEN_STATUS_PROPS.iter().filter(|p| **p != "mode") {
            if let Some(v) = a.try_get(&format!("{base}/{p}")) {
                rec.insert((*p).into(), v);
            }
        }
        out.insert(format!("S{i}"), Value::Object(rec));
    }
    Value::Object(out)
}

/// What is read off each output, after which screen it is in — the header over
/// the grid's columns. Store spellings (`outputList` is `$output`, `plugList` is
/// `$plug`), the same correspondence the mixer paths follow, but unlike those
/// never yet answered by hardware: every read is a try_get, so a firmware that
/// spells them differently costs one E12 per output and the header is absent.
const OUTPUT_PROPS: [(&str, &str); 6] = [
    ("region", "canvas/status/@props/usedInRegion"),
    ("capability", "canvas/status/@props/capability"),
    ("label", "control/@props/label"),
    ("card", "mapping/@props/card"),
    ("physical", "mapping/@props/physical"),
    ("type", "$plug/@items/1/status/@props/type"),
];

/// Every output the device has, and which screen, region and plug it is. An
/// output assigned to no screen (or to an aux, which costs no VPU) is one read.
pub fn outputs(a: &mut Awj) -> Value {
    let mut out = Map::new();
    for i in 1..=24 {
        let b = format!("DeviceObject/$output/@items/{i}");
        let screen = match a.try_get(&format!("{b}/canvas/status/@props/usedInScreenAux")) {
            None => continue, // not fitted, or not this firmware's spelling
            Some(v) => v,
        };
        let mut rec = Map::new();
        let assigned = screen
            .as_str()
            .map(|s| s.len() > 1 && s.starts_with('S') && s[1..].chars().all(|c| c.is_ascii_digit()))
            .unwrap_or(false);
        rec.insert("screen".into(), screen);
        if assigned {
            for (key, rel) in OUTPUT_PROPS.iter() {
                if let Some(v) = a.try_get(&format!("{b}/{rel}")) {
                    if v.is_null() || v.as_str() == Some("") {
                        continue;
                    }
                    rec.insert((*key).into(), v);
                }
            }
        }
        out.insert(i.to_string(), Value::Object(rec));
    }
    Value::Object(out)
}

/// One side of the mapping. `None` means the device has no `$vpuMixer`
/// collection at all — a simulator answers this way, and so does an Aquilon on
/// firmware 6.1.x; `no_mixer_map` lets the device's identity say which.
pub fn mapping_side(a: &mut Awj, which: &str, device: &str) -> Option<Value> {
    let mut out = Map::new();
    let mut first = true;

    for p in 1..=PROCESSORS {
        for m in 1..=MIXERS_PER_PROCESSOR {
            let id = format!("PROC_{p}_MIXER_{m}");
            let b = format!("{}/$vpuMixer/@items/{id}", mapping(which, device));

            let avail = a.try_get(&format!("{b}/@props/isAvailable"));
            let avail = match avail {
                None if first => return None, // no subtree here at all
                None => Value::Bool(false),
                Some(v) => v,
            };
            first = false;

            if avail.as_bool() != Some(true) {
                out.insert(id, json!({ "isAvailable": false }));
                continue;
            }

            let mut rec = Map::new();
            rec.insert("isAvailable".into(), Value::Bool(true));
            for prop in MIXER_PROPS.iter() {
                if let Some(v) = a.try_get(&format!("{b}/@props/{prop}")) {
                    rec.insert((*prop).into(), v);
                }
            }

            // Eight output pipes, not two — each names an output link this mixer
            // drives, and they are what makes the grid's columns real.
            let mut alloc = Map::new();
            for k in 1..=OUT_PIPES {
                let v = a
                    .try_get(&format!("{b}/mixerAllocation/@props/usedOnOutPipe{k}"))
                    .unwrap_or(Value::String("NONE".into()));
                alloc.insert(format!("usedOnOutPipe{k}"), v);
            }
            rec.insert("mixerAllocation".into(), Value::Object(alloc));

            let mut scalers = Map::new();
            for s in ["A", "B"] {
                let mut sc = Map::new();
                for f in ["memoryFill", "memoryCut"] {
                    if let Some(v) =
                        a.try_get(&format!("{b}/$scaler/@items/{s}/@props/{f}"))
                    {
                        sc.insert(f.into(), v);
                    }
                }
                scalers.insert(s.into(), Value::Object(sc));
            }
            rec.insert("scalers".into(), Value::Object(scalers));

            out.insert(id, Value::Object(rec));
        }
    }
    Some(Value::Object(out))
}

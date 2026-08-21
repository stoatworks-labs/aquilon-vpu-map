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
pub fn identity(a: &mut Awj) -> Value {
    let p = "DeviceObject/system/$device/@items/1/@props";
    json!({
        "dev": a.try_get(&format!("{p}/dev")),
        "label": a.try_get(&format!("{p}/label")),
    })
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

/// One side of the mapping. `None` means the device has no `$vpuMixer`
/// collection at all — the simulator behaves this way.
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

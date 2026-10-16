//! Tests for the desktop read path.
//!
//! These mirror `test/vpu.test.js`: a scripted AWJ responder on a real socket,
//! so the framing and path construction are exercised rather than mocked.
//!
//! The important one is `only_ever_sends_get` — the whole safety claim of this
//! app is that it cannot write to a switcher, and that deserves a test rather
//! than a comment.

use crate::awj::Awj;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

/// Serve 0x04-framed AWJ from a table, and report every request line seen.
fn fake_device(table: HashMap<String, serde_json::Value>) -> (u16, mpsc::Receiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (tx, rx) = mpsc::channel();

    thread::spawn(move || {
        let (mut sock, _) = match listener.accept() {
            Ok(v) => v,
            Err(_) => return,
        };
        let mut buf: Vec<u8> = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            let n = match sock.read(&mut chunk) {
                Ok(0) | Err(_) => return,
                Ok(n) => n,
            };
            buf.extend_from_slice(&chunk[..n]);
            while let Some(i) = buf.iter().position(|&b| b == 0x04) {
                let frame: Vec<u8> = buf.drain(..=i).collect();
                let text = String::from_utf8_lossy(&frame[..frame.len() - 1]).to_string();
                let _ = tx.send(text.clone());

                let req: serde_json::Value = serde_json::from_str(&text).unwrap();
                let path = req["path"].as_str().unwrap_or("").to_string();
                let reply = match table.get(&path) {
                    Some(v) => serde_json::json!({ "path": path, "value": v }),
                    None => serde_json::json!({
                        "error": { "code": "E12", "message": format!("Unexpected path \"{path}\"") }
                    }),
                };
                let mut out = serde_json::to_vec(&reply).unwrap();
                out.push(0x04);
                if sock.write_all(&out).is_err() {
                    return;
                }
            }
        }
    });

    (port, rx)
}

fn connect(port: u16) -> Awj {
    Awj::connect("127.0.0.1", port, Duration::from_secs(3)).unwrap()
}

#[test]
fn frames_requests_and_parses_replies() {
    let mut t = HashMap::new();
    t.insert(
        "DeviceObject/system/$device/@items/1/@props/dev".to_string(),
        serde_json::json!("NLC_C"),
    );
    let (port, _rx) = fake_device(t);
    let mut a = connect(port);

    let v = a.get("DeviceObject/system/$device/@items/1/@props/dev").unwrap();
    assert_eq!(v, serde_json::json!("NLC_C"));
}

#[test]
fn e12_becomes_none_rather_than_an_error() {
    let (port, _rx) = fake_device(HashMap::new());
    let mut a = connect(port);

    assert!(a.try_get("DeviceObject/nope").is_none());
    assert!(a.get("DeviceObject/nope").is_err());
}

#[test]
fn only_ever_sends_get() {
    // The safety claim, tested: whatever this client is asked to do, every
    // frame that reaches the device carries op "get" and nothing else.
    let mut t = HashMap::new();
    t.insert(
        "DeviceObject/system/$device/@items/1/@props/dev".to_string(),
        serde_json::json!("NLC_C"),
    );
    let (port, rx) = fake_device(t);
    let mut a = connect(port);

    a.try_get("DeviceObject/system/$device/@items/1/@props/dev");
    a.try_get("DeviceObject/system/$device/@items/1/@props/label");
    a.try_get("Subscriptions");
    let _ = crate::read::identity(&mut a);

    let mut seen = 0;
    while let Ok(line) = rx.recv_timeout(Duration::from_millis(500)) {
        let v: serde_json::Value = serde_json::from_str(&line).unwrap();
        assert_eq!(v["op"], "get", "a non-get frame reached the device: {line}");
        assert!(v.get("value").is_none(), "a frame carried a value: {line}");
        seen += 1;
    }
    assert!(seen >= 4, "expected several requests, saw {seen}");
}

#[test]
fn a_device_with_no_vpu_collection_reports_none() {
    // A simulator answers this way — and so does an Aquilon RS4 on 6.1.60.
    let (port, _rx) = fake_device(HashMap::new());
    let mut a = connect(port);
    assert!(crate::read::mapping_side(&mut a, "current", "1").is_none());
}

#[test]
fn reads_the_mixer_table_with_all_eight_pipes() {
    let base = "DeviceObject/preconfig/resources/current/status/mapping/$device/@items/1\
                /$vpuMixer/@items/PROC_1_MIXER_1";
    let mut t = HashMap::new();
    t.insert(format!("{base}/@props/isAvailable"), serde_json::json!(true));
    t.insert(format!("{base}/@props/isEnabled"), serde_json::json!(true));
    t.insert(format!("{base}/@props/usedInScreen"), serde_json::json!("S1"));
    t.insert(format!("{base}/@props/usedInLayer"), serde_json::json!("NATIVE"));
    t.insert(format!("{base}/@props/slice"), serde_json::json!(0));
    t.insert(format!("{base}/@props/capability"), serde_json::json!("4K"));
    // Interleaved, as the hardware reports: links 1 and 3, not 1 and 2.
    t.insert(format!("{base}/mixerAllocation/@props/usedOnOutPipe1"), serde_json::json!("1"));
    t.insert(format!("{base}/mixerAllocation/@props/usedOnOutPipe3"), serde_json::json!("2"));

    let (port, _rx) = fake_device(t);
    let mut a = connect(port);
    let m = crate::read::mapping_side(&mut a, "current", "1").expect("has a subtree");

    let first = &m["PROC_1_MIXER_1"];
    assert_eq!(first["isAvailable"], serde_json::json!(true));
    assert_eq!(first["usedInScreen"], serde_json::json!("S1"));

    let alloc = &first["mixerAllocation"];
    assert_eq!(alloc["usedOnOutPipe1"], serde_json::json!("1"));
    assert_eq!(alloc["usedOnOutPipe3"], serde_json::json!("2"));
    assert_eq!(alloc["usedOnOutPipe2"], serde_json::json!("NONE"), "absent pipes read NONE");
    // All eight are present, not just the first two.
    for k in 1..=8 {
        assert!(alloc.get(format!("usedOnOutPipe{k}")).is_some(), "pipe {k} missing");
    }

    // A mixer that is not fitted collapses to just isAvailable:false.
    assert_eq!(m["PROC_1_MIXER_2"], serde_json::json!({ "isAvailable": false }));
}

#[test]
fn reads_the_assigned_outputs_in_full_and_the_rest_by_name() {
    // The store's outputList in AWJ spelling — the same table test/vpu.test.js
    // serves. No Aquilon has answered these paths yet.
    let o = |n: u32| format!("DeviceObject/$output/@items/{n}");
    let mut t = HashMap::new();
    t.insert(format!("{}/canvas/status/@props/usedInScreenAux", o(1)), serde_json::json!("S1"));
    t.insert(format!("{}/canvas/status/@props/usedInRegion", o(1)), serde_json::json!("1"));
    t.insert(format!("{}/canvas/status/@props/capability", o(1)), serde_json::json!("4K"));
    t.insert(format!("{}/control/@props/label", o(1)), serde_json::json!("LED left"));
    t.insert(format!("{}/mapping/@props/card", o(1)), serde_json::json!("OUT_1"));
    t.insert(format!("{}/mapping/@props/physical", o(1)), serde_json::json!("1"));
    t.insert(format!("{}/$plug/@items/1/status/@props/type", o(1)), serde_json::json!("HDMI"));
    t.insert(format!("{}/canvas/status/@props/usedInScreenAux", o(2)), serde_json::json!("NONE"));
    t.insert(format!("{}/canvas/status/@props/usedInRegion", o(2)), serde_json::json!("1"));
    t.insert(format!("{}/canvas/status/@props/usedInScreenAux", o(3)), serde_json::json!("A1"));
    // 4 is not fitted; 5 has an empty label and no plug type.
    t.insert(format!("{}/canvas/status/@props/usedInScreenAux", o(5)), serde_json::json!("S2"));
    t.insert(format!("{}/canvas/status/@props/usedInRegion", o(5)), serde_json::json!("2"));
    t.insert(format!("{}/canvas/status/@props/capability", o(5)), serde_json::json!("DUAL"));
    t.insert(format!("{}/control/@props/label", o(5)), serde_json::json!(""));

    let (port, _rx) = fake_device(t);
    let mut a = connect(port);
    let outputs = crate::read::outputs(&mut a);

    let keys: Vec<&String> = outputs.as_object().unwrap().keys().collect();
    assert_eq!(keys, vec!["1", "2", "3", "5"], "a missing output is skipped, not the end");
    assert_eq!(
        outputs["1"],
        serde_json::json!({
            "screen": "S1", "region": "1", "capability": "4K", "label": "LED left",
            "card": "OUT_1", "physical": "1", "type": "HDMI"
        })
    );
    assert_eq!(outputs["2"], serde_json::json!({ "screen": "NONE" }), "unassigned: nothing more");
    assert_eq!(outputs["3"], serde_json::json!({ "screen": "A1" }), "an aux costs no VPU");
    assert_eq!(
        outputs["5"],
        serde_json::json!({ "screen": "S2", "region": "2", "capability": "DUAL" }),
        "blanks are left out"
    );
}

#[test]
fn unreachable_host_is_an_error_not_a_panic() {
    // Port 1 on loopback refuses immediately.
    let r = Awj::connect("127.0.0.1", 1, Duration::from_millis(500));
    assert!(r.is_err());
}

/// Reads a REAL device. Ignored by default — CI has no Aquilon — so run it by
/// hand when one is in front of you:
///
///     AQUILON_IP=192.168.1.50 cargo test -- --ignored --nocapture
///
/// Reads only, like everything else here.
#[test]
#[ignore]
fn reads_a_real_device() {
    let ip = std::env::var("AQUILON_IP").expect("set AQUILON_IP");
    let mut a = Awj::connect(&ip, 10606, Duration::from_secs(6)).expect("connect");

    let id = crate::read::identity(&mut a);
    println!("identity: {id}");
    assert!(id["dev"].is_string(), "device reported a model");

    let names = crate::read::screen_names(&mut a);
    println!("screen names: {names}");

    let status = crate::read::screen_status(&mut a, "current");
    println!("screen status: {status}");

    let m = crate::read::mapping_side(&mut a, "current", "1").expect("has a VPU map");
    let obj = m.as_object().unwrap();
    let fitted = obj.values().filter(|v| v["isAvailable"] == serde_json::json!(true)).count();
    let enabled = obj.values().filter(|v| v["isEnabled"] == serde_json::json!(true)).count();
    println!("mixers: {} fitted, {} enabled, {} slots", fitted, enabled, obj.len());
    assert_eq!(obj.len(), 64, "always 64 slots in the model");
    assert!(fitted > 0, "something is fitted");
}

/// An Aquilon RS4 on 6.1.60 in AWJ spelling, as its store read on 2026-10-16:
/// the same table `test/vpu.test.js` serves. No `$vpuMixer`, as on the box.
fn rs4_table() -> HashMap<String, serde_json::Value> {
    use serde_json::json;
    let d = "DeviceObject/system/$device/@items/1";
    let mut t = HashMap::new();
    t.insert(format!("{d}/@props/dev"), json!("NLC_RS4"));
    t.insert(format!("{d}/@props/label"), json!("AQUILON"));
    t.insert(format!("{d}/@props/isSimulated"), json!(false));
    t.insert(format!("{d}/version/@props/updater"), json!("6.1.60"));
    let screens: [(&str, &[&str]); 3] = [("S1", &["4K", "4K"]), ("S2", &["4K", "4K"]), ("S3", &["DUAL"])];
    for side in ["current", "new"] {
        for n in 1..=24 {
            let id = format!("S{n}");
            let r = format!("DeviceObject/preconfig/resources/{side}/$screen/@items/{id}");
            let layers = screens.iter().find(|(s, _)| *s == id).map(|(_, l)| *l);
            let Some(layers) = layers else {
                t.insert(format!("{r}/status/@props/mode"), json!("DISABLED"));
                continue;
            };
            t.insert(format!("{r}/status/@props/mode"), json!("FREESTYLE"));
            t.insert(format!("{r}/status/@props/layerCount"), json!(layers.len()));
            for k in std::iter::once("NATIVE".to_string()).chain((1..=256).map(|i| i.to_string())) {
                let i: usize = k.parse().unwrap_or(0);
                let c = if i >= 1 && i <= layers.len() { layers[i - 1] } else { "OFF" };
                t.insert(format!("{r}/$layer/@items/{k}/status/@props/capability"), json!(c));
            }
            if side == "new" {
                for (capa, n, m) in [("DUAL", 15, 7), ("4K", 7, 3), ("3", 0, 0), ("5K", 3, 0)] {
                    let c = format!("{r}/$layerCapability/@items/{capa}/status/@props");
                    t.insert(format!("{c}/remainingLayerCapabilities"), json!(n));
                    t.insert(format!("{c}/remainingLayerWithMaskCapabilities"), json!(m));
                }
            }
        }
    }
    t
}

#[test]
fn identity_reads_is_simulated_and_the_firmware() {
    let (port, _rx) = fake_device(rs4_table());
    let mut a = connect(port);
    assert_eq!(
        crate::read::identity(&mut a),
        serde_json::json!({
            "dev": "NLC_RS4", "label": "AQUILON", "isSimulated": false, "firmware": "6.1.60"
        })
    );
}

#[test]
fn screen_layers_reads_sizes_and_the_staged_room() {
    let (port, _rx) = fake_device(rs4_table());
    let mut a = connect(port);
    let running = crate::read::screen_status(&mut a, "current");
    let staged = crate::read::screen_status(&mut a, "new");
    assert_eq!(running.as_object().unwrap().keys().collect::<Vec<_>>(), vec!["S1", "S2", "S3"]);

    let cur = crate::read::screen_layers(&mut a, "current", &running);
    assert_eq!(
        cur["S1"],
        serde_json::json!({
            "layers": [{ "layer": "1", "capability": "4K" }, { "layer": "2", "capability": "4K" }],
            "room": []
        })
    );
    let nw = crate::read::screen_layers(&mut a, "new", &staged);
    assert_eq!(
        nw["S3"]["room"],
        serde_json::json!([
            { "capability": "DUAL", "layers": 15, "withMask": 7 },
            { "capability": "4K", "layers": 7, "withMask": 3 },
            { "capability": "5K", "layers": 3, "withMask": 0 }
        ]),
        "device order, and the always-empty `3` dropped"
    );
}

#[test]
fn no_mixer_map_is_worded_from_identity_and_matches_the_node_bridge() {
    use crate::read::no_mixer_map;
    use serde_json::json;

    let (title, hint) = no_mixer_map(
        &json!({ "dev": "NLC_RS4", "label": "AQUILON", "isSimulated": false, "firmware": "6.1.60" }),
        true,
    );
    assert_eq!(title, "This firmware does not report its VPU allocation");
    // Word for word what lib/read.js says; test/vpu.test.js pins the same opening.
    assert_eq!(
        hint,
        "AQUILON NLC_RS4 on firmware 6.1.60 answers E12 for $vpuMixer. The VPU is there; \
         firmware 6.1.x just does not say how its mixers are allocated, so there is no mixer \
         map to draw \u{2014} the tool is working. What it does report is each screen\u{2019}s \
         layer sizes and the room left, below."
    );
    assert!(!hint.to_lowercase().contains("simulat"), "a live Aquilon is not a simulator");

    let (title, hint) = no_mixer_map(
        &json!({ "dev": "NLC_CPLUS", "label": "AQUILON", "isSimulated": true, "firmware": "6.1.60" }),
        false,
    );
    assert_eq!(title, "No VPU on this simulator");
    assert!(hint.starts_with("The device says it is a simulator (AQUILON NLC_CPLUS, firmware 6.1.60)"));

    let (title, hint) = no_mixer_map(
        &json!({ "dev": "NLC_C", "label": "AQUILON", "isSimulated": false, "firmware": "6.2.73" }),
        false,
    );
    assert_eq!(title, "No VPU mixer map on this device");
    assert!(hint.contains("An Aquilon C on 6.2.73 reports one; an Aquilon RS4 on 6.1.60 does not."));

    let (title, _) = no_mixer_map(&json!({ "dev": null, "label": null }), false);
    assert_eq!(title, "No VPU mixer map reported");
}

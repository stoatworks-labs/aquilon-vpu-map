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
use std::net::{TcpListener, TcpStream};
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
    // Exactly how the LivePremier simulator behaves.
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

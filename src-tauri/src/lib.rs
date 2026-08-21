//! Aquilon VPU Map — desktop app.
//!
//! Same UI as the server build; the difference is only how it reaches the
//! device. Here Rust makes the AWJ connection and `read_vpu` returns exactly
//! the JSON shape the Node bridge's `/api/vpu` returns, so `public/app.js`
//! renders either without caring which it got.
//!
//! Reads only. See `awj.rs` — there is one write to the socket and it is a
//! hard-coded `get`.

mod awj;
mod read;

#[cfg(test)]
mod tests;

use serde_json::{json, Value};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const AWJ_PORT: u16 = 10606;
const TIMEOUT: Duration = Duration::from_secs(6);

fn now_iso() -> String {
    // No chrono: a whole date-time crate for one timestamp is not worth it, and
    // the UI only ever formats this through Date().
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86_400;
    let rem = secs % 86_400;
    let (mut y, mut d) = (1970i64, days as i64);
    loop {
        let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
        let len = if leap { 366 } else { 365 };
        if d < len { break; }
        d -= len;
        y += 1;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let months = [31, if leap {29} else {28}, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    let mut m = 0usize;
    while d >= months[m] { d -= months[m]; m += 1; }
    format!(
        "{y:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        m + 1, d + 1, rem / 3600, (rem % 3600) / 60, rem % 60
    )
}

/// Reject anything that is not a plain host or IP before it reaches connect().
fn valid_host(h: &str) -> bool {
    !h.is_empty()
        && h.len() <= 253
        && h.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_')
}

#[tauri::command]
async fn read_vpu(ip: String, device: String) -> Result<Value, String> {
    if !valid_host(&ip) {
        return Err("invalid ip or hostname".into());
    }
    if !matches!(device.as_str(), "1" | "2" | "3" | "4") {
        return Err("device must be 1-4".into());
    }

    // The read is blocking sockets; keep it off the UI thread.
    tauri::async_runtime::spawn_blocking(move || {
        let started = Instant::now();
        let mut a = awj::Awj::connect(&ip, AWJ_PORT, TIMEOUT).map_err(|e| e.to_string())?;

        let identity = read::identity(&mut a);
        let screens = read::screen_names(&mut a);
        let screen_status = json!({
            "current": read::screen_status(&mut a, "current"),
            "new": read::screen_status(&mut a, "new"),
        });

        let current = match read::mapping_side(&mut a, "current", &device) {
            Some(v) => v,
            None => {
                return Ok(json!({
                    "ok": false,
                    "code": "NO_VPU_SUBTREE",
                    "error": "no $vpuMixer collection under the current mapping",
                    "source": { "kind": "device", "host": ip, "port": AWJ_PORT, "device": device },
                    "hint": "Reached the device, but it exposes no $vpuMixer collection. \
                             The LivePremier simulator behaves this way — it has no \
                             processor boards to map."
                }))
            }
        };
        let staged = read::mapping_side(&mut a, "new", &device);

        Ok(json!({
            "ok": true,
            "mode": "live",
            "source": {
                "kind": "device", "host": ip, "port": AWJ_PORT, "device": device,
                "dev": identity.get("dev"), "label": identity.get("label"),
            },
            "capturedAt": now_iso(),
            "elapsedMs": started.elapsed().as_millis() as u64,
            "screens": screens,
            "screenStatus": screen_status,
            "current": current,
            "new": staged,
        }))
    })
    .await
    .map_err(|e| format!("read task failed: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![read_vpu])
        .run(tauri::generate_context!())
        .expect("error while running aquilon-vpu-map");
}

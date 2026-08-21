//! Minimal AWJ client — the desktop app's equivalent of `lib/awj.js`.
//!
//! AWJ: TCP 10606, one JSON object per message, terminated by the byte 0x04.
//! Exactly one `op`, and this client only ever sends `get`.
//!
//! GET-ONLY BY CONSTRUCTION. There is one function that writes to the socket
//! and it builds `{"op":"get",…}` from a literal. Nothing here can emit a
//! write, and nothing should be added that can — see AGENTS.md.

use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

const EOT: u8 = 0x04;

pub struct Awj {
    stream: TcpStream,
    buf: Vec<u8>,
}

#[derive(Debug)]
pub enum AwjError {
    Connect(String),
    Io(String),
    /// The device answered, but with an error code — `E12` means "no such path".
    Device(String),
}

impl std::fmt::Display for AwjError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AwjError::Connect(m) => write!(f, "{m}"),
            AwjError::Io(m) => write!(f, "{m}"),
            AwjError::Device(c) => write!(f, "device error {c}"),
        }
    }
}

impl Awj {
    pub fn connect(host: &str, port: u16, timeout: Duration) -> Result<Self, AwjError> {
        let addr = (host, port)
            .to_socket_addrs()
            .map_err(|e| AwjError::Connect(format!("cannot resolve {host}: {e}")))?
            .next()
            .ok_or_else(|| AwjError::Connect(format!("cannot resolve {host}")))?;

        let stream = TcpStream::connect_timeout(&addr, timeout)
            .map_err(|e| AwjError::Connect(format!("cannot reach {host}:{port} — {e}")))?;
        stream.set_read_timeout(Some(timeout)).ok();
        stream.set_write_timeout(Some(timeout)).ok();
        stream.set_nodelay(true).ok();

        Ok(Self { stream, buf: Vec::new() })
    }

    /// Send one `get` and read its reply. The only write on this socket.
    pub fn get(&mut self, path: &str) -> Result<serde_json::Value, AwjError> {
        let req = serde_json::json!({ "op": "get", "path": path });
        let mut bytes = serde_json::to_vec(&req).map_err(|e| AwjError::Io(e.to_string()))?;
        bytes.push(EOT);
        self.stream
            .write_all(&bytes)
            .map_err(|e| AwjError::Io(format!("write failed: {e}")))?;

        let frame = self.read_frame()?;
        let msg: serde_json::Value =
            serde_json::from_slice(&frame).map_err(|e| AwjError::Io(format!("bad frame: {e}")))?;

        if let Some(err) = msg.get("error") {
            let code = err
                .get("code")
                .and_then(|c| c.as_str())
                .unwrap_or("UNKNOWN")
                .to_string();
            return Err(AwjError::Device(code));
        }
        Ok(msg.get("value").cloned().unwrap_or(serde_json::Value::Null))
    }

    /// `get` that yields `None` for a path the device does not have (E12),
    /// mirroring `tryGet` on the JavaScript side.
    pub fn try_get(&mut self, path: &str) -> Option<serde_json::Value> {
        match self.get(path) {
            Ok(v) => Some(v),
            Err(_) => None,
        }
    }

    fn read_frame(&mut self) -> Result<Vec<u8>, AwjError> {
        loop {
            if let Some(i) = self.buf.iter().position(|&b| b == EOT) {
                let frame: Vec<u8> = self.buf.drain(..=i).collect();
                return Ok(frame[..frame.len() - 1].to_vec());
            }
            let mut chunk = [0u8; 8192];
            let n = self
                .stream
                .read(&mut chunk)
                .map_err(|e| AwjError::Io(format!("read failed: {e}")))?;
            if n == 0 {
                return Err(AwjError::Io("connection closed by device".into()));
            }
            self.buf.extend_from_slice(&chunk[..n]);
        }
    }
}

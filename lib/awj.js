// Minimal AWJ client for Analog Way LivePremier / Alta 4K / Midra 4K.
//
// Wire format: TCP 10606, one JSON object per message, terminated by ASCII 0x04
// (not a newline). Exactly one `op`, only ever `get` or `replace`.
//
// This client is deliberately GET-ONLY. Every property this tool reads is
// declared readOnly in the device's own model, so there is nothing here that
// can change device state — see AGENTS.md.

import net from 'node:net';

const EOT = 0x04;
const EOT_STR = '\x04';

export class AwjError extends Error {
  constructor(code, message, path) {
    super(message || `AWJ error ${code}`);
    this.name = 'AwjError';
    this.code = code;
    this.path = path;
  }
}

export class AwjClient {
  /**
   * @param {object} opts
   * @param {string} opts.host
   * @param {number} [opts.port=10606]
   * @param {number} [opts.timeout=5000]  per-request timeout, ms
   */
  constructor({ host, port = 10606, timeout = 5000 }) {
    this.host = host;
    this.port = port;
    this.timeout = timeout;
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.queue = [];
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port });
      sock.setNoDelay(true);

      const onFail = (err) => {
        sock.destroy();
        reject(err);
      };
      const connectTimer = setTimeout(
        () => onFail(new Error(`timed out connecting to ${this.host}:${this.port}`)),
        this.timeout,
      );

      sock.once('connect', () => {
        clearTimeout(connectTimer);
        sock.removeListener('error', onFail);
        this.socket = sock;

        sock.on('data', (chunk) => this._onData(chunk));
        sock.on('error', (err) => this._failAll(err));
        sock.on('close', () => {
          this.closed = true;
          this._failAll(new Error('connection closed by device'));
        });

        resolve(this);
      });
      sock.once('error', onFail);
    });
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    let idx;
    while ((idx = this.buf.indexOf(EOT)) !== -1) {
      const raw = this.buf.subarray(0, idx).toString('utf8');
      this.buf = this.buf.subarray(idx + 1);
      const waiter = this.queue.shift();
      if (!waiter) continue; // unsolicited push; this tool does not subscribe
      clearTimeout(waiter.timer);
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        waiter.reject(new Error(`unparseable AWJ frame: ${raw.slice(0, 120)}`));
        continue;
      }
      if (msg.error) {
        waiter.reject(new AwjError(msg.error.code, msg.error.message, waiter.path));
      } else {
        waiter.resolve(msg.value);
      }
    }
  }

  _failAll(err) {
    const q = this.queue;
    this.queue = [];
    for (const w of q) {
      clearTimeout(w.timer);
      w.reject(err);
    }
  }

  /**
   * Read one leaf. Containers legitimately resolve to {} — AWJ cannot enumerate.
   * @param {string} path
   */
  get(path) {
    if (!this.socket || this.closed) return Promise.reject(new Error('not connected'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.queue.findIndex((w) => w.timer === timer);
        if (i !== -1) this.queue.splice(i, 1);
        reject(new Error(`timed out reading ${path}`));
      }, this.timeout);

      this.queue.push({ resolve, reject, timer, path });
      this.socket.write(JSON.stringify({ op: 'get', path }) + EOT_STR);
    });
  }

  /** get() that resolves to `undefined` instead of throwing on E12 (path absent). */
  async tryGet(path) {
    try {
      return await this.get(path);
    } catch (err) {
      if (err instanceof AwjError && err.code === 'E12') return undefined;
      throw err;
    }
  }

  close() {
    this.closed = true;
    if (this.socket) this.socket.destroy();
    this.socket = null;
  }
}

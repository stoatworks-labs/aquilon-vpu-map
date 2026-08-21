#!/usr/bin/env node
//
// Aquilon VPU Map — static server + AWJ bridge.
//
// The bridge exists because AWJ is a raw TCP protocol on port 10606, and a
// browser tab cannot open a TCP socket. This process does that on the page's
// behalf and hands back JSON. It issues `get` only.

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AwjClient } from './lib/awj.js';
import { readMapping, readIdentity, readScreenNames } from './lib/read.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');
const DATA = path.join(HERE, 'data');

const PORT = Number(process.env.PORT || 8531);
const HOST = process.env.HOST || '0.0.0.0';
const DEFAULT_DEVICE_IP = process.env.AQUILON_IP || '192.168.2.140';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
  });
  res.end(buf);
}

/** Reject anything that is not a plain host or IP before it reaches net.connect. */
function validHost(h) {
  return typeof h === 'string' && /^[A-Za-z0-9._-]{1,253}$/.test(h);
}

async function handleRead(req, res, url) {
  const host = url.searchParams.get('ip') || DEFAULT_DEVICE_IP;
  const device = url.searchParams.get('device') || '1';
  const port = Number(url.searchParams.get('port') || 10606);

  if (!validHost(host)) return sendJson(res, 400, { error: 'invalid ip or hostname' });
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return sendJson(res, 400, { error: 'invalid port' });
  }
  if (!/^[1-4]$/.test(String(device))) {
    return sendJson(res, 400, { error: 'device must be 1-4' });
  }

  const client = new AwjClient({ host, port, timeout: 5000 });
  const started = Date.now();
  try {
    await client.connect();
    const identity = await readIdentity(client);
    // The operator's screen names, so the views read as "Main LED" not "S1".
    const screens = await readScreenNames(client);
    const current = await readMapping(client, { which: 'current', device });

    // The staged mapping is the same size again; only read it if it exists.
    let next = null;
    try {
      next = await readMapping(client, { which: 'new', device });
    } catch (err) {
      if (err.code !== 'NO_VPU_SUBTREE') throw err;
    }

    sendJson(res, 200, {
      ok: true,
      mode: 'live',
      source: { kind: 'device', host, port, device, ...identity },
      capturedAt: new Date().toISOString(),
      elapsedMs: Date.now() - started,
      screens,
      current,
      new: next,
    });
  } catch (err) {
    const code = err.code === 'NO_VPU_SUBTREE' ? 'NO_VPU_SUBTREE' : err.code || 'READ_FAILED';
    const status = code === 'NO_VPU_SUBTREE' ? 200 : 502;
    sendJson(res, status, {
      ok: false,
      code,
      error: String(err.message || err),
      source: { kind: 'device', host, port, device },
      hint:
        code === 'NO_VPU_SUBTREE'
          ? 'Reached the device, but it exposes no $vpuMixer collection. The LivePremier simulator behaves this way — it has no processor boards to map.'
          : undefined,
    });
  } finally {
    client.close();
  }
}

async function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';

  // Recorded snapshots are served from data/, everything else from public/.
  const root = rel.startsWith('/data/') ? DATA : PUBLIC;
  if (root === DATA) rel = rel.slice('/data'.length);

  const full = path.join(root, rel);
  if (!full.startsWith(root)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const buf = await fs.readFile(full);
    res.writeHead(200, {
      'content-type': MIME[path.extname(full)] || 'application/octet-stream',
      'content-length': buf.length,
      'cache-control': 'no-cache',
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (url.pathname === '/api/config') {
    return sendJson(res, 200, { defaultIp: DEFAULT_DEVICE_IP });
  }
  if (url.pathname === '/api/vpu') {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'GET only' });
    return handleRead(req, res, url);
  }
  if (url.pathname === '/api/health') {
    return sendJson(res, 200, { ok: true });
  }
  return serveStatic(req, res, url);
});

server.listen(PORT, HOST, () => {
  console.log(`Aquilon VPU Map on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  console.log(`Default device: ${DEFAULT_DEVICE_IP}:10606 (AWJ, reads only)`);
});

#!/usr/bin/env node
//
// Stage the frontend for the desktop build.
//
// The server build serves `public/` at the root and `data/` at `/data`. Tauri
// serves one directory, so assemble that shape here rather than duplicating any
// file in the repo: public/ becomes the root, data/ becomes data/.
//
// Run by tauri.conf.json's beforeBuildCommand — not something to run by hand.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'dist-frontend');

await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
await fs.cp(path.join(root, 'public'), out, { recursive: true });
await fs.cp(path.join(root, 'data'), path.join(out, 'data'), { recursive: true });

const files = await fs.readdir(out);
console.log(`staged dist-frontend/ (${files.length} entries, plus data/)`);

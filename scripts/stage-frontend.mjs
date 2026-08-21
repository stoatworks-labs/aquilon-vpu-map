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

// Strip the funding footer from packaged builds.
//
// It belongs on the hosted page, where someone found the tool for free and
// might choose to chip in. Inside an installed app it is wrong twice over: the
// buttons are external payment links, which App Store guideline 3.1.1 does not
// allow, and a donation bar at the bottom of a tool someone already installed
// is not the same offer the web page makes.
//
// This is only reachable from a Tauri build. server.js serves public/ and
// data/ directly and never looks at dist-frontend, so the hosted page keeps
// its footer and nothing here can affect it.
await fs.rm(path.join(out, 'support-footer.js'), { force: true });

const indexPath = path.join(out, 'index.html');
const before = await fs.readFile(indexPath, 'utf8');
// Matches the whole element including its data-* attributes and any newlines
// between them. Anchored to the src so a future <script> cannot be caught.
const after = before.replace(
  /\n?[^\n]*<script\s+src="\.\/support-footer\.js"[\s\S]*?><\/script>/,
  '',
);
if (after === before) {
  // Fail loudly. A silent no-op here shows up as a donation bar inside a
  // shipped app, which is exactly the thing this is here to prevent.
  throw new Error(
    'stage-frontend: could not find the support-footer script tag in index.html. ' +
      'If it was renamed or removed, update this script to match.',
  );
}
await fs.writeFile(indexPath, after);

const files = await fs.readdir(out);
console.log(`staged dist-frontend/ (${files.length} entries, plus data/) — support footer stripped`);

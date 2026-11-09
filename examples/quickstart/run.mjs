#!/usr/bin/env node
// One-command setup check: serves ./site on a free local port, records scenes.json, builds report.json.
//
//   node examples/quickstart/run.mjs                    video + report in examples/quickstart/out/
//   node examples/quickstart/run.mjs --engine none      silent video (no voice)
//   node examples/quickstart/run.mjs --voice Daniel     another installed macOS voice
//   node examples/quickstart/run.mjs --plan             voice clips and timing only, no recording
//
// Any flag is passed on to scripts/record.mjs.
import { spawn, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.resolve(HERE, '../../scripts');
const SITE = path.join(HERE, 'site');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg' };

const server = http.createServer(async (req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.join(SITE, p.endsWith('/') ? `${p}index.html` : p);
  if (!file.startsWith(SITE)) { res.writeHead(403).end(); return; }
  try { const body = await readFile(file); res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }).end(body); }
  catch { res.writeHead(404).end('not found'); }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
console.log(`serving ${SITE} at ${base}\n`);

const extra = process.argv.slice(2);
// The recorder runs while this process keeps serving: spawnSync would block the event loop, so use a promise.
const run = (args) => new Promise((resolve) => spawn(process.execPath, args, { stdio: 'inherit' }).on('exit', (code) => resolve(code ?? 1)));
let code = await run([path.join(SCRIPTS, 'record.mjs'), path.join(HERE, 'scenes.json'), '--base', base, ...extra]);
server.close();
if (code === 0 && !extra.includes('--plan')) {
  code = spawnSync(process.execPath, [path.join(SCRIPTS, 'report.mjs'), path.join(HERE, 'report.json')], { stdio: 'inherit' }).status ?? 1;
  if (code === 0) console.log(`\nDone. Open the report:\n  open ${path.join(HERE, 'out', 'report.html')}`);
}
process.exit(code);

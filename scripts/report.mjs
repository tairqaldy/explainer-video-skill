#!/usr/bin/env node
// One self-contained HTML report: the video, its chapters, screenshots and free-form sections. Zero dependencies.
//
//   node scripts/report.mjs <report.json | report.mjs> [--out report.html] [--no-embed]
//
// The video, poster and screenshots are embedded as data URIs, so the report is one file you can send or attach
// (keep the video under ~12 MB). With --no-embed (or "embed": false) they are linked by relative path instead.
// Paths in the config are relative to the config file. Config:
// {
//   "title": "…", "subtitle": "…", "lang": "en", "output": "out/report.html",
//   "meta": ["Project", "2026-11-09"],                 small line above the title
//   "badge": { "text": "Ready", "tone": "ok" },        tone: ok | warn | info
//   "video": { "src": "out/demo.mp4", "poster": "out/demo-poster.jpg", "caption": "…", "chapters": true },
//   "sections": [
//     { "heading": "What changed", "md": "Text with **bold**, `code`, [links](https://…) and\n\n- bullet lists" },
//     { "heading": "Screenshots", "stills": [{ "src": "out/stills/board.jpg", "caption": "…" }] },   or "stills": "out/stills"
//     { "heading": "Checks", "checks": ["Tests pass", "…"] },
//     { "heading": "Heads-up", "md": "…", "tone": "warn" },
//     { "heading": "Anything else", "html": "<table>…</table>" }
//   ]
// }
// "chapters": true reads <video>.timeline.json (written by record.mjs) and lists the scenes as clickable timestamps.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const CONFIG = argv.find((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out');

const MIME = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const clock = (ms) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/** A small, safe Markdown subset: paragraphs, ### headings, - and 1. lists, **bold**, *italic*, `code`, [links](url). */
function md(src) {
  const inline = (t) => esc(t)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, text, href) => {
      const h = href.replace(/&amp;/g, '&');
      return /^(https?:|mailto:|#|\.{0,2}\/|[\w-]+\.[\w-]+)/i.test(h) && !/^javascript:/i.test(h) ? `<a href="${esc(h)}">${text}</a>` : m;
    });
  return String(src).trim().split(/\n\s*\n/).map((block) => {
    const lines = block.split('\n');
    if (/^#{1,4}\s/.test(lines[0]) && lines.length === 1) return `<h3>${inline(lines[0].replace(/^#+\s*/, ''))}</h3>`;
    if (lines.every((l) => /^\s*[-*]\s+/.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
    if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s+/, ''))}</li>`).join('')}</ol>`;
    return `<p>${inline(lines.join(' '))}</p>`;
  }).join('\n');
}

async function main() {
  if (!CONFIG) throw new Error('usage: node scripts/report.mjs <report.json | report.mjs> [--out report.html] [--no-embed]');
  const abs = path.resolve(CONFIG), dir = path.dirname(abs);
  let cfg = /\.(mjs|js)$/.test(abs) ? (await import(pathToFileURL(abs).href)).default : JSON.parse(readFileSync(abs, 'utf8'));
  if (typeof cfg === 'function') cfg = await cfg();
  const out = path.resolve(dir, opt('out') || cfg.output || 'out/report.html');
  const embed = !has('no-embed') && cfg.embed !== false;
  let bytes = 0;
  const src = (p) => {
    const file = path.resolve(dir, p);
    if (!existsSync(file)) throw new Error(`missing file: ${file}`);
    if (!embed) return esc(path.relative(path.dirname(out), file).split(path.sep).join('/'));
    const buf = readFileSync(file); bytes += buf.length;
    return `data:${MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'};base64,${buf.toString('base64')}`;
  };

  const parts = [];
  if (cfg.video) {
    const v = typeof cfg.video === 'string' ? { src: cfg.video } : cfg.video;
    const file = path.resolve(dir, v.src);
    const tl = path.join(path.dirname(file), `${path.basename(file, path.extname(file))}.timeline.json`);
    const timeline = existsSync(tl) ? JSON.parse(readFileSync(tl, 'utf8')) : null;
    const poster = v.poster || (timeline?.poster && existsSync(path.join(path.dirname(file), timeline.poster)) ? path.relative(dir, path.join(path.dirname(file), timeline.poster)) : null);
    const secs = timeline ? Math.round(timeline.duration_ms / 1000) : null;
    let chapters = '';
    if (v.chapters && timeline) {
      chapters = `<ol class="chapters">${timeline.scenes.map((s) => `<li><button type="button" data-t="${s.start / 1000}"><span>${clock(s.start)}</span>${esc(s.caps?.[0] || s.name)}</button></li>`).join('')}</ol>`;
    }
    parts.push(`<section class="card video">
    ${v.heading !== false ? `<h2>${esc(v.heading || `Video${secs ? ` · ${secs} s` : ''}${timeline?.voice ? ', narrated with subtitles' : ''}`)}</h2>` : ''}
    <video controls playsinline preload="metadata"${poster ? ` poster="${src(poster)}"` : ''} src="${src(v.src)}"></video>
    ${v.caption ? `<p class="note">${md(v.caption).replace(/^<p>|<\/p>$/g, '')}</p>` : ''}
    ${chapters}
  </section>`);
  }
  for (const s of cfg.sections || []) {
    let body = '';
    if (s.md) body += md(s.md);
    if (s.html) body += s.html;
    if (s.checks) body += `<ul class="checks">${s.checks.map((c) => `<li><i aria-hidden="true">✓</i><span>${md(c).replace(/^<p>|<\/p>$/g, '')}</span></li>`).join('')}</ul>`;
    if (s.stills) {
      let list = s.stills;
      if (typeof list === 'string') {
        const d = path.resolve(dir, list);
        list = readdirSync(d).filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).sort().map((f) => ({ src: path.relative(dir, path.join(d, f)), caption: '' }));
      }
      body += `<div class="shots">${list.map((x) => {
        const it = typeof x === 'string' ? { src: x } : x;
        return `<figure><button type="button" class="zoom" aria-label="Open full size"><img src="${src(it.src)}" alt="${esc(it.alt || it.caption || '')}" loading="lazy"></button>${it.caption ? `<figcaption>${md(it.caption).replace(/^<p>|<\/p>$/g, '')}</figcaption>` : ''}</figure>`;
      }).join('')}</div>`;
    }
    parts.push(`<section class="card${s.tone ? ` tone-${esc(s.tone)}` : ''}">${s.heading ? `<h2>${esc(s.heading)}</h2>` : ''}\n${body}</section>`);
  }

  const badge = cfg.badge ? (typeof cfg.badge === 'string' ? { text: cfg.badge } : cfg.badge) : null;
  const meta = [...(cfg.meta || [])].map(esc).join(' · ');
  const html = `<!doctype html>
<html lang="${esc(cfg.lang || 'en')}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(cfg.title || 'Report')}</title>
<style>
:root{--bg:#f4f6f8;--card:#fff;--fg:#11161c;--muted:#5d6672;--line:#e3e7ec;--soft:#f4f6f8;--accent:${cfg.accent || '#2563eb'};
--ok:#15803d;--ok-bg:#e7f6ec;--warn:#8a4b05;--warn-bg:#fff6e5;--warn-line:#f1c26a;--info:#1d4ed8;--info-bg:#e9f0ff}
@media (prefers-color-scheme:dark){:root{--bg:#0d1116;--card:#151b22;--fg:#e8edf2;--muted:#9aa5b1;--line:#26303b;--soft:#1b232c;
--ok:#4ade80;--ok-bg:#12301f;--warn:#fbbf24;--warn-bg:#2d2412;--warn-line:#6b5016;--info:#93b4ff;--info-bg:#17233d}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15.5px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif}
main{max-width:900px;margin:0 auto;padding:36px 16px 56px}
.top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;color:var(--muted);font-size:13px}
.pill{display:inline-flex;padding:3px 10px;border-radius:999px;font-weight:600;font-size:12.5px;background:var(--soft);color:var(--muted)}
.pill.ok{background:var(--ok-bg);color:var(--ok)}.pill.warn{background:var(--warn-bg);color:var(--warn)}.pill.info{background:var(--info-bg);color:var(--info)}
h1{font-size:30px;line-height:1.2;margin:10px 0 6px;letter-spacing:-.015em;text-wrap:balance}
.lead{font-size:17px;margin:0 0 18px;color:var(--muted);text-wrap:pretty}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px 20px;margin:14px 0}
.card>h2{font-size:12.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted);margin:0 0 12px}
.card p{margin:0 0 10px}.card p:last-child{margin-bottom:0}
.card h3{font-size:16px;margin:16px 0 6px}
.tone-warn{background:var(--warn-bg);border-color:var(--warn-line)}.tone-warn>h2{color:var(--warn)}
.tone-info{background:var(--info-bg);border-color:transparent}.tone-info>h2{color:var(--info)}
.tone-ok{background:var(--ok-bg);border-color:transparent}.tone-ok>h2{color:var(--ok)}
a{color:var(--accent)}
code{font:13px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--soft);border:1px solid var(--line);padding:1px 5px;border-radius:5px}
ul,ol{margin:0 0 10px;padding-left:22px}li{margin:4px 0}
table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;vertical-align:top;padding:7px 8px;border-bottom:1px solid var(--line)}
th{color:var(--muted);font-weight:600;font-size:12.5px}
video{width:100%;display:block;border-radius:10px;background:#000;aspect-ratio:16/10}
.note{margin:10px 0 0;color:var(--muted);font-size:14px}
.chapters{list-style:none;padding:0;margin:12px 0 0;display:grid;gap:2px}
.chapters button{all:unset;cursor:pointer;display:flex;gap:12px;width:100%;box-sizing:border-box;padding:6px 8px;border-radius:8px;font-size:14px}
.chapters button:hover,.chapters button:focus-visible{background:var(--soft)}
.chapters span{font-variant-numeric:tabular-nums;color:var(--accent);font-weight:600;min-width:2.6em}
.checks{list-style:none;padding:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px 20px}
.checks li{display:flex;gap:8px;margin:0}.checks i{font-style:normal;color:var(--ok);font-weight:700}
.shots{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}
figure{margin:0}.zoom{all:unset;cursor:zoom-in;display:block}
figure img{width:100%;display:block;border-radius:10px;border:1px solid var(--line)}
figcaption{color:var(--muted);font-size:13.5px;margin-top:6px}
dialog{border:0;padding:0;background:transparent;max-width:96vw;max-height:94vh}dialog::backdrop{background:rgba(5,8,12,.82)}
dialog img{display:block;max-width:96vw;max-height:94vh;border-radius:8px;cursor:zoom-out}
@media (max-width:640px){.shots,.checks{grid-template-columns:1fr}h1{font-size:24px}}
@media print{body{background:#fff}.card{break-inside:avoid}video,.chapters{display:none}}
</style>
</head>
<body>
<main>
  ${meta || badge ? `<div class="top">${meta ? `<span>${meta}</span>` : ''}${badge ? `<span class="pill ${esc(badge.tone || '')}">${esc(badge.text)}</span>` : ''}</div>` : ''}
  <h1>${esc(cfg.title || 'Report')}</h1>
  ${cfg.subtitle ? `<p class="lead">${md(cfg.subtitle).replace(/^<p>|<\/p>$/g, '')}</p>` : ''}
  ${parts.join('\n  ')}
</main>
<dialog id="lightbox"><img alt=""></dialog>
<script>
const v = document.querySelector('video');
document.querySelectorAll('.chapters button').forEach((b) => b.addEventListener('click', () => { v.currentTime = +b.dataset.t; v.play(); v.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }));
const box = document.getElementById('lightbox');
document.querySelectorAll('.zoom').forEach((b) => b.addEventListener('click', () => { box.querySelector('img').src = b.querySelector('img').src; box.showModal(); }));
box.addEventListener('click', () => box.close());
</script>
</body>
</html>
`;
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, html);
  const mb = statSync(out).size / 1e6;
  console.log(`${out}  ${mb.toFixed(1)} MB${embed ? ` (${(bytes / 1e6).toFixed(1)} MB of media embedded)` : ' (media linked, keep the files next to it)'}`);
  if (mb > 30) console.warn('! the report is over 30 MB: lower "maxMb" in the scenes file or use --no-embed');
}

main().catch((e) => { console.error(`report.mjs: ${e.message}`); process.exit(1); });

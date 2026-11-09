#!/usr/bin/env node
// Narrated, subtitled screen recording of a web app, driven by a scenes file. Zero npm dependencies:
// Node 22 (built-in fetch + WebSocket), Google Chrome, /usr/bin/swift (AVFoundation), macOS `say`.
//
//   node scripts/record.mjs <scenes.json | scenes.mjs> [flags]
//
// 1. Makes one voice clip per scene (macOS `say`, offline; or OpenAI TTS with --engine openai and OPENAI_API_KEY).
// 2. Opens headless Chrome over the DevTools Protocol, injects a visible cursor with a click ripple and plays each
//    scene's actions (goto, click, hover, type, scroll, waitFor, still, zoom, …), grabbing frames with
//    Page.startScreencast. Page loads are cut from the video.
// 3. Fits every scene to its voice clip: a short scene holds its last frame, a long one plays faster.
// 4. encode.swift writes H.264 with the subtitles burned in, mux.swift adds the voice track (AAC) under --max-mb,
//    frames.swift saves one check frame per scene and prints the audio level.
//
// Output (next to the scenes file unless the config says otherwise):
//   out/demo.mp4, out/demo-poster.jpg, out/demo.timeline.json, out/stills/*.jpg, out/check/*.jpg
//
// Flags:
//   --base <url>       base URL (overrides "baseUrl")
//   --out <file.mp4>   output file (overrides "output")
//   --engine <e>       say | openai | none (overrides "voice.engine")
//   --voice <name>     voice name (overrides "voice.name"), e.g. Samantha, Milena, or an OpenAI voice like alloy
//   --plan             make the voice clips and print the timing plan, do not record
//   --show             show the Chrome window instead of running headless (debugging)
//   --keep             keep the raw frames and the voice track (the path is printed)
//   --no-check         skip the check frames
//   --no-cache         do not reuse cached voice clips
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined; };
const CONFIG = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--') && ['base', 'out', 'engine', 'voice'].includes(argv[i - 1].slice(2))));
const SWIFT = existsSync('/usr/bin/swift') ? '/usr/bin/swift' : 'swift';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const sec = (ms) => `${(ms / 1000).toFixed(1)} s`;
const readMs = (caps) => Math.max(1800, 600 + caps.join(' ').length * 55); // silent video: time to read the subtitles
let seed = 7;
const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const ACTIONS = ['goto', 'click', 'hover', 'glide', 'type', 'press', 'scroll', 'waitFor', 'wait', 'still', 'zoom', 'card', 'js'];
/** The action's verb. "waitFor" is also an option of goto, click and press, so it is the verb only when it stands alone. */
function kindOf(a) {
  const keys = Object.keys(a || {}).filter((k) => ACTIONS.includes(k));
  const main = keys.filter((k) => k !== 'waitFor');
  return main.length === 1 ? main[0] : main.length === 0 && keys.length === 1 ? 'waitFor' : null;
}

/* ── config ────────────────────────────────────────────────────────────────────────────────────────── */
async function loadConfig(file) {
  if (!file) throw new Error('usage: node scripts/record.mjs <scenes.json | scenes.mjs> [--base url] [--out file.mp4] [--plan]');
  const abs = path.resolve(file);
  if (!existsSync(abs)) throw new Error(`no such file: ${abs}`);
  let cfg;
  if (/\.(mjs|js)$/.test(abs)) { cfg = (await import(pathToFileURL(abs).href)).default; if (typeof cfg === 'function') cfg = await cfg(); }
  else { try { cfg = JSON.parse(readFileSync(abs, 'utf8')); } catch (e) { throw new Error(`${file}: not valid JSON (${e.message})`); } }
  if (!cfg || typeof cfg !== 'object') throw new Error(`${file}: the config must be an object`);
  return { cfg, dir: path.dirname(abs) };
}
/** "${NAME}" → process.env.NAME, so tokens stay in the environment and never in the scenes file. */
function expand(v, where) {
  if (typeof v !== 'string') return v;
  return v.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, n) => {
    if (process.env[n] === undefined) throw new Error(`${where}: environment variable ${n} is not set`);
    return process.env[n];
  });
}
function settings(cfg, dir) {
  const lang = cfg.lang || 'en';
  const v = cfg.voice || {};
  const engine = opt('engine') || v.engine || 'say';
  if (!['say', 'openai', 'none'].includes(engine)) throw new Error(`voice.engine must be say, openai or none (got ${engine})`);
  const output = path.resolve(dir, opt('out') || cfg.output || 'out/demo.mp4');
  const outDir = path.dirname(output), base = path.basename(output, path.extname(output));
  const baseUrl = expand(opt('base') || cfg.baseUrl || 'http://localhost:3000', 'baseUrl').replace(/\/$/, '');
  return {
    baseUrl, lang, output, outDir, base,
    stills: path.resolve(dir, cfg.stills || path.join(outDir, 'stills')),
    poster: path.join(outDir, `${base}-poster.jpg`),
    timeline: path.join(outDir, `${base}.timeline.json`),
    check: path.join(outDir, 'check'),
    W: cfg.viewport?.width || 1440, H: cfg.viewport?.height || 900, fps: cfg.fps || 24, maxMb: cfg.maxMb || 12,
    lead: cfg.timing?.lead ?? 300, tail: cfg.timing?.tail ?? 600, cutLoads: cfg.cutLoads ?? true,
    color: cfg.cursor?.color || '#2563eb',
    voice: {
      engine,
      name: opt('voice') || v.name || (engine === 'openai' ? 'alloy' : lang.startsWith('ru') ? 'Milena' : lang.startsWith('en') ? 'Samantha' : ''),
      rate: v.rate || 180, model: v.model || 'gpt-4o-mini-tts', speed: v.speed || 1, instructions: v.instructions || '',
    },
    auth: cfg.auth || {},
  };
}
function validate(cfg) {
  const scenes = cfg.scenes;
  if (!Array.isArray(scenes) || !scenes.length) throw new Error('"scenes" must be a non-empty array');
  return scenes.map((s, i) => {
    const name = s.name || `scene-${i + 1}`;
    if (!Array.isArray(s.actions)) throw new Error(`scene ${name}: "actions" must be an array`);
    s.actions.forEach((a, j) => {
      if (!kindOf(a)) throw new Error(`scene ${name}, action ${j + 1}: needs exactly one of ${ACTIONS.join(', ')} (got ${JSON.stringify(a)})`);
    });
    const caps = Array.isArray(s.caps) ? s.caps : typeof s.caps === 'string' ? [s.caps]
      : (s.say || '').split(/(?<=[.!?…])\s+/).map((x) => x.trim()).filter(Boolean);
    return { ...s, name, caps, say: s.say || '', hold: s.hold || 0 };
  });
}

/* ── voice ─────────────────────────────────────────────────────────────────────────────────────────── */
function wavInfo(buf) {
  let o = 12, fmt = null, data = null;
  while (o + 8 <= buf.length) {
    const id = buf.toString('ascii', o, o + 4), size = buf.readUInt32LE(o + 4);
    if (id === 'fmt ') fmt = { rate: buf.readUInt32LE(o + 12), ch: buf.readUInt16LE(o + 10), bits: buf.readUInt16LE(o + 22) };
    if (id === 'data') data = buf.subarray(o + 8, Math.min(buf.length, o + 8 + size));
    o += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('not a PCM WAV file');
  return { ...fmt, data, ms: (data.length / (fmt.rate * fmt.ch * (fmt.bits / 8))) * 1000 };
}
function wavFile({ rate, ch, bits }, pcm) {
  const bps = ch * (bits / 8), h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(ch, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * bps, 28); h.writeUInt16LE(bps, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
function sayVoices() {
  const r = spawnSync('say', ['-v', '?'], { encoding: 'utf8' });
  return new Set((r.stdout || '').split('\n').map((l) => l.match(/^(.+?)\s{2,}[a-z]{2,3}[_-][A-Za-z0-9]+/)?.[1]).filter(Boolean));
}
function sayClip(text, v, tmp) {
  const txt = path.join(tmp, 'say.txt'), wav = path.join(tmp, 'say.wav');
  writeFileSync(txt, text);
  const args = [...(v.name ? ['-v', v.name] : []), '-r', String(v.rate), '--data-format=LEI16@22050', '-o', wav, '-f', txt];
  const r = spawnSync('say', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`say failed: ${r.stderr || r.status}`);
  return readFileSync(wav);
}
async function openaiClip(text, v) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('--engine openai needs OPENAI_API_KEY in the environment (export it in your shell; never put it in a file)');
  const body = { model: v.model, voice: v.name, input: text, response_format: 'pcm', speed: v.speed };
  if (v.instructions) body.instructions = v.instructions;
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`OpenAI TTS: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
  return wavFile({ rate: 24000, ch: 1, bits: 16 }, Buffer.from(await r.arrayBuffer())); // pcm = 24 kHz 16-bit mono
}
async function prepareVoice(scenes, S, tmp) {
  const v = S.voice;
  if (v.engine === 'none') return;
  if (v.engine === 'say') {
    if (process.platform !== 'darwin') throw new Error('the say engine needs macOS (use --engine openai or none)');
    if (v.name && !sayVoices().has(v.name)) {
      console.warn(`! voice "${v.name}" is not installed: using the system voice. Add it in System Settings → Accessibility → Spoken Content → System voice → Manage Voices.`);
      v.name = '';
    }
  }
  const cache = path.join(os.homedir(), '.cache', 'explainer-video', 'voice');
  mkdirSync(cache, { recursive: true });
  for (const s of scenes) {
    if (!s.say.trim()) { s.voice = null; continue; }
    const id = createHash('sha1').update(JSON.stringify([v.engine, v.name, v.rate, v.model, v.speed, v.instructions, s.say])).digest('hex');
    const file = path.join(cache, `${id}.wav`);
    let buf;
    if (!has('no-cache') && existsSync(file)) buf = readFileSync(file);
    else { buf = v.engine === 'openai' ? await openaiClip(s.say, v) : sayClip(s.say, v, tmp); writeFileSync(file, buf); }
    s.voice = wavInfo(buf);
  }
  const rates = new Set(scenes.filter((s) => s.voice).map((s) => `${s.voice.rate}/${s.voice.ch}/${s.voice.bits}`));
  if (rates.size > 1) throw new Error('voice clips have different formats; run again with --no-cache');
}

/* ── in-page overlay: cursor, click ripple, element finder, smooth scrolling ───────────────────────── */
function overlay(opts) {
  if (window.top !== window || window.__demo) return;
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  const c = opts.color;
  const css = `#__demo{position:fixed;inset:0;pointer-events:none;z-index:2147483647;margin:0;padding:0;border:0;width:auto;height:auto;background:transparent;overflow:visible}
    #__demo::backdrop{display:none}#__demo.is-hidden{display:none}
    #__demo-cursor{position:fixed;left:0;top:0;width:40px;height:40px;margin:-4px 0 0 -7px;will-change:transform;filter:drop-shadow(0 2px 4px rgba(14,21,28,.45))}
    #__demo-cursor::before{content:"";position:absolute;left:-19px;top:-17px;width:52px;height:52px;border-radius:50%;background:radial-gradient(circle,${c}4d 0,${c}1f 45%,${c}00 70%)}
    #__demo-cursor svg{position:relative;width:40px;height:40px}
    .__demo-ripple{position:fixed;width:62px;height:62px;margin:-31px 0 0 -31px;border-radius:50%;border:4px solid ${c};background:${c}29;animation:__demo-r .6s cubic-bezier(0,0,.2,1) forwards}
    @keyframes __demo-r{from{transform:scale(.3);opacity:1}to{transform:scale(1.3);opacity:0}}`;
  let pos = { x: opts.w / 2, y: opts.h / 2 };
  try { pos = JSON.parse(sessionStorage.getItem('__demo_pos')) || pos; } catch {}
  let root = null, cur = null;
  const place = () => { if (cur) cur.style.transform = `translate(${pos.x}px,${pos.y}px)`; };
  const mount = () => {
    if (document.getElementById('__demo')) return;
    const st = document.createElement('style'); st.textContent = css;
    root = document.createElement('div'); root.id = '__demo';
    root.innerHTML = '<div id="__demo-cursor"><svg viewBox="0 0 30 30" aria-hidden="true"><path d="M5 3v20.5l5.4-5 3.7 8.2 3.9-1.7-3.7-8.1h7.4z" fill="#0e151c" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg></div>';
    if ('showPopover' in root) root.setAttribute('popover', 'manual');
    document.documentElement.append(st, root); cur = root.firstChild; place(); promote();
  };
  // Modal dialogs and popovers render in the top layer, above any z-index: keep the cursor on top of them.
  const promote = () => { if (!root?.showPopover) return; try { if (root.matches(':popover-open')) root.hidePopover(); root.showPopover(); } catch {} };
  new MutationObserver((ms) => { if (ms.some((m) => m.target !== root)) promote(); }).observe(document, { subtree: true, attributes: true, attributeFilter: ['open'] });
  addEventListener('toggle', (e) => { if (e.target !== root && e.newState === 'open') promote(); }, true);
  addEventListener('mousemove', (e) => { pos = { x: e.clientX, y: e.clientY }; place(); try { sessionStorage.setItem('__demo_pos', JSON.stringify(pos)); } catch {} }, true);
  addEventListener('mousedown', (e) => {
    if (!root) return; const r = document.createElement('div'); r.className = '__demo-ripple';
    r.style.left = `${e.clientX}px`; r.style.top = `${e.clientY}px`; root.append(r); setTimeout(() => r.remove(), 700);
  }, true);

  // ── finding elements by visible text ──
  const CLICKABLE = 'button,a[href],[role=button],[role=link],[role=tab],[role=menuitem],[role=option],[role=checkbox],[role=radio],[role=switch],'
    + 'input[type=submit],input[type=button],input[type=checkbox],input[type=radio],label,summary,select,[onclick],[tabindex]:not([tabindex="-1"])';
  const FIELD = 'input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]),textarea,select,[contenteditable=""],[contenteditable=true]';
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const visible = (el) => {
    if (!el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  };
  const names = (el) => {
    const n = [el.innerText, el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title'), el.getAttribute('alt'), el.getAttribute('name')];
    if (el.value && el.type !== 'password' && typeof el.value === 'string') n.push(el.value);
    if (el.labels) for (const l of el.labels) n.push(l.innerText);
    return n.map(norm).filter(Boolean);
  };
  const score = (el, t) => { const n = names(el); return n.some((x) => x === t) ? 2 : n.some((x) => x.includes(t)) ? 1 : 0; };
  // cheap test before the costly innerText: every word of the text occurs in textContent or an attribute
  const maybe = (el, words) => {
    const hay = `${el.textContent} ${el.getAttribute('aria-label') || ''} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('title') || ''} ${el.getAttribute('alt') || ''} ${el.getAttribute('name') || ''} ${typeof el.value === 'string' ? el.value : ''} ${el.labels ? [...el.labels].map((l) => l.textContent).join(' ') : ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  const depth = (el) => { let d = 0; for (let p = el; p; p = p.parentElement) d++; return d; };
  const innermost = (els) => els.filter((e) => !els.some((o) => o !== e && e.contains(o)));
  function pick(scope, spec, kind) {
    const sels = spec.selector ? [spec.selector] : kind === 'field' ? [FIELD] : kind === 'click' && spec.text ? [CLICKABLE, '*'] : ['*'];
    for (const sel of sels) {
      const t = norm(spec.text), words = t.split(' ').filter(Boolean);
      let els = [...scope.querySelectorAll(sel)].filter((e) => !e.closest('#__demo') && (!t || maybe(e, words)) && visible(e));
      if (spec.text) {
        const scored = els.map((e) => [e, score(e, t)]).filter(([, s]) => s > 0);
        const best = Math.max(0, ...scored.map(([, s]) => s));
        if (spec.exact && best < 2) els = [];
        else els = innermost(scored.filter(([, s]) => s === best).map(([e]) => e));
      }
      if (els.length) return els[Math.min(spec.nth || 0, els.length - 1)];
    }
    return null;
  }
  let tagN = 0;
  function find(spec, kind) {
    let scopes = [document];
    if (spec.within) {
      const w = spec.within, wt = norm(w.text), words = wt.split(' ').filter(Boolean);
      scopes = [...document.querySelectorAll(w.selector || '*')]
        .filter((e) => !e.closest('#__demo') && (!wt || maybe(e, words)) && visible(e) && (!wt || norm(e.innerText).includes(wt)))
        .sort((a, b) => depth(b) - depth(a)); // innermost container first
    }
    for (const s of scopes) {
      const el = pick(s, spec, kind);
      if (el) { if (!el.dataset.demoId) el.dataset.demoId = `d${++tagN}`; return `[data-demo-id="${el.dataset.demoId}"]`; }
    }
    return null;
  }
  // what is on the screen, for "not found" errors
  function inventory() {
    const seen = new Set(), out = [];
    for (const e of document.querySelectorAll(`${CLICKABLE},${FIELD},h1,h2,h3`)) {
      if (e.closest('#__demo') || !visible(e)) continue;
      const n = names(e)[0]; if (!n || seen.has(n)) continue;
      seen.add(n); out.push(`${e.tagName.toLowerCase()}: ${n.slice(0, 60)}`); if (out.length >= 30) break;
    }
    return out;
  }

  // ── scrolling: keep targets clear of fixed headers and of the subtitle zone at the bottom ──
  const k = innerWidth / 1440;
  const safeTop = () => {
    let top = 12;
    for (const x of [innerWidth / 2, 24, innerWidth - 24]) {
      for (const el of document.elementsFromPoint(x, 4)) {
        for (let p = el; p && p !== document.documentElement; p = p.parentElement) {
          const ps = getComputedStyle(p).position;
          if (ps === 'fixed' || ps === 'sticky') { const r = p.getBoundingClientRect(); if (r.top <= 4 && r.height < innerHeight * 0.4) top = Math.max(top, r.bottom + 12); break; }
        }
      }
    }
    return top;
  };
  const safeBottom = () => innerHeight - Math.round(140 * k);
  const scrollParent = (el) => {
    for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 4) return p;
    }
    return document.scrollingElement;
  };
  function animate(sc, to, ms) {
    return new Promise((res) => {
      const from = sc.scrollTop; to = Math.max(0, Math.min(to, sc.scrollHeight - sc.clientHeight));
      if (Math.abs(to - from) < 2) return res();
      ms = ms || Math.min(1200, Math.max(400, 300 + Math.abs(to - from) * 0.5));
      const prev = sc.style.scrollBehavior; sc.style.scrollBehavior = 'auto';
      const t0 = performance.now();
      const step = (now) => { const q = Math.min(1, (now - t0) / ms); sc.scrollTop = from + (to - from) * ease(q); if (q < 1) requestAnimationFrame(step); else { sc.style.scrollBehavior = prev; res(); } };
      requestAnimationFrame(step);
    });
  }
  async function bring(el, block = 'center', ms) {
    const sc = scrollParent(el), win = sc === document.scrollingElement;
    const r = el.getBoundingClientRect();
    const box = win ? { top: safeTop(), bottom: safeBottom() } : (() => { const b = sc.getBoundingClientRect(); return { top: b.top + 8, bottom: b.bottom - 8 }; })();
    const want = block === 'start' ? box.top : box.top + Math.max(0, (box.bottom - box.top - r.height) / 2);
    await animate(sc, sc.scrollTop + (r.top - want), ms);
    if (!win) { const r2 = el.getBoundingClientRect(); if (r2.top < safeTop() || r2.bottom > safeBottom()) await bring(sc, 'center', ms); }
  }
  async function reveal(sel) {
    const el = document.querySelector(sel); if (!el) return null;
    let r = el.getBoundingClientRect();
    if (r.top < safeTop() || r.bottom > safeBottom() || r.left < 0 || r.right > innerWidth) {
      await bring(el, r.height > safeBottom() - safeTop() ? 'start' : 'center'); r = el.getBoundingClientRect();
    }
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }
  async function scroll({ sel, y, by, block = 'start', ms }) {
    if (sel) { const el = document.querySelector(sel); if (!el) return false; await bring(el, block, ms); return true; }
    const sc = document.scrollingElement;
    await animate(sc, by !== undefined ? sc.scrollTop + by : y === 'bottom' ? sc.scrollHeight : y === 'top' ? 0 : y, ms); return true;
  }
  const hide = (on) => { const was = !!root?.classList.contains('is-hidden'); root?.classList.toggle('is-hidden', !!on); return was; };
  window.__demo = { find, inventory, reveal, scroll, hide };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true }); else mount();
}

/* ── Chrome over the DevTools Protocol ─────────────────────────────────────────────────────────────── */
class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.p = new Map(); this.h = new Map(); ws.addEventListener('message', (e) => this.msg(JSON.parse(e.data))); }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cannot connect to Chrome')); }); return new CDP(ws); }
  msg(m) {
    if (m.id) { const p = this.p.get(m.id); this.p.delete(m.id); if (m.error) p?.rej(new Error(`${p.method}: ${m.error.message}`)); else p?.res(m.result); return; }
    for (const f of this.h.get(m.method) || []) f(m.params);
  }
  send(method, params = {}) { const id = ++this.id; return new Promise((res, rej) => { this.p.set(id, { res, rej, method }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  on(m, f) { this.h.set(m, [...(this.h.get(m) || []), f]); }
  close() { try { this.ws.close(); } catch {} }
}
function chromePath() {
  const list = [process.env.CHROME, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary'];
  const found = list.find((p) => p && existsSync(p));
  if (!found) throw new Error('Google Chrome not found (install it, or set CHROME=/path/to/chrome)');
  return found;
}
let chrome = null, cdp = null, profile = null;
async function launchChrome(S) {
  profile = mkdtempSync(path.join(os.tmpdir(), 'explainer-profile-'));
  chrome = spawn(chromePath(), [...(has('show') ? [] : ['--headless=new']), '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--hide-scrollbars', '--mute-audio', `--window-size=${S.W},${S.H}`, '--force-device-scale-factor=1', '--no-first-run',
    '--no-default-browser-check', `--lang=${S.lang}`, '--disable-features=Translate,MediaRouter', '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 150; i++) {
    try {
      const port = readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
      const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(100);
  }
  throw new Error('Chrome did not open a debugging port');
}
function cleanup() {
  cdp?.close(); cdp = null;
  try { chrome?.kill(); } catch {}
  if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch {} profile = null; }
}

/* ── recording clock and frames ────────────────────────────────────────────────────────────────────── */
const rec = {
  dir: null, frames: [], cursor: [], zooms: [], base: 0, t0: 0, paused: true, n: 0, lastT: -1e9,
  clock() { return this.paused ? this.base : this.base + performance.now() - this.t0; },
  pause() { if (!this.paused) { this.base = this.clock(); this.paused = true; } },
  resume() { if (this.paused) { this.t0 = performance.now(); this.paused = false; } },
  add(b64, force) {
    if (this.paused) return;
    const t = this.clock(), last = this.frames.at(-1);
    if (!force && last && t - this.lastT < 30) { writeFileSync(path.join(this.dir, last.f), Buffer.from(b64, 'base64')); return; }
    const f = `${String(++this.n).padStart(6, '0')}.jpg`;
    writeFileSync(path.join(this.dir, f), Buffer.from(b64, 'base64'));
    this.frames.push({ t: Math.round(t), f }); this.lastT = t;
  },
  async grab() { const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 88 }); this.add(data, true); },
};

/* ── actions ───────────────────────────────────────────────────────────────────────────────────────── */
let S = null;
const mouse = { x: 0, y: 0 };
const nav = { mainFrame: null, loading: false, cut: false, stopped: true };
async function js(fn, ...args) {
  const expression = typeof fn === 'function' ? `(${fn})(...${JSON.stringify(args)})` : fn;
  const r = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`page: ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`);
  return r.result?.value;
}
async function poll(fn, args, what, timeout = 15000) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await js(fn, ...args); if (v) return v; } catch {}
    if (Date.now() - t0 > timeout) throw new Error(`timed out after ${sec(timeout)} waiting for ${what}`);
    await sleep(100);
  }
}
const pageReady = () => document.readyState === 'complete' && (!!document.getElementById('__demo') || location.protocol === 'data:');
/** Wait until the main frame has finished loading a new document (not the old one that is still on screen). */
async function loaded(what) {
  const t0 = Date.now();
  while (!nav.stopped) { if (Date.now() - t0 > 30000) throw new Error(`timed out waiting for ${what} to load`); await sleep(50); }
  await poll(pageReady, [], what, 30000);
}
async function placeCursor() { await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mouse.x, y: mouse.y }); }
/** After a click or key press that started a page load: the clock was stopped when the load began; wait, then resume. */
async function settle() {
  if (!nav.loading && !nav.cut) return;
  await loaded('the page');
  await js(() => document.fonts.ready.then(() => true)).catch(() => {});
  await sleep(250); nav.loading = false;
  await placeCursor();
  if (nav.cut) { nav.cut = false; rec.resume(); await rec.grab(); }
}
function url(u) { return /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `${S.baseUrl}${u.startsWith('/') ? '' : '/'}${u}`; }
async function goto(u, waitText) {
  const was = !rec.paused;
  if (S.cutLoads) rec.pause();
  nav.loading = true; nav.stopped = false;
  const r = await cdp.send('Page.navigate', { url: url(u) });
  if (r.errorText) throw new Error(`cannot open ${url(u)}: ${r.errorText}${u.startsWith('http') ? '' : ` (is the app running at ${S.baseUrl}?)`}`);
  if (r.loaderId) await loaded(url(u)); else { nav.stopped = true; await poll(pageReady, [], url(u), 30000); } // no loaderId: same-document navigation
  if (waitText) await waitFor(waitText);
  await js(() => document.fonts.ready.then(() => true)).catch(() => {});
  await sleep(300); nav.loading = false; nav.cut = false;
  await placeCursor();
  if (S.cutLoads || !was) { rec.resume(); await rec.grab(); }
}
function spec(t) {
  if (typeof t === 'string') return { text: t };
  if (!t || typeof t !== 'object') throw new Error(`bad target ${JSON.stringify(t)}: use "visible text" or { "text", "selector", "within", "nth", "exact" }`);
  return { ...t, within: typeof t.within === 'string' ? { text: t.within } : t.within };
}
async function find(t, kind) {
  const s = spec(t);
  const sel = await js((a, b) => window.__demo.find(a, b), s, kind);
  if (!sel) {
    const inv = await js(() => window.__demo.inventory()).catch(() => []);
    throw new Error(`not found: ${JSON.stringify(t)}\n  visible on the page:\n    ${inv.join('\n    ') || '(nothing)'}`);
  }
  return sel;
}
async function moveTo(x, y, ms) {
  const x0 = mouse.x, y0 = mouse.y, dist = Math.hypot(x - x0, y - y0);
  ms = ms ?? Math.min(800, Math.max(280, 200 + dist * 0.45));
  const steps = Math.max(1, Math.round(ms / 16));
  for (let i = 1; i <= steps; i++) {
    const q = ease(i / steps); mouse.x = x0 + (x - x0) * q; mouse.y = y0 + (y - y0) * q;
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mouse.x, y: mouse.y });
    rec.cursor.push({ t: rec.clock(), x: mouse.x, y: mouse.y });
    await sleep(16);
  }
}
async function locate(sel) { const r = await js((s) => window.__demo.reveal(s), sel); if (!r) throw new Error(`element left the page: ${sel}`); return r; }
async function hover(t, o = {}) { const r = await locate(await find(t, o.kind || 'hover')); await moveTo(r.x + r.w * (o.dx ?? 0.5), r.y + r.h * (o.dy ?? 0.5), o.ms); return r; }
async function click(t, o = {}) {
  const r = await hover(t, { ...o, kind: o.kind || 'click' });
  const x = mouse.x, y = mouse.y;
  await sleep(120);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(70);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(o.pause ?? 350);
  return r;
}
const KEYS = { Enter: [13, '\r'], Tab: [9], Escape: [27], Backspace: [8], Delete: [46], Space: [32, ' '], Home: [36], End: [35],
  PageUp: [33], PageDown: [34], ArrowUp: [38], ArrowDown: [40], ArrowLeft: [37], ArrowRight: [39] };
async function press(key) {
  const k = KEYS[key];
  if (!k && key.length !== 1) throw new Error(`press: unknown key ${key} (use ${Object.keys(KEYS).join(', ')} or one character)`);
  const code = key === 'Space' ? 'Space' : k ? key : `Key${key.toUpperCase()}`;
  const text = k ? k[1] : key, vk = k ? k[0] : key.toUpperCase().charCodeAt(0);
  const name = key === 'Space' ? ' ' : key;
  await cdp.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key: name, code, windowsVirtualKeyCode: vk, ...(text ? { text, unmodifiedText: text } : {}) });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: vk });
  await sleep(200);
}
async function type(text, o = {}) {
  if (o.into) await click(o.into, { kind: 'field', pause: 200 });
  if (o.clear) await js(() => { const el = document.activeElement; if (el?.select) el.select(); else document.execCommand('selectAll'); document.execCommand('delete'); return true; });
  const cps = o.cps || 18;
  for (const ch of String(text)) { await cdp.send('Input.insertText', { text: ch }); await sleep((1000 / cps) * (0.55 + rnd() * 0.9)); }
  if (o.enter) await press('Enter');
  await sleep(250);
}
async function waitFor(w, o = {}) {
  const s = typeof w === 'string' ? { text: w } : w;
  const timeout = o.timeout || s.timeout || 15000;
  const test = (text, sel) => {
    if (sel) { const e = document.querySelector(sel); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (!text || e.innerText.includes(text)); }
    // visible text, or a visible element named by it (placeholder, aria-label, value, label)
    return !!document.body?.innerText.includes(text) || !!window.__demo?.find({ text }, 'hover');
  };
  const what = s.selector ? `${s.selector}${s.text ? ` with "${s.text}"` : ''}` : `"${s.text}"`;
  if (!(o.cut || s.cut)) { await poll(test, [s.text || '', s.selector || ''], what, timeout); return; }
  // a slow result: show the first moment of the wait, then stop the clock so the video skips the rest
  const t0 = Date.now(); let paused = false;
  for (;;) {
    let ok = false; try { ok = await js(test, s.text || '', s.selector || ''); } catch {}
    if (ok) break;
    if (!paused && Date.now() - t0 > 1200) { rec.pause(); paused = true; }
    if (Date.now() - t0 > timeout) { if (paused) rec.resume(); throw new Error(`timed out after ${sec(timeout)} waiting for ${what}`); }
    await sleep(150);
  }
  if (paused) { await sleep(150); rec.resume(); await rec.grab(); console.log(`    waited ${sec(Date.now() - t0)} for ${what}, cut from the video`); }
}
async function scroll(a) {
  if (typeof a === 'object' && a && ('by' in a || 'y' in a)) { await js((x) => window.__demo.scroll(x), { by: a.by, y: a.y, ms: a.ms }); }
  else { const sel = await find(a, 'hover'); await js((x) => window.__demo.scroll(x), { sel, block: a.block || 'start', ms: a.ms }); }
  await sleep(150);
}
async function still(name, stills) {
  const wasPaused = rec.paused;
  rec.pause();
  const hidden = await js(() => window.__demo?.hide(true)).catch(() => false); await sleep(180);
  let q = 88, buf;
  for (;;) { const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: q }); buf = Buffer.from(data, 'base64'); if (buf.length <= 350 * 1024 || q <= 46) break; q -= 6; }
  const file = name === '__poster' ? S.poster : path.join(S.stills, `${name}.jpg`);
  writeFileSync(file, buf);
  if (name === 'poster') copyFileSync(file, S.poster);
  if (name !== '__poster') stills.push({ name, file });
  await js((h) => window.__demo?.hide(h), !!hidden).catch(() => {}); await sleep(60);
  if (!wasPaused) { rec.resume(); await rec.grab(); }
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
async function card(c) {
  const o = typeof c === 'string' ? { title: c } : c;
  const dark = (o.theme || 'dark') === 'dark';
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%}
    body{display:grid;place-items:center;background:${dark ? '#17212c' : '#f6f7f9'};color:${dark ? '#fff' : '#0e151c'};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
    main{text-align:center;max-width:78vw}i{display:block;width:64px;height:6px;border-radius:3px;background:${S.color};margin:0 auto 34px}
    h1{font-size:${Math.round(S.W / 24)}px;line-height:1.12;margin:0;letter-spacing:-.02em;text-wrap:balance}
    p{font-size:${Math.round(S.W / 54)}px;line-height:1.4;margin:22px 0 0;opacity:.72;text-wrap:balance}</style></head>
    <body><main><i></i><h1>${esc(o.title)}</h1>${o.subtitle ? `<p>${esc(o.subtitle)}</p>` : ''}</main></body></html>`;
  rec.pause();
  nav.loading = true; nav.stopped = false;
  await cdp.send('Page.navigate', { url: `data:text/html;base64,${Buffer.from(html).toString('base64')}` });
  await loaded('the title card');
  await js(() => window.__demo?.hide(true)).catch(() => {});
  await sleep(200); nav.loading = false; nav.cut = false;
  rec.resume(); await rec.grab();
}
async function run(a, stills) {
  const kind = kindOf(a), v = a[kind];
  switch (kind) {
    case 'goto': return goto(v, a.waitFor);
    case 'click': await click(v, a); if (a.waitFor) { await waitFor(a.waitFor, a); await settle(); } return;
    case 'hover': return hover(v, a);
    case 'glide': { const r = await hover(v, { ...a, dx: 0.04 }); return moveTo(r.x + r.w * 0.9, r.y + r.h * 0.5, a.ms || 900); }
    case 'type': return type(v, a);
    case 'press': await press(v); if (a.waitFor) { await waitFor(a.waitFor, a); await settle(); } return;
    case 'scroll': return scroll(v);
    case 'waitFor': await waitFor(v, a); return settle();
    case 'wait': return sleep(Number(v) || 0);
    case 'still': return still(String(v), stills);
    case 'zoom': rec.zooms.push({ t: rec.clock(), z: Math.max(1, Number(v) || 1) }); return;
    case 'card': return card(v);
    case 'js': return js(String(v));
  }
}

/* ── after the recording: timing, captions, camera ─────────────────────────────────────────────────── */
function camera(map, duration) {
  const { W, H, fps } = S;
  const zooms = rec.zooms.map((e) => ({ t: map(e.t), z: e.z }));
  if (!zooms.some((z) => z.z > 1.001)) return null;
  const cur = rec.cursor.map((c) => ({ t: map(c.t), x: c.x, y: c.y }));
  const n = Math.ceil((duration / 1000) * fps), crops = [];
  let zi = -1, ci = 0, from = 1, to = 1, t0 = 0, cx = W / 2, cy = H / 2;
  for (let k = 0; k < n; k++) {
    const t = (k * 1000) / fps;
    while (zi + 1 < zooms.length && zooms[zi + 1].t <= t) { zi++; const now = from + (to - from) * ease(Math.min(1, (zooms[zi].t - t0) / 450)); from = now; to = zooms[zi].z; t0 = zooms[zi].t; }
    const z = from + (to - from) * ease(Math.min(1, (t - t0) / 450));
    while (ci + 1 < cur.length && cur[ci + 1].t <= t) ci++;
    const p = cur[ci] || { x: W / 2, y: H / 2 };
    const a = z > 1.001 ? 0.16 : 1; cx += (p.x - cx) * a; cy += (p.y - cy) * a; // follow the cursor smoothly while zoomed
    if (z <= 1.001) { crops.push(null); continue; }
    const w = W / z, h = H / z;
    const x = Math.max(0, Math.min(W - w, cx - w / 2)), y = Math.max(0, Math.min(H - h, cy - h * 0.45));
    crops.push([+x.toFixed(1), +y.toFixed(1), +w.toFixed(1), +h.toFixed(1)]);
  }
  return crops;
}

/* ── main ──────────────────────────────────────────────────────────────────────────────────────────── */
async function main() {
  const { cfg, dir } = await loadConfig(CONFIG);
  S = settings(cfg, dir);
  const scenes = validate(cfg);
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'explainer-video-'));
  rec.dir = path.join(tmp, 'frames'); mkdirSync(rec.dir);
  await prepareVoice(scenes, S, tmp);
  const voiced = S.voice.engine !== 'none' && scenes.some((s) => s.voice);
  for (const s of scenes) s.target = s.voice ? Math.round(S.lead + s.voice.ms + S.tail + s.hold) : null;
  console.log(`voice: ${voiced ? `${S.voice.engine}${S.voice.name ? ` · ${S.voice.name}` : ''}` : 'none (silent video)'} · ${S.W}×${S.H} · ${S.baseUrl}`);
  if (has('plan')) {
    for (const s of scenes) console.log(`  ${s.name.padEnd(14)} ${s.voice ? `voice ${sec(s.voice.ms).padStart(6)} → scene ${sec(s.target)}` : 'no voice: as long as it takes (min. reading time)'}`);
    const total = scenes.reduce((n, s) => n + (s.target || 0), 0);
    console.log(`total ≈ ${sec(total)}${scenes.some((s) => !s.voice) ? ' + unvoiced scenes' : ''}`);
    rmSync(tmp, { recursive: true, force: true }); return;
  }
  const first = scenes[0].actions[0];
  if (!first || !('goto' in first || 'card' in first)) scenes[0].actions.unshift({ goto: '/' }); // start on the base URL
  mkdirSync(S.outDir, { recursive: true }); mkdirSync(S.stills, { recursive: true });

  const auth = S.auth;
  cdp = await CDP.connect(await launchChrome(S));
  await cdp.send('Page.enable'); await cdp.send('Runtime.enable'); await cdp.send('Network.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: S.W, height: S.H, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  const { userAgent } = await cdp.send('Browser.getVersion');
  await cdp.send('Network.setUserAgentOverride', { userAgent: userAgent.replace('HeadlessChrome', 'Chrome'), acceptLanguage: S.lang });
  for (const c of auth.cookies || []) {
    const cookie = { path: '/', ...c, value: expand(c.value, `cookie ${c.name}`) };
    if (!cookie.domain) cookie.url = S.baseUrl;
    await cdp.send('Network.setCookie', cookie);
  }
  if (auth.headers) await cdp.send('Network.setExtraHTTPHeaders', { headers: Object.fromEntries(Object.entries(auth.headers).map(([k, v]) => [k, expand(v, `header ${k}`)])) });
  for (const kind of ['localStorage', 'sessionStorage']) {
    if (!auth[kind]) continue;
    const items = Object.fromEntries(Object.entries(auth[kind]).map(([k, v]) => [k, expand(v, `${kind} ${k}`)]));
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `try { if (location.origin === ${JSON.stringify(new URL(S.baseUrl).origin)}) for (const [k, v] of Object.entries(${JSON.stringify(items)})) ${kind}.setItem(k, v); } catch {}` });
  }
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(${overlay})(${JSON.stringify({ color: S.color, w: S.W, h: S.H })});` });
  nav.mainFrame = (await cdp.send('Page.getFrameTree')).frameTree.frame.id;
  cdp.on('Page.frameStoppedLoading', ({ frameId }) => { if (frameId === nav.mainFrame) nav.stopped = true; });
  cdp.on('Page.frameStartedLoading', ({ frameId }) => {
    if (frameId !== nav.mainFrame) return;
    nav.stopped = false;
    if (nav.loading) return;
    nav.loading = true; // a click or key press started a page load: cut it from the video
    if (S.cutLoads && !rec.paused) { rec.pause(); nav.cut = true; }
  });
  cdp.on('Page.screencastFrame', ({ data, sessionId }) => { cdp?.send('Page.screencastFrameAck', { sessionId }).catch(() => {}); rec.add(data); });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: S.W, maxHeight: S.H, everyNthFrame: 1 });
  mouse.x = S.W / 2; mouse.y = S.H / 2;

  const stills = [], segs = [];
  let B = 0, poster = false;
  for (const s of scenes) {
    const a = rec.clock();
    console.log(`── ${s.name}`);
    for (const [j, act] of s.actions.entries()) {
      try { await settle(); await run(act, stills); }
      catch (e) {
        let shot = '';
        try { const { data } = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 70 }); shot = path.join(S.outDir, `failed-${s.name}.jpg`); writeFileSync(shot, Buffer.from(data, 'base64')); } catch {}
        throw new Error(`scene "${s.name}", action ${j + 1} ${JSON.stringify(act)}:\n  ${e.message}${shot ? `\n  screenshot: ${shot}` : ''}`);
      }
    }
    await settle();
    if (stills.some((x) => x.name === 'poster')) poster = true;
    if (!poster) { await still('__poster', stills); poster = true; }
    const acted = rec.clock() - a;
    const T = s.target ?? Math.max(Math.round(acted), readMs(s.caps) + s.hold);
    if (acted < T) { await sleep(T - acted); await rec.grab(); }
    const b = rec.clock(), d = b - a;
    segs.push({ s, a, b, B, T, k: d > T ? T / d : 1, d, acted });
    B += T;
  }
  rec.pause();
  await cdp.send('Page.stopScreencast').catch(() => {});
  cleanup();
  const duration = Math.round(B);

  // frames → output time, scene by scene
  const frames = [];
  segs.forEach((g, i) => {
    const last = i === segs.length - 1;
    for (const f of rec.frames) if (f.t >= g.a && (f.t < g.b || (last && f.t <= g.b))) frames.push({ t: Math.round(g.B + (f.t - g.a) * g.k), f: f.f });
  });
  const map = (t) => { const g = segs.findLast((x) => t >= x.a) || segs[0]; return Math.round(g.B + Math.min(g.T, Math.max(0, t - g.a) * g.k)); };
  const captions = [];
  for (const g of segs) {
    const caps = g.s.caps.filter(Boolean), len = caps.reduce((n, c) => n + c.length, 0);
    let c0 = g.B;
    for (const c of caps) { const c1 = c0 + (g.T * c.length) / len; captions.push({ start: Math.round(c0), end: Math.round(c1 - 80), text: c }); c0 = c1; }
  }
  console.log('\nscene          actions → video');
  for (const g of segs) {
    const f = g.acted / g.T;
    const how = f > 1.03 ? `plays ×${f.toFixed(2)} faster` : f < 0.97 ? `holds the last frame ${sec(g.T - g.acted)}` : 'as recorded';
    console.log(`  ${g.s.name.padEnd(12)} ${sec(g.acted).padStart(7)} → ${sec(g.T).padStart(7)}  ${how}`);
    if (f > 1.6) console.log(`  ! ${g.s.name} plays ×${f.toFixed(1)} faster than it was recorded: give it more narration, fewer actions, or split it`);
  }

  // silent video with burned-in subtitles
  const crops = camera(map, duration);
  const silent = path.join(tmp, 'silent.mp4'), manifest = path.join(tmp, 'manifest.json');
  const capped = Math.max(300_000, Math.min(1_600_000, Math.floor((S.maxMb * 1e6 * 0.9 * 8) / (duration / 1000))));
  writeFileSync(manifest, JSON.stringify({ dir: rec.dir, fps: S.fps, width: S.W, height: S.H, bitrate: voiced ? 8_000_000 : capped,
    keyframe_s: 6, duration_ms: duration, frames, captions, ...(crops ? { crops } : {}) }));
  if (spawnSync(SWIFT, [path.join(HERE, 'encode.swift'), manifest, voiced ? silent : S.output], { stdio: 'inherit' }).status !== 0) throw new Error(`encode.swift failed (frames kept in ${tmp})`);

  // one voice track: each clip at its scene start, then mux it in under the size cap
  if (voiced) {
    const fmt = segs.find((g) => g.s.voice).s.voice, bps = fmt.ch * (fmt.bits / 8);
    const pcm = Buffer.alloc(Math.ceil((duration / 1000) * fmt.rate) * bps);
    for (const g of segs) {
      if (!g.s.voice) continue;
      const at = Math.round(((g.B + S.lead) / 1000) * fmt.rate) * bps;
      g.s.voice.data.copy(pcm, at, 0, Math.max(0, Math.min(g.s.voice.data.length, pcm.length - at)));
    }
    const track = path.join(tmp, 'voice.wav'); writeFileSync(track, wavFile(fmt, pcm));
    if (spawnSync(SWIFT, [path.join(HERE, 'mux.swift'), silent, track, S.output, '--max-mb', String(S.maxMb)], { stdio: 'inherit' }).status !== 0) throw new Error(`mux.swift failed (files kept in ${tmp})`);
  }

  writeFileSync(S.timeline, JSON.stringify({
    video: path.basename(S.output), poster: path.basename(S.poster), duration_ms: duration, width: S.W, height: S.H,
    voice: voiced ? { engine: S.voice.engine, name: S.voice.name } : null,
    scenes: segs.map((g) => ({ name: g.s.name, start: g.B, end: g.B + g.T, recorded_ms: Math.round(g.acted), speed: +Math.max(1, g.acted / g.T).toFixed(2), say: g.s.say, caps: g.s.caps })),
    captions, stills: stills.map((x) => ({ name: x.name, file: path.relative(S.outDir, x.file) })),
  }, null, 2));

  if (!has('no-check')) {
    rmSync(S.check, { recursive: true, force: true });
    const at = segs.map((g) => {
      const t = g.B + g.T * 0.6, c = captions.find((x) => x.start <= t && t < x.end + 80);
      return ((c ? (c.start + c.end) / 2 : t) / 1000).toFixed(2);
    }).join(',');
    const labels = segs.map((g, i) => `${String(i + 1).padStart(2, '0')}-${g.s.name.replace(/[^\w-]+/g, '_')}`).join(',');
    console.log('\ncheck:');
    spawnSync(SWIFT, [path.join(HERE, 'frames.swift'), S.output, S.check, '--at', at, '--labels', labels], { stdio: 'inherit' });
  }
  if (has('keep')) console.log(`\nraw frames and voice track kept in ${tmp}`); else rmSync(tmp, { recursive: true, force: true });
  console.log(`\nvideo:    ${S.output}  (${sec(duration)})\nposter:   ${S.poster}\nstills:   ${S.stills}  (${stills.length})\ntimeline: ${S.timeline}`);
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { cleanup(); process.exit(130); });
main().catch((e) => { console.error(`\nrecord.mjs: ${e.message}`); cleanup(); process.exit(1); });

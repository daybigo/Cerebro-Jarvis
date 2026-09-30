// Graba el demo del Cerebro de Claude cuadro por cuadro (headless), con voz.
//   1) "Cargando el grafo..." y la intro completa
//   2) el cursor toca Voz: el cerebro se presenta
//   3) el cursor toca Probar: una sesión con agentes recorre el cerebro
//   4) mientras trabajan, se le escribe "¿Qué está pasando ahora mismo en tu cerebro?"
//      y el cerebro narra en voz alta los procesos que ve
// Requisitos: servidor corriendo (python server.py), ffmpeg en el PATH, Chrome instalado.
// Uso: node grabar.mjs   → demo/cerebro-demo.mp4 (+ cerebro-demo-voz.wav)
// Variables: PREGUNTA="...", SALIDA=archivo.mp4, FPS=30, CHROME=ruta/a/chrome
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'http://127.0.0.1:7777';
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FPS = Number(process.env.FPS || 30);
const OUT = process.env.SALIDA || 'cerebro-demo.mp4';
const PREGUNTA = process.env.PREGUNTA || '¿Qué estás pensando ahora mismo?';
const SR = 44100;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const post = (path, body) => fetch(BASE + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json());
const graph = await fetch(BASE + '/api/graph').then(r => r.json());

// ---------------------------------------------------------------- 1) voz (en caché para no regenerarla)
const CACHE = 'voz_cache.json';
let cache = {};
try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch {}
async function voiceOnce(key, fn) {
  if (cache[key]?.pcm) return cache[key];
  console.log('generando voz:', key.slice(0, 70));
  const r = await fn();
  if (r.error) console.log('  aviso:', r.error);
  cache[key] = r;
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  return r;
}
const saludoTxt = '[confident] Hola. Soy el Cerebro de Claude: cada neurona es una memoria, y cada destello, algo que Claude está haciendo ahora mismo.';
const saludo = await voiceOnce('saludo:' + saludoTxt, () => post('/api/voice/say', { text: saludoTxt, json: true }));
// la respuesta la piensa el cerebro de verdad, con la sesión de prueba corriendo en el servidor;
// tono corto para TikTok: si sale larga se vuelve a pedir
const MAX_RESP = Number(process.env.MAX_RESP || 12);
const respuesta = await voiceOnce('tiktok:' + PREGUNTA, async () => {
  await post('/api/probar', {});
  await sleep(8000);
  let best = null;
  for (let i = 0; i < 4; i++) {
    const r = await post('/api/voice/ask', { text: PREGUNTA, json: true, id: 'demo', focus: 'demo', tone: 'tiktok' });
    const secs = Buffer.from(r.pcm || '', 'base64').length / 2 / SR;
    console.log(`  intento ${i + 1}: ${secs.toFixed(1)}s — ${r.text}`);
    if (!best || secs < best.secs) best = { ...r, secs };
    if (secs && secs <= MAX_RESP) break;
  }
  return best;
});
const pcm = r => { const b = Buffer.from(r.pcm || '', 'base64'); return new Int16Array(b.buffer, b.byteOffset, Math.floor(b.length / 2)); };
const saludoPCM = pcm(saludo), respPCM = pcm(respuesta);
const dur = a => a.length / SR;
console.log('saludo %ss, respuesta %ss: %s', dur(saludoPCM).toFixed(1), dur(respPCM).toFixed(1), (respuesta.text || '').slice(0, 120));

// ---------------------------------------------------------------- 2) guion (segundos del video)
const T = {};
const TYPE = 0.035;          // segundos por letra al escribir
const INTRO_SPEED = 1.25;    // la intro un poco más rápida para videos cortos
T.load = 0.5;
T.cursorIn = 4.5;
T.clickVoz = 5.4;
T.saludo = T.clickVoz + 0.3;
T.toProbar = T.saludo + dur(saludoPCM) - 1.1;
T.clickProbar = T.toProbar + 0.8;
T.sesion = T.clickProbar + 0.3;
T.toInput = T.sesion + 1.5;
T.clickInput = T.toInput + 0.7;
T.typeEnd = T.clickInput + 0.3 + PREGUNTA.length * TYPE;
T.enter = T.typeEnd + 0.25;
T.habla = T.enter + 0.9;
T.answerEnd = T.habla + dur(respPCM);

// ---------------------------------------------------------------- 3) lo que hace "Probar": sesión con agentes y notas reales
let seed = 7;
const rnd = arr => arr[Math.floor(((seed = (seed * 16807) % 2147483647) / 2147483647) * arr.length)];
const byType = t => graph.nodes.map((n, i) => [n, i]).filter(([n]) => graph.typeIds[n.ty] === t).map(x => x[1]);
const home = graph.globalHome ?? byType('indice')[0];
const idx = byType('indice'), proj = byType('proyecto'), refs = byType('referencia'), fb = byType('feedback'), skills = byType('skill');
const pools = [proj, refs, fb, skills.length ? skills : refs, idx];
const sess = { sid: 'prueba', name: 'prueba', state: 'trabajando', cur: '', agents: [], home };
const events = [];
const at = (t, fn) => events.push([t, fn]);
const now = () => Date.now() / 1000;
const snap = () => ({ k: 'sessions', sessions: [{ ...sess, last: now(), agents: sess.agents.map(a => ({ ...a, last: now() })) }] });
const act = (t, verb, node, extra = {}) => at(t, () => {
  const agent = extra.agent ? sess.agents.find(a => a.aid === extra.agent) : null;
  if (agent) { agent.verb = verb; agent.n++; }
  else { sess.state = verb === 'espera' ? 'espera' : verb === 'listo' ? 'listo' : 'trabajando'; sess.cur = verb === 'listo' ? '' : `${verb} ${node != null ? graph.nodes[node].t : extra.file || extra.text || ''}`; }
  return [{ k: 'act', ts: now(), sid: 'prueba', sname: 'prueba', aid: agent?.aid ?? null, aname: agent?.name ?? null, verb, node: node ?? null,
    file: extra.file ?? null, text: extra.text ?? (node != null ? graph.nodes[node].t : ''), plus: extra.plus || 0, minus: extra.minus || 0, home, actor: null, demo: true }, snap()];
});
const spawnAgent = (t, aid, name) => at(t, () => { sess.agents.push({ aid, name, verb: 'arranca', n: 0 }); return [snap()]; });
const agents = [['a1', 'general-purpose #1'], ['a2', 'Explore #1'], ['a3', 'general-purpose #2'], ['a4', 'Explore #2'], ['a5', 'general-purpose #3'], ['a6', 'Plan #1']];
const verbs = ['lee', 'busca', 'script', 'git', 'compila', 'lee', 'prueba', 'busca'];
let t = T.sesion;
at(t, () => [{ k: 'mind', mind: 'trabajando' }]);
act(t, 'lee', rnd(proj));
act(t += 0.6, 'agente', home, { text: 'lanza 3 agentes' });
agents.slice(0, 3).forEach(([aid, name], k) => spawnAgent(t + 0.15 * k, aid, name));
agents.slice(0, 3).forEach(([aid], k) => act(t + 0.2 + 0.18 * k, verbs[k], rnd(pools[k]), { agent: aid }));
act(t += 0.9, 'agente', home, { text: 'lanza 3 agentes más' });
agents.slice(3).forEach(([aid, name], k) => spawnAgent(t + 0.15 * k, aid, name));
agents.slice(3).forEach(([aid], k) => act(t + 0.2 + 0.18 * k, verbs[k + 3], rnd(pools[k + 1]), { agent: aid }));
t += 0.8;
// los agentes siguen trabajando mientras el cerebro habla
let k = 0;
while (t < T.answerEnd - 2.6) {
  const [aid] = agents[k % agents.length];
  act(t += 0.48, verbs[k % verbs.length], rnd(pools[k % pools.length]), { agent: aid });
  if (k % 6 === 5) act(t += 0.2, 'lee', rnd([proj, refs][k % 2]));
  if (k === 8) act(t += 0.25, 'edita', null, { file: 'demo.txt', plus: 12, minus: 3 });
  k++;
}
act(t += 0.5, 'compila', null, { text: 'build' });
act(t += 0.6, 'crea', null, { file: 'nota-de-prueba.md', plus: 20, minus: 0 });
act(t += 0.5, 'commit', null, { text: 'en prueba' });
at(t += 0.35, () => { sess.agents = []; return [snap()]; });
act(t += 0.3, 'listo', null, { text: 'terminó de responder' });
at(t + 0.3, () => [{ k: 'mind', mind: 'pensando' }]);
T.hideBubble = T.answerEnd + 1.0;
T.fin = Math.max(t + 1.6, T.answerEnd + 1.4);
console.log('duración: %ss', T.fin.toFixed(1));

// ---------------------------------------------------------------- 4) audio
const total = new Int16Array(Math.ceil(T.fin * SR));
const mix = (src, at) => { const o = Math.round(at * SR); for (let i = 0; i < src.length && o + i < total.length; i++) total[o + i] = src[i]; };
mix(saludoPCM, T.saludo); mix(respPCM, T.habla);
function wav(samples) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples.length * 2, 40);
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(b, 44);
  return b;
}
fs.writeFileSync('voz.wav', wav(total));
fs.writeFileSync(OUT.replace(/\.mp4$/, '') + '-voz.wav', wav(total));
const level = tt => {
  const i0 = Math.floor(tt * SR), n = Math.floor(SR / FPS);
  let s = 0; for (let i = i0; i < i0 + n && i < total.length; i++) s += (total[i] / 32768) ** 2;
  return Math.min(1, Math.sqrt(s / n) * 5);
};

// ---------------------------------------------------------------- 5) grabar
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader', '--window-size=1920,1080', '--hide-scrollbars'],
  defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
page.on('pageerror', e => console.log('pageerror:', e.message));
await page.goto(BASE + '/?capture&nolive', { waitUntil: 'load' });
await page.waitForFunction(() => window.cerebro?.brain?.graph && window.__cerebroStep && window.cerebro.demo, { timeout: 30000 });
await page.evaluate(() => {
  window.cerebro.demo.handle({ k: 'mind', mind: 'pensando' });
  const l = document.querySelector('#loading'); l.style.transition = 'none'; l.style.opacity = 1;
  const c = document.createElement('div'); c.id = 'democur';
  c.innerHTML = '<svg width="28" height="28" viewBox="0 0 26 26"><path d="M3 2 L3 21 L8 16.5 L11.5 24 L14.5 22.7 L11 15.4 L18 15.4 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  c.style.cssText = 'position:fixed;left:0;top:0;z-index:9999;pointer-events:none;opacity:0;filter:drop-shadow(0 2px 5px rgba(0,0,0,.55))';
  const r = document.createElement('div'); r.id = 'demorip';
  r.style.cssText = 'position:fixed;left:0;top:0;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;border:2px solid rgba(255,255,255,.95);box-shadow:0 0 18px rgba(170,160,255,.8);z-index:9998;pointer-events:none;opacity:0';
  document.body.append(c, r);
});
const center = sel => page.evaluate(s => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; }, sel);
const P = { start: [1560, 820], voz: await center('#btn-voice'), probar: await center('#probar'), input: null, rest: [1180, 640] };
const ease = q => (q < 0.5 ? 4 * q * q * q : 1 - Math.pow(-2 * q + 2, 3) / 2);
const clicks = [T.clickVoz, T.clickProbar, T.clickInput, T.enter];
function cursorAt(tt) {
  const inp = P.input || P.probar;
  const seg = [[T.cursorIn, P.start], [T.clickVoz, P.voz], [T.toProbar, P.voz], [T.clickProbar, P.probar], [T.toInput, P.probar],
    [T.clickInput, inp], [T.habla + 1, inp], [T.habla + 3, P.rest], [T.fin, P.rest]];
  if (tt <= seg[0][0]) return seg[0][1];
  for (let i = 0; i < seg.length - 1; i++) {
    const [t0, a] = seg[i], [t1, b] = seg[i + 1];
    if (tt <= t1) { const q = ease(Math.min(1, (tt - t0) / Math.max(0.001, t1 - t0))); return [a[0] + (b[0] - a[0]) * q, a[1] + (b[1] - a[1]) * q]; }
  }
  return seg[seg.length - 1][1];
}

const words = (respuesta.text || '').split(/\s+/).filter(Boolean);
const run = (code, ...args) => page.evaluate(code, ...args);
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
  '-i', 'voz.wav', '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'slow', '-crf', '21', '-maxrate', '7M', '-bufsize', '14M', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-b:a', '192k', '-t', T.fin.toFixed(2), '-movflags', '+faststart', OUT], { stdio: ['pipe', 'inherit', 'inherit'] });
const frames = Math.ceil(T.fin * FPS);
const done = new Set();
const once = async (key, cond, fn) => { if (cond && !done.has(key)) { done.add(key); await fn(); } };
events.sort((a, b) => a[0] - b[0]);
let ei = 0, lastWords = -1, lastTyped = -1, brainT = 0;
const t0 = Date.now();
for (let f = 0; f < frames; f++) {
  const tt = f / FPS;
  while (ei < events.length && events[ei][0] <= tt) {
    for (const ev of events[ei][1]()) await run(e => window.cerebro.demo.handle(e), ev);
    ei++;
  }
  await once('load', tt >= T.load, () => run(() => { const l = document.querySelector('#loading'); l.style.transition = 'opacity .5s'; l.style.opacity = 0; }));
  // el cerebro se presenta
  await once('saludo', tt >= T.saludo, async () => {
    await run(txt => window.cerebro.demo.bubbleHTML(`<div class="who">Tu cerebro</div><div>${txt}</div>`), saludoTxt.replace(/\[[^\]]+\]\s*/g, ''));
    P.input = await center('#vq');
  });
  // escribe la pregunta
  if (tt >= T.clickInput + 0.3 && tt < T.enter) {
    const n = Math.min(PREGUNTA.length, Math.floor((tt - T.clickInput - 0.3) / TYPE));
    if (n !== lastTyped) { lastTyped = n; await run(v => { const i = document.querySelector('#vq'); if (i) { i.value = v; i.focus(); } }, PREGUNTA.slice(0, n)); }
  }
  await once('enter', tt >= T.enter, () => run((q, nodes) => { window.cerebro.demo.bubble(q, '', true); window.cerebro.brain.recall(nodes || []); }, PREGUNTA, respuesta.nodes));
  // contesta hablando de lo que ve
  if (tt >= T.habla && tt < T.hideBubble) {
    const n = Math.min(words.length, Math.ceil(words.length * Math.min(1, (tt - T.habla) / Math.max(0.1, dur(respPCM)))));
    if (n !== lastWords) { lastWords = n; await run((q, txt) => window.cerebro.demo.bubble(q, txt), PREGUNTA, words.slice(0, n).join(' ')); }
  }
  await once('fin-burbuja', tt >= T.hideBubble, () => run(() => window.cerebro.demo.hideBubble()));
  // voz, cursor y clic
  const lv = level(tt);
  const [cx, cy] = cursorAt(tt);
  const lastClick = clicks.filter(c => c <= tt).pop();
  const rk = lastClick != null ? (tt - lastClick) / 0.45 : 2;
  const op = tt < T.cursorIn ? 0 : Math.min(1, (tt - T.cursorIn) / 0.3);
  await run(st => {
    window.cerebro.demo.voice(st.lv, st.lv > 0.01);
    const c = document.getElementById('democur'), r = document.getElementById('demorip');
    c.style.opacity = st.op; c.style.transform = `translate(${st.x - 4}px,${st.y - 3}px) scale(${st.rk < 0.25 ? 0.86 : 1})`;
    r.style.left = st.x + 'px'; r.style.top = st.y + 'px';
    r.style.opacity = st.rk >= 0 && st.rk < 1 ? (1 - st.rk).toFixed(3) : 0; r.style.transform = `scale(${(0.35 + 1.1 * Math.min(1, st.rk)).toFixed(3)})`;
    document.querySelector('#probar').style.background = st.probarOn ? 'var(--accent)' : '';
  }, { lv, x: cx, y: cy, op, rk, probarOn: tt >= T.clickProbar && tt < T.clickProbar + 0.4 });

  brainT = await run(dt => window.__cerebroStep(dt), tt < T.load ? 0.00001 : (brainT < 6 ? INTRO_SPEED : 1) / FPS);
  const buf = await page.screenshot({ type: 'jpeg', quality: 92 });
  if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
  if (f % 90 === 0) console.log(`cuadro ${f}/${frames}  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
}
ff.stdin.end();
await new Promise(r => ff.on('close', r));
await browser.close();
fs.rmSync('voz.wav', { force: true });
console.log('listo:', OUT);

// versión vertical 9:16 (TikTok / Reels / Shorts): el cerebro en grande sobre un fondo desenfocado,
// con subtítulos grandes de lo que dice la voz
const { execFileSync } = await import('node:child_process');
const VERT = OUT.replace(/\.mp4$/, '') + '-vertical.mp4';
const clean = s => (s || '').replace(/\[[^\]]+\]\s*/g, '').replace(/\s+/g, ' ').trim();
const assTime = s => { const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = (s % 60).toFixed(2).padStart(5, '0'); return `${h}:${String(m).padStart(2, '0')}:${x}`; };
function chunks(text, start, secs) { // reparte las palabras en bloques de ~4 según su largo
  const w = clean(text).split(' ').filter(Boolean), groups = [];
  for (let i = 0; i < w.length; i += 4) groups.push(w.slice(i, i + 4).join(' '));
  const total = groups.reduce((s, g) => s + g.length + 2, 0) || 1;
  let t = start;
  return groups.map(g => { const d = (secs * (g.length + 2)) / total; const line = [t, t + d, g]; t += d; return line; });
}
const lines = [...chunks(saludoTxt, T.saludo, dur(saludoPCM)), ...chunks(respuesta.text, T.habla, dur(respPCM))];
fs.writeFileSync('subtitulos.ass', `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Voz,Arial Black,70,&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,6,3,2,70,70,300,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${lines.map(([a, b, txt]) => `Dialogue: 0,${assTime(a)},${assTime(b)},Voz,,0,0,0,,${txt.toUpperCase()}`).join('\n')}
`, 'utf8');
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', OUT, '-filter_complex',
  '[0:v]split=2[a][b];[a]scale=-2:1920,crop=1080:1920,boxblur=30:3,eq=brightness=-0.15[bg];' +
  '[b]crop=1080:1080:620:0[fg];[bg][fg]overlay=0:250,subtitles=subtitulos.ass',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '21', '-maxrate', '8M', '-bufsize', '16M', '-pix_fmt', 'yuv420p',
  '-c:a', 'copy', '-movflags', '+faststart', VERT], { stdio: 'inherit' });
fs.rmSync('subtitulos.ass', { force: true });
console.log('listo:', VERT);

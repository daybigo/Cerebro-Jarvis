// Anatomía procedural del cerebro (campo de distancia con lóbulos reales):
// hemisferios con cisura longitudinal, lóbulo temporal separado por la cisura de Silvio,
// circunvoluciones, cerebelo con folias, tronco con puente y fascículos de fibras internas.
// Coordenadas: x = adelante(+)/atrás(-), y = arriba, z = izquierda/derecha.

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- ruido de Perlin 3D
const P = new Uint8Array(512);
{
  const r = rng(1337);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [p[i], p[j]] = [p[j], p[i]]; }
  for (let i = 0; i < 512; i++) P[i] = p[i & 255];
}
const fade = t => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (t, a, b) => a + t * (b - a);
function grad(h, x, y, z) {
  const u = h < 8 ? x : y, v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
  return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
}
export function noise3(x, y, z) {
  const X = Math.floor(x) & 255, Y = Math.floor(y) & 255, Z = Math.floor(z) & 255;
  x -= Math.floor(x); y -= Math.floor(y); z -= Math.floor(z);
  const u = fade(x), v = fade(y), w = fade(z);
  const A = P[X] + Y, AA = P[A] + Z, AB = P[A + 1] + Z, B = P[X + 1] + Y, BA = P[B] + Z, BB = P[B + 1] + Z;
  return lerp(w,
    lerp(v, lerp(u, grad(P[AA] & 15, x, y, z), grad(P[BA] & 15, x - 1, y, z)),
      lerp(u, grad(P[AB] & 15, x, y - 1, z), grad(P[BB] & 15, x - 1, y - 1, z))),
    lerp(v, lerp(u, grad(P[AA + 1] & 15, x, y, z - 1), grad(P[BA + 1] & 15, x - 1, y, z - 1)),
      lerp(u, grad(P[AB + 1] & 15, x, y - 1, z - 1), grad(P[BB + 1] & 15, x - 1, y - 1, z - 1))));
}
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// ---------- campo de distancia
function sdEll(x, y, z, cx, cy, cz, rx, ry, rz) {
  const px = x - cx, py = y - cy, pz = z - cz;
  const k0 = Math.hypot(px / rx, py / ry, pz / rz);
  const k1 = Math.hypot(px / (rx * rx), py / (ry * ry), pz / (rz * rz));
  return k1 > 1e-9 ? (k0 * (k0 - 1)) / k1 : -Math.min(rx, ry, rz);
}
function smin(a, b, k) { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; }

export const CENTER = [0, 0.6, 0];

// Lóbulos temporales recogidos bajo la corteza, sin bolsas laterales separadas.
function sdBase(x, y, z) {
  const az = Math.abs(z);
  const fr = sdEll(x, y, z, 3.3, 1.95, 0, 4.0, 3.35, 5.6);
  const pa = sdEll(x, y, z, -1.5, 2.25, 0, 4.6, 3.2, 5.9);
  const oc = sdEll(x, y, z, -4.9, 0.75, 0, 2.5, 2.55, 4.8);
  const d = smin(smin(fr, pa, 1.4), oc, 1.2);
  const te = sdEll(x, y, az, 1.0, -0.95, 2.7, 3.1, 1.1, 1.55);
  return smin(d, te, 0.95);
}
// altura del cuerpo calloso (hasta ahí baja la cisura longitudinal)
export const callosumY = x => 2.15 + 0.55 * Math.cos(clamp(x / 5.2, -1, 1) * Math.PI / 2);
export function sdCerebrum(x, y, z) {
  const d = sdBase(x, y, z);
  const w = Math.abs(z) - 0.13;
  const top = Math.max(w, callosumY(x) + 0.35 - y);      // arriba: separa los hemisferios
  const orbit = Math.max(w, y + 0.1, 1.4 - x);            // abajo al frente: lóbulos frontales separados
  const pole = Math.max(w, x + 4.4);                      // polo occipital
  return Math.max(d, -Math.min(top, orbit, pole));
}
export function sdCerebellum(x, y, z) {
  // Un único volumen transversal detrás del tronco; las folias aportan el detalle.
  return sdEll(x, y, z, -4.55, -3.0, 0, 2.35, 1.2, 3.0);
}
export const STEM = { top: [-1.4, -1.2, 0], bottom: [-2.65, -6.5, 0] };

function gradOf(f, x, y, z, e = 0.02) {
  const gx = f(x + e, y, z) - f(x - e, y, z), gy = f(x, y + e, z) - f(x, y - e, z), gz = f(x, y, z + e) - f(x, y, z - e);
  const l = Math.hypot(gx, gy, gz) || 1;
  return [gx / l, gy / l, gz / l];
}
function project(f, p) { // lleva un punto a la superficie f=0
  let [x, y, z] = p;
  for (let i = 0; i < 5; i++) {
    const d = f(x, y, z);
    const [gx, gy, gz] = gradOf(f, x, y, z);
    x -= d * gx; y -= d * gy; z -= d * gz;
    if (Math.abs(d) < 0.002) break;
  }
  return [x, y, z];
}

// circunvoluciones: ruido deformado; los surcos son donde vale ~0
export function gyri(x, y, z) {
  const wx = x + 0.85 * noise3(x * 0.2 + 3.1, y * 0.2, z * 0.2);
  const wy = y + 0.85 * noise3(x * 0.2, y * 0.2 + 5.7, z * 0.2);
  const wz = z + 0.85 * noise3(x * 0.2, y * 0.2, z * 0.2 + 9.3);
  return noise3(wx * 0.55 + 11, wy * 0.55, wz * 0.55) + 0.3 * noise3(wx * 1.2, wy * 1.2 + 7, wz * 1.2);
}

// radio exterior del cerebro visto desde CENTER en la dirección d (tabla precalculada)
const RLAT = 72, RLON = 144;
let RTAB = null;
function buildRadial() {
  RTAB = new Float32Array((RLAT + 1) * (RLON + 1));
  for (let i = 0; i <= RLAT; i++) {
    const th = (Math.PI * i) / RLAT;
    for (let j = 0; j <= RLON; j++) {
      const ph = (2 * Math.PI * j) / RLON;
      const dx = Math.sin(th) * Math.cos(ph), dy = Math.cos(th), dz = Math.sin(th) * Math.sin(ph);
      let t = 13;
      for (let k = 0; k < 400 && t > 0.2; k++) {
        const d = sdBase(CENTER[0] + dx * t, CENTER[1] + dy * t, CENTER[2] + dz * t);
        if (d < 0.004) break;
        t -= Math.max(d * 0.8, 0.02);
      }
      RTAB[i * (RLON + 1) + j] = Math.max(t, 0.5);
    }
  }
}
export function cerebrumRadius(dx, dy, dz) {
  if (!RTAB) buildRadial();
  const th = Math.acos(clamp(dy, -1, 1)), ph = (Math.atan2(dz, dx) + 2 * Math.PI) % (2 * Math.PI);
  const fi = (th / Math.PI) * RLAT, fj = (ph / (2 * Math.PI)) * RLON;
  const i0 = Math.min(RLAT - 1, Math.floor(fi)), j0 = Math.min(RLON - 1, Math.floor(fj)), a = fi - i0, b = fj - j0;
  const R = (i, j) => RTAB[i * (RLON + 1) + j];
  return (R(i0, j0) * (1 - b) + R(i0, j0 + 1) * b) * (1 - a) + (R(i0 + 1, j0) * (1 - b) + R(i0 + 1, j0 + 1) * b) * a;
}
export function brainFrac(x, y, z) {
  const dx = x - CENTER[0], dy = y - CENTER[1], dz = z - CENTER[2];
  const len = Math.hypot(dx, dy, dz) || 1e-6;
  return len / cerebrumRadius(dx / len, dy / len, dz / len);
}

// ---------- geometría
class Buf {
  constructor() { this.pos = []; this.col = []; this.alpha = []; this.size = []; this.nrm = []; this.seed = []; this.start = []; this.t = []; this.phase = []; }
}

function knnGraph(pts, maxD, k) { // vecinos cercanos con una grilla
  const cell = maxD, grid = new Map();
  const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  pts.forEach((p, i) => { const kk = key(p[0], p[1], p[2]); if (!grid.has(kk)) grid.set(kk, []); grid.get(kk).push(i); });
  const pairs = [], done = new Set();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell), cz = Math.floor(p[2] / cell);
    const best = [];
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      const lst = grid.get(`${cx + a},${cy + b},${cz + c}`); if (!lst) continue;
      for (const j of lst) {
        if (j === i) continue;
        const q = pts[j], d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
        if (d < maxD * maxD) best.push([d, j]);
      }
    }
    best.sort((u, v) => u[0] - v[0]);
    for (const [, j] of best.slice(0, k)) {
      const kk = i < j ? i * 1e6 + j : j * 1e6 + i;
      if (!done.has(kk)) { done.add(kk); pairs.push([i, j]); }
    }
  }
  return pairs;
}

export function buildAnatomy(opts = {}) {
  const r = rng(42);
  const pts = new Buf(), web = new Buf(), fibers = new Buf();
  fibers.tan = [];
  const paths = []; // recorridos de las fibras (para los pulsos de datos)

  const startIn = () => {
    const u = r(), v = r(), w = Math.cbrt(r()) * 2.2;
    const th = 2 * Math.PI * u, ph = Math.acos(2 * v - 1);
    return [CENTER[0] + w * Math.sin(ph) * Math.cos(th), CENTER[1] + w * Math.cos(ph), CENTER[2] + w * Math.sin(ph) * Math.sin(th)];
  };
  const tint = () => { const q = r(); return q < 0.62 ? [0.74, 0.77, 1.0] : q < 0.86 ? [0.52, 0.8, 1.0] : [1.0, 0.66, 0.92]; };
  const addPt = (p, c, a, s, n) => {
    pts.pos.push(p[0], p[1], p[2]); pts.col.push(c[0], c[1], c[2]); pts.alpha.push(a); pts.size.push(s);
    pts.nrm.push(n[0], n[1], n[2]); pts.seed.push(r()); const st = startIn(); pts.start.push(st[0], st[1], st[2]);
  };
  const addSeg = (p, q, c, a, n, n2) => {
    for (const [pp, nn] of [[p, n], [q, n2 || n]]) {
      web.pos.push(pp[0], pp[1], pp[2]); web.col.push(c[0], c[1], c[2]); web.alpha.push(a); web.nrm.push(nn[0], nn[1], nn[2]);
    }
  };

  // --- superficie de un campo de distancia: muestreo uniforme en la caja y proyección
  function surfaceOf(f, box, want) {
    const out = [];
    let tries = 0;
    while (out.length < want && tries < want * 40) {
      tries++;
      const p = [box[0] + r() * (box[3] - box[0]), box[1] + r() * (box[4] - box[1]), box[2] + r() * (box[5] - box[2])];
      if (Math.abs(f(p[0], p[1], p[2])) > 0.22) continue;
      const q = project(f, p);
      out.push([q, gradOf(f, q[0], q[1], q[2])]);
    }
    return out;
  }

  // --- corteza
  const relief = g => 0.46 * Math.exp(-((g / 0.095) ** 2)) - 0.10 * smooth(0.12, 0.38, Math.abs(g));
  const N = opts.cortex || 18000;
  const cortex = surfaceOf(sdCerebrum, [-7.8, -3.8, -6.1, 7.8, 5.8, 6.1], N).map(([p, n]) => {
    const g = gyri(p[0], p[1], p[2]);
    const sulc = relief(g);
    const q = [p[0] - n[0] * sulc, p[1] - n[1] * sulc, p[2] - n[2] * sulc];
    return { p: q, n, g, c: tint() };
  });
  for (const s of cortex) {
    const crest = smooth(0.03, 0.26, Math.abs(s.g));
    addPt(s.p, s.c, 0.12 + 0.38 * crest, 0.75 + r() * 0.85 + crest * 0.35, s.n);
  }
  // red fina de la corteza
  const cp = cortex.map(s => s.p);
  for (const [i, j] of knnGraph(cp, 0.48, 3)) addSeg(cp[i], cp[j], cortex[i].c, 0.085, cortex[i].n, cortex[j].n);
  // Una membrana tenue conserva el volumen entre partículas, incluso al girar.
  // Usa el mismo campo y relieve que la corteza, incluida la cisura entre hemisferios.
  const shell = { pos: [], ridge: [], index: [] }, rows = 72, cols = 144;
  for (let i = 0; i <= rows; i++) for (let j = 0; j <= cols; j++) {
    const th = Math.PI * i / rows, ph = 2 * Math.PI * j / cols;
    const d = [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
    let radius = cerebrumRadius(...d) + 0.4;
    for (let k = 0; k < 100; k++) {
      const distance = sdCerebrum(CENTER[0] + d[0] * radius, CENTER[1] + d[1] * radius, CENTER[2] + d[2] * radius);
      if (distance < 0.006 || radius < 0.5) break;
      radius -= Math.max(0.025, distance * 0.8);
    }
    const p = d.map((v, axis) => CENTER[axis] + v * radius);
    const g = gyri(...p), n = gradOf(sdCerebrum, ...p), depth = relief(g);
    shell.pos.push(...p.map((v, axis) => v - n[axis] * (depth + 0.035)));
    shell.ridge.push(smooth(0.03, 0.28, Math.abs(g)));
    if (i < rows && j < cols) {
      const a = i * (cols + 1) + j, b = a + cols + 1;
      shell.index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  // surcos: cruces por cero del ruido entre vecinos, unidos en líneas
  {
    const cross = [];
    for (const [i, j] of knnGraph(cp, 0.5, 5)) {
      const a = cortex[i], b = cortex[j];
      if ((a.g > 0) === (b.g > 0)) continue;
      const t = a.g / (a.g - b.g);
      cross.push([[a.p[0] + (b.p[0] - a.p[0]) * t, a.p[1] + (b.p[1] - a.p[1]) * t, a.p[2] + (b.p[2] - a.p[2]) * t], a.n]);
    }
    const cpts = cross.map(c => c[0]);
    for (const [i, j] of knnGraph(cpts, 0.42, 2)) addSeg(cpts[i], cpts[j], [0.42, 0.78, 1.0], r() < 0.1 ? 0.5 : 0.26, cross[i][1], cross[j][1]);
  }
  // cisuras principales (más marcadas): central, de Silvio y temporal superior, en ambos lados
  const lateral = (x, y, side) => { // punto de la cara lateral a esa altura
    let z = 7;
    for (let k = 0; k < 300 && z > 0; k++) { const d = sdCerebrum(x, y, z); if (d < 0.01) break; z -= Math.max(d * 0.8, 0.02); }
    return [x, y, side * (z - 0.04)];
  };
  const fissures = [
    [[4.4, -0.95], [3.1, -0.4], [1.6, 0.0], [0.1, 0.35], [-1.1, 0.8], [-1.8, 1.45]], // Silvio
    [[0.2, 5.3], [0.55, 4.3], [0.9, 3.1], [1.25, 1.9], [1.45, 0.55]], // central (Rolando)
    [[3.7, -2.0], [2.1, -1.4], [0.3, -1.0], [-1.4, -0.55], [-2.2, 0.1]], // temporal superior
    [[-2.6, 5.2], [-3.3, 4.4], [-3.9, 3.4]], // parieto-occipital
    [[5.8, 3.4], [4.4, 4.2], [2.6, 4.6]], // frontal superior
  ];
  for (const side of [-1, 1]) for (const f of fissures) {
    let prev = null;
    for (let s = 0; s < f.length - 1; s++) for (let k = 0; k <= 8; k++) {
      const t = k / 8, x = f[s][0] + (f[s + 1][0] - f[s][0]) * t, y = f[s][1] + (f[s + 1][1] - f[s][1]) * t;
      const p = lateral(x, y, side), n = gradOf(sdCerebrum, p[0], p[1], p[2]);
      if (prev) addSeg(prev[0], p, [0.5, 0.86, 1.0], 0.55, prev[1], n);
      prev = [p, n];
    }
  }
  // bruma interna
  for (let i = 0; i < 1100; i++) {
    const p = [-6 + r() * 12, -2.5 + r() * 7.5, -4.5 + r() * 9];
    if (sdCerebrum(p[0], p[1], p[2]) > -0.4) { i--; continue; }
    addPt(p, [0.55, 0.5, 1.0], 0.04 + r() * 0.05, 0.9 + r(), [0, 0, 0]);
  }

  // --- cerebelo: superficie + folias (líneas de nivel inclinadas)
  {
    const cb = surfaceOf(sdCerebellum, [-7.1, -4.4, -3.2, -2.0, -1.6, 3.2], 2400).map(([p, n]) => ({ p, n }));
    const tilt = -0.3, ct = Math.cos(tilt), st = Math.sin(tilt);
    const h = p => ((p[1] + 3.0) * ct - (p[0] + 4.55) * st);
    for (const s of cb) addPt(s.p, [0.72, 0.78, 1.0], 0.18 + r() * 0.18, 0.9 + r() * 0.9, s.n);
    const pp = cb.map(s => s.p);
    const cross = [];
    const step = 0.13;
    for (const [i, j] of knnGraph(pp, 0.4, 6)) {
      const la = Math.floor(h(pp[i]) / step), lb = Math.floor(h(pp[j]) / step);
      if (la === lb) continue;
      const lvl = Math.max(la, lb) * step, t = (lvl - h(pp[i])) / (h(pp[j]) - h(pp[i]));
      cross.push({ p: [pp[i][0] + (pp[j][0] - pp[i][0]) * t, pp[i][1] + (pp[j][1] - pp[i][1]) * t, pp[i][2] + (pp[j][2] - pp[i][2]) * t], n: cb[i].n, l: Math.max(la, lb) });
    }
    const byLvl = new Map();
    cross.forEach(c => { if (!byLvl.has(c.l)) byLvl.set(c.l, []); byLvl.get(c.l).push(c); });
    for (const list of byLvl.values()) {
      const lp = list.map(c => c.p);
      for (const [i, j] of knnGraph(lp, 0.45, 2)) addSeg(lp[i], lp[j], [0.8, 0.85, 1.0], 0.3, list[i].n, list[j].n);
    }
  }

  // --- tronco: fibras verticales azules con el puente
  const T = STEM.top, B = STEM.bottom;
  const stemC = t => [T[0] + (B[0] - T[0]) * t - 0.35 * Math.sin(t * Math.PI), T[1] + (B[1] - T[1]) * t, 0];
  const stemR = t => 0.85 + 0.55 * Math.exp(-(((t - 0.27) / 0.11) ** 2)) - 0.3 * t;
  for (let f = 0; f < 60; f++) {
    const ang = (2 * Math.PI * f) / 60 + r() * 0.05, inner = r() < 0.25;
    const col = inner ? [0.45, 0.65, 1.0] : [0.34, 0.5, 1.0];
    let prev = null, prevN = null;
    for (let s = 0; s <= 30; s++) {
      const t = s / 30, cc = stemC(t), R = stemR(t) * (inner ? 0.45 : 0.95);
      const n = [Math.cos(ang), 0, Math.sin(ang)];
      const p = [cc[0] + n[0] * R * 0.85, cc[1], cc[2] + n[2] * R];
      if (prev) addSeg(prev, p, col, inner ? 0.3 : 0.15, prevN, n);
      prev = p; prevN = n;
    }
  }
  for (let i = 0; i < 1000; i++) {
    const t = r(), cc = stemC(t), R = stemR(t) * (0.7 + 0.3 * r()), ang = r() * Math.PI * 2;
    addPt([cc[0] + Math.cos(ang) * R * 0.85, cc[1], cc[2] + Math.sin(ang) * R], [0.5, 0.65, 1.0], 0.14 + r() * 0.12, 1 + r(), [Math.cos(ang), 0, Math.sin(ang)]);
  }

  // --- fascículos de fibras (tractografía)
  const catmull = (pts, t) => {
    const n = pts.length - 1, f = clamp(t, 0, 1) * n, i = Math.min(n - 1, Math.floor(f)), u = f - i;
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(n, i + 2)];
    return [0, 1, 2].map(k => 0.5 * (2 * p1[k] + (-p0[k] + p2[k]) * u + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * u * u + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * u * u * u));
  };
  const addFiber = (ctrl, col, alpha, segs = 36) => {
    const ph = r(), path = [];
    for (let s = 0; s <= segs; s++) path.push(catmull(ctrl, s / segs));
    for (let s = 0; s < segs; s++) {
      const a = path[s], b2 = path[s + 1], tl = Math.hypot(b2[0] - a[0], b2[1] - a[1], b2[2] - a[2]) || 1;
      const tan = [(b2[0] - a[0]) / tl, (b2[1] - a[1]) / tl, (b2[2] - a[2]) / tl];
      for (const [pp, tt] of [[a, s / segs], [b2, (s + 1) / segs]]) {
        fibers.pos.push(pp[0], pp[1], pp[2]); fibers.col.push(col[0], col[1], col[2]); fibers.alpha.push(alpha);
        fibers.t.push(tt); fibers.phase.push(ph); fibers.start.push(0, 0, 0); fibers.tan.push(tan[0], tan[1], tan[2]);
      }
    }
    paths.push({ pts: path, col });
  };
  // un haz = varias fibras paralelas alrededor de un recorrido, que se abren en las puntas
  const bundle = (center, n, radius, fan, col, alpha, mirror = true) => {
    for (const side of mirror ? [-1, 1] : [1]) for (let k = 0; k < n; k++) {
      const o = [(r() - 0.5) * 2, (r() - 0.5) * 2, (r() - 0.5) * 2];
      const ctrl = center.map((c, i) => {
        const t = i / (center.length - 1), spread = radius * (1 + fan * ((2 * Math.abs(t - 0.5)) ** 2));
        return [c[0] + o[0] * spread, c[1] + o[1] * spread, side * (c[2] + o[2] * spread * 0.8)];
      });
      addFiber(ctrl, col, alpha * (0.7 + 0.6 * r()));
    }
  };
  // cíngulo: el gran arco en C cerca de la línea media
  bundle([[4.9, 0.4, 0.9], [4.4, 2.5, 0.9], [2.4, 3.7, 0.9], [0, 4.0, 0.9], [-2.4, 3.7, 0.9], [-4.2, 2.4, 0.9], [-4.7, 0.6, 0.9], [-3.8, -0.6, 1.2]], 26, 0.26, 2.2, [0.32, 0.9, 1.0], 0.24);
  // fascículo longitudinal superior + arcuato (lateral, baja al temporal)
  bundle([[5.3, 1.8, 3.2], [3.4, 3.3, 3.4], [0.8, 3.8, 3.5], [-1.8, 3.5, 3.5], [-3.4, 2.4, 3.4], [-3.2, 0.8, 3.5], [-1.6, -0.4, 3.6], [0.6, -1.2, 3.6], [2.3, -1.5, 3.5]], 22, 0.3, 1.8, [0.3, 0.95, 0.85], 0.26);
  // fronto-occipital / longitudinal inferior
  bundle([[5.6, 0.6, 2.4], [3.6, 0.0, 2.6], [1.5, -0.6, 2.8], [-1.0, -0.7, 2.8], [-3.2, -0.2, 2.6], [-5.3, 0.4, 2.3], [-6.4, 0.9, 1.9]], 18, 0.28, 2.0, [0.42, 0.7, 1.0], 0.24);
  // unciforme: gancho frontal-temporal
  bundle([[4.8, -0.2, 2.3], [4.0, -0.9, 2.7], [3.4, -1.5, 3.0], [3.5, -2.2, 3.2], [2.5, -2.6, 3.3]], 8, 0.18, 1.5, [1.0, 0.5, 0.82], 0.28);
  // cuerpo calloso: cruza de un hemisferio al otro
  for (let k = 0; k < 80; k++) {
    const x = -3.6 + r() * 7.2, yb = callosumY(x) - 0.05, J = () => (r() - 0.5) * 0.6;
    addFiber([[x + J(), yb + 1.2 + J(), -3.6 - r()], [x, yb + 0.5, -1.6], [x, yb, 0], [x, yb + 0.5, 1.6], [x + J(), yb + 1.2 + J(), 3.6 + r()]], [0.76, 0.46, 1.0], 0.16, 28);
  }
  // corona radiada -> cápsula interna -> tronco
  for (let k = 0; k < 90; k++) {
    const side = r() < 0.5 ? -1 : 1;
    let dx = -0.6 + r() * 1.6, dy = 0.35 + r() * 0.65, dz = side * (0.25 + r() * 0.7);
    const l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
    const rr = cerebrumRadius(dx, dy, dz) * 0.86;
    const top = [CENTER[0] + dx * rr, CENTER[1] + dy * rr, CENTER[2] + dz * rr];
    const J = () => (r() - 0.5) * 0.35;
    addFiber([top, [top[0] * 0.55, top[1] * 0.6 + 0.6, top[2] * 0.6], [0.2 + J(), 0.3, side * 1.15], [-0.9 + J(), -1.3, side * 0.8], [-1.9 + J(), -3.2, side * 0.5], [-2.6 + J(), -6.4, side * 0.3]], [0.4, 0.56, 1.0], 0.2, 40);
  }
  // pedúnculos cerebelosos
  bundle([[-2.0, -3.3, 0.5], [-3.0, -3.0, 1.2], [-4.3, -2.8, 1.9], [-5.6, -3.2, 2.5]], 14, 0.2, 1.8, [0.56, 0.64, 1.0], 0.26);

  // --- estrellas
  const stars = { pos: [], size: [], col: [], seed: [] };
  for (let i = 0; i < 2600; i++) {
    let dx = r() * 2 - 1, dy = r() * 2 - 1, dz = r() * 2 - 1;
    const l = Math.hypot(dx, dy, dz) || 1, d = 55 + r() * 170;
    stars.pos.push((dx / l) * d, (dy / l) * d, (dz / l) * d);
    stars.size.push(0.6 + Math.pow(r(), 3) * 2.4);
    const q = r(); stars.col.push(...(q < 0.7 ? [0.85, 0.88, 1] : q < 0.9 ? [0.7, 0.8, 1] : [1, 0.85, 0.95]));
    stars.seed.push(r());
  }
  return { pts, web, fibers, stars, paths, shell };
}

// volúmenes del cerebelo y el tronco para ubicar notas (la corteza usa bandas por lóbulo)
export const REGION_SHAPES = {
  prefrontal: { c: [5.2, 1.4, 0], r: [1.5, 1.9, 3.9] },
  frontal: { c: [2.9, 3.1, 0], r: [2.0, 1.45, 4.2] },
  parietal: { c: [-2.5, 3.5, 0], r: [2.1, 1.35, 4.2] },
  occipital: { c: [-5.2, 1.5, 0], r: [1.4, 1.6, 3.5] },
  temporal: { c: [0.9, -0.95, 0], r: [2.6, 0.8, 3.8] },
  cerebelo: { c: [-4.55, -3.0, 0], r: [1.65, 0.72, 2.5] },
  tronco: { c: [-2.1, -4.35, 0], r: [0.7, 1.65, 0.7] },
};

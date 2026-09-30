// Escena 3D del cerebro: anatomía + neuronas (notas) + conexiones + actividad en vivo.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { buildAnatomy, REGION_SHAPES, CENTER, brainFrac, cerebrumRadius, rng } from './anatomy.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const easeIO = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOut = t => 1 - Math.pow(1 - t, 3);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const EDGE_SEGMENTS = 32;
const bezierPoint = (a, b, c, d, t, out) => {
  const u = 1 - t, aa = u * u * u, bb = 3 * u * u * t, cc = 3 * u * t * t, dd = t * t * t;
  return out.set(aa * a.x + bb * b.x + cc * c.x + dd * d.x, aa * a.y + bb * b.y + cc * c.y + dd * d.y, aa * a.z + bb * b.z + cc * c.z + dd * d.z);
};
export const hexRGB = h => { const n = parseInt(h.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const HOT = `uniform vec4 uHot[8];
uniform vec4 uWaves[6], uWaveColors[6]; uniform float uWaveClock;
float hotAt(vec3 p){ float h=0.; for(int i=0;i<8;i++){ vec3 d=p-uHot[i].xyz; h+=uHot[i].w*exp(-dot(d,d)/3.5);} return min(h,2.0); }
vec3 waveAt(vec3 p){
  vec3 light=vec3(0.);
  for(int i=0;i<6;i++){
    float age=uWaveClock-uWaves[i].w;
    float radius=length(p-uWaves[i].xyz);
    float band=(radius-age*5.2)/0.48;
    float life=step(0.,age)*max(0.,1.-age/2.2);
    light+=uWaveColors[i].rgb*uWaveColors[i].w*exp(-band*band)*life*life;
  }
  return light;
}`;

const SHELL_VS = `
attribute float ridge; uniform float uReveal; ${HOT}
varying vec3 vNormal, vView, vWave; varying float vRidge, vHot;
void main(){
  vec4 mv=modelViewMatrix*vec4(position,1.);
  vNormal=normalize(normalMatrix*normal); vView=normalize(-mv.xyz);
  vRidge=ridge; vHot=hotAt(position); vWave=waveAt(position);
  gl_Position=projectionMatrix*mv;
}`;
const SHELL_FS = `
uniform float uReveal, uLight; varying vec3 vNormal, vView, vWave; varying float vRidge, vHot;
void main(){
  float rim=pow(1.-abs(dot(normalize(vNormal),normalize(vView))),2.);
  float diffuse=max(0.,dot(normalize(vNormal),normalize(vec3(-.4,.8,1.))));
  vec3 col=mix(vec3(.045,.05,.14),vec3(.24,.35,.55),vRidge)*(.45+.55*diffuse);
  col+=vWave*.45+vec3(.32,.38,.55)*vHot*.1;
  if(uLight>.5) col=mix(vec3(.2,.24,.4),col,.25);
  gl_FragColor=vec4(col,(.08+.12*rim+.08*vRidge)*uReveal);
}`;

const PTS_VS = `
attribute vec3 color; attribute float alpha; attribute float size; attribute vec3 nrm; attribute vec3 start; attribute float seed;
uniform float uTime, uReveal, uPR, uGlow, uTwinkle;
${HOT}
varying vec3 vColor; varying float vAlpha;
void main(){
  float rv = clamp((uReveal - seed*0.45)/0.55, 0., 1.); rv = rv*rv*(3.-2.*rv);
  vec3 p = mix(start, position, rv);
  vec4 mv = modelViewMatrix*vec4(p,1.);
  float rimF = 1.0;
  if (dot(nrm,nrm) > 0.01) { vec3 n = normalize(normalMatrix*nrm); float rim = 1.0-abs(dot(n, normalize(-mv.xyz))); rimF = 0.28 + 1.55*rim*rim; }
  float hot = hotAt(p);
  float tw = 1.0 + uTwinkle*0.28*sin(uTime*1.3 + seed*60.0);
  vec3 wave = waveAt(p);
  vColor = color*(1.0+hot*0.7) + vec3(0.95,0.85,1.0)*hot*0.25 + wave*2.8;
  vAlpha = alpha*rimF*tw*uGlow*(0.3+0.7*rv)*(1.0+hot*0.6);
  gl_PointSize = size*uPR*34.0/-mv.z*(1.0+hot*0.35+length(wave)*0.75);
  gl_Position = projectionMatrix*mv;
}`;
const PTS_FS = `
uniform float uLight; varying vec3 vColor; varying float vAlpha;
void main(){
  float d = length(gl_PointCoord-0.5);
  float a = smoothstep(0.5, 0.0, d);
  vec3 c = uLight > 0.5 ? mix(vColor*0.3, vec3(0.2,0.18,0.45), 0.4) : vColor;
  gl_FragColor = vec4(c, vAlpha*a*(uLight>0.5?1.6:1.0));
}`;

const WEB_VS = `
attribute vec3 color; attribute float alpha; attribute vec3 nrm;
uniform float uLines, uGlow;
${HOT}
varying vec3 vColor; varying float vAlpha;
void main(){
  vec4 mv = modelViewMatrix*vec4(position,1.);
  float rimF = 1.0;
  if (dot(nrm,nrm) > 0.01) { vec3 n = normalize(normalMatrix*nrm); float rim = 1.0-abs(dot(n, normalize(-mv.xyz))); rimF = 0.3 + 1.45*rim*rim; }
  float hot = hotAt(position);
  vColor = color*(1.0+hot*0.8) + waveAt(position)*2.0;
  vAlpha = alpha*rimF*uLines*uGlow*(1.0+hot*0.6);
  gl_Position = projectionMatrix*mv;
}`;
const LINE_FS = `
uniform float uLight; varying vec3 vColor; varying float vAlpha;
void main(){
  vec3 c = uLight > 0.5 ? mix(vColor*0.3, vec3(0.2,0.2,0.45), 0.4) : vColor;
  gl_FragColor = vec4(c, vAlpha*(uLight>0.5?1.4:1.0));
}`;

const FIB_VS = `
attribute vec3 color; attribute float alpha; attribute float t; attribute float phase; attribute vec3 tan;
uniform float uTime, uFibers, uFlow, uGlow;
${HOT}
varying vec3 vColor; varying float vAlpha;
void main(){
  vec4 mv = modelViewMatrix*vec4(position,1.);
  float pulse = uFlow*pow(smoothstep(0.84, 1.0, fract(t*1.1 - uTime*0.2 + phase)), 2.0)*0.6;
  float hot = hotAt(position);
  vColor = color*(0.7 + pulse*1.2 + hot*0.5) + waveAt(position)*1.4;
  // una fibra que apunta a la cámara se ve "de punta": se atenúa para no quemar la imagen
  float side = length(cross(normalize(normalMatrix*tan), normalize(-mv.xyz)));
  vAlpha = alpha*0.42*uFibers*uGlow*(1.0 + pulse*1.5 + hot*0.6)*(0.12 + 0.88*side*side);
  gl_Position = projectionMatrix*mv;
}`;

const STAR_VS = `
attribute float size; attribute vec3 color; attribute float seed;
uniform float uTime, uPR, uStars, uTwinkle;
varying vec3 vColor; varying float vAlpha;
void main(){
  vec4 mv = modelViewMatrix*vec4(position,1.);
  vColor = color;
  vAlpha = uStars*(0.55 + 0.45*(1.0 - uTwinkle + uTwinkle*sin(uTime*(0.6+seed*2.0) + seed*30.0)));
  gl_PointSize = size*uPR;
  gl_Position = projectionMatrix*mv;
}`;

const SOMA_VS = `
attribute vec3 color; attribute float size; attribute float rot; attribute float focus; attribute float excite; attribute float vis;
uniform float uPR, uFocusOn, uScale;
varying vec3 vColor; varying float vAlpha; varying float vRot; varying float vExcite;
void main(){
  vec4 mv = modelViewMatrix*vec4(position,1.);
  float f = mix(1.0, mix(0.1, 1.0, focus), uFocusOn);
  vColor = color; vRot = rot; vExcite = excite; vAlpha = vis*f;
  float s = size*(1.0 + excite*0.45 + focus*uFocusOn*0.3);
  gl_PointSize = vis > 0.001 ? s*uPR*uScale/-mv.z : 0.0;
  gl_Position = projectionMatrix*mv;
}`;
const SOMA_FS = `
uniform float uLight;
varying vec3 vColor; varying float vAlpha; varying float vRot; varying float vExcite;
void main(){
  vec2 uv = (gl_PointCoord - 0.5)*2.0; uv.y = -uv.y;
  float c = cos(vRot), s = sin(vRot); uv = mat2(c,-s,s,c)*uv;
  float angle = atan(uv.y, uv.x), radius = length(uv);
  // Soma irregular y prolongaciones afinadas, con un núcleo visible al acercarse.
  float lobes = pow(max(0., cos(angle*5. + .45*sin(angle*3.))), 5.);
  float contour = .34 + .055*sin(angle*3.+.8) + .28*lobes;
  float d = radius - contour;
  float aa = max(fwidth(d), .025);
  float fill = 1. - smoothstep(-aa, aa, d);
  float membrane = exp(-abs(d)*28.);
  float halo = exp(-max(d,0.)*10.)*.18;
  float nucleus = 1. - smoothstep(.095, .135, length(uv-vec2(-.035,.025)));
  float nucleolus = 1. - smoothstep(.022, .05, length(uv-vec2(-.055,.01)));
  vec3 col = vColor*(.6 + .2*(1.-radius) + membrane*.25);
  col = mix(col, vColor*.32 + vec3(.035,.065,.075), nucleus*.8);
  col += vColor*nucleolus*.35 + vec3(.8,.95,1.)*exp(-radius*5.)*vExcite*.7;
  if (uLight > .5) col *= .72;
  float a = (fill*.95 + halo*(uLight>.5?.2:.55))*vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a);
}`;

const EDGE_VS = `
attribute vec3 color; attribute float alpha; attribute float focus; attribute float vis; attribute float dist; attribute float style; attribute float phase;
uniform float uFocusOn, uReveal;
varying vec3 vColor; varying float vAlpha; varying float vDist; varying float vStyle; varying float vPhase;
void main(){
  vec4 mv = modelViewMatrix*vec4(position,1.);
  vColor = color; vDist = dist; vStyle = style; vPhase = phase;
  vAlpha = alpha*vis*uReveal*mix(1.0, mix(0.03, 1.4, focus), uFocusOn);
  gl_Position = projectionMatrix*mv;
}`;
const EDGE_FS = `
uniform float uTime, uFlow, uLight;
varying vec3 vColor; varying float vAlpha; varying float vDist; varying float vStyle; varying float vPhase;
void main(){
  if (vAlpha < 0.003) discard;
  if (vStyle > 0.5 && vStyle < 1.5) { if (fract(vDist*2.4) > 0.55) discard; }
  else if (vStyle > 1.5) { if (fract(vDist*5.5) > 0.38) discard; }
  float pulse = uFlow*pow(smoothstep(0.86, 1.0, fract(vDist*0.14 - uTime*0.45 + vPhase)), 2.0);
  vec3 c = uLight > 0.5 ? vColor*0.7 : vColor*(1.0 + pulse*1.8);
  gl_FragColor = vec4(c, vAlpha*(1.0 + pulse*1.3));
}`;

const SIG_VS = `
attribute vec3 color; attribute float alpha; attribute float size;
uniform float uPR, uSig;
varying vec3 vColor; varying float vAlpha;
void main(){
  vec4 mv = modelViewMatrix*vec4(position,1.);
  vColor = color; vAlpha = alpha*uSig;
  gl_PointSize = alpha > 0.001 ? size*uPR*30.0/-mv.z : 0.0;
  gl_Position = projectionMatrix*mv;
}`;
const SIG_FS = `
varying vec3 vColor; varying float vAlpha;
void main(){
  float d = length(gl_PointCoord-0.5);
  float a = smoothstep(0.5, 0.0, d); a = a*a;
  float core = smoothstep(0.22, 0.0, d);
  gl_FragColor = vec4(vColor*(0.9 + core*1.6), vAlpha*(a + core*0.6));
}`;

const RIB_VS = `
attribute vec3 nextPos; attribute float side; attribute float u;
uniform float uWidth; uniform vec2 uRes;
varying float vU; varying float vSide;
void main(){
  vec4 a = projectionMatrix*modelViewMatrix*vec4(position,1.);
  vec4 b = projectionMatrix*modelViewMatrix*vec4(nextPos,1.);
  vec2 sa = a.xy/a.w, sb = b.xy/b.w;
  vec2 d = (sb - sa)*uRes; float L = length(d);
  vec2 dir = L > 1e-5 ? d/L : vec2(1.,0.);
  vec2 nrm = vec2(-dir.y, dir.x);
  a.xy += nrm*side*uWidth/uRes*a.w;
  vU = u; vSide = side;
  gl_Position = a;
}`;
const RIB_FS = `
uniform vec3 uColor; uniform float uHead, uLife, uTail;
varying float vU; varying float vSide;
void main(){
  if (vU > uHead) discard;
  float head = smoothstep(uHead - 0.07, uHead, vU);
  float tail = smoothstep(uHead - uTail, uHead - uTail + 0.15, vU);
  float edge = exp(-vSide*vSide*3.5);
  float a = (0.12 + 0.88*head)*uLife*edge*tail;
  gl_FragColor = vec4(mix(uColor,uColor*.5+vec3(1.),head)*(1.0 + head*1.8), a);
}`;

function canvasTex(draw, size = 128) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  draw(c.getContext('2d'), size);
  const t = new THREE.CanvasTexture(c); t.needsUpdate = true; return t;
}
const GLOW_TEX = () => canvasTex((g, s) => {
  const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.2, 'rgba(255,255,255,0.6)');
  gr.addColorStop(0.5, 'rgba(255,255,255,0.15)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, s, s);
});
const RING_TEX = () => canvasTex((g, s) => {
  g.strokeStyle = 'rgba(255,255,255,0.95)'; g.lineWidth = s * 0.018;
  g.beginPath(); g.arc(s / 2, s / 2, s * 0.46, 0, Math.PI * 2); g.stroke();
  const gr = g.createRadialGradient(s / 2, s / 2, s * 0.38, s / 2, s / 2, s * 0.5);
  gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.8, 'rgba(255,255,255,0.18)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, s, s);
}, 256);
const NEBULA_TEX = () => canvasTex((g, s) => {
  const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  gr.addColorStop(0, 'rgba(46,36,120,0.30)'); gr.addColorStop(0.35, 'rgba(34,26,96,0.2)');
  gr.addColorStop(0.7, 'rgba(16,14,52,0.08)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, s, s);
}, 256);

// ------------------------------------------------------------------ capa de etiquetas HTML
class Labels {
  constructor(el) { this.el = el; this.items = new Map(); }
  begin() { for (const it of this.items.values()) it.used = false; }
  get(key, cls) {
    let it = this.items.get(key);
    if (!it) {
      const d = document.createElement('div'); d.className = 'lab ' + cls; this.el.appendChild(d);
      it = { el: d, html: null, pos: new THREE.Vector3(), ox: 0, oy: 0, op: 1, cls };
      this.items.set(key, it);
    }
    it.used = true; it.ox = 0; it.oy = 0; it.op = 1;
    return it;
  }
  html(it, h) { if (it.html !== h) { it.el.innerHTML = h; it.html = h; } }
  end(camera, w, h, cz, R) {
    const v = new THREE.Vector3();
    const placed = [];
    const list = [];
    for (const [k, it] of this.items) {
      if (!it.used) { it.el.remove(); this.items.delete(k); continue; }
      v.copy(it.pos).project(camera);
      if (v.z > 1 || Math.abs(v.x) > 1.3 || Math.abs(v.y) > 1.3) { it.el.style.opacity = 0; continue; }
      if (it.sizeFor !== it.html) { it.bw = it.el.offsetWidth; it.bh = it.el.offsetHeight; it.sizeFor = it.html; }
      const depth = -it.pos.clone().applyMatrix4(camera.matrixWorldInverse).z;
      list.push({ it, x: (v.x * 0.5 + 0.5) * w + it.ox, y: (-v.y * 0.5 + 0.5) * h + it.oy, depth });
    }
    // primero los grupos, después píldoras, después notas: los de menor prioridad se corren
    const pri = it => (it.cls.startsWith('lab-group') ? 0 : it.cls.startsWith('lab-pill') ? 1 : 2);
    list.sort((a, b) => pri(a.it) - pri(b.it) || a.depth - b.depth);
    for (const L of list) {
      const { it } = L;
      const bw = it.bw || 80, bh = it.bh || 16;
      const ax = it.cls.startsWith('lab-group') || it.cls.includes('sess') ? -bw / 2 : 0;
      const ay = it.cls.includes('sess') ? -bh : -bh / 2;
      let y = L.y;
      for (let tries = 0; tries < 4; tries++) {
        const box = [L.x + ax, y + ay, L.x + ax + bw, y + ay + bh];
        const hit = placed.find(b => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
        if (!hit) break;
        y = hit[3] - ay + 2;
      }
      placed.push([L.x + ax, y + ay, L.x + ax + bw, y + ay + bh]);
      const rel = (L.depth - cz) / R;
      const op = it.op * (1 - 0.62 * smooth(-0.35, 0.95, rel));
      it.el.style.translate = `${L.x.toFixed(1)}px ${y.toFixed(1)}px`;
      it.el.style.opacity = op.toFixed(3);
      it.el.style.zIndex = String(1000 - Math.round(L.depth * 10));
    }
  }
}

// ------------------------------------------------------------------ el cerebro
export class Brain {
  constructor(canvas, labelsEl, hooks = {}) {
    this.canvas = canvas;
    this.hooks = hooks;
    this.labels = new Labels(labelsEl);
    this.anim = true;
    this.follow = true;
    this.light = false;
    this.focusOn = 0;
    this.focusTarget = 0;
    this.selected = -1;
    this.hover = -1;
    this.highlight = null;
    this.colorMode = 'grupos';
    this.usage = {};
    this.mind = 'pensando';
    this.clock = { last: performance.now(), getDelta() { const n = performance.now(), d = (n - this.last) / 1000; this.last = n; return d; } };
    this.time = 0;
    this.actors = new Map();
    this.trails = [];
    this.flashes = [];
    this.sparks = [];
    this.fileTags = new Map();
    this.sessions = [];
    this.activeNodes = new Map(); // node -> hasta cuándo mostrar etiqueta
    this.lastActivity = -1e9;
    this.activityPts = [];
    this.lastInteract = -1e9;
    this.dreamNext = 0;
    this.voiceLevel = 0;
    this.lastActivityMs = 0;
    this.waveCursor = 0;
    this.waveClock = 0;
    this.waves = Array.from({ length: 6 }, () => new THREE.Vector4(0, 0, 0, -100));
    this.waveColors = Array.from({ length: 6 }, () => new THREE.Vector4(0, 0, 0, 0));

    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    r.outputColorSpace = THREE.LinearSRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.1;
    r.setClearColor(0x05060d, 1);
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(36, 1, 0.1, 1200);
    this.camera.position.set(0, 3, 200);
    this.controls = new OrbitControls(this.camera, canvas);
    Object.assign(this.controls, { enableDamping: true, dampingFactor: 0.07, rotateSpeed: 0.55, zoomSpeed: 0.8, minDistance: 6, maxDistance: 90 });
    this.controls.target.set(...CENTER);
    this.controls.addEventListener('start', () => { this.lastInteract = this.time; this.dragging = true; });
    this.controls.addEventListener('end', () => { this.lastInteract = this.time; this.dragging = false; });

    this.composer = new EffectComposer(r);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.68, 0.52, 0.85);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.hot = Array.from({ length: 8 }, () => new THREE.Vector4(0, -999, 0, 0));
    this.glowTex = GLOW_TEX();
    this.ringTex = RING_TEX();
    this.u = {
      uTime: { value: 0 }, uReveal: { value: 0 }, uPR: { value: r.getPixelRatio() }, uGlow: { value: 1 },
      uTwinkle: { value: 1 }, uLight: { value: 0 }, uHot: { value: this.hot }, uLines: { value: 0 },
      uFibers: { value: 0 }, uFlow: { value: 1 }, uStars: { value: 0 },
      uWaves: { value: this.waves }, uWaveColors: { value: this.waveColors }, uWaveClock: { value: 0 },
    };
    this.buildAnatomy();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.bindPointer();
    this.intro = { t0: -1, done: false };
    this.running = true;
    this.queue = [];
    // modo captura (?capture): el reloj avanza a mano, cuadro por cuadro, para grabar videos perfectos
    this.manual = new URLSearchParams(location.search).has('capture');
    if (this.manual) window.__cerebroStep = (dt = 1 / 30) => { this.stepDt = dt; this.frame(); return this.time; };
    else {
      const loop = () => { if (!this.running) return; requestAnimationFrame(loop); this.frame(); };
      requestAnimationFrame(loop);
    }
  }

  // ---------------- anatomía
  buildAnatomy() {
    const A = buildAnatomy();
    const u = this.u;
    const mk = (b, attrs) => {
      const g = new THREE.BufferGeometry();
      for (const [name, arr, n] of attrs) g.setAttribute(name, new THREE.Float32BufferAttribute(arr, n));
      return g;
    };
    const add = (name, b) => { const x = b; x.name = name; this.scene.add(x); return x; };
    const waveUniforms = { uWaves: u.uWaves, uWaveColors: u.uWaveColors, uWaveClock: u.uWaveClock };
    const shellGeo = mk(A.shell, [['position', A.shell.pos, 3], ['ridge', A.shell.ridge, 1]]);
    shellGeo.setIndex(A.shell.index); shellGeo.computeVertexNormals();
    this.shellMat = new THREE.ShaderMaterial({
      uniforms: { ...waveUniforms, uHot: u.uHot, uReveal: u.uReveal, uLight: u.uLight },
      vertexShader: SHELL_VS, fragmentShader: SHELL_FS, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    add('cortical-membrane', new THREE.Mesh(shellGeo, this.shellMat)).renderOrder = -2;
    const ptsMat = new THREE.ShaderMaterial({
      uniforms: { ...waveUniforms, uTime: u.uTime, uReveal: u.uReveal, uPR: u.uPR, uGlow: u.uGlow, uTwinkle: u.uTwinkle, uLight: u.uLight, uHot: u.uHot },
      vertexShader: PTS_VS, fragmentShader: PTS_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.ptsMat = ptsMat;
    add('cortex', new THREE.Points(mk(A.pts, [['position', A.pts.pos, 3], ['color', A.pts.col, 3], ['alpha', A.pts.alpha, 1], ['size', A.pts.size, 1],
      ['nrm', A.pts.nrm, 3], ['start', A.pts.start, 3], ['seed', A.pts.seed, 1]]), ptsMat)).frustumCulled = false;
    const webMat = new THREE.ShaderMaterial({
      uniforms: { ...waveUniforms, uLines: u.uLines, uGlow: u.uGlow, uLight: u.uLight, uHot: u.uHot },
      vertexShader: WEB_VS, fragmentShader: LINE_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.webMat = webMat;
    add('web', new THREE.LineSegments(mk(A.web, [['position', A.web.pos, 3], ['color', A.web.col, 3], ['alpha', A.web.alpha, 1], ['nrm', A.web.nrm, 3]]), webMat));
    const fibMat = new THREE.ShaderMaterial({
      uniforms: { ...waveUniforms, uTime: u.uTime, uFibers: u.uFibers, uFlow: u.uFlow, uGlow: u.uGlow, uLight: u.uLight, uHot: u.uHot },
      vertexShader: FIB_VS, fragmentShader: LINE_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.fibMat = fibMat;
    add('fibers', new THREE.LineSegments(mk(A.fibers, [['position', A.fibers.pos, 3], ['color', A.fibers.col, 3], ['alpha', A.fibers.alpha, 1],
      ['t', A.fibers.t, 1], ['phase', A.fibers.phase, 1], ['tan', A.fibers.tan, 3]]), fibMat));
    const starMat = new THREE.ShaderMaterial({
      uniforms: { uTime: u.uTime, uPR: u.uPR, uStars: u.uStars, uTwinkle: u.uTwinkle },
      vertexShader: STAR_VS, fragmentShader: PTS_FS.replace('uniform float uLight;', 'const float uLight = 0.0;'),
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.stars = add('stars', new THREE.Points(mk(A.stars, [['position', A.stars.pos, 3], ['size', A.stars.size, 1], ['color', A.stars.col, 3], ['seed', A.stars.seed, 1]]), starMat));
    this.nebula = new THREE.Sprite(new THREE.SpriteMaterial({ map: NEBULA_TEX(), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
    this.nebula.scale.set(64, 64, 1); this.nebula.position.set(...CENTER); this.nebula.renderOrder = -10;
    this.scene.add(this.nebula);
    this.introRing = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.ringTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, color: 0xc8ccff }));
    this.introRing.position.set(...CENTER); this.scene.add(this.introRing);
    this.introDot = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0, color: 0xdfe4ff }));
    this.introDot.position.set(...CENTER); this.scene.add(this.introDot);
    // bruma de actividad (nubes blancas donde se trabaja)
    this.haze = this.hot.map(() => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color: 0xffe6f6, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
      s.scale.set(5, 5, 1); this.scene.add(s); return s;
    });
    this.buildSignals(A.paths);
    this.hoverGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0 }));
    this.hoverGlow.renderOrder = 8; this.scene.add(this.hoverGlow);
  }

  // ---------------- datos viajando: pulsos por las fibras y paquetes entre notas (sinapsis)
  buildSignals(paths) {
    this.fpaths = paths.map(p => ({ pts: p.pts, col: p.col.map(c => Math.min(1, c * 1.25 + 0.15)) }));
    const TR = this.SIG_TRAIL = 8;
    const NF = this.SIG_N = 600;       // fondo tenue: los eventos reales dominan la luz
    const NP = this.PKT_N = 260;       // paquetes entre notas
    const tot = (NF + NP) * TR;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tot * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(tot * 3), 3));
    g.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(tot), 1));
    g.setAttribute('size', new THREE.BufferAttribute(new Float32Array(tot), 1));
    this.sigMat = new THREE.ShaderMaterial({
      uniforms: { uPR: this.u.uPR, uSig: { value: 0 } },
      vertexShader: SIG_VS, fragmentShader: SIG_FS, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.sigPts = new THREE.Points(g, this.sigMat);
    this.sigPts.frustumCulled = false; this.sigPts.renderOrder = 7;
    this.scene.add(this.sigPts);
    const R = Math.random;
    this.sig = Array.from({ length: NF }, () => ({ p: Math.floor(R() * this.fpaths.length), u: R(), v: 0.05 + R() * 0.13, d: R() < 0.5 ? 1 : -1 }));
    this.pkts = [];
    this.pktClock = 0;
  }

  samplePath(pts, u, out) {
    const f = Math.min(0.9999, Math.max(0, u)) * (pts.length - 1), i = Math.floor(f), k = f - i, a = pts[i], b = pts[i + 1];
    out[0] = a[0] + (b[0] - a[0]) * k; out[1] = a[1] + (b[1] - a[1]) * k; out[2] = a[2] + (b[2] - a[2]) * k;
    return out;
  }

  edgeControls(A, B, c1, c2) {
    const lo = Math.min(A, B), hi = Math.max(A, B), a = this.pos[lo], b = this.pos[hi];
    const dir = this.edgeDir ||= new THREE.Vector3(), bend = this.edgeBend ||= new THREE.Vector3();
    const cross = this.edgeCross ||= new THREE.Vector3(), axis = this.edgeAxis ||= new THREE.Vector3();
    dir.subVectors(b, a); const length = dir.length(); dir.normalize();
    axis.set(0, Math.abs(dir.y) < 0.9 ? 1 : 0, Math.abs(dir.y) < 0.9 ? 0 : 1);
    bend.crossVectors(dir, axis).normalize(); cross.crossVectors(dir, bend).normalize();
    const angle = ((lo * 17 + hi * 31) % 101) / 101 * Math.PI * 2;
    bend.multiplyScalar(Math.cos(angle)).addScaledVector(cross, Math.sin(angle));
    const bow = Math.min(2.6, length * 0.32);
    c1.lerpVectors(a, b, 0.3).addScaledVector(bend, bow);
    c2.lerpVectors(a, b, 0.7).addScaledVector(bend, -bow * 0.65);
    // El recorrido es idéntico en ambos sentidos, también para los paquetes de luz.
    if (A > B) { axis.copy(c1); c1.copy(c2); c2.copy(axis); }
  }

  // dispara paquetes desde una nota hacia sus vecinas (la señal se propaga)
  firePackets(i, max = 8, col = null) {
    if (!this.anim || !this.adj?.[i] || !this.vis[i]) return;
    const nb = this.adj[i].filter(([j, t]) => this.edgeOn[t] && this.vis[j]).sort(() => Math.random() - 0.5).slice(0, max);
    const visited = new Set([i, ...nb.map(([j]) => j)]);
    nb.forEach(([, , e], k) => this.spawnPacket(e, i, col, { energy: 1, hops: 1, visited, delay: k * 0.035 }));
  }
  spawnPacket(e, from, col = null, { energy = 0.25, hops = 0, visited = null, delay = 0 } = {}) {
    if (this.pkts.length >= this.PKT_N) this.pkts.shift();
    const [A, B] = this.graph.edges[e];
    const src = from === B ? B : A, dst = src === A ? B : A;
    const v = 1 / (0.42 + this.pos[src].distanceTo(this.pos[dst]) * 0.07);
    this.pkts.push({ e, src, dst, t: -delay * v, v, col: col || this.nodeColor(src), energy, hops, visited });
  }

  updateSignals(dt) {
    if (!this.sigPts) return;
    const flowBy = { trabajando: 1.7, pensando: 1.1, listo: 0.9, descansando: 0.45, conectando: 0.8 };
    flowBy['soñando'] = 0.6;
    const flow = flowBy[this.mind] ?? 1;
    const dream = this.mind === 'soñando';
    const visBy = { descansando: 0.55 }; visBy['soñando'] = 0.75;
    const target = this.intro.done ? (visBy[this.mind] ?? 1) : smooth(4.2, 5.4, this.time - this.intro.t0);
    this.sigMat.uniforms.uSig.value += (target - this.sigMat.uniforms.uSig.value) * Math.min(1, dt * 2);
    const at = this.sigPts.geometry.attributes, P = at.position.array, C = at.color.array, AL = at.alpha.array, SZ = at.size.array;
    const TR = this.SIG_TRAIL, tmp = [0, 0, 0];
    let k = 0;
    const put = (x, y, z, c, a, s) => { P[k * 3] = x; P[k * 3 + 1] = y; P[k * 3 + 2] = z; C[k * 3] = c[0]; C[k * 3 + 1] = c[1]; C[k * 3 + 2] = c[2]; AL[k] = a; SZ[k] = s; k++; };
    const pink = [1, 0.55, 0.85];
    for (const s of this.sig) {
      s.u += s.v * s.d * dt * flow * (this.anim ? 1 : 0);
      if (s.u > 1 || s.u < 0) { s.p = Math.floor(Math.random() * this.fpaths.length); s.u = s.d > 0 ? 0 : 1; }
      const fp = this.fpaths[s.p], edge = Math.min(1, s.u / 0.06, (1 - s.u) / 0.06);
      const col = dream ? pink : fp.col;
      for (let q = 0; q < TR; q++) {
        this.samplePath(fp.pts, s.u - s.d * q * 0.011, tmp);
        put(tmp[0], tmp[1], tmp[2], col, edge * (q === 0 ? 0.38 : 0.18 * (1 - q / TR)), q === 0 ? 2.0 : 1.6 - q * 0.12);
      }
    }
    // paquetes entre notas: la sinapsis
    if (this.graph && this.intro.done && this.anim) {
      const rateBy = { trabajando: 10, pensando: 4, listo: 2, descansando: 1 }; rateBy['soñando'] = 2;
      this.pktClock += dt * (rateBy[this.mind] ?? 10);
      const E = this.graph.edges;
      while (this.pktClock > 1 && E.length) {
        this.pktClock -= 1;
        const e = Math.floor(Math.random() * E.length);
        if (this.edgeOn[E[e][2]] && this.vis[E[e][0]] && this.vis[E[e][1]]) this.spawnPacket(e, Math.random() < 0.5 ? E[e][0] : E[e][1]);
      }
    }
    const c = new THREE.Vector3(), d = new THREE.Vector3(), point = new THREE.Vector3();
    const arrived = [];
    this.pkts = this.pkts.filter(pk => {
      if (!this.pos[pk.src] || !this.pos[pk.dst] || !this.vis[pk.src] || !this.vis[pk.dst] || !this.edgeOn[this.graph.edges[pk.e]?.[2]]) return false;
      pk.t += dt * pk.v * (this.anim ? 1 : 0);
      if (pk.t >= 1) { arrived.push(pk); return false; }
      return true;
    });
    for (const pk of arrived) {
      this.excite[pk.dst] = Math.min(2.5, this.excite[pk.dst] + pk.energy);
      if (pk.energy < 0.5) continue;
      const color = new THREE.Color(...pk.col), p = this.pos[pk.dst];
      this.flash(p, color, 0.45 * pk.energy);
      this.hotspot(p, 0.18 * pk.energy);
      if (pk.hops > 0) {
        const next = this.adj[pk.dst].filter(([j, ty]) => this.vis[j] && this.edgeOn[ty] && !pk.visited.has(j)).slice(0, 2);
        for (const [j, , e] of next) {
          pk.visited.add(j);
          this.spawnPacket(e, pk.dst, pk.col, { energy: pk.energy * 0.6, hops: pk.hops - 1, visited: pk.visited, delay: 0.06 });
        }
      }
    }
    for (const pk of this.pkts) {
      if (pk.t < 0) continue;
      const a = this.pos[pk.src], b = this.pos[pk.dst];
      this.edgeControls(pk.src, pk.dst, c, d);
      for (let q = 0; q < TR; q++) {
        const t = Math.max(0, pk.t - q * 0.025);
        bezierPoint(a, c, d, b, t, point);
        put(point.x, point.y, point.z,
          pk.col, (q === 0 ? 1 : 0.6 * (1 - q / TR)) * Math.min(1, pk.t * 12) * pk.energy, q === 0 ? 5.5 : 3.8 - q * 0.3);
      }
    }
    for (let i = k; i < AL.length; i++) AL[i] = 0;
    at.position.needsUpdate = true; at.color.needsUpdate = true; at.alpha.needsUpdate = true; at.size.needsUpdate = true;
  }

  // ---------------- datos
  setGraph(graph, { keepLayout = false } = {}) {
    const old = this.graph ? new Map(this.graph.nodes.map((n, i) => [n.id, this.pos[i]])) : null;
    this.graph = graph;
    this.pkts.length = 0;
    const n = graph.nodes.length;
    this.groupRGB = graph.groups.map(g => hexRGB(g.color));
    this.vis = new Float32Array(n).fill(1);
    this.pop = new Float32Array(n).fill(this.intro.done ? 1 : 0);
    this.excite = new Float32Array(n);
    this.focus = new Float32Array(n);
    this.edgeOn = graph.edgeTypes.map(e => e.on);
    this.nodeRnd = graph.nodes.map((nd, i) => rng(parseInt(nd.id.slice(0, 8), 16) || i));
    this.adj = Array.from({ length: n }, () => []);
    graph.edges.forEach(([a, b, t], k) => { this.adj[a].push([b, t, k]); this.adj[b].push([a, t, k]); });
    this.layout(7);
    if (old && keepLayout) {
      graph.nodes.forEach((nd, i) => {
        const p = old.get(nd.id);
        if (p) this.pos[i].copy(p); else { this.pop[i] = 0; this.popQueue = (this.popQueue || []).concat([[i, this.time + 0.3]]); }
      });
    }
    this.buildNodes();
    this.buildEdges();
    this.computeGroupCenters();
    this.topNodes = graph.nodes.map((nd, i) => [graph.typeIds[nd.ty] === 'indice' ? -1 : nd.i, i]).sort((a, b) => b[0] - a[0]).slice(0, 18).map(x => x[1]);
    if (!this.intro.done && this.intro.t0 < 0) this.intro.t0 = this.time;
  }

  layout(seed) {
    // Cada grupo vive en su lóbulo. En la corteza las notas se reparten como una banda cerca de la
    // superficie (como en el video); el cerebelo y el tronco usan su propio volumen.
    const g = this.graph, r = rng(seed);
    const n = g.nodes.length;
    const LOBE = {
      prefrontal: { th: 0.08, sp: 0.36, band: [0.5, 0.88] },
      frontal: { th: 0.86, sp: 0.36, band: [0.56, 0.9] },
      parietal: { th: 2.2, sp: 0.4, band: [0.56, 0.9] },
      occipital: { th: 2.95, sp: 0.34, band: [0.5, 0.88] },
      temporal: { th: -1.15, sp: 0.5, band: [0.3, 0.86], lat: true },
    };
    const byRegion = {};
    g.groups.forEach((gr, gi) => (byRegion[gr.region] ||= []).push(gi));
    const sub = [];
    for (const [rid, gl] of Object.entries(byRegion)) {
      const total = gl.reduce((s, gi) => s + g.groups[gi].count, 0) || 1;
      let acc = 0;
      for (const gi of gl) {
        const f0 = acc / total, f1 = (acc + g.groups[gi].count) / total; acc += g.groups[gi].count;
        if (LOBE[rid]) {
          const L = LOBE[rid];
          const a0 = L.th - L.sp + 2 * L.sp * f0, a1 = L.th - L.sp + 2 * L.sp * f1;
          sub[gi] = { rid, cortex: true, a0: Math.min(a0, a1 - 0.14), a1: Math.max(a1, a0 + 0.14), band: L.band, lat: L.lat };
        } else {
          const R = REGION_SHAPES[rid] || REGION_SHAPES.temporal;
          const axis = R.r[1] > R.r[2] ? 1 : 2;
          const c = R.c.slice(), rr = R.r.slice();
          c[axis] = R.c[axis] + R.r[axis] * (f0 + f1 - 1);
          rr[axis] = Math.max(R.r[axis] * (f1 - f0), 0.8);
          sub[gi] = { c, r: rr, rid };
        }
      }
    }
    this.sub = sub;
    const cortexPoint = (th, z, f) => {
      const k = Math.sqrt(Math.max(0, 1 - z * z));
      const dx = Math.cos(th) * k, dy = Math.sin(th) * k, dz = z;
      const R = cerebrumRadius(dx, dy, dz) * f;
      return new THREE.Vector3(CENTER[0] + dx * R, CENTER[1] + dy * R, CENTER[2] + dz * R);
    };
    const toCortex = p => {
      const dx = p.x - CENTER[0], dy = p.y - CENTER[1], dz = p.z - CENTER[2];
      const len = Math.hypot(dx, dy, dz) || 1e-6;
      const z = dz / len, th = Math.atan2(dy, dx);
      return { th, z, f: len / cerebrumRadius(dx / len, dy / len, dz / len) };
    };
    const pos = this.pos = [];
    for (let i = 0; i < n; i++) {
      const s = sub[g.nodes[i].g];
      if (s.cortex) {
        const th = s.a0 + (s.a1 - s.a0) * r();
        const z = s.lat ? (r() < 0.5 ? -1 : 1) * (0.42 + r() * 0.4) : (r() * 2 - 1) * 0.82;
        const f = s.band[0] + (s.band[1] - s.band[0]) * Math.sqrt(r());
        pos.push(cortexPoint(th, z, f));
      } else {
        let p;
        do {
          const u = r() * 2 - 1, v = r() * 2 - 1, w = r() * 2 - 1;
          if (u * u + v * v + w * w <= 1) p = new THREE.Vector3(s.c[0] + u * s.r[0], s.c[1] + v * s.r[1], s.c[2] + w * s.r[2]);
        } while (!p);
        pos.push(p);
      }
    }
    // relajación: repulsión dentro de la región + resortes suaves + contención
    const regionOf = i => sub[g.nodes[i].g].rid;
    const groupsIdx = {};
    for (let i = 0; i < n; i++) (groupsIdx[regionOf(i)] ||= []).push(i);
    const springs = g.edges.filter(([a, b, t]) => t <= 3 && regionOf(a) === regionOf(b));
    const tmp = new THREE.Vector3();
    for (let it = 0; it < 140; it++) {
      for (const idx of Object.values(groupsIdx)) {
        const minD = idx.length > 60 ? 0.85 : 1.0;
        for (let a = 0; a < idx.length; a++) for (let b = a + 1; b < idx.length; b++) {
          const pa = pos[idx[a]], pb = pos[idx[b]];
          tmp.subVectors(pa, pb); const d = tmp.length() || 0.001;
          if (d < minD) { tmp.multiplyScalar(((minD - d) / d) * 0.5); pa.add(tmp); pb.sub(tmp); }
        }
      }
      for (const [a, b] of springs) {
        tmp.subVectors(pos[b], pos[a]); const d = tmp.length() || 0.001;
        tmp.multiplyScalar(((d - 1.6) / d) * 0.008); pos[a].add(tmp); pos[b].sub(tmp);
      }
      for (let i = 0; i < n; i++) {
        const s = sub[g.nodes[i].g], p = pos[i];
        if (s.cortex) {
          const c = toCortex(p);
          const th = clamp(c.th, s.a0 - 0.05, s.a1 + 0.05), z = clamp(c.z, -0.86, 0.86), f = clamp(c.f, s.band[0], s.band[1]);
          if (th !== c.th || z !== c.z || f !== c.f) p.copy(cortexPoint(th, z, f));
        } else {
          p.x += (s.c[0] - p.x) * 0.003; p.y += (s.c[1] - p.y) * 0.003; p.z += (s.c[2] - p.z) * 0.003;
          const qx = (p.x - s.c[0]) / s.r[0], qy = (p.y - s.c[1]) / s.r[1], qz = (p.z - s.c[2]) / s.r[2];
          const q = Math.hypot(qx, qy, qz);
          if (q > 1.15) { const k = 1.15 / q; p.set(s.c[0] + qx * k * s.r[0], s.c[1] + qy * k * s.r[1], s.c[2] + qz * k * s.r[2]); }
        }
      }
    }
  }

  nodeColor(i) {
    if (this.colorMode === 'uso') {
      const u = this.usage[i] || 0;
      if (!u) return [0.3, 0.33, 0.48];
      const t = clamp(Math.log2(1 + u) / Math.log2(1 + (this.maxUse || 1)), 0, 1);
      const stops = [[0.25, 0.48, 1.0], [0.25, 0.9, 1.0], [1.0, 0.82, 0.25], [1.0, 0.35, 0.25]];
      const x = t * 3, k = Math.min(2, Math.floor(x)), f = x - k;
      return stops[k].map((c, j) => c + (stops[k + 1][j] - c) * f);
    }
    return this.groupRGB[this.graph.nodes[i].g];
  }

  nodeSize(i) {
    const nd = this.graph.nodes[i];
    const crowd = clamp(1.3 - this.graph.groups[nd.g].count / 180, 0.72, 1);
    let s = (1.15 + 0.42 * nd.i) * crowd;
    if (this.colorMode === 'uso') s = 1.0 + 0.9 * Math.log2(1 + (this.usage[i] || 0));
    return Math.min(s, 5.2);
  }

  buildNodes() {
    if (this.somas) { this.scene.remove(this.somas, this.dendrites); this.somas.geometry.dispose(); this.dendrites.geometry.dispose(); }
    const n = this.graph.nodes.length;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('size', new THREE.BufferAttribute(new Float32Array(n), 1));
    g.setAttribute('rot', new THREE.BufferAttribute(new Float32Array(n), 1));
    g.setAttribute('focus', new THREE.BufferAttribute(this.focus, 1));
    g.setAttribute('excite', new THREE.BufferAttribute(this.excite, 1));
    g.setAttribute('vis', new THREE.BufferAttribute(new Float32Array(n), 1));
    this.somaMat ||= new THREE.ShaderMaterial({
      uniforms: { uPR: this.u.uPR, uFocusOn: { value: 0 }, uScale: { value: 210 }, uLight: this.u.uLight },
      vertexShader: SOMA_VS, fragmentShader: SOMA_FS, transparent: true, depthWrite: false,
    });
    this.somas = new THREE.Points(g, this.somaMat);
    this.somas.frustumCulled = false; this.somas.renderOrder = 5;
    this.scene.add(this.somas);
    // Dendritas curvas y bifurcadas; la forma local queda estable al reacomodar.
    this.dendShape = this.graph.nodes.map((nd, i) => {
      const R = rng((parseInt(nd.id.slice(0, 8), 16) || i) ^ 0x5a17);
      const positions = [], alpha = [], rotation = R() * Math.PI * 2;
      const L = 0.25 + 0.065 * this.nodeSize(i), origin = new THREE.Vector3();
      const curve = (a, c, b, steps, strength) => {
        for (let k = 0; k < steps; k++) for (const t of [k / steps, (k + 1) / steps]) {
          const u = 1 - t;
          positions.push(u*u*a.x + 2*u*t*c.x + t*t*b.x, u*u*a.y + 2*u*t*c.y + t*t*b.y, u*u*a.z + 2*u*t*c.z + t*t*b.z);
          alpha.push(strength * (1 - t * 0.65));
        }
      };
      for (let branch = 0; branch < 5; branch++) {
        const angle = rotation + branch * Math.PI * 2 / 5 + (R() - 0.5) * 0.3;
        const dir = new THREE.Vector3(Math.cos(angle), Math.sin(angle), (R() - 0.5) * 0.7).normalize();
        const bend = new THREE.Vector3(-dir.y, dir.x, 0);
        const end = dir.clone().multiplyScalar(L * (1.05 + R() * 0.65));
        const ctrl = end.clone().multiplyScalar(0.5).addScaledVector(bend, L * (R() - 0.5) * 0.8);
        curve(origin, ctrl, end, 10, 0.46);
        const fork = ctrl.clone().multiplyScalar(2 * 0.65 * 0.35).addScaledVector(end, 0.65 * 0.65);
        for (const sign of [-1, 1]) {
          const tip = fork.clone().addScaledVector(dir, L * 0.38).addScaledVector(bend, sign * L * (0.28 + R() * 0.24));
          const turn = fork.clone().addScaledVector(dir, L * 0.24).addScaledVector(bend, sign * L * 0.05);
          curve(fork, turn, tip, 6, 0.3);
        }
      }
      return { positions, alpha, rotation };
    });
    const nv = this.dendShape.reduce((s, d) => s + d.alpha.length, 0);
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
    dg.setAttribute('color', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
    for (const nm of ['alpha', 'focus', 'vis', 'dist', 'style', 'phase']) dg.setAttribute(nm, new THREE.BufferAttribute(new Float32Array(nv), 1));
    this.dendMat ||= new THREE.ShaderMaterial({
      uniforms: { uFocusOn: { value: 0 }, uReveal: { value: 1 }, uTime: this.u.uTime, uFlow: { value: 0 }, uLight: this.u.uLight },
      vertexShader: EDGE_VS, fragmentShader: EDGE_FS, transparent: true, depthWrite: false, blending: THREE.NormalBlending,
    });
    this.dendrites = new THREE.LineSegments(dg, this.dendMat);
    this.dendrites.frustumCulled = false;
    this.scene.add(this.dendrites);
    this.updateNodeGeometry();
    this.refreshNodeStyle();
  }

  updateNodeGeometry() {
    const n = this.graph.nodes.length, P = this.somas.geometry.attributes.position.array;
    const rot = this.somas.geometry.attributes.rot.array;
    const up = new THREE.Vector3(), cen = new THREE.Vector3(...CENTER), side = new THREE.Vector3(), normal = new THREE.Vector3();
    const D = this.dendrites.geometry.attributes.position.array;
    let k = 0;
    for (let i = 0; i < n; i++) {
      const p = this.pos[i];
      P[i * 3] = p.x; P[i * 3 + 1] = p.y; P[i * 3 + 2] = p.z;
      rot[i] = this.dendShape[i].rotation;
      up.subVectors(p, cen).normalize().lerp(new THREE.Vector3(0, 1, 0), 0.55).normalize();
      side.crossVectors(up, new THREE.Vector3(0.3, 0.1, 1)).normalize();
      normal.crossVectors(side, up).normalize();
      const local = this.dendShape[i].positions;
      for (let j = 0; j < local.length; j += 3) {
        const x = local[j], y = local[j + 1], z = local[j + 2];
        D[k++] = p.x + side.x*x + up.x*y + normal.x*z;
        D[k++] = p.y + side.y*x + up.y*y + normal.y*z;
        D[k++] = p.z + side.z*x + up.z*y + normal.z*z;
      }
    }
    this.somas.geometry.attributes.position.needsUpdate = true;
    this.somas.geometry.attributes.rot.needsUpdate = true;
    this.dendrites.geometry.attributes.position.needsUpdate = true;
    this.somas.geometry.computeBoundingSphere();
  }

  refreshNodeStyle() {
    const n = this.graph.nodes.length;
    const C = this.somas.geometry.attributes.color.array, S = this.somas.geometry.attributes.size.array, VS = this.somas.geometry.attributes.vis.array;
    const dA = this.dendrites.geometry.attributes;
    let k = 0;
    this.maxUse = Math.max(1, ...Object.values(this.usage));
    for (let i = 0; i < n; i++) {
      const c = this.nodeColor(i);
      C[i * 3] = c[0]; C[i * 3 + 1] = c[1]; C[i * 3 + 2] = c[2];
      S[i] = this.nodeSize(i);
      const v = this.vis[i] * this.pop[i];
      VS[i] = v;
      const alpha = this.dendShape[i].alpha;
      for (let s = 0; s < alpha.length; s++) {
        dA.color.array[k * 3] = c[0]; dA.color.array[k * 3 + 1] = c[1]; dA.color.array[k * 3 + 2] = c[2];
        dA.alpha.array[k] = alpha[s] * (this.colorMode === 'uso' && !this.usage[i] ? 0.35 : 1);
        dA.vis.array[k] = v; dA.focus.array[k] = this.focus[i];
        k++;
      }
    }
    for (const a of ['color', 'size', 'vis']) this.somas.geometry.attributes[a].needsUpdate = true;
    for (const a of ['color', 'alpha', 'vis', 'focus']) dA[a].needsUpdate = true;
    this.somas.geometry.attributes.focus.needsUpdate = true;
  }

  buildEdges() {
    if (this.edgeMesh) { this.scene.remove(this.edgeMesh); this.edgeMesh.geometry.dispose(); }
    const E = this.graph.edges, SEG = EDGE_SEGMENTS, nv = E.length * SEG * 2;
    const g = new THREE.BufferGeometry();
    for (const [nm, sz] of [['position', 3], ['color', 3], ['alpha', 1], ['focus', 1], ['vis', 1], ['dist', 1], ['style', 1], ['phase', 1]])
      g.setAttribute(nm, new THREE.BufferAttribute(new Float32Array(nv * sz), sz));
    this.edgeMat ||= new THREE.ShaderMaterial({
      uniforms: { uFocusOn: { value: 0 }, uReveal: { value: 0 }, uTime: this.u.uTime, uFlow: this.u.uFlow, uLight: this.u.uLight },
      vertexShader: EDGE_VS, fragmentShader: EDGE_FS, transparent: true, depthWrite: false, blending: THREE.NormalBlending,
    });
    this.edgeMesh = new THREE.LineSegments(g, this.edgeMat);
    this.edgeMesh.frustumCulled = false; this.edgeMesh.renderOrder = 2;
    this.scene.add(this.edgeMesh);
    this.updateEdgeGeometry();
    this.refreshEdgeStyle();
  }

  updateEdgeGeometry() {
    const E = this.graph.edges, SEG = EDGE_SEGMENTS;
    const P = this.edgeMesh.geometry.attributes.position.array, D = this.edgeMesh.geometry.attributes.dist.array;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), d = new THREE.Vector3(), p = new THREE.Vector3(), q = new THREE.Vector3();
    let k = 0;
    for (let e = 0; e < E.length; e++) {
      a.copy(this.pos[E[e][0]]); b.copy(this.pos[E[e][1]]);
      this.edgeControls(E[e][0], E[e][1], c, d);
      let dist = 0; q.copy(a);
      for (let s = 0; s < SEG; s++) {
        const t0 = s / SEG, t1 = (s + 1) / SEG;
        for (const t of [t0, t1]) {
          bezierPoint(a, c, d, b, t, p);
          if (t === t1) dist += p.distanceTo(q);
          P[k * 3] = p.x; P[k * 3 + 1] = p.y; P[k * 3 + 2] = p.z; D[k] = t === t0 ? dist - 0 : dist;
          if (t === t0) q.copy(p);
          k++;
        }
        D[k - 2] = dist - p.distanceTo(q); // inicio del segmento
      }
    }
    this.edgeMesh.geometry.attributes.position.needsUpdate = true;
    this.edgeMesh.geometry.attributes.dist.needsUpdate = true;
  }

  refreshEdgeStyle() {
    const E = this.graph.edges, SEG = EDGE_SEGMENTS, at = this.edgeMesh.geometry.attributes;
    const alphaBy = { wiki: 0.42, indice: 0.14, enlace: 0.42, responde: 0.38, mencion: 0.22, carpeta: 0.3, cadena: 0.3, sugerida: 0.5, parecida: 0.3, comparte: 0.18 };
    const styleBy = { 'solid-strong': 0, solid: 0, dashed: 1, dotted: 2 };
    let k = 0, shown = 0;
    for (let e = 0; e < E.length; e++) {
      const [A, B, t] = E[e];
      const et = this.graph.edgeTypes[t];
      const on = this.edgeOn[t] && this.vis[A] && this.vis[B];
      if (on) shown++;
      const ca = this.nodeColor(A), cb = this.nodeColor(B);
      const al = (alphaBy[et.id] ?? 0.3) * (this.colorMode === 'uso' ? 0.45 : 0.82);
      const sty = styleBy[et.style] ?? 0;
      const white = et.id === 'sugerida';
      const f = Math.max(this.focus[A], this.focus[B]) > 0.9 && (this.selected < 0 || A === this.selected || B === this.selected || this.highlight) ? 1 : 0;
      const ph = ((A * 7 + B * 13) % 97) / 97;
      const v = on ? Math.min(this.pop[A], this.pop[B]) : 0;
      for (let s = 0; s < SEG * 2; s++) {
        const tt = Math.ceil(s / 2) / SEG;
        const c = white ? [0.85, 0.88, 1.0] : [ca[0] + (cb[0] - ca[0]) * tt, ca[1] + (cb[1] - ca[1]) * tt, ca[2] + (cb[2] - ca[2]) * tt];
        at.color.array[k * 3] = c[0]; at.color.array[k * 3 + 1] = c[1]; at.color.array[k * 3 + 2] = c[2];
        at.alpha.array[k] = al; at.vis.array[k] = v; at.style.array[k] = sty; at.phase.array[k] = ph; at.focus.array[k] = f;
        k++;
      }
    }
    for (const a of ['color', 'alpha', 'vis', 'style', 'phase', 'focus']) at[a].needsUpdate = true;
    this.visibleEdges = shown;
  }

  computeGroupCenters() {
    const g = this.graph;
    this.gcenter = g.groups.map(() => new THREE.Vector3());
    const cnt = g.groups.map(() => 0);
    g.nodes.forEach((nd, i) => { this.gcenter[nd.g].add(this.pos[i]); cnt[nd.g]++; });
    const cen = new THREE.Vector3(...CENTER);
    this.gcenter.forEach((c, gi) => {
      if (cnt[gi]) c.multiplyScalar(1 / cnt[gi]);
      const out = c.clone().sub(cen); out.y += 1.2;
      c.addScaledVector(out.normalize(), 1.3);
    });
  }

  // ---------------- filtros / modos
  setFilter(nodeVis, edgeOn) {
    this.vis.set(nodeVis);
    this.edgeOn = edgeOn.slice();
    this.refreshNodeStyle();
    this.refreshEdgeStyle();
  }
  visibleCounts() { return { nodes: this.vis.reduce((s, v) => s + v, 0), edges: this.visibleEdges || 0 }; }

  setColorMode(mode, usage) {
    this.colorMode = mode;
    if (usage) this.usage = usage;
    this.refreshNodeStyle(); this.refreshEdgeStyle();
  }
  setUsage(usage) { this.usage = usage || {}; if (this.colorMode === 'uso') this.setColorMode('uso'); }

  select(i, { fly = true } = {}) {
    this.selected = i;
    this.highlight = null;
    this.focus.fill(0);
    if (i >= 0) {
      this.focus[i] = 1;
      for (const [j, t] of this.adj[i]) if (this.edgeOn[t]) this.focus[j] = 1;
      this.focusTarget = 1;
      const color = new THREE.Color(...this.nodeColor(i));
      this.excite[i] = 2.2;
      this.hotspot(this.pos[i], 0.65);
      this.flash(this.pos[i], color, 1.15);
      this.firePackets(i, 7, this.nodeColor(i));
      if (this.anim) this.spark(this.pos[i], color);
      if (fly) this.flyTo(this.pos[i], 17);
    } else this.focusTarget = 0;
    this.refreshNodeStyle(); this.refreshEdgeStyle();
  }
  setHighlight(set) {
    if (this.selected >= 0 && set) this.selected = -1;
    this.highlight = set && set.size ? set : null;
    this.focus.fill(0);
    if (this.highlight) { for (const i of this.highlight) this.focus[i] = 1; this.focusTarget = 1; }
    else if (this.selected < 0) this.focusTarget = 0;
    this.refreshNodeStyle(); this.refreshEdgeStyle();
  }

  setTheme(light) {
    this.light = light;
    this.u.uLight.value = light ? 1 : 0;
    this.renderer.setClearColor(light ? 0xeef0f8 : 0x05060d, 1);
    const blend = light ? THREE.NormalBlending : THREE.AdditiveBlending;
    for (const m of [this.ptsMat, this.webMat, this.fibMat]) { if (m) { m.blending = blend; m.needsUpdate = true; } }
    this.bloom.strength = light ? 0.12 : 0.68;
    this.nebula.visible = !light; this.stars.visible = !light;
  }
  setAnimations(on) {
    this.anim = on;
    this.u.uTwinkle.value = on ? 1 : 0;
    this.u.uFlow.value = on ? 1 : 0;
    if (!on && !this.intro.done) this.finishIntro();
    if (!on) {
      this.pkts.length = 0;
      this.waveColors.forEach(c => { c.w = 0; });
      for (const f of this.flashes) f.t0 = -100;
      for (const s of this.sparks) s.t0 = -100;
      for (const a of this.actors.values()) if (a.move) {
        a.pos.copy(a.move.to); if (a.move.tr) a.move.tr.done = this.time; a.move = null;
      }
    }
  }

  // ---------------- cámara
  flyTo(target, dist, dur = 1.4) {
    const cam = this.camera, ctl = this.controls;
    const dir = cam.position.clone().sub(ctl.target).normalize();
    this.fly = { t0: this.time, dur, fromT: ctl.target.clone(), toT: target.clone(), fromD: cam.position.distanceTo(ctl.target), toD: dist, dir };
    this.lastInteract = this.time;
  }
  zoom(f) { this.flyTo(this.controls.target.clone(), clamp(this.camera.position.distanceTo(this.controls.target) * f, 6, 90), 0.5); }
  fitDistance() { return Math.max(23.5, 19 / Math.max(0.5, this.camera.aspect)); }
  fit() { this.select(-1); this.flyTo(new THREE.Vector3(CENTER[0], CENTER[1] - 1.4, CENTER[2]), this.fitDistance(), 1.2); }
  relayout() {
    const from = this.pos.map(p => p.clone());
    this.layout(Math.floor(Math.random() * 1e6));
    const to = this.pos.map(p => p.clone());
    this.pos = from;
    this.morph = { t0: this.time, from, to, dur: 1.4 };
  }

  // ---------------- intro
  finishIntro() {
    this.intro.done = true;
    this.pop.fill(1);
    this.u.uReveal.value = 1; this.u.uLines.value = 1; this.u.uFibers.value = 1; this.u.uStars.value = 1;
    this.edgeMat.uniforms.uReveal.value = 1; this.nebula.material.opacity = 0.85;
    this.introRing.material.opacity = 0; this.introDot.material.opacity = 0;
    this.camera.position.set(CENTER[0] - 1.5, CENTER[1] + 2.2, CENTER[2] - this.fitDistance());
    this.controls.target.set(CENTER[0], CENTER[1] - 1.4, CENTER[2]);
    this.refreshNodeStyle(); this.refreshEdgeStyle();
    this.hooks.onIntroDone?.();
  }
  runIntro() {
    const t = this.time - this.intro.t0;
    const u = this.u;
    u.uStars.value = smooth(0.0, 1.2, t);
    this.nebula.material.opacity = 0.85 * smooth(0.8, 3.0, t);
    // la cámara vuela desde lejos (el frente del cerebro queda a la izquierda, como en el video)
    const k = easeIO(clamp((t - 0.35) / 3.4, 0, 1));
    const dist = 150 * (1 - k) + this.fitDistance() * k;
    const az = 0.55 * (1 - k);
    this.camera.position.set(CENTER[0] - 1.5 * k + Math.sin(az) * dist * 0.35, CENTER[1] + 2.2, CENTER[2] - Math.cos(az) * dist);
    this.controls.target.set(CENTER[0] + 7 * (1 - k), CENTER[1] - 1.4 * k + 4.5 * (1 - k), CENTER[2]);
    this.camera.lookAt(this.controls.target);
    // ola de luz que sube por el tronco, cruza el cerebelo y el lóbulo temporal y enciende las fibras
    if (t > 3.0 && t < 5.0) {
      const path = [[-2.6, -6.2, 0], [-2.2, -3.6, 0], [-4.6, -3.0, 1.5], [-1.5, -1.6, 3], [2.0, -1.4, 2.5], [0, 3.0, 0]];
      const w = clamp((t - 3.0) / 1.9, 0, 0.999) * (path.length - 1);
      const i0 = Math.floor(w), f = w - i0, a = path[i0], b = path[i0 + 1];
      this.hot[0].set(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, 1.5);
      this.hot[1].set(this.hot[0].x, this.hot[0].y, -this.hot[0].z, 1.1);
    }
    // punto -> anillo -> nube -> cerebro
    this.introDot.material.opacity = smooth(0.2, 0.7, t) * (1 - smooth(1.6, 2.4, t));
    this.introDot.scale.setScalar(1.6);
    this.introRing.material.opacity = 0.7 * smooth(0.5, 1.0, t) * (1 - smooth(2.4, 3.3, t));
    this.introRing.scale.setScalar(4 + 11 * smooth(0.4, 3.2, t));
    u.uReveal.value = smooth(1.0, 3.8, t);
    u.uLines.value = smooth(2.6, 4.0, t);
    u.uFibers.value = smooth(3.0, 4.4, t);
    this.edgeMat.uniforms.uReveal.value = smooth(4.3, 5.4, t);
    // las neuronas aparecen de a grupos
    const g = this.graph;
    let changed = false;
    for (let i = 0; i < g.nodes.length; i++) {
      const start = 3.9 + (g.nodes[i].g / Math.max(1, g.groups.length)) * 0.9 + (i % 7) * 0.04;
      const p = easeOut(clamp((t - start) / 0.5, 0, 1));
      if (p !== this.pop[i]) { this.pop[i] = p; changed = true; }
    }
    if (changed) { this.refreshNodeStyle(); if (t > 4.3) this.refreshEdgeStyle(); }
    this.groupLabelOp = smooth(4.6, 5.6, t);
    if (t > 5.8) { this.intro.done = true; this.refreshEdgeStyle(); this.hooks.onIntroDone?.(); }
  }

  // ---------------- actividad en vivo
  nodePos(i) { return i != null && i >= 0 && this.pos[i] ? this.pos[i] : null; }

  hotspot(p, w = 0.55) {
    let best = null, bd = 1e9;
    for (const h of this.hot) { const d = (h.x - p.x) ** 2 + (h.y - p.y) ** 2 + (h.z - p.z) ** 2; if (d < bd) { bd = d; best = h; } }
    if (bd < 6) { best.x += (p.x - best.x) * 0.3; best.y += (p.y - best.y) * 0.3; best.z += (p.z - best.z) * 0.3; best.w = Math.min(0.95, best.w + w); return; }
    const weakest = this.hot.reduce((m, h) => (h.w < m.w ? h : m), this.hot[0]);
    weakest.set(p.x, p.y, p.z, Math.min(0.95, w));
  }

  flash(p, color, big = 1) {
    if (!this.anim) return;
    if (big >= 0.7) {
      const k = this.waveCursor++ % this.waves.length, c = new THREE.Color(color);
      this.waves[k].set(p.x, p.y, p.z, this.waveClock);
      this.waveColors[k].set(c.r * 0.45 + 0.55, c.g * 0.45 + 0.55, c.b * 0.45 + 0.55, big);
    }
    if (this.flashes.length >= 36) {
      const old = this.flashes.shift();
      this.scene.remove(old.ring, old.glow); old.ring.material.dispose(); old.glow.material.dispose();
    }
    const mk = tex => new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    const ring = mk(this.ringTex), glow = mk(this.glowTex);
    glow.material.color.lerp(new THREE.Color(0xffffff), 0.65);
    ring.position.copy(p); glow.position.copy(p);
    this.scene.add(ring, glow);
    this.flashes.push({ ring, glow, t0: this.time, big });
  }

  spark(p, color) {
    if (!this.anim) return;
    if (this.sparks.length >= 18) {
      const old = this.sparks.shift(); this.scene.remove(old.l); old.l.geometry.dispose(); old.l.material.dispose();
    }
    const R = Math.random, pos = [];
    for (let k = 0; k < 24; k++) {
      const d = new THREE.Vector3(R() - 0.5, R() - 0.5, R() - 0.5).normalize();
      const L = 0.3 + R() * 1.1, e = d.clone().multiplyScalar(L);
      pos.push(0, 0, 0, e.x, e.y, e.z);
      const d2 = d.clone().add(new THREE.Vector3(R() - 0.5, R() - 0.5, R() - 0.5)).normalize();
      const e2 = e.clone().addScaledVector(d2, L * 0.5);
      pos.push(e.x, e.y, e.z, e2.x, e2.y, e2.z);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    const l = new THREE.LineSegments(g, m); l.position.copy(p); this.scene.add(l);
    this.sparks.push({ l, t0: this.time });
  }

  trail(from, to, color, width = 3.2) {
    const N = 44, cen = new THREE.Vector3(...CENTER);
    const mid = from.clone().add(to).multiplyScalar(0.5);
    const d = from.distanceTo(to);
    const out = mid.clone().sub(cen).normalize();
    const ctrl = mid.clone().addScaledVector(out, 0.3 * d + 0.6);
    ctrl.y += 0.15 * d;
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const t = i / N, u = 1 - t;
      pts.push(new THREE.Vector3(u * u * from.x + 2 * u * t * ctrl.x + t * t * to.x, u * u * from.y + 2 * u * t * ctrl.y + t * t * to.y, u * u * from.z + 2 * u * t * ctrl.z + t * t * to.z));
    }
    const pos = [], nxt = [], side = [], uu = [], idx = [];
    pts.forEach((p, i) => {
      const n = pts[Math.min(N, i + 1)], pr = pts[Math.max(0, i - 1)];
      const nn = i === N ? p.clone().add(p.clone().sub(pr)) : n;
      for (const s of [-1, 1]) { pos.push(p.x, p.y, p.z); nxt.push(nn.x, nn.y, nn.z); side.push(s); uu.push(i / N); }
      if (i < N) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('nextPos', new THREE.Float32BufferAttribute(nxt, 3));
    g.setAttribute('side', new THREE.Float32BufferAttribute(side, 1));
    g.setAttribute('u', new THREE.Float32BufferAttribute(uu, 1));
    g.setIndex(idx);
    const m = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) }, uHead: { value: 0 }, uLife: { value: 1 }, uTail: { value: 0.42 }, uWidth: { value: width }, uRes: { value: this.res } },
      vertexShader: RIB_VS, fragmentShader: RIB_FS, transparent: true, depthWrite: false, blending: this.light ? THREE.NormalBlending : THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false; mesh.renderOrder = 8;
    this.scene.add(mesh);
    const tr = { mesh, t0: this.time, pts };
    this.trails.push(tr);
    if (this.trails.length > 46) { const o = this.trails.shift(); this.scene.remove(o.mesh); o.mesh.geometry.dispose(); o.mesh.material.dispose(); }
    return tr;
  }

  actor(key, color, kind) {
    let a = this.actors.get(key);
    if (!a) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glowTex, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
      s.scale.set(1.1, 1.1, 1); s.renderOrder = 9;
      this.scene.add(s);
      a = { key, sprite: s, color, kind, pos: null, move: null, text: '', last: this.time, trail: null };
      this.actors.set(key, a);
    }
    a.last = this.time;
    return a;
  }

  moveActor(a, to) {
    if (!a.pos) { a.pos = to.clone(); a.sprite.position.copy(to); return; }
    if (a.pos.distanceTo(to) < 0.05) return;
    if (a.move?.tr) a.move.tr.done = this.time;
    if (!this.anim) { a.pos.copy(to); a.sprite.position.copy(to); a.move = null; return; }
    const tr = this.anim ? this.trail(a.pos.clone(), to.clone(), a.color, a.kind === 'session' ? 3.6 : 2.6) : null;
    a.move = { from: a.pos.clone(), to: to.clone(), t0: this.time, dur: 0.95, tr };
  }

  act(ev, colors) {
    const target = this.nodePos(ev.node) || this.nodePos(ev.home) || new THREE.Vector3(...CENTER);
    const key = ev.aid ? ev.sid + ':' + ev.aid : ev.sid;
    const col = colors.actor;
    const home = this.nodePos(ev.home);
    if (ev.actor === 'user') {
      if (home) { this.flash(home, 0xffffff, 1.2); this.hotspot(home, 0.35); }
      return;
    }
    const a = this.actor(key, col, ev.aid ? 'agent' : 'session');
    a.sid = ev.sid;
    if (!a.pos) {
      a.pos = (home || new THREE.Vector3(-2.1, -4.7, 0)).clone();
      this.flash(a.pos, col, 0.85); this.hotspot(a.pos, 0.4);
    }
    const nodeName = ev.node != null ? this.graph.nodes[ev.node]?.t : (ev.file || '');
    const label = ev.aid ? ev.aname : ev.sname;
    const obj = ev.node != null || ev.file ? ' ' + (nodeName || '') : '';
    a.text = `${esc(label)} · ${esc(ev.verb === 'listo' ? 'listo' : ev.verb)}${ev.verb === 'listo' ? '' : esc(obj.length > 42 ? obj.slice(0, 40) + '…' : obj)}`;
    a.labelUntil = this.time + (ev.verb === 'listo' ? 6 : 40);
    const dest = ev.node != null ? target : (home ? home.clone().add(new THREE.Vector3((Math.random() - 0.5) * 1.6, 0.9 + Math.random(), (Math.random() - 0.5) * 1.6)) : target);
    this.moveActor(a, dest);
    this.lastActivity = this.time;
    this.lastActivityMs = Date.now();
    this.activityPts.push([dest.clone(), this.time]);
    if (this.activityPts.length > 30) this.activityPts.shift();
    if (ev.node != null) {
      this.excite[ev.node] = Math.min(2.5, this.excite[ev.node] + 1.2);
      this.activeNodes.set(ev.node, this.time + 14);
    }
    const big = ['edita', 'crea', 'commit'].includes(ev.verb) ? 1.15 : 0.8;
    this.later(this.anim && a.move ? a.move.dur : 0, () => {
      if (ev.node != null) this.firePackets(ev.node, 6, hexRGB('#' + new THREE.Color(col).getHexString()));
      this.flash(dest, col, big);
      this.hotspot(dest, ev.verb === 'agente' ? 0.4 : 0.22);
      if (['agente', 'busca', 'skill', 'edita', 'crea', 'commit'].includes(ev.verb) && this.anim) this.spark(dest, col);
    });
    if (ev.file && ['edita', 'crea'].includes(ev.verb)) {
      const t = this.fileTags.get(ev.file) || { plus: 0, minus: 0 };
      t.plus = ev.plus; t.minus = ev.minus; t.verb = ev.verb; t.until = this.time + 30; t.home = ev.home; t.born ||= this.time;
      this.fileTags.set(ev.file, t);
    }
  }

  setSessions(list) { this.sessions = list || []; }
  setMind(m) {
    if (m === 'trabajando' && this.mind !== m && this.graph && this.intro.done) this.taskPulse();
    this.mind = m;
  }
  taskPulse() {
    if (!this.anim || !this.graph) return;
    const i = this.selected >= 0 ? this.selected : this.sessions.find(s => this.nodePos(s.home))?.home;
    const p = this.nodePos(i) || new THREE.Vector3(-1.4, -1.2, 0);
    this.flash(p, 0x94efff, 1.4); this.hotspot(p, 0.8); this.spark(p, 0x94efff);
    if (i != null && i >= 0) this.firePackets(i, 8, [0.45, 0.9, 1]);
  }
  setVoiceLevel(v) { this.voiceLevel = v; }
  later(sec, fn) { if (sec <= 0) fn(); else this.queue.push([this.time + sec, fn]); }

  // recordar: ilumina, una por una, las notas de las que va a hablar
  recall(nodes) {
    nodes.forEach((i, k) => this.later(k * 0.32, () => {
      const p = this.nodePos(i); if (!p) return;
      this.flash(p, 0xff9ad8, 0.7);
      this.firePackets(i, 5, [1, 0.6, 0.88]);
      this.excite[i] = 2.2;
      this.activeNodes.set(i, this.time + 25);
      this.hotspot(p, 0.22);
      this.activityPts.push([p.clone(), this.time]);
      this.lastActivity = this.time; this.lastActivityMs = Date.now();
      if (k > 0 && this.anim) { const q = this.nodePos(nodes[k - 1]); if (q) { const tr = this.trail(q.clone(), p.clone(), 0xff9ad8, 2.4); tr.mesh.material.uniforms.uHead.value = 1; tr.done = this.time; } }
    }));
  }

  dream() {
    // sueño: recorre caminos de conexiones al azar
    const n = this.graph.nodes.length;
    let i = Math.floor(Math.random() * n);
    const path = [i];
    for (let k = 0; k < 4; k++) {
      const nb = this.adj[i].filter(([j, t]) => this.edgeOn[t] && this.vis[j]);
      if (!nb.length) break;
      i = nb[Math.floor(Math.random() * nb.length)][0];
      path.push(i);
    }
    const a = this.actor('__dream__', 0xff7ac8, 'dream');
    a.text = '';
    a.pos = this.pos[path[0]].clone();
    path.slice(1).forEach((j, k) => this.later(k * 1.3, () => {
      if (this.mind !== 'soñando') return;
      this.moveActor(a, this.pos[j]);
      this.later(0.9, () => { this.flash(this.pos[j], 0xff9ad8, 0.7); this.hotspot(this.pos[j], 0.25); this.excite[j] = 1; this.activeNodes.set(j, this.time + 5); });
    }));
  }

  // ---------------- interacción
  bindPointer() {
    const cv = this.canvas;
    let down = null;
    cv.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
    cv.addEventListener('pointermove', e => {
      if (this.dragging) return;
      const i = this.pick(e.clientX, e.clientY);
      if (i !== this.hover) { this.hover = i; cv.style.cursor = i >= 0 ? 'pointer' : ''; }
      this.hooks.onHover?.(i, e.clientX, e.clientY);
    });
    cv.addEventListener('pointerleave', () => { this.hover = -1; this.hooks.onHover?.(-1); });
    cv.addEventListener('pointerup', e => {
      const origin = down; down = null;
      if (!origin || e.button !== 0 || Math.hypot(e.clientX - origin[0], e.clientY - origin[1]) > 5) return;
      const i = this.pick(e.clientX, e.clientY);
      this.hooks.onPick?.(i);
    });
    cv.addEventListener('pointercancel', () => { down = null; this.hover = -1; });
    cv.addEventListener('wheel', () => { this.lastInteract = this.time; this.fly = null; }, { passive: true });
  }

  pick(cx, cy) {
    if (!this.graph) return -1;
    const rect = this.canvas.getBoundingClientRect();
    const x = cx - rect.left, y = cy - rect.top;
    const v = new THREE.Vector3();
    let best = -1, bd = 1e9;
    for (let i = 0; i < this.pos.length; i++) {
      if (!this.vis[i] || this.pop[i] < 0.5) continue;
      v.copy(this.pos[i]).project(this.camera);
      if (v.z > 1) continue;
      const sx = (v.x * 0.5 + 0.5) * rect.width, sy = (-v.y * 0.5 + 0.5) * rect.height;
      const d = Math.hypot(sx - x, sy - y);
      const depth = -this.pos[i].clone().applyMatrix4(this.camera.matrixWorldInverse).z;
      const rad = Math.max(8, (this.nodeSize(i) * 250 / depth) * 0.3);
      if (d < rad && d - rad * 0.2 < bd) { bd = d; best = i; }
    }
    return best;
  }

  resize() {
    const el = this.canvas.parentElement;
    const w = el.clientWidth, h = el.clientHeight;
    this.W = w; this.H = h;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.setViewOffset(w, h, -(w > 900 ? 158 : 0) - w * 0.015, -26, w, h); // el cerebro queda a la derecha de la barra lateral
    this.camera.updateProjectionMatrix();
    this.res = this.res || new THREE.Vector2();
    this.res.set(w, h);
  }

  // ---------------- cada cuadro
  frame() {
    const dt = this.manual ? this.stepDt : Math.min(0.05, this.clock.getDelta());
    this.time += dt;
    if (this.anim) this.waveClock += dt;
    this.u.uWaveClock.value = this.waveClock;
    if (this.queue.length) {
      const due = this.queue.filter(q => q[0] <= this.time);
      if (due.length) { this.queue = this.queue.filter(q => q[0] > this.time); due.forEach(q => q[1]()); }
    }
    this.hooks.onFrame?.(dt);
    const t = this.time;
    this.u.uTime.value = t;
    if (!this.graph) { this.renderer.render(this.scene, this.camera); return; }

    if (!this.intro.done) { if (this.anim) this.runIntro(); else this.finishIntro(); }

    // nuevas notas (el cerebro creció)
    if (this.popQueue?.length) {
      for (const q of this.popQueue) if (t >= q[1]) { this.pop[q[0]] = Math.min(1, this.pop[q[0]] + dt * 2); if (this.pop[q[0]] >= 1 && !q[2]) { q[2] = 1; this.flash(this.pos[q[0]], 0xffffff, 1.5); } }
      this.popQueue = this.popQueue.filter(q => this.pop[q[0]] < 1 || !q[2]);
      this.refreshNodeStyle(); this.refreshEdgeStyle();
    }

    this.updateSignals(dt);

    // reacomodar
    if (this.morph) {
      const k = easeIO(clamp((t - this.morph.t0) / this.morph.dur, 0, 1));
      this.pos.forEach((p, i) => p.lerpVectors(this.morph.from[i], this.morph.to[i], k));
      this.updateNodeGeometry(); this.updateEdgeGeometry(); this.computeGroupCenters();
      if (k >= 1) this.morph = null;
    }

    // foco
    this.focusOn += (this.focusTarget - this.focusOn) * Math.min(1, dt * 6);
    this.somaMat.uniforms.uFocusOn.value = this.focusOn;
    this.edgeMat.uniforms.uFocusOn.value = this.focusOn;
    this.dendMat.uniforms.uFocusOn.value = this.focusOn;
    const hoverPos = this.nodePos(this.hover);
    const hoverTarget = hoverPos && this.vis[this.hover] ? (this.light ? 0.25 : 0.65) : 0;
    this.hoverGlow.material.opacity += (hoverTarget - this.hoverGlow.material.opacity) * Math.min(1, dt * 12);
    if (hoverPos && hoverTarget) {
      this.hoverGlow.position.copy(hoverPos);
      this.hoverGlow.material.color.setRGB(...this.nodeColor(this.hover));
      this.hoverGlow.scale.setScalar(0.8 + this.nodeSize(this.hover) * 0.25);
    }

    // estado de la mente
    // al hablar se enciende el área de Broca (lóbulo frontal izquierdo)
    if (this.voiceLevel > 0.02) this.hot[7].set(3.4, 0.4, -4.3, Math.min(1.6, 0.4 + this.voiceLevel * 1.6));
    const targetGlow = ({ trabajando: 1.12, pensando: 1.0, listo: 0.95, descansando: 0.78, 'soñando': 0.7 }[this.mind] ?? 1) + this.voiceLevel * 0.35;
    this.u.uGlow.value += (targetGlow * (this.anim ? 0.97 + 0.03 * Math.sin(t * (this.mind === 'soñando' ? 0.7 : 1.6)) : 1) - this.u.uGlow.value) * Math.min(1, dt * 2);
    if (this.mind === 'soñando' && this.anim && t > this.dreamNext && this.intro.done) { this.dreamNext = t + 5.5; this.dream(); }

    // excitación y puntos calientes
    let exc = false;
    for (let i = 0; i < this.excite.length; i++) if (this.excite[i] > 0.001) { this.excite[i] *= Math.exp(-dt / 1.6); exc = true; }
    if (exc) this.somas.geometry.attributes.excite.needsUpdate = true;
    this.hot.forEach((h, k) => { h.w *= Math.exp(-dt / 2.2); this.haze[k].position.set(h.x, h.y, h.z); this.haze[k].material.opacity = this.light ? 0 : Math.min(0.11, h.w * 0.07); });

    // actores
    for (const [key, a] of this.actors) {
      if (a.move) {
        const k = clamp((t - a.move.t0) / a.move.dur, 0, 1), e = easeIO(k);
        const pts = a.move.tr?.pts;
        if (pts) { const f = e * (pts.length - 1), i0 = Math.floor(f), i1 = Math.min(pts.length - 1, i0 + 1); a.pos.lerpVectors(pts[i0], pts[i1], f - i0); }
        else a.pos.lerpVectors(a.move.from, a.move.to, e);
        if (a.move.tr) a.move.tr.mesh.material.uniforms.uHead.value = e;
        if (k >= 1) { if (a.move.tr) a.move.tr.done = t; a.move = null; }
      }
      if (a.pos) {
        const bob = this.anim ? 0.08 : 0;
        a.sprite.position.set(a.pos.x + Math.sin(t * 1.3 + key.length) * bob, a.pos.y + Math.cos(t * 1.1) * bob, a.pos.z);
        a.sprite.scale.setScalar(a.kind === 'session' ? 1.05 + (this.anim ? 0.1 * Math.sin(t * 3) : 0) : 0.8);
      }
      const idle = t - a.last;
      const fade = a.kind === 'dream' ? 1 - smooth(4, 6, idle) : 1 - smooth(70, 90, idle);
      a.sprite.material.opacity = fade;
      if (fade <= 0) { this.scene.remove(a.sprite); a.sprite.material.dispose(); this.actors.delete(key); }
    }
    for (const tr of this.trails) {
      const m = tr.mesh.material.uniforms;
      if (tr.done) m.uLife.value = Math.max(0, 1 - (t - tr.done) / 2.4);
    }
    this.trails = this.trails.filter(tr => {
      if (tr.done && tr.mesh.material.uniforms.uLife.value <= 0) { this.scene.remove(tr.mesh); tr.mesh.geometry.dispose(); tr.mesh.material.dispose(); return false; }
      return true;
    });
    this.flashes = this.flashes.filter(f => {
      const k = (t - f.t0) / 1.25;
      if (k >= 1) { this.scene.remove(f.ring, f.glow); f.ring.material.dispose(); f.glow.material.dispose(); return false; }
      f.ring.scale.setScalar((0.3 + 3.8 * easeOut(k)) * f.big); f.ring.material.opacity = (1 - k) ** 2 * 0.32;
      f.glow.scale.setScalar((0.9 + 2.8 * easeOut(Math.min(1, k * 3))) * f.big);
      f.glow.material.opacity = Math.exp(-k * 5) * 0.75;
      return true;
    });
    this.sparks = this.sparks.filter(s => {
      const k = (t - s.t0) / 1.3;
      if (k >= 1) { this.scene.remove(s.l); s.l.geometry.dispose(); s.l.material.dispose(); return false; }
      s.l.material.opacity = (1 - k) ** 2; s.l.scale.setScalar(0.3 + 1.1 * easeOut(k));
      return true;
    });

    // cámara
    const ctl = this.controls, cam = this.camera;
    if (this.fly) {
      const k = easeIO(clamp((t - this.fly.t0) / this.fly.dur, 0, 1));
      ctl.target.lerpVectors(this.fly.fromT, this.fly.toT, k);
      const d = this.fly.fromD + (this.fly.toD - this.fly.fromD) * k;
      const dir = cam.position.clone().sub(ctl.target).normalize();
      cam.position.copy(ctl.target).addScaledVector(dir, d);
      if (k >= 1) this.fly = null;
    } else if (this.intro.done) {
      const idle = t - this.lastInteract;
      if (this.anim && !this.dragging && idle > 6 && this.selected < 0) {
        const off = cam.position.clone().sub(ctl.target);
        const sph = new THREE.Spherical().setFromVector3(off);
        const speed = { trabajando: 0.085, pensando: 0.075, 'soñando': 0.035, descansando: 0.045 }[this.mind] ?? 0.07;
        sph.theta += speed * dt * smooth(6, 9, idle);
        const polar = 1.42 + 0.3 * Math.sin(t * 0.045);
        sph.phi += (polar - sph.phi) * dt * 0.15;
        cam.position.copy(ctl.target).add(new THREE.Vector3().setFromSpherical(sph));
      }
      if (this.follow && this.selected < 0 && !this.dragging) {
        const recent = this.activityPts.filter(p => t - p[1] < 12);
        const want = new THREE.Vector3(CENTER[0], CENTER[1] - 1.4, CENTER[2]);
        if (recent.length) {
          const c = new THREE.Vector3(); recent.forEach(p => c.add(p[0])); c.multiplyScalar(1 / recent.length);
          want.lerp(c, 0.32);
        }
        ctl.target.lerp(want, Math.min(1, dt * 0.6));
      }
    }
    if (this.intro.done) ctl.update();
    cam.updateMatrixWorld();

    this.updateLabels();
    this.composer.render();
  }

  updateLabels() {
    const L = this.labels, g = this.graph, t = this.time;
    L.begin();
    const op = this.intro.done ? 1 : (this.groupLabelOp || 0);
    if (op > 0.01) {
      // regiones + grupos
      const firstOfRegion = new Map();
      g.regions.forEach(r => r.groups.forEach((gi, k) => { if (k === 0) firstOfRegion.set(gi, r); }));
      g.groups.forEach((gr, gi) => {
        const anyVis = g.nodes.some((n, i) => n.g === gi && this.vis[i]);
        if (!anyVis) return;
        const it = L.get('g' + gi, 'lab-group');
        const reg = firstOfRegion.get(gi);
        L.html(it, (reg ? `<div class="lab-region" style="color:${gr.color}">${esc(reg.name)} · ${esc(reg.theme)}</div>` : '') +
          `<div class="lab-gname"><i style="background:${gr.color}"></i>${esc(gr.name)}</div>`);
        it.pos.copy(this.gcenter[gi]); it.op = op * (this.focusOn > 0.5 ? 0.45 : 1);
      });
      // notas destacadas, activas, vecinas del seleccionado, resultados de búsqueda
      const want = new Map();
      if (this.focusOn < 0.5) this.topNodes.forEach(i => want.set(i, 0.75));
      for (const [i, until] of this.activeNodes) { if (t > until) this.activeNodes.delete(i); else want.set(i, 1); }
      if (this.selected >= 0) { want.set(this.selected, 1.2); this.adj[this.selected].slice(0, 22).forEach(([j, ty]) => this.edgeOn[ty] && want.set(j, 0.9)); }
      if (this.highlight) [...this.highlight].slice(0, 24).forEach(i => want.set(i, 1));
      if (this.hover >= 0) want.set(this.hover, 1.2);
      for (const [i, w] of want) {
        if (!this.vis[i] || this.pop[i] < 0.5) continue;
        const it = L.get('n' + i, 'lab-node' + (w > 1 ? ' strong' : ''));
        L.html(it, esc(g.nodes[i].t));
        it.pos.copy(this.pos[i]); it.op = op * Math.min(1, w); it.ox = 9; it.oy = 9;
      }
    }
    // sesiones: su "casa" en el cerebro
    this.sessions.forEach((s, k) => {
      const p = this.nodePos(s.home); if (!p) return;
      const it = L.get('s' + s.sid, 'lab-pill sess');
      L.html(it, esc(s.name));
      it.pos.copy(p); it.oy = -18 - 22 * (this.sessions.filter((o, j) => j < k && o.home === s.home).length);
    });
    // actores (cursores de sesión y subagentes)
    for (const [key, a] of this.actors) {
      if (!a.text || !a.pos || t > (a.labelUntil || 0)) continue;
      const it = L.get('a' + key, 'lab-pill actor');
      const hex = '#' + new THREE.Color(a.color).getHexString();
      L.html(it, `<i style="background:${hex}"></i>${a.text}`);
      it.pos.copy(a.sprite.position); it.ox = 12; it.oy = -12; it.op = a.sprite.material.opacity;
    }
    // archivos tocados fuera de la memoria
    let fk = 0;
    for (const [name, tag] of this.fileTags) {
      if (t > tag.until) { this.fileTags.delete(name); continue; }
      const p = this.nodePos(tag.home); if (!p) continue;
      const it = L.get('f' + name, 'lab-pill file');
      L.html(it, `<i class="${tag.verb === 'crea' ? 'ok' : 'warn'}"></i>${esc(name)} <b class="plus">+${tag.plus}</b> <b class="minus">−${tag.minus}</b>`);
      it.pos.copy(p); it.ox = 34; it.oy = 18 + 24 * fk++;
      it.op = 1 - smooth(tag.until - 4, tag.until, t);
    }
    const cz = -new THREE.Vector3(...CENTER).applyMatrix4(this.camera.matrixWorldInverse).z;
    L.end(this.camera, this.W, this.H, cz, 7.5);
  }
}

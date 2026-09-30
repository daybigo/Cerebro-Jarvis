import { Brain } from './brain.js';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fold = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const CHECK = '<svg viewBox="0 0 12 12"><path d="M2.5 6.2l2.3 2.3 4.7-5"/></svg>';

const VERB_COLORS = {
  lee: '#62b6ff', edita: '#ff7a59', crea: '#3ddc84', busca: '#ffb347', ejecuta: '#aab1d0', script: '#aab1d0', compila: '#ffa53a',
  prueba: '#3ddc84', git: '#c6e84a', commit: '#3ddc84', agente: '#b18cff', espera: '#ffd23f', listo: '#3ddc84', skill: '#ff7ad9',
  navega: '#4fd6ff', planea: '#b18cff', base: '#62d6e8', usa: '#7fe0c8',
};
const SESSION_COLORS = ['#3fe6ff', '#ffd23f', '#7dff8a', '#ff8fd0', '#ffa53a', '#9d8cff'];
const AGENT_COLORS = ['#ff6fb0', '#ffd23f', '#7dff8a', '#ffa53a', '#9d8cff', '#3fe6ff', '#ff5a5a', '#c6e84a'];
const MIND_COLORS = { trabajando: '#3fe6ff', pensando: '#e27ad8', listo: '#3ddc84', descansando: '#8b90a7', 'soñando': '#b18cff', conectando: '#6b6f86', hablando: '#3fe6ff', escuchando: '#ff5c9a' };

// iconos de tipo de nota (triángulos como en el cerebro)
const TYPE_ICONS = {
  instrucciones: '<svg viewBox="0 0 18 16" class="ico"><path d="M9 1.2l7.6 13.4H1.4z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M9 5.4l4 7.1H5z" fill="currentColor" opacity=".55"/></svg>',
  indice: '<svg viewBox="0 0 18 16" class="ico"><path d="M9 1.2l7.6 13.4H1.4z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M9 6l3.4 6H5.6z" fill="currentColor"/></svg>',
  usuario: '<svg viewBox="0 0 18 16" class="ico"><path d="M9 1.5l7.3 12.9H1.7z" fill="currentColor" opacity=".35" stroke="currentColor" stroke-width="1.2"/></svg>',
  feedback: '<svg viewBox="0 0 18 16" class="ico"><path d="M9 1.5l7.3 12.9H1.7z" fill="currentColor"/></svg>',
  proyecto: '<svg viewBox="0 0 18 16" class="ico"><circle cx="9" cy="4" r="2.2" fill="currentColor"/><circle cx="5.6" cy="11" r="2.2" fill="currentColor"/><circle cx="12.4" cy="11" r="2.2" fill="currentColor"/></svg>',
  referencia: '<svg viewBox="0 0 18 16" class="ico"><g fill="currentColor"><circle cx="9" cy="2.8" r="1.5"/><circle cx="6.7" cy="7.2" r="1.5"/><circle cx="11.3" cy="7.2" r="1.5"/><circle cx="4.4" cy="11.8" r="1.5"/><circle cx="9" cy="11.8" r="1.5"/><circle cx="13.6" cy="11.8" r="1.5"/></g></svg>',
  skill: '<svg viewBox="0 0 18 16" class="ico"><path d="M9 3l6 10.6H3z" fill="currentColor" opacity=".8"/><path d="M9 0.5v2.4M9 13.6v2" stroke="currentColor" stroke-width="1.2"/></svg>',
  plan: '<svg viewBox="0 0 18 16" class="ico"><path d="M9 2l6.8 12H2.2z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-dasharray="2 1.6"/></svg>',
  documento: '<svg viewBox="0 0 18 16" class="ico"><path d="M9 4.5l5 8.8H4z" fill="currentColor"/></svg>',
};

const S = {
  graph: null, groupsOn: [], typesOn: {}, etypesOn: [], view: 'grafo', color: 'grupos', usage: {}, q: '',
  sessions: [], feed: [], edits: [], mind: 'conectando', user: '', job: null, voice: null, connected: false,
  sessColor: new Map(), agentColor: new Map(), selected: -1, sort: ['i', -1],
};

const brain = new Brain($('#gl'), $('#labels'), {
  onPick: i => (i >= 0 ? openNote(i) : closeDrawer()),
  onHover: (i, x, y) => showTip(i, x, y),
});
window.cerebro = { brain, S };

// ------------------------------------------------------------------ grafo
async function loadGraph(keep = false) {
  const g = await fetch('/api/graph').then(r => r.json());
  const prev = S.graph;
  S.graph = g;
  S.usage = g.usage || S.usage || {};
  if (!prev) {
    S.groupsOn = g.groups.map(() => true);
    S.typesOn = Object.fromEntries(g.typeIds.map(t => [t, true]));
    S.etypesOn = g.edgeTypes.map(e => e.on);
  } else {
    const byName = new Map(prev.groups.map((gr, i) => [gr.name, S.groupsOn[i]]));
    S.groupsOn = g.groups.map(gr => byName.has(gr.name) ? byName.get(gr.name) : true);
  }
  $('#generated').textContent = 'Generado el ' + g.generated;
  $('#st-notes').textContent = g.nodes.length;
  $('#st-edges').textContent = g.edges.length;
  $('#st-problems b').textContent = g.problems.length;
  renderSidebar();
  brain.setGraph(g, { keepLayout: keep });
  brain.setUsage(S.usage);
  if (S.color === 'uso') brain.setColorMode('uso', S.usage);
  applyFilters();
  $('#loading').style.opacity = 0;
  if (S.view === 'lista') renderList();
}

function row(on, lead, name, count, data) {
  return `<div class="row ${on ? 'on' : ''}" ${data}><span class="cb">${CHECK}</span>${lead}<span class="name">${esc(name)}</span><span class="cnt">${count}</span></div>`;
}
function renderSidebar() {
  const g = S.graph;
  $('#groups').innerHTML = g.groups.map((gr, i) => row(S.groupsOn[i], `<span class="dot" style="background:${gr.color}"></span>`, gr.name, gr.count, `data-g="${i}" title="${esc(gr.name)}"`)).join('');
  $('#types').innerHTML = g.types.map(t => row(S.typesOn[t.id], TYPE_ICONS[t.id] || TYPE_ICONS.documento, t.label, t.count, `data-t="${t.id}"`)).join('');
  const lineCls = { 'solid-strong': 'line strong', solid: 'line', dashed: 'line dashed', dotted: 'line dotted' };
  $('#etypes').innerHTML = g.edgeTypes.map((e, i) => row(S.etypesOn[i], `<span class="${lineCls[e.style]}"></span>`, e.label, e.count, `data-e="${i}" title="${esc(e.help)}"`)).join('');
}
document.querySelector('.side').addEventListener('click', e => {
  const r = e.target.closest('.row');
  const a = e.target.closest('a[data-all],a[data-none]');
  if (a) {
    const on = !!a.dataset.all, which = a.dataset.all || a.dataset.none;
    if (which === 'groups') S.groupsOn = S.groupsOn.map(() => on);
    if (which === 'types') Object.keys(S.typesOn).forEach(k => (S.typesOn[k] = on));
    if (which === 'etypes') S.etypesOn = S.etypesOn.map(() => on);
  } else if (r) {
    if (r.dataset.g) S.groupsOn[+r.dataset.g] = !S.groupsOn[+r.dataset.g];
    if (r.dataset.t) S.typesOn[r.dataset.t] = !S.typesOn[r.dataset.t];
    if (r.dataset.e) S.etypesOn[+r.dataset.e] = !S.etypesOn[+r.dataset.e];
  } else return;
  renderSidebar(); applyFilters();
});

function visibleMask() {
  const g = S.graph;
  return g.nodes.map(n => (S.groupsOn[n.g] && S.typesOn[g.typeIds[n.ty]] ? 1 : 0));
}
function applyFilters() {
  brain.setFilter(visibleMask(), S.etypesOn);
  const c = brain.visibleCounts();
  $('#foot').textContent = `${c.nodes} de ${S.graph.nodes.length} notas · ${c.edges} conexiones`;
  if (S.view === 'lista') renderList();
}

// ------------------------------------------------------------------ búsqueda
const qEl = $('#q'), resEl = $('#results');
let resSel = 0, resList = [];
function search(q) {
  const f = fold(q).trim();
  if (!f) return [];
  const g = S.graph, out = [];
  g.nodes.forEach((n, i) => {
    const t = fold(n.t), d = fold(n.d), p = fold(n.p);
    let s = t.startsWith(f) ? 3 : t.includes(f) ? 2 : d.includes(f) ? 1 : p.includes(f) ? 0.5 : 0;
    if (s) out.push([s + n.i * 0.01, i]);
  });
  return out.sort((a, b) => b[0] - a[0]).map(x => x[1]);
}
qEl.addEventListener('input', () => {
  S.q = qEl.value;
  resList = search(S.q);
  resSel = 0;
  brain.setHighlight(resList.length ? new Set(resList.slice(0, 60)) : null);
  renderResults();
  if (S.view === 'lista') renderList();
});
function renderResults() {
  if (!S.q.trim()) { resEl.classList.add('hidden'); return; }
  const g = S.graph;
  resEl.innerHTML = resList.length ? resList.slice(0, 8).map((i, k) => `<div data-i="${i}" class="${k === resSel ? 'sel' : ''}"><i style="background:${g.groups[g.nodes[i].g].color}"></i><span>${esc(g.nodes[i].t)}</span><small>${esc(g.types.find(t => t.id === g.typeIds[g.nodes[i].ty])?.label || '')}</small></div>`).join('')
    : '<div class="muted">Nada con ese nombre.</div>';
  resEl.classList.remove('hidden');
}
qEl.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { resSel = Math.min(resSel + 1, Math.min(7, resList.length - 1)); renderResults(); e.preventDefault(); }
  if (e.key === 'ArrowUp') { resSel = Math.max(0, resSel - 1); renderResults(); e.preventDefault(); }
  if (e.key === 'Enter' && resList.length) { openNote(resList[resSel]); resEl.classList.add('hidden'); qEl.blur(); }
  if (e.key === 'Escape') { qEl.value = ''; qEl.dispatchEvent(new Event('input')); qEl.blur(); }
});
resEl.addEventListener('mousedown', e => { const d = e.target.closest('[data-i]'); if (d) { openNote(+d.dataset.i); resEl.classList.add('hidden'); } });
qEl.addEventListener('blur', () => setTimeout(() => resEl.classList.add('hidden'), 150));
qEl.addEventListener('focus', () => S.q && renderResults());

// ------------------------------------------------------------------ vistas
$('#view-seg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  S.view = b.dataset.view;
  document.querySelectorAll('#view-seg button').forEach(x => x.classList.toggle('on', x === b));
  $('#list').classList.toggle('hidden', S.view !== 'lista');
  $('#labels').classList.toggle('hidden', S.view === 'lista');
  if (S.view === 'lista') renderList();
});
$('#color-seg').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  S.color = b.dataset.color;
  document.querySelectorAll('#color-seg button').forEach(x => x.classList.toggle('on', x === b));
  brain.setColorMode(S.color, S.usage);
  if (S.view === 'lista') renderList();
});

const ago = ts => {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 5) return 'ahora';
  if (s < 60) return `hace ${Math.round(s / 5) * 5} s`;
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86400)} d`;
};

function renderList() {
  const g = S.graph, mask = visibleMask();
  let idx = g.nodes.map((n, i) => i).filter(i => mask[i]);
  if (S.q.trim()) { const set = new Set(search(S.q)); idx = idx.filter(i => set.has(i)); }
  const [key, dir] = S.sort;
  const val = i => { const n = g.nodes[i]; return { t: fold(n.t), g: g.groups[n.g].name, ty: n.ty, k: n.k, u: S.usage[i] || 0, pb: n.pb, m: n.m, i: n.i }[key]; };
  idx.sort((a, b) => (val(a) > val(b) ? 1 : val(a) < val(b) ? -1 : 0) * dir);
  const th = (k, l) => `<th data-k="${k}">${l}${S.sort[0] === k ? (S.sort[1] > 0 ? ' ↑' : ' ↓') : ''}</th>`;
  $('#list').innerHTML = `<table><thead><tr>${th('t', 'NOTA')}${th('g', 'GRUPO')}${th('ty', 'TIPO')}${th('k', 'CONEXIONES')}${th('u', 'USO')}${th('pb', 'PROBLEMAS')}${th('m', 'ACTUALIZADA')}</tr></thead><tbody>` +
    idx.slice(0, 600).map(i => {
      const n = g.nodes[i], gr = g.groups[n.g];
      return `<tr data-i="${i}"><td>${esc(n.t)}</td><td><span class="gdot" style="background:${gr.color}"></span>${esc(gr.name)}</td><td>${esc(g.types.find(t => t.id === g.typeIds[n.ty])?.label)}</td><td>${n.k}</td><td>${S.usage[i] || 0}</td><td class="${n.pb ? 'pb' : ''}">${n.pb || ''}</td><td>${ago(n.m)}</td></tr>`;
    }).join('') + '</tbody></table>';
}
$('#list').addEventListener('click', e => {
  const th = e.target.closest('th');
  if (th) { S.sort = [th.dataset.k, S.sort[0] === th.dataset.k ? -S.sort[1] : -1]; renderList(); return; }
  const tr = e.target.closest('tr[data-i]');
  if (tr) openNote(+tr.dataset.i, { fly: false });
});

// ------------------------------------------------------------------ detalle de nota
function md(text) {
  let h = esc(text);
  h = h.replace(/```[\s\S]*?```/g, m => `<pre><code>${m.slice(3, -3).replace(/^\w*\n/, '')}</code></pre>`);
  h = h.replace(/^#{1,6}\s+(.+)$/gm, '<h4>$1</h4>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`\n]+)`/g, '<code>$1</code>');
  h = h.replace(/\[\[([^\]]+)\]\]/g, '<code>[[$1]]</code>').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<u>$1</u>');
  h = h.replace(/^\s*[-*]\s+(.+)$/gm, '<li>$1</li>').replace(/(<li>.*<\/li>\n?)+/g, m => `<ul>${m}</ul>`);
  return h.replace(/\n{2,}/g, '<br><br>').replace(/\n/g, '<br>');
}
async function openNote(i, { fly = true } = {}) {
  const g = S.graph, n = g.nodes[i];
  S.selected = i;
  brain.select(i, { fly: fly && S.view === 'grafo' });
  const gr = g.groups[n.g], reg = g.regions.find(r => r.id === gr.region);
  const type = g.types.find(t => t.id === g.typeIds[n.ty]);
  const probs = g.problems.filter(p => p.node === i);
  const neigh = {};
  g.edges.forEach(([a, b, t]) => { if (a === i || b === i) (neigh[t] ||= []).push(a === i ? b : a); });
  const d = $('#drawer');
  d.innerHTML = `<button class="x" id="dx">×</button>
    <h2>${esc(n.t)}</h2>
    <div class="badges"><span class="badge"><i style="background:${gr.color}"></i>${esc(gr.name)}</span><span class="badge">${esc(type?.label)}</span>
    ${reg ? `<span class="badge">${esc(reg.name.toLowerCase())} · ${esc(reg.theme.toLowerCase())}</span>` : ''}<span class="badge">${n.k} conexiones</span>
    ${S.usage[i] ? `<span class="badge">usada ${S.usage[i]} veces</span>` : ''}</div>
    <div class="path">${esc(n.p)}</div>
    ${n.d ? `<div class="desc">${esc(n.d)}</div>` : ''}
    <div class="actions"><button class="btn" id="d-open">Abrir archivo</button><button class="btn" id="d-center">Centrar</button></div>
    ${probs.length ? `<h3>PROBLEMAS</h3>${probs.map(p => `<div class="prob">${esc(p.msg)}${p.other != null ? `<small>↳ ${esc(g.nodes[p.other].t)}</small>` : ''}</div>`).join('')}` : ''}
    ${Object.keys(neigh).length ? `<h3>CONEXIONES</h3>` + Object.entries(neigh).map(([t, l]) => `<div class="muted" style="font-size:11px;margin:8px 0 2px">${esc(g.edgeTypes[t].label)} · ${l.length}</div>` +
      l.slice(0, 30).map(j => `<div class="nb" data-i="${j}"><i style="background:${g.groups[g.nodes[j].g].color}"></i><span>${esc(g.nodes[j].t)}</span><small>${esc(g.groups[g.nodes[j].g].name.split('·').pop())}</small></div>`).join('')).join('') : ''}
    <h3>CONTENIDO · actualizada ${ago(n.m)}</h3><div class="body" id="d-body"><span class="spinner"></span></div>`;
  d.classList.remove('hidden');
  $('#dx').onclick = closeDrawer;
  $('#d-open').onclick = () => fetch('/api/open?i=' + i, { method: 'POST' });
  $('#d-center').onclick = () => brain.select(i, { fly: true });
  d.querySelectorAll('.nb').forEach(el => (el.onclick = () => openNote(+el.dataset.i)));
  try {
    const note = await fetch('/api/note?i=' + i).then(r => r.json());
    if (S.selected === i) $('#d-body').innerHTML = md(note.body || '(vacía)');
  } catch { $('#d-body').textContent = 'No se pudo leer el archivo.'; }
}
function closeDrawer() {
  $('#drawer').classList.add('hidden');
  S.selected = -1;
  brain.select(-1);
  if (S.q.trim()) brain.setHighlight(new Set(resList.slice(0, 60)));
}
$('#st-problems').addEventListener('click', () => {
  const g = S.graph, d = $('#drawer');
  const names = { roto: 'Links rotos', fuera_indice: 'Fuera del índice', sin_descripcion: 'Sin descripción', vacia: 'Casi vacías', repetida: 'Repetidas', vieja: 'Viejas' };
  const by = {};
  g.problems.forEach(p => (by[p.kind] ||= []).push(p));
  d.innerHTML = `<button class="x" id="dx">×</button><h2>${g.problems.length} problemas en tu memoria</h2>
    <div class="desc">Detectados automáticamente al leer tus notas. Para una revisión a fondo, que Claude las audite.</div>
    <div class="actions"><button class="btn primary" id="p-audit">Auditar con Claude</button><button class="btn" id="p-improve">Mejorar memoria</button></div>` +
    Object.entries(by).map(([k, l]) => `<h3>${esc(names[k] || k).toUpperCase()} · ${l.length}</h3>` + l.map(p => `<div class="prob" data-i="${p.node}">${esc(g.nodes[p.node].t)}<small>${esc(p.msg)}</small></div>`).join('')).join('');
  d.classList.remove('hidden');
  $('#dx').onclick = closeDrawer;
  $('#p-audit').onclick = startAudit;
  $('#p-improve').onclick = confirmImprove;
  d.querySelectorAll('.prob[data-i]').forEach(el => (el.onclick = () => openNote(+el.dataset.i)));
  brain.setHighlight(new Set(g.problems.map(p => p.node)));
});

// tooltip
const tip = $('#tip');
function showTip(i, x, y) {
  if (i < 0 || !S.graph) { tip.classList.add('hidden'); return; }
  const g = S.graph, n = g.nodes[i], rect = $('#stage').getBoundingClientRect();
  tip.innerHTML = `<b>${esc(n.t)}</b><small>${esc(g.groups[n.g].name)} · ${esc(g.types.find(t => t.id === g.typeIds[n.ty])?.label)} · ${n.k} conexiones${S.usage[i] ? ' · usada ' + S.usage[i] + ' veces' : ''}</small>${n.d ? `<div class="muted" style="margin-top:4px">${esc(n.d.slice(0, 160))}</div>` : ''}`;
  tip.style.left = Math.min(x - rect.left + 16, rect.width - 330) + 'px';
  tip.style.top = (y - rect.top + 14) + 'px';
  tip.classList.remove('hidden');
}

// ------------------------------------------------------------------ controles
$('#zin').onclick = () => brain.zoom(0.78);
$('#zout').onclick = () => brain.zoom(1.28);
$('#fit').onclick = () => { closeDrawer(); brain.fit(); };
$('#relayout').onclick = () => brain.relayout();
$('#follow').onclick = () => { brain.follow = !brain.follow; $('#follow').classList.toggle('on', brain.follow); };
$('#anim').onchange = e => brain.setAnimations(e.target.checked);
$('#theme').onclick = () => {
  const light = document.documentElement.dataset.theme !== 'light';
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  brain.setTheme(light);
  try { localStorage.setItem('cerebro-theme', light ? 'light' : 'dark'); } catch {}
};
try { if (localStorage.getItem('cerebro-theme') === 'light') $('#theme').click(); } catch {}
$('#probar').onclick = () => fetch('/api/probar', { method: 'POST' });
document.addEventListener('keydown', e => {
  if (e.key === '/' && document.activeElement !== qEl && !e.target.closest('input,textarea')) { e.preventDefault(); qEl.focus(); }
  if (e.key === 'Escape') { if (!$('#modal').classList.contains('hidden')) closeModal(); else closeDrawer(); stopVoice(); }
});

// ------------------------------------------------------------------ actividad en vivo (SSE)
function sessColor(sid) {
  if (!S.sessColor.has(sid)) S.sessColor.set(sid, SESSION_COLORS[S.sessColor.size % SESSION_COLORS.length]);
  return S.sessColor.get(sid);
}
function agentColor(sid, aid) {
  const k = sid + ':' + aid;
  if (!S.agentColor.has(k)) S.agentColor.set(k, AGENT_COLORS[S.agentColor.size % AGENT_COLORS.length]);
  return S.agentColor.get(k);
}

let nowDirty = true;
function renderNow() {
  nowDirty = false;
  const body = $('#now-body');
  const sess = S.sessions;
  if (!sess.length && !S.feed.length && !S.edits.length) {
    body.innerHTML = '<div class="empty">Todavía no hay acciones. Cuando Claude lea o edite algo, aparece acá.</div>';
    return;
  }
  let h = '';
  for (const s of sess) {
    const st = s.state === 'espera' ? `<span class="espera">espera tu OK</span>` :
      `<span>${esc(s.state)}${s.cur && s.state === 'trabajando' ? ': ' + esc(s.cur) : ''}${s.agents.length ? ` · ${s.agents.length} agente${s.agents.length > 1 ? 's' : ''}` : ''}</span>`;
    h += `<div class="sess-line"><b style="color:${sessColor(s.sid) === '#3fe6ff' ? 'inherit' : 'inherit'}">${esc(s.name)}</b>${st}</div>`;
    for (const a of s.agents.slice(0, 7)) h += `<div class="agent-line"><b>↳ ${esc(a.name)}</b><span>${esc(a.verb)} · ${a.n} acci${a.n === 1 ? 'ón' : 'ones'}</span></div>`;
  }
  const feed = S.feed.slice(-6).reverse();
  if (feed.length) {
    h += '<div class="feed">' + feed.map(e => {
      const old = Date.now() / 1000 - e.ts > 60;
      const dots = `<i style="background:${sessColor(e.sid)}"></i>` + (e.aid ? `<i style="background:${agentColor(e.sid, e.aid)}"></i>` : '');
      let verb = `<span class="verb" style="color:${VERB_COLORS[e.verb] || '#aab1d0'}">${esc(e.verb)}</span>`;
      let what = e.aid ? `${esc(e.aname)}${e.text ? ': ' + esc(e.text) : ''}` : esc(e.text || '');
      if (e.actor === 'user') { verb = `<span class="verb" style="color:var(--text)">${esc(S.user || 'Tú')}</span>`; what = 'escribió un mensaje'; }
      if (e.file && (e.plus || e.minus)) what += ` <b style="color:var(--ok)">+${e.plus}</b>`;
      return `<div class="ev ${old ? 'old' : ''}"><span class="when">${ago(e.ts)}</span>${verb}<span class="what">${dots}<span>${what}</span></span></div>`;
    }).join('') + '</div>';
  }
  if (S.edits.length) {
    h += '<div class="prog"><h4>Programando (última media hora)</h4>' + S.edits.slice(0, 3).map(f =>
      `<div class="f"><i></i><span>${esc(f.name)}</span><b class="p">+${f.plus}</b><b class="m">−${f.minus}</b><small>${ago(f.ts)}</small></div>`).join('') + '</div>';
  }
  body.innerHTML = h;
}
setInterval(() => { renderNow(); }, 1000);

function setMind(m) {
  S.mind = m;
  brain.setMind(m);
}

function handle(m) {
  switch (m.k) {
    case 'snapshot':
      S.sessions = m.sessions || []; S.feed = m.feed || []; S.edits = m.edits || []; S.user = m.user || S.user;
      brain.setSessions(S.sessions); setMind(m.mind); renderNow();
      if (S.graph && m.v && m.v !== S.graph.version) loadGraph(true);
      break;
    case 'act':
      S.feed.push(m); if (S.feed.length > 60) S.feed.shift();
      if (S.graph) brain.act(m, { actor: m.aid ? agentColor(m.sid, m.aid) : sessColor(m.sid) });
      if (m.demo === false || m.demo === undefined) lastRealAct = Date.now();
      renderNow();
      break;
    case 'sessions':
    case 'tick':
      S.sessions = m.sessions || S.sessions;
      if (m.edits) S.edits = m.edits;
      brain.setSessions(S.sessions);
      if (m.k === 'sessions') renderNow();
      break;
    case 'mind': setMind(m.mind); break;
    case 'graph': loadGraph(true); break;
    case 'usage': S.usage = m.usage || {}; brain.setUsage(S.usage); if (S.view === 'lista') renderList(); break;
    case 'job': onJob(m.job); break;
    case 'voice': onVoiceEvent(m); break;
  }
}
let lastRealAct = 0;
function connect() {
  const es = new EventSource('/api/events');
  es.onopen = () => { S.connected = true; $('#conn-dot').classList.add('on'); $('#conn-txt').textContent = 'conectado'; };
  es.onmessage = e => { try { handle(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  es.onerror = () => { S.connected = false; $('#conn-dot').classList.remove('on'); $('#conn-txt').textContent = 'conectando...'; setMind('conectando'); };
}

// ------------------------------------------------------------------ monitor (EKG)
const ekg = $('#ekg'), ectx = ekg.getContext('2d');
const EW = 182 * 2, EH = 30 * 2;
ekg.width = EW; ekg.height = EH;
const samples = new Array(EW / 2).fill(0);
let phase = 0, beat = 0, voiceLevel = 0;
function ekgTick() {
  const m = S.speaking ? 'hablando' : S.listening ? 'escuchando' : S.mind;
  const t = performance.now() / 1000;
  phase += 1;
  let v = 0;
  if (m === 'trabajando') {
    beat -= 1;
    if (beat <= 0) beat = 26 + Math.random() * 30;
    const k = beat;
    v = k > 22 ? 0 : k > 19 ? (22 - k) * -0.12 : k > 16 ? (k - 16) * 0.35 * (0.7 + Math.random() * 0.5) : k > 13 ? (k - 13) * -0.18 : (Math.random() - 0.5) * 0.12;
  } else if (m === 'pensando') v = 0.25 * Math.sin(phase * 0.9) * Math.sin(phase * 0.13) + (Math.random() - 0.5) * 0.3;
  else if (m === 'descansando') v = 0.08 * Math.sin(t * 2.2);
  else if (m === 'soñando') v = 0.22 * Math.sin(t * 1.6) + (Math.sin(t * 0.31) > 0.8 ? (Math.random() - 0.5) * 0.5 : 0);
  else if (m === 'hablando') v = (Math.random() - 0.5) * 1.6 * voiceLevel;
  else if (m === 'escuchando') v = (Math.random() - 0.5) * 0.7 * (micLevel || 0.2);
  else if (m === 'listo') v = 0.05 * Math.sin(t * 3);
  samples.push(v); samples.shift();
  ectx.clearRect(0, 0, EW, EH);
  const col = MIND_COLORS[m] || '#3fe6ff';
  ectx.strokeStyle = col; ectx.lineWidth = 2; ectx.shadowColor = col; ectx.shadowBlur = 6;
  ectx.beginPath();
  samples.forEach((s, i) => { const x = i * 2, y = EH / 2 - s * EH * 0.45; i ? ectx.lineTo(x, y) : ectx.moveTo(x, y); });
  ectx.stroke();
  const mind = $('#mind');
  if (mind.textContent !== m) mind.textContent = m;
  mind.style.color = col;
  $('#follow').classList.toggle('live', Date.now() - brain.lastActivityMs < 12000);
  if (!brain.manual) requestAnimationFrame(ekgTick);
}
if (brain.manual) brain.hooks.onFrame = () => ekgTick(); else requestAnimationFrame(ekgTick);

// ------------------------------------------------------------------ voz
let audioCtx = null, analyser = null, nextTime = 0, voiceAbort = null, micLevel = 0, recog = null;
const bubble = $('#voice-bubble');
async function loadVoiceStatus() {
  try { S.voice = await fetch('/api/voice/status').then(r => r.json()); } catch { S.voice = null; }
  const b = $('#btn-voice');
  b.title = S.voice?.llm ? (S.voice.tts ? 'Háblale a tu cerebro' : 'El cerebro contesta por escrito (pon tu FISH_API_KEY en .env para oír su voz)') : 'Instala Claude Code para hablar con el cerebro';
}
function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser(); analyser.fftSize = 512;
    analyser.connect(audioCtx.destination);
    const buf = new Uint8Array(analyser.fftSize);
    const loop = () => {
      analyser.getByteTimeDomainData(buf);
      let s = 0; for (const x of buf) s += ((x - 128) / 128) ** 2;
      const lvl = Math.min(1, Math.sqrt(s / buf.length) * 4);
      voiceLevel = voiceLevel * 0.6 + lvl * 0.4;
      S.speaking = audioCtx.currentTime < nextTime - 0.02;
      brain.setVoiceLevel(S.speaking ? voiceLevel : 0);
      $('#btn-voice').classList.toggle('speaking', !!S.speaking);
      requestAnimationFrame(loop);
    };
    loop();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}
async function playPCM(resp) {
  const ctx = ensureAudio();
  const rate = +resp.headers.get('X-Sample-Rate') || 44100;
  const reader = resp.body.getReader();
  let carry = null;
  nextTime = Math.max(nextTime, ctx.currentTime + 0.08);
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    let bytes = value;
    if (carry) { const m = new Uint8Array(carry.length + bytes.length); m.set(carry); m.set(bytes, carry.length); bytes = m; carry = null; }
    if (bytes.length % 2) { carry = bytes.slice(bytes.length - 1); bytes = bytes.slice(0, bytes.length - 1); }
    if (!bytes.length) continue;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const n = bytes.length / 2, f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = dv.getInt16(i * 2, true) / 32768;
    const ab = ctx.createBuffer(1, n, rate);
    ab.copyToChannel(f, 0);
    const src = ctx.createBufferSource();
    src.buffer = ab; src.connect(analyser);
    const at = Math.max(nextTime, ctx.currentTime + 0.02);
    src.start(at);
    nextTime = at + ab.duration;
    (S.sources ||= []).push(src);
  }
}
function stopVoice() {
  voiceAbort?.abort(); voiceAbort = null;
  (S.sources || []).forEach(s => { try { s.stop(); } catch {} });
  S.sources = [];
  if (audioCtx) nextTime = audioCtx.currentTime;
  recog?.abort?.();
}
function showBubble(html, sticky = false) {
  bubble.innerHTML = html + `<div style="display:flex;gap:6px;margin-top:8px"><input id="vq" class="search" style="margin:0;flex:1;height:32px" placeholder="…o escribe tu pregunta y presiona Enter"><button class="btn" id="vclose">Cerrar</button></div>`;
  bubble.classList.remove('hidden');
  $('#vclose').onclick = () => { stopVoice(); bubble.classList.add('hidden'); };
  const vq = $('#vq');
  vq.onkeydown = e => { if (e.key === 'Enter' && vq.value.trim()) ask(vq.value.trim()); e.stopPropagation(); };
  if (sticky) vq.focus();
}
const voiceTurn = { id: null, q: '', text: '' };
function onVoiceEvent(m) {
  if (m.id !== voiceTurn.id) return;
  if (m.phase === 'thinking' && m.nodes?.length) brain.recall(m.nodes);
  if (m.text != null) voiceTurn.text = m.text;
  if (m.error) voiceTurn.text = '⚠ ' + m.error;
  renderVoiceBubble(m.phase === 'final');
}
function renderVoiceBubble(final) {
  const t = voiceTurn.text ? esc(voiceTurn.text) : '<span class="spinner"></span>pensando…';
  showBubble(`<div class="you">Tú: ${esc(voiceTurn.q)}</div><div class="who">Tu cerebro</div><div>${t}</div>`);
}
async function ask(q) {
  stopVoice();
  ensureAudio();
  voiceTurn.id = 'v' + Date.now(); voiceTurn.q = q; voiceTurn.text = '';
  renderVoiceBubble(false);
  voiceAbort = new AbortController();
  try {
    const r = await fetch('/api/voice/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: q, id: voiceTurn.id }), signal: voiceAbort.signal });
    if (!r.ok) { const j = await r.json().catch(() => ({})); voiceTurn.text = '⚠ ' + (j.error || 'No pude contestar.'); renderVoiceBubble(true); return; }
    await playPCM(r);
  } catch (e) { if (e.name !== 'AbortError') { voiceTurn.text = '⚠ Se cortó la voz.'; renderVoiceBubble(true); } }
}
async function say(text) {
  if (!S.voice?.tts || !S.voiceOn) return;
  try {
    ensureAudio();
    const r = await fetch('/api/voice/say', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    if (r.ok) await playPCM(r);
  } catch {}
}
function listen() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { showBubble('<div class="who">Tu cerebro</div><div>Este navegador no tiene micrófono con reconocimiento. Escríbeme la pregunta.</div>', true); return; }
  stopVoice();
  recog = new SR();
  recog.lang = 'es-419'; recog.interimResults = true; recog.continuous = false;
  let finalText = '';
  S.listening = true; $('#btn-voice').classList.add('live'); $('#voice-label').textContent = 'Escuchando…';
  showBubble('<div class="who">Te escucho</div><div><span class="bars"><i></i><i></i><i></i><i></i></span><span id="interim" class="muted">Habla cuando quieras…</span></div>');
  recog.onresult = e => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript; else interim += e.results[i][0].transcript;
    }
    micLevel = 0.6 + Math.random() * 0.4;
    const el = $('#interim'); if (el) el.textContent = finalText + interim;
  };
  recog.onerror = e => { if (e.error === 'not-allowed') showBubble('<div class="who">Micrófono bloqueado</div><div>Da permiso al micrófono en el candado de la barra de direcciones, o escribe tu pregunta.</div>', true); };
  recog.onend = () => {
    S.listening = false; micLevel = 0; $('#btn-voice').classList.remove('live'); $('#voice-label').textContent = 'Voz';
    if (finalText.trim()) ask(finalText.trim());
  };
  recog.start();
}
$('#btn-voice').onclick = () => {
  ensureAudio();
  if (S.speaking) { stopVoice(); return; }
  if (S.listening) { recog?.stop(); return; }
  if (!S.voice?.llm) {
    showBubble('<div class="who">Falta Claude Code</div><div>El cerebro conversa usando tu Claude Code (el comando <code>claude</code>). Instálalo y vuelve a tocar <b>Voz</b>. Para oír su voz, pon tu <b>FISH_API_KEY</b> en <code>.env</code>.</div>', true);
    loadVoiceStatus();
    return;
  }
  if (!S.voiceOn) {
    S.voiceOn = true;
    const g = S.graph;
    const greet = `[friendly] Hola. Soy el Cerebro de Claude: cada neurona es una memoria y cada destello es algo que Claude está haciendo ahora mismo. Pregúntame lo que quieras.`;
    say(greet).then(() => listen());
    showBubble(`<div class="who">Tu cerebro</div><div>${esc(greet.replace(/\[[^\]]+\]\s*/g, ''))}</div>`);
    return;
  }
  listen();
};

// ------------------------------------------------------------------ auditar / mejorar con Claude
const modal = $('#modal'), card = $('#modal-card');
function openModal(html) { card.innerHTML = html; modal.classList.remove('hidden'); }
function closeModal() { modal.classList.add('hidden'); if (S.selected < 0) brain.setHighlight(S.q.trim() ? new Set(resList.slice(0, 60)) : null); }
modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

function startAudit() {
  if (S.job?.status === 'running') { renderJob(); return; }
  fetch('/api/audit', { method: 'POST' }).then(r => r.json()).then(j => onJob(j.job, true));
}
function confirmImprove() {
  if (S.job?.status === 'running') { renderJob(); return; }
  const a = S.job?.lastAudit;
  openModal(`<h2>Mejorar memoria</h2><p class="lead">Claude va a corregir tus memorias${a ? ` usando la auditoría del ${esc(a.fecha)} (${a.hallazgos?.length || 0} hallazgos)` : ' (primero las audita)'}:
    fusiona las repetidas, arregla encabezados corruptos y links rotos, y marca las que quedaron viejas.
    Antes hago un <b>backup completo</b> y después puedes deshacer todo con un clic.</p>
    <div class="modal-actions"><button class="btn" id="m-cancel">Cancelar</button><button class="btn primary" id="m-go">Mejorar memoria</button></div>`);
  $('#m-cancel').onclick = closeModal;
  $('#m-go').onclick = () => fetch('/api/improve', { method: 'POST' }).then(r => r.json()).then(j => onJob(j.job, true));
}
$('#btn-audit').onclick = () => (S.job?.status === 'running' && S.job.kind === 'audit') ? renderJob() : (S.job?.lastAudit && S.job.status !== 'running' ? showAudit(S.job.lastAudit) : startAudit());
$('#btn-improve').onclick = () => (S.job?.status === 'running' && S.job.kind === 'improve') ? renderJob() : confirmImprove();

let jobModalOpen = false;
function onJob(job, open = false) {
  const prev = S.job;
  S.job = job;
  if (job.status === 'running' && prev?.status !== 'running') brain.taskPulse();
  $('#btn-audit').classList.toggle('busy', job.status === 'running' && job.kind === 'audit');
  $('#btn-improve').classList.toggle('busy', job.status === 'running' && job.kind === 'improve');
  if (open) jobModalOpen = true;
  const finished = prev?.status === 'running' && job.status !== 'running';
  if (finished && job.status === 'done') {
    if (job.kind === 'audit' && job.result) {
      showAudit(job.result);
      say(`[confident] Auditoría lista. ${job.result.resumen || ''}`);
    }
    if (job.kind === 'improve' && job.result) {
      showImprove(job.result);
      say(`[satisfied] Listo, mejoré tu memoria. ${job.result.resumen || ''}`);
    }
    return;
  }
  if (jobModalOpen && !modal.classList.contains('hidden') || open) renderJob();
}
function renderJob() {
  const j = S.job; if (!j) return;
  if (j.status !== 'running' && j.status !== 'error') return;
  const title = j.kind === 'audit' ? 'Claude está auditando tu memoria' : 'Claude está mejorando tu memoria';
  openModal(`<h2>${j.status === 'error' ? 'Algo falló' : `<span class="spinner"></span>${title}`}</h2>
    <p class="lead">${j.status === 'error' ? esc(j.error) : 'Mira el cerebro: cada archivo que lee o edita se ilumina en vivo. Puede tardar unos minutos.'}</p>
    <div class="log" id="joblog">${esc((j.log || []).join('\n'))}</div>
    <div class="modal-actions"><button class="btn" id="m-hide">${j.status === 'error' ? 'Cerrar' : 'Seguir mirando el cerebro'}</button></div>`);
  const lg = $('#joblog'); lg.scrollTop = lg.scrollHeight;
  $('#m-hide').onclick = () => { jobModalOpen = false; closeModal(); };
}
function pctBar(a) {
  const segs = [['pct_repetidas', '#ffb347'], ['pct_corruptas', '#ff5c72'], ['pct_viejas', '#6fb7ff'], ['pct_rotas', '#ff8fbd']];
  return `<div class="meter">${segs.map(([k, c]) => `<i style="width:${Math.min(100, a[k] || 0)}%;background:${c}"></i>`).join('')}</div>`;
}
function showAudit(a) {
  const g = S.graph;
  const kpi = (v, l, cls) => `<div class="kpi ${cls}"><div class="v">${v}</div><div class="l">${l}</div></div>`;
  openModal(`<button class="x" style="position:absolute;right:14px;top:12px;border:0;background:none;color:var(--muted);font-size:18px" id="m-x">×</button>
    <h2>Auditoría de tu memoria</h2><p class="lead">${esc(a.fecha || '')} · ${a.total} memorias revisadas por Claude${a._cost ? ` · costo ${a._cost.toFixed(2)} USD` : ''}</p>
    <div class="kpis">${kpi((a.pct_repetidas ?? 0) + '%', `repetidas (${a.repetidas})`, a.pct_repetidas > 5 ? 'warn' : 'good')}${kpi((a.pct_corruptas ?? 0) + '%', `corruptas (${a.corruptas})`, a.pct_corruptas > 2 ? 'bad' : 'good')}
    ${kpi((a.pct_viejas ?? 0) + '%', `viejas (${a.viejas})`, a.pct_viejas > 10 ? 'warn' : 'good')}${kpi((a.salud ?? 0) + '%', 'salud', a.salud < 85 ? 'warn' : 'good')}</div>
    ${pctBar(a)}<p>${esc(a.resumen || '')}</p>
    <h3 style="font-size:11px;letter-spacing:.08em;color:var(--muted)">HALLAZGOS · ${a.hallazgos?.length || 0}</h3>
    <div class="issues">${(a.hallazgos || []).map(h => `<div class="issue"><span class="k ${esc(h.tipo)}">${esc(h.tipo)}</span>${esc(h.motivo)}
      <div class="files">${(h.archivos || []).map((f, k) => h.nodos?.[k] != null ? `<a data-i="${h.nodos[k]}" style="cursor:pointer;text-decoration:underline">${esc(f)}</a>` : esc(f)).join('<br>')}</div>
      <div class="fix">→ ${esc(h.arreglo)}</div></div>`).join('') || '<div class="muted">Nada para marcar. Tu memoria está sana.</div>'}</div>
    <div class="modal-actions"><button class="btn" id="m-re">Auditar de nuevo</button><button class="btn" id="m-close">Cerrar</button>${a.hallazgos?.length ? '<button class="btn primary" id="m-fix">Mejorar memoria</button>' : ''}</div>`);
  if (a.nodos?.length && g) brain.setHighlight(new Set(a.nodos.filter(i => i < g.nodes.length)));
  $('#m-x').onclick = $('#m-close').onclick = closeModal;
  $('#m-re').onclick = startAudit;
  if ($('#m-fix')) $('#m-fix').onclick = confirmImprove;
  card.querySelectorAll('a[data-i]').forEach(el => (el.onclick = () => { closeModal(); openNote(+el.dataset.i); }));
}
function showImprove(r) {
  openModal(`<h2>Memoria mejorada</h2><p class="lead">${esc(r.resumen || '')}</p>
    <div class="issues">${(r.cambios || []).map(c => `<div class="issue"><span class="k repetida">${esc(c.accion)}</span>${esc(c.detalle)}<div class="files">${esc(c.archivo)}</div></div>`).join('')}
    ${(r.borradas || []).map(f => `<div class="issue"><span class="k corrupta">borrada</span><div class="files">${esc(f)}</div></div>`).join('')}</div>
    <p class="muted" style="margin-top:12px">Backup en <code>${esc(r.backup || '')}</code></p>
    <div class="modal-actions"><button class="btn" id="m-undo">Deshacer todo</button><button class="btn primary" id="m-close">Listo</button></div>`);
  $('#m-close').onclick = closeModal;
  $('#m-undo').onclick = async () => {
    const j = await fetch('/api/undo', { method: 'POST' }).then(x => x.json());
    openModal(`<h2>${j.ok ? 'Restaurado' : 'No se pudo deshacer'}</h2><p class="lead">${j.ok ? `Volvieron ${j.info} memorias desde el backup.` : esc(j.info)}</p><div class="modal-actions"><button class="btn primary" id="m-close2">Cerrar</button></div>`);
    $('#m-close2').onclick = closeModal;
  };
}

// ------------------------------------------------------------------ API para grabar demos (demo/grabar.mjs)
window.cerebro.demo = {
  handle, openNote, closeDrawer, showAudit, closeModal,
  setColor: mode => document.querySelector(`#color-seg button[data-color="${mode}"]`)?.click(),
  find: text => S.graph.nodes.findIndex(n => fold(n.t).includes(fold(text))),
  bubble(q, text, thinking) {
    voiceTurn.id = 'demo'; voiceTurn.q = q; voiceTurn.text = thinking ? '' : text;
    renderVoiceBubble(false);
  },
  hideBubble: () => bubble.classList.add('hidden'),
  bubbleHTML: html => showBubble(html),
  voice(level, speaking) { voiceLevel = level; S.speaking = speaking; brain.setVoiceLevel(speaking ? level : 0); $('#btn-voice').classList.toggle('speaking', speaking); },
  listening(on) { S.listening = on; $('#btn-voice').classList.toggle('live', on); $('#voice-label').textContent = on ? 'Escuchando…' : 'Voz'; },
  job: onJob,
};

// ------------------------------------------------------------------ arranque
(async function start() {
  if (!new URLSearchParams(location.search).has('nolive')) connect();
  else { S.connected = true; $('#conn-dot').classList.add('on'); $('#conn-txt').textContent = 'conectado'; }
  loadVoiceStatus();
  fetch('/api/job').then(r => r.json()).then(j => onJob(j)).catch(() => {});
  try { await loadGraph(false); } catch (e) { $('#loading').textContent = 'No se pudo cargar el grafo: ' + e.message; }
})();

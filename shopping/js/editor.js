// Editor do grafo: nós, arestas, lojas e trocas de piso sobre a planta.
import { MapView, svgEl } from './mapview.js';
import { norm } from './graph.js';

const $ = (s) => document.querySelector(s);
const DRAFT_KEY = 'snsnav.draft';
const GROUPS = ['Alimentação', 'Beleza', 'Calçados', 'Casa', 'Facilidades', 'Lazer', 'Moda', 'Óticas e joias', 'Serviços', 'Tecnologia', 'Outros'];
const TR_TYPES = ['escalator', 'elevator', 'stairs', 'ramp'];
const TR_NAME = { escalator: 'Escada rolante', elevator: 'Elevador', stairs: 'Escada', ramp: 'Esteira / rampa' };
const HINTS = {
  pan: 'Clique para selecionar. Arraste um nó ou o marcador verde de uma loja para mover. Delete apaga o item selecionado.',
  node: 'Clique no corredor para criar um nó. Clicar sobre uma aresta divide a aresta naquele ponto.',
  edge: 'Clique em dois nós em sequência para ligá-los. Clicar no vazio cria o nó na hora. Esc encerra a sequência.',
  poi: 'Clique na porta da loja. O editor cria a loja, pede o nome e liga a porta ao corredor mais próximo.',
  link: 'Clique no nó da escada/elevador neste piso, mude de piso nas abas e clique no nó correspondente.',
};

let data, view, L, floor, tool = 'pan';
let sel = null;          // {kind:'node'|'edge'|'poi', id}
let chain = null;        // último nó da sequência de arestas
let pendingLink = null;  // nó de origem da troca de piso
let drag = null;
const undoStack = [];
const localImages = new Map(); // piso -> object URL da imagem escolhida

init();

async function init() {
  const draft = localStorage.getItem(DRAFT_KEY);
  if (draft && confirm('Há um rascunho salvo neste navegador. Continuar de onde parou?\n(Cancelar carrega o mapa publicado.)')) {
    data = JSON.parse(draft);
  } else {
    data = await (await fetch('data/mall.json')).json();
  }
  view = new MapView($('#map'));
  L = {
    polys: svgEl('g', {}, view.svg), edges: svgEl('g', {}, view.svg), nodes: svgEl('g', {}, view.svg),
    pois: svgEl('g', {}, view.svg), labels: svgEl('g', {}, view.svg), over: svgEl('g', {}, view.svg),
  };
  view.panEnabled = (e) => !hitOf(e.target) || tool !== 'pan';
  view.onTap = onTap;
  view.onChange = scaleMarks;
  bind();
  setTool('pan');
  setFloor([...data.floors].sort((a, b) => a.level - b.level)[1]?.id || data.floors[0].id, true);
  status();
}

/* ---------- utilidades de dados ---------- */
const node = (id) => data.nodes.find((n) => n.id === id);
const poiOfNode = (id) => data.pois.find((p) => p.node === id);
const newNodeId = () => data.nodes.reduce((m, n) => Math.max(m, n.id), -1) + 1;
const edgeKey = (e) => `${e.a}-${e.b}`;
const curFloor = () => data.floors.find((f) => f.id === floor);

function snapshot() {
  undoStack.push(JSON.stringify(data));
  if (undoStack.length > 60) undoStack.shift();
}
function commit() {
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(data)); } catch { /* cota cheia: segue sem rascunho */ }
  render();
  status();
}
function undo() {
  const s = undoStack.pop();
  if (!s) return;
  data = JSON.parse(s);
  sel = chain = pendingLink = null;
  if (!curFloor()) floor = data.floors[0].id;
  setFloor(floor, false);
  commit();
}
function status() {
  $('#status').textContent = `${data.nodes.length} nós · ${data.edges.length} arestas · ${data.pois.length} lojas`;
}

function addNode(x, y, t = 'c') {
  const n = { id: newNodeId(), f: floor, x: +x.toFixed(1), y: +y.toFixed(1), t };
  data.nodes.push(n);
  return n;
}
function addEdge(a, b, t = 'walk') {
  if (a === b) return;
  const [x, y] = a < b ? [a, b] : [b, a];
  if (!data.edges.some((e) => e.a === x && e.b === y)) data.edges.push({ a: x, b: y, t });
}
function removeNode(id) {
  data.edges = data.edges.filter((e) => e.a !== id && e.b !== id);
  data.pois = data.pois.filter((p) => p.node !== id);
  data.nodes = data.nodes.filter((n) => n.id !== id);
}
function projOnEdge(pt, e) {
  const a = node(e.a), b = node(e.b);
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / l2));
  const q = { x: a.x + t * dx, y: a.y + t * dy };
  return { d: Math.hypot(pt.x - q.x, pt.y - q.y), q, t };
}
function splitEdge(e, q) {
  const m = addNode(q.x, q.y);
  data.edges = data.edges.filter((x) => x !== e);
  addEdge(e.a, m.id); addEdge(m.id, e.b);
  return m;
}
/** Nó de corredor mais próximo de pt (dividindo uma aresta se preciso). */
function attachToCorridor(pt) {
  let best = null;
  for (const e of data.edges) {
    if ((e.t || 'walk') !== 'walk') continue;
    const a = node(e.a), b = node(e.b);
    if (a.f !== floor || b.f !== floor || a.t === 'door' || b.t === 'door') continue;
    const p = projOnEdge(pt, e);
    if (!best || p.d < best.d) best = { ...p, e };
  }
  if (!best) {
    const near = data.nodes.filter((n) => n.f === floor && n.t !== 'door')
      .sort((m, n) => Math.hypot(m.x - pt.x, m.y - pt.y) - Math.hypot(n.x - pt.x, n.y - pt.y))[0];
    return near || null;
  }
  const tol = 8 / view.k;
  for (const id of [best.e.a, best.e.b]) {
    const n = node(id);
    if (Math.hypot(n.x - best.q.x, n.y - best.q.y) < tol) return n;
  }
  return splitEdge(best.e, best.q);
}

/* ---------- desenho ---------- */
function setFloor(id, fit) {
  floor = id;
  const f = curFloor();
  view.setFloor(localImages.get(id) || f.image, f.width, f.height);
  const tabs = $('#floor-tabs');
  tabs.textContent = '';
  for (const fl of [...data.floors].sort((a, b) => a.level - b.level)) {
    const b = document.createElement('button');
    b.className = 'tb';
    b.textContent = fl.id;
    b.title = fl.name;
    b.setAttribute('aria-pressed', fl.id === id);
    b.onclick = () => { chain = null; sel = null; setFloor(fl.id, true); };
    tabs.appendChild(b);
  }
  $('#fl-name').value = f.name;
  $('#fl-level').value = f.level;
  render();
  if (fit) {
    const ns = data.nodes.filter((n) => n.f === id);
    if (ns.length) {
      const xs = ns.map((n) => n.x), ys = ns.map((n) => n.y);
      view.fit([Math.min(...xs) - 60, Math.min(...ys) - 60, Math.max(...xs) + 60, Math.max(...ys) + 60], {}, false, 3);
    } else view.fit([0, 0, f.width, f.height], {}, false);
  }
}

function render() {
  for (const g of Object.values(L)) g.textContent = '';
  const onFloor = new Map(data.nodes.filter((n) => n.f === floor).map((n) => [n.id, n]));
  const showLabels = $('#show-labels').checked;

  for (const p of data.pois) {
    if (p.f !== floor) continue;
    if (p.poly?.length >= 6) svgEl('polygon', { points: p.poly.join(' '), class: 'poly' }, L.polys);
    const c = svgEl('rect', { class: 'p' + (isSel('poi', p.id) ? ' sel' : '') }, L.pois);
    c.dataset.kind = 'poi'; c.dataset.id = p.id; c._x = p.x; c._y = p.y;
    svgEl('title', {}, c).textContent = p.name;
    if (showLabels) svgEl('text', { class: 'plabel', x: p.x, y: p.y - 7 }, L.labels).textContent = p.name;
  }
  for (const e of data.edges) {
    const a = onFloor.get(e.a), b = onFloor.get(e.b);
    if (!a || !b) continue;
    const key = edgeKey(e), door = a.t === 'door' || b.t === 'door';
    const at = { x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    svgEl('line', { ...at, class: 'e' + (door ? ' door' : '') + (isSel('edge', key) ? ' sel' : '') }, L.edges);
    const h = svgEl('line', { ...at, class: 'e-hit' }, L.edges);
    h.dataset.kind = 'edge'; h.dataset.id = key;
  }
  const linked = new Set();
  for (const e of data.edges) if ((e.t || 'walk') !== 'walk') { linked.add(e.a); linked.add(e.b); }
  for (const n of onFloor.values()) {
    const cls = ['n', n.t === 'door' ? 'door' : '', linked.has(n.id) ? 'tr' : '', isSel('node', n.id) ? 'sel' : '',
      pendingLink === n.id || chain === n.id ? 'pending' : ''].join(' ');
    const c = svgEl('circle', { cx: n.x, cy: n.y, class: cls }, L.nodes);
    c.dataset.kind = 'node'; c.dataset.id = n.id;
  }
  scaleMarks();
  renderProps();
  renderPoiList();
}

function scaleMarks() {
  const k = view.k, r = 5 / k;
  for (const c of L.nodes.children) c.setAttribute('r', c.classList.contains('tr') ? r * 1.5 : r);
  const s = 6 / k;
  for (const c of L.pois.children) {
    c.setAttribute('x', c._x - s); c.setAttribute('y', c._y - s);
    c.setAttribute('width', 2 * s); c.setAttribute('height', 2 * s); c.setAttribute('rx', s / 3);
  }
  L.labels.style.display = k > 0.9 ? '' : 'none';
  for (const t of L.labels.children) t.setAttribute('font-size', 11 / k);
}

const isSel = (kind, id) => sel && sel.kind === kind && String(sel.id) === String(id);
const hitOf = (t) => (t?.dataset?.kind ? { kind: t.dataset.kind, id: t.dataset.kind === 'node' ? +t.dataset.id : t.dataset.id } : null);

/* ---------- interação ---------- */
function setTool(t) {
  tool = t;
  chain = null;
  if (t !== 'link') pendingLink = null;
  for (const b of document.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', b.dataset.tool === t);
  $('#map').className = 'tool-' + t;
  $('#hint').textContent = HINTS[t];
  $('#link-type').hidden = t !== 'link';
  $('#rubber')?.remove();
  if (data) render();
}

function onTap(pt, ev, target) {
  const hit = hitOf(target);
  if (tool === 'pan') { sel = hit; render(); return; }

  if (tool === 'node') {
    if (hit?.kind === 'node') { sel = hit; render(); return; }
    snapshot();
    let n;
    if (hit?.kind === 'edge') {
      const e = data.edges.find((x) => edgeKey(x) === hit.id);
      n = splitEdge(e, projOnEdge(pt, e).q);
    } else n = addNode(pt.x, pt.y);
    sel = { kind: 'node', id: n.id };
    commit();
    return;
  }

  if (tool === 'edge') {
    snapshot();
    let n;
    if (hit?.kind === 'node') n = node(hit.id);
    else if (hit?.kind === 'edge') {
      const e = data.edges.find((x) => edgeKey(x) === hit.id);
      n = splitEdge(e, projOnEdge(pt, e).q);
    } else n = addNode(pt.x, pt.y);
    if (chain != null && node(chain)?.f === floor) addEdge(chain, n.id);
    chain = n.id;
    sel = { kind: 'node', id: n.id };
    commit();
    return;
  }

  if (tool === 'poi') {
    const name = prompt('Nome da loja:');
    if (!name?.trim()) return;
    snapshot();
    const at = attachToCorridor(pt);
    const d = addNode(pt.x, pt.y, 'door');
    if (at) addEdge(at.id, d.id);
    const id = 'p' + (data.pois.reduce((m, p) => Math.max(m, +String(p.id).slice(1) || 0), 0) + 1);
    data.pois.push({ id, name: name.trim(), f: floor, x: Math.round(pt.x), y: Math.round(pt.y), node: d.id, group: 'Outros', cat: '', poly: [] });
    sel = { kind: 'poi', id };
    commit();
    return;
  }

  if (tool === 'link') {
    if (hit?.kind !== 'node' || node(hit.id).t === 'door') return;
    if (pendingLink == null || node(pendingLink).f === floor) {
      pendingLink = hit.id;
      $('#hint').textContent = `Origem marcada no piso ${floor}. Agora mude de piso nas abas e clique no nó de chegada.`;
      render();
      return;
    }
    snapshot();
    const t = $('#ttype').value;
    addEdge(pendingLink, hit.id, t);
    for (const id of [pendingLink, hit.id]) node(id).t = t;
    pendingLink = null;
    $('#hint').textContent = HINTS.link;
    sel = hit;
    commit();
  }
}

function bind() {
  for (const b of document.querySelectorAll('[data-tool]')) b.onclick = () => setTool(b.dataset.tool);
  const map = $('#map');

  // arrastar nós e marcadores de loja
  map.addEventListener('pointerdown', (e) => {
    if (tool !== 'pan' || e.button !== 0) return;
    const hit = hitOf(e.target);
    if (!hit || hit.kind === 'edge') return;
    drag = { hit, moved: false, start: view.toMap(e.clientX, e.clientY) };
    map.setPointerCapture(e.pointerId);
  });
  map.addEventListener('pointermove', (e) => {
    const pt = view.toMap(e.clientX, e.clientY);
    if (drag) {
      if (!drag.moved) {
        if (Math.hypot(pt.x - drag.start.x, pt.y - drag.start.y) * view.k < 4) return;
        drag.moved = true; snapshot(); sel = drag.hit;
      }
      const o = drag.hit.kind === 'node' ? node(drag.hit.id) : data.pois.find((p) => p.id === drag.hit.id);
      o.x = +pt.x.toFixed(1); o.y = +pt.y.toFixed(1);
      render();
      return;
    }
    // linha-guia da sequência de arestas
    $('#rubber')?.remove();
    if (tool === 'edge' && chain != null && node(chain)?.f === floor) {
      const a = node(chain);
      const l = svgEl('line', { x1: a.x, y1: a.y, x2: pt.x, y2: pt.y, class: 'rubber', id: 'rubber' }, L.over);
      l.style.pointerEvents = 'none';
    }
  });
  const end = () => { if (drag?.moved) commit(); drag = null; };
  map.addEventListener('pointerup', end);
  map.addEventListener('pointercancel', end);

  addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    const k = e.key.toLowerCase();
    if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); undo(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'escape') { chain = null; pendingLink = null; sel = null; $('#rubber')?.remove(); render(); }
    else if (k === 'delete' || k === 'backspace') { e.preventDefault(); deleteSel(); }
    else if (k === 'v') setTool('pan');
    else if (k === 'n') setTool('node');
    else if (k === 'e') setTool('edge');
    else if (k === 'l') setTool('poi');
    else if (k === 't') setTool('link');
  });

  $('#undo').onclick = undo;
  $('#export').onclick = exportJson;
  $('#import').onclick = () => $('#file-json').click();
  $('#file-json').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const d = JSON.parse(await file.text());
      if (!Array.isArray(d.floors) || !Array.isArray(d.nodes) || !Array.isArray(d.edges) || !Array.isArray(d.pois)) throw new Error('formato');
      snapshot();
      data = d; sel = chain = pendingLink = null;
      setFloor(data.floors[0].id, true);
      commit();
    } catch { alert('Arquivo inválido: esperava um JSON exportado por este editor.'); }
    e.target.value = '';
  };
  $('#test').onclick = () => { commit(); window.open('index.html?draft=1', '_blank'); };

  $('#fl-name').onchange = (e) => { snapshot(); curFloor().name = e.target.value.trim() || curFloor().id; commit(); };
  $('#fl-level').onchange = (e) => { snapshot(); curFloor().level = +e.target.value || 0; setFloor(floor, false); commit(); };
  $('#fl-img').onclick = () => $('#file-img').click();
  $('#file-img').onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      snapshot();
      const f = curFloor();
      f.width = img.naturalWidth; f.height = img.naturalHeight; f.image = 'maps/' + file.name;
      localImages.set(f.id, url);
      setFloor(f.id, true);
      commit();
      alert(`Imagem aplicada. Antes de publicar, copie "${file.name}" para a pasta maps/.`);
    };
    img.src = url;
    e.target.value = '';
  };
  $('#add-floor').onclick = () => {
    const id = prompt('Sigla do novo piso (ex.: L4):')?.trim();
    if (!id) return;
    if (data.floors.some((f) => f.id === id)) { alert('Já existe um piso com essa sigla.'); return; }
    snapshot();
    const top = Math.max(...data.floors.map((f) => f.level));
    const ref = curFloor();
    data.floors.push({ id, name: id, level: top + 1, image: '', width: ref.width, height: ref.height });
    setFloor(id, true);
    commit();
  };
  $('#opacity').oninput = (e) => { view.img.style.opacity = e.target.value; };
  $('#show-labels').onchange = render;
  $('#poi-q').oninput = renderPoiList;
  $('#check').onclick = check;
  addEventListener('beforeunload', () => { try { localStorage.setItem(DRAFT_KEY, JSON.stringify(data)); } catch { /* ignora */ } });
}

function deleteSel() {
  if (!sel) return;
  snapshot();
  if (sel.kind === 'node') removeNode(sel.id);
  else if (sel.kind === 'edge') {
    const e = data.edges.find((x) => edgeKey(x) === sel.id);
    data.edges = data.edges.filter((x) => x !== e);
    // nó de troca de piso sem mais nenhuma troca volta a ser corredor
    for (const id of [e.a, e.b]) {
      const n = node(id);
      if (n && TR_TYPES.includes(n.t) && !data.edges.some((x) => (x.a === id || x.b === id) && (x.t || 'walk') !== 'walk')) n.t = 'c';
    }
  } else if (sel.kind === 'poi') {
    const p = data.pois.find((x) => x.id === sel.id);
    if (p) removeNode(p.node);
  }
  sel = null;
  commit();
}

/* ---------- painel lateral ---------- */
function field(parent, label, input) {
  const l = document.createElement('label');
  l.textContent = label;
  parent.append(l, input);
  return input;
}
function inputEl(value, onChange) {
  const i = document.createElement('input');
  i.type = 'text'; i.value = value ?? '';
  i.onchange = () => { snapshot(); onChange(i.value.trim()); commit(); };
  return i;
}
function selectEl(options, value, onChange) {
  const s = document.createElement('select');
  for (const [v, t] of options) { const o = document.createElement('option'); o.value = v; o.textContent = t; s.appendChild(o); }
  s.value = value;
  s.onchange = () => { snapshot(); onChange(s.value); commit(); };
  return s;
}

function renderProps() {
  const box = $('#props-body');
  box.textContent = '';
  $('#props').hidden = !sel;
  if (!sel) return;
  const info = (t) => { const p = document.createElement('p'); p.textContent = t; box.appendChild(p); };
  if (sel.kind === 'node') {
    const n = node(sel.id);
    if (!n) { sel = null; $('#props').hidden = true; return; }
    const p = poiOfNode(n.id);
    info(`Nó ${n.id} · piso ${n.f} · (${Math.round(n.x)}, ${Math.round(n.y)})`);
    if (p) info(`Porta de: ${p.name}`);
    const links = data.edges.filter((e) => (e.a === n.id || e.b === n.id) && (e.t || 'walk') !== 'walk');
    for (const e of links) {
      const other = node(e.a === n.id ? e.b : e.a);
      info(`${TR_NAME[e.t] || e.t} ↔ piso ${other.f}`);
    }
  } else if (sel.kind === 'edge') {
    const e = data.edges.find((x) => edgeKey(x) === sel.id);
    if (!e) { sel = null; $('#props').hidden = true; return; }
    const a = node(e.a), b = node(e.b);
    info(`Aresta ${e.a} – ${e.b} · ${(Math.hypot(a.x - b.x, a.y - b.y) / (data.meta?.pxPerMeter || 10)).toFixed(0)} m`);
  } else {
    const p = data.pois.find((x) => x.id === sel.id);
    if (!p) { sel = null; $('#props').hidden = true; return; }
    field(box, 'Nome', inputEl(p.name, (v) => { if (v) p.name = v; }));
    field(box, 'Grupo', selectEl(GROUPS.map((g) => [g, g]), GROUPS.includes(p.group) ? p.group : 'Outros', (v) => { p.group = v; }));
    field(box, 'Categoria (texto livre)', inputEl(p.cat, (v) => { p.cat = v; }));
    info('O quadrado verde é a posição do nome; o círculo azul ligado a ele é a porta.');
  }
  const del = document.createElement('button');
  del.className = 'tb';
  del.textContent = 'Apagar';
  del.onclick = deleteSel;
  const row = document.createElement('div');
  row.className = 'row';
  row.appendChild(del);
  box.appendChild(row);
}

function renderPoiList() {
  const ul = $('#poi-list');
  const q = norm($('#poi-q').value);
  ul.textContent = '';
  const list = data.pois.filter((p) => !q || norm(p.name).includes(q))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt')).slice(0, 80);
  for (const p of list) {
    const li = document.createElement('li');
    const a = document.createElement('span'), b = document.createElement('span');
    a.textContent = p.name; b.textContent = p.f;
    li.append(a, b);
    li.onclick = () => focusOn(p.f, p.x, p.y, { kind: 'poi', id: p.id });
    ul.appendChild(li);
  }
}

function focusOn(f, x, y, s) {
  if (f !== floor) setFloor(f, false);
  sel = s;
  view.fit([x - 120, y - 120, x + 120, y + 120], {}, true, 3);
  render();
}

/* ---------- verificação e exportação ---------- */
function check() {
  const ul = $('#issues');
  ul.textContent = '';
  const add = (text, go) => { const li = document.createElement('li'); li.textContent = text; if (go) li.onclick = go; ul.appendChild(li); };
  const adj = new Map(data.nodes.map((n) => [n.id, []]));
  for (const e of data.edges) { adj.get(e.a)?.push(e.b); adj.get(e.b)?.push(e.a); }
  // maior componente conexo
  const comp = new Map();
  let best = null, sizes = [];
  for (const n of data.nodes) {
    if (comp.has(n.id)) continue;
    const c = sizes.length, stack = [n.id];
    let size = 0;
    while (stack.length) {
      const u = stack.pop();
      if (comp.has(u)) continue;
      comp.set(u, c); size++;
      stack.push(...adj.get(u));
    }
    sizes.push(size);
    if (best == null || size > sizes[best]) best = c;
  }
  let problems = 0;
  for (const p of data.pois) {
    const n = node(p.node);
    if (!n) { add(`${p.name}: sem porta`, null); problems++; continue; }
    if (comp.get(n.id) !== best) { add(`${p.name} (${p.f}): sem caminho até o restante do shopping`, () => focusOn(p.f, p.x, p.y, { kind: 'poi', id: p.id })); problems++; }
  }
  for (const n of data.nodes) {
    if (!adj.get(n.id).length) { add(`Nó ${n.id} (${n.f}) solto`, () => focusOn(n.f, n.x, n.y, { kind: 'node', id: n.id })); problems++; }
  }
  const names = new Map();
  for (const p of data.pois) names.set(p.name.trim().toLowerCase() + '|' + p.f, (names.get(p.name.trim().toLowerCase() + '|' + p.f) || 0) + 1);
  for (const p of data.pois) if (names.get(p.name.trim().toLowerCase() + '|' + p.f) > 1) { add(`Nome repetido no ${p.f}: ${p.name}`, () => focusOn(p.f, p.x, p.y, { kind: 'poi', id: p.id })); problems++; }
  for (const f of data.floors) {
    const has = data.edges.some((e) => (e.t || 'walk') !== 'walk' && (node(e.a)?.f === f.id || node(e.b)?.f === f.id));
    if (!has && data.floors.length > 1) { add(`Piso ${f.id} sem escada/elevador ligado a outro piso`, null); problems++; }
  }
  if (!problems) add('Tudo certo: todas as lojas têm caminho entre si.', null);
}

function exportJson() {
  const out = {
    ...data,
    nodes: data.nodes.map((n) => ({ ...n, x: +(+n.x).toFixed(1), y: +(+n.y).toFixed(1) })),
    pois: [...data.pois].sort((a, b) => a.name.localeCompare(b.name, 'pt')),
  };
  const blob = new Blob([JSON.stringify(out)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'mall.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

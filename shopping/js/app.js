import { Mall, TRANSITION, fmtDist, fmtTime } from './graph.js';
import { MapView, svgEl } from './mapview.js';

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const DRAFT_KEY = 'snsnav.draft';
const ICON = {
  start: '●', straight: '↑', right: '↱', left: '↰', 'slight-right': '↗', 'slight-left': '↖',
  uturn: '↶', arrive: '⚑',
};

const state = { from: null, to: null, floor: null, route: null, step: 0, picked: null, accessible: false, open: false };
let mall, view, layers, picking = 'from', group = '';
let cullRaf = 0;
const markers = [];

async function init() {
  const useDraft = new URLSearchParams(location.search).has('draft') && localStorage.getItem(DRAFT_KEY);
  if (useDraft) {
    mall = new Mall(JSON.parse(localStorage.getItem(DRAFT_KEY)));
    $('#draft-flag').hidden = false;
  } else {
    mall = await Mall.load('data/mall.json');
  }

  view = new MapView($('#map'));
  layers = {
    hit: svgEl('g', {}, view.svg),
    sel: svgEl('g', {}, view.svg),
    route: svgEl('g', {}, view.svg),
    labels: svgEl('g', {}, view.svg),
  };
  view.onChange = () => { placeMarkers(); cullLabels(); };
  view.onTap = onMapTap;

  buildFloors();
  buildGroups();
  bindUI();

  const h = new URLSearchParams(location.hash.slice(1));
  state.from = mall.poiById.get(h.get('de')) || null;
  state.to = mall.poiById.get(h.get('para')) || null;
  state.accessible = h.get('acessivel') === '1';
  $('#accessible').checked = state.accessible;

  setFloor(state.from?.f || 'L1', false);
  update(true);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

/* ---------- interface ---------- */
function bindUI() {
  $('#f-from').onclick = () => openPicker('from');
  $('#f-to').onclick = () => openPicker('to');
  $('#swap').onclick = () => { [state.from, state.to] = [state.to, state.from]; update(true); };
  $('#accessible').onchange = (e) => { state.accessible = e.target.checked; update(true); };
  $('#zin').onclick = () => view.zoomBy(1.6);
  $('#zout').onclick = () => view.zoomBy(1 / 1.6);
  $('#q').oninput = renderResults;
  $('#picker').addEventListener('close', () => { $('#q').value = ''; });
  addEventListener('resize', () => placeMarkers());
}

function buildFloors() {
  const nav = $('#floors');
  for (const f of [...mall.floors].reverse()) {
    const b = el('button', '', f.id);
    b.type = 'button';
    b.dataset.f = f.id;
    b.title = f.name;
    b.onclick = () => setFloor(f.id, true);
    nav.appendChild(b);
  }
}

function buildGroups() {
  const box = $('#groups');
  const groups = ['', ...new Set(mall.pois.map((p) => p.group))].sort((a, b) => a.localeCompare(b, 'pt'));
  for (const g of groups) {
    const c = el('button', 'chip', g || 'Tudo');
    c.type = 'button';
    c.onclick = () => { group = g; [...box.children].forEach((x) => x.classList.toggle('on', x === c)); renderResults(); };
    if (!g) c.classList.add('on');
    box.appendChild(c);
  }
}

function openPicker(which) {
  picking = which;
  $('#q').placeholder = which === 'from' ? 'Perto de qual loja você está?' : 'Para onde você quer ir?';
  renderResults();
  $('#picker').showModal();
  $('#q').focus();
}

function renderResults() {
  const ul = $('#results');
  ul.textContent = '';
  const list = mall.search($('#q').value, group);
  if (!list.length) { ul.appendChild(el('li', 'empty', 'Nada encontrado.')); return; }
  for (const p of list) {
    const li = el('li');
    li.tabIndex = 0;
    const box = el('div');
    box.append(el('div', 'n', p.name), el('div', 'c', p.cat || p.group));
    li.append(box, el('span', 'f', p.f));
    const pick = () => { state[picking] = p; state.picked = null; $('#picker').close(); update(true); };
    li.onclick = pick;
    li.onkeydown = (e) => { if (e.key === 'Enter') pick(); };
    ul.appendChild(li);
  }
}

/* ---------- piso ---------- */
function setFloor(fid, refit) {
  const f = mall.floorById.get(fid);
  if (!f) return;
  const changed = state.floor !== fid;
  state.floor = fid;
  if (changed) {
    view.setFloor(f.image, f.width, f.height);
    drawFloor(f);
  }
  for (const b of $('#floors').children) b.setAttribute('aria-pressed', b.dataset.f === fid);
  drawRoute();
  if (refit) fitCurrent();
}

function drawFloor(f) {
  layers.hit.textContent = '';
  layers.labels.textContent = '';
  const dark = f.id === 'G1';
  for (const p of mall.pois) {
    if (p.f !== f.id) continue;
    let box;
    if (p.poly?.length >= 6) {
      const xs = p.poly.filter((_, i) => i % 2 === 0), ys = p.poly.filter((_, i) => i % 2);
      box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      const poly = svgEl('polygon', { points: p.poly.join(' '), class: 'poi-hit' }, layers.hit);
      poly.dataset.id = p.id;
    } else {
      box = [p.x - 22, p.y - 10, p.x + 22, p.y + 10];
    }
    addLabel(p, box, dark);
  }
  cullLabels();
}

function addLabel(p, box, dark) {
  const name = p.name.replace(/\s*\((QUIOSQUE[^)]*|EM BREVE|\d+)\)/gi, '').trim();
  const w = (box[2] - box[0]) * 0.9, h = (box[3] - box[1]) * 0.85;
  const words = name.split(' ');
  let best = { fs: 0, lines: [name] };
  for (let n = 1; n <= Math.min(3, words.length); n++) {
    const lines = wrap(words, n);
    const longest = Math.max(...lines.map((l) => l.length));
    const fs = Math.min(w / (longest * 0.58), h / (lines.length * 1.15), 30);
    if (fs > best.fs) best = { fs, lines };
  }
  const fs = Math.max(best.fs, 3.5);
  const t = svgEl('text', { class: 'lbl' + (dark ? ' dark' : ''), x: p.x, 'font-size': fs.toFixed(1) }, layers.labels);
  const y0 = p.y - ((best.lines.length - 1) * fs * 1.1) / 2 + fs * 0.35;
  best.lines.forEach((l, i) => { svgEl('tspan', { x: p.x, y: (y0 + i * fs * 1.1).toFixed(1) }, t).textContent = l; });
  t._fs = fs;
}

function wrap(words, n) {
  if (n === 1) return [words.join(' ')];
  const target = words.join(' ').length / n, lines = [];
  let cur = '';
  for (const w of words) {
    if (cur && lines.length < n - 1 && (cur + ' ' + w).length > target + 2) { lines.push(cur); cur = w; }
    else cur = cur ? cur + ' ' + w : w;
  }
  lines.push(cur);
  return lines;
}

function cullLabels() {
  if (cullRaf) return;
  cullRaf = requestAnimationFrame(() => {
    cullRaf = 0;
    for (const t of layers.labels.children) t.style.display = t._fs * view.k >= 6.5 ? '' : 'none';
  });
}

/* ---------- toque no mapa ---------- */
function onMapTap(pt, ev, target) {
  let p = target?.dataset?.id ? mall.poiById.get(target.dataset.id) : null;
  if (!p) {
    let bd = 24 / view.k;
    for (const q of mall.pois) {
      if (q.f !== state.floor) continue;
      const d = Math.hypot(q.x - pt.x, q.y - pt.y);
      if (d < bd) { bd = d; p = q; }
    }
  }
  if (!p) { if (state.picked) { state.picked = null; update(false); } return; }
  state.picked = p;
  update(false);
}

/* ---------- estado → tela ---------- */
function update(refit) {
  setField('#f-from', state.from, 'Escolha a loja mais próxima');
  setField('#f-to', state.to, 'Escolha o destino');

  state.route = null;
  if (state.from && state.to && state.from.id !== state.to.id) {
    state.route = mall.route(state.from.id, state.to.id, { accessible: state.accessible });
  }
  if (refit) state.step = 0;

  const h = new URLSearchParams();
  if (state.from) h.set('de', state.from.id);
  if (state.to) h.set('para', state.to.id);
  if (state.accessible) h.set('acessivel', '1');
  history.replaceState(null, '', location.pathname + location.search + (h.size ? '#' + h : ''));

  const inRoute = new Set(state.route?.floors || []);
  for (const b of $('#floors').children) b.classList.toggle('in-route', inRoute.has(b.dataset.f));

  renderSheet();
  if (refit) {
    const target = state.route ? state.route.steps[0].floor : (state.to || state.from)?.f;
    if (target) setFloor(target, true); else fitCurrent();
  } else {
    drawRoute();
  }
}

function setField(sel, poi, placeholder) {
  const b = $(sel);
  b.classList.toggle('set', !!poi);
  b.querySelector('span').textContent = poi ? `${poi.name} · ${poi.f}` : placeholder;
}

function renderSheet() {
  const s = $('#sheet');
  s.textContent = '';
  const p = state.picked;
  if (p) {
    const head = el('div', 'sheet-head');
    const g = el('div', 'grow');
    g.append(el('h2', '', p.name), el('p', '', [mall.floorById.get(p.f).name, p.cat || p.group].filter(Boolean).join(' · ')));
    const x = el('button', 'icon-btn', '✕');
    x.setAttribute('aria-label', 'Fechar');
    x.onclick = () => { state.picked = null; update(false); };
    head.append(g, x);
    const act = el('div', 'actions');
    const a = el('button', 'btn from', 'Estou aqui');
    a.onclick = () => { state.from = p; state.picked = null; update(true); };
    const b = el('button', 'btn primary', 'Ir para cá');
    b.onclick = () => { state.to = p; state.picked = null; update(true); };
    act.append(a, b);
    s.append(head, act);
    s.hidden = false;
    return;
  }
  if (state.from && state.to && state.from.id === state.to.id) {
    s.append(el('p', 'empty', 'Origem e destino são o mesmo lugar.'));
    s.hidden = false;
    return;
  }
  if (state.from && state.to && !state.route) {
    s.append(el('p', 'empty', state.accessible
      ? 'Não encontrei rota sem escada rolante entre esses pontos. Desmarque a opção para ver outras rotas.'
      : 'Não encontrei caminho entre esses pontos no mapa.'));
    s.hidden = false;
    return;
  }
  const r = state.route;
  if (!r) { s.hidden = true; return; }

  const head = el('div', 'sheet-head');
  const g = el('div', 'grow');
  const fl = r.floors.filter((f, i) => f !== r.floors[i - 1]);
  g.append(
    el('h2', '', `${fmtTime(r.seconds)} · ${fmtDist(r.meters)}`),
    el('p', '', fl.length > 1 ? `Pisos: ${fl.join(' → ')}` : `Tudo no piso ${fl[0]}`),
  );
  const prev = el('button', 'btn small', '‹');
  prev.setAttribute('aria-label', 'Passo anterior');
  const next = el('button', 'btn small primary', 'Próximo ›');
  prev.onclick = () => goStep(state.step - 1);
  next.onclick = () => goStep(state.step + 1);
  prev.disabled = state.step === 0;
  next.disabled = state.step === r.steps.length - 1;
  head.append(g, prev, next);

  const cur = r.steps[state.step];
  const now = el('div', 'now');
  const txt = el('div', 'txt', cur.text);
  if (cur.dist) txt.appendChild(el('small', '', `siga por ${fmtDist(cur.dist)}`));
  now.append(el('div', 'ico', stepIcon(cur)), txt);

  const ol = el('ol', 'steps');
  r.steps.forEach((st, i) => {
    const li = el('li', (i === state.step ? 'cur ' : '') + (st.kind === 'transition' ? 'floor-change' : ''));
    li.append(el('span', 'ico', stepIcon(st)), el('span', 'fl', st.floor), el('span', '', st.text));
    if (st.dist) li.append(el('span', 'd', fmtDist(st.dist)));
    li.onclick = () => goStep(i);
    ol.appendChild(li);
  });
  const more = el('button', 'more', state.open ? 'Ocultar passos' : `Ver os ${r.steps.length} passos`);
  more.onclick = () => { state.open = !state.open; renderSheet(); };
  ol.hidden = !state.open;
  s.append(head, now, more, ol);
  s.hidden = false;
  ol.querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
}

const stepIcon = (st) => (st.kind === 'transition' ? (st.up ? '⬆' : '⬇') : ICON[st.kind] || '↑');

function goStep(i) {
  const r = state.route;
  if (!r || i < 0 || i >= r.steps.length) return;
  state.step = i;
  renderSheet();
  const st = r.steps[i];
  // ao chegar num passo de troca de piso, o mapa mostra onde ela fica
  if (st.floor !== state.floor) setFloor(st.floor, false); else drawRoute();
  fitPoints(st.pts, 18 * mall.ppm);
}

/* ---------- rota no mapa ---------- */
function drawRoute() {
  layers.route.textContent = '';
  layers.sel.textContent = '';
  markers.length = 0;
  const r = state.route;
  const mark = (p, cls) => {
    if (!p || p.f !== state.floor) return;
    if (p.poly?.length >= 6) svgEl('polygon', { points: p.poly.join(' '), class: 'poi-sel ' + cls }, layers.sel);
    markers.push({ x: p.x, y: p.y, cls });
  };
  if (state.picked && state.picked !== state.from && state.picked !== state.to) {
    const p = state.picked;
    if (p.f === state.floor && p.poly?.length >= 6) svgEl('polygon', { points: p.poly.join(' '), class: 'poi-sel' }, layers.sel);
  }
  if (r) {
    r.legs.forEach((leg, i) => {
      if (leg.floor !== state.floor || leg.pts.length < 1) return;
      const d = leg.pts.map((p) => `${p.x},${p.y}`).join(' ');
      if (leg.pts.length > 1) {
        svgEl('polyline', { points: d, class: 'route-case' }, layers.route);
        svgEl('polyline', { points: d, class: 'route-line' }, layers.route);
      }
      const nextLeg = r.legs[i + 1], prevLeg = r.legs[i - 1];
      if (nextLeg) {
        const up = mall.level(nextLeg.floor) > mall.level(leg.floor), a = leg.pts.at(-1);
        markers.push({ x: a.x, y: a.y, cls: 'hop', text: `${up ? '⬆' : '⬇'} ${nextLeg.floor}`, go: nextLeg.floor, title: TRANSITION[nextLeg.via]?.label });
      }
      if (prevLeg && leg.pts.length > 1) {
        const a = leg.pts[0];
        markers.push({ x: a.x, y: a.y, cls: 'hop', text: `← ${prevLeg.floor}`, go: prevLeg.floor });
      }
    });
    const st = r.steps[state.step];
    if (st && st.floor === state.floor && st.pts.length > 1) {
      svgEl('polyline', { points: st.pts.map((p) => `${p.x},${p.y}`).join(' '), class: 'route-step' }, layers.route);
    }
  }
  mark(state.from, 'from');
  mark(state.to, 'to');
  placeMarkers();
}

function placeMarkers() {
  const box = $('#markers');
  while (box.children.length > markers.length) box.lastChild.remove();
  markers.forEach((m, i) => {
    let d = box.children[i];
    if (!d) d = box.appendChild(document.createElement('div'));
    const tag = m.cls === 'hop' ? 'BUTTON' : 'DIV';
    if (d.tagName !== tag) { const n = document.createElement(tag); d.replaceWith(n); d = n; }
    d.className = 'mk ' + m.cls;
    d.textContent = m.text || '';
    d.title = m.title || '';
    d.onclick = m.go ? () => setFloor(m.go, true) : null;
    const s = view.toScreen(m.x, m.y);
    d.style.left = s.x + 'px';
    d.style.top = s.y + 'px';
  });
}

/* ---------- enquadramento ---------- */
function pads() {
  const top = $('.top').getBoundingClientRect().bottom + 12;
  const sheet = $('#sheet');
  const wide = innerWidth >= 760;
  const sh = sheet.hidden ? 0 : sheet.getBoundingClientRect();
  return {
    t: top, r: 70,
    b: !wide && sh ? sh.height + 16 : 24,
    l: wide && sh ? sh.width + 30 : 16,
  };
}

function fitPoints(pts, minSize = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
  const gx = Math.max(0, (minSize - (x1 - x0)) / 2), gy = Math.max(0, (minSize - (y1 - y0)) / 2);
  view.fit([x0 - gx, y0 - gy, x1 + gx, y1 + gy], pads());
}

function fitCurrent() {
  const f = mall.floorById.get(state.floor);
  const pts = [];
  for (const leg of state.route?.legs || []) if (leg.floor === f.id) pts.push(...leg.pts);
  if (!pts.length) {
    for (const p of [state.from, state.to]) if (p && p.f === f.id) pts.push(p);
  }
  if (pts.length) return fitPoints(pts, 40 * mall.ppm);
  // piso inteiro: usa a área onde há lojas/corredores
  const all = mall.data.nodes.filter((n) => n.f === f.id);
  if (all.length) fitPoints(all, 0); else view.fit([0, 0, f.width, f.height], pads());
}

init().catch((err) => {
  console.error(err);
  const s = $('#sheet');
  s.hidden = false;
  s.textContent = 'Não foi possível carregar o mapa. Verifique a conexão e tente de novo.';
});

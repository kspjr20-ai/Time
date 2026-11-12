// Modelo de dados do shopping + rota por A* + instruções em texto.

export const TRANSITION = {
  escalator: { label: 'escada rolante', cost: 20, accessible: false },
  elevator: { label: 'elevador', cost: 45, accessible: true },
  ramp: { label: 'esteira rolante', cost: 35, accessible: true },
  stairs: { label: 'escada', cost: 30, accessible: false },
};
const WALK_SPEED = 1.2; // m/s

export const norm = (s) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export const fmtDist = (m) => (m < 10 ? 'poucos metros' : `${Math.round(m / 5) * 5} m`);
export const fmtTime = (s) => (s < 50 ? 'menos de 1 min' : `${Math.max(1, Math.round(s / 60))} min`);

class Heap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(k, v) {
    const a = this.a; a.push([k, v]);
    for (let i = a.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

export class Mall {
  constructor(data) {
    this.data = data;
    this.ppm = data.meta?.pxPerMeter || 10;
    this.floors = [...data.floors].sort((a, b) => a.level - b.level);
    this.floorById = new Map(data.floors.map((f) => [f.id, f]));
    this.nodes = new Map(data.nodes.map((n) => [n.id, n]));
    this.pois = data.pois;
    this.poiById = new Map(data.pois.map((p) => [p.id, p]));
    this.adj = new Map(data.nodes.map((n) => [n.id, []]));
    for (const e of data.edges) {
      const a = this.nodes.get(e.a), b = this.nodes.get(e.b);
      if (!a || !b) continue;
      const t = e.t || 'walk';
      const w = t === 'walk' ? Math.hypot(a.x - b.x, a.y - b.y) : (TRANSITION[t]?.cost ?? 30) * this.ppm;
      this.adj.get(a.id).push({ to: b.id, t, w });
      this.adj.get(b.id).push({ to: a.id, t, w });
    }
    this.minTransition = Math.min(...Object.values(TRANSITION).map((t) => t.cost)) * this.ppm;
    // Lojas por nó de corredor ao qual a porta se liga (para pontos de referência)
    this.landmarks = new Map();
    for (const p of this.pois) {
      for (const e of this.adj.get(p.node) || []) {
        if (!this.landmarks.has(e.to)) this.landmarks.set(e.to, []);
        this.landmarks.get(e.to).push(p);
      }
    }
  }

  static async load(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Falha ao carregar ${url}`);
    return new Mall(await res.json());
  }

  level(fid) { return this.floorById.get(fid)?.level ?? 0; }

  search(q, group) {
    const nq = norm(q || '');
    let list = this.pois;
    if (group) list = list.filter((p) => p.group === group);
    if (!nq) return list;
    const scored = [];
    for (const p of list) {
      const n = norm(p.name), c = norm(p.cat || '');
      const s = n.startsWith(nq) ? 0 : n.includes(' ' + nq) ? 1 : n.includes(nq) ? 2 : c.includes(nq) ? 3 : -1;
      if (s >= 0) scored.push([s, p]);
    }
    return scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name, 'pt')).map((x) => x[1]);
  }

  /** A* entre dois nós. Devolve lista de ids ou null. */
  findPath(start, goal, { accessible = false } = {}) {
    const g = this.nodes.get(goal);
    if (!g || !this.nodes.has(start)) return null;
    const h = (id) => {
      const n = this.nodes.get(id);
      const dl = Math.abs(this.level(n.f) - this.level(g.f));
      return dl ? dl * this.minTransition : Math.hypot(n.x - g.x, n.y - g.y);
    };
    const dist = new Map([[start, 0]]), prev = new Map(), done = new Set(), open = new Heap();
    open.push(h(start), start);
    while (open.size) {
      const [, u] = open.pop();
      if (u === goal) break;
      if (done.has(u)) continue;
      done.add(u);
      for (const e of this.adj.get(u)) {
        if (accessible && e.t !== 'walk' && !TRANSITION[e.t]?.accessible) continue;
        // portas de outras lojas não servem de atalho
        const nt = this.nodes.get(e.to).t;
        if (nt === 'door' && e.to !== goal) continue;
        const d = dist.get(u) + e.w;
        if (d < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, d); prev.set(e.to, [u, e.t]); open.push(d + h(e.to), e.to);
        }
      }
    }
    if (!dist.has(goal)) return null;
    const path = [];
    for (let u = goal; u !== undefined; u = prev.get(u)?.[0]) path.push(u);
    return path.reverse();
  }

  /** Rota completa entre dois pontos de interesse, com trechos por piso e passos. */
  route(fromId, toId, opts = {}) {
    const from = this.poiById.get(fromId), to = this.poiById.get(toId);
    if (!from || !to) return null;
    const ids = this.findPath(from.node, to.node, opts);
    if (!ids) return null;
    const pts = ids.map((id) => this.nodes.get(id));

    // Trechos por piso
    const legs = [];
    for (let i = 0; i < pts.length; i++) {
      const last = legs[legs.length - 1];
      if (last && last.floor === pts[i].f) last.pts.push(pts[i]);
      else {
        let via = null;
        if (i > 0) via = this.adj.get(pts[i - 1].id).find((e) => e.to === pts[i].id)?.t;
        legs.push({ floor: pts[i].f, pts: [pts[i]], via });
      }
    }

    let meters = 0, seconds = 0;
    const steps = [];
    const floorName = (f) => this.floorById.get(f)?.id || f;
    legs.forEach((leg, li) => {
      if (leg.via) {
        // junta trocas consecutivas (ex.: elevador L1 → L3)
        const prevStep = steps[steps.length - 1];
        const fromLevel = this.level(legs[li - 1].floor), up = this.level(leg.floor) > fromLevel;
        const T = TRANSITION[leg.via] || TRANSITION.stairs;
        const text = leg.via === 'elevator'
          ? `Pegue o elevador e ${up ? 'suba' : 'desça'} até o piso ${floorName(leg.floor)}`
          : `${up ? 'Suba' : 'Desça'} pela ${T.label} até o piso ${floorName(leg.floor)}`;
        seconds += T.cost / WALK_SPEED;
        if (prevStep?.kind === 'transition' && prevStep.via === leg.via) {
          prevStep.text = text; prevStep.toFloor = leg.floor;
        } else {
          const a = legs[li - 1].pts.at(-1);
          steps.push({ kind: 'transition', via: leg.via, up, text, floor: legs[li - 1].floor, toFloor: leg.floor, pts: [a] });
        }
      }
      if (leg.pts.length < 2) return;
      const idx = collapseShort(leg.pts, simplify(leg.pts, 2 * this.ppm), 7 * this.ppm);
      for (let k = 0; k < idx.length - 1; k++) {
        const a = leg.pts[idx[k]], b = leg.pts[idx[k + 1]];
        const raw = leg.pts.slice(idx[k], idx[k + 1] + 1);
        let len = 0;
        for (let i = 1; i < raw.length; i++) len += Math.hypot(raw[i].x - raw[i - 1].x, raw[i].y - raw[i - 1].y);
        len /= this.ppm;
        meters += len;
        let turn = null;
        if (k > 0) turn = turnOf(leg.pts[idx[k - 1]], a, b);
        const first = steps.length === 0;
        if (turn === 'straight') {
          const s = steps[steps.length - 1];
          s.dist += len; s.pts.push(...raw.slice(1));
          continue;
        }
        let text;
        if (first) text = `Saia de ${from.name}`;
        else if (k === 0) text = 'Siga em frente';
        else {
          const lm = (this.landmarks.get(a.id) || []).find((p) => p.id !== from.id && p.id !== to.id && !/banheiro|pagamento|em breve/i.test(p.name));
          text = TURN_TEXT[turn] + (lm ? ` em frente a ${lm.name.replace(/\s*\([^)]*\)/g, '')}` : '');
        }
        steps.push({ kind: first ? 'start' : (turn || 'straight'), text, dist: len, floor: leg.floor, pts: raw });
      }
    });
    seconds += meters / WALK_SPEED;

    // Chegada: de que lado fica o destino
    let side = '';
    const n = pts.length;
    if (n >= 3 && pts[n - 3].f === to.f) {
      const t = turnOf(pts[n - 3], pts[n - 2], pts[n - 1]);
      if (t.includes('right')) side = ', à sua direita';
      else if (t.includes('left')) side = ', à sua esquerda';
    }
    steps.push({ kind: 'arrive', text: `Você chegou: ${to.name}${side}`, floor: to.f, pts: [pts[n - 1]] });

    return { from, to, legs, steps, meters, seconds, floors: legs.map((l) => l.floor) };
  }
}

const TURN_TEXT = {
  right: 'Vire à direita', left: 'Vire à esquerda',
  'slight-right': 'Mantenha-se à direita', 'slight-left': 'Mantenha-se à esquerda',
  uturn: 'Faça o retorno',
};

// Eixo Y cresce para baixo: produto vetorial positivo = curva à direita.
function turnOf(a, b, c) {
  const ux = b.x - a.x, uy = b.y - a.y, vx = c.x - b.x, vy = c.y - b.y;
  const ang = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy) * 180 / Math.PI;
  const abs = Math.abs(ang), dir = ang > 0 ? 'right' : 'left';
  if (abs < 28) return 'straight';
  if (abs < 55) return 'slight-' + dir;
  if (abs < 150) return dir;
  return 'uturn';
}

// Douglas-Peucker
function simplify(pts, tol) {
  if (pts.length < 3) return pts.map((_, i) => i);
  const keep = new Array(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let best = -1, bd = tol;
    const a = pts[i], b = pts[j], dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs((pts[k].x - a.x) * dy - (pts[k].y - a.y) * dx) / L;
      if (d > bd) { bd = d; best = k; }
    }
    if (best > 0) { keep[best] = true; stack.push([i, best], [best, j]); }
  }
  return keep.map((k, i) => (k ? i : -1)).filter((i) => i >= 0);
}

// Remove vértices que geram trechos curtos demais para virar instrução.
function collapseShort(pts, idx, min) {
  idx = idx.slice();
  for (let changed = true; changed && idx.length > 2;) {
    changed = false;
    for (let k = 0; k < idx.length - 1; k++) {
      const a = pts[idx[k]], b = pts[idx[k + 1]];
      if (Math.hypot(b.x - a.x, b.y - a.y) >= min) continue;
      idx.splice(k + 1 === idx.length - 1 ? k : k + 1, 1);
      if (k === 0 && idx.length === 2) break;
      changed = true;
      break;
    }
  }
  return idx;
}

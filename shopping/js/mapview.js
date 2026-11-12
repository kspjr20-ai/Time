// Visualizador com arrastar/zoom (mouse, roda e pinça) usado pelo app e pelo editor.
const SVG = 'http://www.w3.org/2000/svg';
export const svgEl = (tag, attrs = {}, parent) => {
  const el = document.createElementNS(SVG, tag);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(el);
  return el;
};

export class MapView {
  constructor(container) {
    this.el = container;
    this.content = document.createElement('div');
    this.content.className = 'mv-content';
    this.img = document.createElement('img');
    this.img.alt = '';
    this.img.draggable = false;
    this.svg = svgEl('svg');
    this.content.append(this.img, this.svg);
    this.el.appendChild(this.content);
    this.x = 0; this.y = 0; this.k = 1; this.w = 100; this.h = 100;
    this.minK = 0.05; this.maxK = 6;
    this.onChange = null; // (view)
    this.onTap = null;    // (ponto no mapa, evento)
    this.panEnabled = () => true;
    this._bind();
  }

  setFloor(src, w, h) {
    this.w = w; this.h = h;
    if (src) this.img.src = src; else this.img.removeAttribute('src');
    this.img.width = w; this.img.height = h;
    this.content.style.width = w + 'px';
    this.content.style.height = h + 'px';
    this.svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    this.svg.setAttribute('width', w); this.svg.setAttribute('height', h);
  }

  apply(animate = false) {
    this.content.classList.toggle('mv-anim', animate);
    this.content.style.transform = `translate(${this.x}px,${this.y}px) scale(${this.k})`;
    this.onChange?.(this);
  }

  /** Enquadra a caixa [x0,y0,x1,y1]; pad = margens {t,r,b,l} em px de tela. */
  fit(box, pad = {}, animate = true, maxK = 2.2) {
    const r = this.el.getBoundingClientRect();
    const p = { t: 20, r: 20, b: 20, l: 20, ...pad };
    const bw = Math.max(box[2] - box[0], 1), bh = Math.max(box[3] - box[1], 1);
    const aw = Math.max(r.width - p.l - p.r, 50), ah = Math.max(r.height - p.t - p.b, 50);
    this.k = Math.max(this.minK, Math.min(maxK, aw / bw, ah / bh));
    this.x = p.l + (aw - bw * this.k) / 2 - box[0] * this.k;
    this.y = p.t + (ah - bh * this.k) / 2 - box[1] * this.k;
    this.apply(animate);
  }

  toMap(cx, cy) {
    const r = this.el.getBoundingClientRect();
    return { x: (cx - r.left - this.x) / this.k, y: (cy - r.top - this.y) / this.k };
  }

  toScreen(mx, my) { return { x: mx * this.k + this.x, y: my * this.k + this.y }; }

  zoomAt(cx, cy, factor, animate = false) {
    const r = this.el.getBoundingClientRect();
    const px = cx - r.left, py = cy - r.top;
    const k = Math.max(this.minK, Math.min(this.maxK, this.k * factor));
    this.x = px - (px - this.x) * (k / this.k);
    this.y = py - (py - this.y) * (k / this.k);
    this.k = k;
    this.apply(animate);
  }

  zoomBy(f) {
    const r = this.el.getBoundingClientRect();
    this.zoomAt(r.left + r.width / 2, r.top + r.height / 2, f, true);
  }

  _bind() {
    const el = this.el, ptrs = new Map();
    let moved = 0, start = null, pinch = null, panning = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.button > 1) return;
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptrs.size === 1) {
        moved = 0; start = { x: e.clientX, y: e.clientY, target: e.target };
        panning = e.button === 1 || this.panEnabled(e);
      } else if (ptrs.size === 2) {
        const [a, b] = [...ptrs.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) }; moved = 99;
      }
    });
    el.addEventListener('pointermove', (e) => {
      const p = ptrs.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x, dy = e.clientY - p.y;
      p.x = e.clientX; p.y = e.clientY;
      if (ptrs.size === 1 && panning) {
        moved += Math.abs(dx) + Math.abs(dy);
        if (moved > 6) {
          if (!el.hasPointerCapture(e.pointerId)) el.setPointerCapture(e.pointerId);
          this.x += dx; this.y += dy; this.apply();
        }
      } else if (ptrs.size === 2 && pinch) {
        const [a, b] = [...ptrs.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        this.x += dx / 2; this.y += dy / 2;
        this.zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, d / pinch.d);
        pinch.d = d;
      }
    });
    const up = (e) => {
      if (!ptrs.has(e.pointerId)) return;
      ptrs.delete(e.pointerId);
      if (ptrs.size < 2) pinch = null;
      if (ptrs.size === 0 && e.type === 'pointerup' && moved <= 6 && start) {
        this.onTap?.(this.toMap(e.clientX, e.clientY), e, start.target);
      }
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      this.zoomAt(e.clientX, e.clientY, f);
    }, { passive: false });
  }
}

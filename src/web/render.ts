// Canvas 2D renderer for the factory floor. Draws in screen space from tile coordinates.

import type { Camera } from '../game/api.ts';
import { TILE_PX, type BeltView, type CatalogView, type MachineView, type Snapshot } from '../shared/protocol.ts';

export const STATUS_COLOR: Record<string, string> = {
  working: '#5ee08a',
  starved: '#f2c230',
  blocked: '#ff5d5d',
  idle: '#6b7785',
  ready: '#6cb7ff',
};

const DISPLAY_FONT = `'DIN Alternate', 'DIN Condensed', Bahnschrift, 'Barlow Condensed', 'Roboto Condensed', 'Arial Narrow', sans-serif`;
const MONO_FONT = `'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace`;
const BELT_SPEED = 2.5;

export interface Frame {
  cam: Camera;
  prev: Snapshot | null;
  curr: Snapshot;
  /** 0..1 between prev and curr. */
  alpha: number;
  catalog: CatalogView;
  /** Seconds, for animation. */
  now: number;
  /** Machine under the mouse pointer, highlighted. */
  hoverId?: string | null;
}

interface Poly {
  key: string;
  xs: number[];
  ys: number[];
  cum: number[];
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function shade(hex: string, amount: number): string {
  const [r, g, b] = hexToRgb(hex);
  const t = amount < 0 ? 0 : 255;
  const p = Math.abs(amount);
  return `rgb(${Math.round(r + (t - r) * p)},${Math.round(g + (t - g) * p)},${Math.round(b + (t - b) * p)})`;
}

function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

export class Renderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private w = 0;
  private h = 0;
  private polys = new Map<string, Poly>();
  private noise: CanvasPattern | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.noise = this.makeNoise();
  }

  private makeNoise(): CanvasPattern | null {
    const c = document.createElement('canvas');
    c.width = c.height = 160;
    const g = c.getContext('2d')!;
    const img = g.createImageData(160, 160);
    let seed = 1337;
    for (let i = 0; i < img.data.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const v = seed % 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 7;
    }
    g.putImageData(img, 0, 0);
    return this.ctx.createPattern(c, 'repeat');
  }

  private resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (w !== this.w || h !== this.h || dpr !== this.dpr) {
      this.w = w;
      this.h = h;
      this.dpr = dpr;
      this.canvas.width = Math.round(w * dpr);
      this.canvas.height = Math.round(h * dpr);
    }
  }

  draw(f: Frame): void {
    this.resize();
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const s = TILE_PX * f.cam.zoom;
    const ox = this.w / 2 - f.cam.x * s;
    const oy = this.h / 2 - f.cam.y * s;
    const X = (x: number) => ox + x * s;
    const Y = (y: number) => oy + y * s;
    const sizes = new Map(f.catalog.machines.map((m) => [m.id, m]));
    const machines = f.curr.machines;
    const byId = new Map(machines.map((m) => [m.id, m]));

    ctx.fillStyle = '#080b0e';
    ctx.fillRect(0, 0, this.w, this.h);
    this.drawFloor(f, s, X, Y);
    this.drawLineZones(f, s, X, Y, sizes);
    for (const b of f.curr.belts) this.drawBelt(b, byId, sizes, s, X, Y, f);
    this.drawItems(f, byId, sizes, s, X, Y);
    for (const m of machines) this.drawMachine(m, sizes.get(m.type)!, s, X, Y, f);
    this.drawRulers(f, s, X, Y);
    if (machines.length === 0) this.drawEmptyHint(f, s, X, Y);
  }

  private drawFloor(f: Frame, s: number, X: (x: number) => number, Y: (y: number) => number): void {
    const { ctx } = this;
    const W = f.curr.world.w;
    const H = f.curr.world.h;
    ctx.fillStyle = '#10151b';
    ctx.fillRect(X(0), Y(0), W * s, H * s);
    if (this.noise) {
      ctx.save();
      ctx.translate(X(0), Y(0));
      ctx.fillStyle = this.noise;
      ctx.fillRect(0, 0, W * s, H * s);
      ctx.restore();
    }
    // Visible tile range.
    const x0 = Math.max(0, Math.floor((0 - X(0)) / s));
    const x1 = Math.min(W, Math.ceil((this.w - X(0)) / s));
    const y0 = Math.max(0, Math.floor((0 - Y(0)) / s));
    const y1 = Math.min(H, Math.ceil((this.h - Y(0)) / s));
    if (s >= 9) {
      ctx.strokeStyle = `rgba(120,140,160,${Math.min(0.07, (s - 9) / 200 + 0.035)})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = x0; x <= x1; x++) {
        if (x % 10 === 0) continue;
        ctx.moveTo(Math.round(X(x)) + 0.5, Y(y0));
        ctx.lineTo(Math.round(X(x)) + 0.5, Y(y1));
      }
      for (let y = y0; y <= y1; y++) {
        if (y % 10 === 0) continue;
        ctx.moveTo(X(x0), Math.round(Y(y)) + 0.5);
        ctx.lineTo(X(x1), Math.round(Y(y)) + 0.5);
      }
      ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(140,160,185,0.13)';
    ctx.beginPath();
    for (let x = Math.ceil(x0 / 10) * 10; x <= x1; x += 10) {
      ctx.moveTo(Math.round(X(x)) + 0.5, Y(y0));
      ctx.lineTo(Math.round(X(x)) + 0.5, Y(y1));
    }
    for (let y = Math.ceil(y0 / 10) * 10; y <= y1; y += 10) {
      ctx.moveTo(X(x0), Math.round(Y(y)) + 0.5);
      ctx.lineTo(X(x1), Math.round(Y(y)) + 0.5);
    }
    ctx.stroke();
    // Painted safety border around the floor.
    ctx.save();
    ctx.strokeStyle = 'rgba(242,194,48,0.55)';
    ctx.lineWidth = Math.max(2, s * 0.14);
    ctx.setLineDash([s * 0.9, s * 0.5]);
    ctx.strokeRect(X(0) - ctx.lineWidth, Y(0) - ctx.lineWidth, W * s + ctx.lineWidth * 2, H * s + ctx.lineWidth * 2);
    ctx.restore();
  }

  private drawLineZones(
    f: Frame,
    s: number,
    X: (x: number) => number,
    Y: (y: number) => number,
    sizes: Map<string, CatalogView['machines'][number]>,
  ): void {
    const { ctx } = this;
    for (const line of f.curr.lines) {
      const ms = f.curr.machines.filter((m) => m.line === line.id);
      if (ms.length === 0) continue;
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const m of ms) {
        const d = sizes.get(m.type)!;
        x0 = Math.min(x0, m.x);
        y0 = Math.min(y0, m.y);
        x1 = Math.max(x1, m.x + d.w);
        y1 = Math.max(y1, m.y + d.h);
      }
      const pad = 1.5;
      const rx = X(x0 - pad);
      const ry = Y(y0 - pad);
      const rw = (x1 - x0 + pad * 2) * s;
      const rh = (y1 - y0 + pad * 2) * s;
      ctx.fillStyle = 'rgba(242,194,48,0.022)';
      ctx.fillRect(rx, ry, rw, rh);
      ctx.save();
      ctx.strokeStyle = 'rgba(242,194,48,0.22)';
      ctx.lineWidth = Math.max(1, s * 0.06);
      ctx.setLineDash([s * 0.5, s * 0.3]);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.restore();
      if (s >= 6) {
        const fs = Math.max(10, Math.min(26, s * 0.75));
        ctx.font = `700 ${fs}px ${DISPLAY_FONT}`;
        ctx.fillStyle = 'rgba(242,194,48,0.42)';
        ctx.textBaseline = 'bottom';
        ctx.textAlign = 'left';
        ctx.fillText(line.name.toUpperCase().split('').join('\u200A'), rx + 2, ry - 3);
      }
    }
  }

  private poly(b: BeltView, byId: Map<string, MachineView>, sizes: Map<string, CatalogView['machines'][number]>): Poly | null {
    if (b.path.length === 0) return null;
    const from = byId.get(b.from);
    const to = byId.get(b.to);
    if (!from || !to) return null;
    const key = `${b.path.join(',')}|${from.x},${from.y}|${to.x},${to.y}`;
    const cached = this.polys.get(b.id);
    if (cached && cached.key === key) return cached;
    const edge = (tx: number, ty: number, m: MachineView): [number, number] => {
      const d = sizes.get(m.type)!;
      if (ty === m.y - 1) return [tx + 0.5, m.y];
      if (ty === m.y + d.h) return [tx + 0.5, m.y + d.h];
      if (tx === m.x - 1) return [m.x, ty + 0.5];
      return [m.x + d.w, ty + 0.5];
    };
    const n = b.path.length / 2;
    const xs: number[] = [];
    const ys: number[] = [];
    const [sx, sy] = edge(b.path[0], b.path[1], from);
    xs.push(sx);
    ys.push(sy);
    for (let i = 0; i < n; i++) {
      xs.push(b.path[i * 2] + 0.5);
      ys.push(b.path[i * 2 + 1] + 0.5);
    }
    const [ex, ey] = edge(b.path[(n - 1) * 2], b.path[(n - 1) * 2 + 1], to);
    xs.push(ex);
    ys.push(ey);
    const cum = [0];
    for (let i = 1; i < xs.length; i++) cum.push(cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]));
    const p: Poly = { key, xs, ys, cum };
    this.polys.set(b.id, p);
    return p;
  }

  private at(p: Poly, d: number): [number, number] {
    const { xs, ys, cum } = p;
    if (d <= 0) return [xs[0], ys[0]];
    const total = cum[cum.length - 1];
    if (d >= total) return [xs[xs.length - 1], ys[ys.length - 1]];
    let lo = 0;
    let hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= d) lo = mid;
      else hi = mid;
    }
    const t = (d - cum[lo]) / (cum[hi] - cum[lo] || 1);
    return [xs[lo] + (xs[hi] - xs[lo]) * t, ys[lo] + (ys[hi] - ys[lo]) * t];
  }

  private drawBelt(
    b: BeltView,
    byId: Map<string, MachineView>,
    sizes: Map<string, CatalogView['machines'][number]>,
    s: number,
    X: (x: number) => number,
    Y: (y: number) => number,
    f: Frame,
  ): void {
    const { ctx } = this;
    const p = this.poly(b, byId, sizes);
    if (!p) {
      // Unroutable connection: a red dashed hint between the two machines.
      const a = byId.get(b.from);
      const c = byId.get(b.to);
      if (!a || !c) return;
      const da = sizes.get(a.type)!;
      const dc = sizes.get(c.type)!;
      ctx.save();
      ctx.strokeStyle = 'rgba(255,93,93,0.7)';
      ctx.setLineDash([6, 6]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(X(a.x + da.w / 2), Y(a.y + da.h / 2));
      ctx.lineTo(X(c.x + dc.w / 2), Y(c.y + dc.h / 2));
      ctx.stroke();
      ctx.restore();
      return;
    }
    const trace = () => {
      ctx.beginPath();
      ctx.moveTo(X(p.xs[0]), Y(p.ys[0]));
      for (let i = 1; i < p.xs.length; i++) ctx.lineTo(X(p.xs[i]), Y(p.ys[i]));
    };
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'butt';
    trace();
    ctx.strokeStyle = '#3a4350';
    ctx.lineWidth = s * 0.62;
    ctx.stroke();
    ctx.strokeStyle = '#1a2027';
    ctx.lineWidth = s * 0.5;
    ctx.stroke();
    if (s >= 7) {
      // Rollers that move with the belt.
      const speed = f.curr.speed === 0 ? 0 : BELT_SPEED * f.curr.speed;
      ctx.setLineDash([Math.max(1, s * 0.07), s * 0.25]);
      ctx.lineDashOffset = -((f.now * speed * s) % (s * 0.32));
      ctx.strokeStyle = '#2c343e';
      ctx.lineWidth = s * 0.46;
      ctx.stroke();
    }
    ctx.restore();
  }

  private drawItems(
    f: Frame,
    byId: Map<string, MachineView>,
    sizes: Map<string, CatalogView['machines'][number]>,
    s: number,
    X: (x: number) => number,
    Y: (y: number) => number,
  ): void {
    const { ctx } = this;
    const prevPos = new Map<number, number>();
    if (f.prev) for (const b of f.prev.belts) for (let i = 0; i < b.items.length; i += 3) prevPos.set(b.items[i], b.items[i + 1]);
    const r = Math.max(1.5, s * 0.2);
    ctx.lineWidth = Math.max(1, s * 0.05);
    for (const b of f.curr.belts) {
      const p = this.poly(b, byId, sizes);
      if (!p) continue;
      for (let i = 0; i < b.items.length; i += 3) {
        const id = b.items[i];
        const cur = b.items[i + 1];
        const old = prevPos.get(id);
        const pos = old !== undefined && old <= cur ? old + (cur - old) * f.alpha : cur;
        const [tx, ty] = this.at(p, pos);
        const x = X(tx);
        const y = Y(ty);
        if (x < -20 || y < -20 || x > this.w + 20 || y > this.h + 20) continue;
        const item = f.catalog.items[b.items[i + 2]];
        ctx.strokeStyle = 'rgba(0,0,0,0.7)';
        if (item.kind === 'product') {
          ctx.fillStyle = '#c9a46b';
          ctx.fillRect(x - r, y - r, r * 2, r * 2);
          ctx.strokeRect(x - r, y - r, r * 2, r * 2);
          ctx.fillStyle = item.color;
          ctx.fillRect(x - r, y - r * 0.3, r * 2, r * 0.6);
        } else {
          ctx.fillStyle = item.color;
          ctx.beginPath();
          ctx.arc(x, y, item.kind === 'part' ? r : r * 0.8, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }
  }

  private drawMachine(m: MachineView, d: CatalogView['machines'][number], s: number, X: (x: number) => number, Y: (y: number) => number, f: Frame): void {
    const { ctx } = this;
    const x = X(m.x) + s * 0.06;
    const y = Y(m.y) + s * 0.06;
    const w = d.w * s - s * 0.12;
    const h = d.h * s - s * 0.12;
    if (x > this.w || y > this.h || x + w < 0 || y + h < 0) return;
    const status = STATUS_COLOR[m.status] ?? '#888';
    const rad = Math.min(6, s * 0.18);

    ctx.fillStyle = 'rgba(0,0,0,0.38)';
    roundRect(ctx, x + s * 0.1, y + s * 0.16, w, h, rad);
    ctx.fill();

    ctx.fillStyle = shade(d.color, -0.45);
    roundRect(ctx, x, y, w, h, rad);
    ctx.fill();

    const band = Math.min(h * 0.42, s * 0.78);
    ctx.save();
    roundRect(ctx, x, y, w, h, rad);
    ctx.clip();
    ctx.fillStyle = shade(d.color, -0.1);
    ctx.fillRect(x, y, w, band);
    this.drawDetail(m, x, y + band, w, h - band, s, f);
    ctx.restore();

    // Status outline.
    ctx.lineWidth = Math.max(1, s * 0.07);
    ctx.strokeStyle = m.status === 'working' ? rgba(status, 0.75) : m.status === 'idle' || m.status === 'ready' ? 'rgba(255,255,255,0.12)' : rgba(status, 0.9);
    if (m.status === 'starved' || m.status === 'blocked') ctx.setLineDash([s * 0.3, s * 0.18]);
    roundRect(ctx, x, y, w, h, rad);
    ctx.stroke();
    ctx.setLineDash([]);
    if (f.hoverId === m.id) {
      ctx.lineWidth = Math.max(1.5, s * 0.09);
      ctx.strokeStyle = 'rgba(242,194,48,0.95)';
      roundRect(ctx, x - s * 0.08, y - s * 0.08, w + s * 0.16, h + s * 0.16, rad + s * 0.08);
      ctx.stroke();
    }

    // Status lamp.
    const lr = Math.max(2, s * 0.12);
    const lx = x + w - lr - s * 0.14;
    const ly = y + band / 2;
    ctx.save();
    if (m.status !== 'idle') {
      ctx.shadowColor = status;
      ctx.shadowBlur = m.status === 'working' ? s * 0.5 * (0.7 + 0.3 * Math.sin(f.now * 6)) : s * 0.3;
    }
    ctx.fillStyle = status;
    ctx.beginPath();
    ctx.arc(lx, ly, lr, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Progress bar.
    if (m.progress > 0 && d.role === 'process') {
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(x + s * 0.1, y + h - s * 0.2, w - s * 0.2, Math.max(2, s * 0.08));
      ctx.fillStyle = status;
      ctx.fillRect(x + s * 0.1, y + h - s * 0.2, (w - s * 0.2) * m.progress, Math.max(2, s * 0.08));
    }

    if (s < 8) return;
    // Labels.
    const n = m.id.slice(m.id.lastIndexOf('-') + 1);
    let label = m.name ? m.name.toUpperCase() : `${d.name.toUpperCase()} ${n}`;
    let fs = Math.max(8, Math.min(16, band * 0.58));
    ctx.font = `700 ${fs}px ${DISPLAY_FONT}`;
    const room = w - lr * 2 - s * 0.45;
    if (ctx.measureText(label).width > room && !m.name) label = `${d.short.toUpperCase()} ${n}`;
    if (ctx.measureText(label).width > room && m.name) label = ellipsize(ctx, label, room);
    while (ctx.measureText(label).width > room && fs > 7) {
      fs -= 1;
      ctx.font = `700 ${fs}px ${DISPLAY_FONT}`;
    }
    ctx.fillStyle = '#f3f5f7';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillText(label, x + s * 0.18, y + band / 2 + 1);

    if (s >= 16 && h - band > s * 0.7) {
      const recipe = m.recipe ? f.catalog.recipes.find((r) => r.id === m.recipe) : null;
      const sub = d.role === 'process' ? (recipe ? recipe.name : 'no recipe') : d.role === 'storage' ? 'stock' : d.role === 'shipping' ? 'sells boxed goods' : `+${d.power || 400} kW`;
      const small = Math.max(8, Math.min(11.5, s * 0.36));
      ctx.font = `${small}px ${MONO_FONT}`;
      ctx.fillStyle = 'rgba(230,236,242,0.78)';
      ctx.textBaseline = 'top';
      ctx.fillText(ellipsize(ctx, sub, w - s * 0.3), x + s * 0.18, y + band + s * 0.12);
      let issue = '';
      if (m.status === 'starved' && recipe) {
        const missing = Object.entries(recipe.inputs).find(([it, q]) => (m.input[it] ?? 0) < q);
        if (missing) issue = `needs ${f.catalog.items.find((i) => i.id === missing[0])?.name ?? missing[0]}`;
      } else if (m.status === 'blocked') issue = 'output full';
      else if (m.status === 'idle' && d.role === 'process') issue = 'set a recipe';
      if (issue && h - band > s * 1.3) {
        ctx.fillStyle = m.status === 'blocked' ? '#ff8a7a' : '#f2c230';
        ctx.fillText(ellipsize(ctx, issue, w - s * 0.3), x + s * 0.18, y + band + s * 0.12 + small * 1.35);
      }
    }
  }

  /** Small per-category illustration in the machine body; animated while working. */
  private drawDetail(m: MachineView, x: number, y: number, w: number, h: number, s: number, f: Frame): void {
    const { ctx } = this;
    const on = m.status === 'working';
    const t = f.now;
    const cx = x + w / 2;
    const cy = y + h * 0.62;
    ctx.save();
    ctx.globalAlpha = 0.9;
    switch (m.type) {
      case 'receiving_dock':
      case 'shipping_dock': {
        const sx = m.type === 'receiving_dock' ? x : x + w - s * 0.35;
        ctx.save();
        ctx.beginPath();
        ctx.rect(sx, y, s * 0.35, h);
        ctx.clip();
        for (let i = -2; i < h / (s * 0.3) + 2; i++) {
          ctx.fillStyle = i % 2 ? '#f2c230' : '#1a1610';
          ctx.beginPath();
          ctx.moveTo(sx, y + i * s * 0.3);
          ctx.lineTo(sx + s * 0.35, y + i * s * 0.3 - s * 0.35);
          ctx.lineTo(sx + s * 0.35, y + i * s * 0.3 - s * 0.05);
          ctx.lineTo(sx, y + i * s * 0.3 + s * 0.3);
          ctx.fill();
        }
        ctx.restore();
        ctx.fillStyle = 'rgba(255,255,255,0.07)';
        ctx.font = `700 ${Math.min(h * 0.7, s * 1.2)}px ${DISPLAY_FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(m.type === 'receiving_dock' ? 'IN' : 'OUT', cx, y + h * 0.58);
        break;
      }
      case 'warehouse': {
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.lineWidth = Math.max(1, s * 0.06);
        for (let i = 1; i < 4; i++) {
          ctx.beginPath();
          ctx.moveTo(x + s * 0.3, y + (h * i) / 4);
          ctx.lineTo(x + w - s * 0.3, y + (h * i) / 4);
          ctx.stroke();
        }
        break;
      }
      case 'kiln': {
        const r = Math.min(w, h) * 0.32;
        const g = ctx.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
        const heat = on ? 0.75 + 0.25 * Math.sin(t * 9 + m.x) : 0.15;
        g.addColorStop(0, `rgba(255,${Math.round(150 + 60 * heat)},80,${heat})`);
        g.addColorStop(1, 'rgba(120,30,10,0.15)');
        ctx.fillStyle = g;
        roundRect(ctx, cx - r, cy - r * 0.8, r * 2, r * 1.6, r * 0.25);
        ctx.fill();
        break;
      }
      case 'cnc_mill':
      case 'potters_wheel': {
        const r = Math.min(w, h) * 0.28;
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = Math.max(1, s * 0.07);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
        const a = on ? t * 12 : 0;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
        ctx.stroke();
        break;
      }
      case 'stamping_press': {
        const k = on ? (Math.sin(t * 5) + 1) / 2 : 0;
        ctx.fillStyle = 'rgba(255,255,255,0.22)';
        ctx.fillRect(x + w * 0.2, y + h * 0.15 + k * h * 0.3, w * 0.6, h * 0.14);
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(x + w * 0.15, y + h * 0.72, w * 0.7, h * 0.12);
        break;
      }
      case 'anodizing_tank':
      case 'glazing_station':
      case 'slip_caster': {
        ctx.fillStyle = m.type === 'anodizing_tank' ? 'rgba(90,170,255,0.25)' : m.type === 'glazing_station' ? 'rgba(94,196,214,0.25)' : 'rgba(187,161,132,0.3)';
        ctx.fillRect(x + w * 0.12, y + h * 0.25, w * 0.76, h * 0.55);
        if (on) {
          ctx.fillStyle = 'rgba(255,255,255,0.35)';
          for (let i = 0; i < 4; i++) {
            const bx = x + w * (0.2 + 0.18 * i);
            const by = y + h * 0.75 - ((t * 0.6 + i * 0.27) % 1) * h * 0.45;
            ctx.beginPath();
            ctx.arc(bx, by, Math.max(1, s * 0.05), 0, Math.PI * 2);
            ctx.fill();
          }
        }
        break;
      }
      case 'smt_line':
      case 'reflow_oven':
      case 'aoi':
      case 'pcb_test': {
        ctx.fillStyle = 'rgba(160,255,170,0.18)';
        const cols = Math.max(2, Math.floor(w / (s * 0.45)));
        for (let i = 0; i < cols; i++) {
          const lit = on && Math.floor(t * 6 + i) % cols === i % cols;
          ctx.fillStyle = lit ? 'rgba(200,255,200,0.6)' : 'rgba(160,255,170,0.16)';
          ctx.fillRect(x + s * 0.2 + i * ((w - s * 0.4) / cols), cy - s * 0.12, ((w - s * 0.4) / cols) * 0.6, s * 0.24);
        }
        if (m.type === 'reflow_oven' && on) {
          ctx.fillStyle = 'rgba(255,120,60,0.2)';
          ctx.fillRect(x, y, w, h);
        }
        break;
      }
      case 'substation': {
        ctx.fillStyle = 'rgba(255,230,120,0.55)';
        ctx.beginPath();
        ctx.moveTo(cx + s * 0.1, y + h * 0.1);
        ctx.lineTo(cx - s * 0.25, cy + s * 0.05);
        ctx.lineTo(cx, cy + s * 0.05);
        ctx.lineTo(cx - s * 0.1, y + h * 0.95);
        ctx.lineTo(cx + s * 0.28, cy - s * 0.1);
        ctx.lineTo(cx + s * 0.02, cy - s * 0.1);
        ctx.closePath();
        ctx.fill();
        break;
      }
      default: {
        ctx.strokeStyle = 'rgba(255,255,255,0.14)';
        ctx.lineWidth = Math.max(1, s * 0.05);
        ctx.strokeRect(x + w * 0.18, y + h * 0.22, w * 0.64, h * 0.56);
        if (on) {
          const k = (t * 0.8) % 1;
          ctx.fillStyle = 'rgba(255,255,255,0.18)';
          ctx.fillRect(x + w * 0.18 + w * 0.64 * k - s * 0.05, y + h * 0.22, s * 0.1, h * 0.56);
        }
      }
    }
    ctx.restore();
  }

  private drawRulers(f: Frame, s: number, X: (x: number) => number, Y: (y: number) => number): void {
    const { ctx } = this;
    const step = s >= 30 ? 5 : s >= 8 ? 10 : 20;
    ctx.font = `10px ${MONO_FONT}`;
    ctx.fillStyle = 'rgba(160,175,195,0.55)';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    const top = 70;
    for (let x = 0; x <= f.curr.world.w; x += step) {
      const sx = X(x);
      if (sx < 30 || sx > this.w - 330) continue;
      ctx.fillText(String(x), sx, top);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (let y = 0; y <= f.curr.world.h; y += step) {
      const sy = Y(y);
      if (sy < 86 || sy > this.h - 20) continue;
      ctx.fillText(String(y), 4, sy);
    }
  }

  private drawEmptyHint(f: Frame, s: number, X: (x: number) => number, Y: (y: number) => number): void {
    const { ctx } = this;
    const cx = X(f.cam.x);
    const cy = Y(f.cam.y) - 60;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `700 34px ${DISPLAY_FONT}`;
    ctx.fillStyle = 'rgba(242,194,48,0.55)';
    ctx.fillText('EMPTY FLOOR', cx, cy);
    ctx.font = `13px ${MONO_FONT}`;
    ctx.fillStyle = 'rgba(217,224,232,0.6)';
    ctx.fillText('Type “build a mug line” below to break ground.', cx, cy + 30);
    void s;
  }
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let t = text;
  while (t.length > 1 && ctx.measureText(t + '…').width > max) t = t.slice(0, -1);
  return t + '…';
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

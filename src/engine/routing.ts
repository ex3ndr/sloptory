// Conveyor auto-routing: A* over the tile grid from any free tile beside the source
// machine to any free tile beside the destination. Belts never cross machines; they may
// share tiles with other belts, but that costs extra so parallel runs spread out.

import type { Belt, GameState, Machine } from './state.ts';
import { machineIndex, occupancy, rectOf, type Rect } from './world.ts';

const DX = [0, 1, 0, -1];
const DY = [-1, 0, 1, 0];
const OVERLAP_COST = 3;
const TURN_COST = 0.3;

interface Side {
  x: number;
  y: number;
  dir: number;
}

/** Tiles orthogonally adjacent to a rect (no corners), with the outward direction. */
export function perimeter(r: Rect): Side[] {
  const out: Side[] = [];
  for (let x = r.x; x < r.x + r.w; x++) out.push({ x, y: r.y - 1, dir: 0 });
  for (let y = r.y; y < r.y + r.h; y++) out.push({ x: r.x + r.w, y, dir: 1 });
  for (let x = r.x; x < r.x + r.w; x++) out.push({ x, y: r.y + r.h, dir: 2 });
  for (let y = r.y; y < r.y + r.h; y++) out.push({ x: r.x - 1, y, dir: 3 });
  return out;
}

function rectDistance(x: number, y: number, r: Rect): number {
  const dx = Math.max(r.x - x, 0, x - (r.x + r.w - 1));
  const dy = Math.max(r.y - y, 0, y - (r.y + r.h - 1));
  return dx + dy;
}

export function isAdjacent(x: number, y: number, r: Rect): boolean {
  const insideX = x >= r.x && x < r.x + r.w;
  const insideY = y >= r.y && y < r.y + r.h;
  return (insideX && (y === r.y - 1 || y === r.y + r.h)) || (insideY && (x === r.x - 1 || x === r.x + r.w));
}

class Heap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size(): number {
    return this.keys.length;
  }
  push(key: number, val: number): void {
    const k = this.keys;
    const v = this.vals;
    k.push(key);
    v.push(val);
    let i = k.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop(): number {
    const k = this.keys;
    const v = this.vals;
    const top = v[0];
    const lastK = k.pop()!;
    const lastV = v.pop()!;
    if (k.length > 0) {
      k[0] = lastK;
      v[0] = lastV;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return top;
  }
}

function beltUsage(state: GameState, ignore?: string): Uint8Array {
  const use = new Uint8Array(state.width * state.height);
  for (const b of state.belts) {
    if (b.id === ignore) continue;
    for (let i = 0; i < b.path.length; i += 2) {
      const idx = b.path[i + 1] * state.width + b.path[i];
      if (use[idx] < 255) use[idx]++;
    }
  }
  return use;
}

/** Returns a flat [x0,y0,x1,y1,...] tile path from `from` to `to`, or null if unroutable. */
export function routeBelt(state: GameState, from: Machine, to: Machine, ignoreBelt?: string, grid?: Int32Array): number[] | null {
  const W = state.width;
  const H = state.height;
  const blocked = grid ?? occupancy(state);
  const usage = beltUsage(state, ignoreBelt);
  const src = rectOf(from);
  const dst = rectOf(to);

  const n = W * H * 4;
  const g = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new Heap();
  const free = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && blocked[y * W + x] === 0;
  const tileCost = (x: number, y: number) => 1 + usage[y * W + x] * OVERLAP_COST;

  for (const s of perimeter(src)) {
    if (!free(s.x, s.y)) continue;
    const st = (s.y * W + s.x) * 4 + s.dir;
    const cost = tileCost(s.x, s.y);
    if (cost < g[st]) {
      g[st] = cost;
      heap.push(cost + Math.max(0, rectDistance(s.x, s.y, dst) - 1), st);
    }
  }

  while (heap.size > 0) {
    const st = heap.pop();
    if (closed[st]) continue;
    closed[st] = 1;
    const tile = st >> 2;
    const dir = st & 3;
    const x = tile % W;
    const y = (tile - x) / W;
    if (isAdjacent(x, y, dst)) {
      const path: number[] = [];
      for (let cur = st; cur !== -1; cur = prev[cur]) {
        const t = cur >> 2;
        path.push(t % W, Math.floor(t / W));
      }
      // Built back-to-front; reverse pairs.
      const out: number[] = [];
      for (let i = path.length - 2; i >= 0; i -= 2) out.push(path[i], path[i + 1]);
      return out;
    }
    for (let d = 0; d < 4; d++) {
      if (d === ((dir + 2) & 3)) continue;
      const nx = x + DX[d];
      const ny = y + DY[d];
      if (!free(nx, ny)) continue;
      const ns = (ny * W + nx) * 4 + d;
      if (closed[ns]) continue;
      const cost = g[st] + tileCost(nx, ny) + (d === dir ? 0 : TURN_COST);
      if (cost < g[ns]) {
        g[ns] = cost;
        prev[ns] = st;
        heap.push(cost + Math.max(0, rectDistance(nx, ny, dst) - 1), ns);
      }
    }
  }
  return null;
}

export function beltLength(b: Belt): number {
  return b.path.length / 2;
}

/** True when the belt's path is still clear of machines and touches both endpoints. */
export function beltValid(state: GameState, b: Belt, grid: Int32Array, idx: Map<string, Machine>): boolean {
  if (b.path.length === 0) return false;
  const from = idx.get(b.from);
  const to = idx.get(b.to);
  if (!from || !to) return false;
  for (let i = 0; i < b.path.length; i += 2) {
    const x = b.path[i];
    const y = b.path[i + 1];
    if (x < 0 || y < 0 || x >= state.width || y >= state.height) return false;
    if (grid[y * state.width + x] !== 0) return false;
  }
  const last = b.path.length - 2;
  return isAdjacent(b.path[0], b.path[1], rectOf(from)) && isAdjacent(b.path[last], b.path[last + 1], rectOf(to));
}

/** Re-routes every belt invalidated by a layout change. Returns ids of belts left unroutable. */
export function rerouteInvalid(state: GameState): string[] {
  const grid = occupancy(state);
  const idx = machineIndex(state);
  const broken: string[] = [];
  for (const b of state.belts) {
    if (beltValid(state, b, grid, idx)) continue;
    const from = idx.get(b.from);
    const to = idx.get(b.to);
    const oldLen = beltLength(b);
    const path = from && to ? routeBelt(state, from, to, b.id, grid) : null;
    b.path = path ?? [];
    if (!path) {
      // Items on a belt that no longer exists go back to stock.
      for (const it of b.items) state.stock[it.item] = (state.stock[it.item] ?? 0) + 1;
      b.items = [];
      broken.push(b.id);
      continue;
    }
    const scale = oldLen > 0 ? beltLength(b) / oldLen : 0;
    for (const it of b.items) it.pos = Math.min(beltLength(b), it.pos * scale);
  }
  return broken;
}

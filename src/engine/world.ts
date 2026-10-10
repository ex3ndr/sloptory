// Queries over the world layout and derived limits.

import { MACHINES, RECIPES, type MachineDef, type RecipeDef } from './catalog.ts';
import { BASE_POWER_KW, BASE_STOCK_CAPACITY, total, type GameState, type Machine } from './state.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function defOf(m: Machine): MachineDef {
  return MACHINES[m.type];
}

export function recipeOf(m: Machine): RecipeDef | null {
  return m.recipe ? RECIPES[m.recipe] ?? null : null;
}

export function rectOf(m: Machine): Rect {
  const d = defOf(m);
  return { x: m.x, y: m.y, w: d.w, h: d.h };
}

export function findMachine(state: GameState, id: string): Machine | undefined {
  return state.machines.find((m) => m.id === id);
}

export function machineIndex(state: GameState): Map<string, Machine> {
  const map = new Map<string, Machine>();
  for (const m of state.machines) map.set(m.id, m);
  return map;
}

export function displayName(m: Machine): string {
  const n = m.id.slice(m.id.lastIndexOf('-') + 1);
  return `${defOf(m).name} ${n}`;
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function inBounds(state: GameState, r: Rect): boolean {
  return r.x >= 0 && r.y >= 0 && r.x + r.w <= state.width && r.y + r.h <= state.height;
}

/** Grid of machine occupancy: 0 = free, otherwise index + 1 into state.machines. */
export function occupancy(state: GameState, ignore?: string): Int32Array {
  const grid = new Int32Array(state.width * state.height);
  state.machines.forEach((m, i) => {
    if (m.id === ignore) return;
    const r = rectOf(m);
    for (let y = r.y; y < r.y + r.h; y++) {
      for (let x = r.x; x < r.x + r.w; x++) grid[y * state.width + x] = i + 1;
    }
  });
  return grid;
}

export function rectFree(state: GameState, r: Rect, grid: Int32Array): boolean {
  if (!inBounds(state, r)) return false;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) if (grid[y * state.width + x] !== 0) return false;
  }
  return true;
}

/** Finds the free spot for a w*h footprint (plus margin) closest to a hint point. */
export function findFreeSpot(
  state: GameState,
  w: number,
  h: number,
  hint: { x: number; y: number },
  margin = 1,
  ignore?: string,
): { x: number; y: number } | null {
  const grid = occupancy(state, ignore);
  let best: { x: number; y: number; d: number } | null = null;
  for (let y = margin; y + h + margin <= state.height; y++) {
    for (let x = margin; x + w + margin <= state.width; x++) {
      const d = Math.abs(x + w / 2 - hint.x) + Math.abs(y + h / 2 - hint.y) * 1.2;
      if (best && d >= best.d) continue;
      if (rectFree(state, { x: x - margin, y: y - margin, w: w + margin * 2, h: h + margin * 2 }, grid)) {
        best = { x, y, d };
      }
    }
  }
  return best ? { x: best.x, y: best.y } : null;
}

export function stockCapacity(state: GameState): number {
  let cap = BASE_STOCK_CAPACITY;
  for (const m of state.machines) {
    const d = defOf(m);
    if (d.role === 'storage') cap += d.capacity;
  }
  return cap;
}

export function stockFree(state: GameState): number {
  return Math.max(0, stockCapacity(state) - total(state.stock));
}

export function powerCapacity(state: GameState): number {
  let cap = BASE_POWER_KW;
  for (const m of state.machines) {
    const d = defOf(m);
    if (d.role === 'power') cap += d.capacity;
  }
  return cap;
}

export function hasReceivingDock(state: GameState): boolean {
  return state.machines.some((m) => defOf(m).receives);
}

/** Buffer limit for one item in a machine's input or output. */
export function bufferCap(qty: number): number {
  return Math.max(4, qty * 3);
}

export function nextMachineId(state: GameState, def: MachineDef): string {
  const used = new Set(state.machines.filter((m) => m.type === def.id).map((m) => m.id));
  for (let n = 1; ; n++) {
    const id = `${def.short}-${n}`;
    if (!used.has(id)) return id;
  }
}

export function contentBounds(state: GameState, machines: Machine[] = state.machines): Rect | null {
  if (machines.length === 0) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const m of machines) {
    const r = rectOf(m);
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

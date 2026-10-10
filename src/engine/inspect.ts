// Read-only analysis for players and agents: free space, region maps, structured state,
// catalog lookups and a diagnosis of layout problems.

import { ITEMS, MACHINES, MACHINE_LIST, RECIPES, RECIPE_LIST, isBuyable, type MachineDef } from './catalog.ts';
import { count, type Belt, type GameState, type Machine } from './state.ts';
import { defOf, machineIndex, powerCapacity, recipeOf, rectOf, stockCapacity, type Rect } from './world.ts';

// ---------- free space ----------

/** Summed-area table of blocked tiles (machines, and belts unless `ignoreBelts`). */
function blockedTable(state: GameState, ignoreBelts: boolean): Int32Array {
  const W = state.width;
  const H = state.height;
  const blocked = new Uint8Array(W * H);
  for (const m of state.machines) {
    const r = rectOf(m);
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) blocked[y * W + x] = 1;
  }
  if (!ignoreBelts) {
    for (const b of state.belts) for (let i = 0; i < b.path.length; i += 2) blocked[b.path[i + 1] * W + b.path[i]] = 1;
  }
  const sat = new Int32Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += blocked[y * W + x];
      sat[(y + 1) * (W + 1) + x + 1] = sat[y * (W + 1) + x + 1] + row;
    }
  }
  return sat;
}

function blockedIn(sat: Int32Array, W: number, x: number, y: number, w: number, h: number): number {
  const s = W + 1;
  return sat[(y + h) * s + x + w] - sat[y * s + x + w] - sat[(y + h) * s + x] + sat[y * s + x];
}

export interface FreeArea {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Finds up to `count` non-overlapping free w×h areas (top-left corners) closest to `near`,
 * keeping `margin` clear tiles around each (inside the floor) and avoiding existing belts.
 */
export function findFreeAreas(
  state: GameState,
  w: number,
  h: number,
  near: { x: number; y: number } = { x: 0, y: 0 },
  margin = 1,
  count = 3,
): FreeArea[] {
  w = Math.max(1, Math.floor(w));
  h = Math.max(1, Math.floor(h));
  margin = Math.max(0, Math.floor(margin));
  const W = state.width;
  const sat = blockedTable(state, false);
  const candidates: { x: number; y: number; d: number }[] = [];
  for (let y = margin; y + h + margin <= state.height; y++) {
    for (let x = margin; x + w + margin <= W; x++) {
      if (blockedIn(sat, W, x - margin, y - margin, w + margin * 2, h + margin * 2) !== 0) continue;
      candidates.push({ x, y, d: Math.abs(x + w / 2 - near.x) + Math.abs(y + h / 2 - near.y) });
    }
  }
  candidates.sort((a, b) => a.d - b.d || a.y - b.y || a.x - b.x);
  const out: FreeArea[] = [];
  for (const c of candidates) {
    if (out.length >= count) break;
    const overlaps = out.some((o) => c.x < o.x + o.w + margin && o.x < c.x + w + margin && c.y < o.y + o.h + margin && o.y < c.y + h + margin);
    if (!overlaps) out.push({ x: c.x, y: c.y, w, h });
  }
  return out;
}

// ---------- region map ----------

const LABELS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const MAP_MAX = { w: 100, h: 60 };

/** ASCII map of a floor region: '.' free, '=' conveyor, letters are machines (see legend). */
export function renderMap(state: GameState, x: number, y: number, w: number, h: number): { map: string; legend: Record<string, string> } {
  x = Math.max(0, Math.floor(x));
  y = Math.max(0, Math.floor(y));
  w = Math.max(1, Math.min(MAP_MAX.w, Math.floor(w), state.width - x));
  h = Math.max(1, Math.min(MAP_MAX.h, Math.floor(h), state.height - y));
  const grid: string[][] = Array.from({ length: h }, () => Array(w).fill('.'));
  for (const b of state.belts) {
    for (let i = 0; i < b.path.length; i += 2) {
      const gx = b.path[i] - x;
      const gy = b.path[i + 1] - y;
      if (gx >= 0 && gy >= 0 && gx < w && gy < h) grid[gy][gx] = '=';
    }
  }
  const legend: Record<string, string> = {};
  let n = 0;
  for (const m of state.machines) {
    const r = rectOf(m);
    if (r.x >= x + w || r.y >= y + h || r.x + r.w <= x || r.y + r.h <= y) continue;
    const label = LABELS[n++ % LABELS.length];
    legend[label] = `${m.id} (${m.type}) @${m.x},${m.y} ${r.w}x${r.h}`;
    for (let yy = Math.max(r.y, y); yy < Math.min(r.y + r.h, y + h); yy++) {
      for (let xx = Math.max(r.x, x); xx < Math.min(r.x + r.w, x + w); xx++) grid[yy - y][xx - x] = label;
    }
  }
  const pad = String(y + h - 1).length;
  let ruler = ' '.repeat(pad + 1);
  for (let i = 0; i < w; i++) ruler += (x + i) % 10 === 0 ? String(Math.floor((x + i) / 10) % 10) : ' ';
  const rows = grid.map((row, i) => `${String(y + i).padStart(pad)} ${row.join('')}`);
  return { map: [`x=${x}..${x + w - 1} (tens digit marks every 10th column), y=${y}..${y + h - 1}`, ruler, ...rows].join('\n'), legend };
}

// ---------- structured views ----------

function machineData(state: GameState, m: Machine, idx: Map<string, Belt[]>, out: Map<string, Belt[]>) {
  const d = defOf(m);
  return {
    id: m.id,
    ...(m.name ? { name: m.name } : {}),
    type: m.type,
    x: m.x,
    y: m.y,
    w: d.w,
    h: d.h,
    ...(d.role === 'process' ? { recipe: m.recipe, status: m.status, in: m.input, out: m.output, cycles: m.cycles } : { role: d.role }),
    from: (idx.get(m.id) ?? []).map((b) => (b.path.length ? b.from : `${b.from} (NO ROUTE)`)),
    to: (out.get(m.id) ?? []).map((b) => (b.path.length ? b.to : `${b.to} (NO ROUTE)`)),
    ...(m.line ? { line: state.lines.find((l) => l.id === m.line)?.name ?? m.line } : {}),
  };
}

/** Machines selected by a line name/id, a machine id, or everything. */
export function selectMachines(state: GameState, ids?: Set<string>, region?: Rect): Machine[] {
  return state.machines.filter((m) => {
    if (ids && !ids.has(m.id)) return false;
    if (region) {
      const r = rectOf(m);
      if (r.x >= region.x + region.w || r.y >= region.y + region.h || r.x + r.w <= region.x || r.y + r.h <= region.y) return false;
    }
    return true;
  });
}

export function fullLoadPower(state: GameState): number {
  return state.machines.reduce((sum, m) => sum + defOf(m).power, 0);
}

export function stateData(state: GameState, machines: Machine[] = state.machines) {
  const into = new Map<string, Belt[]>();
  const from = new Map<string, Belt[]>();
  for (const b of state.belts) {
    into.set(b.to, [...(into.get(b.to) ?? []), b]);
    from.set(b.from, [...(from.get(b.from) ?? []), b]);
  }
  return {
    time: Math.floor(state.time),
    cash: Math.round(state.cash),
    speed: state.speed,
    autobuy: state.autobuy,
    floor: { w: state.width, h: state.height },
    power: { capacity: powerCapacity(state), demand: Math.round(state.power.demand), full_load: fullLoadPower(state) },
    stock: state.stock,
    stock_capacity: stockCapacity(state),
    orders: state.orders.map((o) => ({ id: o.id, item: o.item, qty: o.qty, filled: o.filled, price: o.price, seconds_left: Math.max(0, Math.round(o.expiresAt - state.time)) })),
    lines: state.lines.map((l) => ({ name: l.name, machines: state.machines.filter((m) => m.line === l.id).map((m) => m.id) })),
    shipped: state.stats.shipped,
    machines: machines.map((m) => machineData(state, m, into, from)),
  };
}

function recipeData(id: string) {
  const r = RECIPES[id];
  return { id: r.id, machine: r.machine, in: r.inputs, out: r.outputs, time: r.time };
}

function machineTypeData(d: MachineDef) {
  return {
    type: d.id,
    name: d.name,
    role: d.role,
    w: d.w,
    h: d.h,
    cost: d.cost,
    power: d.power,
    ...(d.capacity ? { capacity: d.capacity } : {}),
    recipes: d.recipes.map(recipeData),
  };
}

/** Machine types with recipes, and items with prices. Filter by machine type/category/role or item kind. */
export function catalogData(filter?: string) {
  const f = filter?.toLowerCase().trim() || undefined;
  const items = Object.values(ITEMS).map((i) => ({ id: i.id, kind: i.kind, price: i.price }));
  if (f && items.some((i) => i.kind === f)) return { items: items.filter((i) => i.kind === f) };
  const machines = MACHINE_LIST.filter((d) => d.id === f || d.category === f || d.role === f);
  if (f && machines.length > 0) return { machines: machines.map(machineTypeData) };
  return { machines: MACHINE_LIST.map(machineTypeData), items };
}

/** What makes and uses an item; with `upstream`, every recipe needed to make it from bought goods. */
export function itemData(itemId: string, upstream = false) {
  const it = ITEMS[itemId];
  const madeBy = RECIPE_LIST.filter((r) => itemId in r.outputs).map((r) => recipeData(r.id));
  const usedBy = RECIPE_LIST.filter((r) => itemId in r.inputs).map((r) => recipeData(r.id));
  const data: Record<string, unknown> = { item: it.id, name: it.name, kind: it.kind, price: it.price, buyable: isBuyable(it.id), made_by: madeBy, used_by: usedBy };
  if (upstream) {
    const chain: ReturnType<typeof recipeData>[] = [];
    const bought = new Set<string>();
    const seen = new Set<string>();
    const visit = (item: string) => {
      if (seen.has(item)) return;
      seen.add(item);
      if (isBuyable(item)) {
        bought.add(item);
        return;
      }
      const r = RECIPE_LIST.find((x) => item in x.outputs);
      if (!r) return;
      for (const inp of Object.keys(r.inputs)) visit(inp);
      chain.push(recipeData(r.id));
    };
    visit(itemId);
    data.chain = chain;
    data.buy = [...bought];
  }
  return data;
}

// ---------- diagnosis ----------

export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  severity: Severity;
  code: string;
  machine?: string;
  text: string;
}

function canSupply(state: GameState, src: Machine, item: string): boolean {
  const role = defOf(src).role;
  if (role === 'storage') return isBuyable(item) || count(state.stock, item) > 0;
  if (role === 'process') return !!recipeOf(src)?.outputs[item];
  return false;
}

function canAccept(dest: Machine, item: string): boolean {
  const role = defOf(dest).role;
  if (role === 'storage') return true;
  if (role === 'shipping') return ITEMS[item]?.kind === 'product';
  if (role === 'process') return !!recipeOf(dest)?.inputs[item];
  return false;
}

function makers(item: string): string {
  const rs = RECIPE_LIST.filter((r) => item in r.outputs);
  if (rs.length === 0) return isBuyable(item) ? 'bought: connect a receiving dock' : 'nothing';
  return rs.map((r) => `${r.machine} (${r.id})`).join(' or ');
}

/** Finds layout and supply problems. `scope` limits machine-level checks to those ids. */
export function diagnose(state: GameState, scope?: Set<string>): Issue[] {
  const issues: Issue[] = [];
  const idx = machineIndex(state);
  const inScope = (id: string) => !scope || scope.has(id);
  const add = (severity: Severity, code: string, text: string, machine?: string) => issues.push({ severity, code, text, ...(machine ? { machine } : {}) });
  const boughtNeeded = new Set<string>();

  for (const b of state.belts) {
    if (!inScope(b.from) && !inScope(b.to)) continue;
    const from = idx.get(b.from);
    const to = idx.get(b.to);
    if (!from || !to) continue;
    if (b.path.length === 0) {
      add('error', 'route_unreachable', `Conveyor ${b.from} → ${b.to} has no free route (machines are boxed in). Move one of them or clear space between them.`, b.to);
      continue;
    }
    const fr = recipeOf(from);
    const fromRole = defOf(from).role;
    if (fromRole === 'process' && fr && !Object.keys(fr.outputs).some((it) => canAccept(to, it))) {
      add('warning', 'useless_conveyor', `Conveyor ${b.from} → ${b.to} carries nothing: ${b.from} makes ${Object.keys(fr.outputs).join(', ')}, which ${b.to} does not use.`, b.to);
    }
    if (fromRole === 'storage' && defOf(to).role === 'storage') {
      add('warning', 'useless_conveyor', `Conveyor ${b.from} → ${b.to} links two stores; stock is already shared.`, b.to);
    }
  }

  for (const m of state.machines) {
    if (!inScope(m.id)) continue;
    const d = defOf(m);
    if (d.role !== 'process') continue;
    const r = recipeOf(m);
    if (!r) {
      add('error', 'no_recipe', `${m.id} has no recipe. Options: ${d.recipes.join(', ')}.`, m.id);
      continue;
    }
    const incoming = state.belts.filter((b) => b.to === m.id && b.path.length > 0);
    const outgoing = state.belts.filter((b) => b.from === m.id && b.path.length > 0);
    for (const item of Object.keys(r.inputs)) {
      const ok = incoming.some((b) => {
        const src = idx.get(b.from);
        return !!src && canSupply(state, src, item);
      });
      if (!ok) add('error', 'input_unconnected', `${m.id} (${r.id}) needs ${item} but nothing connected to it supplies it. Made by: ${makers(item)}.`, m.id);
      else if (isBuyable(item)) boughtNeeded.add(item);
    }
    for (const item of Object.keys(r.outputs)) {
      const ok = outgoing.some((b) => {
        const dest = idx.get(b.to);
        return !!dest && canAccept(dest, item);
      });
      if (!ok) {
        const users = RECIPE_LIST.filter((x) => item in x.inputs).map((x) => `${x.machine} (${x.id})`);
        const where = ITEMS[item].kind === 'product' ? 'a shipping_dock' : users.join(' or ') || 'a warehouse';
        add('error', 'output_unconnected', `${m.id} makes ${item} but no conveyor takes it away, so it will block. Connect it to ${where}.`, m.id);
      }
    }
    if (m.status === 'blocked') add('info', 'blocked', `${m.id} is blocked: its output buffer is full (downstream is slower or not taking ${Object.keys(r.outputs).join(', ')}).`, m.id);
    if (m.status === 'starved' && m.cycles > 0) {
      const missing = Object.entries(r.inputs)
        .filter(([it, q]) => count(m.input, it) < q)
        .map(([it]) => it);
      add('info', 'starved', `${m.id} is waiting for ${missing.join(', ')} (upstream is slower, or stock ran out).`, m.id);
    }
  }

  if (boughtNeeded.size > 0 && !state.machines.some((m) => defOf(m).receives)) {
    add('error', 'no_receiving_dock', 'No receiving dock: purchased materials cannot be delivered.');
  }
  const empty = [...boughtNeeded].filter((it) => count(state.stock, it) === 0);
  if (empty.length > 0 && !state.autobuy) {
    add('warning', 'out_of_stock', `Out of stock: ${empty.join(', ')}. Buy them or turn on autobuy, or the line will starve.`);
  }

  const capacity = powerCapacity(state);
  if (state.power.satisfaction < 1) {
    add('error', 'power_shortfall', `Brownout: demand ${Math.round(state.power.demand)} kW exceeds ${capacity} kW, every machine runs at ${Math.round(state.power.satisfaction * 100)}%. Place substation(s) (+${MACHINES.substation.capacity} kW each).`);
  } else {
    const full = state.machines.reduce((sum, m) => sum + defOf(m).power, 0);
    if (full > capacity) {
      const need = Math.ceil((full - capacity) / MACHINES.substation.capacity);
      add('warning', 'power_at_full_load', `At full load the factory draws ${full} kW but only ${capacity} kW is available. Place ${need} substation(s).`);
    }
  }
  return issues;
}

export function summarizeIssues(issues: Issue[]): string {
  if (issues.length === 0) return 'No problems found: every input is supplied, every output has somewhere to go, power is sufficient.';
  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of issues) counts[i.severity]++;
  const head = `${counts.error} error(s), ${counts.warning} warning(s), ${counts.info} note(s):`;
  return [head, ...issues.map((i) => `- [${i.severity}] ${i.text}`)].join('\n');
}


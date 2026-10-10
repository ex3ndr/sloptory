// The fixed-step simulation: power, machine cycles, belt transport, economy.

import { ITEMS, type RecipeDef } from './catalog.ts';
import { autobuy, shipProduct, updateOrders, type SimEvent } from './economy.ts';
import { beltLength } from './routing.ts';
import {
  BELT_SPACING,
  BELT_SPEED,
  STANDBY_POWER,
  TICK_SECONDS,
  add,
  count,
  type Belt,
  type GameState,
  type Machine,
} from './state.ts';
import { bufferCap, defOf, machineIndex, powerCapacity, recipeOf, stockFree } from './world.ts';

type Inflight = Map<string, Record<string, number>>;

function updatePower(state: GameState): number {
  const capacity = powerCapacity(state);
  let demand = 0;
  for (const m of state.machines) {
    const d = defOf(m);
    if (d.role === 'process') demand += m.running ? d.power : d.power * STANDBY_POWER;
    else demand += d.power;
  }
  const satisfaction = demand <= capacity ? 1 : capacity / demand;
  state.power = { capacity, demand: Math.round(demand * 10) / 10, satisfaction };
  return satisfaction;
}

function updateMachine(state: GameState, m: Machine, dt: number): void {
  const role = defOf(m).role;
  if (role !== 'process') {
    m.status = 'ready';
    return;
  }
  const r = recipeOf(m);
  if (!r) {
    m.status = 'idle';
    m.running = false;
    m.progress = 0;
    return;
  }
  if (!m.running) tryStart(m, r);
  if (!m.running) return;
  m.progress += dt;
  if (m.progress + 1e-9 >= r.time) {
    for (const [it, q] of Object.entries(r.outputs)) {
      add(m.output, it, q);
      add(state.stats.produced, it, q);
    }
    m.running = false;
    m.progress = 0;
    m.cycles++;
    // The next cycle begins the moment this one ends.
    tryStart(m, r);
  }
}

function tryStart(m: Machine, r: RecipeDef): void {
  for (const [it, q] of Object.entries(r.outputs)) {
    if (count(m.output, it) + q > bufferCap(q)) {
      m.status = 'blocked';
      return;
    }
  }
  for (const [it, q] of Object.entries(r.inputs)) {
    if (count(m.input, it) < q) {
      m.status = 'starved';
      return;
    }
  }
  for (const [it, q] of Object.entries(r.inputs)) add(m.input, it, -q);
  m.running = true;
  m.status = 'working';
}

function inflightTo(inflight: Inflight, dest: string): Record<string, number> {
  let bag = inflight.get(dest);
  if (!bag) inflight.set(dest, (bag = {}));
  return bag;
}

/** Whether `dest` wants one more `item` loaded onto a belt toward it. */
function wants(state: GameState, src: Machine, dest: Machine, item: string, inflight: Inflight, inflightStock: number): boolean {
  const d = defOf(dest);
  if (d.role === 'process') {
    const r = recipeOf(dest);
    const need = r?.inputs[item];
    if (!need) return false;
    return count(dest.input, item) + count(inflightTo(inflight, dest.id), item) < bufferCap(need);
  }
  if (d.role === 'storage') return defOf(src).role !== 'storage' && stockFree(state) - inflightStock > 0;
  if (d.role === 'shipping') return ITEMS[item]?.kind === 'product';
  return false;
}

/** Hands an arriving item to its destination. Returns false if it must wait on the belt. */
function deliver(state: GameState, dest: Machine, item: string, events: SimEvent[]): boolean {
  const d = defOf(dest);
  if (d.role === 'process' && recipeOf(dest)?.inputs[item]) {
    add(dest.input, item, 1);
    return true;
  }
  if (d.role === 'shipping' && ITEMS[item]?.kind === 'product') {
    shipProduct(state, item, events);
    return true;
  }
  // Storage, or a stray item the destination no longer uses: forklift it to stock.
  if (stockFree(state) > 0) {
    add(state.stock, item, 1);
    return true;
  }
  return false;
}

function pickItem(state: GameState, src: Machine, dest: Machine, inflight: Inflight, inflightStock: number): string | null {
  const srcRole = defOf(src).role;
  const pool = srcRole === 'process' ? src.output : srcRole === 'storage' ? state.stock : null;
  if (!pool) return null;
  const destRecipe = defOf(dest).role === 'process' ? recipeOf(dest) : null;
  if (destRecipe) {
    // Feed whichever input the destination is shortest on.
    let best: string | null = null;
    let bestFill = Infinity;
    for (const [it, need] of Object.entries(destRecipe.inputs)) {
      if (count(pool, it) <= 0 || !wants(state, src, dest, it, inflight, inflightStock)) continue;
      const fill = (count(dest.input, it) + count(inflightTo(inflight, dest.id), it)) / bufferCap(need);
      if (fill < bestFill) {
        bestFill = fill;
        best = it;
      }
    }
    return best;
  }
  for (const it of Object.keys(pool)) {
    if (pool[it] > 0 && wants(state, src, dest, it, inflight, inflightStock)) return it;
  }
  return null;
}

function moveBelt(state: GameState, b: Belt, dest: Machine | undefined, events: SimEvent[]): void {
  const len = beltLength(b);
  const step = BELT_SPEED * TICK_SECONDS;
  let limit = len;
  const kept: typeof b.items = [];
  for (const it of b.items) {
    it.pos = Math.min(it.pos + step, limit);
    if (kept.length === 0 && it.pos >= len - 1e-9 && dest && deliver(state, dest, it.item, events)) continue;
    kept.push(it);
    limit = it.pos - BELT_SPACING;
  }
  b.items = kept;
}

function updateBelts(state: GameState, events: SimEvent[]): void {
  const idx = machineIndex(state);
  for (const b of state.belts) if (b.path.length > 0) moveBelt(state, b, idx.get(b.to), events);

  const inflight: Inflight = new Map();
  let inflightStock = 0;
  for (const b of state.belts) {
    const bag = inflightTo(inflight, b.to);
    const toStorage = defOf(idx.get(b.to)!).role === 'storage';
    for (const it of b.items) {
      add(bag, it.item, 1);
      if (toStorage) inflightStock++;
    }
  }

  const n = state.belts.length;
  if (n === 0) return;
  const start = state.tick % n;
  for (let k = 0; k < n; k++) {
    const b = state.belts[(start + k) % n];
    if (b.path.length === 0) continue;
    const last = b.items[b.items.length - 1];
    if (last && last.pos < BELT_SPACING) continue;
    const src = idx.get(b.from);
    const dest = idx.get(b.to);
    if (!src || !dest) continue;
    const it = pickItem(state, src, dest, inflight, inflightStock);
    if (!it) continue;
    if (defOf(src).role === 'process') add(src.output, it, -1);
    else add(state.stock, it, -1);
    state.counters.item++;
    b.items.push({ id: state.counters.item, item: it, pos: 0 });
    add(inflightTo(inflight, dest.id), it, 1);
    if (defOf(dest).role === 'storage') inflightStock++;
  }
}

/** Advances the world by one fixed tick (TICK_SECONDS). Returns notable events. */
export function step(state: GameState): SimEvent[] {
  const events: SimEvent[] = [];
  const satisfaction = updatePower(state);
  for (const m of state.machines) updateMachine(state, m, TICK_SECONDS * satisfaction);
  updateBelts(state, events);
  state.tick++;
  state.time = Math.round(state.tick * TICK_SECONDS * 10) / 10;
  if (state.tick % 10 === 0) autobuy(state, events);
  updateOrders(state, events);
  if (state.tick % 100 === 0) {
    const shipped = Object.values(state.stats.shipped).reduce((a, b) => a + b, 0);
    state.history.push({ t: state.time, cash: Math.round(state.cash), revenue: Math.round(state.stats.revenue), shipped });
    if (state.history.length > 120) state.history.splice(0, state.history.length - 120);
  }
  return events;
}

export function run(state: GameState, ticks: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let i = 0; i < ticks; i++) events.push(...step(state));
  return events;
}

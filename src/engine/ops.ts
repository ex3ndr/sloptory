// Layout operations: place, remove, move, connect, recipes. Each returns a result the
// command layer can show to the player verbatim.

import { ITEMS, MACHINES, RECIPES } from './catalog.ts';
import { money } from './economy.ts';
import { beltLength, rerouteInvalid, routeBelt } from './routing.ts';
import { add, type Belt, type GameState, type Machine } from './state.ts';
import {
  defOf,
  displayName,
  findMachine,
  inBounds,
  nextMachineId,
  occupancy,
  recipeOf,
  rectFree,
  rectOf,
} from './world.ts';

export interface OpResult {
  ok: boolean;
  message: string;
  machine?: Machine;
  belt?: Belt;
}

const fail = (message: string): OpResult => ({ ok: false, message });

export function placeMachine(
  state: GameState,
  type: string,
  x: number,
  y: number,
  opts: { recipe?: string | null; line?: string | null; name?: string | null; free?: boolean } = {},
): OpResult {
  const def = MACHINES[type];
  if (!def) return fail(`Unknown machine type "${type}".`);
  x = Math.floor(x);
  y = Math.floor(y);
  const rect = { x, y, w: def.w, h: def.h };
  if (!inBounds(state, rect)) {
    return fail(`${def.name} (${def.w}×${def.h}) does not fit at ${x},${y}; the floor is ${state.width}×${state.height}.`);
  }
  if (!rectFree(state, rect, occupancy(state))) {
    const blocker = state.machines.find((m) => {
      const r = rectOf(m);
      return r.x < x + def.w && x < r.x + r.w && r.y < y + def.h && y < r.y + r.h;
    });
    return fail(`Can't place ${def.name} at ${x},${y}: ${blocker ? displayName(blocker) + ' is in the way' : 'space is taken'}.`);
  }
  if (!opts.free && state.cash < def.cost) return fail(`${def.name} costs ${money(def.cost)}; you have ${money(state.cash)}.`);
  let recipe = opts.recipe ?? null;
  if (recipe && !def.recipes.includes(recipe)) return fail(`${def.name} can't run recipe "${recipe}".`);
  if (!recipe && def.recipes.length === 1) recipe = def.recipes[0];
  const m: Machine = {
    id: nextMachineId(state, def),
    type,
    name: opts.name ?? null,
    x,
    y,
    recipe,
    input: {},
    output: {},
    progress: 0,
    running: false,
    status: def.role === 'process' ? (recipe ? 'starved' : 'idle') : 'ready',
    cycles: 0,
    line: opts.line ?? null,
  };
  if (!opts.free) {
    state.cash -= def.cost;
    state.stats.spent += def.cost;
  }
  state.machines.push(m);
  const broken = rerouteInvalid(state);
  let note = '';
  if (broken.length) note = ` Warning: it cut off ${broken.length} conveyor(s) that could not be re-routed.`;
  const r = recipe ? ` running ${RECIPES[recipe].name}` : def.recipes.length > 1 ? ' (no recipe yet)' : '';
  return { ok: true, machine: m, message: `Placed ${displayName(m)} [${m.id}] at ${x},${y}${r} for ${money(def.cost)}.${note}` };
}

function returnToStock(state: GameState, items: Record<string, number>): void {
  for (const [it, q] of Object.entries(items)) add(state.stock, it, q);
}

export function removeMachine(state: GameState, id: string): OpResult {
  const m = findMachine(state, id);
  if (!m) return fail(`No machine "${id}".`);
  const def = defOf(m);
  const refund = Math.round(def.cost * 0.5);
  returnToStock(state, m.input);
  returnToStock(state, m.output);
  const belts = state.belts.filter((b) => b.from === id || b.to === id);
  for (const b of belts) for (const it of b.items) add(state.stock, it.item, 1);
  state.belts = state.belts.filter((b) => b.from !== id && b.to !== id);
  state.machines = state.machines.filter((x) => x !== m);
  if (m.line && !state.machines.some((x) => x.line === m.line)) state.lines = state.lines.filter((l) => l.id !== m.line);
  state.cash += refund;
  rerouteInvalid(state);
  const extra = belts.length ? ` and ${belts.length} conveyor(s)` : '';
  return { ok: true, message: `Removed ${displayName(m)}${extra}; salvage refund ${money(refund)}.` };
}

export function moveMachine(state: GameState, id: string, x: number, y: number): OpResult {
  const m = findMachine(state, id);
  if (!m) return fail(`No machine "${id}".`);
  const def = defOf(m);
  x = Math.floor(x);
  y = Math.floor(y);
  const rect = { x, y, w: def.w, h: def.h };
  if (!inBounds(state, rect)) return fail(`${displayName(m)} does not fit at ${x},${y}.`);
  if (!rectFree(state, rect, occupancy(state, m.id))) return fail(`Can't move ${displayName(m)} to ${x},${y}: space is taken.`);
  m.x = x;
  m.y = y;
  const broken = rerouteInvalid(state);
  const note = broken.length ? ` ${broken.length} conveyor(s) could not be re-routed.` : '';
  return { ok: true, machine: m, message: `Moved ${displayName(m)} to ${x},${y}.${note}` };
}

/** Picks a recipe for `m` that produces something `consumer` uses (or vice versa). */
function inferRecipe(m: Machine, other: Machine, mIsSource: boolean): string | null {
  const otherRecipe = recipeOf(other);
  for (const rid of defOf(m).recipes) {
    const r = RECIPES[rid];
    if (mIsSource && otherRecipe && Object.keys(r.outputs).some((it) => it in otherRecipe.inputs)) return rid;
    if (!mIsSource && otherRecipe && Object.keys(r.inputs).some((it) => it in otherRecipe.outputs)) return rid;
  }
  return null;
}

export function connect(state: GameState, fromId: string, toId: string): OpResult {
  const from = findMachine(state, fromId);
  const to = findMachine(state, toId);
  if (!from) return fail(`No machine "${fromId}".`);
  if (!to) return fail(`No machine "${toId}".`);
  if (from === to) return fail("A machine can't feed itself.");
  if (defOf(from).role === 'power' || defOf(to).role === 'power') return fail('Substations supply power to the whole factory; they need no conveyors.');
  if (defOf(from).role === 'shipping') return fail('The shipping dock is an end point; connect things to it, not from it.');
  if (state.belts.some((b) => b.from === from.id && b.to === to.id)) {
    return fail(`${displayName(from)} already feeds ${displayName(to)}.`);
  }
  const notes: string[] = [];
  if (defOf(from).role === 'process' && !from.recipe) {
    const r = inferRecipe(from, to, true);
    if (r) {
      from.recipe = r;
      notes.push(`set ${from.id} to ${RECIPES[r].name}`);
    }
  }
  if (defOf(to).role === 'process' && !to.recipe) {
    const r = inferRecipe(to, from, false);
    if (r) {
      to.recipe = r;
      notes.push(`set ${to.id} to ${RECIPES[r].name}`);
    }
  }
  const path = routeBelt(state, from, to);
  if (!path) return fail(`No free route for a conveyor from ${displayName(from)} to ${displayName(to)}. Try moving one of them.`);
  state.counters.belt++;
  const belt: Belt = { id: `belt-${state.counters.belt}`, from: from.id, to: to.id, path, items: [] };
  state.belts.push(belt);
  const fr = recipeOf(from);
  const tr = recipeOf(to);
  let warn = '';
  if (fr && tr && !Object.keys(fr.outputs).some((it) => it in tr.inputs)) {
    warn = ` Note: ${displayName(from)} makes ${Object.keys(fr.outputs).map((i) => ITEMS[i].name).join(', ')}, which ${displayName(to)} does not use.`;
  }
  const n = notes.length ? ` (${notes.join('; ')})` : '';
  return { ok: true, belt, message: `Conveyor ${displayName(from)} → ${displayName(to)}, ${beltLength(belt)} tiles${n}.${warn}` };
}

export function disconnect(state: GameState, fromId: string, toId?: string): OpResult {
  const doomed = state.belts.filter((b) =>
    toId ? (b.from === fromId && b.to === toId) || (b.from === toId && b.to === fromId) : b.from === fromId || b.to === fromId,
  );
  if (doomed.length === 0) return fail(toId ? `No conveyor between ${fromId} and ${toId}.` : `${fromId} has no conveyors.`);
  for (const b of doomed) for (const it of b.items) add(state.stock, it.item, 1);
  state.belts = state.belts.filter((b) => !doomed.includes(b));
  return { ok: true, message: `Removed ${doomed.length} conveyor(s).` };
}

export function setRecipe(state: GameState, id: string, recipe: string | null): OpResult {
  const m = findMachine(state, id);
  if (!m) return fail(`No machine "${id}".`);
  const def = defOf(m);
  if (def.role !== 'process') return fail(`${displayName(m)} has no recipes.`);
  if (recipe && !def.recipes.includes(recipe)) {
    return fail(`${def.name} can't make that. Options: ${def.recipes.map((r) => RECIPES[r].name).join(', ')}.`);
  }
  if (m.recipe === recipe) return { ok: true, machine: m, message: `${displayName(m)} already runs ${recipe ? RECIPES[recipe].name : 'nothing'}.` };
  // Clear buffers into stock so the machine starts clean.
  returnToStock(state, m.input);
  if (m.running) {
    const old = recipeOf(m);
    if (old) returnToStock(state, old.inputs);
  }
  m.input = {};
  m.recipe = recipe;
  m.running = false;
  m.progress = 0;
  return { ok: true, machine: m, message: `${displayName(m)} now runs ${recipe ? RECIPES[recipe].name : 'nothing'}.` };
}

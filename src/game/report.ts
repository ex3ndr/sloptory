// Text reports for queries, help, and the compact state summary handed to the LLM.

import { BLUEPRINTS, blueprintBounds, blueprintCost } from '../engine/blueprints.ts';
import { ITEMS, MACHINES, MACHINE_LIST, RECIPES, type MachineDef } from '../engine/catalog.ts';
import { money } from '../engine/economy.ts';
import { total, type GameState, type Machine } from '../engine/state.ts';
import { defOf, displayName, recipeOf, stockCapacity } from '../engine/world.ts';

export function clock(t: number): string {
  const s = Math.floor(t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function bag(b: Record<string, number>): string {
  const parts = Object.entries(b)
    .filter(([, q]) => q > 0)
    .map(([it, q]) => `${q} ${ITEMS[it]?.name ?? it}`);
  return parts.length ? parts.join(', ') : 'empty';
}

function recipeLine(id: string): string {
  const r = RECIPES[id];
  const io = (b: Record<string, number>) =>
    Object.entries(b)
      .map(([it, q]) => `${q} ${ITEMS[it].name}`)
      .join(' + ');
  return `${r.name} [${r.id}]: ${io(r.inputs)} → ${io(r.outputs)} in ${r.time}s`;
}

export function shippedTotal(state: GameState): number {
  return Object.values(state.stats.shipped).reduce((a, b) => a + b, 0);
}

export function perMinute(state: GameState): { revenue: number; shipped: number } {
  const h = state.history;
  if (h.length === 0) return { revenue: 0, shipped: 0 };
  const now = { t: state.time, revenue: state.stats.revenue, shipped: shippedTotal(state) };
  const past = h.find((p) => p.t >= state.time - 60) ?? h[0];
  const span = Math.max(1, now.t - past.t);
  if (span < 5) return { revenue: 0, shipped: 0 };
  return {
    revenue: Math.round(((now.revenue - past.revenue) * 60) / span),
    shipped: Math.round(((now.shipped - past.shipped) * 60) / span),
  };
}

export function statusReport(state: GameState): string {
  const counts: Record<string, number> = {};
  for (const m of state.machines) if (defOf(m).role === 'process') counts[m.status] = (counts[m.status] ?? 0) + 1;
  const statusText = Object.entries(counts)
    .map(([s, n]) => `${n} ${s}`)
    .join(', ');
  const pm = perMinute(state);
  const lines = state.lines.map((l) => l.name).join(', ') || 'none';
  const shipped = bag(state.stats.shipped);
  const pw = state.power;
  return [
    `${state.name} · T+${clock(state.time)} · speed ${state.speed === 0 ? 'paused' : state.speed + '×'}`,
    `Cash ${money(state.cash)} (revenue ${money(state.stats.revenue)}, ${money(pm.revenue)}/min)`,
    `Power ${Math.round(pw.demand)}/${pw.capacity} kW${pw.satisfaction < 1 ? ` — BROWNOUT, machines at ${Math.round(pw.satisfaction * 100)}%` : ''}`,
    `Machines: ${state.machines.length} (${statusText || 'no process machines'}); lines: ${lines}`,
    `Shipped: ${shipped}`,
    `Stock (${total(state.stock)}/${stockCapacity(state)}): ${bag(state.stock)}`,
    `Orders: ${state.orders.length ? state.orders.map((o) => `${o.id} ${o.filled}/${o.qty} ${ITEMS[o.item].name}`).join('; ') : 'none open'}`,
    `Auto-buy: ${state.autobuy ? 'on' : 'off'}`,
  ].join('\n');
}

export function machineSummary(m: Machine): string {
  const r = recipeOf(m);
  return `${m.id} ${defOf(m).name} @${m.x},${m.y} ${m.status}${r ? ` · ${r.name}` : ''}`;
}

export function machinesReport(state: GameState): string {
  if (state.machines.length === 0) return 'The floor is empty. Try "build a mug line".';
  return state.machines.map(machineSummary).join('\n');
}

export function machineReport(state: GameState, m: Machine): string {
  const d = defOf(m);
  const ins = state.belts.filter((b) => b.to === m.id).map((b) => `${b.from}${b.path.length ? '' : ' (no route!)'}`);
  const outs = state.belts.filter((b) => b.from === m.id).map((b) => `${b.to}${b.path.length ? '' : ' (no route!)'}`);
  const lines = [
    `${displayName(m)} [${m.id}] at ${m.x},${m.y} (${d.w}×${d.h}) — ${m.status}`,
    d.description,
  ];
  if (d.role === 'process') {
    lines.push(m.recipe ? `Recipe: ${recipeLine(m.recipe)}` : `No recipe. Options: ${d.recipes.map((r) => `${RECIPES[r].name} [${r}]`).join(', ')}`);
    lines.push(`Input buffer: ${bag(m.input)} · Output buffer: ${bag(m.output)} · cycles done: ${m.cycles}`);
  }
  lines.push(`Fed by: ${ins.join(', ') || 'nothing'} · Feeds: ${outs.join(', ') || 'nothing'}`);
  return lines.join('\n');
}

export function stockReport(state: GameState): string {
  return `Stock ${total(state.stock)}/${stockCapacity(state)} units: ${bag(state.stock)}`;
}

export function ordersReport(state: GameState): string {
  if (state.orders.length === 0) return 'No open orders right now. New ones arrive every minute or so.';
  return state.orders
    .map((o) => `${o.id}: ${o.filled}/${o.qty} ${ITEMS[o.item].name} at ${money(o.price)} each, ${clock(Math.max(0, o.expiresAt - state.time))} left`)
    .join('\n');
}

function machineTypeLine(d: MachineDef): string {
  return `${d.name} [${d.id}] ${d.w}×${d.h}, ${money(d.cost)}, ${d.power} kW`;
}

export function recipesReport(def?: MachineDef): string {
  const list = def ? [def] : MACHINE_LIST.filter((d) => d.recipes.length > 0);
  return list.map((d) => `${machineTypeLine(d)}\n${d.recipes.map((r) => '  ' + recipeLine(r)).join('\n')}`).join('\n');
}

export function catalogReport(): string {
  return MACHINE_LIST.map((d) => `${machineTypeLine(d)} — ${d.description}`).join('\n');
}

export function blueprintsReport(): string {
  return BLUEPRINTS.map((b) => {
    const { w, h } = blueprintBounds(b);
    return `${b.name} [${b.id}]: ${b.parts.length} machines, ${w}×${h} tiles, ${money(blueprintCost(b))}. ${b.description}`;
  }).join('\n');
}

export function linesReport(state: GameState): string {
  if (state.lines.length === 0) return 'No production lines yet. Try "build a mug line".';
  return state.lines
    .map((l) => {
      const ms = state.machines.filter((m) => m.line === l.id);
      const bad = ms.filter((m) => m.status === 'starved' || m.status === 'blocked').map((m) => `${m.id} ${m.status}`);
      return `${l.name}: ${ms.length} machines${bad.length ? `; ${bad.join(', ')}` : '; all running'}`;
    })
    .join('\n');
}

export function powerReport(state: GameState): string {
  const pw = state.power;
  const hogs = state.machines
    .filter((m) => defOf(m).power > 0)
    .sort((a, b) => defOf(b).power - defOf(a).power)
    .slice(0, 5)
    .map((m) => `${m.id} ${defOf(m).power} kW`);
  return `Power ${Math.round(pw.demand)}/${pw.capacity} kW (${Math.round(pw.satisfaction * 100)}% supplied). Biggest loads: ${hogs.join(', ') || 'none'}. Each substation adds ${MACHINES.substation.capacity} kW.`;
}

export const HELP = `You run the factory by typing. Examples:
  build a mug line            · build a smart kettle line at 10,40 · blueprints
  place a kiln at 10,5        · place cnc mill for watch case · add 2 kilns
  connect kiln 1 to qa 1      · disconnect kiln 1 from qa 1
  set kiln 1 to glaze firing  · recipes for cnc · info kiln 1
  buy 200 clay                · sell 10 mugs · autobuy on
  remove kiln 2               · move kiln 1 to 30,12
  rename kiln 1 to Bisque kiln · diagnose · diagnose the mug line
  go to the smt line / go to kiln 1 / overview (text camera shortcuts)
  status · stock · orders · machines · lines · power · catalog
  pause · resume · speed 4    · save as day1 · load day1 · saves · new game
Navigate with the mouse and keyboard: drag or two-finger scroll to pan, wheel or pinch to zoom,
WASD/arrows to pan and +/- to zoom, F or Home to fit the factory. Esc or a click on the floor leaves
the text box; Enter or / goes back to typing.
Coordinates are tiles (x right, y down) for a machine's top-left corner.
Materials flow from a receiving dock over conveyors; the shipping dock sells boxed products.`;

function occupiedText(state: GameState): string {
  if (state.machines.length === 0) return 'none, the floor is empty';
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const m of state.machines) {
    const d = defOf(m);
    x0 = Math.min(x0, m.x);
    y0 = Math.min(y0, m.y);
    x1 = Math.max(x1, m.x + d.w);
    y1 = Math.max(y1, m.y + d.h);
  }
  return `x ${x0}..${x1 - 1}, y ${y0}..${y1 - 1}`;
}

/** Compact world description for the LLM, refreshed on every request. */
export function agentSummary(state: GameState): string {
  const lineName = (id: string | null) => (id ? state.lines.find((l) => l.id === id)?.name : undefined);
  const machines = state.machines.map((m) => {
    const d = defOf(m);
    const name = m.name ? ` "${m.name}"` : '';
    const status = d.role === 'process' ? ` ${m.status} ${m.recipe ?? 'NO-RECIPE'}` : '';
    const buf = Object.keys(m.output).length ? ` out{${bag(m.output)}}` : '';
    const line = lineName(m.line) ? ` [${lineName(m.line)}]` : '';
    return `${m.id}${name} ${m.type} @${m.x},${m.y} ${d.w}x${d.h}${status}${buf}${line}`;
  });
  const belts = state.belts.map((b) => `${b.from}->${b.to}${b.path.length ? '' : ' NO-ROUTE'}`);
  return [
    statusReport(state),
    `Floor ${state.width}x${state.height} tiles. Occupied area: ${occupiedText(state)}.`,
    `Machines (id "name" type @x,y wxh status recipe [line]):\n${machines.join('\n') || '(none)'}`,
    `Conveyors: ${belts.join(', ') || '(none)'}`,
  ].join('\n');
}

// Blueprints: complete, connected production lines placed in one command.

import { ITEMS, MACHINES, RECIPES } from './catalog.ts';
import { money, neededSupplies } from './economy.ts';
import { connect, placeMachine } from './ops.ts';
import type { GameState } from './state.ts';
import { occupancy, rectFree, type Rect } from './world.ts';

export interface BlueprintPart {
  key: string;
  type: string;
  x: number;
  y: number;
  recipe?: string;
}

export interface Blueprint {
  id: string;
  name: string;
  product: string;
  aliases: string[];
  description: string;
  parts: BlueprintPart[];
  links: [string, string][];
}

const p = (key: string, type: string, x: number, y: number, recipe?: string): BlueprintPart => ({ key, type, x, y, recipe });

/** The shared board chain: SMT -> reflow -> AOI -> in-circuit test. */
function boardChain(board: string): BlueprintPart[] {
  return [
    p('smt', 'smt_line', 6, 0, `smt_${board}`),
    p('reflow', 'reflow_oven', 13, 0, `reflow_${board}`),
    p('aoi', 'aoi', 19, 0, `aoi_${board}`),
    p('ict', 'pcb_test', 23, 0, `ict_${board}`),
  ];
}

/** Final assembly -> test -> QA -> pack -> ship, starting at x = 27. */
function finishing(product: string): BlueprintPart[] {
  return [
    p('asm', 'assembly', 27, 2, `assemble_${product}`),
    p('test', 'test_bench', 32, 2, `test_${product}`),
    p('qa', 'qa', 37, 2, `qa_${product}`),
    p('pack', 'packaging', 41, 2, `pack_${product}`),
    p('ship', 'shipping_dock', 46, 2),
  ];
}

const BOARD_LINKS: [string, string][] = [
  ['dock', 'smt'],
  ['smt', 'reflow'],
  ['reflow', 'aoi'],
  ['aoi', 'ict'],
  ['ict', 'asm'],
];
const FINISH_LINKS: [string, string][] = [
  ['dock', 'asm'],
  ['dock', 'pack'],
  ['asm', 'test'],
  ['test', 'qa'],
  ['qa', 'pack'],
  ['pack', 'ship'],
];

export const BLUEPRINTS: Blueprint[] = [
  {
    id: 'mug',
    name: 'Mug line',
    product: 'mug_boxed',
    aliases: ['mug', 'mugs', 'ceramic', 'ceramics', 'ceramic mug', 'pottery', 'cup', 'cups'],
    description: 'Slip casting, bisque kiln, glazing, glaze kiln, QA and packaging.',
    parts: [
      p('dock', 'receiving_dock', 0, 0),
      p('cast', 'slip_caster', 6, 0, 'cast_mugs'),
      p('kiln1', 'kiln', 11, 0, 'bisque_fire'),
      p('glaze', 'glazing_station', 16, 0, 'glaze_mug'),
      p('kiln2', 'kiln', 20, 0, 'glaze_fire'),
      p('qa', 'qa', 25, 0, 'qa_mug'),
      p('pack', 'packaging', 29, 0, 'pack_mug'),
      p('ship', 'shipping_dock', 34, 0),
    ],
    links: [
      ['dock', 'cast'],
      ['cast', 'kiln1'],
      ['kiln1', 'glaze'],
      ['dock', 'glaze'],
      ['glaze', 'kiln2'],
      ['kiln2', 'qa'],
      ['qa', 'pack'],
      ['dock', 'pack'],
      ['pack', 'ship'],
    ],
  },
  {
    id: 'kettle',
    name: 'Smart kettle line',
    product: 'kettle_boxed',
    aliases: ['kettle', 'kettles', 'smart kettle', 'smart kettles', 'teakettle'],
    description: 'Deep-drawn steel body, molded housing, controller PCBA, assembly, safety test, QA, packaging.',
    parts: [
      p('dock', 'receiving_dock', 0, 4),
      ...boardChain('kettle'),
      p('press', 'stamping_press', 13, 5, 'draw_kettle_body'),
      p('molder', 'injection_molder', 19, 5, 'mold_kettle_housing'),
      ...finishing('kettle'),
    ],
    links: [...BOARD_LINKS, ['dock', 'press'], ['dock', 'molder'], ['press', 'asm'], ['molder', 'asm'], ...FINISH_LINKS],
  },
  {
    id: 'watch',
    name: 'Smartwatch line',
    product: 'watch_boxed',
    aliases: ['watch', 'watches', 'smartwatch', 'smartwatches', 'smart watch', 'apple watch', 'wearable'],
    description: 'CNC-milled anodized case, molded straps, logic board, assembly, functional test, QA, packaging.',
    parts: [
      p('dock', 'receiving_dock', 0, 4),
      ...boardChain('watch'),
      p('cnc', 'cnc_mill', 6, 5, 'mill_watch_case'),
      p('anod', 'anodizing_tank', 11, 5, 'anodize_case'),
      p('molder', 'injection_molder', 18, 5, 'mold_watch_strap'),
      ...finishing('watch'),
    ],
    links: [...BOARD_LINKS, ['dock', 'cnc'], ['cnc', 'anod'], ['anod', 'asm'], ['dock', 'molder'], ['molder', 'asm'], ...FINISH_LINKS],
  },
  {
    id: 'phone',
    name: 'Smartphone line',
    product: 'phone_boxed',
    aliases: ['phone', 'phones', 'smartphone', 'smartphones', 'iphone', 'iphones', 'mobile', 'cellphone'],
    description: 'CNC-milled anodized frame, logic board with SoC, assembly with display/battery/camera, test, QA, packaging.',
    parts: [
      p('dock', 'receiving_dock', 0, 4),
      ...boardChain('phone'),
      p('cnc', 'cnc_mill', 6, 5, 'mill_phone_frame'),
      p('anod', 'anodizing_tank', 11, 5, 'anodize_frame'),
      ...finishing('phone'),
    ],
    links: [...BOARD_LINKS, ['dock', 'cnc'], ['cnc', 'anod'], ['anod', 'asm'], ...FINISH_LINKS],
  },
];

export const BLUEPRINT_BY_ID: Record<string, Blueprint> = Object.fromEntries(BLUEPRINTS.map((b) => [b.id, b]));

export function blueprintBounds(bp: Blueprint): { w: number; h: number } {
  let w = 0;
  let h = 0;
  for (const part of bp.parts) {
    const d = MACHINES[part.type];
    w = Math.max(w, part.x + d.w);
    h = Math.max(h, part.y + d.h);
  }
  return { w, h };
}

export function blueprintCost(bp: Blueprint): number {
  return bp.parts.reduce((sum, part) => sum + MACHINES[part.type].cost, 0);
}

const MARGIN = 3;

function fits(state: GameState, bp: Blueprint, x: number, y: number, grid: Int32Array, margin: number): boolean {
  const { w, h } = blueprintBounds(bp);
  const outer: Rect = { x: x - margin, y: y - margin, w: w + margin * 2, h: h + margin * 2 };
  if (outer.x < 0 || outer.y < 0 || outer.x + outer.w > state.width || outer.y + outer.h > state.height) return false;
  return rectFree(state, outer, grid);
}

/** First free spot scanning top-to-bottom, left-to-right, with room for belts around it. */
export function findBlueprintSpot(state: GameState, bp: Blueprint): { x: number; y: number } | null {
  const grid = occupancy(state);
  for (let y = MARGIN; y < state.height; y++) {
    for (let x = MARGIN; x < state.width; x++) if (fits(state, bp, x, y, grid, MARGIN)) return { x, y };
  }
  return null;
}

export interface BlueprintResult {
  ok: boolean;
  message: string;
  lineId?: string;
  at?: { x: number; y: number };
}

export function buildBlueprint(state: GameState, id: string, at?: { x: number; y: number }): BlueprintResult {
  const bp = BLUEPRINT_BY_ID[id];
  if (!bp) return { ok: false, message: `Unknown blueprint "${id}". Options: ${BLUEPRINTS.map((b) => b.id).join(', ')}.` };
  const cost = blueprintCost(bp);
  if (state.cash < cost) return { ok: false, message: `${bp.name} costs ${money(cost)}; you have ${money(state.cash)}.` };
  const spot = at ?? findBlueprintSpot(state, bp);
  if (!spot) return { ok: false, message: `No room left on the floor for a ${bp.name.toLowerCase()} (${blueprintBounds(bp).w}×${blueprintBounds(bp).h}).` };
  if (at && !fits(state, bp, at.x, at.y, occupancy(state), 0)) {
    const { w, h } = blueprintBounds(bp);
    return { ok: false, message: `A ${bp.name.toLowerCase()} needs a clear ${w}×${h} area at ${at.x},${at.y}.` };
  }

  state.counters.line++;
  const n = state.lines.filter((l) => l.blueprint === bp.id).length + 1;
  const lineId = `${bp.id}-line-${state.counters.line}`;
  const lineName = `${bp.name} ${n}`;
  const ids: Record<string, string> = {};
  for (const part of bp.parts) {
    const r = placeMachine(state, part.type, spot.x + part.x, spot.y + part.y, { recipe: part.recipe ?? null, line: lineId });
    if (!r.ok || !r.machine) return { ok: false, message: `Blueprint stopped: ${r.message}` };
    ids[part.key] = r.machine.id;
  }
  state.lines.push({ id: lineId, name: lineName, blueprint: bp.id });
  const failed: string[] = [];
  for (const [a, b] of bp.links) {
    const r = connect(state, ids[a], ids[b]);
    if (!r.ok) failed.push(r.message);
  }
  const supplies = neededSupplies(state).filter((it) => bp.parts.some((part) => part.recipe && recipeUses(part.recipe, it)));
  const supplyText = supplies.map((it) => ITEMS[it].name).join(', ');
  const warn = failed.length ? ` ${failed.length} conveyor(s) failed: ${failed.join(' ')}` : '';
  return {
    ok: true,
    lineId,
    at: spot,
    message:
      `Built ${lineName} at ${spot.x},${spot.y}: ${bp.parts.length} machines, ${bp.links.length - failed.length} conveyors, ${money(cost)}.` +
      ` It consumes ${supplyText}. Buy them (e.g. "buy 200 ${ITEMS[supplies[0]]?.aliases[0] ?? 'clay'}") or say "autobuy on".${warn}`,
  };
}

function recipeUses(recipe: string, item: string): boolean {
  return item in (RECIPES[recipe]?.inputs ?? {});
}

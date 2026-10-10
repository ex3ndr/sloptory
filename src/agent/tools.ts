// LLM tool definitions: a thin JSON-schema mirror of the engine Command API. The model
// designs layouts itself from fine-grained tools; blueprints are parser-only.

import { ITEM_LIST, MACHINE_LIST, RECIPES, isBuyable } from '../engine/catalog.ts';
import { BELT_SPEED, WORLD_H, WORLD_W } from '../engine/state.ts';
import { BATCH_OPS, type Command } from '../game/api.ts';

export interface ToolDef {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'integer', description });
const numb = (description: string) => ({ type: 'number', description });
const bool = (description: string) => ({ type: 'boolean', description });
const obj = (properties: Record<string, unknown>, required: string[] = []): ToolDef['parameters'] => ({ type: 'object', properties, ...(required.length ? { required } : {}) });

const MACHINE_TYPES = MACHINE_LIST.map((m) => m.id);
const BUYABLE = ITEM_LIST.filter((i) => isBuyable(i.id)).map((i) => i.id);

const BATCH_OP = {
  type: 'object',
  description: 'One edit op. Fields depend on op (see the batch tool description).',
  properties: {
    op: { type: 'string', enum: [...BATCH_OPS] },
    type: { type: 'string', enum: MACHINE_TYPES, description: 'place: machine type' },
    x: int('place/move: top-left tile x'),
    y: int('place/move: top-left tile y'),
    recipe: str('place/set_recipe: recipe id'),
    name: str('place/rename/name_line: a name'),
    as: str('place: reference for later ops in this batch, used as "@<as>"'),
    id: str('remove/move/set_recipe/rename: machine id or "@ref"'),
    from: str('connect/disconnect: source machine id or "@ref"'),
    to: str('connect/disconnect: destination machine id or "@ref"'),
    machines: { type: 'array', items: { type: 'string' }, description: 'name_line: machine ids or "@refs"' },
    item: str('buy/sell: item id'),
    qty: int('buy/sell: quantity'),
    on: bool('autobuy: on/off'),
  },
  required: ['op'],
};

export const TOOLS: ToolDef[] = [
  // ---- read ----
  {
    name: 'get_catalog',
    description:
      'Machine types (footprint w×h, cost $, power kW, role) with their recipes (inputs → outputs per cycle, cycle seconds), plus item prices. Optional filter: a machine type, a category (logistics, ceramics, metal, plastics, electronics, assembly, power) or an item kind (raw, component, part, product).',
    parameters: obj({ filter: str('Optional filter') }),
  },
  {
    name: 'find_recipes',
    description:
      'Which recipes make and which use an item. With upstream=true, also the full chain of recipes needed to make it from purchasable goods (in build order) and the list of goods to buy.',
    parameters: obj({ item: str('Item id or name, e.g. kettle_boxed'), upstream: bool('Include the full upstream chain') }, ['item']),
  },
  {
    name: 'get_state',
    description:
      'Current factory: cash, power (capacity, demand, full_load), stock, orders, lines, and machines with id, name, type, x, y, w, h, recipe, status, input/output buffers and conveyor connections (from/to). Optionally limit to a line name, a machine id, or a region (x, y, w, h).',
    parameters: obj({ target: str('Line name or machine id'), x: int('Region left'), y: int('Region top'), w: int('Region width'), h: int('Region height') }),
  },
  {
    name: 'find_free_area',
    description:
      'Find empty w×h areas (no machines or conveyors) with a clear margin around them, closest to near_x,near_y (default: top-left of the floor). Returns top-left corners.',
    parameters: obj(
      {
        w: int('Width in tiles'),
        h: int('Height in tiles'),
        near_x: int('Preferred x'),
        near_y: int('Preferred y'),
        margin: int('Clear tiles kept around the area (default 1)'),
        count: int('How many candidates (default 3, max 10)'),
      },
      ['w', 'h'],
    ),
  },
  {
    name: 'view_map',
    description: "ASCII map of a floor region (max 100×60): '.' free, '=' conveyor, letters are machines (legend maps letters to ids and positions).",
    parameters: obj({ x: int('Left'), y: int('Top'), w: int('Width'), h: int('Height') }, ['x', 'y', 'w', 'h']),
  },
  {
    name: 'diagnose',
    description:
      'Check the layout: machines without recipes, inputs nothing supplies, outputs with nowhere to go, conveyors with no route or carrying nothing, missing receiving dock, out-of-stock purchased inputs, power shortfall, plus notes on starved/blocked machines. Optional target: a line name or machine id. Call it after every build or change and fix all errors.',
    parameters: obj({ target: str('Line name or machine id (default: whole factory)') }),
  },
  // ---- edit ----
  {
    name: 'place_machine',
    description: 'Buy and place one machine with its top-left tile at x,y. Multi-recipe machines need a recipe.',
    parameters: obj(
      { type: { type: 'string', enum: MACHINE_TYPES }, x: int('Top-left tile x'), y: int('Top-left tile y'), recipe: str('Recipe id'), name: str('Optional display name') },
      ['type', 'x', 'y'],
    ),
  },
  { name: 'remove_machine', description: 'Demolish a machine (50% refund). Its conveyors go too; buffered items return to stock.', parameters: obj({ id: str('Machine id') }, ['id']) },
  { name: 'move_machine', description: 'Move a machine; its conveyors re-route automatically.', parameters: obj({ id: str('Machine id'), x: int('New top-left x'), y: int('New top-left y') }, ['id', 'x', 'y']) },
  { name: 'set_recipe', description: 'Choose the recipe a machine runs ("none" clears it).', parameters: obj({ id: str('Machine id'), recipe: str('Recipe id') }, ['id', 'recipe']) },
  { name: 'rename_machine', description: 'Give a machine a display name (empty string restores the default). Names can be used instead of ids.', parameters: obj({ id: str('Machine id'), name: str('New name') }, ['id', 'name']) },
  {
    name: 'connect',
    description: 'Run an auto-routed conveyor from one machine to another. It carries what the source outputs (or, from a dock/warehouse, what the destination consumes from stock).',
    parameters: obj({ from: str('Source machine id'), to: str('Destination machine id') }, ['from', 'to']),
  },
  {
    name: 'disconnect',
    description: 'Remove the conveyor between two machines (either direction), or every conveyor of one machine if `to` is omitted.',
    parameters: obj({ from: str('Machine id'), to: str('Other machine id') }, ['from']),
  },
  {
    name: 'name_line',
    description: 'Group machines under a line/zone name (created if new; machines leave their previous line). The player can then say "go to the <name>".',
    parameters: obj({ name: str('Line name, e.g. "Kettle line"'), machines: { type: 'array', items: { type: 'string' }, description: 'Machine ids' } }, ['name', 'machines']),
  },
  { name: 'buy', description: 'Buy purchasable goods into stock (needs a receiving dock).', parameters: obj({ item: { type: 'string', enum: BUYABLE }, qty: int('Quantity') }, ['item', 'qty']) },
  { name: 'sell', description: 'Sell items from stock: boxed products at market price, purchased goods back at half price.', parameters: obj({ item: str('Item id'), qty: int('Quantity (omit for all)') }, ['item']) },
  { name: 'set_autobuy', description: 'Keep every purchased input of configured machines topped up automatically while cash lasts.', parameters: obj({ on: { type: 'boolean' } }, ['on']) },
  {
    name: 'batch',
    description:
      'Apply many edit ops in order in one call; the efficient way to build or rework a line. Ops: place {type,x,y,recipe?,name?,as?}, remove {id}, move {id,x,y}, set_recipe {id,recipe}, rename {id,name}, connect {from,to}, disconnect {from,to?}, name_line {name,machines}, buy {item,qty}, sell {item,qty?}, autobuy {on}. A place op with as:"press" can be referenced by later ops as "@press" (in id, from, to, machines). Returns ok/message/id for every op. dry_run=true simulates on a copy and changes nothing (ids reported are the ones a real run would get). atomic=true rolls everything back if any op fails.',
    parameters: obj({ ops: { type: 'array', items: BATCH_OP, description: 'Ops, applied in order' }, dry_run: bool('Simulate only'), atomic: bool('All or nothing') }, ['ops']),
  },
  // ---- view and game ----
  {
    name: 'camera',
    description:
      "Move this player's view. focus: a target (machine id, machine type, or line name). overview: fit the whole factory. pan: dx/dy tiles. center: absolute x/y. zoom: factor (>1 = in) or level (0.25..3).",
    parameters: obj(
      {
        action: { type: 'string', enum: ['focus', 'overview', 'pan', 'center', 'zoom'] },
        target: str('What to focus on'),
        dx: numb('Tiles right (negative = left)'),
        dy: numb('Tiles down (negative = up)'),
        x: numb('Tile x to center on'),
        y: numb('Tile y to center on'),
        factor: numb('Zoom multiplier'),
        level: numb('Absolute zoom'),
      },
      ['action'],
    ),
  },
  { name: 'set_speed', description: 'Simulation speed: 0 pauses, 1/2/4/8 run faster.', parameters: obj({ value: int('0, 1, 2, 4 or 8') }, ['value']) },
  { name: 'new_game', description: 'Start over with an empty floor (the current game is autosaved).', parameters: obj({ name: str('Optional name') }) },
  { name: 'save_game', description: 'Save the game under a name.', parameters: obj({ name: str('Save name') }) },
  { name: 'load_game', description: 'Load a saved game.', parameters: obj({ name: str('Save name') }, ['name']) },
  { name: 'list_saves', description: 'List saved games.', parameters: obj({}) },
];

/** Tools that change the factory (their results are streamed to the player's log). */
export const EDIT_TOOLS = new Set(['place_machine', 'remove_machine', 'move_machine', 'set_recipe', 'rename_machine', 'connect', 'disconnect', 'name_line', 'buy', 'sell', 'set_autobuy', 'batch']);

type Args = Record<string, unknown>;
const s = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
const req = (v: unknown) => (v === undefined || v === null ? '' : String(v));
const n = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));

/** Maps one batch op ({op, type, id, ...}) to an engine Command. Unknown ops pass through for the engine to reject. */
export function batchOpToCommand(o: Args): Command {
  switch (o.op) {
    case 'place':
      return { op: 'place', machine: req(o.type), x: n(o.x), y: n(o.y), recipe: s(o.recipe), name: s(o.name), as: s(o.as) };
    case 'remove':
      return { op: 'remove', target: req(o.id) };
    case 'move':
      return { op: 'move', target: req(o.id), x: Number(o.x), y: Number(o.y) };
    case 'set_recipe':
      return { op: 'set_recipe', target: req(o.id), recipe: req(o.recipe) };
    case 'rename':
      return { op: 'rename', target: req(o.id), name: req(o.name) };
    case 'connect':
      return { op: 'connect', from: req(o.from), to: req(o.to) };
    case 'disconnect':
      return { op: 'disconnect', from: req(o.from), to: s(o.to) };
    case 'name_line':
      return { op: 'name_line', name: req(o.name), machines: Array.isArray(o.machines) ? o.machines.map(String) : [] };
    case 'buy':
      return { op: 'buy', item: req(o.item), qty: Number(o.qty) };
    case 'sell':
      return { op: 'sell', item: req(o.item), qty: n(o.qty) ?? 'all' };
    case 'autobuy':
      return { op: 'autobuy', on: Boolean(o.on) };
    default:
      return { op: String(o.op ?? '') } as unknown as Command;
  }
}

/** The ops array of a batch call; models sometimes send it as a JSON string. */
function batchOps(a: Args): unknown[] {
  let ops = a.ops;
  if (typeof ops === 'string') {
    try {
      ops = JSON.parse(ops);
    } catch {
      // Reported below.
    }
  }
  if (Array.isArray(ops)) return ops;
  const got = ops === undefined ? `no "ops" (arguments had: ${Object.keys(a).join(', ') || 'nothing'})` : `"ops" as ${typeof ops}: ${JSON.stringify(ops).slice(0, 120)}`;
  throw new Error(`batch needs "ops": an array of op objects like {"op":"place",...}; got ${got}.`);
}

export function toolToCommand(name: string, a: Args): Command {
  switch (name) {
    case 'get_catalog':
      return { op: 'catalog', filter: s(a.filter) };
    case 'find_recipes':
      return { op: 'item', item: req(a.item), upstream: Boolean(a.upstream) };
    case 'get_state':
      return { op: 'inspect', target: s(a.target), x: n(a.x), y: n(a.y), w: n(a.w), h: n(a.h) };
    case 'find_free_area':
      return { op: 'find_space', w: Number(a.w), h: Number(a.h), x: n(a.near_x), y: n(a.near_y), margin: n(a.margin), count: n(a.count) };
    case 'view_map':
      return { op: 'map', x: Number(a.x ?? 0), y: Number(a.y ?? 0), w: Number(a.w ?? 60), h: Number(a.h ?? 30) };
    case 'diagnose':
      return { op: 'diagnose', target: s(a.target) };
    case 'place_machine':
      return { op: 'place', machine: req(a.type), x: n(a.x), y: n(a.y), recipe: s(a.recipe), name: s(a.name) };
    case 'remove_machine':
      return { op: 'remove', target: req(a.id) };
    case 'move_machine':
      return { op: 'move', target: req(a.id), x: Number(a.x), y: Number(a.y) };
    case 'set_recipe':
      return { op: 'set_recipe', target: req(a.id), recipe: req(a.recipe) };
    case 'rename_machine':
      return { op: 'rename', target: req(a.id), name: req(a.name) };
    case 'connect':
      return { op: 'connect', from: req(a.from), to: req(a.to) };
    case 'disconnect':
      return { op: 'disconnect', from: req(a.from), to: s(a.to) };
    case 'name_line':
      return { op: 'name_line', name: req(a.name), machines: Array.isArray(a.machines) ? a.machines.map(String) : [] };
    case 'buy':
      return { op: 'buy', item: req(a.item), qty: Number(a.qty) };
    case 'sell':
      return { op: 'sell', item: req(a.item), qty: n(a.qty) ?? 'all' };
    case 'set_autobuy':
      return { op: 'autobuy', on: Boolean(a.on) };
    case 'batch':
      return { op: 'batch', ops: batchOps(a).map((o) => batchOpToCommand((o ?? {}) as Args)), dryRun: Boolean(a.dry_run), atomic: Boolean(a.atomic) };
    case 'camera':
      return {
        op: 'camera',
        action: String(a.action) as Extract<Command, { op: 'camera' }>['action'],
        dx: n(a.dx),
        dy: n(a.dy),
        x: n(a.x),
        y: n(a.y),
        factor: n(a.factor),
        level: n(a.level),
        target: s(a.target),
      };
    case 'set_speed':
      return { op: 'speed', value: Number(a.value) };
    case 'new_game':
      return { op: 'new_game', name: s(a.name) };
    case 'save_game':
      return { op: 'save', name: s(a.name) };
    case 'load_game':
      return { op: 'load', name: req(a.name) };
    case 'list_saves':
      return { op: 'list_saves' };
    default:
      throw new Error(`Unknown tool "${name}".`);
  }
}

function io(b: Record<string, number>): string {
  return Object.entries(b)
    .map(([it, q]) => `${q} ${it}`)
    .join(' + ');
}

/** Static rules, layout guidance and a compact catalog, sent once as the system prompt. */
export function systemPrompt(): string {
  const machines = MACHINE_LIST.map((m) => {
    const recipes = m.recipes.map((r) => `\n    ${r}: ${io(RECIPES[r].inputs)} -> ${io(RECIPES[r].outputs)} in ${RECIPES[r].time}s`).join('');
    const extra = m.role === 'storage' ? ` (+${m.capacity} stock)` : m.role === 'power' ? ` (+${m.capacity} kW)` : '';
    return `- ${m.id} ${m.w}x${m.h} $${m.cost} ${m.power}kW ${m.role}${extra}: ${m.description}${recipes}`;
  }).join('\n');
  const buyables = ITEM_LIST.filter((i) => isBuyable(i.id))
    .map((i) => `${i.id} $${i.price}`)
    .join(', ');
  const products = ITEM_LIST.filter((i) => i.kind === 'product')
    .map((i) => `${i.id} $${i.price}`)
    .join(', ');
  return `You are the plant engineer of Sloptory, a top-down factory simulation. The player can only type; you change the factory with tools. You design every layout yourself: which machines, where they go, which recipe each runs and how they connect. There are no prefab lines.

## How the world works
- Floor: ${WORLD_W}x${WORLD_H} tiles, x grows to the right, y grows down. A machine's x,y is its top-left tile and it covers w×h tiles. Machines cannot overlap or leave the floor.
- Conveyors: you only call connect(from, to). The engine routes the belt (A*) through free tiles around machines and re-routes after moves. Belts may share tiles. Routing fails only when a machine is boxed in, so leave gaps. Belts move ${BELT_SPEED} tiles/s, so keep connected machines reasonably close.
- Machines: each process machine runs one recipe, consuming its inputs from an input buffer and putting outputs in an output buffer. A conveyor A→B carries whatever A outputs that B's recipe uses. Outputs leave only on conveyors, so every output needs a connected consumer or the machine blocks.
- Purchases go into one shared stock, delivered through a receiving dock (at least one is required). A receiving dock or warehouse connected to a machine sends it whatever stock items its recipe consumes, so connect a dock to every machine that uses purchased goods (packaging needs cartons, SMT needs PCBs and SMD reels, assembly needs bought modules, and so on). One dock can feed many machines.
- Shipping dock: boxed products (*_boxed) delivered to it are sold; open orders pay a premium.
- Power: one global budget, 400 kW base, +400 kW per substation (2x2, $15000, no conveyors needed). Over budget, every machine slows down proportionally.
- Throughput: a recipe yields its outputs every "time" seconds. Example: kiln bisque_fire gives 4 per 12 s = 20/min; glazing_station gives 1 per 2.5 s = 24/min. Where one stage is much slower than its neighbours, add a parallel machine fed by the same source and feeding the same consumer.
- Nothing is produced until purchased inputs are in stock. After building, buy a starting supply (about 100–200 of each cheap input, fewer of expensive modules) and turn on autobuy unless the player said otherwise.

## How to build a production line
1. Work out the chain with find_recipes(<product>, upstream=true): every recipe from purchased goods to the boxed product.
2. Choose a spot with find_free_area sized for the whole line plus gaps. One row of N machines is about (sum of widths + 2*N) tiles wide; a main row plus a feeder row is about 12 tiles tall.
3. Lay it out in flow order, left to right: receiving dock at the left, then each stage, then final assembly, test, QA, packaging, and the shipping dock at the right end. Put sub-assembly chains (circuit boards, molded or machined parts) in a parallel row 3–4 tiles above or below the main row, ending next to the assembly station they feed. Keep at least 2 empty tiles between machines and between rows.
4. Build the whole line with a single batch: place ops with "as" refs, connect ops using the "@refs", and name_line (for example "Kettle line"). Run it with dry_run=true first, fix any failed ops, then apply it for real with atomic=true.
5. Run diagnose on the line and fix every error. Then buy materials or set_autobuy, and use camera focus on the line so the player sees it.
6. To change an existing line, get_state for that line first, find free space next to the machines involved, wire new machines in parallel or in sequence, then diagnose.

## Reply style
After the work is done, reply in one to three short sentences: what you built or changed (machine ids, total cost) and anything the player should know. Don't narrate tool calls or ask permission for obvious next steps. If a request is impossible (unknown product, not enough cash), say so briefly and suggest an alternative.

## Catalog
Machines (type WxH cost power role):
${machines}

Purchasable (unit price): ${buyables}
Products (sale price): ${products}`;
}

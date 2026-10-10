// LLM tool definitions: a thin JSON-schema mirror of the engine Command API.

import { BLUEPRINTS } from '../engine/blueprints.ts';
import { ITEM_LIST, MACHINE_LIST, RECIPES, isBuyable } from '../engine/catalog.ts';
import type { Command, QueryKind } from '../game/api.ts';

export interface ToolDef {
  name: string;
  description: string;
  parameters: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'integer', description });
const numb = (description: string) => ({ type: 'number', description });

export const TOOLS: ToolDef[] = [
  {
    name: 'build_blueprint',
    description: 'Place a complete, connected production line. Omit x/y to auto-place it in free space. Fastest way to start producing a product.',
    parameters: {
      type: 'object',
      properties: { blueprint: { type: 'string', enum: BLUEPRINTS.map((b) => b.id) }, x: int('Top-left tile x (optional)'), y: int('Top-left tile y (optional)') },
      required: ['blueprint'],
    },
  },
  {
    name: 'place_machine',
    description: 'Buy and place machine(s). x,y is the top-left tile; omit to auto-place near the player view.',
    parameters: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: MACHINE_LIST.map((m) => m.id) },
        x: int('Top-left tile x'),
        y: int('Top-left tile y'),
        recipe: str('Recipe id to run (optional)'),
        count: int('How many to place (default 1, max 10)'),
      },
      required: ['type'],
    },
  },
  { name: 'remove_machine', description: 'Demolish a machine (50% refund). Its conveyors are removed too.', parameters: { type: 'object', properties: { id: str('Machine id, e.g. kiln-1') }, required: ['id'] } },
  {
    name: 'move_machine',
    description: 'Move a machine; its conveyors re-route automatically.',
    parameters: { type: 'object', properties: { id: str('Machine id'), x: int('New top-left x'), y: int('New top-left y') }, required: ['id', 'x', 'y'] },
  },
  {
    name: 'connect',
    description: 'Run an auto-routed conveyor from one machine to another. Items flow from the source output (or stock, for docks/warehouses) to whatever the destination needs.',
    parameters: { type: 'object', properties: { from: str('Source machine id'), to: str('Destination machine id') }, required: ['from', 'to'] },
  },
  {
    name: 'disconnect',
    description: 'Remove the conveyor between two machines, or all conveyors of one machine if `to` is omitted.',
    parameters: { type: 'object', properties: { from: str('Machine id'), to: str('Other machine id (optional)') }, required: ['from'] },
  },
  {
    name: 'set_recipe',
    description: 'Choose which recipe a machine runs ("none" clears it).',
    parameters: { type: 'object', properties: { id: str('Machine id'), recipe: str('Recipe id') }, required: ['id', 'recipe'] },
  },
  {
    name: 'buy',
    description: 'Buy raw materials or components; delivered to stock via the receiving dock.',
    parameters: { type: 'object', properties: { item: { type: 'string', enum: ITEM_LIST.filter((i) => isBuyable(i.id)).map((i) => i.id) }, qty: int('Quantity') }, required: ['item', 'qty'] },
  },
  {
    name: 'sell',
    description: 'Sell items from stock: boxed products at market price, purchased goods at half price.',
    parameters: { type: 'object', properties: { item: str('Item id'), qty: int('Quantity (omit for all)') }, required: ['item'] },
  },
  {
    name: 'query',
    description: 'Read factory information.',
    parameters: {
      type: 'object',
      properties: {
        what: { type: 'string', enum: ['status', 'machines', 'machine', 'stock', 'orders', 'recipes', 'catalog', 'blueprints', 'power', 'lines'] },
        target: str('Machine id for "machine"; machine type or item for "recipes"'),
      },
      required: ['what'],
    },
  },
  {
    name: 'camera',
    description: "Move the player's view. pan: dx/dy tiles. center: absolute x/y. zoom: factor (>1 in) or level. focus: target name (machine id, machine type, or line like 'mug line'). overview: fit everything.",
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['pan', 'center', 'zoom', 'focus', 'overview'] },
        dx: numb('Tiles right (negative = left)'),
        dy: numb('Tiles down (negative = up)'),
        x: numb('Tile x to center on'),
        y: numb('Tile y to center on'),
        factor: numb('Zoom multiplier'),
        level: numb('Absolute zoom 0.3..3'),
        target: str('What to focus on'),
      },
      required: ['action'],
    },
  },
  { name: 'set_speed', description: 'Simulation speed: 0 pauses, 1/2/4/8 run faster.', parameters: { type: 'object', properties: { value: int('0, 1, 2, 4 or 8') }, required: ['value'] } },
  { name: 'set_autobuy', description: 'Automatically keep purchased inputs stocked.', parameters: { type: 'object', properties: { on: { type: 'boolean' } }, required: ['on'] } },
  { name: 'new_game', description: 'Start over with a fresh factory (current game is autosaved).', parameters: { type: 'object', properties: { name: str('Optional name') } } },
  { name: 'save_game', description: 'Save the game under a name.', parameters: { type: 'object', properties: { name: str('Save name') } } },
  { name: 'load_game', description: 'Load a saved game.', parameters: { type: 'object', properties: { name: str('Save name') }, required: ['name'] } },
  { name: 'list_saves', description: 'List saved games.', parameters: { type: 'object', properties: {} } },
];

type Args = Record<string, unknown>;
const s = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
const n = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));

export function toolToCommand(name: string, a: Args): Command {
  switch (name) {
    case 'build_blueprint':
      return { op: 'blueprint', name: String(a.blueprint), x: n(a.x), y: n(a.y) };
    case 'place_machine':
      return { op: 'place', machine: String(a.type), x: n(a.x), y: n(a.y), recipe: s(a.recipe), count: n(a.count) };
    case 'remove_machine':
      return { op: 'remove', target: String(a.id) };
    case 'move_machine':
      return { op: 'move', target: String(a.id), x: Number(a.x), y: Number(a.y) };
    case 'connect':
      return { op: 'connect', from: String(a.from), to: String(a.to) };
    case 'disconnect':
      return { op: 'disconnect', from: String(a.from), to: s(a.to) };
    case 'set_recipe':
      return { op: 'set_recipe', target: String(a.id), recipe: String(a.recipe) };
    case 'buy':
      return { op: 'buy', item: String(a.item), qty: Number(a.qty) };
    case 'sell':
      return { op: 'sell', item: String(a.item), qty: n(a.qty) ?? 'all' };
    case 'query':
      return { op: 'query', what: String(a.what) as QueryKind, target: s(a.target) };
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
    case 'set_autobuy':
      return { op: 'autobuy', on: Boolean(a.on) };
    case 'new_game':
      return { op: 'new_game', name: s(a.name) };
    case 'save_game':
      return { op: 'save', name: s(a.name) };
    case 'load_game':
      return { op: 'load', name: String(a.name) };
    case 'list_saves':
      return { op: 'list_saves' };
    default:
      throw new Error(`Unknown tool "${name}".`);
  }
}

/** Static rules and catalog, sent once as the system prompt. */
export function systemPrompt(): string {
  const machines = MACHINE_LIST.map((m) => {
    const recipes = m.recipes
      .map((r) => {
        const rd = RECIPES[r];
        const io = (b: Record<string, number>) =>
          Object.entries(b)
            .map(([it, q]) => `${q} ${it}`)
            .join('+');
        return `${r}: ${io(rd.inputs)} -> ${io(rd.outputs)} ${rd.time}s`;
      })
      .join('; ');
    return `- ${m.id} (${m.w}x${m.h}, $${m.cost}, ${m.power}kW, ${m.role}) ${m.description}${recipes ? ` Recipes: ${recipes}` : ''}`;
  }).join('\n');
  const buyables = ITEM_LIST.filter((i) => isBuyable(i.id))
    .map((i) => `${i.id} $${i.price}`)
    .join(', ');
  const products = ITEM_LIST.filter((i) => i.kind === 'product')
    .map((i) => `${i.id} $${i.price}`)
    .join(', ');
  const blueprints = BLUEPRINTS.map((b) => `- ${b.id}: ${b.name}. ${b.description}`).join('\n');
  return `You are the floor manager agent of Sloptory, a top-down factory simulation. The player can only type; you change the factory by calling tools. Act, don't just describe: when the player asks for something, call the tools that do it, then reply in one to three short sentences saying what changed (mention machine ids and costs). If a tool fails, adjust and retry once, or explain briefly.

World: a ${120}x${80} tile grid, x to the right, y down. Machine x,y is its top-left tile. Machines cannot overlap; leave 2+ tiles between machines so conveyors can route. Conveyors are auto-routed by the engine; you only say what connects to what.
Flow: purchases go into a shared stock delivered through receiving docks. A receiving dock or warehouse connected to a machine sends that machine whatever stock items its recipe needs. Process machines have input/output buffers; connect each machine to the next. Boxed products (*_boxed) delivered to a shipping dock are sold; open orders pay a premium. Power is one global budget (400 kW base, +400 kW per substation); over budget everything slows down.
Prefer build_blueprint for whole products. Buying materials or "set_autobuy" keeps lines running. Camera tool affects only this player's view.

Machines:
${machines}

Blueprints:
${blueprints}

Buyable (unit price): ${buyables}
Products (sale price): ${products}`;
}

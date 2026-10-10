// Data-driven catalog: every item, machine and recipe in the factory.
// Prices are in dollars, power in kW, times in simulated seconds.

export type ItemKind = 'raw' | 'component' | 'part' | 'product';

export interface ItemDef {
  id: string;
  name: string;
  kind: ItemKind;
  /** Purchase price for raw/component items, sale price for products, 0 for parts. */
  price: number;
  color: string;
  aliases: string[];
}

/** process: runs recipes. storage: shares the global stock. shipping: sells products. power: adds grid capacity. */
export type MachineRole = 'process' | 'storage' | 'shipping' | 'power';

export type MachineCategory =
  | 'logistics'
  | 'ceramics'
  | 'metal'
  | 'plastics'
  | 'electronics'
  | 'assembly'
  | 'power';

export interface MachineDef {
  id: string;
  /** Prefix for instance ids, e.g. "kiln" gives "kiln-1". */
  short: string;
  name: string;
  category: MachineCategory;
  role: MachineRole;
  w: number;
  h: number;
  cost: number;
  /** kW drawn while working (10% while idle). */
  power: number;
  /** storage: stock units added. power: kW of grid capacity added. */
  capacity: number;
  /** Receiving docks are where purchases are delivered. */
  receives: boolean;
  recipes: string[];
  aliases: string[];
  description: string;
}

export interface RecipeDef {
  id: string;
  name: string;
  machine: string;
  inputs: Record<string, number>;
  outputs: Record<string, number>;
  time: number;
  aliases: string[];
}

function item(id: string, name: string, kind: ItemKind, price: number, color: string, aliases: string[] = []): ItemDef {
  return { id, name, kind, price, color, aliases };
}

export const ITEM_LIST: ItemDef[] = [
  // Raw materials.
  item('clay', 'Clay', 'raw', 0.4, '#a5643f', ['clay', 'slip', 'porcelain']),
  item('glaze', 'Glaze', 'raw', 0.3, '#5ec4d6', ['glaze', 'glazes']),
  item('aluminum_billet', 'Aluminum billet', 'raw', 5, '#c3cad1', ['aluminum', 'aluminium', 'billet', 'billets', 'aluminum billet', 'aluminium billet']),
  item('steel_sheet', 'Stainless steel sheet', 'raw', 3, '#8b97a3', ['steel', 'steel sheet', 'stainless', 'sheet steel', 'stainless steel']),
  item('plastic_pellets', 'Plastic pellets', 'raw', 0.5, '#efe8d2', ['plastic', 'pellets', 'resin', 'plastic pellets', 'abs']),
  item('carton', 'Carton', 'raw', 0.4, '#c9a46b', ['carton', 'cartons', 'box', 'boxes', 'packaging material', 'packaging materials', 'cardboard']),
  // Purchased components.
  item('pcb_blank', 'Bare PCB', 'component', 2, '#2f8a3a', ['pcb', 'pcbs', 'bare pcb', 'blank pcb', 'pcb blank', 'boards', 'bare board']),
  item('smd_kit', 'SMD component reel', 'component', 3, '#5b6470', ['smd', 'smd kit', 'smd components', 'passives', 'components', 'reels', 'reel']),
  item('soc_phone', 'Phone SoC', 'component', 85, '#1d1f24', ['phone soc', 'soc', 'chip', 'phone chip', 'processor', 'a-series chip']),
  item('soc_watch', 'Watch SoC', 'component', 28, '#2a2d34', ['watch soc', 'watch chip', 's-series chip']),
  item('wifi_mcu', 'Wi-Fi MCU', 'component', 2.5, '#3c4a5c', ['wifi', 'wi-fi', 'mcu', 'wifi mcu', 'wifi module', 'microcontroller', 'kettle chip']),
  item('battery_phone', 'Phone battery', 'component', 9, '#6bbf59', ['phone battery', 'battery', 'batteries', 'li-ion cell']),
  item('battery_watch', 'Watch battery', 'component', 4, '#8fd17d', ['watch battery', 'watch cell']),
  item('display_phone', 'Phone OLED display', 'component', 55, '#2b7de9', ['phone display', 'display', 'displays', 'oled', 'screen', 'screens', 'phone screen']),
  item('display_watch', 'Watch OLED display', 'component', 22, '#5aa2f0', ['watch display', 'watch screen', 'watch oled']),
  item('camera_module', 'Camera module', 'component', 18, '#40444c', ['camera', 'cameras', 'camera module']),
  item('heating_element', 'Heating element', 'component', 5, '#e2652b', ['heating element', 'heater', 'heaters', 'element', 'elements']),
  // Ceramics intermediates.
  item('greenware_mug', 'Greenware mug', 'part', 0, '#bba184', ['greenware', 'greenware mug', 'raw mug', 'unfired mug']),
  item('bisque_mug', 'Bisque mug', 'part', 0, '#e7d2b5', ['bisque', 'bisque mug']),
  item('glazed_mug', 'Glazed mug', 'part', 0, '#8ed3e2', ['glazed mug', 'glazed']),
  item('fired_mug', 'Fired mug', 'part', 0, '#f3f1ea', ['fired mug', 'fired mugs']),
  item('mug_qc', 'Inspected mug', 'part', 0, '#ffffff', ['inspected mug', 'mug qc']),
  // Metal and plastic parts.
  item('phone_frame', 'Phone frame', 'part', 0, '#b9c0c8', ['phone frame', 'frame', 'frames', 'chassis']),
  item('anodized_frame', 'Anodized phone frame', 'part', 0, '#7f8fa6', ['anodized frame', 'anodized phone frame']),
  item('watch_case', 'Watch case', 'part', 0, '#c8ced5', ['watch case', 'case', 'cases']),
  item('anodized_case', 'Anodized watch case', 'part', 0, '#9a8fb3', ['anodized case', 'anodized watch case']),
  item('kettle_body', 'Kettle body', 'part', 0, '#a7b1ba', ['kettle body', 'body', 'bodies']),
  item('kettle_housing', 'Kettle housing', 'part', 0, '#f2efe6', ['kettle housing', 'housing', 'base', 'kettle base', 'handle']),
  item('watch_strap', 'Watch strap', 'part', 0, '#e0567a', ['watch strap', 'strap', 'straps', 'band', 'bands']),
  // Assembled units through the test/QA/pack stages.
  item('kettle_assembled', 'Kettle (assembled)', 'part', 0, '#d8dde2', ['assembled kettle']),
  item('kettle_tested', 'Kettle (tested)', 'part', 0, '#d8dde2', ['tested kettle']),
  item('kettle_qc', 'Kettle (QA passed)', 'part', 0, '#e8edf2', ['inspected kettle', 'kettle qc']),
  item('watch_assembled', 'Watch (assembled)', 'part', 0, '#9a8fb3', ['assembled watch']),
  item('watch_tested', 'Watch (tested)', 'part', 0, '#9a8fb3', ['tested watch']),
  item('watch_qc', 'Watch (QA passed)', 'part', 0, '#b2a7cb', ['inspected watch', 'watch qc']),
  item('phone_assembled', 'Phone (assembled)', 'part', 0, '#7f8fa6', ['assembled phone']),
  item('phone_tested', 'Phone (tested)', 'part', 0, '#7f8fa6', ['tested phone']),
  item('phone_qc', 'Phone (QA passed)', 'part', 0, '#97a7be', ['inspected phone', 'phone qc']),
  // Finished, boxed products. These are what the shipping dock sells.
  item('mug_boxed', 'Ceramic mug', 'product', 18, '#f0b45e', ['mug', 'mugs', 'boxed mug', 'boxed mugs', 'ceramic mug']),
  item('kettle_boxed', 'Smart kettle', 'product', 79, '#ef7d4f', ['kettle', 'kettles', 'smart kettle', 'smart kettles', 'boxed kettle']),
  item('watch_boxed', 'Smartwatch', 'product', 299, '#c77dff', ['watch', 'watches', 'smartwatch', 'smartwatches', 'smart watch', 'boxed watch']),
  item('phone_boxed', 'Smartphone', 'product', 899, '#4cc9f0', ['phone', 'phones', 'smartphone', 'smartphones', 'iphone', 'boxed phone']),
];

// Board stages share one SMT -> reflow -> AOI -> test chain.
interface BoardDef {
  key: string;
  name: string;
  extra: string;
  color: string;
}
const BOARDS: BoardDef[] = [
  { key: 'kettle', name: 'Kettle controller', extra: 'wifi_mcu', color: '#3f9b4b' },
  { key: 'watch', name: 'Watch logic board', extra: 'soc_watch', color: '#2f8f6f' },
  { key: 'phone', name: 'Phone logic board', extra: 'soc_phone', color: '#2e7f8f' },
];
for (const b of BOARDS) {
  ITEM_LIST.push(
    item(`board_${b.key}_placed`, `${b.name} (placed)`, 'part', 0, b.color, [`${b.key} placed board`]),
    item(`board_${b.key}_soldered`, `${b.name} (soldered)`, 'part', 0, b.color, [`${b.key} soldered board`]),
    item(`board_${b.key}_inspected`, `${b.name} (inspected)`, 'part', 0, b.color, [`${b.key} inspected board`]),
    item(`pcba_${b.key}`, `${b.name} PCBA`, 'part', 0, b.color, [`${b.key} pcba`, `${b.key} board`, `${b.key} logic board`]),
  );
}

function recipe(
  id: string,
  name: string,
  machine: string,
  inputs: Record<string, number>,
  outputs: Record<string, number>,
  time: number,
  aliases: string[] = [],
): RecipeDef {
  return { id, name, machine, inputs, outputs, time, aliases };
}

export const RECIPE_LIST: RecipeDef[] = [
  recipe('throw_mug', 'Throw mug', 'potters_wheel', { clay: 1 }, { greenware_mug: 1 }, 6, ['mug', 'throw', 'greenware']),
  recipe('cast_mugs', 'Slip-cast mugs', 'slip_caster', { clay: 3 }, { greenware_mug: 2 }, 5, ['mug', 'cast', 'greenware']),
  recipe('bisque_fire', 'Bisque firing', 'kiln', { greenware_mug: 4 }, { bisque_mug: 4 }, 12, ['bisque', 'bisque fire', 'first firing']),
  recipe('glaze_fire', 'Glaze firing', 'kiln', { glazed_mug: 4 }, { fired_mug: 4 }, 12, ['glaze fire', 'glost', 'second firing', 'final firing']),
  recipe('glaze_mug', 'Glaze mug', 'glazing_station', { bisque_mug: 1, glaze: 1 }, { glazed_mug: 1 }, 2.5, ['glaze', 'mug']),
  recipe('mill_phone_frame', 'Mill phone frame', 'cnc_mill', { aluminum_billet: 1 }, { phone_frame: 1 }, 9, ['phone', 'frame', 'phone frame']),
  recipe('mill_watch_case', 'Mill watch case', 'cnc_mill', { aluminum_billet: 1 }, { watch_case: 2 }, 8, ['watch', 'case', 'watch case']),
  recipe('draw_kettle_body', 'Deep-draw kettle body', 'stamping_press', { steel_sheet: 1 }, { kettle_body: 1 }, 6, ['kettle', 'body', 'kettle body']),
  recipe('mold_kettle_housing', 'Mold kettle housing', 'injection_molder', { plastic_pellets: 2 }, { kettle_housing: 1 }, 5, ['kettle', 'housing', 'kettle housing', 'base']),
  recipe('mold_watch_strap', 'Mold watch straps', 'injection_molder', { plastic_pellets: 1 }, { watch_strap: 2 }, 6, ['watch', 'strap', 'straps', 'watch strap']),
  recipe('anodize_frame', 'Anodize phone frames', 'anodizing_tank', { phone_frame: 2 }, { anodized_frame: 2 }, 10, ['phone', 'frame', 'phone frame']),
  recipe('anodize_case', 'Anodize watch cases', 'anodizing_tank', { watch_case: 2 }, { anodized_case: 2 }, 8, ['watch', 'case', 'watch case']),
  recipe(
    'assemble_kettle',
    'Assemble smart kettle',
    'assembly',
    { kettle_body: 1, kettle_housing: 1, heating_element: 1, pcba_kettle: 1 },
    { kettle_assembled: 1 },
    8,
    ['kettle', 'smart kettle'],
  ),
  recipe(
    'assemble_watch',
    'Assemble smartwatch',
    'assembly',
    { anodized_case: 1, watch_strap: 1, pcba_watch: 1, display_watch: 1, battery_watch: 1 },
    { watch_assembled: 1 },
    9,
    ['watch', 'smartwatch'],
  ),
  recipe(
    'assemble_phone',
    'Assemble smartphone',
    'assembly',
    { anodized_frame: 1, pcba_phone: 1, display_phone: 1, battery_phone: 1, camera_module: 1 },
    { phone_assembled: 1 },
    10,
    ['phone', 'smartphone', 'iphone'],
  ),
  recipe('test_kettle', 'Kettle safety test (hi-pot + boil)', 'test_bench', { kettle_assembled: 1 }, { kettle_tested: 1 }, 5, ['kettle', 'safety', 'hipot']),
  recipe('test_watch', 'Watch functional test', 'test_bench', { watch_assembled: 1 }, { watch_tested: 1 }, 5, ['watch', 'functional']),
  recipe('test_phone', 'Phone functional test', 'test_bench', { phone_assembled: 1 }, { phone_tested: 1 }, 6, ['phone', 'functional']),
  recipe('qa_mug', 'Mug final QA', 'qa', { fired_mug: 1 }, { mug_qc: 1 }, 1.5, ['mug', 'mugs']),
  recipe('qa_kettle', 'Kettle final QA', 'qa', { kettle_tested: 1 }, { kettle_qc: 1 }, 3, ['kettle']),
  recipe('qa_watch', 'Watch final QA', 'qa', { watch_tested: 1 }, { watch_qc: 1 }, 3, ['watch']),
  recipe('qa_phone', 'Phone final QA', 'qa', { phone_tested: 1 }, { phone_qc: 1 }, 3, ['phone']),
  recipe('pack_mug', 'Box mugs', 'packaging', { mug_qc: 1, carton: 1 }, { mug_boxed: 1 }, 2, ['mug', 'mugs']),
  recipe('pack_kettle', 'Box smart kettles', 'packaging', { kettle_qc: 1, carton: 1 }, { kettle_boxed: 1 }, 3, ['kettle', 'kettles']),
  recipe('pack_watch', 'Box smartwatches', 'packaging', { watch_qc: 1, carton: 1 }, { watch_boxed: 1 }, 3, ['watch', 'watches']),
  recipe('pack_phone', 'Box smartphones', 'packaging', { phone_qc: 1, carton: 1 }, { phone_boxed: 1 }, 3, ['phone', 'phones']),
];

for (const b of BOARDS) {
  const k = b.key;
  RECIPE_LIST.push(
    recipe(`smt_${k}`, `Place ${b.name.toLowerCase()}`, 'smt_line', { pcb_blank: 1, smd_kit: 1, [b.extra]: 1 }, { [`board_${k}_placed`]: 1 }, 5, [k]),
    recipe(`reflow_${k}`, `Reflow ${b.name.toLowerCase()}`, 'reflow_oven', { [`board_${k}_placed`]: 1 }, { [`board_${k}_soldered`]: 1 }, 5, [k]),
    recipe(`aoi_${k}`, `Inspect ${b.name.toLowerCase()}`, 'aoi', { [`board_${k}_soldered`]: 1 }, { [`board_${k}_inspected`]: 1 }, 3, [k]),
    recipe(`ict_${k}`, `Test ${b.name.toLowerCase()}`, 'pcb_test', { [`board_${k}_inspected`]: 1 }, { [`pcba_${k}`]: 1 }, 4, [k]),
  );
}

function machine(def: Omit<MachineDef, 'recipes' | 'capacity' | 'receives'> & Partial<Pick<MachineDef, 'capacity' | 'receives'>>): MachineDef {
  return {
    capacity: 0,
    receives: false,
    ...def,
    recipes: RECIPE_LIST.filter((r) => r.machine === def.id).map((r) => r.id),
  };
}

export const MACHINE_LIST: MachineDef[] = [
  machine({
    id: 'receiving_dock', short: 'dock', name: 'Receiving dock', category: 'logistics', role: 'storage',
    w: 4, h: 3, cost: 6000, power: 4, capacity: 1000, receives: true,
    aliases: ['receiving dock', 'receiving', 'dock', 'loading dock', 'intake', 'receiving bay'],
    description: 'Trucks deliver purchased materials here. Dispatches stock to connected machines.',
  }),
  machine({
    id: 'warehouse', short: 'warehouse', name: 'Warehouse', category: 'logistics', role: 'storage',
    w: 4, h: 4, cost: 10000, power: 2, capacity: 4000,
    aliases: ['warehouse', 'storage', 'store', 'stockroom', 'rack', 'racks'],
    description: 'Adds stock capacity. Accepts any output and dispatches stock to connected machines.',
  }),
  machine({
    id: 'shipping_dock', short: 'shipping', name: 'Shipping dock', category: 'logistics', role: 'shipping',
    w: 4, h: 3, cost: 6000, power: 4,
    aliases: ['shipping dock', 'shipping', 'ship', 'outbound', 'outbound dock', 'shipping bay'],
    description: 'Boxed products delivered here are shipped and sold (open orders pay a premium).',
  }),
  machine({
    id: 'substation', short: 'substation', name: 'Substation', category: 'power', role: 'power',
    w: 2, h: 2, cost: 15000, power: 0, capacity: 400,
    aliases: ['substation', 'transformer', 'power', 'power station', 'generator'],
    description: 'Adds 400 kW to the factory power budget.',
  }),
  machine({
    id: 'potters_wheel', short: 'wheel', name: "Potter's wheel", category: 'ceramics', role: 'process',
    w: 2, h: 2, cost: 2500, power: 2,
    aliases: ["potter's wheel", 'potters wheel', 'pottery wheel', 'wheel'],
    description: 'Throws one greenware mug at a time from clay. Cheap and slow.',
  }),
  machine({
    id: 'slip_caster', short: 'caster', name: 'Slip caster', category: 'ceramics', role: 'process',
    w: 3, h: 2, cost: 8000, power: 6,
    aliases: ['slip caster', 'slip casting', 'slip casting station', 'caster', 'casting', 'mold station'],
    description: 'Casts greenware mugs from liquid clay slip in plaster molds.',
  }),
  machine({
    id: 'kiln', short: 'kiln', name: 'Kiln', category: 'ceramics', role: 'process',
    w: 3, h: 3, cost: 14000, power: 60,
    aliases: ['kiln', 'kilns', 'furnace'],
    description: 'Fires ceramics in batches of four: bisque firing or glaze firing.',
  }),
  machine({
    id: 'glazing_station', short: 'glazing', name: 'Glazing station', category: 'ceramics', role: 'process',
    w: 2, h: 2, cost: 4500, power: 3,
    aliases: ['glazing station', 'glazing', 'glaze station', 'glazer', 'spray booth'],
    description: 'Dips bisque mugs in glaze.',
  }),
  machine({
    id: 'cnc_mill', short: 'cnc', name: 'CNC mill', category: 'metal', role: 'process',
    w: 3, h: 3, cost: 42000, power: 30,
    aliases: ['cnc mill', 'cnc', 'mill', 'milling machine', 'machining center', '5-axis'],
    description: 'Machines aluminum billet into phone frames or watch cases.',
  }),
  machine({
    id: 'stamping_press', short: 'press', name: 'Deep-draw press', category: 'metal', role: 'process',
    w: 3, h: 3, cost: 30000, power: 40,
    aliases: ['stamping press', 'deep draw press', 'deep-draw press', 'press', 'stamper', 'stamping'],
    description: 'Deep-draws stainless sheet into seamless kettle bodies.',
  }),
  machine({
    id: 'injection_molder', short: 'molder', name: 'Injection molder', category: 'plastics', role: 'process',
    w: 3, h: 2, cost: 24000, power: 25,
    aliases: ['injection molder', 'injection moulder', 'injection molding', 'molder', 'moulder', 'injection'],
    description: 'Molds plastic pellets into kettle housings or watch straps.',
  }),
  machine({
    id: 'anodizing_tank', short: 'anodizer', name: 'Anodizing tank', category: 'metal', role: 'process',
    w: 4, h: 2, cost: 18000, power: 15,
    aliases: ['anodizing tank', 'anodizing', 'anodizer', 'anodiser', 'anodize', 'tank'],
    description: 'Anodizes aluminum frames and cases for color and hardness.',
  }),
  machine({
    id: 'smt_line', short: 'smt', name: 'SMT pick-and-place', category: 'electronics', role: 'process',
    w: 5, h: 2, cost: 65000, power: 12,
    aliases: ['smt line', 'smt', 'pick and place', 'pick-and-place', 'pnp', 'smt machine', 'chip shooter'],
    description: 'Prints solder paste and places SMD parts and the SoC onto bare PCBs.',
  }),
  machine({
    id: 'reflow_oven', short: 'reflow', name: 'Reflow oven', category: 'electronics', role: 'process',
    w: 4, h: 2, cost: 28000, power: 45,
    aliases: ['reflow oven', 'reflow', 'oven', 'solder oven'],
    description: 'Melts solder paste to bond placed parts.',
  }),
  machine({
    id: 'aoi', short: 'aoi', name: 'AOI inspection', category: 'electronics', role: 'process',
    w: 2, h: 2, cost: 22000, power: 3,
    aliases: ['aoi', 'aoi inspection', 'optical inspection', 'automated optical inspection', 'inspection'],
    description: 'Automated optical inspection of soldered boards.',
  }),
  machine({
    id: 'pcb_test', short: 'pcbtest', name: 'PCB test (ICT)', category: 'electronics', role: 'process',
    w: 2, h: 2, cost: 16000, power: 4,
    aliases: ['pcb test', 'pcb tester', 'ict', 'in-circuit test', 'board test', 'flying probe'],
    description: 'In-circuit test and firmware flash; outputs finished PCBAs.',
  }),
  machine({
    id: 'assembly', short: 'assembly', name: 'Final assembly', category: 'assembly', role: 'process',
    w: 3, h: 3, cost: 12000, power: 5,
    aliases: ['final assembly', 'assembly station', 'assembly', 'assembler', 'assembly cell'],
    description: 'Final assembly of kettles, watches and phones.',
  }),
  machine({
    id: 'test_bench', short: 'testbench', name: 'Test bench', category: 'assembly', role: 'process',
    w: 3, h: 2, cost: 14000, power: 6,
    aliases: ['test bench', 'testbench', 'functional test', 'safety test', 'tester', 'test station', 'hipot'],
    description: 'Functional and electrical-safety tests of assembled units.',
  }),
  machine({
    id: 'qa', short: 'qa', name: 'QA station', category: 'assembly', role: 'process',
    w: 2, h: 2, cost: 6000, power: 2,
    aliases: ['qa', 'qa station', 'quality', 'quality assurance', 'qc', 'quality control', 'final qa'],
    description: 'Final cosmetic and quality inspection.',
  }),
  machine({
    id: 'packaging', short: 'packaging', name: 'Packaging', category: 'assembly', role: 'process',
    w: 3, h: 2, cost: 9000, power: 4,
    aliases: ['packaging', 'packaging station', 'packer', 'packing', 'boxing', 'box line', 'pack'],
    description: 'Boxes finished products in cartons, ready to ship.',
  }),
];

export const ITEMS: Record<string, ItemDef> = Object.fromEntries(ITEM_LIST.map((i) => [i.id, i]));
export const RECIPES: Record<string, RecipeDef> = Object.fromEntries(RECIPE_LIST.map((r) => [r.id, r]));
export const MACHINES: Record<string, MachineDef> = Object.fromEntries(MACHINE_LIST.map((m) => [m.id, m]));

/** Products you can sell, in the order they unlock in difficulty. */
export const PRODUCTS = ['mug_boxed', 'kettle_boxed', 'watch_boxed', 'phone_boxed'];

export const CATEGORY_COLORS: Record<MachineCategory, string> = {
  logistics: '#59636e',
  ceramics: '#a45a3d',
  metal: '#4f7192',
  plastics: '#2c8679',
  electronics: '#3a7a3f',
  assembly: '#8a4f7d',
  power: '#5a56b0',
};

export function isBuyable(itemId: string): boolean {
  const def = ITEMS[itemId];
  return !!def && (def.kind === 'raw' || def.kind === 'component');
}

// Plain-JSON game state. Everything here must survive JSON.stringify/parse unchanged.

export const SAVE_VERSION = 1;
export const TICK_SECONDS = 0.1;
export const WORLD_W = 120;
export const WORLD_H = 80;
export const START_CASH = 500_000;
export const BASE_POWER_KW = 400;
export const BASE_STOCK_CAPACITY = 500;
/** Tiles per simulated second. */
export const BELT_SPEED = 2.5;
/** Minimum gap between items on a belt, in tiles. */
export const BELT_SPACING = 0.5;
export const STANDBY_POWER = 0.1;

export type MachineStatus = 'idle' | 'working' | 'starved' | 'blocked' | 'ready';

export interface Machine {
  id: string;
  type: string;
  /** Top-left tile of the footprint. */
  x: number;
  y: number;
  recipe: string | null;
  input: Record<string, number>;
  output: Record<string, number>;
  /** Seconds into the current cycle. */
  progress: number;
  running: boolean;
  status: MachineStatus;
  cycles: number;
  line: string | null;
}

export interface BeltItem {
  id: number;
  item: string;
  /** Distance travelled along the belt, 0..length tiles. */
  pos: number;
}

export interface Belt {
  id: string;
  from: string;
  to: string;
  /** Flat tile list [x0, y0, x1, y1, ...] from the tile next to `from` to the tile next to `to`. */
  path: number[];
  /** Items ordered front (largest pos) first. */
  items: BeltItem[];
}

export interface Order {
  id: string;
  item: string;
  qty: number;
  filled: number;
  /** Price per unit while the order is open. */
  price: number;
  expiresAt: number;
}

export interface Line {
  id: string;
  name: string;
  blueprint: string;
}

export interface HistoryPoint {
  t: number;
  cash: number;
  revenue: number;
  shipped: number;
}

export interface Stats {
  produced: Record<string, number>;
  shipped: Record<string, number>;
  revenue: number;
  spent: number;
}

export interface GameState {
  version: number;
  name: string;
  rng: number;
  tick: number;
  /** Simulated seconds since the game started. */
  time: number;
  /** Simulation steps per engine tick; 0 means paused. */
  speed: number;
  width: number;
  height: number;
  cash: number;
  machines: Machine[];
  belts: Belt[];
  stock: Record<string, number>;
  autobuy: boolean;
  orders: Order[];
  nextOrderAt: number;
  lines: Line[];
  stats: Stats;
  history: HistoryPoint[];
  power: { capacity: number; demand: number; satisfaction: number };
  counters: { item: number; belt: number; order: number; line: number };
}

export function createState(name = 'factory', seed = 0x5107_7a11): GameState {
  return {
    version: SAVE_VERSION,
    name,
    rng: seed >>> 0,
    tick: 0,
    time: 0,
    speed: 1,
    width: WORLD_W,
    height: WORLD_H,
    cash: START_CASH,
    machines: [],
    belts: [],
    stock: {},
    autobuy: false,
    orders: [],
    nextOrderAt: 20,
    lines: [],
    stats: { produced: {}, shipped: {}, revenue: 0, spent: 0 },
    history: [],
    power: { capacity: BASE_POWER_KW, demand: 0, satisfaction: 1 },
    counters: { item: 0, belt: 0, order: 0, line: 0 },
  };
}

/** mulberry32: small deterministic RNG whose whole state lives in the save. */
export function random(state: GameState): number {
  state.rng = (state.rng + 0x6d2b79f5) >>> 0;
  let t = state.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function add(bag: Record<string, number>, item: string, qty: number): void {
  const next = (bag[item] ?? 0) + qty;
  if (next <= 0) delete bag[item];
  else bag[item] = next;
}

export function count(bag: Record<string, number>, item: string): number {
  return bag[item] ?? 0;
}

export function total(bag: Record<string, number>): number {
  let n = 0;
  for (const k in bag) n += bag[k];
  return n;
}

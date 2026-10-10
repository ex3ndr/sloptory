// Wire protocol between the engine (server) and the web interface.

import type { Camera } from '../game/api.ts';
import type { ItemKind, MachineCategory, MachineRole } from '../engine/catalog.ts';
import type { Line, MachineStatus, Order } from '../engine/state.ts';

export const TILE_PX = 24;
export const SNAPSHOT_EVERY_TICKS = 2;
/** Screen space (px) covered by HUD panels, used to frame camera focus. */
export const VIEW_INSETS = { left: 16, right: 330, top: 64, bottom: 250 };

export interface CatalogView {
  items: { id: string; name: string; kind: ItemKind; price: number; color: string }[];
  machines: {
    id: string;
    name: string;
    short: string;
    category: MachineCategory;
    role: MachineRole;
    w: number;
    h: number;
    cost: number;
    power: number;
    color: string;
  }[];
  recipes: { id: string; name: string; machine: string; inputs: Record<string, number>; outputs: Record<string, number>; time: number }[];
}

export interface MachineView {
  id: string;
  /** Custom name, if one was given. */
  name: string | null;
  type: string;
  x: number;
  y: number;
  recipe: string | null;
  status: MachineStatus;
  /** 0..1 through the current cycle. */
  progress: number;
  input: Record<string, number>;
  output: Record<string, number>;
  line: string | null;
}

export interface BeltView {
  id: string;
  from: string;
  to: string;
  path: number[];
  /** Flat triples: [itemUid, pos (tiles), itemIndex into catalog.items, ...]. */
  items: number[];
}

export interface Snapshot {
  t: 'state';
  name: string;
  tick: number;
  time: number;
  speed: number;
  cash: number;
  autobuy: boolean;
  world: { w: number; h: number };
  power: { capacity: number; demand: number; satisfaction: number };
  stock: Record<string, number>;
  stockCap: number;
  machines: MachineView[];
  belts: BeltView[];
  orders: Order[];
  lines: Line[];
  shipped: Record<string, number>;
  revenue: number;
  spent: number;
  /** Revenue and units shipped over the last simulated minute. */
  perMinute: { revenue: number; shipped: number };
}

/** tool: live progress while an agent works. */
export type LogKind = 'player' | 'agent' | 'system' | 'error' | 'tool';

export interface LogEntry {
  id: number;
  kind: LogKind;
  text: string;
  time: number;
  /** Which agent produced an agent reply ("parser" or the LLM name). */
  via?: string;
}

export type ServerMessage =
  | { t: 'hello'; clientId: string; catalog: CatalogView; camera: Camera; log: LogEntry[]; agent: string }
  | Snapshot
  | { t: 'log'; entries: LogEntry[] }
  | { t: 'camera'; camera: Camera }
  | { t: 'busy'; busy: boolean };

export type ClientMessage =
  | { t: 'cmd'; text: string }
  | { t: 'viewport'; w: number; h: number }
  /** The client moved its own camera (mouse/keyboard); the server keeps it for text commands. */
  | { t: 'camera'; camera: Camera };

// The single running game: owns the state, executes commands, saves and loads.

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBlueprint } from '../engine/blueprints.ts';
import { CATEGORY_COLORS, ITEM_LIST, MACHINE_LIST, RECIPE_LIST, isBuyable } from '../engine/catalog.ts';
import { buy, money, sellStock, type SimEvent } from '../engine/economy.ts';
import { connect, disconnect, moveMachine, placeMachine, removeMachine, setRecipe } from '../engine/ops.ts';
import {
  resolveBlueprint,
  resolveFocus,
  resolveItem,
  resolveMachine,
  resolveMachineType,
  resolveRecipe,
} from '../engine/resolve.ts';
import { deserialize, sanitizeSaveName, serialize } from '../engine/save.ts';
import { step } from '../engine/sim.ts';
import { count, createState, type GameState } from '../engine/state.ts';
import { contentBounds, findFreeSpot, stockCapacity, type Rect } from '../engine/world.ts';
import { TILE_PX, VIEW_INSETS, type CatalogView, type LogEntry, type LogKind, type Snapshot } from '../shared/protocol.ts';
import type { Camera, ClientView, Command, CommandResult } from './api.ts';
import {
  HELP,
  blueprintsReport,
  catalogReport,
  linesReport,
  machineReport,
  machinesReport,
  ordersReport,
  perMinute,
  powerReport,
  recipesReport,
  statusReport,
  stockReport,
} from './report.ts';

export const MIN_ZOOM = 0.3;
export const MAX_ZOOM = 3;
const ITEM_INDEX: Record<string, number> = Object.fromEntries(ITEM_LIST.map((it, i) => [it.id, i]));
const SPEEDS = [0, 1, 2, 4, 8];

export interface GameOptions {
  savesDir: string;
  /** Called when the whole world is replaced (new game / load) so views can reset. */
  onReset?: () => void;
  onLog?: (entry: LogEntry) => void;
}

const ok = (message: string): CommandResult => ({ ok: true, message });
const err = (message: string): CommandResult => ({ ok: false, message });

export function defaultCamera(state: GameState, viewport = { w: 1280, h: 800 }): Camera {
  const r = contentBounds(state);
  if (!r) return { x: 30, y: 20, zoom: 1 };
  return fitCamera(r, viewport);
}

/** Camera that fits a rect into the part of the screen not covered by the HUD panels. */
export function fitCamera(r: Rect, viewport: { w: number; h: number }, pad = 3): Camera {
  const i = VIEW_INSETS;
  const w = Math.max(320, viewport.w - i.left - i.right);
  const h = Math.max(200, viewport.h - i.top - i.bottom);
  const zoom = clamp(Math.min(w / ((r.w + pad * 2) * TILE_PX), h / ((r.h + pad * 2) * TILE_PX)), MIN_ZOOM, 2.2);
  // Shift so the rect sits in the middle of the free area rather than the screen.
  const dx = (i.right - i.left) / 2 / (TILE_PX * zoom);
  const dy = (i.bottom - i.top) / 2 / (TILE_PX * zoom);
  return { x: r.x + r.w / 2 + dx, y: r.y + r.h / 2 + dy, zoom };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

export class Game {
  state: GameState;
  readonly savesDir: string;
  readonly log: LogEntry[] = [];
  private logId = 0;
  private resumeSpeed = 1;
  private onReset?: () => void;
  private onLog?: (entry: LogEntry) => void;

  constructor(opts: GameOptions) {
    this.savesDir = opts.savesDir;
    this.onReset = opts.onReset;
    this.onLog = opts.onLog;
    this.state = createState();
  }

  setListeners(onReset: () => void, onLog: (entry: LogEntry) => void): void {
    this.onReset = onReset;
    this.onLog = onLog;
  }

  addLog(kind: LogKind, text: string, via?: string): LogEntry {
    const entry: LogEntry = { id: ++this.logId, kind, text, time: this.state.time, via };
    this.log.push(entry);
    if (this.log.length > 300) this.log.splice(0, this.log.length - 300);
    this.onLog?.(entry);
    return entry;
  }

  /** Advances the simulation by one engine tick (state.speed fixed steps). */
  tick(): SimEvent[] {
    const events: SimEvent[] = [];
    for (let i = 0; i < this.state.speed; i++) events.push(...step(this.state));
    for (const e of events) this.addLog('system', e.text);
    return events;
  }

  exec(cmd: Command, view: ClientView): CommandResult {
    try {
      return this.execUnsafe(cmd, view);
    } catch (e) {
      return err(`Engine error: ${(e as Error).message}`);
    }
  }

  private execUnsafe(cmd: Command, view: ClientView): CommandResult {
    const s = this.state;
    switch (cmd.op) {
      case 'help':
        return ok(HELP);
      case 'place': {
        const def = resolveMachineType(cmd.machine);
        if (!def) return err(`I don't know a machine called "${cmd.machine}". Try "catalog".`);
        let recipe: string | undefined;
        if (cmd.recipe) {
          const r = resolveRecipe(cmd.recipe, def);
          if (!r) return err(`${def.name} has no recipe like "${cmd.recipe}". Options: ${def.recipes.join(', ') || 'none'}.`);
          recipe = r.id;
        }
        const n = Math.max(1, Math.min(10, Math.floor(cmd.count ?? 1)));
        const messages: string[] = [];
        for (let i = 0; i < n; i++) {
          let x = cmd.x;
          let y = cmd.y;
          if (x === undefined || y === undefined || i > 0) {
            const hint = x !== undefined && y !== undefined ? { x, y } : { x: view.camera.x, y: view.camera.y };
            const spot = findFreeSpot(s, def.w, def.h, hint, 1);
            if (!spot) return err(`No free space for a ${def.name.toLowerCase()}.`);
            x = spot.x;
            y = spot.y;
          }
          const r = placeMachine(s, def.id, x, y, { recipe });
          if (!r.ok) return { ok: messages.length > 0, message: [...messages, r.message].join('\n') };
          messages.push(r.message);
        }
        return ok(messages.join('\n'));
      }
      case 'remove': {
        const ref = resolveMachine(s, cmd.target);
        if ('error' in ref) return err(ref.error);
        return removeMachine(s, ref.machine.id);
      }
      case 'move': {
        const ref = resolveMachine(s, cmd.target);
        if ('error' in ref) return err(ref.error);
        return moveMachine(s, ref.machine.id, cmd.x, cmd.y);
      }
      case 'connect': {
        const a = resolveMachine(s, cmd.from);
        if ('error' in a) return err(a.error);
        const b = resolveMachine(s, cmd.to);
        if ('error' in b) return err(b.error);
        return connect(s, a.machine.id, b.machine.id);
      }
      case 'disconnect': {
        const a = resolveMachine(s, cmd.from);
        if ('error' in a) return err(a.error);
        let to: string | undefined;
        if (cmd.to) {
          const b = resolveMachine(s, cmd.to);
          if ('error' in b) return err(b.error);
          to = b.machine.id;
        }
        return disconnect(s, a.machine.id, to);
      }
      case 'set_recipe': {
        const ref = resolveMachine(s, cmd.target);
        if ('error' in ref) return err(ref.error);
        const def = resolveMachineType(ref.machine.type)!;
        if (/^(none|nothing|off|stop|clear)$/i.test(cmd.recipe.trim())) return setRecipe(s, ref.machine.id, null);
        const r = resolveRecipe(cmd.recipe, def);
        if (!r) return err(`${def.name} can't make "${cmd.recipe}". Options: ${def.recipes.join(', ') || 'none'}.`);
        return setRecipe(s, ref.machine.id, r.id);
      }
      case 'buy': {
        const it = resolveItem(cmd.item, (i) => isBuyable(i.id));
        if (!it) {
          const other = resolveItem(cmd.item);
          if (other) return err(`${other.name} is produced in the factory, not bought from suppliers.`);
          return err(`No supplier sells "${cmd.item}". Buyable: ${ITEM_LIST.filter((i) => isBuyable(i.id)).map((i) => i.id).join(', ')}.`);
        }
        return buy(s, it.id, cmd.qty);
      }
      case 'sell': {
        const it = resolveItem(cmd.item, (i) => count(s.stock, i.id) > 0) ?? resolveItem(cmd.item);
        if (!it) return err(`Unknown item "${cmd.item}".`);
        const events: SimEvent[] = [];
        const r = sellStock(s, it.id, cmd.qty === 'all' ? count(s.stock, it.id) : cmd.qty, events);
        for (const e of events) this.addLog('system', e.text);
        return r;
      }
      case 'blueprint': {
        const bp = resolveBlueprint(cmd.name);
        if (!bp) return err(`No blueprint for "${cmd.name}". ${blueprintsReport()}`);
        const at = cmd.x !== undefined && cmd.y !== undefined ? { x: Math.floor(cmd.x), y: Math.floor(cmd.y) } : undefined;
        const r = buildBlueprint(s, bp.id, at);
        if (r.ok && r.lineId) {
          const ms = s.machines.filter((m) => m.line === r.lineId);
          view.camera = fitCamera(contentBounds(s, ms)!, view.viewport);
        }
        return r;
      }
      case 'query':
        return this.query(cmd.what, cmd.target);
      case 'camera':
        return this.camera(cmd, view);
      case 'speed': {
        const v = SPEEDS.reduce((best, x) => (Math.abs(x - cmd.value) < Math.abs(best - cmd.value) ? x : best), 1);
        if (v > 0) this.resumeSpeed = v;
        s.speed = v;
        return ok(v === 0 ? 'Paused. Say "resume" to continue.' : `Simulation speed ${v}×.`);
      }
      case 'resume':
        s.speed = s.speed || this.resumeSpeed;
        return ok(`Running at ${s.speed}×.`);
      case 'autobuy':
        s.autobuy = cmd.on;
        return ok(cmd.on ? 'Auto-buy on: purchased inputs are kept topped up while cash lasts.' : 'Auto-buy off.');
      case 'new_game': {
        this.autosave();
        const name = (cmd.name && sanitizeSaveName(cmd.name)) || 'factory';
        this.state = createState(name, (Date.now() >>> 0) ^ 0x9e3779b9);
        this.resumeSpeed = 1;
        this.onReset?.();
        return ok(`New game "${name}" started with ${money(this.state.cash)}. (Previous game autosaved.) Try "build a mug line".`);
      }
      case 'save': {
        const name = sanitizeSaveName(cmd.name ?? '') ?? (s.name === 'autosave' ? 'quicksave' : s.name);
        this.writeSave(name);
        s.name = name;
        return ok(`Saved as "${name}" at T+${Math.floor(s.time)}s.`);
      }
      case 'load': {
        const name = sanitizeSaveName(cmd.name);
        if (!name) return err('Load which save? Say "saves" to list them.');
        let loaded: GameState;
        try {
          loaded = deserialize(readFileSync(this.savePath(name), 'utf8'));
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          return err(code === 'ENOENT' ? `No save called "${name}". ${this.savesText()}` : `Could not load "${name}": ${(e as Error).message}`);
        }
        if (name !== 'autosave') this.autosave();
        this.state = loaded;
        if (name !== 'autosave') this.state.name = name;
        this.onReset?.();
        return ok(`Loaded "${name}": T+${Math.floor(loaded.time)}s, ${money(loaded.cash)}, ${loaded.machines.length} machines.`);
      }
      case 'list_saves':
        return ok(this.savesText());
    }
  }

  private query(what: string, target?: string): CommandResult {
    const s = this.state;
    switch (what) {
      case 'status':
        return ok(statusReport(s));
      case 'machines':
        return ok(machinesReport(s));
      case 'machine': {
        const ref = resolveMachine(s, target ?? '');
        if ('error' in ref) return err(ref.error);
        return ok(machineReport(s, ref.machine));
      }
      case 'stock':
        return ok(stockReport(s));
      case 'orders':
        return ok(ordersReport(s));
      case 'recipes': {
        if (!target) return ok(recipesReport());
        const def = resolveMachineType(target);
        if (def) return ok(recipesReport(def));
        const it = resolveItem(target);
        if (it) {
          const makers = RECIPE_LIST.filter((r) => it.id in r.outputs);
          const users = RECIPE_LIST.filter((r) => it.id in r.inputs);
          return ok(
            `${it.name}: made by ${makers.map((r) => `${r.machine} (${r.name})`).join(', ') || 'suppliers (buy it)'}; used by ${users.map((r) => `${r.machine} (${r.name})`).join(', ') || 'nobody — sell it'}.`,
          );
        }
        return err(`No machine or item called "${target}".`);
      }
      case 'catalog':
        return ok(catalogReport());
      case 'blueprints':
        return ok(blueprintsReport());
      case 'power':
        return ok(powerReport(s));
      case 'lines':
        return ok(linesReport(s));
      default:
        return err(`Unknown query "${what}".`);
    }
  }

  private camera(cmd: Extract<Command, { op: 'camera' }>, view: ClientView): CommandResult {
    const c = view.camera;
    const s = this.state;
    switch (cmd.action) {
      case 'pan': {
        c.x = clamp(c.x + (cmd.dx ?? 0), 0, s.width);
        c.y = clamp(c.y + (cmd.dy ?? 0), 0, s.height);
        return ok(`View centered on ${Math.round(c.x)},${Math.round(c.y)}.`);
      }
      case 'center': {
        c.x = clamp(cmd.x ?? c.x, 0, s.width);
        c.y = clamp(cmd.y ?? c.y, 0, s.height);
        return ok(`View centered on ${Math.round(c.x)},${Math.round(c.y)}.`);
      }
      case 'zoom': {
        const z = cmd.level ?? c.zoom * (cmd.factor ?? 1.5);
        c.zoom = clamp(z, MIN_ZOOM, MAX_ZOOM);
        return ok(`Zoom ${c.zoom.toFixed(2)}×.`);
      }
      case 'focus': {
        const f = resolveFocus(s, cmd.target ?? '');
        if (!f) return err(`Can't find "${cmd.target}" on the floor.`);
        view.camera = fitCamera(f.rect, view.viewport, f.rect.w < 6 ? 6 : 4);
        if (f.rect.w < 6) view.camera.zoom = Math.max(view.camera.zoom, 1.4);
        view.camera.zoom = Math.min(view.camera.zoom, 2.2);
        return ok(`Looking at ${f.label}.`);
      }
      case 'overview': {
        const r = contentBounds(s) ?? { x: 0, y: 0, w: s.width, h: s.height };
        view.camera = fitCamera(r, view.viewport);
        return ok(s.machines.length ? 'Showing the whole factory.' : 'The floor is empty.');
      }
    }
  }

  // ---- persistence ----

  savePath(name: string): string {
    return join(this.savesDir, `${name}.json`);
  }

  private writeSave(name: string): void {
    mkdirSync(this.savesDir, { recursive: true });
    const path = this.savePath(name);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, serialize(this.state));
    renameSync(tmp, path);
  }

  autosave(): void {
    if (this.state.tick === 0 && this.state.machines.length === 0) return;
    try {
      this.writeSave('autosave');
    } catch (e) {
      console.error('autosave failed:', (e as Error).message);
    }
  }

  /** Resume the autosave if there is one. Returns true if a save was loaded. */
  resumeAutosave(): boolean {
    try {
      this.state = deserialize(readFileSync(this.savePath('autosave'), 'utf8'));
      return true;
    } catch {
      return false;
    }
  }

  listSaves(): { name: string; savedAt: string; time: number; cash: number }[] {
    let files: string[] = [];
    try {
      files = readdirSync(this.savesDir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const out: { name: string; savedAt: string; time: number; cash: number }[] = [];
    for (const f of files) {
      try {
        const st = deserialize(readFileSync(join(this.savesDir, f), 'utf8'));
        out.push({ name: f.slice(0, -5), savedAt: statSync(join(this.savesDir, f)).mtime.toISOString(), time: st.time, cash: st.cash });
      } catch {
        // Skip unreadable files.
      }
    }
    return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  private savesText(): string {
    const saves = this.listSaves();
    if (saves.length === 0) return 'No saves yet. Say "save as <name>".';
    return 'Saves: ' + saves.map((x) => `${x.name} (T+${Math.floor(x.time)}s, ${money(x.cash)})`).join(', ');
  }

  // ---- views ----

  snapshot(): Snapshot {
    const s = this.state;
    return {
      t: 'state',
      name: s.name,
      tick: s.tick,
      time: s.time,
      speed: s.speed,
      cash: Math.round(s.cash * 100) / 100,
      autobuy: s.autobuy,
      world: { w: s.width, h: s.height },
      power: s.power,
      stock: s.stock,
      stockCap: stockCapacity(s),
      machines: s.machines.map((m) => {
        const r = m.recipe ? RECIPE_LIST.find((x) => x.id === m.recipe) : undefined;
        return {
          id: m.id,
          type: m.type,
          x: m.x,
          y: m.y,
          recipe: m.recipe,
          status: m.status,
          progress: r && m.running ? Math.min(1, m.progress / r.time) : 0,
          input: m.input,
          output: m.output,
          line: m.line,
        };
      }),
      belts: s.belts.map((b) => {
        const items: number[] = [];
        for (const it of b.items) items.push(it.id, Math.round(it.pos * 100) / 100, ITEM_INDEX[it.item] ?? 0);
        return { id: b.id, from: b.from, to: b.to, path: b.path, items };
      }),
      orders: s.orders,
      lines: s.lines,
      shipped: s.stats.shipped,
      revenue: Math.round(s.stats.revenue),
      spent: Math.round(s.stats.spent),
      perMinute: perMinute(s),
    };
  }

  static catalog(): CatalogView {
    return {
      items: ITEM_LIST.map((i) => ({ id: i.id, name: i.name, kind: i.kind, price: i.price, color: i.color })),
      machines: MACHINE_LIST.map((m) => ({
        id: m.id,
        name: m.name,
        short: m.short,
        category: m.category,
        role: m.role,
        w: m.w,
        h: m.h,
        cost: m.cost,
        power: m.power,
        color: CATEGORY_COLORS[m.category],
      })),
      recipes: RECIPE_LIST.map((r) => ({ id: r.id, name: r.name, machine: r.machine, inputs: r.inputs, outputs: r.outputs, time: r.time })),
    };
  }
}

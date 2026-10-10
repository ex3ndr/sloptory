// The single running game: owns the state, executes commands, saves and loads.

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBlueprint } from '../engine/blueprints.ts';
import { CATEGORY_COLORS, ITEM_LIST, MACHINE_LIST, RECIPE_LIST, isBuyable } from '../engine/catalog.ts';
import { buy, money, sellStock, type SimEvent } from '../engine/economy.ts';
import { connect, disconnect, moveMachine, placeMachine, removeMachine, setRecipe } from '../engine/ops.ts';
import { catalogData, diagnose, findFreeAreas, itemData, renderMap, selectMachines, stateData, summarizeIssues } from '../engine/inspect.ts';
import {
  norm,
  resolveBlueprint,
  resolveFocus,
  resolveItem,
  resolveLine,
  resolveMachine,
  resolveMachineType,
  resolveRecipe,
} from '../engine/resolve.ts';
import { deserialize, sanitizeSaveName, serialize } from '../engine/save.ts';
import { step } from '../engine/sim.ts';
import { count, createState, type GameState, type Machine } from '../engine/state.ts';
import { contentBounds, displayName, findFreeSpot, stockCapacity } from '../engine/world.ts';
import { MAX_ZOOM, MIN_ZOOM, clamp, fitCamera } from '../shared/camera.ts';
import type { CatalogView, LogEntry, LogKind, Snapshot } from '../shared/protocol.ts';
import { BATCH_OPS, type Camera, type ClientView, type Command, type CommandResult } from './api.ts';
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


/** Replaces "@ref" machine references from earlier place ops in the same batch. Returns an error string if one is unknown. */
function substituteRefs(op: Command, refs: Map<string, string>): Command | string {
  const out = { ...op } as Record<string, unknown>;
  const sub = (v: unknown): unknown => {
    if (typeof v !== 'string' || !v.startsWith('@')) return v;
    const id = refs.get(v.slice(1));
    if (!id) throw new Error(`Unknown reference "${v}": no earlier successful place op in this batch had as: "${v.slice(1)}".`);
    return id;
  };
  try {
    for (const key of ['target', 'from', 'to']) if (key in out) out[key] = sub(out[key]);
    if (Array.isArray(out.machines)) out.machines = out.machines.map(sub);
  } catch (e) {
    return (e as Error).message;
  }
  return out as Command;
}

export class Game {
  state: GameState;
  readonly savesDir: string;
  readonly log: LogEntry[] = [];
  private logId = 0;
  /** >0 while a dry run executes on a copy: suppress log output. */
  private quiet = 0;
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
    if (this.quiet > 0) return { id: 0, kind, text, time: this.state.time, via };
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
        const name = cmd.name?.trim().slice(0, 40) || null;
        if (name) {
          if (n > 1) return err('Give each machine its own name; place them one at a time.');
          const clash = this.nameClash(name);
          if (clash) return err(clash);
        }
        const messages: string[] = [];
        const ids: string[] = [];
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
          const r = placeMachine(s, def.id, x, y, { recipe, name });
          if (!r.ok) return { ok: messages.length > 0, message: [...messages, r.message].join('\n'), data: { ids } };
          messages.push(r.message);
          ids.push(r.machine!.id);
        }
        return { ok: true, message: messages.join('\n'), data: ids.length === 1 ? { id: ids[0] } : { ids } };
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
      case 'rename': {
        const ref = resolveMachine(s, cmd.target);
        if ('error' in ref) return err(ref.error);
        const name = cmd.name.trim().slice(0, 40);
        const old = displayName(ref.machine);
        if (!name) {
          ref.machine.name = null;
          return ok(`${old} [${ref.machine.id}] is back to its default name.`);
        }
        const clash = this.nameClash(name, ref.machine.id);
        if (clash) return err(clash);
        ref.machine.name = name;
        return ok(`Renamed ${old} [${ref.machine.id}] to "${name}".`);
      }
      case 'name_line':
        return this.nameLine(cmd.name, cmd.machines);
      case 'batch':
        return this.batch(cmd, view);
      case 'diagnose': {
        const scope = cmd.target ? this.scope(cmd.target) : undefined;
        if (scope && 'error' in scope) return err(scope.error);
        const issues = diagnose(s, scope?.ids);
        const label = scope ? ` (${scope.label})` : '';
        return {
          ok: true,
          message: summarizeIssues(issues).replace(/^([^:\n]+):?/, (head) => head + label),
          data: { scope: scope?.label ?? 'whole factory', errors: issues.filter((i) => i.severity === 'error').length, issues },
        };
      }
      case 'find_space': {
        const w = Math.floor(cmd.w);
        const h = Math.floor(cmd.h);
        const margin = Math.max(0, Math.floor(cmd.margin ?? 1));
        if (!(w > 0 && h > 0)) return err('find_space needs a positive width and height.');
        const near = cmd.x !== undefined && cmd.y !== undefined ? { x: cmd.x, y: cmd.y } : undefined;
        const areas = findFreeAreas(s, w, h, near, margin, Math.max(1, Math.min(10, cmd.count ?? 3)));
        if (areas.length === 0) {
          return { ok: false, message: `No free ${w}×${h} area with a ${margin}-tile margin on the ${s.width}×${s.height} floor.`, data: { areas } };
        }
        return { ok: true, message: `Free ${w}×${h} areas (top-left corners): ${areas.map((a) => `${a.x},${a.y}`).join('; ')}.`, data: { areas } };
      }
      case 'map': {
        const r = renderMap(s, cmd.x, cmd.y, cmd.w, cmd.h);
        const legend = Object.entries(r.legend).map(([k, v]) => `${k} = ${v}`);
        return { ok: true, message: [r.map, ...legend].join('\n'), data: r };
      }
      case 'inspect': {
        let machines = s.machines;
        let label = 'whole factory';
        if (cmd.target) {
          const scope = this.scope(cmd.target);
          if ('error' in scope) return err(scope.error);
          machines = selectMachines(s, scope.ids);
          label = scope.label;
        } else if (cmd.x !== undefined && cmd.y !== undefined) {
          const region = { x: cmd.x, y: cmd.y, w: cmd.w ?? 30, h: cmd.h ?? 20 };
          machines = selectMachines(s, undefined, region);
          label = `region ${region.x},${region.y} ${region.w}×${region.h}`;
        }
        if (machines.length === 1) return { ok: true, message: machineReport(s, machines[0]), data: stateData(s, machines) };
        return { ok: true, message: `${label}: ${machines.length} machines.`, data: stateData(s, machines) };
      }
      case 'catalog':
        return { ok: true, message: catalogReport(), data: catalogData(cmd.filter) };
      case 'item': {
        const it = resolveItem(cmd.item);
        if (!it) return err(`Unknown item "${cmd.item}".`);
        const data = itemData(it.id, cmd.upstream);
        return { ok: true, message: this.query('recipes', it.id).message, data };
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

  /** Error text if `name` is already used by another machine (as a name or an id). */
  private nameClash(name: string, except?: string): string | null {
    const n = norm(name);
    const other = this.state.machines.find((m) => m.id !== except && (norm(m.id) === n || norm(displayName(m)) === n));
    return other ? `The name "${name}" is already used by ${other.id}.` : null;
  }

  /** Machines in a named line, or a single machine. */
  private scope(target: string): { ids: Set<string>; label: string } | { error: string } {
    const line = resolveLine(this.state, target);
    if (line) return { ids: new Set(this.state.machines.filter((m) => m.line === line.id).map((m) => m.id)), label: line.name };
    const ref = resolveMachine(this.state, target);
    if ('machine' in ref) return { ids: new Set([ref.machine.id]), label: ref.machine.id };
    return { error: `No line or machine called "${target}". Lines: ${this.state.lines.map((l) => l.name).join(', ') || 'none'}.` };
  }

  private nameLine(rawName: string, targets: string[]): CommandResult {
    const s = this.state;
    const name = (rawName ?? '').trim().slice(0, 40);
    if (!name) return err('A line needs a name.');
    if (!Array.isArray(targets) || targets.length === 0) return err('List the machines that belong to the line.');
    const machines: Machine[] = [];
    const missing: string[] = [];
    for (const t of targets) {
      const ref = resolveMachine(s, String(t));
      if ('error' in ref) missing.push(`${t} (${ref.error})`);
      else if (!machines.includes(ref.machine)) machines.push(ref.machine);
    }
    if (missing.length > 0) return err(`Could not find: ${missing.join('; ')}`);
    let line = s.lines.find((l) => norm(l.name) === norm(name));
    if (!line) {
      s.counters.line++;
      line = { id: `line-${s.counters.line}`, name, blueprint: null };
      s.lines.push(line);
    }
    const lineId = line.id;
    for (const m of machines) m.line = lineId;
    s.lines = s.lines.filter((l) => s.machines.some((m) => m.line === l.id));
    const members = s.machines.filter((m) => m.line === lineId).map((m) => m.id);
    return { ok: true, message: `Line "${line.name}" has ${members.length} machines.`, data: { line: line.name, machines: members } };
  }

  private batch(cmd: Extract<Command, { op: 'batch' }>, view: ClientView): CommandResult {
    const ops = Array.isArray(cmd.ops) ? cmd.ops : [];
    if (ops.length === 0) return err('A batch needs at least one op.');
    if (ops.length > 200) return err('A batch can hold at most 200 ops.');
    const original = this.state;
    const dry = !!cmd.dryRun;
    const backup = dry || cmd.atomic ? structuredClone(original) : null;
    if (dry) {
      this.state = backup!;
      this.quiet++;
    }
    const refs = new Map<string, string>();
    const results: { i: number; op: string; ok: boolean; message: string; id?: string }[] = [];
    try {
      ops.forEach((raw, i) => {
        const opName = String((raw as { op?: unknown })?.op ?? '');
        if (!(BATCH_OPS as readonly string[]).includes(opName)) {
          results.push({ i, op: opName, ok: false, message: `"${opName}" is not allowed in a batch (allowed: ${BATCH_OPS.join(', ')}).` });
          return;
        }
        const resolved = substituteRefs(raw, refs);
        if (typeof resolved === 'string') {
          results.push({ i, op: opName, ok: false, message: resolved });
          return;
        }
        const r = this.exec(resolved, view);
        const id = (r.data as { id?: string } | undefined)?.id;
        if (r.ok && id && resolved.op === 'place' && resolved.as) refs.set(resolved.as.replace(/^@/, ''), id);
        results.push({ i, op: opName, ok: r.ok, message: r.message, ...(id ? { id } : {}) });
      });
    } finally {
      if (dry) {
        this.state = original;
        this.quiet--;
      }
    }
    const failed = results.filter((r) => !r.ok);
    const rolledBack = !dry && !!cmd.atomic && failed.length > 0;
    if (rolledBack) this.state = backup!;
    const head =
      `Batch${dry ? ' (dry run, nothing changed)' : ''}: ${results.length - failed.length}/${results.length} ops succeeded` +
      (rolledBack ? '; atomic batch rolled back, nothing changed.' : '.');
    const lines = failed.map((r) => `#${r.i} ${r.op}: ${r.message}`);
    return {
      ok: failed.length === 0,
      message: [head, ...lines].join('\n'),
      data: { dry_run: dry, applied: !dry && !rolledBack, succeeded: results.length - failed.length, failed: failed.length, results },
    };
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
          name: m.name,
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

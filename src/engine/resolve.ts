// Forgiving name resolution shared by the text parser and the LLM tools:
// "kiln 1", "Kiln-1", "the cnc", "aluminium", "glaze firing", "the mug line".

import { BLUEPRINTS, type Blueprint } from './blueprints.ts';
import { ITEM_LIST, MACHINE_LIST, RECIPES, type ItemDef, type MachineDef, type RecipeDef } from './catalog.ts';
import type { GameState, Line, Machine } from './state.ts';
import { contentBounds, displayName, type Rect } from './world.ts';

const FILLER = new Set(['the', 'a', 'an', 'my', 'our', 'that', 'this', 'of', 'some', 'please', 'new', 'units', 'unit', 'pieces', 'pcs', 'x']);

export function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[_\-/]+/g, ' ')
    .replace(/[^a-z0-9#. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function singular(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y';
  if (w.length > 3 && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 2 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function tokens(s: string): string[] {
  return norm(s)
    .split(' ')
    .filter((t) => t && !FILLER.has(t))
    .map(singular);
}

function score(query: string, phrase: string): number {
  const q = tokens(query);
  const p = tokens(phrase);
  if (q.length === 0 || p.length === 0) return 0;
  const qs = q.join(' ');
  const ps = p.join(' ');
  if (qs === ps) return 100;
  const pset = new Set(p);
  const qset = new Set(q);
  const hits = q.filter((t) => pset.has(t)).length;
  if (hits === q.length) return 70 + 20 * (hits / p.length);
  if (q.length <= p.length + 2 && p.every((t) => qset.has(t))) return 60 + 20 * (p.length / q.length);
  // Prefix matches ("anod" -> "anodizing").
  const prefix = q.filter((t) => t.length >= 3 && p.some((x) => x.startsWith(t))).length;
  if (prefix === q.length) return 55;
  return 40 * (hits / Math.max(q.length, p.length));
}

function best<T>(query: string, list: T[], phrases: (t: T) => string[], min = 54): T | null {
  let top: T | null = null;
  let topScore = min;
  for (const item of list) {
    for (const ph of phrases(item)) {
      const s = score(query, ph);
      if (s > topScore) {
        topScore = s;
        top = item;
      }
    }
  }
  return top;
}

export function resolveMachineType(q: string): MachineDef | null {
  return best(q, MACHINE_LIST, (m) => [m.id, m.name, ...m.aliases]);
}

export function resolveItem(q: string, filter?: (i: ItemDef) => boolean): ItemDef | null {
  const list = filter ? ITEM_LIST.filter(filter) : ITEM_LIST;
  // Prefer finished products and purchasable goods over intermediate parts on ties.
  const ranked = [...list.filter((i) => i.kind !== 'part'), ...list.filter((i) => i.kind === 'part')];
  return best(q, ranked, (i) => [i.id, i.name, ...i.aliases]);
}

export function resolveRecipe(q: string, machine?: MachineDef): RecipeDef | null {
  const ids = machine ? machine.recipes : Object.keys(RECIPES);
  const list = ids.map((id) => RECIPES[id]);
  return best(q, list, (r) => [r.id, r.name, ...r.aliases, ...Object.keys(r.outputs)], 50);
}

export function resolveBlueprint(q: string): Blueprint | null {
  const cleaned = norm(q).replace(/\b(production|assembly|manufacturing)?\s*(line|lines|factory|plant|blueprint|cell)\b/g, '').trim();
  return best(cleaned || q, BLUEPRINTS, (b) => [b.id, b.name, ...b.aliases]);
}

export type MachineRef = { machine: Machine } | { error: string };

export function resolveMachine(state: GameState, ref: string): MachineRef {
  const n = norm(ref).replace(/^(the|a|an|my)\s+/, '');
  if (!n) return { error: 'Which machine?' };
  const direct = state.machines.find((m) => norm(m.id) === n || norm(displayName(m)) === n);
  if (direct) return { machine: direct };
  const numbered = n.match(/^(.*?)\s*(?:#|no\.?|number)?\s*(\d+)$/);
  if (numbered && numbered[1]) {
    const def = resolveMachineType(numbered[1]);
    if (def) {
      const id = `${def.short}-${Number(numbered[2])}`;
      const m = state.machines.find((x) => x.id === id);
      if (m) return { machine: m };
      const have = state.machines.filter((x) => x.type === def.id).map((x) => x.id);
      return { error: `No ${def.name.toLowerCase()} #${numbered[2]}. ${have.length ? 'You have: ' + have.join(', ') : 'You have none yet'}.` };
    }
  }
  const ordinal = n.match(/^(first|second|third|fourth|last)\s+(.*)$/);
  const def = resolveMachineType(ordinal ? ordinal[2] : n);
  if (!def) return { error: `I don't know a machine called "${ref}".` };
  const all = state.machines.filter((x) => x.type === def.id);
  if (all.length === 0) return { error: `There is no ${def.name.toLowerCase()} on the floor yet.` };
  if (ordinal) {
    const k = ['first', 'second', 'third', 'fourth'].indexOf(ordinal[1]);
    const pick = ordinal[1] === 'last' ? all[all.length - 1] : all[k];
    if (pick) return { machine: pick };
  }
  if (all.length === 1) return { machine: all[0] };
  return { error: `Which ${def.name.toLowerCase()}? ${all.map((m) => m.id).join(', ')}.` };
}

/** A named line or zone: exact name, "kettle line 2" style numbering, or fuzzy name / blueprint match. */
export function resolveLine(state: GameState, q: string): Line | null {
  const n = norm(q).replace(/^(the|a|an|my|our)\s+/, '');
  if (!n) return null;
  const exact = state.lines.find((l) => norm(l.name) === n || l.id === n);
  if (exact) return exact;
  const numbered = n.match(/^(.*?)\s+(\d+)$/);
  const base = numbered ? numbered[1] : n;
  const k = numbered ? Number(numbered[2]) : 1;
  const bp = resolveBlueprint(base);
  const matches = state.lines.filter((l) => score(base, l.name) >= 54 || (bp !== null && l.blueprint === bp.id));
  return matches[k - 1] ?? (numbered ? null : matches[0] ?? null);
}

/** Finds an area to point the camera at: a line, a machine, a machine type, or a product's line. */
export function resolveFocus(state: GameState, q: string): { rect: Rect; label: string } | null {
  const n = norm(q).replace(/^(the|a|an|my|our)\s+/, '');
  if (/^(everything|all|factory|whole factory|floor|overview|home)$/.test(n)) {
    const r = contentBounds(state);
    return r ? { rect: r, label: 'the whole factory' } : null;
  }
  const lineRect = (line: Line | null) => {
    const r = line && contentBounds(state, state.machines.filter((m) => m.line === line.id));
    return line && r ? { rect: r, label: line.name } : null;
  };
  const exactLine = state.lines.find((l) => norm(l.name) === n);
  if (exactLine) return lineRect(exactLine);
  const ref = resolveMachine(state, n);
  if ('machine' in ref) return { rect: contentBounds(state, [ref.machine])!, label: displayName(ref.machine) };
  // An exact machine-type alias ("smt line") wins over fuzzy line names.
  const typeExact = MACHINE_LIST.find((d) => d.aliases.some((a) => norm(a) === n) || norm(d.name) === n);
  if (!typeExact) {
    const hit = lineRect(resolveLine(state, n));
    if (hit) return hit;
  }
  const def = typeExact ?? resolveMachineType(n);
  if (def) {
    const first = state.machines.find((m) => m.type === def.id);
    if (first) return { rect: contentBounds(state, [first])!, label: displayName(first) };
  }
  return null;
}

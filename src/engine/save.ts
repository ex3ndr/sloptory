// Save files are the whole GameState as JSON, wrapped with a small header.

import { MACHINES, RECIPES } from './catalog.ts';
import { SAVE_VERSION, createState, type GameState } from './state.ts';

export interface SaveFile {
  format: 'sloptory-save';
  version: number;
  savedAt: string;
  state: GameState;
}

export function serialize(state: GameState, savedAt = new Date().toISOString()): string {
  const file: SaveFile = { format: 'sloptory-save', version: SAVE_VERSION, savedAt, state };
  return JSON.stringify(file);
}

export function deserialize(json: string): GameState {
  const file = JSON.parse(json) as Partial<SaveFile>;
  if (file.format !== 'sloptory-save' || !file.state) throw new Error('Not a Sloptory save file.');
  if (typeof file.version !== 'number' || file.version > SAVE_VERSION) throw new Error(`Unsupported save version ${file.version}.`);
  // Fill any fields newer than the save with defaults, then sanity-check references.
  const state: GameState = { ...createState(), ...file.state };
  for (const m of state.machines) {
    if (!MACHINES[m.type]) throw new Error(`Save references unknown machine type "${m.type}".`);
    if (m.recipe && !RECIPES[m.recipe]) m.recipe = null;
  }
  const ids = new Set(state.machines.map((m) => m.id));
  state.belts = state.belts.filter((b) => ids.has(b.from) && ids.has(b.to));
  return state;
}

export function sanitizeSaveName(name: string): string | null {
  const s = name
    .trim()
    .toLowerCase()
    .replace(/\.json$/, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s.length > 0 ? s : null;
}

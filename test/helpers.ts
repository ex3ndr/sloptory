import assert from 'node:assert/strict';
import { connect, placeMachine } from '../src/engine/ops.ts';
import { createState, type GameState, type Machine } from '../src/engine/state.ts';

export function fresh(): GameState {
  return createState('test', 42);
}

export function place(state: GameState, type: string, x: number, y: number, recipe?: string): Machine {
  const r = placeMachine(state, type, x, y, { recipe });
  assert.ok(r.ok && r.machine, r.message);
  return r.machine;
}

export function link(state: GameState, a: Machine, b: Machine): void {
  const r = connect(state, a.id, b.id);
  assert.ok(r.ok, r.message);
}

export function seconds(n: number): number {
  return Math.round(n * 10);
}

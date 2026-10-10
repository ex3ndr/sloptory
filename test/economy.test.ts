import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLUEPRINTS, blueprintCost, buildBlueprint } from '../src/engine/blueprints.ts';
import { ITEMS, MACHINES } from '../src/engine/catalog.ts';
import { buy, sellStock, shipProduct, updateOrders, type SimEvent } from '../src/engine/economy.ts';
import { placeMachine } from '../src/engine/ops.ts';
import { run } from '../src/engine/sim.ts';
import { START_CASH } from '../src/engine/state.ts';
import { stockCapacity } from '../src/engine/world.ts';
import { fresh, link, place, seconds } from './helpers.ts';

test('placing machines costs money; you cannot overspend', () => {
  const s = fresh();
  place(s, 'kiln', 5, 5);
  assert.equal(s.cash, START_CASH - MACHINES.kiln.cost);
  s.cash = 100;
  const r = placeMachine(s, 'cnc_mill', 20, 20);
  assert.equal(r.ok, false);
  assert.match(r.message, /costs/);
});

test('buying needs a receiving dock, cash, and stock space', () => {
  const s = fresh();
  assert.equal(buy(s, 'clay', 10).ok, false, 'no dock yet');
  place(s, 'receiving_dock', 2, 2);
  const cash = s.cash;
  const r = buy(s, 'clay', 200);
  assert.ok(r.ok, r.message);
  assert.equal(s.stock.clay, 200);
  assert.ok(Math.abs(cash - s.cash - 200 * ITEMS.clay.price) < 1e-6);
  assert.equal(buy(s, 'fired_mug', 1).ok, false, 'intermediates are not for sale');
  const cap = stockCapacity(s);
  const big = buy(s, 'glaze', cap * 2);
  assert.equal(s.stock.glaze, cap - 200, 'capped by stock space');
  assert.match(big.message, /stock space/);
  s.cash = 1;
  s.stock = {};
  assert.equal(buy(s, 'soc_phone', 5).ok, false, 'not enough cash');
});

test('shipping sells boxed products, filling open orders at a premium first', () => {
  const s = fresh();
  s.orders.push({ id: '#1', item: 'mug_boxed', qty: 2, filled: 0, price: 30, expiresAt: 999 });
  const events: SimEvent[] = [];
  const cash = s.cash;
  shipProduct(s, 'mug_boxed', events);
  shipProduct(s, 'mug_boxed', events);
  shipProduct(s, 'mug_boxed', events);
  assert.equal(s.cash, cash + 30 + 30 + ITEMS.mug_boxed.price);
  assert.equal(s.orders.length, 0, 'completed order is closed');
  assert.ok(events.some((e) => e.kind === 'order_done'));
  assert.ok(events.some((e) => e.kind === 'first_ship'));
  assert.equal(s.stats.shipped.mug_boxed, 3);
});

test('selling stock: products at market, purchased goods at half price, parts never', () => {
  const s = fresh();
  s.stock = { mug_boxed: 2, clay: 10, bisque_mug: 3 };
  const cash = s.cash;
  assert.ok(sellStock(s, 'mug_boxed', 5).ok);
  assert.equal(s.cash, cash + 2 * ITEMS.mug_boxed.price);
  assert.ok(sellStock(s, 'clay', 10).ok);
  assert.ok(Math.abs(s.cash - (cash + 2 * ITEMS.mug_boxed.price + 10 * ITEMS.clay.price * 0.5)) < 1e-6);
  assert.equal(sellStock(s, 'bisque_mug', 3).ok, false);
});

test('orders arrive over time and expire without penalty', () => {
  const s = fresh();
  const events: SimEvent[] = [];
  s.time = s.nextOrderAt;
  updateOrders(s, events);
  assert.equal(s.orders.length, 1);
  assert.ok(s.orders[0].price > ITEMS[s.orders[0].item].price, 'orders pay a premium');
  const cash = s.cash;
  s.time = s.orders[0].expiresAt;
  s.nextOrderAt = Infinity;
  updateOrders(s, events);
  assert.ok(events.some((e) => e.kind === 'order_expired'));
  assert.equal(s.orders.length, 0);
  assert.equal(s.cash, cash);
});

test('autobuy keeps inputs stocked and switches off when cash runs out', () => {
  const s = fresh();
  buildBlueprint(s, 'mug');
  s.autobuy = true;
  run(s, 10);
  assert.ok((s.stock.clay ?? 0) + countOnBelts(s, 'clay') >= 100, 'clay was bought');
  assert.ok((s.stock.glaze ?? 0) > 0 && (s.stock.carton ?? 0) > 0);
  s.cash = 0;
  s.stock = {};
  run(s, 10);
  assert.equal(s.autobuy, false);
});

function countOnBelts(s: ReturnType<typeof fresh>, item: string): number {
  return s.belts.reduce((n, b) => n + b.items.filter((i) => i.item === item).length, 0);
}

test('the starting budget covers a mug line plus any one electronics line', () => {
  const mug = blueprintCost(BLUEPRINTS.find((b) => b.id === 'mug')!);
  for (const id of ['kettle', 'watch', 'phone']) {
    assert.ok(mug + blueprintCost(BLUEPRINTS.find((b) => b.id === id)!) < START_CASH, id);
  }
});

test('a dock feeds a machine only what its recipe needs', () => {
  const s = fresh();
  const dock = place(s, 'receiving_dock', 2, 2);
  const glazing = place(s, 'glazing_station', 10, 2);
  link(s, dock, glazing);
  s.stock = { glaze: 50, clay: 50 };
  run(s, seconds(10));
  assert.equal(s.stock.clay, 50, 'clay stays in stock');
  assert.ok((glazing.input.glaze ?? 0) > 0);
  assert.ok((glazing.input.glaze ?? 0) <= 4, 'input buffer is bounded');
  assert.equal(s.belts[0].items.length, 0, 'nothing extra is queued on the belt');
});

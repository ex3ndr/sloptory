// Cash, purchasing, selling and customer orders.

import { ITEMS, PRODUCTS, RECIPES, isBuyable } from './catalog.ts';
import { add, count, random, type GameState } from './state.ts';
import { defOf, hasReceivingDock, stockFree } from './world.ts';

export interface SimEvent {
  kind: 'order_new' | 'order_done' | 'order_expired' | 'first_ship' | 'autobuy';
  text: string;
}

export interface BuyResult {
  ok: boolean;
  qty: number;
  cost: number;
  message: string;
}

function money(n: number): string {
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: n < 100 ? 2 : 0 })}`;
}

export function buy(state: GameState, itemId: string, qty: number): BuyResult {
  const def = ITEMS[itemId];
  if (!def) return { ok: false, qty: 0, cost: 0, message: `Unknown item "${itemId}".` };
  if (!isBuyable(itemId)) return { ok: false, qty: 0, cost: 0, message: `${def.name} is made in the factory, not bought.` };
  if (!hasReceivingDock(state)) {
    return { ok: false, qty: 0, cost: 0, message: 'You need a receiving dock before suppliers can deliver. Try "place receiving dock".' };
  }
  qty = Math.floor(qty);
  if (qty <= 0) return { ok: false, qty: 0, cost: 0, message: 'Quantity must be positive.' };
  const room = stockFree(state);
  const affordable = Math.floor(state.cash / def.price);
  const n = Math.min(qty, room, affordable);
  if (n <= 0) {
    const why = room <= 0 ? 'stock is full (build a warehouse)' : 'not enough cash';
    return { ok: false, qty: 0, cost: 0, message: `Could not buy ${def.name}: ${why}.` };
  }
  const cost = Math.round(n * def.price * 100) / 100;
  state.cash -= cost;
  state.stats.spent += cost;
  add(state.stock, itemId, n);
  const short = n < qty ? ` (wanted ${qty}; ${room < qty ? 'stock space' : 'cash'} ran out)` : '';
  return { ok: true, qty: n, cost, message: `Bought ${n} × ${def.name} for ${money(cost)}${short}.` };
}

/** Sell items from stock: products at market price, purchased goods back at half price. */
export function sellStock(state: GameState, itemId: string, qty: number, events: SimEvent[] = []): BuyResult {
  const def = ITEMS[itemId];
  if (!def) return { ok: false, qty: 0, cost: 0, message: `Unknown item "${itemId}".` };
  const have = count(state.stock, itemId);
  const n = Math.min(Math.floor(qty), have);
  if (n <= 0) return { ok: false, qty: 0, cost: 0, message: `No ${def.name} in stock to sell.` };
  if (def.kind === 'part') return { ok: false, qty: 0, cost: 0, message: `Nobody buys loose ${def.name.toLowerCase()}s. Finish and box them first.` };
  let earned = 0;
  add(state.stock, itemId, -n);
  if (def.kind === 'product') {
    for (let i = 0; i < n; i++) earned += shipProduct(state, itemId, events);
  } else {
    earned = Math.round(n * def.price * 0.5 * 100) / 100;
    state.cash += earned;
    state.stats.revenue += earned;
  }
  return { ok: true, qty: n, cost: earned, message: `Sold ${n} × ${def.name} for ${money(earned)}.` };
}

/** One boxed product leaves through shipping; fills the oldest matching order first. */
export function shipProduct(state: GameState, itemId: string, events: SimEvent[]): number {
  const def = ITEMS[itemId];
  const order = state.orders.find((o) => o.item === itemId && o.filled < o.qty);
  const price = order ? order.price : def.price;
  if (order) {
    order.filled++;
    if (order.filled >= order.qty) {
      state.orders = state.orders.filter((o) => o !== order);
      events.push({ kind: 'order_done', text: `Order ${order.id} complete: ${order.qty} × ${def.name} delivered at ${money(order.price)} each.` });
    }
  }
  if (!state.stats.shipped[itemId]) events.push({ kind: 'first_ship', text: `First ${def.name.toLowerCase()} shipped! Sold for ${money(price)}.` });
  add(state.stats.shipped, itemId, 1);
  state.cash += price;
  state.stats.revenue += price;
  return price;
}

const ORDER_SIZE: Record<string, [number, number]> = {
  mug_boxed: [20, 60],
  kettle_boxed: [8, 24],
  watch_boxed: [5, 15],
  phone_boxed: [3, 10],
};
const ORDER_WEIGHT: Record<string, number> = { mug_boxed: 4, kettle_boxed: 2, watch_boxed: 1.5, phone_boxed: 1 };

function producible(state: GameState): Set<string> {
  const out = new Set<string>();
  for (const m of state.machines) {
    if (m.type !== 'packaging' || !m.recipe) continue;
    if (m.recipe.startsWith('pack_')) out.add(`${m.recipe.slice(5)}_boxed`);
  }
  return out;
}

export function updateOrders(state: GameState, events: SimEvent[]): void {
  for (const o of state.orders) {
    if (state.time >= o.expiresAt) {
      events.push({ kind: 'order_expired', text: `Order ${o.id} expired (${o.filled}/${o.qty} ${ITEMS[o.item].name} delivered). No penalty.` });
    }
  }
  state.orders = state.orders.filter((o) => state.time < o.expiresAt);
  if (state.time < state.nextOrderAt) return;
  state.nextOrderAt = state.time + 45 + Math.floor(random(state) * 45);
  if (state.orders.length >= 3) return;
  const can = producible(state);
  const weights = PRODUCTS.map((p) => ORDER_WEIGHT[p] * (can.has(p) ? 4 : 1));
  let roll = random(state) * weights.reduce((a, b) => a + b, 0);
  let item = PRODUCTS[0];
  for (let i = 0; i < PRODUCTS.length; i++) {
    roll -= weights[i];
    if (roll <= 0) {
      item = PRODUCTS[i];
      break;
    }
  }
  const [lo, hi] = ORDER_SIZE[item];
  const qty = lo + Math.floor(random(state) * (hi - lo + 1));
  const premium = 1.25 + Math.floor(random(state) * 36) / 100;
  const price = Math.round(ITEMS[item].price * premium * 100) / 100;
  const duration = 300 + Math.floor(random(state) * 301);
  state.counters.order++;
  const id = `#${100 + state.counters.order}`;
  state.orders.push({ id, item, qty, filled: 0, price, expiresAt: state.time + duration });
  events.push({
    kind: 'order_new',
    text: `New order ${id}: ${qty} × ${ITEMS[item].name} at ${money(price)} each (${Math.round(premium * 100 - 100)}% over market), due in ${Math.round(duration / 60)} min.`,
  });
}

const AUTOBUY_LOW = 40;
const AUTOBUY_TARGET = 150;

/** Purchased items consumed by any configured machine. */
export function neededSupplies(state: GameState): string[] {
  const needed = new Set<string>();
  for (const m of state.machines) {
    if (defOf(m).role !== 'process' || !m.recipe) continue;
    for (const it of Object.keys(RECIPES[m.recipe]?.inputs ?? {})) if (isBuyable(it)) needed.add(it);
  }
  return [...needed];
}

/** Keeps purchased inputs of every configured machine topped up. */
export function autobuy(state: GameState, events: SimEvent[]): void {
  if (!state.autobuy || !hasReceivingDock(state)) return;
  for (const it of neededSupplies(state)) {
    const have = count(state.stock, it);
    if (have >= AUTOBUY_LOW || stockFree(state) <= 0) continue;
    if (state.cash < ITEMS[it].price * (AUTOBUY_TARGET - have)) {
      state.autobuy = false;
      events.push({ kind: 'autobuy', text: `Auto-buy switched off: not enough cash to restock ${ITEMS[it].name}.` });
      return;
    }
    buy(state, it, AUTOBUY_TARGET - have);
  }
}

export { money };

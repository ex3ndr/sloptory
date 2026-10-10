// Web interface: streams the factory from the engine and sends text. No other controls.

import type { Camera } from '../game/api.ts';
import type { CatalogView, ClientMessage, LogEntry, ServerMessage, Snapshot } from '../shared/protocol.ts';
import { Renderer } from './render.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const renderer = new Renderer($<HTMLCanvasElement>('floor'));
let catalog: CatalogView | null = null;
let ws: WebSocket | null = null;
let retry = 500;
let cam: Camera = { x: 30, y: 20, zoom: 1 };
let camTarget: Camera = { ...cam };
const snaps: { snap: Snapshot; at: number }[] = [];
const INTERP_MS = 200;

function sendMsg(msg: ClientMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function sendViewport(): void {
  sendMsg({ t: 'viewport', w: window.innerWidth, h: window.innerHeight });
}

function connect(): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    retry = 500;
    setLink(true);
    sendViewport();
  };
  ws.onclose = () => {
    setLink(false);
    setTimeout(connect, retry);
    retry = Math.min(retry * 2, 8000);
  };
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data as string) as ServerMessage);
}

function onMessage(msg: ServerMessage): void {
  switch (msg.t) {
    case 'hello':
      catalog = msg.catalog;
      cam = { ...msg.camera };
      camTarget = { ...msg.camera };
      $('agent').textContent = msg.agent === 'parser' ? 'built-in parser (no LLM key)' : msg.agent;
      $('log').innerHTML = '';
      for (const e of msg.log) appendLog(e, false);
      break;
    case 'state':
      snaps.push({ snap: msg, at: performance.now() });
      if (snaps.length > 3) snaps.shift();
      updateHud(msg);
      break;
    case 'log':
      for (const e of msg.entries) appendLog(e, true);
      break;
    case 'camera':
      camTarget = { ...msg.camera };
      break;
    case 'busy':
      $('busy').hidden = !msg.busy;
      break;
  }
}

function setLink(live: boolean): void {
  const el = $('link');
  el.classList.toggle('live', live);
  el.querySelector('span')!.textContent = live ? 'live' : 'offline';
}

// ---------- HUD ----------

function money(n: number): string {
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`;
  return `${sign}$${Math.round(a).toLocaleString('en-US')}`;
}

function clock(t: number): string {
  const s = Math.floor(t);
  return `T+${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function updateHud(s: Snapshot): void {
  if (!catalog) return;
  const items = new Map(catalog.items.map((i) => [i.id, i]));
  $('game-name').textContent = s.name;
  $('cash').textContent = money(s.cash);
  const rate = $('rate');
  rate.textContent = `${s.perMinute.revenue >= 0 ? '+' : ''}${money(s.perMinute.revenue)}/min`;
  rate.classList.toggle('up', s.perMinute.revenue > 0);
  $('clock').textContent = clock(s.time);
  $('speed').textContent = s.speed === 0 ? 'PAUSED' : `${s.speed}×`;
  const p = s.power;
  $('power').textContent = `${Math.round(p.demand)} / ${p.capacity} kW`;
  const bar = $('power-bar');
  bar.style.width = `${Math.min(100, (p.demand / p.capacity) * 100)}%`;
  bar.style.background = p.satisfaction < 1 ? 'var(--bad)' : p.demand / p.capacity > 0.8 ? 'var(--warn)' : 'var(--ok)';
  const shipped = Object.values(s.shipped).reduce((a, b) => a + b, 0);
  $('shipped').textContent = shipped.toLocaleString('en-US');
  $('shipped-rate').textContent = `${s.perMinute.shipped}/min`;
  const stockTotal = Object.values(s.stock).reduce((a, b) => a + b, 0);
  $('stock-total').textContent = stockTotal.toLocaleString('en-US');
  $('stock-cap').textContent = `/ ${s.stockCap.toLocaleString('en-US')}`;
  const processing = s.machines.filter((m) => m.status !== 'ready');
  $('floor-running').textContent = `${processing.filter((m) => m.status === 'working').length} / ${processing.length}`;
  $('floor-belts').textContent = `running · ${s.belts.length} belts`;

  const orders = $('orders');
  orders.replaceChildren();
  if (s.orders.length === 0) orders.append(el('li', 'empty', 'No open orders'));
  for (const o of s.orders) {
    const li = el('li', 'order');
    li.append(el('span', 'what', `${o.id} · ${o.qty}× ${items.get(o.item)?.name ?? o.item}`));
    li.append(el('span', 'due', clock(Math.max(0, o.expiresAt - s.time)).slice(2)));
    const barWrap = el('span', 'bar');
    const fill = el('span');
    fill.style.width = `${(o.filled / o.qty) * 100}%`;
    barWrap.append(fill);
    li.append(barWrap);
    li.append(el('span', 'pay', `${o.filled}/${o.qty} delivered · ${money(o.price)} each`));
    orders.append(li);
  }

  const lines = $('lines');
  lines.replaceChildren();
  if (s.lines.length === 0) lines.append(el('li', 'empty', 'No lines yet — “build a mug line”'));
  for (const l of s.lines) {
    const li = el('li', 'line-row');
    li.append(el('span', '', l.name));
    const lamps = el('span', 'lamps');
    for (const m of s.machines) {
      if (m.line !== l.id || m.status === 'ready') continue;
      const lamp = el('i', `lamp ${m.status}`);
      lamp.title = `${m.id}: ${m.status}`;
      lamps.append(lamp);
    }
    li.append(lamps);
    lines.append(li);
  }

  const auto = $('autobuy');
  auto.textContent = s.autobuy ? 'autobuy on' : 'autobuy off';
  auto.classList.toggle('on', s.autobuy);
  const stock = $('stock');
  stock.replaceChildren();
  const entries = Object.entries(s.stock).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) stock.append(el('li', 'empty', 'Empty — “buy 200 clay”'));
  for (const [id, q] of entries.slice(0, 16)) {
    const li = el('li');
    const sw = el('i', 'sw');
    sw.style.background = items.get(id)?.color ?? '#888';
    li.append(sw, el('span', 'nm', items.get(id)?.name ?? id), el('span', 'q', q.toLocaleString('en-US')));
    stock.append(li);
  }
}

// ---------- console ----------

const logEl = $('log');

function appendLog(e: LogEntry, animate: boolean): void {
  const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 60;
  const div = el('div', `entry ${e.kind}`);
  div.append(el('span', 't', clock(e.time).slice(2)));
  const body = el('span', 'body');
  div.append(body);
  if (e.via && e.kind !== 'player') div.append(el('span', 'via', `· ${e.via}`));
  logEl.append(div);
  while (logEl.childElementCount > 220) logEl.firstElementChild!.remove();
  if (animate && (e.kind === 'agent' || e.kind === 'error')) {
    // Teletype: print the reply quickly instead of popping it in.
    const text = e.text;
    const start = performance.now();
    const dur = Math.min(700, text.length * 6);
    const tick = () => {
      const k = Math.min(1, (performance.now() - start) / dur);
      body.textContent = text.slice(0, Math.ceil(text.length * k));
      if (nearBottom) logEl.scrollTop = logEl.scrollHeight;
      if (k < 1) requestAnimationFrame(tick);
    };
    tick();
  } else {
    body.textContent = e.text;
  }
  if (nearBottom || !animate) logEl.scrollTop = logEl.scrollHeight;
}

const input = $<HTMLInputElement>('cmd');
const history: string[] = [];
let histPos = 0;

$<HTMLFormElement>('prompt').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  sendMsg({ t: 'cmd', text });
  if (history[history.length - 1] !== text) history.push(text);
  histPos = history.length;
  input.value = '';
  logEl.scrollTop = logEl.scrollHeight;
});

input.addEventListener('keydown', (ev) => {
  if (ev.key === 'ArrowUp' && history.length) {
    histPos = Math.max(0, histPos - 1);
    input.value = history[histPos];
    ev.preventDefault();
  } else if (ev.key === 'ArrowDown' && history.length) {
    histPos = Math.min(history.length, histPos + 1);
    input.value = history[histPos] ?? '';
    ev.preventDefault();
  }
});

// Typing anywhere goes to the console; the floor itself takes no input.
window.addEventListener('keydown', (ev) => {
  if (document.activeElement !== input && ev.key.length === 1 && !ev.metaKey && !ev.ctrlKey) input.focus();
});
document.addEventListener('mouseup', () => {
  if (!window.getSelection()?.toString()) input.focus();
});
window.addEventListener('wheel', (ev) => {
  if (!(ev.target as HTMLElement).closest('#log')) ev.preventDefault();
}, { passive: false });

let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(sendViewport, 200);
});

// ---------- render loop ----------

let last = performance.now();
function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const k = 1 - Math.exp(-dt * 7);
  cam = {
    x: cam.x + (camTarget.x - cam.x) * k,
    y: cam.y + (camTarget.y - cam.y) * k,
    zoom: cam.zoom * Math.pow(camTarget.zoom / cam.zoom, k),
  };
  $('view').textContent = `${Math.round(camTarget.x)},${Math.round(camTarget.y)}`;
  $('zoom').textContent = `${camTarget.zoom.toFixed(2)}×`;
  if (catalog && snaps.length > 0) {
    const renderAt = now - INTERP_MS;
    let prev: Snapshot | null = null;
    let curr = snaps[snaps.length - 1].snap;
    let alpha = 1;
    for (let i = snaps.length - 1; i > 0; i--) {
      if (snaps[i - 1].at <= renderAt) {
        prev = snaps[i - 1].snap;
        curr = snaps[i].snap;
        alpha = Math.max(0, Math.min(1, (renderAt - snaps[i - 1].at) / Math.max(1, snaps[i].at - snaps[i - 1].at)));
        break;
      }
    }
    renderer.draw({ cam, prev, curr, alpha, catalog, now: now / 1000 });
  }
  requestAnimationFrame(frame);
}

connect();
input.focus();
requestAnimationFrame(frame);

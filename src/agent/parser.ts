// Deterministic natural-language parser: turns player text into engine Commands with no
// network or model. It is the fallback agent and the fast path for camera commands.

import { isBuyable } from '../engine/catalog.ts';
import { norm, resolveBlueprint, resolveItem, resolveMachine, resolveMachineType } from '../engine/resolve.ts';
import type { GameState } from '../engine/state.ts';
import type { Command, QueryKind } from '../game/api.ts';

export interface ParseResult {
  commands: Command[];
  /** Segments of the input that matched nothing. */
  unknown: string[];
}

const DEFAULT_PAN = 10;
const DEFAULT_BUY = 100;
const WORD_NUM: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  dozen: 12, twenty: 20, fifty: 50, hundred: 100, thousand: 1000,
};
const NUM = String.raw`(\d[\d,]*(?:\.\d+)?k?|one|two|three|four|five|six|seven|eight|nine|ten|dozen|twenty|fifty|hundred|thousand)`;
const XY = String.raw`\(?\s*(-?\d+)\s*(?:,|\s|x|by)\s*(-?\d+)\s*\)?`;
const END = '$';

function num(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const w = WORD_NUM[s];
  if (w !== undefined) return w;
  const k = s.endsWith('k');
  const n = Number(s.replace(/[,k]/g, ''));
  if (!Number.isFinite(n)) return undefined;
  return k ? n * 1000 : n;
}

export function clean(text: string): string {
  let s = text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/, '')
    .trim();
  const lead =
    /^(please|pls|ok|okay|hey|now|so|and|also|then|alright|can you|could you|would you|will you|i want to|i'd like to|id like to|i would like to|let's|lets|go ahead and|i want|i need to|i need|we need to|we need|time to|try to)\s+/;
  for (let i = 0; i < 4 && lead.test(s); i++) s = s.replace(lead, '');
  return s.replace(/\s+(please|pls|now|for me)$/, '').trim();
}

type Rule = (s: string, state?: GameState) => Command | Command[] | null;

const query = (what: QueryKind, target?: string): Command => ({ op: 'query', what, target });

const DIRS: Record<string, [number, number]> = {
  left: [-1, 0], west: [-1, 0], right: [1, 0], east: [1, 0], up: [0, -1], north: [0, -1], down: [0, 1], south: [0, 1],
};

function amount(s: string | undefined): number {
  if (!s) return DEFAULT_PAN;
  if (/bit|little|slight|tad/.test(s)) return 4;
  if (/lot|far|way/.test(s)) return 25;
  return num(s.match(/\d+/)?.[0]) ?? DEFAULT_PAN;
}

function isMachine(state: GameState | undefined, ref: string): boolean {
  return !!state && 'machine' in resolveMachine(state, ref);
}

const BUY_VERBS = /^(buy|purchase|order|get)$/;

/** "build/place/add/buy ..." share verbs; the noun decides between blueprint, machine and purchase. */
function buildRule(s: string): Command | null {
  const m = s.match(
    /^(build|make|create|construct|set ?up|start|add|place|open|launch|blueprint|put|install|buy|get|purchase|order|drop|deploy|i want|give me)\s+(.+)$/,
  );
  if (!m) return null;
  const verb = m[1];
  let rest = m[2];
  let x: number | undefined;
  let y: number | undefined;
  const at =
    rest.match(new RegExp(String.raw`\s*(?:at|@|on|to|near|around)\s+(?:tile\s+|position\s+)?` + XY)) ??
    rest.match(/\s*\bx\s*=?\s*(\d+)[\s,]+y\s*=?\s*(\d+)/);
  if (at) {
    x = Number(at[1]);
    y = Number(at[2]);
    rest = (rest.slice(0, at.index) + ' ' + rest.slice(at.index! + at[0].length)).replace(/\s+/g, ' ').trim();
  }
  let recipe: string | undefined;
  const rec = rest.match(/\s+(?:for|making|to make|that makes|which makes|producing|to produce|running|with recipe|recipe)\s+(.+)$/);
  if (rec) {
    recipe = rec[1];
    rest = rest.slice(0, rec.index).trim();
  }
  let countN: number | undefined;
  const cm = rest.match(new RegExp('^' + NUM + String.raw`\s*(?:x\s+|units? of\s+|pcs of\s+|of\s+|more\s+)?(.+)` + END));
  if (cm) {
    countN = num(cm[1]);
    rest = cm[2];
  } else {
    const tail = rest.match(new RegExp(String.raw`^(.+?)\s+(?:x\s*)?` + NUM + END));
    if (tail && !resolveMachineType(rest)) {
      countN = num(tail[2]);
      rest = tail[1];
    }
  }
  rest = rest.replace(/^(?:(?:a|an|the|another|one|new|more|some|complete|full|whole|entire|working|second|third|me|us)\s+)+/, '').trim();
  if (!rest) return null;

  const wantsLine = /\b(line|lines|factory|plant|production|blueprint)$/.test(rest) || verb === 'blueprint';
  const restNorm = norm(rest).replace(/s$/, '');
  const machine = resolveMachineType(rest);
  const machineExact = !!machine && [machine.name, machine.id, ...machine.aliases].some((a) => norm(a).replace(/s$/, '') === restNorm);
  const bp = resolveBlueprint(rest);
  const buying = BUY_VERBS.test(verb);

  if (bp && !machineExact && (wantsLine || (!machine && !buying))) return { op: 'blueprint', name: bp.id, x, y };
  if (buying && !machineExact) {
    const item = resolveItem(rest, (i) => isBuyable(i.id));
    if (item) return { op: 'buy', item: item.id, qty: countN ?? DEFAULT_BUY };
  }
  if (machine) return { op: 'place', machine: machine.id, x, y, recipe, count: countN };
  const item = resolveItem(rest, (i) => isBuyable(i.id));
  if (item && (buying || verb === 'add')) return { op: 'buy', item: item.id, qty: countN ?? DEFAULT_BUY };
  if (bp) return { op: 'blueprint', name: bp.id, x, y };
  return null;
}

const RULES: Rule[] = [
  // ---- meta / game management ----
  (s) => (/^(help|\?|commands|what can i (do|say|type)|how do i play|how to play|tutorial|hint|hints)\b/.test(s) ? { op: 'help' } : null),
  (s) => (/^(list|show|my)?\s*(saves|saved games|save files|games|savegames)$/.test(s) || s === 'list' ? { op: 'list_saves' } : null),
  (s) => {
    const m = s.match(/^(?:new game|new|restart|start over|reset|reset game|start (?:a )?new game|fresh start|start fresh)(?:\s+(?:called|named|as)\s+(\S+))?$/);
    return m ? { op: 'new_game', name: m[1] } : null;
  },
  (s) => {
    const m = s.match(/^(?:save|quicksave|quick save)(?:\s+(?:the\s+)?(?:game|progress|factory))?(?:\s+(?:as|to|named|called|into|in))?(?:\s+"?([\w-]+)"?)?$/);
    return m ? { op: 'save', name: m[1] } : null;
  },
  (s) => {
    const m = s.match(/^(?:load|restore|open|resume|continue|load up)\s+(?:(?:the\s+)?(?:game|save|saved game|file)\s+|from\s+)?"?([\w-]+)"?$/);
    if (!m || /^(game|play|playing|simulation|sim|time|it)$/.test(m[1])) return null;
    return { op: 'load', name: m[1] };
  },

  // ---- time ----
  (s) => (/^(pause|stop time|freeze|hold on|stop the clock|pause (the )?(game|simulation|sim|time))$/.test(s) ? { op: 'speed', value: 0 } : null),
  (s) => (/^(resume|unpause|play|continue|go on|resume (the )?(game|simulation|sim|play|time)|start (the )?(clock|simulation))$/.test(s) ? { op: 'resume' } : null),
  (s) => {
    const m = s.match(/^(?:set\s+)?(?:the\s+)?(?:game\s+|sim\s+|simulation\s+)?speed(?:\s+(?:to|=|at))?\s+(\d+(?:\.\d+)?)\s*x?$/) ?? s.match(/^(\d+)\s*x(?:\s+speed)?$/);
    if (m) return { op: 'speed', value: Number(m[1]) };
    if (/^(fast forward|faster|speed up|hurry up|ff)$/.test(s)) return { op: 'speed', value: 4 };
    if (/^(slower|slow down|normal speed|real ?time)$/.test(s)) return { op: 'speed', value: 1 };
    return null;
  },
  (s) => {
    const m = s.match(
      /^(?:(turn|switch)\s+)?(on|off|enable|disable|start|stop)?\s*auto[\s-]?(?:buy|buying|restock|restocking|supply|purchas\w*|order\w*)\s*(on|off|enable|disable|enabled|disabled|yes|no)?$/,
    );
    if (!m) return null;
    const word = m[3] ?? m[2] ?? 'on';
    return { op: 'autobuy', on: !/^(off|disable|disabled|no|stop)$/.test(word) };
  },

  // ---- camera ----
  (s) => {
    const m = s.match(
      /^(?:(?:scroll|pan|move|go|look|camera|view|shift|slide|head)\s+(?:the\s+)?(?:camera\s+|view\s+)?)?(left|right|up|down|north|south|east|west)(?:wards?)?(\s+(?:by\s+)?(?:\d+|a bit|a little|slightly|a tad|a lot|far|way)(?:\s*(?:tiles?|squares?|cells?|units?|steps?|more))?)?$/,
    );
    if (!m) return null;
    const [dx, dy] = DIRS[m[1]];
    const n = amount(m[2]);
    return { op: 'camera', action: 'pan', dx: dx * n, dy: dy * n };
  },
  (s) => {
    if (/^(zoom in|closer|enhance|zoom closer|get closer|magnify)$/.test(s)) return { op: 'camera', action: 'zoom', factor: 1.5 };
    if (/^(zoom out|further|farther|back up|zoom further)$/.test(s)) return { op: 'camera', action: 'zoom', factor: 1 / 1.5 };
    if (/^zoom (in|out) a lot$/.test(s)) return { op: 'camera', action: 'zoom', factor: s.includes(' in') ? 2.5 : 0.4 };
    const m = s.match(/^zoom(?:\s+(in|out))?(?:\s+(?:to|by|at))?\s+(\d+(?:\.\d+)?)\s*(x|%|times)?$/);
    if (!m) return null;
    let v = Number(m[2]);
    if (m[3] === '%') v /= 100;
    if (m[1] === 'in') return { op: 'camera', action: 'zoom', factor: v };
    if (m[1] === 'out') return { op: 'camera', action: 'zoom', factor: 1 / v };
    return { op: 'camera', action: 'zoom', level: v };
  },
  (s) =>
    /^(overview|zoom (to )?fit|fit|fit (all|everything)|zoom out (all the way|fully)|show (me )?(everything|it all|all|the whole factory|the factory|whole factory|the floor)|whole factory|the whole factory|home|center|centre|reset (the )?(camera|view)|birds? ?eye( view)?|big picture)$/.test(
      s,
    )
      ? { op: 'camera', action: 'overview' }
      : null,
  (s) => {
    const m = s.match(
      new RegExp(String.raw`^(?:go to|goto|go|center on|centre on|look at|jump to|move camera to|camera to|pan to|scroll to|view)\s+(?:tile\s+|position\s+|coords?\s+)?` + XY + END),
    );
    return m ? { op: 'camera', action: 'center', x: Number(m[1]), y: Number(m[2]) } : null;
  },

  // ---- queries ----
  (s) =>
    /^(status|report|summary|how are we doing|how('s| is) (it|the factory|everything|business) (going|doing)|what'?s (happening|going on|up)|state|stats|dashboard|overview of (the )?factory|cash|money|balance|funds|bank|profit|how much money( do (we|i) have)?)$/.test(
      s,
    )
      ? query('status')
      : null,
  (s) => (/^(?:show\s+|list\s+|check\s+|view\s+)?(?:the\s+)?(stock|inventory|warehouse|materials|supplies|what do we have|what do i have|storage)$/.test(s) ? query('stock') : null),
  (s) => (/^(?:show\s+|list\s+|check\s+|any\s+)?(?:the\s+)?(?:open\s+)?(orders|contracts|demand|customers|customer orders)$/.test(s) ? query('orders') : null),
  (s) => (/^(?:show\s+|list\s+)?(?:all\s+)?(?:the\s+)?(machines|equipment|machinery|floor)$/.test(s) ? query('machines') : null),
  (s) => (/^(?:show\s+|list\s+)?(?:the\s+)?(?:production\s+)?lines$/.test(s) ? query('lines') : null),
  (s) => (/^(?:show\s+|check\s+)?(?:the\s+)?(power|electricity|energy|power usage|grid)$/.test(s) ? query('power') : null),
  (s) =>
    /^(?:show\s+|list\s+|open\s+)?(?:the\s+)?(catalog|catalogue|shop|store|machine types|what can i build|buildings|machine list|price list)$/.test(s)
      ? query('catalog')
      : null,
  (s) => (/^(?:show\s+|list\s+)?(?:the\s+)?(blueprints?|templates|line types|what lines can i build)$/.test(s) ? query('blueprints') : null),
  (s) => {
    const m =
      s.match(/^(?:show\s+|list\s+)?recipes?(?:\s+(?:for|of|on|in|using)\s+(?:the\s+|a\s+)?(.+))?$/) ??
      s.match(/^how (?:do i|to|do you|do we) (?:make|build|produce) (?:a |an |the )?(.+)$/);
    return m ? query('recipes', m[1]) : null;
  },
  (s, state) => {
    const m = s.match(
      /^(?:info|inspect|details|detail|describe|examine|check|what is|what's|whats|how is|how's|tell me about|about|status of|look into)\s+(?:on\s+)?(?:the\s+)?(.+?)(?:\s+doing)?$/,
    );
    if (!m) return null;
    if (isMachine(state, m[1])) return query('machine', m[1]);
    if (resolveMachineType(m[1]) || resolveItem(m[1])) return query('recipes', m[1]);
    return query('machine', m[1]);
  },

  // ---- camera focus (after queries so "show stock" stays a query) ----
  (s) => {
    const m = s.match(
      /^(?:go to|goto|go|focus(?: on)?|show(?: me)?|look at|center on|centre on|jump to|find|where is|where's|wheres|take me to|camera on|zoom (?:in )?on|zoom to|view|navigate to|head to|visit)\s+(?:the\s+)?(.+)$/,
    );
    return m ? { op: 'camera', action: 'focus', target: m[1] } : null;
  },

  // ---- conveyors ----
  (s) => {
    const m = s.match(
      /^(?:disconnect|unlink|cut|unhook|detach|remove (?:the\s+)?(?:belts?|conveyors?|connections?|links?)(?:\s+(?:from|between|of))?)\s+(?:from\s+)?(.+?)(?:\s+(?:from|to|->|→|and)\s+(.+))?$/,
    );
    return m ? { op: 'disconnect', from: m[1], to: m[2] } : null;
  },
  (s) => {
    const m = s.match(/^(?:connect|link|hook up|hook|feed|route|run (?:a\s+)?(?:belt|conveyor)|belt|conveyor|send|wire|chain)\s+(?:from\s+)?(.+?)\s+(?:to|->|→|=>|into|with|and)\s+(.+)$/);
    const chain = m
      ? [m[1], ...m[2].split(/\s*(?:->|→|=>|\bthen\b|\bto\b)\s*/)]
      : s.includes('->') || s.includes('→')
        ? s.split(/\s*(?:->|→|=>)\s*/)
        : null;
    if (!chain || chain.length < 2 || chain.some((x) => !x.trim())) return null;
    const out: Command[] = [];
    for (let i = 0; i + 1 < chain.length; i++) out.push({ op: 'connect', from: chain[i].trim(), to: chain[i + 1].trim() });
    return out;
  },

  // ---- moving ----
  (s, state) => {
    const m = s.match(new RegExp(String.raw`^(?:move|relocate|shift|drag)\s+(.+?)\s+(?:to|at|@|onto)\s+` + XY + END));
    if (m) return { op: 'move', target: m[1], x: Number(m[2]), y: Number(m[3]) };
    const r = s.match(/^(?:move|shift|nudge)\s+(.+?)\s+(left|right|up|down)(?:\s+(?:by\s+)?(\d+))?(?:\s*tiles?)?$/);
    if (r && state) {
      const ref = resolveMachine(state, r[1]);
      if ('machine' in ref) {
        const [dx, dy] = DIRS[r[2]];
        const n = Number(r[3] ?? 1);
        return { op: 'move', target: ref.machine.id, x: ref.machine.x + dx * n, y: ref.machine.y + dy * n };
      }
    }
    return null;
  },

  // ---- recipes ----
  (s) => {
    const m =
      s.match(/^(?:set|change|switch|configure|make)\s+(?:the\s+)?recipe\s+(?:of|for|on|in)\s+(.+?)\s+(?:to|=|as)\s+(.+)$/) ??
      s.match(/^(?:set|change|switch|configure|reconfigure|retool|turn)\s+(?!up\b)(.+?)(?:'s)?\s+(?:recipe\s+)?(?:to|=|into|for)\s+(?:make\s+|making\s+|produce\s+)?(.+)$/) ??
      s.match(/^(?:make|have|let|tell|get)\s+(.+?)\s+(?:make|produce|do|run|craft|build|work on|start making|switch to)\s+(.+)$/) ??
      s.match(
        /^(?!(?:build|place|add|put|install|construct|create|set ?up|buy|get|make|order|purchase|i want|give me)\b)(.+?)\s+(?:should\s+)?(?:make|makes|produce|produces|run|runs)\s+(.+)$/,
      );
    if (m) return { op: 'set_recipe', target: m[1], recipe: m[2] };
    const u = s.match(/^(?:use|run|apply)\s+(?:recipe\s+)?(.+?)\s+(?:on|in|at|for)\s+(.+)$/);
    return u ? { op: 'set_recipe', target: u[2], recipe: u[1] } : null;
  },

  // ---- removing / selling ----
  (s, state) => {
    const m = s.match(/^(?:remove|delete|demolish|destroy|scrap|bulldoze|dismantle|tear down|get rid of|sell|trash)\s+(?:the\s+)?(.+)$/);
    if (!m) return null;
    if (s.startsWith('sell') && !isMachine(state, m[1])) return null;
    return { op: 'remove', target: m[1] };
  },
  (s) => {
    const m = s.match(
      new RegExp(String.raw`^(?:sell|liquidate|dump|offload)\s+(?:(all|everything|` + NUM + String.raw`)\s+)?(?:of\s+)?(?:the\s+|our\s+|my\s+)?(.+?)(?:\s+(all|` + NUM + '))?' + END),
    );
    if (!m) return null;
    // NUM has its own capture group: m[1]/m[2] lead quantity, m[3] item, m[4]/m[5] trailing quantity.
    const qtyText = m[1] ?? m[4];
    const qty = !qtyText || /all|everything/.test(qtyText) ? 'all' : (num(qtyText) ?? 'all');
    return { op: 'sell', item: m[3], qty };
  },

  // ---- building ----
  buildRule,
  (s) => {
    const m = s.match(new RegExp(String.raw`^(?:restock|stock up(?: on)?|import|acquire)\s+(?:` + NUM + String.raw`\s+)?(?:more\s+)?(.+?)(?:\s+` + NUM + ')?' + END));
    if (!m) return null;
    return { op: 'buy', item: m[2], qty: num(m[1] ?? m[3]) ?? DEFAULT_BUY };
  },
];

export function parseOne(segment: string, state?: GameState): Command[] | null {
  const s = clean(segment);
  if (!s) return [];
  for (const rule of RULES) {
    const r = rule(s, state);
    if (r) return Array.isArray(r) ? r : [r];
  }
  return null;
}

/** Parses a whole line, which may hold several commands ("build a mug line; buy 200 clay"). */
export function parse(text: string, state?: GameState): ParseResult {
  const commands: Command[] = [];
  const unknown: string[] = [];
  const segments = text
    .split(/\s*(?:;|\n|,?\s+and then\s+|,?\s+then\s+)\s*/i)
    .map((x) => x.trim())
    .filter(Boolean);
  for (const seg of segments) {
    // "x, y and z" is a list of commands only if every part parses on its own.
    const parts = seg.split(/\s*(?:,\s*and\s+|\s+and\s+|,\s*)\s*/i).filter(Boolean);
    const parsed = parts.length > 1 ? parts.map((p) => parseOne(p, state)) : [];
    if (parsed.length > 1 && parsed.every((p) => p !== null && p.length > 0)) {
      for (const p of parsed) commands.push(...p!);
      continue;
    }
    const whole = parseOne(seg, state);
    if (whole) commands.push(...whole);
    else unknown.push(seg);
  }
  return { commands, unknown };
}

/** Input that is only camera/time/save management skips the LLM entirely. */
export function isFastPath(cmds: Command[]): boolean {
  const fast = new Set(['camera', 'help', 'speed', 'resume', 'list_saves', 'save', 'load', 'new_game', 'autobuy']);
  return cmds.length > 0 && cmds.every((c) => fast.has(c.op));
}

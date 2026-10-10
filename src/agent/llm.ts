// LLM-backed agent: the model designs and edits the factory through fine-grained tools.
// Camera/meta commands take the parser fast path; the parser is also the fallback when
// the model is unreachable.

import type { CommandResult } from '../game/api.ts';
import { agentSummary } from '../game/report.ts';
import { ParserAgent, quickReply, type Agent, type AgentContext, type AgentReply } from './agent.ts';
import { isFastPath, parse } from './parser.ts';
import { EDIT_TOOLS, TOOLS, systemPrompt, toolToCommand } from './tools.ts';

export const MAX_ROUNDS = 30;
const TIMEOUT_MS = 120_000;
const MAX_TOKENS = 8192;
const MAX_RESULT_CHARS = 24_000;

export const DEFAULT_MODELS = {
  anthropic: 'claude-sonnet-5-5',
  openai: 'gpt-4.1-mini',
  openrouter: 'anthropic/claude-sonnet-5.5',
};

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolOutput {
  content: string;
  isError: boolean;
}

export interface Usage {
  input: number;
  output: number;
  cached: number;
  cost: number;
}

export interface RunHooks {
  exec: (call: ToolCall) => ToolOutput;
  /** Text the model writes alongside tool calls (its running commentary). */
  onText?: (text: string) => void;
}

export interface RunResult {
  text: string;
  rounds: number;
  toolCalls: number;
  usage: Usage;
  /** True when the round limit stopped the model. */
  exhausted: boolean;
}

export type HistoryItem = { role: 'user' | 'assistant'; text: string };

export interface Provider {
  readonly label: string;
  run(system: string, history: HistoryItem[], user: string, hooks: RunHooks, maxRounds: number): Promise<RunResult>;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

const emptyUsage = (): Usage => ({ input: 0, output: 0, cached: 0, cost: 0 });

export class AnthropicProvider implements Provider {
  readonly label: string;
  private key: string;
  private model: string;
  private baseUrl: string;

  constructor(key: string, model: string, baseUrl = 'https://api.anthropic.com') {
    this.key = key;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.label = model;
  }

  async run(system: string, history: HistoryItem[], user: string, hooks: RunHooks, maxRounds: number): Promise<RunResult> {
    const messages: any[] = history.map((h) => ({ role: h.role, content: h.text }));
    messages.push({ role: 'user', content: [{ type: 'text', text: user }] });
    const tools = TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    const usage = emptyUsage();
    let toolCalls = 0;
    let text = '';
    for (let round = 1; round <= maxRounds; round++) {
      // Cache the system prompt + tools, and everything up to the newest message.
      const last = messages[messages.length - 1];
      const marked = [...messages.slice(0, -1), { ...last, content: markLastBlock(last.content) }];
      const res = await postJson(
        `${this.baseUrl}/v1/messages`,
        { 'x-api-key': this.key, 'anthropic-version': '2023-06-01' },
        { model: this.model, max_tokens: MAX_TOKENS, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], tools, messages: marked },
      );
      const u = res.usage ?? {};
      usage.input += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      usage.cached += u.cache_read_input_tokens ?? 0;
      usage.output += u.output_tokens ?? 0;
      const blocks: any[] = res.content ?? [];
      text = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      const calls = blocks.filter((b) => b.type === 'tool_use');
      if (calls.length === 0) return { text, rounds: round, toolCalls, usage, exhausted: false };
      if (text) hooks.onText?.(text);
      messages.push({ role: 'assistant', content: blocks });
      const truncated = res.stop_reason === 'max_tokens';
      messages.push({
        role: 'user',
        content: calls.map((c) => {
          toolCalls++;
          const out = truncated && !c.input ? cutOff() : hooks.exec({ id: c.id, name: c.name, args: c.input ?? {} });
          return { type: 'tool_result', tool_use_id: c.id, content: out.content, ...(out.isError ? { is_error: true } : {}) };
        }),
      });
    }
    return { text, rounds: maxRounds, toolCalls, usage, exhausted: true };
  }
}

function markLastBlock(content: unknown): unknown {
  if (typeof content === 'string') return [{ type: 'text', text: content, cache_control: { type: 'ephemeral' } }];
  if (!Array.isArray(content) || content.length === 0) return content;
  const copy = [...content];
  copy[copy.length - 1] = { ...copy[copy.length - 1], cache_control: { type: 'ephemeral' } };
  return copy;
}

function cutOff(): ToolOutput {
  return { content: 'ERROR: your tool call was cut off by the output limit. Split the work into smaller batches (about 40 ops each).', isError: true };
}

/** OpenAI chat-completions compatible: OpenAI, OpenRouter, local servers. */
export class OpenAIProvider implements Provider {
  readonly label: string;
  private key: string;
  private model: string;
  private baseUrl: string;
  private vendor: string;
  /** Anthropic models behind OpenRouter honour cache_control breakpoints. */
  private caching: boolean;

  constructor(key: string, model: string, baseUrl: string, vendor: string) {
    this.key = key;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.vendor = vendor;
    this.label = model;
    this.caching = vendor === 'openrouter' && model.startsWith('anthropic/');
  }

  async run(system: string, history: HistoryItem[], user: string, hooks: RunHooks, maxRounds: number): Promise<RunResult> {
    const cached = (text: string) => (this.caching ? [{ type: 'text', text, cache_control: { type: 'ephemeral' } }] : text);
    const messages: any[] = [{ role: 'system', content: cached(system) }, ...history.map((h) => ({ role: h.role, content: h.text })), { role: 'user', content: user }];
    const tools = TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    const usage = emptyUsage();
    let toolCalls = 0;
    let text = '';
    for (let round = 1; round <= maxRounds; round++) {
      const body: Record<string, unknown> = { model: this.model, messages: this.withBreakpoint(messages), tools, max_tokens: MAX_TOKENS };
      if (this.vendor === 'openrouter') body.usage = { include: true };
      const res = await postJson(`${this.baseUrl}/chat/completions`, { authorization: `Bearer ${this.key}` }, body);
      const u = res.usage ?? {};
      usage.input += u.prompt_tokens ?? 0;
      usage.output += u.completion_tokens ?? 0;
      usage.cached += u.prompt_tokens_details?.cached_tokens ?? 0;
      usage.cost += u.cost ?? 0;
      const choice = res.choices?.[0];
      const msg = choice?.message;
      if (!msg) throw new Error(`empty response ${JSON.stringify(res).slice(0, 200)}`);
      text = (typeof msg.content === 'string' ? msg.content : '').trim();
      const calls: any[] = msg.tool_calls ?? [];
      if (calls.length === 0) return { text, rounds: round, toolCalls, usage, exhausted: false };
      if (text) hooks.onText?.(text);
      messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
      for (const c of calls) {
        toolCalls++;
        let out: ToolOutput;
        try {
          const args = JSON.parse(c.function?.arguments || '{}');
          out = hooks.exec({ id: c.id, name: c.function?.name, args });
        } catch {
          out = choice.finish_reason === 'length' ? cutOff() : { content: 'ERROR: tool arguments were not valid JSON.', isError: true };
        }
        messages.push({ role: 'tool', tool_call_id: c.id, content: out.content });
      }
    }
    return { text, rounds: maxRounds, toolCalls, usage, exhausted: true };
  }

  /** Moves a cache breakpoint onto the newest message so each round reuses the previous prefix. */
  private withBreakpoint(messages: any[]): any[] {
    if (!this.caching || messages.length < 2) return messages;
    const last = messages[messages.length - 1];
    if (typeof last.content !== 'string' || !last.content) return messages;
    return [...messages.slice(0, -1), { ...last, content: [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }] }];
  }
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}… (truncated ${s.length - n} chars; narrow the request)` : s;
}

function firstLine(s: string, n = 160): string {
  const line = s.split('\n')[0];
  return line.length > n ? `${line.slice(0, n)}…` : line;
}

function tokens(n: number): string {
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** One progress line for the player's log describing a finished tool call. */
export function describeTool(name: string, args: Record<string, unknown>, r: CommandResult): string {
  if (name === 'batch') {
    const data = r.data as { dry_run?: boolean; succeeded?: number; failed?: number; results?: { i: number; op: string; ok: boolean; message: string }[] } | undefined;
    const results = data?.results ?? [];
    const byOp: Record<string, number> = {};
    for (const x of results) if (x.ok) byOp[x.op] = (byOp[x.op] ?? 0) + 1;
    const counts = Object.entries(byOp)
      .map(([op, k]) => `${k} ${op}`)
      .join(', ');
    const fails = results.filter((x) => !x.ok).slice(0, 4).map((x) => `\n  #${x.i} ${x.op}: ${firstLine(x.message, 140)}`).join('');
    const total = results.length;
    if (!data) return `batch failed: ${firstLine(r.message)}`;
    const head = data.dry_run ? `checked a plan (dry run): ${data.succeeded}/${total} ops would succeed` : `batch: ${counts || 'nothing applied'} (${data.succeeded}/${total} ok)`;
    return head + fails;
  }
  if (!r.ok) return `${name} failed: ${firstLine(r.message)}`;
  switch (name) {
    case 'get_catalog':
      return `read the catalog${args.filter ? ` (${args.filter})` : ''}`;
    case 'find_recipes':
      return `looked up recipes for ${args.item}${args.upstream ? ' (full chain)' : ''}`;
    case 'get_state':
      return `inspected ${args.target ?? (args.x !== undefined ? 'a region' : 'the factory')}`;
    case 'find_free_area':
      return `searched for a free ${args.w}×${args.h} area → ${firstLine(r.message.replace(/^.*?:\s*/, ''), 80)}`;
    case 'view_map':
      return `looked at the map around ${args.x},${args.y}`;
    case 'diagnose': {
      const d = r.data as { errors?: number; issues?: { severity: string; text: string }[] } | undefined;
      const errs = (d?.issues ?? []).filter((i) => i.severity === 'error');
      return errs.length ? `diagnose: ${errs.length} error(s), e.g. ${firstLine(errs[0].text, 140)}` : `diagnose: ${firstLine(r.message, 120)}`;
    }
    default:
      return firstLine(r.message, 200);
  }
}

export class LlmAgent implements Agent {
  readonly name: string;
  private provider: Provider;
  private fallback = new ParserAgent();
  private history: HistoryItem[] = [];
  private system = systemPrompt();
  private maxRounds: number;

  constructor(provider: Provider, maxRounds = MAX_ROUNDS) {
    this.provider = provider;
    this.name = provider.label;
    this.maxRounds = maxRounds;
  }

  quick(text: string, ctx: AgentContext): AgentReply | null {
    return quickReply(text, ctx);
  }

  async handle(text: string, ctx: AgentContext): Promise<AgentReply> {
    const parsed = parse(text, ctx.game.state);
    if (parsed.unknown.length === 0 && isFastPath(parsed.commands)) return this.fallback.handle(text, ctx, 'fast-path');
    const started = Date.now();
    const actions: string[] = [];
    const exec = (call: ToolCall): ToolOutput => {
      let r: CommandResult;
      try {
        r = ctx.game.exec(toolToCommand(call.name, call.args ?? {}), ctx.view);
      } catch (e) {
        r = { ok: false, message: `${call.name}: ${(e as Error).message}` };
      }
      const line = describeTool(call.name, call.args ?? {}, r);
      ctx.progress?.(line);
      if (EDIT_TOOLS.has(call.name)) actions.push(line);
      const payload = JSON.stringify({ ok: r.ok, message: r.message, ...(r.data !== undefined ? { data: r.data } : {}) });
      return { content: r.ok ? clip(payload, MAX_RESULT_CHARS) : `ERROR: ${clip(payload, MAX_RESULT_CHARS)}`, isError: !r.ok };
    };
    const user = `<factory>\n${agentSummary(ctx.game.state)}\n</factory>\n\nPlayer: ${text}`;
    try {
      const run = await this.provider.run(this.system, this.history, user, { exec, onText: (t) => ctx.progress?.(`… ${firstLine(t, 220)}`) }, this.maxRounds);
      let reply = run.text || actions.slice(-3).join('\n') || 'Done.';
      if (run.exhausted) reply = `${reply}\n(Stopped after ${run.rounds} tool rounds; say "continue" to let me finish.)`;
      this.remember(text, reply);
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const cost = run.usage.cost ? ` · $${run.usage.cost.toFixed(3)}` : '';
      const via = `${this.name} · ${run.rounds} rounds · ${run.toolCalls} tools · ${tokens(run.usage.input)} in (${tokens(run.usage.cached)} cached) / ${tokens(run.usage.output)} out${cost} · ${secs}s`;
      // Failed steps the model recovered from are visible in the progress log; only a stuck run is an error.
      return { text: reply, ok: !run.exhausted, via };
    } catch (e) {
      const msg = (e as Error).message;
      // Never redo actions the model already took; only fall back when nothing happened.
      if (actions.length > 0) return { text: `${actions.join('\n')}\n(LLM stopped: ${msg.slice(0, 200)})`, ok: false, via: this.name };
      const r = await this.fallback.handle(text, ctx);
      return { ...r, text: `${r.text}\n(LLM unavailable: ${msg.slice(0, 160)}; used the built-in parser.)` };
    }
  }

  private remember(user: string, reply: string): void {
    this.history.push({ role: 'user', text: user }, { role: 'assistant', text: reply });
    if (this.history.length > 8) this.history.splice(0, this.history.length - 8);
  }
}

/** Picks the agent from the environment; the parser is used when no API key is set. */
export function createAgent(env: NodeJS.ProcessEnv = process.env): Agent {
  const choice = (env.SLOPTORY_AGENT ?? 'auto').toLowerCase();
  if (choice === 'parser') return new ParserAgent();
  const model = env.SLOPTORY_MODEL;
  if ((choice === 'auto' || choice === 'anthropic') && env.ANTHROPIC_API_KEY) {
    return new LlmAgent(new AnthropicProvider(env.ANTHROPIC_API_KEY, model ?? DEFAULT_MODELS.anthropic, env.ANTHROPIC_BASE_URL));
  }
  if ((choice === 'auto' || choice === 'openai') && env.OPENAI_API_KEY) {
    return new LlmAgent(new OpenAIProvider(env.OPENAI_API_KEY, model ?? DEFAULT_MODELS.openai, env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1', 'openai'));
  }
  if ((choice === 'auto' || choice === 'openrouter') && env.OPENROUTER_API_KEY) {
    return new LlmAgent(new OpenAIProvider(env.OPENROUTER_API_KEY, model ?? DEFAULT_MODELS.openrouter, 'https://openrouter.ai/api/v1', 'openrouter'));
  }
  return new ParserAgent();
}

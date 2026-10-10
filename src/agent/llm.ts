// LLM-backed agent: tool calling against the engine API, with the parser as fast path
// for camera/meta commands and as fallback when the model is unreachable.

import { agentSummary } from '../game/report.ts';
import { ParserAgent, type Agent, type AgentContext, type AgentReply } from './agent.ts';
import { isFastPath, parse } from './parser.ts';
import { TOOLS, systemPrompt, toolToCommand } from './tools.ts';

const MAX_ROUNDS = 8;
const TIMEOUT_MS = 60_000;

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

type Exec = (call: ToolCall) => string;

export interface Provider {
  readonly label: string;
  /** Runs one player request to completion, calling `exec` for every tool call. */
  run(system: string, history: { role: 'user' | 'assistant'; text: string }[], user: string, exec: Exec): Promise<string>;
}

async function postJson(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

export class AnthropicProvider implements Provider {
  readonly label: string;
  private key: string;
  private model: string;
  private baseUrl: string;

  constructor(key: string, model: string, baseUrl = 'https://api.anthropic.com') {
    this.key = key;
    this.model = model;
    this.baseUrl = baseUrl;
    this.label = `${model} (anthropic)`;
  }

  async run(system: string, history: { role: 'user' | 'assistant'; text: string }[], user: string, exec: Exec): Promise<string> {
    const messages: any[] = history.map((h) => ({ role: h.role, content: h.text }));
    messages.push({ role: 'user', content: user });
    const tools = TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    let finalText = '';
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await postJson(
        `${this.baseUrl}/v1/messages`,
        { 'x-api-key': this.key, 'anthropic-version': '2023-06-01' },
        { model: this.model, max_tokens: 1024, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], tools, messages },
      );
      const blocks: any[] = res.content ?? [];
      finalText = blocks
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      const calls = blocks.filter((b) => b.type === 'tool_use');
      if (calls.length === 0) return finalText;
      messages.push({ role: 'assistant', content: blocks });
      messages.push({
        role: 'user',
        content: calls.map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: exec({ id: c.id, name: c.name, args: c.input ?? {} }) })),
      });
    }
    return finalText || 'Done.';
  }
}

/** OpenAI chat-completions compatible (OpenAI, OpenRouter, local servers). */
export class OpenAIProvider implements Provider {
  readonly label: string;
  private key: string;
  private model: string;
  private baseUrl: string;

  constructor(key: string, model: string, baseUrl: string, vendor: string) {
    this.key = key;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.label = `${model} (${vendor})`;
  }

  async run(system: string, history: { role: 'user' | 'assistant'; text: string }[], user: string, exec: Exec): Promise<string> {
    const messages: any[] = [{ role: 'system', content: system }, ...history.map((h) => ({ role: h.role, content: h.text })), { role: 'user', content: user }];
    const tools = TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    let finalText = '';
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const res = await postJson(`${this.baseUrl}/chat/completions`, { authorization: `Bearer ${this.key}` }, { model: this.model, messages, tools, max_tokens: 1024 });
      const msg = res.choices?.[0]?.message;
      if (!msg) throw new Error('empty response');
      finalText = (msg.content ?? '').trim();
      const calls: any[] = msg.tool_calls ?? [];
      if (calls.length === 0) return finalText;
      messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
      for (const c of calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(c.function?.arguments || '{}');
        } catch {
          // Leave args empty; the engine reports what is missing.
        }
        messages.push({ role: 'tool', tool_call_id: c.id, content: exec({ id: c.id, name: c.function?.name, args }) });
      }
    }
    return finalText || 'Done.';
  }
}

export class LlmAgent implements Agent {
  readonly name: string;
  private provider: Provider;
  private fallback = new ParserAgent();
  private history: { role: 'user' | 'assistant'; text: string }[] = [];
  private system = systemPrompt();

  constructor(provider: Provider) {
    this.provider = provider;
    this.name = provider.label;
  }

  async handle(text: string, ctx: AgentContext): Promise<AgentReply> {
    const quick = parse(text, ctx.game.state);
    if (quick.unknown.length === 0 && isFastPath(quick.commands)) return this.fallback.handle(text, ctx, 'fast-path');
    const actions: string[] = [];
    let allOk = true;
    const exec: Exec = (call) => {
      let message: string;
      try {
        const r = ctx.game.exec(toolToCommand(call.name, call.args), ctx.view);
        if (!r.ok) allOk = false;
        message = (r.ok ? '' : 'FAILED: ') + r.message;
      } catch (e) {
        allOk = false;
        message = `FAILED: ${(e as Error).message}`;
      }
      if (call.name !== 'query') actions.push(message);
      return message;
    };
    const user = `<factory>\n${agentSummary(ctx.game.state)}\n</factory>\n\nPlayer: ${text}`;
    try {
      const reply = await this.provider.run(this.system, this.history, user, exec);
      this.remember(text, reply);
      return { text: reply || actions.join('\n') || 'Done.', ok: allOk, via: this.name };
    } catch (e) {
      // Model unreachable: fall back to the parser, but never redo actions already taken.
      if (actions.length > 0) return { text: `${actions.join('\n')}\n(LLM stopped: ${(e as Error).message})`, ok: false, via: this.name };
      const r = await this.fallback.handle(text, ctx);
      return { ...r, text: `${r.text}\n(LLM unavailable: ${(e as Error).message.slice(0, 120)}; used the built-in parser.)` };
    }
  }

  private remember(user: string, reply: string): void {
    this.history.push({ role: 'user', text: user }, { role: 'assistant', text: reply || 'Done.' });
    if (this.history.length > 8) this.history.splice(0, this.history.length - 8);
  }
}

/** Picks the agent from the environment; the parser is used when no API key is set. */
export function createAgent(env: NodeJS.ProcessEnv = process.env): Agent {
  const choice = (env.SLOPTORY_AGENT ?? 'auto').toLowerCase();
  if (choice === 'parser') return new ParserAgent();
  const model = env.SLOPTORY_MODEL;
  if ((choice === 'auto' || choice === 'anthropic') && env.ANTHROPIC_API_KEY) {
    return new LlmAgent(new AnthropicProvider(env.ANTHROPIC_API_KEY, model ?? 'claude-sonnet-4-5', env.ANTHROPIC_BASE_URL));
  }
  if ((choice === 'auto' || choice === 'openai') && env.OPENAI_API_KEY) {
    return new LlmAgent(new OpenAIProvider(env.OPENAI_API_KEY, model ?? 'gpt-4.1-mini', env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1', 'openai'));
  }
  if ((choice === 'auto' || choice === 'openrouter') && env.OPENROUTER_API_KEY) {
    return new LlmAgent(new OpenAIProvider(env.OPENROUTER_API_KEY, model ?? 'anthropic/claude-sonnet-4.5', 'https://openrouter.ai/api/v1', 'openrouter'));
  }
  return new ParserAgent();
}

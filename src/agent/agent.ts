// Agents turn player text into engine commands. Every agent goes through Game.exec().

import type { ClientView, Command, CommandResult } from '../game/api.ts';
import type { Game } from '../game/game.ts';
import { isFastPath, parse } from './parser.ts';

export interface AgentContext {
  game: Game;
  view: ClientView;
  /** Live progress lines while the agent works (shown in the player's log). */
  progress?: (text: string) => void;
}

export interface AgentReply {
  text: string;
  ok: boolean;
  /** Which agent answered: "parser", "fast-path", or the LLM label (with run stats). */
  via: string;
}

export interface Agent {
  readonly name: string;
  handle(text: string, ctx: AgentContext): Promise<AgentReply>;
  /** Answers instantly (camera, speed, help, save…) without queueing behind slow requests; null if it can't. */
  quick?(text: string, ctx: AgentContext): AgentReply | null;
}

export function runCommands(cmds: Command[], ctx: AgentContext): CommandResult[] {
  return cmds.map((c) => ctx.game.exec(c, ctx.view));
}

const NOT_QUICK = new Set(['load', 'new_game']);

/** Fast-path input handled by the parser, except commands that replace the whole world. */
export function quickReply(text: string, ctx: AgentContext): AgentReply | null {
  const { commands, unknown } = parse(text, ctx.game.state);
  if (unknown.length > 0 || !isFastPath(commands) || commands.some((c) => NOT_QUICK.has(c.op))) return null;
  const results = runCommands(commands, ctx);
  return { text: results.map((r) => r.message).join('\n'), ok: results.every((r) => r.ok), via: 'fast-path' };
}

/** The built-in, offline agent: deterministic parsing, no model. */
export class ParserAgent implements Agent {
  readonly name = 'parser';

  quick(text: string, ctx: AgentContext): AgentReply | null {
    return quickReply(text, ctx);
  }

  async handle(text: string, ctx: AgentContext, via = 'parser'): Promise<AgentReply> {
    const { commands, unknown } = parse(text, ctx.game.state);
    const results = runCommands(commands, ctx);
    const lines = results.map((r) => r.message);
    if (unknown.length > 0) {
      lines.push(
        `I didn't understand "${unknown.join('", "')}". Try things like "build a mug line", "buy 200 clay", "connect kiln 1 to qa 1", "diagnose", or "help".`,
      );
    }
    return { text: lines.join('\n'), ok: unknown.length === 0 && results.every((r) => r.ok), via };
  }
}

// Agents turn player text into engine commands. Every agent goes through Game.exec().

import type { ClientView, Command, CommandResult } from '../game/api.ts';
import type { Game } from '../game/game.ts';
import { parse } from './parser.ts';

export interface AgentContext {
  game: Game;
  view: ClientView;
}

export interface AgentReply {
  text: string;
  ok: boolean;
  /** Which agent answered: "parser", "fast-path", or the LLM label. */
  via: string;
}

export interface Agent {
  readonly name: string;
  handle(text: string, ctx: AgentContext): Promise<AgentReply>;
}

export function runCommands(cmds: Command[], ctx: AgentContext): CommandResult[] {
  return cmds.map((c) => ctx.game.exec(c, ctx.view));
}

/** The built-in, offline agent: deterministic parsing, no model. */
export class ParserAgent implements Agent {
  readonly name = 'parser';

  async handle(text: string, ctx: AgentContext, via = 'parser'): Promise<AgentReply> {
    const { commands, unknown } = parse(text, ctx.game.state);
    const results = runCommands(commands, ctx);
    const lines = results.map((r) => r.message);
    if (unknown.length > 0) {
      lines.push(
        `I didn't understand "${unknown.join('", "')}". Try things like "build a mug line", "buy 200 clay", "connect kiln 1 to qa 1", "left 10", or "help".`,
      );
    }
    return { text: lines.join('\n'), ok: unknown.length === 0 && results.every((r) => r.ok), via };
  }
}

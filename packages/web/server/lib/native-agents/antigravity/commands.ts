import { NativeAgentError } from '../errors.js';
import type { PromptPart } from '../prompt-parts.js';

export type { PromptPart as AgyPromptPart };

export interface AgySkillCommand {
  name: string;
  description: string;
  argumentHint: string;
}

export interface AgyCommandListResult {
  commands: AgySkillCommand[];
}

export interface AgyCommandsDependencies {
  readSkills: (directory: string) => Promise<string>;
  now?: (() => number) | undefined;
}

export interface AgyCommandsController {
  list: (directory: string, options?: { fresh?: boolean | undefined }) => Promise<AgyCommandListResult>;
  promptParts: (parts: PromptPart[], directory: string) => Promise<PromptPart[]>;
}

const CACHE_MS = 10 * 60_000;
const CACHE_DIRECTORIES = 64;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_:-]*$/;

const commandOf = (text: string): { name: string; arguments: string } | null => {
  const match = /^\/([a-zA-Z0-9][a-zA-Z0-9_:-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const name = match?.[1];
  return name ? { name, arguments: match[2]?.trim() ?? '' } : null;
};

const parseSkills = (output: string): AgyCommandListResult => {
  const commands = new Map<string, AgySkillCommand>();
  for (const line of output.split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const name = line.slice(0, tab).trim();
    if (!NAME.test(name) || commands.has(name)) continue;
    commands.set(name, { name, description: line.slice(tab + 1).trim(), argumentHint: '' });
  }
  if (!commands.size && output.trim()) {
    throw new NativeAgentError('Antigravity skill discovery returned an unreadable listing', {
      code: 'NATIVE_ANTIGRAVITY_COMMANDS_UNAVAILABLE',
      status: 502,
    });
  }
  return { commands: [...commands.values()] };
};

export const createAntigravityCommands = ({
  readSkills,
  now = Date.now,
}: AgyCommandsDependencies): AgyCommandsController => {
  const cache = new Map<string, { at: number; result: Promise<AgyCommandListResult> }>();
  const list = async (directory: string, { fresh = false }: { fresh?: boolean | undefined } = {}): Promise<AgyCommandListResult> => {
    const held = cache.get(directory);
    if (!fresh && held && now() - held.at < CACHE_MS) return held.result;
    const entry = { at: now(), result: Promise.resolve().then(() => readSkills(directory)).then(parseSkills) };
    cache.delete(directory);
    cache.set(directory, entry);
    if (cache.size > CACHE_DIRECTORIES) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    try {
      return await entry.result;
    } catch (error) {
      if (cache.get(directory) === entry) cache.delete(directory);
      throw error;
    }
  };
  return {
    list,
    async promptParts(parts, directory) {
      const first = parts[0];
      const command = first?.type === 'text' ? commandOf(first.text) : null;
      if (!command || !first || first.type !== 'text') return parts;
      const { commands } = await list(directory, { fresh: true });
      const skill = commands.find((item) => item.name === command.name);
      if (!skill) {
        throw new NativeAgentError(`/${command.name} is not an available Antigravity skill. Choose a skill from the command menu.`, {
          code: 'NATIVE_ANTIGRAVITY_COMMAND_UNSUPPORTED',
          status: 400,
        });
      }
      return [
        {
          ...first,
          text: `Use the "${skill.name}" skill. Read and follow its instructions before handling this request.${command.arguments ? `\n\n${command.arguments}` : ''}`,
        },
        ...parts.slice(1),
      ];
    },
  };
};

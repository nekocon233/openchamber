import { z } from 'zod';

import { invalidRequestError, NativeAgentError } from '../errors.js';
import { codexPromptInput } from '../prompt-parts.js';
import type { JsonRpcRequest } from './rpc.js';

const skillSchema = z.object({
  name: z.string(),
  path: z.string(),
  description: z.string(),
  shortDescription: z.string().nullish(),
  enabled: z.boolean(),
});
const skillsResponse = z.object({
  data: z.array(z.object({
    cwd: z.string(),
    skills: z.array(skillSchema),
    errors: z.array(z.object({ path: z.string(), message: z.string() })),
  })),
});
const mcpPage = z.object({
  data: z.array(z.object({
    name: z.string(),
    authStatus: z.string(),
    tools: z.record(z.string(), z.object({ name: z.string(), description: z.string().optional() })),
    serverInfo: z.object({ name: z.string(), version: z.string() }).nullish(),
    toolsError: z.string().nullish(),
  })),
  nextCursor: z.string().nullish(),
});
const terminalPage = z.object({
  data: z.array(z.object({ processId: z.string(), command: z.string(), cwd: z.string() })),
  nextCursor: z.string().nullish(),
});

const slashCommand = /^\/([a-zA-Z][a-zA-Z0-9_:-]*)(?:\s+([\s\S]*))?$/;

export interface ParsedCodexCommand {
  name: string;
  argument: string;
}

export interface CodexCommandListItem {
  name: string;
  description: string;
  argumentHint: string;
}

export type CodexCommandInspectEntry = {
  label: string;
  detail: string;
  command?: string;
};

export interface CodexCommandInspectInput {
  name: string;
  directory: string;
  threadId?: string | undefined;
  verbose?: boolean | undefined;
}

export interface CodexCommandsOptions {
  request: JsonRpcRequest;
}

export const parseCodexCommand = (text: string): ParsedCodexCommand | null => {
  const match = slashCommand.exec(text.trim());
  const name = match?.[1];
  return name ? { name, argument: match[2]?.trim() ?? '' } : null;
};

export const createCodexCommands = ({ request }: CodexCommandsOptions) => {
  const skills = async (directory: string) => {
    const result = skillsResponse.parse(await request('skills/list', { cwds: [directory], forceReload: true }));
    const entry = result.data[0];
    if (result.data.length !== 1 || !entry) throw invalidRequestError('Codex did not return the requested directory’s skills');
    return entry;
  };

  return {
    async list(directory: string): Promise<{ commands: CodexCommandListItem[]; warnings: string[] }> {
      const entry = await skills(directory);
      return {
        commands: entry.skills.filter((skill) => skill.enabled).map((skill) => ({
          name: skill.name,
          description: skill.shortDescription || skill.description,
          argumentHint: '',
        })),
        warnings: entry.errors.map((error) => `${error.path}: ${error.message}`),
      };
    },

    async promptInput(parts: Parameters<typeof codexPromptInput>[0], directory: string) {
      const first = parts[0];
      const command = first?.type === 'text' ? parseCodexCommand(first.text) : null;
      if (!command) return codexPromptInput(parts);
      if (command.name === 'init') {
        return codexPromptInput([
          { type: 'text', text: `Create or update AGENTS.md with concise instructions for agents working in this directory. Inspect the repository and its existing instructions first. Document relevant build, test, and coding conventions using the actual project configuration. Preserve existing guidance that still applies.${command.argument ? `\n\n${command.argument}` : ''}` },
          ...parts.slice(1),
        ]);
      }
      const entry = await skills(directory);
      const skill = entry.skills.find((item) => item.enabled && item.name === command.name);
      if (!skill) throw new NativeAgentError(
        `/${command.name} is not an available Codex skill. Use the command menu for supported actions; terminal-only commands must run in Codex CLI.`,
        { code: 'NATIVE_CODEX_COMMAND_UNSUPPORTED', status: 400 },
      );
      return [
        ...codexPromptInput([{ type: 'text', text: `$${skill.name}${command.argument ? ` ${command.argument}` : ''}` }, ...parts.slice(1)]),
        { type: 'skill' as const, name: skill.name, path: skill.path },
      ];
    },

    async inspect({ name, directory, threadId, verbose = false }: CodexCommandInspectInput): Promise<{ entries: CodexCommandInspectEntry[]; notices: string[] }> {
      if (name === 'skills') {
        const entry = await skills(directory);
        return {
          entries: entry.skills.filter((skill) => skill.enabled).map((skill) => ({
            label: skill.name,
            detail: skill.shortDescription || skill.description,
            command: `/${skill.name} `,
          })),
          notices: entry.errors.map((error) => `${error.path}: ${error.message}`),
        };
      }
      if (!threadId) throw invalidRequestError(`/${name} requires a Codex session`);
      if (name === 'mcp') {
        const entries: CodexCommandInspectEntry[] = [];
        let cursor: string | null | undefined;
        do {
          const page = mcpPage.parse(await request('mcpServerStatus/list', { cursor, limit: 100, threadId, detail: 'toolsAndAuthOnly' }));
          entries.push(...page.data.map((server) => ({
            label: server.name,
            detail: [
              server.authStatus,
              verbose && server.serverInfo ? `${server.serverInfo.name} ${server.serverInfo.version}` : null,
              ...Object.entries(server.tools).map(([toolName, tool]) => verbose && tool.description ? `${toolName}: ${tool.description}` : toolName),
              server.toolsError,
            ].filter((line): line is string => Boolean(line)).join('\n'),
          })));
          cursor = page.nextCursor;
        } while (cursor);
        return { entries, notices: [] };
      }
      if (name === 'stop') {
        await request('thread/backgroundTerminals/clean', { threadId });
        return { entries: [], notices: [] };
      }
      if (name === 'ps') {
        const entries: CodexCommandInspectEntry[] = [];
        let cursor: string | null | undefined;
        do {
          const page = terminalPage.parse(await request('thread/backgroundTerminals/list', { threadId, cursor, limit: 100 }));
          entries.push(...page.data.map((terminal) => ({ label: terminal.processId, detail: `${terminal.command}\n${terminal.cwd}` })));
          cursor = page.nextCursor;
        } while (cursor);
        return { entries, notices: [] };
      }
      throw invalidRequestError(`Unsupported Codex command: /${name}`);
    },
  };
};

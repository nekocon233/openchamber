import type { I18nKey } from '@/lib/i18n';
import type { NativeCodexReviewTarget } from '@/lib/api/types';

// Commands implemented by the composer. Skills are discovered separately
// through app-server; both paths keep Codex commands out of ordinary prompts.
export const CODEX_COMPOSER_COMMANDS = [
  { name: 'model', descriptionKey: 'chat.modelControls.selectModel' },
  { name: 'reasoning', descriptionKey: 'chat.modelControls.thinking' },
  { name: 'fast', descriptionKey: 'chat.codexCommand.fast' },
  { name: 'plan', descriptionKey: 'chat.codexCommand.plan' },
  { name: 'new', descriptionKey: 'sessions.sidebar.header.actions.newSession' },
  { name: 'clear', descriptionKey: 'sessions.sidebar.header.actions.newSession' },
  { name: 'resume', descriptionKey: 'chat.codexCommand.resume' },
  { name: 'fork', descriptionKey: 'chat.codexCommand.fork' },
  { name: 'rename', descriptionKey: 'sessions.sidebar.session.menu.rename' },
  { name: 'status', descriptionKey: 'chat.codexCommand.status' },
  { name: 'skills', descriptionKey: 'chat.codexCommand.skills' },
  { name: 'mcp', descriptionKey: 'chat.codexCommand.mcp' },
  { name: 'ps', descriptionKey: 'chat.codexCommand.ps' },
  { name: 'stop', descriptionKey: 'chat.codexCommand.stop' },
  { name: 'review', descriptionKey: 'chat.codexCommand.review' },
  { name: 'init', descriptionKey: 'chat.commandAutocomplete.command.initDescription' },
  { name: 'side', descriptionKey: 'chat.commandAutocomplete.command.btwDescription' },
  { name: 'copy', descriptionKey: 'chat.messageBody.actions.copyAnswer' },
  { name: 'diff', descriptionKey: 'chat.codexCommand.diff' },
  { name: 'mention', descriptionKey: 'chat.codexCommand.mention' },
  { name: 'agent', descriptionKey: 'chat.codexCommand.agents' },
  { name: 'subagents', descriptionKey: 'chat.codexCommand.agents' },
  { name: 'archive', descriptionKey: 'sessions.sidebar.nav.archive' },
  { name: 'exit', descriptionKey: 'dialog.common.actions.close' },
  { name: 'quit', descriptionKey: 'dialog.common.actions.close' },
] as const satisfies ReadonlyArray<{ name: string; descriptionKey: I18nKey }>;

type CodexComposerCommandName = typeof CODEX_COMPOSER_COMMANDS[number]['name'];
export type CodexComposerCommand = { name: CodexComposerCommandName; argument: string };

export const CODEX_COMMAND_USAGE = new Map<CodexComposerCommandName, string>([
  ['model', '/model [model-id] [effort]'],
  ['reasoning', '/reasoning [effort]'],
  ['fast', '/fast [on|off]'],
  ['plan', '/plan [prompt]'],
  ['rename', '/rename <title>'],
  ['resume', '/resume [thread-id]'],
  ['review', '/review [--base <branch> | --commit <sha> | instructions]'],
  ['mention', '/mention [path]'],
  ['mcp', '/mcp [verbose]'],
]);

export const parseCodexComposerCommand = (text: string): CodexComposerCommand | null => {
  const match = /^\/([a-z][a-z0-9-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const definition = CODEX_COMPOSER_COMMANDS.find((command) => command.name === match[1]);
  return definition ? { name: definition.name, argument: match[2]?.trim() ?? '' } : null;
};

export const codexReviewTarget = (argument: string): NativeCodexReviewTarget | null => {
  if (!argument) return { type: 'uncommittedChanges' };
  const base = /^--base\s+(\S+)$/.exec(argument);
  if (base) return { type: 'baseBranch', branch: base[1] };
  const commit = /^--commit\s+([a-fA-F0-9]{7,64})$/.exec(argument);
  if (commit) return { type: 'commit', sha: commit[1] };
  if (argument.startsWith('--')) return null;
  return { type: 'custom', instructions: argument };
};

/** Fast is a service tier, independent of the reasoning effort. */
export const codexFastVariant = (variants: string[], current: string | undefined, argument: string): string | null => {
  if (argument !== '' && argument !== 'on' && argument !== 'off') return null;
  const enabled = argument === 'on' || (argument === '' && !current?.endsWith('-fast'));
  const effort = current?.replace(/-fast$/, '');
  if (!effort) return null;
  const next = enabled ? `${effort}-fast` : effort;
  return variants.includes(next) ? next : null;
};

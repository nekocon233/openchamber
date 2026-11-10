import { NativeAgentError } from '../errors.js';

const CACHE_MS = 10 * 60_000;
const CACHE_DIRECTORIES = 64;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_:-]*$/;
const commandOf = (text) => {
  const match = /^\/([a-zA-Z0-9][a-zA-Z0-9_:-]*)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1], arguments: match[2]?.trim() ?? '' } : null;
};

const parseSkills = (output) => {
  const commands = new Map();
  for (const line of output.split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    const name = line.slice(0, tab).trim();
    if (!NAME.test(name) || commands.has(name)) continue;
    commands.set(name, { name, description: line.slice(tab + 1).trim(), argumentHint: '' });
  }
  if (!commands.size && output.trim()) throw new NativeAgentError('Antigravity skill discovery returned an unreadable listing', {
    code: 'NATIVE_ANTIGRAVITY_COMMANDS_UNAVAILABLE', status: 502,
  });
  return { commands: [...commands.values()] };
};

/** Discovery is local to the CLI; submission always rechecks the current skill list. */
export const createAntigravityCommands = ({ readSkills, now = Date.now }) => {
  const cache = new Map();
  const list = async (directory, { fresh = false } = {}) => {
    const held = cache.get(directory);
    if (!fresh && held && now() - held.at < CACHE_MS) return held.result;
    const entry = { at: now(), result: Promise.resolve().then(() => readSkills(directory)).then(parseSkills) };
    cache.delete(directory);
    cache.set(directory, entry);
    if (cache.size > CACHE_DIRECTORIES) cache.delete(cache.keys().next().value);
    try { return await entry.result; }
    catch (error) {
      if (cache.get(directory) === entry) cache.delete(directory);
      throw error;
    }
  };
  return {
    list,
    async promptParts(parts, directory) {
      const command = parts[0]?.type === 'text' ? commandOf(parts[0].text) : null;
      if (!command) return parts;
      const { commands } = await list(directory, { fresh: true });
      const skill = commands.find((item) => item.name === command.name);
      if (!skill) throw new NativeAgentError(`/${command.name} is not an available Antigravity skill. Choose a skill from the command menu.`, {
        code: 'NATIVE_ANTIGRAVITY_COMMAND_UNSUPPORTED', status: 400,
      });
      return [{ ...parts[0], text: `Use the "${skill.name}" skill. Read and follow its instructions before handling this request.${command.arguments ? `\n\n${command.arguments}` : ''}` }, ...parts.slice(1)];
    },
  };
};

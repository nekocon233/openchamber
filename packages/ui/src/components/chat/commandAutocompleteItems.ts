import { fuzzyMatch } from '@/lib/utils';
import { rankByQuery } from '@/lib/search/fuzzySearch';

export interface CommandAutocompleteSearchItem {
  name: string;
  description?: string;
  searchAliases?: string[];
  isBuiltIn?: boolean;
}

function addSearchAliases<T extends CommandAutocompleteSearchItem>(winner: T, duplicate: T): T {
  const existingAliases = winner.searchAliases ?? [];
  const aliases = [
    ...existingAliases,
    ...(winner.name === duplicate.name ? [] : [duplicate.name]),
    ...(duplicate.description ? [duplicate.description] : []),
    ...(duplicate.searchAliases ?? []),
  ].filter((alias, index, values) => alias !== winner.description && values.indexOf(alias) === index);
  const unchanged = aliases.length === existingAliases.length
    && aliases.every((alias, index) => alias === existingAliases[index]);

  return unchanged ? winner : { ...winner, searchAliases: aliases };
}

/**
 * Precedence is built-in command, then custom/plugin command. Identity matches
 * session.command's case-sensitive lookup.
 */
export function mergeCommandAutocompleteItems<T extends CommandAutocompleteSearchItem>(
  builtIns: T[],
  commands: T[],
): T[] {
  const merged: T[] = [];
  const byName = new Map<string, { index: number; item: T; precedence: number }>();

  const addItems = (items: T[], getPrecedence: (item: T) => number) => {
    for (const item of items) {
      const precedence = getPrecedence(item);
      const identity = item.name;
      const existing = byName.get(identity);
      if (!existing) {
        byName.set(identity, { index: merged.length, item, precedence });
        merged.push(item);
        continue;
      }

      const winner = precedence > existing.precedence
        ? addSearchAliases(item, existing.item)
        : addSearchAliases(existing.item, item);
      merged[existing.index] = winner;
      byName.set(identity, {
        index: existing.index,
        item: winner,
        precedence: Math.max(existing.precedence, precedence),
      });
    }
  };

  addItems(builtIns, () => 1);
  addItems(commands, (item) => item.isBuiltIn ? 1 : 0);
  return merged;
}

export function commandMatchesSearch(command: CommandAutocompleteSearchItem, query: string): boolean {
  return fuzzyMatch(command.name, query)
    || Boolean(command.description && fuzzyMatch(command.description, query))
    || Boolean(command.searchAliases?.some((alias) => fuzzyMatch(alias, query)));
}

export function rankCommandAutocompleteItems<T extends CommandAutocompleteSearchItem>(
  commands: T[],
  query: string,
): T[] {
  const filtered = query
    ? commands.filter((command) => commandMatchesSearch(command, query))
    : [...commands];

  filtered.sort((a, b) => a.name.localeCompare(b.name));
  if (!query) return filtered;

  const rankedByName = rankByQuery(filtered, query, (command) => [command.name]);
  const matchedNames = new Set(rankedByName);
  return [...rankedByName, ...filtered.filter((command) => !matchedNames.has(command))];
}

/**
 * The command picker of a native CLI session: the commands the composer runs
 * itself (its `/compact` runs the CLI's compaction), then the CLI's own
 * commands except those a composer command of the same name shadows. Commands
 * whose name starts with the query come first, then by name.
 */
export function orderNativeCommandItems<T extends CommandAutocompleteSearchItem>(local: T[], cliCommands: T[], query: string): T[] {
  const localNames = new Set(local.map((command) => command.name));
  const items = [...local, ...cliCommands.filter((command) => !localNames.has(command.name))];
  const matching = query ? items.filter((item) => commandMatchesSearch(item, query)) : items;
  const prefix = query.toLowerCase();
  return matching.sort((a, b) => {
    const aStarts = a.name.toLowerCase().startsWith(prefix);
    const bStarts = b.name.toLowerCase().startsWith(prefix);
    if (aStarts !== bStarts) return aStarts ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

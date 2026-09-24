// OpenChamber's global AGENTS.md, the file its Behavior settings edit and
// OpenCode reads as global rules, reaches native CLI sessions too: appended to
// Claude Code's system prompt, and given to Codex as developer instructions.
// It is read when a CLI session starts or resumes, so an edit applies from the
// next start. A missing, empty or unreadable file adds nothing.

import fs from 'node:fs';

/**
 * @param {{ filePath: string, readFile?: (filePath: string) => Promise<string> }} options
 * @returns {() => Promise<string | null>} the instructions in OpenCode's
 *   `Instructions from: <path>` form, or null when there are none
 */
export const createGlobalInstructionsReader = ({ filePath, readFile = (target) => fs.promises.readFile(target, 'utf8') }) => async () => {
  let content;
  try {
    content = await readFile(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn('[native-agents] could not read the global AGENTS.md:', error instanceof Error ? error.message : error);
    }
    return null;
  }
  const text = content.trim();
  return text ? `Instructions from: ${filePath}\n${text}` : null;
};

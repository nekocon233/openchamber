import fs from 'node:fs';

export interface GlobalInstructionsReaderOptions {
  filePath: string;
  readFile?: ((filePath: string) => Promise<string>) | undefined;
}

const hasErrorCode = (value: unknown): value is { code?: unknown } => value !== null && typeof value === 'object';

export const createGlobalInstructionsReader = ({
  filePath,
  readFile = (target: string) => fs.promises.readFile(target, 'utf8'),
}: GlobalInstructionsReaderOptions): (() => Promise<string | null>) => async () => {
  let content: string;
  try {
    content = await readFile(filePath);
  } catch (error) {
    if (!hasErrorCode(error) || error.code !== 'ENOENT') {
      console.warn('[native-agents] could not read the global AGENTS.md:', error instanceof Error ? error.message : error);
    }
    return null;
  }
  const text = content.trim();
  return text ? `Instructions from: ${filePath}\n${text}` : null;
};

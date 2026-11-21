type PrRowTarget = 'context-panel' | 'changes' | 'browser';

export const resolvePrRowTarget = (input: {
  directory: string | null;
  prUrl: string | null;
  mobile: boolean;
  vscode: boolean;
}): PrRowTarget | null => {
  if (!input.directory) return null;
  if (input.vscode) return input.prUrl ? 'browser' : null;
  if (input.mobile) return 'changes';
  return 'context-panel';
};

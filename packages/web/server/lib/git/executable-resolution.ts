import fs from 'fs';
import path from 'path';

export const isExecutableFile = (candidate: string | null): candidate is string => {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    return false;
  }
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform === 'win32') {
      const ext = path.extname(candidate).toLowerCase();
      return ext.length === 0 || ext === '.exe' || ext === '.cmd' || ext === '.bat' || ext === '.com';
    }
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

export const normalizeGitExecutableCandidate = (candidate: string) => {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return null;
  }

  const ext = path.extname(trimmed).toLowerCase();
  if (ext === '.cmd' || ext === '.bat' || ext === '.com') {
    const exeCandidate = trimmed.slice(0, -ext.length) + '.exe';
    if (isExecutableFile(exeCandidate)) {
      return exeCandidate;
    }
  }

  return trimmed;
};

export const listPathExecutableCandidates = (binaryName: string) => {
  const currentPath = process.env.PATH || '';
  const seen = new Set<string>();
  const matches = [];
  for (const segment of currentPath.split(path.delimiter)) {
    const dir = segment.trim();
    if (!dir || seen.has(dir)) {
      continue;
    }
    seen.add(dir);
    matches.push(path.join(dir, binaryName));
  }
  return matches;
};

export const listWindowsGitInstallCandidates = () => {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.LocalAppData,
  ]
    .map((value) => (isPrimitiveString(value) ? value.trim() : ''))
    .filter(Boolean);

  const candidates = [];
  for (const root of roots) {
    candidates.push(path.join(root, 'Git', 'cmd', 'git.exe'));
    candidates.push(path.join(root, 'Git', 'bin', 'git.exe'));
    candidates.push(path.join(root, 'Git', 'mingw64', 'bin', 'git.exe'));
    candidates.push(path.join(root, 'Programs', 'Git', 'cmd', 'git.exe'));
    candidates.push(path.join(root, 'Programs', 'Git', 'bin', 'git.exe'));
  }
  return candidates;
};

export const resolveExplicitGitBinary = () => {
  const explicit = [process.env.GIT_BINARY, process.env.OPENCHAMBER_GIT_BINARY]
    .map((value) => (isPrimitiveString(value) ? value.trim() : ''))
    .filter(Boolean);
  for (const candidate of explicit) {
    const normalized = normalizeGitExecutableCandidate(candidate);
    if (isExecutableFile(normalized)) {
      return normalized;
    }
  }
  return null;
};

export const isPrimitiveString = (value: unknown): value is string => typeof value === 'string';

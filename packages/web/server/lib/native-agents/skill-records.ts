import path from 'node:path';
import { buildToolPart } from './records.js';
import type { NativeToolPart } from './records.js';

export interface BuildSkillReadPartInput {
  filePath: string;
  cwd?: string | undefined;
  id: string;
  sessionID: string;
  messageID: string;
  start: number;
  end: number;
}

const skillManifest = (filePath: string): { name: string; dir: string } | null => {
  const match = /(?:^|[\\/])([^\\/]+)[\\/]SKILL\.md$/i.exec(filePath);
  const name = match?.[1];
  return name ? { name, dir: filePath.replace(/[\\/]SKILL\.md$/i, '') } : null;
};

export const buildSkillReadPart = ({
  filePath,
  cwd,
  id,
  sessionID,
  messageID,
  start,
  end,
}: BuildSkillReadPartInput): NativeToolPart | null => {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd || '.', filePath);
  const skill = skillManifest(resolved);
  if (!skill) return null;
  const dir = path.isAbsolute(skill.dir) ? skill.dir : path.resolve(cwd || '.', skill.dir);
  return buildToolPart({
    id,
    callID: id,
    sessionID,
    messageID,
    tool: 'skill',
    input: { id: skill.name, name: skill.name },
    title: skill.name,
    start,
    metadata: { dir, source: 'read' },
    result: { status: 'completed', output: '', end },
  });
};

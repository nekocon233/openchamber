import path from 'node:path';
import { buildToolPart } from './records.js';

/** A successful read of a manifest is evidence of loading, not invocation. */
const skillManifest = (filePath) => {
  const match = /(?:^|[\\/])([^\\/]+)[\\/]SKILL\.md$/i.exec(filePath);
  return match ? { name: match[1], dir: filePath.replace(/[\\/]SKILL\.md$/i, '') } : null;
};

export const buildSkillReadPart = ({ filePath, cwd, id, sessionID, messageID, start, end }) => {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(cwd || '.', filePath);
  const skill = skillManifest(resolved);
  if (!skill) return null;
  const dir = path.isAbsolute(skill.dir) ? skill.dir : path.resolve(cwd || '.', skill.dir);
  return buildToolPart({
    id, callID: id, sessionID, messageID, tool: 'skill',
    input: { id: skill.name, name: skill.name }, title: skill.name, start,
    metadata: { dir, source: 'read' }, result: { status: 'completed', output: '', end },
  });
};

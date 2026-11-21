import { OpenCode } from '@opencode/client';
import { OPENCODE_CONFIG_DIR } from './config-files.js';
import { asNonEmptyString, isString } from '../shared/guards.js';
import type { Request } from '../shared/http-contracts.js';
import type { ListedSkill } from './skills.js';
import type { SkillRouteOptions } from './skill-routes.js';

type Directory = string | null;
type SkillSource = ListedSkill['source'];
interface WireSkill {
  id?: unknown;
  name?: unknown;
  path?: unknown;
  location?: unknown;
  description?: unknown;
  content?: unknown;
}

type SkillDiscoveryOptions = Pick<SkillRouteOptions,
  'fs' | 'path' | 'os' | 'SKILL_SCOPE' | 'getOpenCodePort' | 'buildOpenCodeUrl' | 'getOpenCodeAuthHeaders'
  | 'resolveOptionalProjectDirectory' | 'resolveProjectDirectory'
>;

export function createSkillDiscovery({
  fs, path, os, SKILL_SCOPE, getOpenCodePort, buildOpenCodeUrl, getOpenCodeAuthHeaders,
  resolveOptionalProjectDirectory, resolveProjectDirectory,
}: SkillDiscoveryOptions) {
  const findWorktreeRootForSkills = (workingDirectory: Directory) => {
    if (!workingDirectory) return null;
    let current = path.resolve(workingDirectory);
    while (true) {
      if (fs.existsSync(path.join(current, '.git'))) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return null;
      }
      current = parent;
    }
  };

  const getSkillProjectAncestors = (workingDirectory: Directory) => {
    if (!workingDirectory) return [];
    const result = [];
    let current = path.resolve(workingDirectory);
    const stop = findWorktreeRootForSkills(workingDirectory) || current;
    while (true) {
      result.push(current);
      if (current === stop) break;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return result;
  };

  const isPathInside = (candidatePath: string, parentPath: string | null | undefined) => {
    if (!candidatePath || !parentPath) return false;
    const normalizedCandidate = path.resolve(candidatePath);
    const normalizedParent = path.resolve(parentPath);
    return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}${path.sep}`);
  };

  const inferSkillScopeAndSourceFromPath = (skillPath: string, projectAncestors: string[]) => {
    const resolvedPath = path.resolve(skillPath);
    const home = os.homedir();
    const source: SkillSource = resolvedPath.includes(`${path.sep}.agents${path.sep}skills${path.sep}`)
      ? 'agents'
      : resolvedPath.includes(`${path.sep}.claude${path.sep}skills${path.sep}`)
        ? 'claude'
        : 'opencode';

    const isProjectScoped = projectAncestors.some((ancestor) => {
      const candidates = [
        path.join(ancestor, '.opencode'),
        path.join(ancestor, '.claude', 'skills'),
        path.join(ancestor, '.agents', 'skills'),
      ];
      return candidates.some((candidate) => isPathInside(resolvedPath, candidate));
    });

    if (isProjectScoped) {
      return { scope: SKILL_SCOPE.PROJECT, source };
    }

    const userRoots = [
      OPENCODE_CONFIG_DIR,
      path.join(home, '.opencode'),
      path.join(home, '.claude', 'skills'),
      path.join(home, '.agents', 'skills'),
      process.env.OPENCODE_CONFIG_DIR ? path.resolve(process.env.OPENCODE_CONFIG_DIR) : null,
    ].filter(Boolean);

    if (userRoots.some((root) => isPathInside(resolvedPath, root))) {
      return { scope: SKILL_SCOPE.USER, source };
    }

    return { scope: SKILL_SCOPE.USER, source };
  };

  const fetchOpenCodeDiscoveredSkills = async (workingDirectory: Directory) => {
    if (!getOpenCodePort()) {
      return null;
    }

    try {
      const baseUrl = buildOpenCodeUrl('/', '').replace(/\/$/, '');
      const headers = { ...getOpenCodeAuthHeaders() };
      if (workingDirectory) headers['x-opencode-directory'] = encodeURIComponent(workingDirectory);
      const client = OpenCode.make({
        baseUrl,
        headers,
        fetch: (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(8_000) }),
      });

      const response = await client.skill.list();
      const payload = response?.data;
      if (!Array.isArray(payload)) {
        return null;
      }

      const projectAncestors = getSkillProjectAncestors(workingDirectory);
      return payload
        .map((item: WireSkill | null | undefined): ListedSkill | null => {
          const name = isString(item?.name) ? item.name.trim() : '';
          const rawLocation = isString(item?.path) ? item.path : (isString(item?.location) ? item.location : '');
          const location = rawLocation.startsWith('/builtin/') || rawLocation.startsWith('skill://') ? '<built-in>' : rawLocation;
          const description = isString(item?.description) ? item.description : '';
          const content = isString(item?.content) ? item.content : '';
          if (!name || !location) {
            return null;
          }
          if (location === '<built-in>') {
            return {
              id: asNonEmptyString(item?.id) ?? name,
              name,
              path: location,
              scope: SKILL_SCOPE.USER,
              source: 'opencode',
              description,
              content,
            };
          }
          const inferred = inferSkillScopeAndSourceFromPath(location, projectAncestors);
          const skill: ListedSkill = {
            name,
            path: location,
            scope: inferred.scope,
            source: inferred.source,
            description,
          };
          if (content) {
            skill.content = content;
          }
          return skill;
        })
        .filter((skill) => skill !== null);
    } catch (error) {
      console.error('Failed to list OpenCode skills:', error);
      return null;
    }
  };

  const resolveSkillsDirectory = async (req: Pick<Request, 'get' | 'query'>) => {
    const optional = await resolveOptionalProjectDirectory(req);
    if (optional.error) {
      return optional;
    }
    if (optional.directory) {
      return optional;
    }

    try {
      const fallback = await resolveProjectDirectory(req);
      if (fallback.directory) {
        return { directory: fallback.directory, error: null };
      }
    } catch {
      return { directory: null, error: null };
    }

    return { directory: null, error: null };
  };

  return { fetchOpenCodeDiscoveredSkills, resolveSkillsDirectory };
}

import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import { Decoration, EditorView } from '@codemirror/view';
import stripJsonComments from 'strip-json-comments';
import { z } from 'zod';
import { isMacOS } from '@/lib/utils';

type ImportLink = { from: number; to: number; specifier: string };

export type TsconfigPathMapping = {
  prefix: string;
  suffix: string;
  wildcard: boolean;
  targets: string[];
};

const IMPORT_PARENTS = new Set(['ImportDeclaration', 'ExportDeclaration', 'DynamicImport']);

type SyntaxNode = ReturnType<typeof syntaxTree>['topNode'];

const isRequireArgument = (state: EditorState, argList: SyntaxNode): boolean => {
  const call = argList.parent;
  const callee = call?.firstChild;
  return call?.name === 'CallExpression' && !!callee && state.sliceDoc(callee.from, callee.to) === 'require';
};

/** Any import specifier string under `pos` (relative, alias or package), quotes excluded. */
export const importSpecifierAt = (state: EditorState, pos: number): ImportLink | null => {
  const tree = syntaxTree(state);
  const node = [tree.resolveInner(pos, 1), tree.resolveInner(pos, -1)].find((candidate) => candidate.name === 'String');
  const parent = node?.parent;
  if (!node || !parent || node.to - node.from < 2) return null;
  if (!IMPORT_PARENTS.has(parent.name) && !(parent.name === 'ArgList' && isRequireArgument(state, parent))) return null;
  const specifier = state.sliceDoc(node.from + 1, node.to - 1);
  if (!specifier) return null;
  return { from: node.from, to: node.to, specifier };
};

/** The relative import path under `pos`, quotes excluded from the specifier. */
export const relativeImportAt = (state: EditorState, pos: number): ImportLink | null => {
  const found = importSpecifierAt(state, pos);
  if (!found) return null;
  if (!found.specifier.startsWith('./') && !found.specifier.startsWith('../')) return null;
  return found;
};

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json', '.vue', '.svelte'];
const INDEX_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
// TypeScript's ESM style imports the compiled name of a source file.
const COMPILED_TO_SOURCE = new Map([
  ['.js', ['.ts', '.tsx']],
  ['.jsx', ['.tsx']],
  ['.mjs', ['.mts']],
  ['.cjs', ['.cts']],
]);

const dirname = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), 0)) || '/';

/** Joins a relative specifier onto a directory, folding `.` and `..`. */
export const joinPath = (directory: string, relative: string): string => {
  const parts = directory.split('/');
  for (const segment of relative.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (parts.length > 1) parts.pop();
    } else {
      parts.push(segment);
    }
  }
  return parts.join('/') || '/';
};

const candidatesForBasePath = (base: string): string[] => {
  const name = base.slice(base.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot) : '';
  const stem = extension ? base.slice(0, -extension.length) : base;
  return [
    base,
    ...(COMPILED_TO_SOURCE.get(extension) ?? []).map((source) => stem + source),
    ...SOURCE_EXTENSIONS.map((source) => base + source),
    ...INDEX_EXTENSIONS.map((source) => `${base}/index${source}`),
  ];
};

/** Every path the specifier may mean, in the order a bundler tries them. */
export const importCandidates = (fromFile: string, specifier: string): string[] => (
  candidatesForBasePath(joinPath(dirname(fromFile), specifier))
);

const tsconfigSchema = z.object({
  compilerOptions: z.object({
    baseUrl: z.string().optional(),
    paths: z.record(z.string(), z.array(z.string())).optional(),
  }).optional(),
});

/**
 * Parses `compilerOptions.baseUrl` and `compilerOptions.paths` from a
 * `tsconfig.json` or `jsconfig.json` document (comments and trailing commas allowed).
 */
export const parseTsconfigPaths = (rawConfig: string, configDirectory: string): TsconfigPathMapping[] => {
  try {
    const cleaned = stripJsonComments(rawConfig).replace(/,\s*([}\]])/g, '$1');
    const parsed = tsconfigSchema.safeParse(JSON.parse(cleaned));
    if (!parsed.success || !parsed.data.compilerOptions) return [];
    const compilerOptions = parsed.data.compilerOptions;
    const rawBaseUrl = compilerOptions.baseUrl?.trim() ?? '';
    const baseUrl = rawBaseUrl ? joinPath(configDirectory, rawBaseUrl) : configDirectory;
    const rawPaths = compilerOptions.paths;
    const mappings: TsconfigPathMapping[] = [];
    if (rawPaths) {
      for (const [pattern, rawTargets] of Object.entries(rawPaths)) {
        const targets = rawTargets
          .map((target) => target.trim())
          .filter((target) => target.length > 0)
          .map((target) => joinPath(baseUrl, target));
        if (targets.length === 0) continue;
        const starIndex = pattern.indexOf('*');
        if (starIndex >= 0) {
          mappings.push({
            prefix: pattern.slice(0, starIndex),
            suffix: pattern.slice(starIndex + 1),
            wildcard: true,
            targets,
          });
        } else {
          mappings.push({
            prefix: pattern,
            suffix: '',
            wildcard: false,
            targets,
          });
        }
      }
    }
    if (rawBaseUrl) {
      mappings.push({
        prefix: '',
        suffix: '',
        wildcard: true,
        targets: [`${baseUrl}/*`],
      });
    }
    return mappings;
  } catch {
    return [];
  }
};

/** Expands a module specifier through `tsconfig` path mappings into candidate base paths. */
const expandTsconfigAlias = (specifier: string, mappings: readonly TsconfigPathMapping[]): string[] => {
  const bases: string[] = [];
  for (const mapping of mappings) {
    if (!mapping.wildcard) {
      if (specifier === mapping.prefix) {
        bases.push(...mapping.targets);
      }
      continue;
    }
    if (!specifier.startsWith(mapping.prefix) || !specifier.endsWith(mapping.suffix)) continue;
    const matched = specifier.slice(mapping.prefix.length, specifier.length - mapping.suffix.length);
    for (const target of mapping.targets) {
      const replaced = target.includes('*') ? target.replace('*', matched) : joinPath(target, matched);
      bases.push(replaced);
    }
  }
  return bases;
};

const MONOREPO_CONTAINER_SEGMENTS = new Set(['modules', 'packages', 'host', 'apps', 'services', 'sdk']);
const WORKSPACE_PACKAGE_CONTAINERS = ['packages', 'sdk', 'modules', 'host'];

const collectMonorepoRoots = (fromFile: string, workspaceRoot?: string): string[] => {
  const roots: string[] = [];
  const addRoot = (candidate: string) => {
    const clean = candidate.replace(/\/+$/, '');
    if (clean && !roots.includes(clean)) roots.push(clean);
  };
  if (workspaceRoot) addRoot(workspaceRoot);
  const parts = fromFile.split('/');
  for (let i = 1; i < parts.length; i += 1) {
    if (MONOREPO_CONTAINER_SEGMENTS.has(parts[i])) {
      addRoot(parts.slice(0, i).join('/') || '/');
    }
  }
  return roots;
};

/**
 * Generates candidate base paths in a monorepo for a package specifier such as
 * `@peroperogames/host-sdk`, `@peroperogames/host-sdk/bff`, or `@openchamber/sdk`.
 */
const workspacePackageBasePaths = (
  fromFile: string,
  specifier: string,
  workspaceRoot?: string,
): string[] => {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) {
    return [];
  }
  let pkgName = '';
  let subpath = '';
  if (specifier.startsWith('@')) {
    const match = /^@([^/]+)\/([^/]+)(?:\/(.+))?$/.exec(specifier);
    if (!match) return [];
    pkgName = match[2];
    subpath = match[3] ?? '';
  } else {
    const match = /^([^/]+)(?:\/(.+))?$/.exec(specifier);
    if (!match) return [];
    pkgName = match[1];
    subpath = match[2] ?? '';
  }
  if (!pkgName) return [];

  const roots = collectMonorepoRoots(fromFile, workspaceRoot);
  const bases: string[] = [];
  for (const root of roots) {
    for (const container of WORKSPACE_PACKAGE_CONTAINERS) {
      const pkgRoot = `${root}/${container}/${pkgName}`;
      if (!subpath) {
        bases.push(`${pkgRoot}/src/index`, `${pkgRoot}/index`);
      } else {
        bases.push(
          `${pkgRoot}/src/${subpath}`,
          `${pkgRoot}/${subpath}`,
          `${pkgRoot}/src/${subpath}/index`,
          `${pkgRoot}/${subpath}/index`,
        );
      }
    }
  }
  return bases;
};

/** Names in a directory and whether each is a folder; null when it cannot be read. */
export type ListDirectoryNames = (directory: string) => Promise<ReadonlyMap<string, boolean> | null>;

type ImportResolution = { status: 'found'; path: string } | { status: 'missing' } | { status: 'failed' };

const resolveCandidatePaths = async (
  candidates: readonly string[],
  listNames: ListDirectoryNames,
): Promise<ImportResolution> => {
  const listings = new Map<string, Promise<ReadonlyMap<string, boolean> | null>>();
  let failed = false;
  for (const candidate of candidates) {
    const directory = dirname(candidate);
    const parentListing = listings.get(dirname(directory));
    const parentNames = parentListing ? await parentListing : null;
    if (!listings.has(directory) && parentNames && parentNames.get(directory.slice(directory.lastIndexOf('/') + 1)) !== true) continue;
    let listing = listings.get(directory);
    if (!listing) {
      listing = listNames(directory);
      listings.set(directory, listing);
    }
    const names = await listing;
    if (!names) {
      failed = true;
      continue;
    }
    if (names.get(candidate.slice(candidate.lastIndexOf('/') + 1)) === false) return { status: 'found', path: candidate };
  }
  return failed ? { status: 'failed' } : { status: 'missing' };
};

/**
 * The first candidate that exists as a file. A folder its parent's listing
 * does not show is skipped as missing; a listing that fails makes the lookup
 * `failed` unless another candidate is found, since the file may well be there.
 */
export const resolveRelativeImport = async (
  fromFile: string,
  specifier: string,
  listNames: ListDirectoryNames,
): Promise<ImportResolution> => (
  resolveCandidatePaths(importCandidates(fromFile, specifier), listNames)
);

/**
 * Resolves a relative import (`./`, `../`), a `tsconfig` alias import
 * (`@/lib/foo`, `~/bar`), or a workspace/monorepo package import
 * (`@peroperogames/host-sdk`, `@peroperogames/host-sdk/bff`, `@openchamber/sdk`).
 */
export const resolveImportSpecifier = async (
  fromFile: string,
  specifier: string,
  listNames: ListDirectoryNames,
  aliasMappings: readonly TsconfigPathMapping[] = [],
  workspaceRoot?: string,
): Promise<ImportResolution> => {
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return resolveRelativeImport(fromFile, specifier, listNames);
  }
  const aliasBases = expandTsconfigAlias(specifier, aliasMappings);
  const packageBases = workspacePackageBasePaths(fromFile, specifier, workspaceRoot);
  const allBases = [...aliasBases, ...packageBases];
  if (allBases.length === 0) {
    return { status: 'missing' };
  }
  const candidates = allBases.flatMap((base) => candidatesForBasePath(base));
  return resolveCandidatePaths(candidates, listNames);
};

const hasLinkModifier = (event: MouseEvent | KeyboardEvent) => (isMacOS() ? event.metaKey : event.ctrlKey);

const setHoveredLink = StateEffect.define<{ from: number; to: number } | null>();
const linkMark = Decoration.mark({ class: 'cm-import-link' });

const hoveredLinkField = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setHoveredLink)) return effect.value;
    }
    return transaction.docChanged ? null : value;
  },
  provide: (field) => EditorView.decorations.from(field, (range) => (
    range ? Decoration.set([linkMark.range(range.from, range.to)]) : Decoration.none
  )),
});

const showHovered = (view: EditorView, range: { from: number; to: number } | null) => {
  const current = view.state.field(hoveredLinkField);
  if (current?.from === range?.from && current?.to === range?.to) return;
  view.dispatch({ effects: setHoveredLink.of(range) });
};

const isResolvableSpecifier = (specifier: string) => (
  specifier.startsWith('./')
  || specifier.startsWith('../')
  || specifier.startsWith('@')
  || specifier.startsWith('~/')
);

const linkAtEvent = (view: EditorView, event: MouseEvent): ImportLink | null => {
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos === null) return null;
  const found = importSpecifierAt(view.state, pos);
  return found && isResolvableSpecifier(found.specifier) ? found : null;
};

/** `openImport` gets the specifier of the clicked path. */
export const importLinks = (openImport: (specifier: string) => void): Extension => [
  hoveredLinkField,
  EditorView.domEventHandlers({
    mousedown: (event, view) => {
      if (event.button !== 0 || !hasLinkModifier(event)) return false;
      const link = linkAtEvent(view, event);
      if (!link) return false;
      event.preventDefault();
      openImport(link.specifier);
      return true;
    },
    mousemove: (event, view) => {
      showHovered(view, hasLinkModifier(event) ? linkAtEvent(view, event) : null);
      return false;
    },
    mouseleave: (_event, view) => {
      showHovered(view, null);
      return false;
    },
    keyup: (event, view) => {
      if (!hasLinkModifier(event)) showHovered(view, null);
      return false;
    },
  }),
  EditorView.theme({
    '.cm-import-link': { textDecoration: 'underline', cursor: 'pointer' },
  }),
];

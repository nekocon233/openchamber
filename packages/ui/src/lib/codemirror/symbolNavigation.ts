import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import type { FileContentSearchMatch, FileContentSearchOutcome, FileContentSearchQuery } from '@/lib/api/types';
import {
  extractSymbolSignatureAndDoc,
  readDocumentSymbols,
  type DocumentSymbolKind,
} from './documentSymbols';
import {
  importSpecifierAt,
  resolveImportSpecifier,
  type ListDirectoryNames,
  type TsconfigPathMapping,
} from './importLinks';

type SyntaxNode = ReturnType<typeof syntaxTree>['topNode'];

export type SymbolLocation = {
  path: string;
  relativePath: string;
  line: number;
  column: number;
  endColumn: number;
  text: string;
  kind?: DocumentSymbolKind | 'variable' | 'parameter' | 'reference';
  isDeclaration?: boolean;
  signature?: string;
  documentation?: string | null;
};

type IdentifierToken = {
  name: string;
  from: number;
  to: number;
  line: number;
  column: number;
  isDeclaration: boolean;
  importedFrom: { specifier: string; importedName: string } | null;
};

export type SymbolNavigationContext = {
  filePath: string;
  workspaceRoot: string;
  listDirectoryNames?: ListDirectoryNames;
  readFileText?: (path: string) => Promise<string | null>;
  searchContents?: (payload: FileContentSearchQuery) => Promise<FileContentSearchOutcome>;
  tsconfigMappings?: readonly TsconfigPathMapping[];
  includeHidden?: boolean;
  respectGitignore?: boolean;
};

const COMMENT_AND_STRING_NODES = new Set([
  'LineComment',
  'BlockComment',
  'Comment',
  'DocComment',
  'String',
  'StringLiteral',
  'TemplateString',
  'InterpolatedRegularString',
  'CharacterLiteral',
  'RegExp',
]);

const IDENTIFIER_NODE_NAMES = new Set([
  'VariableName',
  'VariableDefinition',
  'PropertyName',
  'PropertyDefinition',
  'TypeName',
  'TypeDefinition',
  'TypeIdentifier',
  'FieldName',
  'DefName',
  'BoundIdentifier',
  'Label',
  'MethodName',
  'ParamName',
  'ConstName',
  'VarName',
  'Ident',
  'ArgumentName',
]);

const DEFINITION_NODE_NAMES = new Set([
  'VariableDefinition',
  'PropertyDefinition',
  'TypeDefinition',
  'DefName',
  'BoundIdentifier',
  'ParamName',
  'ConstName',
]);

const DECLARATION_PARENT_NAMES = new Set([
  'FunctionDeclaration',
  'FunctionDefinition',
  'FunctionItem',
  'FunctionDecl',
  'MethodDeclaration',
  'MethodDecl',
  'ClassDeclaration',
  'ClassDefinition',
  'InterfaceDeclaration',
  'StructItem',
  'TraitItem',
  'ImplItem',
  'TypeAliasDeclaration',
  'EnumDeclaration',
  'EnumItem',
  'TypeSpec',
  'ModItem',
  'VariableDeclarator',
  'VariableDeclaration',
  'PropertyDeclaration',
  'ParamList',
  'ParameterList',
  'LocalVarDecl',
]);

const SCOPE_CONTAINER_NAMES = new Set([
  'Block',
  'StatementBlock',
  'ClassBody',
  'ObjectType',
  'InterfaceDeclaration',
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunction',
  'MethodDeclaration',
  'FunctionDefinition',
  'ClassDefinition',
  'FunctionItem',
  'ImplItem',
  'FunctionDecl',
  'MethodDecl',
  'Delim',
]);

const CSHARP_TYPE_KEYWORDS = new Set([
  'class',
  'interface',
  'struct',
  'record',
  'enum',
  'delegate',
  'namespace',
]);

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const toRelativeWorkspacePath = (filePath: string, workspaceRoot: string): string => {
  const cleanRoot = workspaceRoot.replace(/\/+$/, '');
  if (cleanRoot && filePath.startsWith(`${cleanRoot}/`)) {
    return filePath.slice(cleanRoot.length + 1);
  }
  return filePath;
};

const isInsideCommentOrString = (node: SyntaxNode | null): boolean => {
  for (let current = node; current; current = current.parent) {
    if (COMMENT_AND_STRING_NODES.has(current.name)) return true;
  }
  return false;
};

/**
 * True when `node` sits inside an `import ...` statement or an `export { ... }`
 * re-export clause. Identifiers in import/re-export clauses reference declarations
 * from another module or elsewhere in the file and must not be treated as the
 * origin declaration themselves.
 */
const isInsideImportOrReExportClause = (node: SyntaxNode | null): boolean => {
  for (let current = node; current; current = current.parent) {
    if (current.name === 'ImportDeclaration' || current.name === 'ImportGroup' || current.name === 'ExportGroup') {
      return true;
    }
  }
  return false;
};

const previousNonErrorSibling = (node: SyntaxNode): SyntaxNode | null => {
  let prev = node.prevSibling;
  while (prev && prev.name === '⚠') prev = prev.prevSibling;
  return prev;
};

const nextNonErrorSibling = (node: SyntaxNode): SyntaxNode | null => {
  let next = node.nextSibling;
  while (next && next.name === '⚠') next = next.nextSibling;
  return next;
};

const isCSharpDeclarationNode = (state: EditorState, node: SyntaxNode): boolean => {
  if (node.name === 'ParamName' || node.name === 'ConstName' || node.name === 'PropertyName') {
    return true;
  }
  if (node.name === 'VarName') {
    return true;
  }
  if (node.name === 'TypeIdentifier') {
    const prev = previousNonErrorSibling(node);
    if (prev && prev.name === 'Keyword' && CSHARP_TYPE_KEYWORDS.has(state.sliceDoc(prev.from, prev.to))) {
      return true;
    }
    const next = nextNonErrorSibling(node);
    if (
      prev
      && prev.name === 'Keyword'
      && next
      && next.name === 'Delim'
      && state.sliceDoc(next.from, next.from + 1) === '('
    ) {
      return true;
    }
    return false;
  }
  if (node.name === 'MethodName') {
    const prev = previousNonErrorSibling(node);
    if (!prev || prev.name === '.') return false;
    return prev.name === 'SimpleType' || prev.name === 'TypeIdentifier' || prev.name === '>' || prev.name === '?' || prev.name === ']';
  }
  return false;
};

const isDeclarationIdentifierNode = (state: EditorState, node: SyntaxNode): boolean => {
  if (isInsideImportOrReExportClause(node)) return false;
  if (DEFINITION_NODE_NAMES.has(node.name)) return true;
  const topName = syntaxTree(state).topNode.name;
  if (topName === 'Program') {
    return isCSharpDeclarationNode(state, node);
  }
  const parent = node.parent;
  if (!parent) return false;
  if (DECLARATION_PARENT_NAMES.has(parent.name)) {
    for (let child = parent.firstChild; child; child = child.nextSibling) {
      if (IDENTIFIER_NODE_NAMES.has(child.name)) {
        return child.from === node.from && child.to === node.to;
      }
    }
  }
  return false;
};

type ImportBindingRecord = {
  localName: string;
  importedName: string;
  specifier: string;
  from: number;
  to: number;
};

/**
 * Extracts all ES/TS `import` and `export ... from '...'` bindings from a
 * document so jumping on an imported or re-exported identifier follows it to
 * the target module.
 */
const collectImportBindingsFromText = (docText: string) => {
  const bindings = new Map<string, ImportBindingRecord>();
  const starExports: string[] = [];

  const statementRe = /\b(?:import|export)\s+([\s\S]*?)\bfrom\s+['"]([^'"]+)['"]/g;
  let stmtMatch: RegExpExecArray | null;
  while ((stmtMatch = statementRe.exec(docText)) !== null) {
    const clause = stmtMatch[1];
    const specifier = stmtMatch[2];
    const stmtStart = stmtMatch.index;

    if (/^\s*\*\s*$/.test(clause) || /^\s*type\s+\*\s*$/.test(clause)) {
      starExports.push(specifier);
      continue;
    }

    // Named bindings `{ a, type b, c as d }`
    const braceMatch = /\{([\s\S]*?)\}/.exec(clause);
    if (braceMatch) {
      const innerText = braceMatch[1];
      const innerOffset = stmtStart + stmtMatch[0].indexOf('{') + 1;
      const rawItems = innerText.split(',');
      let searchCursor = 0;
      for (const rawItem of rawItems) {
        const itemIndex = innerText.indexOf(rawItem, searchCursor);
        searchCursor = itemIndex + rawItem.length;
        const cleaned = rawItem.replace(/^\s*type\s+/, '').trim();
        if (!cleaned) continue;
        const asParts = cleaned.split(/\s+as\s+/);
        const importedName = asParts[0]?.trim() ?? '';
        const localName = (asParts[1] ?? asParts[0])?.trim() ?? '';
        if (!localName || !importedName) continue;
        const localIndexInRaw = rawItem.lastIndexOf(localName);
        const tokenFrom = innerOffset + itemIndex + Math.max(0, localIndexInRaw);
        const record: ImportBindingRecord = {
          localName,
          importedName,
          specifier,
          from: tokenFrom,
          to: tokenFrom + localName.length,
        };
        bindings.set(localName, record);
        if (importedName !== localName && !bindings.has(importedName)) {
          bindings.set(importedName, record);
        }
      }
    }

    // Default or namespace binding: `import Foo from '...'` or `import * as Foo from '...'`
    const withoutBraces = clause.replace(/\{[\s\S]*?\}/, '').replace(/,/g, '').trim();
    const defaultMatch = /^(?:type\s+)?(?:\*\s+as\s+([A-Za-z_$][\w$]*)|([A-Za-z_$][\w$]*))$/.exec(withoutBraces);
    if (defaultMatch) {
      const localName = defaultMatch[1] ?? defaultMatch[2];
      const importedName = defaultMatch[1] ? '*' : 'default';
      if (localName) {
        const localOffset = stmtMatch[0].indexOf(localName);
        const tokenFrom = stmtStart + Math.max(0, localOffset);
        bindings.set(localName, {
          localName,
          importedName,
          specifier,
          from: tokenFrom,
          to: tokenFrom + localName.length,
        });
      }
    }
  }

  return { bindings, starExports };
};

const collectImportBindings = (state: EditorState): Map<string, ImportBindingRecord> => (
  collectImportBindingsFromText(state.sliceDoc(0, Math.min(state.doc.length, 60_000))).bindings
);

/**
 * Returns the identifier token under `pos`, or null if `pos` is inside a
 * comment, string literal, or whitespace/punctuation.
 */
export const identifierAtPosition = (state: EditorState, pos: number): IdentifierToken | null => {
  if (pos < 0 || pos > state.doc.length) return null;
  const tree = ensureSyntaxTree(state, Math.min(state.doc.length, Math.max(pos + 2_000, 10_000)), 100) ?? syntaxTree(state);
  const candidates = [tree.resolveInner(pos, 1), tree.resolveInner(pos, -1)];
  for (const candidate of candidates) {
    if (isInsideCommentOrString(candidate)) return null;
  }

  let matchedNode: SyntaxNode | null = null;
  for (const candidate of candidates) {
    for (let cur: SyntaxNode | null = candidate; cur; cur = cur.parent) {
      if (IDENTIFIER_NODE_NAMES.has(cur.name) && cur.from <= pos && pos <= cur.to && cur.to > cur.from) {
        matchedNode = cur;
        break;
      }
    }
    if (matchedNode) break;
  }

  let from: number;
  let to: number;
  let name: string;
  let isDeclaration = false;

  if (matchedNode) {
    from = matchedNode.from;
    to = matchedNode.to;
    name = state.sliceDoc(from, to);
    if (!/^[A-Za-z_$@][\w$]*$/.test(name)) return null;
    isDeclaration = isDeclarationIdentifierNode(state, matchedNode);
  } else {
    const line = state.doc.lineAt(pos);
    const offset = pos - line.from;
    const left = line.text.slice(0, offset);
    const right = line.text.slice(offset);
    const leftMatch = /[A-Za-z_$][\w$]*$/.exec(left);
    const rightMatch = /^[\w$]*/.exec(right);
    if (!leftMatch && (!rightMatch || !/^[A-Za-z_$]/.test(rightMatch[0]))) {
      return null;
    }
    const word = (leftMatch?.[0] ?? '') + (rightMatch?.[0] ?? '');
    if (!word) return null;
    from = pos - (leftMatch?.[0].length ?? 0);
    to = from + word.length;
    name = word;
  }

  const normalizedName = name.startsWith('@') ? name.slice(1) : name;
  const lineObj = state.doc.lineAt(from);
  const importBindings = collectImportBindings(state);
  const importBinding = importBindings.get(normalizedName) ?? null;

  return {
    name: normalizedName,
    from,
    to,
    line: lineObj.number,
    column: from - lineObj.from + 1,
    isDeclaration: isDeclaration && !importBinding,
    importedFrom: importBinding
      ? { specifier: importBinding.specifier, importedName: importBinding.importedName }
      : null,
  };
};

type InFileSymbolOccurrence = {
  from: number;
  to: number;
  line: number;
  column: number;
  endColumn: number;
  text: string;
  isDeclaration: boolean;
  enclosingScopeRange: { from: number; to: number };
};

const FUNCTION_AND_TYPE_DECLARATION_CONTAINERS = new Set([
  'FunctionDeclaration',
  'FunctionDefinition',
  'FunctionItem',
  'FunctionDecl',
  'MethodDeclaration',
  'MethodDecl',
  'ClassDeclaration',
  'ClassDefinition',
  'InterfaceDeclaration',
  'StructItem',
  'TraitItem',
  'ImplItem',
]);

const enclosingScopeOf = (state: EditorState, node: SyntaxNode) => {
  const startParent = node.parent
    && FUNCTION_AND_TYPE_DECLARATION_CONTAINERS.has(node.parent.name)
    && node.parent.firstChild
    ? node.parent.parent
    : node.parent;
  for (let cur = startParent; cur; cur = cur.parent) {
    if (SCOPE_CONTAINER_NAMES.has(cur.name)) {
      if (cur.name === 'Delim' && state.sliceDoc(cur.from, cur.from + 1) !== '{') {
        const next = nextNonErrorSibling(cur);
        if (next && next.name === 'Delim' && state.sliceDoc(next.from, next.from + 1) === '{') {
          return { from: cur.from, to: next.to };
        }
        continue;
      }
      if (cur.name === 'ParamList' || cur.name === 'ParameterList') {
        return { from: cur.parent?.from ?? cur.from, to: cur.parent?.to ?? cur.to };
      }
      return { from: cur.from, to: cur.to };
    }
  }
  return { from: 0, to: state.doc.length };
};

/**
 * Finds all identifier occurrences matching `symbolName` in `state` (excluding
 * strings and comments).
 */
export const findInFileSymbolOccurrences = (
  state: EditorState,
  symbolName: string,
  timeoutMs = 200,
): InFileSymbolOccurrence[] => {
  if (!symbolName) return [];
  const tree = ensureSyntaxTree(state, state.doc.length, timeoutMs) ?? syntaxTree(state);
  const occurrences: InFileSymbolOccurrence[] = [];
  const seenOffsets = new Set<number>();

  tree.iterate({
    enter: (ref) => {
      if (COMMENT_AND_STRING_NODES.has(ref.name)) return false;
      if (!IDENTIFIER_NODE_NAMES.has(ref.name)) return;
      const raw = state.sliceDoc(ref.from, ref.to);
      const normalized = raw.startsWith('@') ? raw.slice(1) : raw;
      if (normalized !== symbolName || seenOffsets.has(ref.from)) return;
      seenOffsets.add(ref.from);
      const line = state.doc.lineAt(ref.from);
      const column = ref.from - line.from + 1;
      occurrences.push({
        from: ref.from,
        to: ref.to,
        line: line.number,
        column,
        endColumn: column + (ref.to - ref.from),
        text: line.text.trim(),
        isDeclaration: isDeclarationIdentifierNode(state, ref.node),
        enclosingScopeRange: enclosingScopeOf(state, ref.node),
      });
    },
  });

  if (occurrences.length === 0 && tree.topNode.firstChild === null) {
    const wordRe = new RegExp(`\\b${escapeRegExp(symbolName)}\\b`, 'g');
    for (let lineNo = 1; lineNo <= state.doc.lines; lineNo += 1) {
      const line = state.doc.line(lineNo);
      let match: RegExpExecArray | null;
      while ((match = wordRe.exec(line.text)) !== null) {
        const from = line.from + match.index;
        const to = from + symbolName.length;
        occurrences.push({
          from,
          to,
          line: lineNo,
          column: match.index + 1,
          endColumn: match.index + 1 + symbolName.length,
          text: line.text.trim(),
          isDeclaration: false,
          enclosingScopeRange: { from: 0, to: state.doc.length },
        });
      }
    }
  }

  return occurrences;
};

/**
 * Finds the best matching declaration(s) of `symbolName` in `state` for a
 * reference at `cursorPos`, preferring the innermost lexical scope that
 * encloses `cursorPos`, then document-level symbols.
 */
const findLocalSymbolDeclarations = (
  state: EditorState,
  symbolName: string,
  cursorPos: number,
  filePath = '',
  workspaceRoot = '',
): SymbolLocation[] => {
  const relativePath = toRelativeWorkspacePath(filePath, workspaceRoot);
  const allOccurrences = findInFileSymbolOccurrences(state, symbolName);
  const declarations = allOccurrences.filter((item) => item.isDeclaration);

  // 1. Check lexical declarations whose enclosing scope contains `cursorPos`.
  const enclosingDeclarations = declarations
    .filter((decl) => decl.enclosingScopeRange.from <= cursorPos && cursorPos <= decl.enclosingScopeRange.to)
    .sort((a, b) => (
      (a.enclosingScopeRange.to - a.enclosingScopeRange.from)
      - (b.enclosingScopeRange.to - b.enclosingScopeRange.from)
    ));

  if (enclosingDeclarations.length > 0) {
    const bestScopeSize = enclosingDeclarations[0].enclosingScopeRange.to - enclosingDeclarations[0].enclosingScopeRange.from;
    const picked = enclosingDeclarations.filter((decl) => (
      (decl.enclosingScopeRange.to - decl.enclosingScopeRange.from) === bestScopeSize
    ));
    return picked.map((decl) => {
      const docInfo = extractSymbolSignatureAndDoc(state, decl.from);
      return {
        path: filePath,
        relativePath,
        line: decl.line,
        column: decl.column,
        endColumn: decl.endColumn,
        text: decl.text,
        isDeclaration: true,
        signature: docInfo.signature,
        documentation: docInfo.documentation,
      };
    });
  }

  // 2. Check document outline symbols (functions, classes, methods, types, C# members).
  const outlineMatches = readDocumentSymbols(state).filter((sym) => sym.name === symbolName);
  if (outlineMatches.length > 0) {
    return outlineMatches.map((sym) => {
      const line = state.doc.line(sym.line);
      const column = sym.from - line.from + 1;
      const docInfo = extractSymbolSignatureAndDoc(state, sym.from);
      return {
        path: filePath,
        relativePath,
        line: sym.line,
        column,
        endColumn: column + sym.name.length,
        text: line.text.trim(),
        kind: sym.kind,
        isDeclaration: true,
        signature: docInfo.signature,
        documentation: docInfo.documentation,
      };
    });
  }

  // 3. Any other declaration in the file.
  if (declarations.length > 0) {
    return declarations.map((decl) => {
      const docInfo = extractSymbolSignatureAndDoc(state, decl.from);
      return {
        path: filePath,
        relativePath,
        line: decl.line,
        column: decl.column,
        endColumn: decl.endColumn,
        text: decl.text,
        isDeclaration: true,
        signature: docInfo.signature,
        documentation: docInfo.documentation,
      };
    });
  }

  return [];
};

/**
 * Builds a ripgrep regular expression that matches declarations of `symbolName`
 * across TypeScript/JavaScript, C#, Python, Go, Rust, Java, and C/C++ without
 * matching `import { type Foo }` or `export { Foo }` re-export specifiers.
 */
const buildWorkspaceDeclarationRegex = (symbolName: string): string => {
  const escaped = escapeRegExp(symbolName);
  return [
    // TS / JS / Rust / Go / Python / C# class, function, interface, enum, struct, record
    `\\b(export\\s+(default\\s+)?(async\\s+)?)?(function\\*?|(abstract|sealed|partial|static|public|private|protected|internal)\\s+class|class|interface|enum|struct|record|trait|mod|namespace|def|func|fn|delegate)\\s+${escaped}\\b`,
    // TS / Go type alias declaration (`type Foo =` or `type Foo<T> =` or Go `type Foo struct/interface`)
    `\\b(export\\s+)?type\\s+${escaped}\\b(\\s*<[^>\\n]+>)?\\s*(=|struct\\b|interface\\b)`,
    // JS / TS const / let / var declarations
    `\\b(export\\s+)?(const|let|var)\\s+${escaped}\\s*[:=]`,
    // Go receiver methods: `func (r *Repo) Name(`
    `\\bfunc\\s*\\([^)]+\\)\\s*${escaped}\\s*\\(`,
    // C# / Java / TS class methods & properties with visibility/modifiers
    `\\b(public|private|protected|internal|static|virtual|override|abstract|async|sealed|readonly|extern|new)\\s+[^;=()]+\\s+${escaped}\\s*(<[^>]+>)?\\s*(\\(|\\{|=>)`,
  ].join('|');
};

const matchDirectDeclarationInText = (
  content: string,
  targetPath: string,
  workspaceRoot: string,
  symbolName: string,
): SymbolLocation | null => {
  const relativePath = toRelativeWorkspacePath(targetPath, workspaceRoot);
  const lines = content.split(/\r?\n/);
  const escaped = escapeRegExp(symbolName);
  const patterns = symbolName === 'default'
    ? [/^\s*export\s+default\b/]
    : [
      new RegExp(`^\\s*export\\s+(?:default\\s+)?(?:async\\s+)?(?:function\\*?|class|interface|enum|const|let|var)\\s+(${escaped})\\b`),
      new RegExp(`^\\s*export\\s+type\\s+(${escaped})\\b`),
      new RegExp(`^\\s*(?:async\\s+)?(?:function\\*?|class|interface|enum|const|let|var)\\s+(${escaped})\\b`),
      new RegExp(`^\\s*type\\s+(${escaped})\\b`),
    ];

  for (const pattern of patterns) {
    for (let index = 0; index < lines.length; index += 1) {
      const lineText = lines[index];
      const trimmed = lineText.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue;
      const match = pattern.exec(lineText);
      if (match) {
        const col = match[1] ? lineText.indexOf(match[1], match.index) + 1 : match.index + 1;
        const tempState = EditorState.create({ doc: content });
        const lineStart = tempState.doc.line(index + 1).from;
        const docInfo = extractSymbolSignatureAndDoc(tempState, lineStart + Math.max(0, col - 1));
        return {
          path: targetPath,
          relativePath,
          line: index + 1,
          column: col,
          endColumn: col + (match[1]?.length ?? symbolName.length),
          text: trimmed,
          isDeclaration: true,
          signature: docInfo.signature,
          documentation: docInfo.documentation,
        };
      }
    }
  }
  return null;
};

const matchToSymbolLocation = (match: FileContentSearchMatch, isDeclaration: boolean): SymbolLocation => {
  const firstRange = match.ranges[0];
  const length = firstRange ? Math.max(1, firstRange[1] - firstRange[0]) : 1;
  return {
    path: match.path,
    relativePath: match.relativePath,
    line: match.line,
    column: match.column,
    endColumn: match.column + length,
    text: match.text,
    isDeclaration,
    signature: isDeclaration ? match.text.replace(/\s*\{[\s\S]*$/, '').trim() : undefined,
  };
};

const searchWorkspaceDeclarations = async (
  symbolName: string,
  context: SymbolNavigationContext,
): Promise<SymbolLocation[]> => {
  if (!symbolName || symbolName === 'default' || symbolName === '*' || !context.searchContents || !context.workspaceRoot) {
    return [];
  }
  try {
    const outcome = await context.searchContents({
      directory: context.workspaceRoot,
      query: buildWorkspaceDeclarationRegex(symbolName),
      regex: true,
      limit: 60,
      includeHidden: context.includeHidden,
      respectGitignore: context.respectGitignore,
    });
    if (outcome.status !== 'ok' || outcome.matches.length === 0) {
      return [];
    }
    const locations = await Promise.all(outcome.matches.map(async (match) => {
      const symbolIndex = match.text.search(new RegExp(`\\b${escapeRegExp(symbolName)}\\b`));
      const adjustedColumn = symbolIndex >= 0 && match.ranges[0]
        ? Math.max(1, match.column + (symbolIndex - match.ranges[0][0]))
        : match.column;
      const base = {
        ...matchToSymbolLocation(match, true),
        column: adjustedColumn,
        endColumn: adjustedColumn + symbolName.length,
      };
      if (context.readFileText && outcome.matches.length <= 5) {
        const text = await context.readFileText(match.path);
        if (text !== null) {
          const tempState = EditorState.create({ doc: text });
          const lineNo = Math.max(1, Math.min(match.line, tempState.doc.lines));
          const lineStart = tempState.doc.line(lineNo).from;
          const docInfo = extractSymbolSignatureAndDoc(tempState, lineStart + Math.max(0, adjustedColumn - 1));
          return {
            ...base,
            signature: docInfo.signature || base.signature,
            documentation: docInfo.documentation,
          };
        }
      }
      return base;
    }));
    return locations;
  } catch {
    return [];
  }
};

/**
 * Resolves `symbolName` inside `targetPath`, recursively following barrel
 * re-exports (`export { ... } from '...'` and `export * from '...'`) up to
 * depth 5.
 */
const resolveSymbolInModule = async (
  targetPath: string,
  symbolName: string,
  context: SymbolNavigationContext,
  depth = 0,
): Promise<SymbolLocation | null> => {
  if (depth > 5) return null;
  if (!context.readFileText) {
    return {
      path: targetPath,
      relativePath: toRelativeWorkspacePath(targetPath, context.workspaceRoot),
      line: 1,
      column: 1,
      endColumn: 1,
      text: symbolName,
      isDeclaration: true,
    };
  }

  const content = await context.readFileText(targetPath);
  if (content === null) return null;

  // 1. Direct declaration in `targetPath`
  const direct = matchDirectDeclarationInText(content, targetPath, context.workspaceRoot, symbolName);
  if (direct) return direct;

  // 2. Named re-export or import-then-export in `targetPath` (barrel file)
  if (context.listDirectoryNames) {
    const { bindings, starExports } = collectImportBindingsFromText(content);
    const reExport = bindings.get(symbolName);
    if (reExport) {
      const nextResolved = await resolveImportSpecifier(
        targetPath,
        reExport.specifier,
        context.listDirectoryNames,
        context.tsconfigMappings,
        context.workspaceRoot,
      );
      if (nextResolved.status === 'found' && nextResolved.path !== targetPath) {
        const followed = await resolveSymbolInModule(
          nextResolved.path,
          reExport.importedName,
          context,
          depth + 1,
        );
        if (followed) return followed;
      }
      const wsLocations = await searchWorkspaceDeclarations(reExport.importedName, context);
      if (wsLocations.length > 0) return wsLocations[0];
    }

    for (const starSpecifier of starExports) {
      const nextResolved = await resolveImportSpecifier(
        targetPath,
        starSpecifier,
        context.listDirectoryNames,
        context.tsconfigMappings,
        context.workspaceRoot,
      );
      if (nextResolved.status === 'found' && nextResolved.path !== targetPath) {
        const followed = await resolveSymbolInModule(nextResolved.path, symbolName, context, depth + 1);
        if (followed) return followed;
      }
    }
  }

  // 3. Try workspace declaration search before falling back to line 1 of the barrel file
  const wsMatches = await searchWorkspaceDeclarations(symbolName, context);
  if (wsMatches.length > 0) return wsMatches[0];

  const lines = content.split(/\r?\n/);
  return {
    path: targetPath,
    relativePath: toRelativeWorkspacePath(targetPath, context.workspaceRoot),
    line: 1,
    column: 1,
    endColumn: 1,
    text: (lines[0] ?? '').trim(),
    isDeclaration: true,
  };
};

/**
 * Resolves the definition(s) of the symbol or import path at `pos`.
 */
export const resolveSymbolDefinitions = async (
  state: EditorState,
  pos: number,
  context: SymbolNavigationContext,
): Promise<{ symbolName: string; locations: SymbolLocation[] }> => {
  // 1. Direct click/F12 on an import string specifier
  const specAtPos = importSpecifierAt(state, pos);
  if (specAtPos && context.listDirectoryNames) {
    const resolved = await resolveImportSpecifier(
      context.filePath,
      specAtPos.specifier,
      context.listDirectoryNames,
      context.tsconfigMappings,
      context.workspaceRoot,
    );
    if (resolved.status === 'found') {
      return {
        symbolName: specAtPos.specifier,
        locations: [{
          path: resolved.path,
          relativePath: toRelativeWorkspacePath(resolved.path, context.workspaceRoot),
          line: 1,
          column: 1,
          endColumn: 1,
          text: specAtPos.specifier,
          isDeclaration: true,
        }],
      };
    }
  }

  const token = identifierAtPosition(state, pos);
  if (!token) {
    return { symbolName: '', locations: [] };
  }

  // 2. Follow ES/TS imported or re-exported symbol across modules and barrel files
  if (token.importedFrom) {
    if (context.listDirectoryNames) {
      const resolved = await resolveImportSpecifier(
        context.filePath,
        token.importedFrom.specifier,
        context.listDirectoryNames,
        context.tsconfigMappings,
        context.workspaceRoot,
      );
      if (resolved.status === 'found') {
        const location = await resolveSymbolInModule(
          resolved.path,
          token.importedFrom.importedName,
          context,
        );
        if (location) {
          return { symbolName: token.name, locations: [location] };
        }
      }
    }
    // If the specifier is a workspace package whose path wasn't resolved by directory listing,
    // search the workspace for the original imported symbol name first.
    const importedTargetName = token.importedFrom.importedName !== 'default' && token.importedFrom.importedName !== '*'
      ? token.importedFrom.importedName
      : token.name;
    const wsImported = await searchWorkspaceDeclarations(importedTargetName, context);
    if (wsImported.length > 0) {
      return { symbolName: token.name, locations: wsImported };
    }
  }

  // 3. Look up in the current document's lexical scopes and outline
  const localDecls = findLocalSymbolDeclarations(
    state,
    token.name,
    pos,
    context.filePath,
    context.workspaceRoot,
  );
  if (localDecls.length > 0) {
    return { symbolName: token.name, locations: localDecls };
  }

  // 4. Search across the workspace via ripgrep (covers C# cross-file classes/methods, Go, Python, Rust, TS globals)
  const wsLocations = await searchWorkspaceDeclarations(token.name, context);
  if (wsLocations.length > 0) {
    return { symbolName: token.name, locations: wsLocations };
  }

  return { symbolName: token.name, locations: [] };
};

/**
 * Finds all references to the symbol at `pos` across the current document and workspace.
 */
export const findSymbolReferences = async (
  state: EditorState,
  pos: number,
  context: SymbolNavigationContext,
): Promise<{ symbolName: string; locations: SymbolLocation[] }> => {
  const token = identifierAtPosition(state, pos);
  if (!token) {
    return { symbolName: '', locations: [] };
  }

  const relativeCurrentPath = toRelativeWorkspacePath(context.filePath, context.workspaceRoot);
  const inFile = findInFileSymbolOccurrences(state, token.name).map<SymbolLocation>((occ) => ({
    path: context.filePath,
    relativePath: relativeCurrentPath,
    line: occ.line,
    column: occ.column,
    endColumn: occ.endColumn,
    text: occ.text,
    isDeclaration: occ.isDeclaration,
  }));

  if (!context.searchContents || !context.workspaceRoot) {
    return { symbolName: token.name, locations: inFile };
  }

  try {
    const outcome = await context.searchContents({
      directory: context.workspaceRoot,
      query: `\\b${escapeRegExp(token.name)}\\b`,
      regex: true,
      limit: 200,
      includeHidden: context.includeHidden,
      respectGitignore: context.respectGitignore,
    });
    if (outcome.status !== 'ok') {
      return { symbolName: token.name, locations: inFile };
    }

    const declRegex = new RegExp(buildWorkspaceDeclarationRegex(token.name));
    const otherFileMatches: SymbolLocation[] = [];
    for (const match of outcome.matches) {
      if (match.path === context.filePath) continue;
      const isDecl = declRegex.test(match.text);
      otherFileMatches.push(matchToSymbolLocation(match, isDecl));
    }

    const combined = [...inFile, ...otherFileMatches].sort((a, b) => {
      if (Boolean(a.isDeclaration) !== Boolean(b.isDeclaration)) {
        return a.isDeclaration ? -1 : 1;
      }
      if (a.path !== b.path) {
        if (a.path === context.filePath) return -1;
        if (b.path === context.filePath) return 1;
        return a.relativePath.localeCompare(b.relativePath);
      }
      return a.line - b.line || a.column - b.column;
    });

    return { symbolName: token.name, locations: combined };
  } catch {
    return { symbolName: token.name, locations: inFile };
  }
};

export type WorkspaceSymbolItem = {
  name: string;
  kind: DocumentSymbolKind;
  path: string;
  relativePath: string;
  line: number;
  column: number;
  detail: string;
};

const WORKSPACE_KEYWORD_SYMBOL_RE = /\b(?:(namespace|mod)|(class|interface|struct|record|trait)|(enum|type|delegate)|(function\*?|def|func|fn))\s+([A-Za-z_][\w]*)/;
const WORKSPACE_METHOD_SYMBOL_RE = /\b(?:public|private|protected|internal|static|virtual|override|abstract|async)\s+(?!class\b|interface\b|struct\b|record\b|enum\b|delegate\b|function\b)[\w<>[\].,?\s]+\s+([A-Za-z_][\w]*)\s*\(/;

/**
 * Builds a ripgrep regex to search workspace symbol declarations matching `query`.
 */
export const buildWorkspaceSymbolQueryRegex = (query: string): string => {
  const trimmed = query.trim();
  const namePattern = trimmed ? `[A-Za-z_]*${escapeRegExp(trimmed)}[\\w]*` : '[A-Za-z_][\\w]{2,}';
  return [
    `\\b(export\\s+(default\\s+)?(async\\s+)?)?(function\\*?|class|interface|enum|struct|record|trait|mod|namespace|def|func|fn|delegate)\\s+${namePattern}\\b`,
    `\\b(export\\s+)?type\\s+${namePattern}\\b(\\s*<[^>\\n]+>)?\\s*=`,
    `\\b(public|private|protected|internal|override|virtual)\\s+[A-Za-z0-9_<>\\[\\]?.,\\s]+\\s+${namePattern}\\s*\\(`,
  ].join('|');
};

/**
 * Parses ripgrep declaration matches into structured workspace symbols.
 */
export const parseWorkspaceSymbolMatches = (matches: readonly FileContentSearchMatch[]): WorkspaceSymbolItem[] => {
  const items: WorkspaceSymbolItem[] = [];
  const seen = new Set<string>();
  for (const match of matches) {
    let name: string | undefined;
    let kind: DocumentSymbolKind = 'method';
    const kwMatch = WORKSPACE_KEYWORD_SYMBOL_RE.exec(match.text);
    if (kwMatch) {
      name = kwMatch[5];
      kind = kwMatch[1]
        ? 'module'
        : kwMatch[2]
          ? 'class'
          : kwMatch[3]
            ? 'type'
            : 'function';
    } else {
      const methodMatch = WORKSPACE_METHOD_SYMBOL_RE.exec(match.text);
      if (methodMatch) {
        name = methodMatch[1];
        kind = 'method';
      }
    }
    if (!name) continue;
    const key = `${match.path}:${match.line}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      name,
      kind,
      path: match.path,
      relativePath: match.relativePath,
      line: match.line,
      column: match.column,
      detail: match.text,
    });
  }
  return items;
};

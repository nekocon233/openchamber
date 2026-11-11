import type { EditorState } from '@codemirror/state';
import { ensureSyntaxTree, type syntaxTree } from '@codemirror/language';

// The parser's node type, reached through the editor package this module
// already depends on.
type SyntaxNode = ReturnType<typeof syntaxTree>['topNode'];

export type DocumentSymbolKind = 'function' | 'method' | 'class' | 'type' | 'module' | 'heading';

export type DocumentSymbol = {
    name: string;
    kind: DocumentSymbolKind;
    /** 1-based line of the declaration. */
    line: number;
    /** Offset of the name, where the cursor lands. */
    from: number;
    /** Nesting for indentation: containing symbols, or a heading's level below 1. */
    depth: number;
    /** Start offset of the declaration or scope header. */
    scopeFrom?: number;
    /** End offset of the declaration body or scope. */
    scopeTo?: number;
};

type SymbolDocumentation = {
    signature: string;
    documentation: string | null;
};

// Node names across the bundled Lezer grammars (JS/TS, Python, Go, Rust, C++, Java).
const DECLARATION_KINDS = new Map<string, DocumentSymbolKind>(Object.entries({
    FunctionDeclaration: 'function',
    FunctionDefinition: 'function',
    FunctionItem: 'function',
    FunctionDecl: 'function',
    MethodDeclaration: 'method',
    MethodDecl: 'method',
    ClassDeclaration: 'class',
    ClassDefinition: 'class',
    InterfaceDeclaration: 'class',
    StructItem: 'class',
    TraitItem: 'class',
    ImplItem: 'class',
    TypeAliasDeclaration: 'type',
    EnumDeclaration: 'type',
    EnumItem: 'type',
    TypeSpec: 'type',
    ModItem: 'module',
    NamespaceDefinition: 'module',
} satisfies Record<string, DocumentSymbolKind>));

// `const foo = () => …` and `static bar = function () {…}` read as functions.
const BINDING_DECLARATIONS = new Map<string, DocumentSymbolKind>([
    ['VariableDeclaration', 'function'],
    ['PropertyDeclaration', 'method'],
]);
const FUNCTION_VALUES = new Set(['ArrowFunction', 'FunctionExpression']);

const NAME_NODES = new Set([
    'VariableDefinition',
    'PropertyDefinition',
    'TypeDefinition',
    'VariableName',
    'DefName',
    'FieldName',
    'BoundIdentifier',
    'TypeIdentifier',
]);

const HEADING_RE = /^(?:ATXHeading|SetextHeading)([1-6])$/;

const childNamed = (node: SyntaxNode, names: ReadonlySet<string>): SyntaxNode | null => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
        if (names.has(child.name)) return child;
    }
    return null;
};

/** What a syntax node declares, or null for a node that names nothing. */
export const symbolKindOf = (node: SyntaxNode): DocumentSymbolKind | null => {
    if (HEADING_RE.test(node.name)) return 'heading';
    const declared = DECLARATION_KINDS.get(node.name);
    if (declared) return declared;
    const binding = BINDING_DECLARATIONS.get(node.name);
    return binding && childNamed(node, FUNCTION_VALUES) ? binding : null;
};

const headingText = (state: EditorState, node: SyntaxNode): string => {
    const firstLine = state.doc.lineAt(node.from);
    return firstLine.text.replace(/^\s{0,3}#{1,6}\s*/, '').replace(/\s+#+\s*$/, '').trim();
};

const isBraceDelim = (state: EditorState, node: SyntaxNode | null): boolean => (
    Boolean(node && node.name === 'Delim' && state.sliceDoc(node.from, node.from + 1) === '{')
);

const isParenDelim = (state: EditorState, node: SyntaxNode | null): boolean => (
    Boolean(node && node.name === 'Delim' && state.sliceDoc(node.from, node.from + 1) === '(')
);

/**
 * Walks `@replit/codemirror-lang-csharp`'s `Program` tree, where each `{ ... }`
 * block is a `Delim` node containing the declarations inside that scope.
 */
const walkCSharpSymbols = (
    state: EditorState,
    container: SyntaxNode,
    depth: number,
    enclosingTypeName: string | null,
    out: DocumentSymbol[],
): void => {
    let currentDepth = depth;
    for (let child: SyntaxNode | null = container.firstChild; child; child = child.nextSibling) {
        if (child.name === 'Keyword') {
            const keyword = state.sliceDoc(child.from, child.to);
            if (keyword === 'namespace') {
                let cursor: SyntaxNode | null = child.nextSibling;
                const parts: string[] = [];
                const firstFrom = cursor ? cursor.from : child.from;
                while (cursor && (cursor.name === 'TypeIdentifier' || cursor.name === '.' || cursor.name === '⚠')) {
                    if (cursor.name === 'TypeIdentifier') {
                        parts.push(state.sliceDoc(cursor.from, cursor.to));
                    }
                    cursor = cursor.nextSibling;
                }
                if (parts.length > 0) {
                    const line = state.doc.lineAt(firstFrom);
                    if (cursor && isBraceDelim(state, cursor)) {
                        out.push({
                            name: parts.join('.'),
                            kind: 'module',
                            line: line.number,
                            from: firstFrom,
                            depth: currentDepth,
                            scopeFrom: line.from,
                            scopeTo: cursor.to,
                        });
                        walkCSharpSymbols(state, cursor, currentDepth + 1, null, out);
                        child = cursor;
                    } else if (cursor && cursor.name === ';') {
                        out.push({
                            name: parts.join('.'),
                            kind: 'module',
                            line: line.number,
                            from: firstFrom,
                            depth: currentDepth,
                            scopeFrom: line.from,
                            scopeTo: container.to,
                        });
                        currentDepth += 1;
                        child = cursor;
                    }
                }
            } else if (
                keyword === 'class'
                || keyword === 'interface'
                || keyword === 'struct'
                || keyword === 'record'
                || keyword === 'enum'
            ) {
                let nameNode: SyntaxNode | null = child.nextSibling;
                while (nameNode && nameNode.name === '⚠') nameNode = nameNode.nextSibling;
                if (nameNode && nameNode.name === 'TypeIdentifier') {
                    const typeName = state.sliceDoc(nameNode.from, nameNode.to);
                    const kind: DocumentSymbolKind = keyword === 'enum' ? 'type' : 'class';
                    const line = state.doc.lineAt(nameNode.from);
                    let cursor: SyntaxNode | null = nameNode.nextSibling;
                    while (cursor && cursor.name !== ';' && !isBraceDelim(state, cursor)) {
                        cursor = cursor.nextSibling;
                    }
                    const scopeTo = cursor ? cursor.to : nameNode.to;
                    out.push({
                        name: typeName,
                        kind,
                        line: line.number,
                        from: nameNode.from,
                        depth: currentDepth,
                        scopeFrom: line.from,
                        scopeTo,
                    });
                    if (cursor && isBraceDelim(state, cursor)) {
                        if (keyword !== 'enum') {
                            walkCSharpSymbols(state, cursor, currentDepth + 1, typeName, out);
                        }
                        child = cursor;
                    } else if (cursor) {
                        child = cursor;
                    }
                }
            } else if (keyword === 'delegate') {
                let cursor: SyntaxNode | null = child.nextSibling;
                let lastTypeId: SyntaxNode | null = null;
                while (cursor && cursor.name !== ';' && !isParenDelim(state, cursor)) {
                    if (cursor.name === 'TypeIdentifier') lastTypeId = cursor;
                    cursor = cursor.nextSibling;
                }
                if (lastTypeId) {
                    const line = state.doc.lineAt(lastTypeId.from);
                    while (cursor && cursor.name !== ';') cursor = cursor.nextSibling;
                    out.push({
                        name: state.sliceDoc(lastTypeId.from, lastTypeId.to),
                        kind: 'type',
                        line: line.number,
                        from: lastTypeId.from,
                        depth: currentDepth,
                        scopeFrom: line.from,
                        scopeTo: cursor ? cursor.to : lastTypeId.to,
                    });
                    if (cursor) child = cursor;
                }
            }
        } else if (enclosingTypeName) {
            if (child.name === 'PropertyName' || child.name === 'MethodName') {
                const name = state.sliceDoc(child.from, child.to);
                const line = state.doc.lineAt(child.from);
                let cursor: SyntaxNode | null = child.nextSibling;
                while (cursor && cursor.name !== ';' && !isBraceDelim(state, cursor)) {
                    cursor = cursor.nextSibling;
                }
                if (cursor && isBraceDelim(state, cursor) && child.name === 'PropertyName') {
                    // Auto-property `{ get; set; } = ...;` may have a trailing initializer.
                    const afterBrace = cursor.nextSibling;
                    if (afterBrace && afterBrace.name === '=') {
                        while (cursor && cursor.name !== ';') cursor = cursor.nextSibling;
                    }
                }
                out.push({
                    name,
                    kind: 'method',
                    line: line.number,
                    from: child.from,
                    depth: currentDepth,
                    scopeFrom: line.from,
                    scopeTo: cursor ? cursor.to : child.to,
                });
                if (cursor) child = cursor;
            } else if (child.name === 'TypeIdentifier' && state.sliceDoc(child.from, child.to) === enclosingTypeName) {
                let next: SyntaxNode | null = child.nextSibling;
                while (next && next.name === '⚠') next = next.nextSibling;
                if (next && isParenDelim(state, next)) {
                    const line = state.doc.lineAt(child.from);
                    let cursor: SyntaxNode | null = next.nextSibling;
                    while (cursor && cursor.name !== ';' && !isBraceDelim(state, cursor)) {
                        cursor = cursor.nextSibling;
                    }
                    out.push({
                        name: enclosingTypeName,
                        kind: 'method',
                        line: line.number,
                        from: child.from,
                        depth: currentDepth,
                        scopeFrom: line.from,
                        scopeTo: cursor ? cursor.to : next.to,
                    });
                    if (cursor) child = cursor;
                }
            }
        }
    }
};

/**
 * Every nameable declaration in document order. Parses up to `timeoutMs` to
 * cover the whole file; a file too large to parse in time lists what was
 * reached.
 */
export const readDocumentSymbols = (state: EditorState, timeoutMs = 200): DocumentSymbol[] => {
    const tree = ensureSyntaxTree(state, state.doc.length, timeoutMs);
    if (!tree) return [];
    if (tree.topNode.name === 'Program') {
        const csharpSymbols: DocumentSymbol[] = [];
        walkCSharpSymbols(state, tree.topNode, 0, null, csharpSymbols);
        return csharpSymbols;
    }
    const symbols: DocumentSymbol[] = [];
    const openEnds: number[] = [];
    tree.iterate({
        enter: (ref) => {
            const kind = symbolKindOf(ref.node);
            if (!kind) return;
            let name: string;
            let from: number;
            if (kind === 'heading') {
                name = headingText(state, ref.node);
                from = ref.from;
            } else {
                const nameNode = childNamed(ref.node, NAME_NODES);
                if (!nameNode) return;
                name = state.sliceDoc(nameNode.from, nameNode.to);
                from = nameNode.from;
            }
            if (!name) return;
            while (openEnds.length > 0 && openEnds[openEnds.length - 1] <= ref.from) openEnds.pop();
            const depth = kind === 'heading' ? Number(HEADING_RE.exec(ref.name)?.[1] ?? 1) - 1 : openEnds.length;
            symbols.push({
                name,
                kind,
                line: state.doc.lineAt(from).number,
                from,
                depth,
                scopeFrom: ref.from,
                scopeTo: ref.to,
            });
            if (kind !== 'heading') openEnds.push(ref.to);
        },
    });
    return symbols;
};

/**
 * Returns the chain of enclosing declarations containing `pos`, outermost first.
 */
export const enclosingSymbolsAtPosition = (state: EditorState, pos: number, timeoutMs = 100): DocumentSymbol[] => {
    const all = readDocumentSymbols(state, timeoutMs);
    if (all.length === 0) return [];
    const chain: DocumentSymbol[] = [];
    for (const symbol of all) {
        if (symbol.kind === 'heading') continue;
        const start = symbol.scopeFrom ?? symbol.from;
        const end = symbol.scopeTo ?? symbol.from;
        if (start <= pos && pos <= end) {
            while (chain.length > 0 && chain[chain.length - 1].depth >= symbol.depth) {
                chain.pop();
            }
            chain.push(symbol);
        }
    }
    return chain;
};

const formatXmlDocLines = (rawLines: string[]): string => {
    const joined = rawLines.join('\n');
    const summaryMatch = /<summary>([\s\S]*?)<\/summary>/i.exec(joined);
    const paramMatches = [...joined.matchAll(/<param\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/param>/gi)];
    const returnsMatch = /<returns>([\s\S]*?)<\/returns>/i.exec(joined);
    const cleanXml = (text: string) => text
        .replace(/<see\s+cref=["']([^"']+)["']\s*\/>/gi, '`$1`')
        .replace(/<c>([\s\S]*?)<\/c>/gi, '`$1`')
        .replace(/<\/?[a-zA-Z0-9_:-]+(?:\s[^>]*)?>/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const sections: string[] = [];
    if (summaryMatch) {
        const cleaned = cleanXml(summaryMatch[1]);
        if (cleaned) sections.push(cleaned);
    } else {
        const fallback = cleanXml(joined);
        if (fallback) sections.push(fallback);
    }
    if (paramMatches.length > 0) {
        sections.push(paramMatches.map((m) => `- \`${m[1]}\`: ${cleanXml(m[2])}`).join('\n'));
    }
    if (returnsMatch) {
        const cleaned = cleanXml(returnsMatch[1]);
        if (cleaned) sections.push(`Returns: ${cleaned}`);
    }
    return sections.join('\n\n').trim();
};

const cleanBlockComment = (raw: string): string => {
    const inner = raw
        .replace(/^\/\*+\s*/, '')
        .replace(/\s*\*+\/$/, '');
    return inner
        .split(/\r?\n/)
        .map((line) => line.replace(/^\s*\*\s?/, '').trimEnd())
        .join('\n')
        .trim();
};

/**
 * Extracts the declaration signature and any immediately preceding JSDoc,
 * C# `///` XML doc, or line comments for the declaration at `targetFrom`.
 */
export const extractSymbolSignatureAndDoc = (state: EditorState, targetFrom: number): SymbolDocumentation => {
    const declLine = state.doc.lineAt(Math.max(0, Math.min(targetFrom, state.doc.length)));
    let sigText = declLine.text.trim();
    // If the declaration header spans multiple lines before `{` or `;`, collect up to 3 lines.
    if (!sigText.includes('{') && !sigText.includes(';') && declLine.number < state.doc.lines) {
        for (let lineNo = declLine.number + 1; lineNo <= Math.min(state.doc.lines, declLine.number + 2); lineNo += 1) {
            const nextText = state.doc.line(lineNo).text.trim();
            if (!nextText) break;
            sigText = `${sigText} ${nextText}`;
            if (nextText.includes('{') || nextText.includes(';') || nextText.includes('=>')) break;
        }
    }
    const cleanedSignature = sigText
        .replace(/\s*\{[\s\S]*$/, '')
        .replace(/\s*=>[\s\S]*$/, '')
        .replace(/;\s*$/, '')
        .trim();

    // Walk upward above the declaration line (skipping C#/TS attributes/decorators `[...]` / `@...`).
    let lineNo = declLine.number - 1;
    while (lineNo >= 1) {
        const trimmed = state.doc.line(lineNo).text.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']') || trimmed.startsWith('@')) {
            lineNo -= 1;
            continue;
        }
        break;
    }

    if (lineNo < 1) {
        return { signature: cleanedSignature, documentation: null };
    }

    const xmlDocLines: string[] = [];
    const slashLines: string[] = [];
    const hashLines: string[] = [];

    const aboveLine = state.doc.line(lineNo).text.trim();
    if (aboveLine.endsWith('*/')) {
        const blockLines: string[] = [];
        for (let cur = lineNo; cur >= 1 && cur >= lineNo - 40; cur -= 1) {
            const text = state.doc.line(cur).text;
            blockLines.unshift(text);
            if (text.includes('/*')) {
                const doc = cleanBlockComment(blockLines.join('\n'));
                return { signature: cleanedSignature, documentation: doc || null };
            }
        }
    }

    for (let cur = lineNo; cur >= 1 && cur >= lineNo - 30; cur -= 1) {
        const trimmed = state.doc.line(cur).text.trim();
        if (trimmed.startsWith('///')) {
            xmlDocLines.unshift(trimmed.replace(/^\/\/\/\s?/, ''));
        } else if (xmlDocLines.length === 0 && trimmed.startsWith('//')) {
            slashLines.unshift(trimmed.replace(/^\/\/\s?/, ''));
        } else if (xmlDocLines.length === 0 && slashLines.length === 0 && trimmed.startsWith('#') && !trimmed.startsWith('#!')) {
            hashLines.unshift(trimmed.replace(/^#\s?/, ''));
        } else {
            break;
        }
    }

    if (xmlDocLines.length > 0) {
        const formatted = formatXmlDocLines(xmlDocLines);
        return { signature: cleanedSignature, documentation: formatted || null };
    }
    if (slashLines.length > 0) {
        return { signature: cleanedSignature, documentation: slashLines.join('\n').trim() || null };
    }
    if (hashLines.length > 0) {
        return { signature: cleanedSignature, documentation: hashLines.join('\n').trim() || null };
    }

    return { signature: cleanedSignature, documentation: null };
};

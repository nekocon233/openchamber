import { EditorSelection, type EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { findInFileSymbolOccurrences, identifierAtPosition } from './symbolNavigation';

type RenameSymbolTarget = {
  name: string;
  from: number;
  to: number;
  ranges: Array<{ from: number; to: number }>;
};

/**
 * Finds the identifier ranges that belong to the same lexical binding as the
 * identifier at `pos` (comments and strings excluded).
 */
export const findScopeRenameRanges = (state: EditorState, pos: number): RenameSymbolTarget | null => {
  const token = identifierAtPosition(state, pos);
  if (!token) return null;

  const occurrences = findInFileSymbolOccurrences(state, token.name);
  if (occurrences.length === 0) return null;

  // Check if the identifier at `pos` resolves to a declaration inside a local scope
  // (e.g. a function/method parameter or local variable).
  const enclosingLocalDeclarations = occurrences
    .filter((occ) => (
      occ.isDeclaration
      && occ.enclosingScopeRange.from <= pos
      && pos <= occ.enclosingScopeRange.to
      && (occ.enclosingScopeRange.from > 0 || occ.enclosingScopeRange.to < state.doc.length)
    ))
    .sort((a, b) => (
      (a.enclosingScopeRange.to - a.enclosingScopeRange.from)
      - (b.enclosingScopeRange.to - b.enclosingScopeRange.from)
    ));

  if (enclosingLocalDeclarations.length > 0) {
    const scope = enclosingLocalDeclarations[0].enclosingScopeRange;
    // Only scope-narrow when the declaration itself is inside that scope (local var / parameter),
    // not when the declaration is a class/function header whose body is `scope`.
    const declInsideScope = enclosingLocalDeclarations[0].from >= scope.from
      && enclosingLocalDeclarations[0].to <= scope.to;
    if (declInsideScope) {
      const scoped = occurrences
        .filter((occ) => occ.from >= scope.from && occ.to <= scope.to)
        .map(({ from, to }) => ({ from, to }));
      if (scoped.length > 0) {
        return { name: token.name, from: token.from, to: token.to, ranges: scoped };
      }
    }
  }

  return {
    name: token.name,
    from: token.from,
    to: token.to,
    ranges: occurrences.map(({ from, to }) => ({ from, to })),
  };
};

/**
 * Selects all in-scope occurrences of the symbol under the cursor as multiple
 * cursors (`Mod+F2` Change All Occurrences).
 */
export const selectAllSymbolOccurrences = (view: EditorView): boolean => {
  const head = view.state.selection.main.head;
  const target = findScopeRenameRanges(view.state, head);
  if (!target || target.ranges.length === 0) return false;

  const mainIndex = Math.max(
    0,
    target.ranges.findIndex((range) => range.from <= head && head <= range.to),
  );
  const selections = target.ranges.map((range) => EditorSelection.range(range.from, range.to));
  view.dispatch({
    selection: EditorSelection.create(selections, mainIndex),
  });
  return true;
};

import type { Extension } from '@codemirror/state';
import { EditorState } from '@codemirror/state';
import { crosshairCursor, drawSelection, keymap, rectangularSelection, type EditorView } from '@codemirror/view';
import { bracketMatching } from '@codemirror/language';
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import {
    copyLineDown,
    copyLineUp,
    deleteLine,
    moveLineDown,
    moveLineUp,
    selectParentSyntax,
    toggleBlockComment,
    toggleComment,
    undoSelection,
} from '@codemirror/commands';
import { selectNextOccurrence } from '@codemirror/search';
import { timerCaretBlink } from './caretBlink';

/**
 * Editing help that needs no language server: the matching bracket lights up
 * and brackets and quotes close themselves. Word completion is deliberately
 * left out.
 */
export const bracketAids = (): Extension => [
    bracketMatching(),
    closeBrackets(),
    keymap.of(closeBracketsKeymap),
];

/**
 * VS Code editing keybindings for line movement, duplication, deletion,
 * comments, and syntax-tree smart selection expansion/shrinking.
 */
const vscodeEditingKeymap = (): Extension => keymap.of([
    { key: 'Mod-/', run: toggleComment, preventDefault: true },
    { key: 'Shift-Alt-a', run: toggleBlockComment, preventDefault: true },
    { key: 'Alt-ArrowUp', run: moveLineUp, preventDefault: true },
    { key: 'Alt-ArrowDown', run: moveLineDown, preventDefault: true },
    { key: 'Shift-Alt-ArrowUp', run: copyLineUp, preventDefault: true },
    { key: 'Shift-Alt-ArrowDown', run: copyLineDown, preventDefault: true },
    { key: 'Mod-Shift-k', run: deleteLine, preventDefault: true },
    { key: 'Shift-Alt-ArrowRight', run: selectParentSyntax, preventDefault: true },
    { key: 'Shift-Alt-ArrowLeft', run: undoSelection, preventDefault: true },
]);

export const runToggleEditorComment = (view: EditorView): boolean => toggleComment(view);

/**
 * Several cursors: Cmd/Ctrl+click adds one (CodeMirror's default; on a
 * relative import path or navigable symbol the click jumps instead),
 * Alt+drag selects a rectangle, and Cmd/Ctrl+D adds the next occurrence of
 * the selection. Desktop only: drawing
 * the selection itself replaces the native one, whose handles a touch screen
 * needs. Vim keeps Ctrl+D for scrolling half a page, so the key is left to it.
 */
export const multipleCursors = ({ vimMode }: { vimMode: boolean }): Extension => [
    EditorState.allowMultipleSelections.of(true),
    drawSelection(),
    timerCaretBlink(),
    rectangularSelection(),
    crosshairCursor(),
    vscodeEditingKeymap(),
    vimMode ? [] : keymap.of([{ key: 'Mod-d', run: selectNextOccurrence, preventDefault: true }]),
];

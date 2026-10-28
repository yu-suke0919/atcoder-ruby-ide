import {
  EditorState, Compartment, EditorView, keymap, lineNumbers, drawSelection,
  StreamLanguage, ruby, indentUnit, indentOnInput, bracketMatching,
  syntaxHighlighting, HighlightStyle, tags, history, historyKeymap, defaultKeymap,
  indentMore, indentLess, redo, closeBrackets, closeBracketsKeymap,
  autocompletion, completionKeymap, startCompletion, closeCompletion,
  search, searchKeymap, openSearchPanel,
} from './vendor/editor/codemirror.mjs';
import { rubyCompletions } from './ruby-completion.mjs';

const colors = HighlightStyle.define([
  { tag: tags.keyword, color: '#c5a3ff' },
  { tag: [tags.string, tags.special(tags.string)], color: '#a9dfbf' },
  { tag: [tags.number, tags.bool, tags.null], color: '#efbe8b' },
  { tag: tags.comment, color: '#8795ab', fontStyle: 'italic' },
  { tag: [tags.definition(tags.variableName), tags.function(tags.variableName)], color: '#8fccec' },
  { tag: [tags.operator, tags.punctuation], color: '#c3cfe1' },
]);
const theme = EditorView.theme({
  '&': { height: '100%', backgroundColor: '#141922', color: '#d5deed' },
  '&.cm-focused': { outline: '2px solid #a78bfa', outlineOffset: '-2px' },
  '.cm-scroller': { fontFamily: 'Consolas, "Liberation Mono", monospace', fontSize: '13px', lineHeight: '24px', overflow: 'auto' },
  '.cm-content': { padding: '12px 0 18px', caretColor: '#e7edf6' },
  '.cm-line': { padding: '0 12px' },
  '.cm-gutters': { backgroundColor: '#141922', color: '#71819b', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '38px', padding: '0 8px' },
  '.cm-cursor': { borderLeftColor: '#e7edf6' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: '#493e6b' },
  '.cm-matchingBracket': { backgroundColor: '#3d5262', outline: '1px solid #8fccec' },
  '.cm-panels': { backgroundColor: '#202735', color: '#e7edf6' },
  '.cm-searchMatch': { backgroundColor: '#725a2c' },
  '.cm-searchMatch-selected': { backgroundColor: '#986c39', outline: '1px solid #efbe8b' },
}, { dark: true });
const phrases = {
  Find: '検索', Replace: '置換', next: '次へ', previous: '前へ', all: 'すべて選択',
  'match case': '大文字小文字を区別', regexp: '正規表現', 'by word': '単語単位',
  replace: '置換する', 'replace all': 'すべて置換', close: '閉じる',
  'Go to line': '行へ移動', go: '移動', 'Selection deleted': '選択範囲を削除しました',
  Completions: '補完候補',
};

function complete(view) {
  if (view.state.readOnly || view.compositionStarted) return false;
  return startCompletion(view);
}

export function createEditor(parent, initial, onChange, onCursor) {
  const writable = new Compartment();
  let readOnly = false;
  const editable = () => [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
  const state = doc => EditorState.create({ doc, extensions: [
    writable.of(editable()), EditorState.tabSize.of(2), indentUnit.of('  '),
    EditorView.contentAttributes.of({ id: 'code-editor', 'data-testid': 'code-editor', 'aria-label': 'Ruby コード', tabindex: '0', spellcheck: 'false', autocapitalize: 'off' }),
    lineNumbers(), drawSelection(), history(), StreamLanguage.define(ruby), indentOnInput(),
    bracketMatching(), closeBrackets(), syntaxHighlighting(colors), theme,
    autocompletion({ override: [rubyCompletions], activateOnTyping: false, defaultKeymap: false, filterStrict: true }),
    EditorView.domEventHandlers({ compositionstart: (_event, view) => { closeCompletion(view); return false; } }),
    search({ top: true }), EditorState.phrases.of(phrases),
    keymap.of([
      { key: 'Tab', run: view => {
        if (view.state.readOnly) return false;
        if (view.state.selection.ranges.some(range => !range.empty)) return indentMore(view);
        view.dispatch({ ...view.state.replaceSelection('  '), userEvent: 'input.indent', scrollIntoView: true });
        return true;
      } },
      { key: 'Shift-Tab', run: indentLess },
      { key: 'Escape', run: view => { view.setTabFocusMode(2000); return closeCompletion(view); } },
      { key: 'Ctrl-Space', run: complete },
      ...completionKeymap.filter(binding => binding.key !== 'Ctrl-Space' && binding.key !== 'Escape' && !binding.mac),
      { key: 'Mod-h', run: openSearchPanel, scope: 'editor search-panel' },
      { key: 'Mod-Shift-z', run: redo, preventDefault: true },
      ...closeBracketsKeymap, ...searchKeymap, ...historyKeymap,
      // Let the application handle Run instead of CodeMirror's insertBlankLine.
      ...defaultKeymap.filter(binding => binding.key !== 'Mod-Enter'),
    ]),
    EditorView.updateListener.of(update => {
      if (update.docChanged) onChange();
      else if (update.selectionSet) onCursor();
    }),
  ] });
  const view = new EditorView({ parent, state: state(initial) });
  return {
    get value() { return view.state.doc.toString(); },
    set value(value) { view.setState(state(value)); },
    get cursor() { const pos = view.state.selection.main.head; const line = view.state.doc.lineAt(pos); return { line: line.number, column: pos - line.from + 1 }; },
    set readOnly(value) { if (readOnly === value) return; readOnly = value; if (value) closeCompletion(view); view.dispatch({ effects: writable.reconfigure(editable()) }); },
    focus() { view.focus(); },
    search() { openSearchPanel(view); },
    complete() { view.focus(); complete(view); },
  };
}

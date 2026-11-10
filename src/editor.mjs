import {
  EditorState, Compartment, StateEffect, StateField, EditorView, Decoration, WidgetType, keymap, lineNumbers, drawSelection,
  StreamLanguage, ruby, indentUnit, indentOnInput, bracketMatching,
  syntaxHighlighting, HighlightStyle, tags, history, historyKeymap, defaultKeymap,
  indentMore, indentLess, redo, closeBrackets, closeBracketsKeymap,
  autocompletion, completionKeymap, completionStatus, acceptCompletion, currentCompletions, selectedCompletionIndex, setSelectedCompletion,
  startCompletion, closeCompletion,
  search, searchKeymap, openSearchPanel,
} from './vendor/editor/codemirror.mjs';
import { lspCompletions } from './lsp-completion.mjs';

const setErrorPosition = StateEffect.define();
const errorPosition = StateField.define({
  create: () => null,
  update(position, transaction) {
    if (transaction.docChanged) position = null;
    for (const effect of transaction.effects) if (effect.is(setErrorPosition)) position = effect.value;
    return position;
  },
  provide: field => EditorView.decorations.from(field, position => position === null ? Decoration.none : Decoration.set([Decoration.line({ class: 'cm-run-error-line' }).range(position)])),
});

// Reading code for rows has two forms, a loop and an array. A button at the right edge of the
// first line of either form, while it is still as generated, puts the other form in its place.
const setReadingForms = StateEffect.define();
class ReadingToggle extends WidgetType {
  constructor(from, to, other, label) { super(); Object.assign(this, { from, to, other, label }); }
  eq(widget) { return widget.from === this.from && widget.to === this.to && widget.other === this.other; }
  toDOM(view) {
    const button = document.createElement('button');
    button.className = 'cm-reading-toggle';
    button.textContent = '⇄';
    button.title = button.ariaLabel = this.label;
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', () => {
      if (view.state.readOnly) return;
      view.dispatch({ changes: { from: this.from, to: this.to, insert: this.other }, userEvent: 'input.reading' });
    });
    return button;
  }
  ignoreEvent() { return true; }
}
function readingToggles(state, forms) {
  // Most files have no reading forms; large ones must not be copied on every key.
  if (!forms.length) return Decoration.none;
  const text = state.doc.toString();
  const toggles = [];
  for (const pair of forms) {
    pair.forEach((form, index) => {
      for (let from = text.indexOf(form); from >= 0; from = text.indexOf(form, from + 1)) {
        const to = from + form.length;
        if ((from > 0 && text[from - 1] !== '\n') || (to < text.length && text[to] !== '\n')) continue;
        const label = index === 0 ? '配列に入れる形にする' : 'ループで読む形にする';
        toggles.push(Decoration.widget({ widget: new ReadingToggle(from, to, pair[1 - index], label), side: 1 }).range(state.doc.lineAt(from).to));
      }
    });
  }
  return Decoration.set(toggles, true);
}
const readingField = forms => StateField.define({
  create: state => ({ forms, decorations: readingToggles(state, forms) }),
  update(value, transaction) {
    const set = transaction.effects.find(effect => effect.is(setReadingForms));
    if (!set && !transaction.docChanged) return value;
    const next = set ? set.value : value.forms;
    return { forms: next, decorations: readingToggles(transaction.state, next) };
  },
  provide: field => EditorView.decorations.from(field, value => value.decorations),
});

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
  '.cm-run-error-line': { backgroundColor: '#57313e', boxShadow: 'inset 3px 0 #f5a3b2' },
  '.cm-panels': { backgroundColor: '#202735', color: '#e7edf6' },
  '.cm-searchMatch': { backgroundColor: '#725a2c' },
  '.cm-searchMatch-selected': { backgroundColor: '#986c39', outline: '1px solid #efbe8b' },
  '.cm-completionInfo': { maxWidth: 'min(360px, calc(100vw - 24px))', maxHeight: 'min(240px, calc(100vh - 24px))', overflow: 'auto', overflowWrap: 'anywhere' },
}, { dark: true });
const phrases = {
  Find: '検索', Replace: '置換', next: '次へ', previous: '前へ', all: 'すべて選択',
  'match case': '大文字小文字を区別', regexp: '正規表現', 'by word': '単語単位',
  replace: '置換する', 'replace all': 'すべて置換', close: '閉じる',
  'Go to line': '行へ移動', go: '移動', 'Selection deleted': '選択範囲を削除しました',
  Completions: '補完候補',
};

// Tab takes the selected candidate, or the first. Right after they open, and while typing queries
// them again, CodeMirror cannot accept them yet, so this waits unless the document changes
// (docs/code-editor.md).
function acceptWhenReady(view) {
  const doc = view.state.doc;
  const attempt = () => {
    if (view.state.doc !== doc || view.state.readOnly || completionStatus(view.state) === null) return;
    if (currentCompletions(view.state).length) {
      if (selectedCompletionIndex(view.state) === null) view.dispatch({ effects: setSelectedCompletion(0) });
      if (acceptCompletion(view)) return;
    }
    setTimeout(attempt, 20);
  };
  attempt();
}

export function createEditor(parent, initial, onChange, onCursor, completionClient) {
  const writable = new Compartment();
  // Ruby LSP's replies are used only while the editor shows the state they were asked for.
  const completion = new Compartment();
  // Typing opens candidates with none selected, so Enter still breaks the line; Ctrl+Space selects
  // the first until those candidates close (docs/code-editor.md).
  let explicit = false;
  const completer = currentRevision => autocompletion({ override: [lspCompletions(completionClient, () => revision === currentRevision)], selectOnOpen: explicit, defaultKeymap: false, filterStrict: true });
  const complete = view => {
    if (view.state.readOnly || view.compositionStarted) return false;
    if (!explicit) { explicit = true; view.dispatch({ effects: completion.reconfigure(completer(revision)) }); }
    return startCompletion(view);
  };
  // The other files of the open problem keep their state, and with it their undo history.
  const files = new Map();
  let file = null;
  let readOnly = false;
  let revision = 0;
  let readingForms = [];
  const editable = () => [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
  const state = (doc, currentRevision = revision) => EditorState.create({ doc, extensions: [
    writable.of(editable()), EditorState.tabSize.of(2), indentUnit.of('  '),
    EditorView.contentAttributes.of({ id: 'code-editor', 'data-testid': 'code-editor', 'aria-label': 'Ruby コード', tabindex: '0', spellcheck: 'false', autocapitalize: 'off' }),
    lineNumbers(), drawSelection(), history(), errorPosition, readingField(readingForms), StreamLanguage.define(ruby), indentOnInput(),
    bracketMatching(), closeBrackets(), syntaxHighlighting(colors), theme,
    completion.of(completer(currentRevision)),
    EditorView.domEventHandlers({ compositionstart: (_event, view) => { closeCompletion(view); return false; } }),
    search({ top: true }), EditorState.phrases.of(phrases),
    keymap.of([
      { key: 'Tab', run: view => {
        if (view.state.readOnly) return false;
        if (completionStatus(view.state) !== null) { acceptWhenReady(view); return true; }
        if (view.state.selection.ranges.some(range => !range.empty)) return indentMore(view);
        view.dispatch({ ...view.state.replaceSelection('  '), userEvent: 'input.indent', scrollIntoView: true });
        return true;
      } },
      { key: 'Shift-Tab', run: indentLess },
      { key: 'Escape', run: view => {
        if (closeCompletion(view)) return true;
        view.setTabFocusMode(2000);
        return false;
      } },
      { key: 'Ctrl-Space', run: complete },
      ...completionKeymap.filter(binding => binding.key !== 'Ctrl-Space' && binding.key !== 'Escape' && !binding.mac),
      { key: 'Mod-h', run: openSearchPanel, scope: 'editor search-panel' },
      { key: 'Mod-Shift-z', run: redo, preventDefault: true },
      ...closeBracketsKeymap, ...searchKeymap, ...historyKeymap,
      // Let the application handle Run instead of CodeMirror's insertBlankLine.
      ...defaultKeymap.filter(binding => binding.key !== 'Mod-Enter'),
    ]),
    EditorView.updateListener.of(update => {
      if (explicit && completionStatus(update.startState) !== null && completionStatus(update.state) === null) {
        explicit = false;
        queueMicrotask(() => { if (!explicit) view.dispatch({ effects: completion.reconfigure(completer(revision)) }); });
      }
      if (update.docChanged) onChange();
      else if (update.selectionSet) onCursor();
    }),
  ] });
  const view = new EditorView({ parent, state: state(initial) });
  return {
    get value() { return view.state.doc.toString(); },
    /** Shows `name` with `code`. Within one problem (`sameProblem`) a file shown again keeps its
     * undo history; another problem starts every file afresh (docs/code-editor.md). */
    show(name, code, sameProblem = false) {
      revision++;
      explicit = false;
      if (!sameProblem) files.clear();
      else if (file !== null) files.set(file, view.state);
      const kept = files.get(name);
      files.delete(name);
      file = name;
      if (kept?.doc.toString() !== code) { view.setState(state(code)); return; }
      view.setState(kept);
      view.dispatch({ effects: [writable.reconfigure(editable()), completion.reconfigure(completer(revision)), setReadingForms.of(readingForms), setErrorPosition.of(null)] });
    },
    renameFile(from, to) {
      if (file === from) file = to;
      else if (files.has(from)) { files.set(to, files.get(from)); files.delete(from); }
    },
    forgetFile(name) { files.delete(name); },
    // The [loop, array] forms of the open problem's reading code; kept for its other files.
    set readingForms(forms) { readingForms = forms; view.dispatch({ effects: setReadingForms.of(forms) }); },
    set errorLine(line) {
      const position = Number.isInteger(line) && line > 0 && line <= view.state.doc.lines ? view.state.doc.line(line).from : null;
      if (view.state.field(errorPosition) !== position) view.dispatch({ effects: setErrorPosition.of(position) });
    },
    jumpToError() {
      const position = view.state.field(errorPosition);
      if (position === null) return;
      view.dispatch({ selection: { anchor: position }, effects: EditorView.scrollIntoView(position, { y: 'center' }) });
      view.focus();
    },
    // What F1 searches for in るりま (D3): the selected text, or else the word at the cursor.
    get searchText() {
      const { from, to, head } = view.state.selection.main;
      if (from !== to) return view.state.sliceDoc(from, to);
      const word = view.state.wordAt(head);
      return word ? view.state.sliceDoc(word.from, word.to) : '';
    },
    get cursor() { const pos = view.state.selection.main.head; const line = view.state.doc.lineAt(pos); return { line: line.number, column: pos - line.from + 1 }; },
    set readOnly(value) { if (readOnly === value) return; readOnly = value; if (value) closeCompletion(view); view.dispatch({ effects: writable.reconfigure(editable()) }); },
    focus() { view.focus(); },
    search() { openSearchPanel(view); },
    complete() { view.focus(); complete(view); },
  };
}

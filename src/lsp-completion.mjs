import { insertCompletionText, pickedCompletion } from './vendor/editor/codemirror.mjs';
import { rubyCompletions } from './ruby-completion.mjs';

export function createLspClient(bridge, onStatus) {
  let ready = false;
  let tail = Promise.resolve();
  const status = (value, error = '') => onStatus({ status: value, error: String(error) });
  const enqueue = task => {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  };
  async function start() {
    if (ready) return;
    status('starting');
    await bridge.lspStart();
    ready = true;
    status('ready');
  }
  const guarded = task => enqueue(async () => {
    try { return await task(); }
    catch (error) { ready = false; status('failed', error.message || error); throw error; }
  });
  return {
    complete: (code, line, character, current) => guarded(async () => {
      if (!current()) return null;
      await start();
      if (!current()) return null;
      return bridge.lspComplete(code, line, character);
    }),
    retry: () => guarded(async () => {
      ready = false;
      status('starting');
      await bridge.lspStop();
      await start();
    }),
  };
}

function position(doc, point) {
  if (!point || !Number.isInteger(point.line) || !Number.isInteger(point.character) || point.line < 0 || point.line >= doc.lines) return null;
  const line = doc.line(point.line + 1), column = point.character;
  if (column < 0 || column > line.length) return null;
  // Reject positions inside UTF-16 surrogate pairs.
  if (column > 0 && /[\uD800-\uDBFF]/.test(line.text[column - 1]) && /[\uDC00-\uDFFF]/.test(line.text[column] || '')) return null;
  return line.from + column;
}

function remoteOption(item, context, current, fallback) {
  if (!item || typeof item.label !== 'string' || !item.label || item.insertTextFormat === 2 || item.command || item.additionalTextEdits && (!Array.isArray(item.additionalTextEdits) || item.additionalTextEdits.length)) return null;
  const { state, pos } = context;
  const edit = item.textEdit;
  const range = edit?.range || edit?.replace;
  if (edit && !range) return null;
  const from = range ? position(state.doc, range.start) : fallback.from;
  const to = range ? position(state.doc, range.end) : pos + state.sliceDoc(pos, state.doc.lineAt(pos).to).match(/^[\p{L}\p{N}_]*(?:\?|!(?![=~]))?/u)[0].length;
  const text = edit?.newText ?? item.insertText ?? item.label;
  if (from === null || to === null || from > pos || to < pos || from > to || typeof text !== 'string') return null;
  const known = fallback.options.find(option => option.label === item.label);
  const owner = item.data?.owner_name;
  const summary = typeof known?.info === 'string' ? known.info.split('\n\n').find(text => text.startsWith(`${owner}#`)) : null;
  const signature = `${owner ? `${owner}#` : ''}${item.label}${item.labelDetails?.detail || ''}`;
  const documentation = typeof item.documentation === 'string' ? item.documentation : item.documentation?.value;
  return {
    label: typeof item.filterText === 'string' ? item.filterText : item.label,
    displayLabel: item.label,
    editFrom: from,
    type: ({ 2: 'method', 3: 'function', 6: 'variable', 7: 'class', 9: 'namespace', 10: 'property', 14: 'keyword', 21: 'constant' })[item.kind] || 'text',
    detail: `LSP${owner ? ` · ${owner}` : ''}`,
    info: summary || [signature, documentation, item.labelDetails?.description].filter(Boolean).join('\n\n'),
    apply(view, completion) {
      if (!current()) return;
      view.dispatch({ ...insertCompletionText(view.state, text, from, to), annotations: pickedCompletion.of(completion) });
    },
  };
}

export function lspCompletions(client, active = () => true) {
  return async context => {
    const fallback = rubyCompletions(context);
    if (!fallback) return null;
    let canceled = false;
    context.addEventListener('abort', () => { canceled = true; }, { onDocChange: true });
    const { state, pos, view } = context;
    const current = () => !canceled && !context.aborted && active() && (!view || view.state.doc === state.doc && view.state.selection.main.head === pos && !view.state.readOnly && !view.compositionStarted);
    if (!current()) return null;
    const line = state.doc.lineAt(pos);
    let response;
    try { response = await client.complete(state.doc.toString(), line.number - 1, pos - line.from, current); }
    catch { return current() ? fallback : null; }
    if (!current()) return null;
    const items = Array.isArray(response) ? response : response?.items || [];
    if (!Array.isArray(items)) return fallback;
    const remote = new Map();
    for (const item of items) {
      const option = remoteOption(item, context, current, fallback);
      if (option && !remote.has(item.label)) remote.set(item.label, option);
    }
    if (!remote.size) return fallback;
    const member = state.sliceDoc(Math.max(0, fallback.from - 1), fallback.from) === '.' && state.sliceDoc(Math.max(0, fallback.from - 2), fallback.from) !== '..';
    const options = [...remote.values()];
    const from = options.reduce((from, option) => Math.min(from, option.editFrom), fallback.from);
    for (const option of fallback.options) {
      if ((!member || option.type === 'snippet') && !remote.has(option.label)) options.push(option);
    }
    return { from, options, validFor: (_text, _from, _to, next) => next.doc === state.doc && next.selection.main.head === pos && !next.readOnly };
  };
}

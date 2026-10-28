import { completeAnyWord, ensureSyntaxTree, insertCompletionText, pickedCompletion, snippetCompletion } from './vendor/editor/codemirror.mjs';

const entries = (words, type, detail) => words.split(' ').map(label => ({ label, type, detail }));
const keywords = entries('alias and BEGIN begin break case class def defined? do else elsif END end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield __FILE__ __LINE__ __ENCODING__', 'keyword', 'キーワード');
const globals = entries('gets puts putc p print printf warn raise exit require require_relative loop proc lambda', 'function', '標準メソッド');
const constants = entries('Array Hash Integer Float String Math', 'class', '組み込み');
const methods = entries('new chomp split to_i to_f to_s each each_with_index map map! select reject reduce sum min max minmax sort sort! sort_by reverse reverse! length size empty? include? count times upto downto abs gcd lcm divmod even? odd? join push pop shift unshift first last keys values fetch dig zip transpose flatten uniq compact any? all? find bsearch', 'method', '標準メソッド');
const conditional = snippetCompletion('if ${condition}\n\t\nend', { label: 'if … end', type: 'snippet', detail: '条件分岐' });
const iteration = member => snippetCompletion(member ? 'each do |${item}|\n\t\nend' : '${items}.each do |item|\n\t\nend', { label: 'each do … end', type: 'snippet', detail: '繰り返し' });
const integers = snippetCompletion('gets.split.map(&:to_i)${}', { label: 'gets.split.map(&:to_i)', type: 'snippet', detail: '整数列の入力' });
const identifier = /^[\p{L}_][\p{L}\p{N}_]*[!?]?$/u;

// Filter using the prefix, but replace the entire identifier when accepting.
function replaceIdentifier(option) {
  return { ...option, apply(view, completion, from, to) {
    if (view.state.readOnly) return;
    const rest = view.state.sliceDoc(to, view.state.doc.lineAt(to).to).match(/^[\p{L}\p{N}_]*(?:\?|!(?![=~]))?/u)[0];
    if (typeof option.apply === 'function') option.apply(view, completion, from, to + rest.length);
    else view.dispatch({ ...insertCompletionText(view.state, option.label, from, to + rest.length), annotations: pickedCompletion.of(completion) });
  } };
}

export function rubyCompletions(context) {
  const { state, pos } = context;
  if (state.readOnly || !state.selection.main.empty || context.view?.compositionStarted) return null;
  const tree = ensureSyntaxTree(state, pos, 100);
  if (!tree) return null;
  for (let node = tree.resolveInner(pos, -1); node; node = node.parent) {
    if (/^(comment|string)/.test(node.name)) return null;
  }
  const word = context.matchBefore(/[\p{L}\p{N}_]+[!?]?/u);
  if (word && !identifier.test(word.text)) return null;
  if (!word && !context.explicit) return null;
  const from = word ? word.from : pos;
  const member = state.sliceDoc(Math.max(0, from - 1), from) === '.';
  const options = member ? [...methods, iteration(true)] : [...keywords, ...globals, ...constants, conditional, iteration(false), integers];
  const seen = new Set(options.map(option => option.label));
  if (!member) {
    for (const option of completeAnyWord(context)?.options || []) {
      if (!identifier.test(option.label) || seen.has(option.label)) continue;
      seen.add(option.label);
      options.push({ ...option, type: 'variable', detail: '文書内' });
    }
  }
  return { from, options: options.map(replaceIdentifier), validFor: /^[\p{L}\p{N}_]*[!?]?$/u };
}

// Short reference for Ruby 3.4's standard APIs. These are method names, not call snippets.
const common = [
  ['length', '要素または文字の数を返します。'],
  ['size', '要素または文字の数を返します。'],
  ['empty?', '空ならtrueを返します。'],
  ['to_s', '文字列表現を返します。'],
];
const enumerable = [
  ['each_with_index { |item, index| ... }', '要素と0始まりの位置を順に渡します。ブロック省略時はEnumeratorを返します。'],
  ['map { |item| ... }', '各要素の処理結果を新しい配列にします。ブロック省略時はEnumeratorを返します。'],
  ['reduce(initial) { |memo, item| ... }', '累積値と各要素を使って集約します。初期値の省略やメソッド名による指定もできます。'],
  ['sum(initial = 0) { |item| ... }', '要素の合計を返します。ブロックを渡すと各処理結果を合計します。'],
  ['min', '最小の要素を返します。個数や比較ブロックも指定できます。'],
  ['max', '最大の要素を返します。個数や比較ブロックも指定できます。'],
  ['minmax', '最小・最大の要素を配列で返します。比較ブロックも指定できます。'],
  ['sort { |a, b| ... }', '要素を並べ替えた配列を返します。比較ブロックは省略できます。'],
  ['sort_by { |item| ... }', 'ブロックの結果を基準に並べ替えます。ブロック省略時はEnumeratorを返します。'],
  ['count(item) { |item| ... }', '要素数を数えます。引数・ブロックの省略や、値・条件の指定ができます。'],
  ['any? { |item| ... }', '条件を満たす要素があればtrue。ブロックの省略やパターン指定もできます。'],
  ['all? { |item| ... }', '全要素が条件を満たせばtrue。ブロックの省略やパターン指定もできます。'],
  ['find { |item| ... }', '条件を満たす最初の要素を返します。ブロック省略時はEnumeratorを返します。'],
];
const definitions = {
  String: [...common,
    ['upcase(*options)', '大文字にした新しい文字列を返します。'],
    ['downcase(*options)', '小文字にした新しい文字列を返します。'],
    ['chomp(separator = $/)', '末尾の改行などの区切りを除いた文字列を返します。'],
    ['split(pattern = $;, limit = 0)', '空白または指定した区切りで分割した配列を返します。ブロックも指定できます。'],
    ['to_i(base = 10)', '先頭から整数として読み取ります。基数も指定できます。'],
    ['to_f', '先頭から浮動小数点数として読み取ります。'],
    ['include?(string)', '指定した文字列を含むかを返します。'],
    ['count(*strings)', '指定した文字集合に含まれる文字数を返します。'],
    ['reverse', '文字順を逆にした新しい文字列を返します。'],
    ['reverse!', 'この文字列の文字順を逆に変更します。'],
    ['chars', '文字ごとに分けた配列を返します。'],
    ['bytes', 'バイトごとの整数を配列で返します。'],
    ['lines(separator = $/, chomp: false)', '行ごとに分けた配列を返します。'],
    ['strip', '前後の空白を除いた新しい文字列を返します。'],
    ['sub(pattern, replacement)', '最初の一致を置換した文字列を返します。置換用ブロックも指定できます。'],
    ['gsub(pattern, replacement)', 'すべての一致を置換した文字列を返します。置換用ブロックも指定できます。'],
    ['start_with?(*prefixes)', '指定した接頭辞で始まるかを返します。正規表現も指定できます。'],
    ['end_with?(*suffixes)', '指定した接尾辞で終わるかを返します。'],
  ],
  Array: [...common, ...enumerable,
    ['each { |item| ... }', '要素を順に渡します。ブロック省略時はEnumeratorを返します。'],
    ['map! { |item| ... }', '各要素をブロックの結果で置き換えます。'],
    ['select { |item| ... }', '条件を満たす要素の配列を返します。'],
    ['reject { |item| ... }', '条件を満たさない要素の配列を返します。'],
    ['sort! { |a, b| ... }', 'この配列を並べ替えます。比較ブロックは省略できます。'],
    ['reverse', '要素を逆順にした新しい配列を返します。'],
    ['reverse!', 'この配列を逆順に変更します。'],
    ['include?(object)', '指定した要素を含むかを返します。'],
    ['join(separator = $,)', '要素を区切り文字でつないだ文字列を返します。'],
    ['push(*objects)', '末尾に要素を追加します。'],
    ['pop(count)', '末尾の要素を取り除いて返します。個数を省略すると1要素を返します。'],
    ['shift(count)', '先頭の要素を取り除いて返します。個数を省略すると1要素を返します。'],
    ['unshift(*objects)', '先頭に要素を追加します。'],
    ['first(count)', '先頭の要素を返します。個数を省略すると1要素を返します。'],
    ['last(count)', '末尾の要素を返します。個数を省略すると1要素を返します。'],
    ['fetch(index, default) / fetch(index) { |index| ... }', '位置の要素を返します。範囲外の場合の既定値・ブロックは省略でき、省略時はIndexErrorです。'],
    ['dig(index, *indices)', '位置を順にたどり、ネストした値を取得します。'],
    ['zip(*arrays)', '同じ位置の要素をまとめた配列を返します。ブロックも指定できます。'],
    ['transpose', '行と列を入れ替えた配列を返します。'],
    ['flatten(level)', 'ネストした配列を平坦化します。深さの指定は省略できます。'],
    ['uniq { |item| ... }', '重複を除いた配列を返します。比較用ブロックは省略できます。'],
    ['compact', 'nilを除いた配列を返します。'],
    ['bsearch { |item| ... }', '整列済み配列をブロックの条件で二分探索します。'],
  ],
  Hash: [...common, ...enumerable,
    ['each { |key, value| ... }', 'キーと値を順に渡します。ブロック省略時はEnumeratorを返します。'],
    ['each_key { |key| ... }', 'キーを順に渡します。ブロック省略時はEnumeratorを返します。'],
    ['each_value { |value| ... }', '値を順に渡します。ブロック省略時はEnumeratorを返します。'],
    ['keys', 'キーの配列を返します。'],
    ['values', '値の配列を返します。'],
    ['fetch(key, default) / fetch(key) { |key| ... }', 'キーの値を返します。未登録時の既定値・ブロックは省略でき、省略時はKeyErrorです。'],
    ['dig(key, *keys)', 'キーを順にたどり、ネストした値を取得します。'],
    ['include?(key)', 'キーが登録されているかを返します。'],
    ['key?(key)', 'キーが登録されているかを返します。'],
    ['value?(value)', '値が登録されているかを返します。'],
    ['select { |key, value| ... }', '条件を満たす組を新しいハッシュで返します。'],
    ['reject { |key, value| ... }', '条件を満たさない組を新しいハッシュで返します。'],
    ['merge(*hashes) { |key, old, new| ... }', 'ハッシュを統合した新しいハッシュを返します。競合時の処理は省略できます。'],
    ['merge!(*hashes) { |key, old, new| ... }', 'このハッシュへ統合します。競合時の処理は省略できます。'],
    ['delete(key) { |key| ... }', 'キーの組を取り除いて値を返します。未登録時のブロックは省略できます。'],
  ],
};
const options = Object.fromEntries(Object.entries(definitions).map(([owner, rows]) => [owner, rows.map(([signature, description]) => ({
  label: signature.match(/^\w+[!?]?/)[0], type: 'method', detail: owner, info: `${owner}#${signature}\n${description}`,
}))]));
const general = new Map();
for (const list of Object.values(options)) for (const option of list) {
  const previous = general.get(option.label);
  general.set(option.label, { ...option, detail: '標準メソッド', info: previous ? `${previous.info}\n\n${option.info}` : option.info });
}
export const methodCompletions = type => type ? options[type] : [...general.values()];

export function receiverType(state, tree, from) {
  let end = from - 1; // The dot immediately before the method name.
  if (end > 0 && state.sliceDoc(end - 1, end) === '&') end--;
  const minimum = Math.max(0, end - 4096);
  const text = state.sliceDoc(minimum, end);
  const opening = { ')': '(', ']': '[', '}': '{' };
  function literal(to, depth = 0) {
    if (depth > 8) return null;
    while (to > minimum && /\s/.test(text[to - minimum - 1])) to--;
    const token = tree.resolveInner(to, -1);
    if (token.name === 'string' && token.to === to && token.from >= minimum) {
      const value = state.sliceDoc(token.from, token.to);
      if (/^["']/.test(value) && value.length >= 2 && value.at(-1) === value[0] && !(value[0] === '"' && /#[{@$]/.test(value))) return { type: 'String', from: token.from };
      return null;
    }
    const last = text[to - minimum - 1];
    if (!opening[last]) return null;
    const stack = [];
    for (let i = to - 1; i >= minimum; i--) {
      const ch = text[i - minimum];
      if (!'()[]{}'.includes(ch)) continue;
      const node = tree.resolveInner(i, 1);
      if (/^(string|comment|atom)/.test(node.name)) { i = node.from; continue; }
      if (opening[ch]) stack.push(opening[ch]);
      else if (stack.pop() !== ch) return null;
      else if (!stack.length) {
        if (last !== ')') return { type: last === ']' ? 'Array' : 'Hash', from: i };
        const inner = literal(to - 1, depth + 1);
        return inner && /^\s*$/.test(state.sliceDoc(i + 1, inner.from)) ? { ...inner, from: i } : null;
      }
    }
    return null;
  }
  const result = literal(end);
  if (!result) return null;
  let before = result.from;
  const boundary = Math.max(0, before - 64);
  while (before > boundary && /[ \t\r]/.test(state.sliceDoc(before - 1, before))) before--;
  if (before === 0) return result.type;
  if (before === boundary) return null;
  const token = tree.resolveInner(before, -1);
  const previous = state.sliceDoc(before - 1, before);
  if (previous === ':' && token.name !== 'atom') return null;
  if (previous === '\n' && /\\\r?\n$/.test(state.sliceDoc(Math.max(0, before - 3), before))) return null;
  if (/[\n=,;([{:]$/.test(previous)) return result.type;
  return token.name === 'keyword' && /^(return|yield|then|else)$/.test(state.sliceDoc(token.from, token.to)) ? result.type : null;
}

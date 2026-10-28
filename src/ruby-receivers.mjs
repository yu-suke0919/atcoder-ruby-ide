const simpleString = value => /^["']/.test(value) && value.length >= 2 && value.at(-1) === value[0] && !(value[0] === '"' && /#[{@$]/.test(value));

function literalAt(state, tree, end) {
  const minimum = Math.max(0, end - 4096);
  const text = state.sliceDoc(minimum, end);
  const opening = { ')': '(', ']': '[', '}': '{' };
  function literal(to, depth = 0) {
    if (depth > 8) return null;
    while (to > minimum && /\s/.test(text[to - minimum - 1])) to--;
    const token = tree.resolveInner(to, -1);
    if (token.name === 'string' && token.to === to && token.from >= minimum) {
      const value = state.sliceDoc(token.from, token.to);
      if (simpleString(value)) return { type: 'String', from: token.from };
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
  return literal(end);
}

function atExpressionStart(state, tree, before) {
  const boundary = Math.max(0, before - 64);
  while (before > boundary && /[ \t\r]/.test(state.sliceDoc(before - 1, before))) before--;
  if (before === 0) return true;
  if (before === boundary) return false;
  const token = tree.resolveInner(before, -1);
  const previous = state.sliceDoc(before - 1, before);
  if (previous === ':' && token.name !== 'atom') return false;
  if (previous === '\n' && /\\\r?\n$/.test(state.sliceDoc(Math.max(0, before - 3), before))) return false;
  if (/[\n=,;([{:]$/.test(previous)) return true;
  return token.name === 'keyword' && /^(return|yield|then|else)$/.test(state.sliceDoc(token.from, token.to));
}

const localName = '[\\p{Ll}\\p{Lo}\\p{Lm}_][\\p{L}\\p{N}_]*';
const localIdentifier = new RegExp(`^${localName}$`, 'u');
const assignment = new RegExp(`^\\s*(${localName})[ \\t]*=(?!=|>|~)[ \\t]*`, 'u');
const pendingCall = new RegExp(`^(?:${localName}\\s*)?(?:\\(\\s*)*$`, 'u');

// Track only straight-line literal assignments. Every other statement is a barrier.
function localType(state, tree, end) {
  if (end > 16384) return null;
  while (end > 0 && /[ \t]/.test(state.sliceDoc(end - 1, end))) end--;
  const token = tree.resolveInner(end, -1);
  const name = state.sliceDoc(token.from, end);
  if (token.name !== 'variableName' || token.to !== end || !localIdentifier.test(name)) return null;
  const code = state.sliceDoc(0, token.from);
  const masked = code.split('');
  const opaque = new Map();
  tree.iterate({ to: code.length, enter(node) {
    if (!/^(string|comment|atom|number)/.test(node.name) || node.from >= code.length) return;
    const text = code.slice(node.from, node.to);
    const unsafe = /^string/.test(node.name) ? !simpleString(text) : node.name === 'atom' && /#[{@$]/.test(text);
    opaque.set(node.from, { to: node.to, comment: node.name === 'comment', unsafe });
    for (let i = node.from; i < Math.min(node.to, code.length); i++) if (masked[i] !== '\n') masked[i] = ' ';
    return false;
  } });
  const visible = masked.join('');
  // The legacy Ruby mode cannot reliably delimit every heredoc spelling.
  for (const match of visible.matchAll(/<<[-~]?/g)) {
    if (/^[ \t]*['"`]?[\p{L}_]/u.test(code.slice(match.index + match[0].length))) return null;
  }
  if (/(?:^|\n)__END__(?:\r?\n|$)/.test(visible)) return null;
  const known = new Map();
  const stack = [];
  let start = 0, last = 0, unsafe = false;
  function finish() {
    if (last <= start) return;
    const match = code.slice(start, last).match(assignment);
    const value = match && literalAt(state, tree, last);
    const rhs = start + (match?.[0].length || 0);
    if (!value || value.from !== rhs) { known.clear(); return; }
    const expression = masked.slice(rhs, last).join('').replace(/\b(?:nil|true|false)\b/g, '').replace(/=>/g, '');
    if (unsafe || !/^[\s[\]{},():+-]*$/.test(expression)) known.clear();
    known.set(match[1], value.type);
  }
  for (let i = 0; i < code.length;) {
    const span = opaque.get(i);
    if (span) {
      if (!span.comment) { last = span.to; unsafe ||= span.unsafe; }
      i = span.to;
      continue;
    }
    const ch = code[i];
    const tail = ch === '\n' && tree.resolveInner(last, -1);
    const continued = ch === '\n' && (/[=,+\-*/%&|^<>?:.\\!~]/.test(masked[last - 1] || ' ') ||
      tail.name === 'keyword' && /^(and|or|not|rescue|defined\?)$/.test(code.slice(tail.from, tail.to)));
    if (!stack.length && (ch === ';' || ch === '\n' && !continued)) {
      finish();
      start = last = ++i;
      unsafe = false;
      continue;
    }
    if ('([{'.includes(ch)) {
      stack.push(ch);
      if (stack.length > 64) return null;
    } else if (')]}'.includes(ch) && stack.pop() !== { ')': '(', ']': '[', '}': '{' }[ch]) return null;
    if (!/\s/.test(ch)) last = i + 1;
    i++;
  }
  return pendingCall.test(masked.slice(start).join('').trim()) ? known.get(name) || null : null;
}

export function receiverType(state, tree, from) {
  let end = from - 1;
  if (end > 0 && state.sliceDoc(end - 1, end) === '&') end--;
  const value = literalAt(state, tree, end);
  if (value && atExpressionStart(state, tree, value.from)) return value.type;
  return localType(state, tree, end);
}

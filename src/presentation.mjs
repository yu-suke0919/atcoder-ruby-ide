import katex from './vendor/katex/katex.mjs';

export function renderStatement(target, parts) {
  const nodes = parts.map(part => {
    if (part.type === 'text') return document.createTextNode(part.text);
    if (part.type === 'code') {
      const pre = document.createElement('pre'); pre.textContent = part.text; return pre;
    }
    if (part.type === 'preformatted') {
      const pre = document.createElement('pre'); renderStatement(pre, part.parts); return pre;
    }
    if (part.type === 'math') {
      const span = document.createElement(part.display ? 'div' : 'span');
      try {
        katex.render(part.text, span, { displayMode: part.display, throwOnError: true, trust: false, maxExpand: 1000, maxSize: 20, strict: 'ignore' });
      } catch {
        span.className = 'math-fallback'; span.textContent = part.text; span.title = '数式を整形できないため原文を表示しています。';
      }
      return span;
    }
    if (part.type === 'image') {
      const button = document.createElement('button'); button.className = 'statement-image';
      button.setAttribute('aria-label', `${part.alt || '問題の図'}を拡大`);
      const img = document.createElement('img'); img.src = part.data; img.alt = part.alt || '問題の図'; img.width = part.width; img.height = part.height;
      img.addEventListener('error', () => {
        button.textContent = `画像を表示できません：${img.alt}。対象の問題を取り直してください。`;
        button.disabled = true;
      });
      button.append(img);
      button.addEventListener('click', () => {
        const preview = document.getElementById('image-preview');
        preview.src = part.data; preview.alt = img.alt;
        document.getElementById('image-heading').textContent = img.alt;
        document.getElementById('image-dialog').showModal();
      });
      return button;
    }
    return document.createTextNode('');
  });
  target.replaceChildren(...nodes);
}

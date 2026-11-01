// Pane sizes: the icon rail and task list have pixel widths; the other borders split shared space
// by ratio, so a window resize keeps the ratio while CSS keeps every pane above its minimum.
export const DEFAULT_LAYOUT = Object.freeze({ rail: 56, tasks: 190, browser: 0.45, editor: 0.52, input: 0.5 });
const LIMITS = { rail: [40, 96], tasks: [140, 300], browser: [0.1, 0.9], editor: [0.1, 0.9], input: [0.1, 0.9] };
const SPLITTER = 5;

export const resize = (name, value) => Math.min(LIMITS[name][1], Math.max(LIMITS[name][0], value));

// Saved sizes come from the screen's storage; anything unreadable falls back to the default.
export function restoreLayout(saved) {
  let values = {};
  try { values = JSON.parse(saved) ?? {}; } catch { values = {}; }
  return Object.fromEntries(Object.entries(DEFAULT_LAYOUT).map(([name, fallback]) => {
    const value = values[name];
    const [min, max] = LIMITS[name];
    return [name, typeof value === 'number' && value >= min && value <= max ? value : fallback];
  }));
}

// Shares become factors of at least 10: grid and flexbox hand out only part of the free space
// when the factors of the panes that can still grow add up to less than 1.
const factor = share => String(Math.round(share * 1000) / 10);

export function layoutStyles({ rail, tasks, browser, editor, input }) {
  return {
    columns: `${rail}px ${SPLITTER}px ${tasks}px ${SPLITTER}px minmax(480px, ${factor(1 - browser)}fr) ${SPLITTER}px minmax(360px, ${factor(browser)}fr)`,
    io: `minmax(200px, ${factor(input)}fr) ${SPLITTER}px minmax(200px, ${factor(1 - input)}fr)`,
    editor: factor(editor),
    lower: factor(1 - editor)
  };
}

// The new size after the pointer moved by dx, dy from where the drag started, from the sizes
// the panes on both sides of the border had at the start.
function dragged(name, { a, b }, dx, dy) {
  if (name === 'rail' || name === 'tasks') return a.width + dx;
  if (name === 'browser') return (b.width - dx) / (a.width + b.width);
  if (name === 'editor') return (a.height + dy) / (a.height + b.height);
  return (a.width + dx) / (a.width + b.width);
}

export function setupLayout(storage, key) {
  let layout = restoreLayout(storage.get(key));
  const app = document.querySelector('.app');
  const apply = () => {
    const styles = layoutStyles(layout);
    app.style.gridTemplateColumns = styles.columns;
    app.style.setProperty('--rail-width', `${layout.rail}px`);
    document.querySelector('.io-row').style.gridTemplateColumns = styles.io;
    document.querySelector('.editor-panel').style.flexGrow = styles.editor;
    document.querySelector('.io-row').style.flexGrow = styles.lower;
  };
  const save = () => storage.set(key, JSON.stringify(layout));
  for (const splitter of document.querySelectorAll('.splitter')) {
    const name = splitter.dataset.split;
    const [before, after] = [splitter.previousElementSibling, splitter.nextElementSibling];
    let start = null;
    splitter.addEventListener('pointerdown', event => {
      event.preventDefault();
      start = { x: event.clientX, y: event.clientY, a: before.getBoundingClientRect(), b: after.getBoundingClientRect() };
      splitter.setPointerCapture(event.pointerId);
      splitter.classList.add('dragging');
    });
    splitter.addEventListener('pointermove', event => {
      if (!splitter.hasPointerCapture(event.pointerId)) return;
      layout = { ...layout, [name]: resize(name, dragged(name, start, event.clientX - start.x, event.clientY - start.y)) };
      apply();
    });
    const finish = event => {
      if (!splitter.hasPointerCapture(event.pointerId)) return;
      splitter.releasePointerCapture(event.pointerId);
      splitter.classList.remove('dragging');
      save();
    };
    splitter.addEventListener('pointerup', finish);
    splitter.addEventListener('pointercancel', finish);
    splitter.addEventListener('dblclick', () => {
      layout = { ...layout, [name]: DEFAULT_LAYOUT[name] };
      apply();
      save();
    });
  }
  apply();
}

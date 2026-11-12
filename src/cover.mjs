import { readGraph, layoutGraph } from './graph.mjs';
import { GraphView } from './graph-view.mjs';

const $ = id => document.getElementById(id);

/**
 * Wires the windows over the AtCoder page. `sample()` gives the selected sample's number (from 0)
 * and its input, `searchText()` what F1 searches for in the editor. Returns `slideCover` (null
 * puts the window away), `drawGraph` (after the sample changes) and `useGraphForm` (for a new
 * problem).
 */
export function setupCover({ ide, sample, searchText, browserMessage, message }) {
  // The windows that slide over the AtCoder page, るりま (D3) and the graph (D4), are drawn here;
  // the るりま page lies over the screen like the AtCoder pages. Nothing can be drawn over those, so
  // while a window is out the AtCoder page is hidden behind a picture of it, darkened as the window
  // comes out. One loop moves the window toward the last press, so presses never stack up, and it
  // never waits on a reply: the pages are placed by the latest position, sent once the previous
  // one is answered or has taken too long. Pressing the other window's button while one is out
  // swaps what the window shows.
  const COVER_SLIDE_MS = 180;
  const COVER_SHADE = 0.5;
  let coverWanted = null; // 'rurima', 'graph', or null to put the window away
  let coverShown = 'rurima';
  let coverReveal = 0;
  let coverMoving = null;
  let coverPicture = null;
  let coverPlace = null;
  let coverPlacing = false;
  let rurimaUrl = '';
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  function placeCover(open = true) {
    const rect = open && coverShown === 'rurima' ? $('rurima-host').getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 };
    coverPlace = [open, rect.x, rect.y, rect.width, rect.height];
    if (coverPlacing) return;
    coverPlacing = true;
    (async () => {
      while (coverPlace) {
        const place = coverPlace;
        coverPlace = null;
        await Promise.race([ide.coverLayout(...place).catch(() => {}), delay(300)]);
      }
      coverPlacing = false;
    })();
  }
  new ResizeObserver(() => { if (coverWanted === 'rurima' && !coverMoving) placeCover(); }).observe($('rurima-host'));
  // A picture that cannot be shown leaves the darkened background instead of a broken image.
  $('cover-snapshot').addEventListener('error', () => $('cover-snapshot').removeAttribute('src'));
  async function pictureAtCoderPage() {
    const bytes = await Promise.race([ide.browserSnapshot().catch(() => null), delay(1500)]);
    if (coverPicture) URL.revokeObjectURL(coverPicture);
    // The app sends the bytes as an ArrayBuffer; the UI test host as an array of numbers.
    const jpeg = bytes ? new Uint8Array(bytes) : null;
    coverPicture = jpeg?.length ? URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' })) : null;
    if (coverPicture) $('cover-snapshot').src = coverPicture;
    else $('cover-snapshot').removeAttribute('src');
  }
  // The next frame, or a short wait when frames do not come.
  const nextFrame = () => new Promise(resolve => {
    const timer = setTimeout(resolve, 50);
    requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
  });
  function showCoverReveal() {
    const shown = 1 - (1 - coverReveal) ** 3;
    $(`${coverShown}-panel`).style.setProperty('--reveal', String(shown));
    $('cover-shade').style.opacity = String(COVER_SHADE * shown);
  }
  async function moveCover() {
    let last = performance.now();
    while (true) {
      // Coming out from fully put away: the AtCoder page is pictured first, then hidden.
      if (coverWanted && $('browser-cover').hidden) {
        await pictureAtCoderPage();
        showCoverReveal();
        $('browser-cover').hidden = false;
        last = performance.now();
      }
      const now = performance.now();
      const step = (now - last) / COVER_SLIDE_MS;
      last = now;
      coverReveal = coverWanted ? Math.min(1, coverReveal + step) : Math.max(0, coverReveal - step);
      showCoverReveal();
      if (!coverWanted && coverReveal === 0) {
        placeCover(false);
        $('browser-cover').hidden = true;
        return;
      }
      placeCover();
      if (coverWanted && coverReveal === 1) return;
      await nextFrame();
    }
  }
  function slideCover(wanted) {
    coverWanted = wanted;
    if (wanted) {
      coverShown = wanted;
      for (const name of ['rurima', 'graph']) $(`${name}-panel`).hidden = name !== wanted;
      showCoverReveal();
    }
    for (const name of ['rurima', 'graph']) $(`${name}-toggle`).setAttribute('aria-pressed', String(name === wanted));
    // The AtCoder page is put aside while the window is out, and so are its controls.
    for (const id of ['browser-back', 'browser-forward', 'browser-reload', 'browser-url']) $(id).disabled = Boolean(wanted);
    coverMoving ??= moveCover().finally(() => { coverMoving = null; });
    return coverMoving;
  }
  // Opens the window with the words searched for, or with the page it showed last. The press counts
  // at once, so presses made while the window's page is being made still decide where it ends.
  async function openRurima(query = null) {
    if (query?.trim()) $('rurima-search').value = query.trim().split(/\s+/).join(' ');
    const moving = slideCover('rurima');
    try {
      await ide.rurimaShow(query);
      browserMessage('');
    } catch (error) {
      browserMessage(error.message);
      if (coverWanted === 'rurima') slideCover(null);
    }
    await moving;
  }
  ide.onRurimaUrl(url => {
    rurimaUrl = url;
    if (document.activeElement !== $('rurima-url')) $('rurima-url').value = url;
  }).catch(error => message(String(error), true));
  // The window's URL field opens a page of the reference or of the search, or searches for words.
  $('rurima-url').addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (event.key === 'Escape') { $('rurima-url').blur(); return; }
    if (event.key === 'Enter') { openRurima($('rurima-url').value); $('rurima-url').blur(); }
  });
  $('rurima-url').addEventListener('blur', () => { $('rurima-url').value = rurimaUrl; });
  $('rurima-back').addEventListener('click', () => ide.rurimaHistory(false).catch(error => browserMessage(error.message)));
  $('rurima-forward').addEventListener('click', () => ide.rurimaHistory(true).catch(error => browserMessage(error.message)));
  $('rurima-reload').addEventListener('click', () => ide.rurimaReload().catch(error => browserMessage(error.message)));
  // The darkened page around the window puts it away.
  $('browser-cover').addEventListener('click', event => { if (!$(`${coverShown}-panel`).contains(event.target)) slideCover(null); });
  $('rurima-toggle').addEventListener('click', () => (coverWanted === 'rurima' ? slideCover(null) : openRurima()));
  $('rurima-search-bar').addEventListener('submit', event => {
    event.preventDefault();
    if ($('rurima-search').value.trim()) openRurima($('rurima-search').value);
  });
  // F1 searches for the selected text (in the editor, the word at the cursor without a selection).
  document.addEventListener('keydown', event => {
    if (event.key !== 'F1') return;
    event.preventDefault();
    const text = $('editor-host').contains(document.activeElement) ? searchText() : String(window.getSelection() ?? '');
    openRurima(text.trim() ? text : null);
  });
  // The right-click item 「るりまを全文検索」 of Windows sends the selected text.
  ide.onRurimaSearch(text => openRurima(text)).catch(error => message(String(error), true));

  // The graph window (D4) draws the selected sample's input by the form the task's input format
  // gave, or by one chosen by hand until another problem opens.
  const graphView = new GraphView($('graph-canvas'));
  const GRAPH_KINDS = { edges: '辺の列', parents: '親の配列' };
  let graphForm = null;
  let graphManual = null;
  let graphDrawn = '';
  function drawGraph() {
    if (coverWanted !== 'graph') return;
    $('graph-title').textContent = `グラフ（サンプル ${sample().index + 1}）`;
    $('graph-form').options[0].textContent = graphForm ? `自動（${GRAPH_KINDS[graphForm.kind]}・${graphForm.line + 1}行目から）` : '自動（判定できません）';
    $('graph-form').value = graphManual?.kind ?? 'auto';
    $('graph-line').disabled = !graphManual;
    if (graphManual) $('graph-line').value = String(graphManual.line + 1);
    const form = graphManual ?? graphForm;
    const graph = form ? readGraph(sample().input, form) : { error: '形式を判定できません。「形式」で辺の列か親の配列を選び、開始行を指定してください。' };
    $('graph-message').textContent = graph.error ?? '';
    const drawn = JSON.stringify(graph);
    if (drawn === graphDrawn) return;
    graphDrawn = drawn;
    if (graph.error) graphView.clear();
    else graphView.show(graph, layoutGraph(graph));
  }
  function useGraphForm(form) {
    graphForm = form;
    graphManual = null;
    graphDrawn = '';
  }
  async function openGraph() {
    graphDrawn = '';
    const moving = slideCover('graph');
    drawGraph();
    await moving;
    // Fitted again to the window as it ended up once out.
    if (coverWanted === 'graph') graphView.fit();
  }
  $('graph-toggle').addEventListener('click', () => (coverWanted === 'graph' ? slideCover(null) : openGraph()));
  $('graph-form').addEventListener('change', () => {
    const kind = $('graph-form').value;
    const line = graphManual?.line ?? graphForm?.line ?? 1;
    graphManual = kind === 'auto' ? null : { kind, line };
    drawGraph();
  });
  $('graph-line').addEventListener('input', () => {
    const line = Number($('graph-line').value);
    if (!graphManual || !Number.isInteger(line) || line < 1) return;
    graphManual = { ...graphManual, line: line - 1 };
    drawGraph();
  });
  $('graph-directed').addEventListener('change', () => { graphView.directed = $('graph-directed').checked; });
  $('graph-fit').addEventListener('click', () => graphView.fit());
  return { slideCover, drawGraph, useGraphForm };
}

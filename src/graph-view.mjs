// Draws a graph laid out by graph.mjs into an SVG (D4): the wheel zooms around the pointer,
// dragging the background moves the whole, dragging a vertex moves it.
const SVG = 'http://www.w3.org/2000/svg';
const RADIUS = 16;
const MARGIN = 40;

const element = (name, attributes = {}, parent = null) => {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  parent?.append(node);
  return node;
};

export class GraphView {
  #svg;
  #graph = null;
  #points = [];
  #edges = [];
  #vertices = [];
  #directed = false;
  #box = { x: -100, y: -100, width: 200, height: 200 };

  constructor(svg) {
    this.#svg = svg;
    svg.addEventListener('wheel', event => this.#zoom(event), { passive: false });
    svg.addEventListener('pointerdown', event => this.#drag(event));
  }

  get directed() { return this.#directed; }
  set directed(directed) {
    this.#directed = directed;
    this.#update();
  }

  // Shows a graph at its positions, fitted to the window.
  show(graph, points) {
    this.#graph = graph;
    this.#points = points.map(point => ({ ...point }));
    const svg = this.#svg;
    svg.replaceChildren();
    const defs = element('defs', {}, svg);
    const marker = element('marker', { id: 'graph-arrow', viewBox: '0 0 10 10', refX: 10, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto-start-reverse' }, defs);
    element('path', { d: 'M 0 0 L 10 5 L 0 10 z', class: 'graph-arrow' }, marker);
    const edges = element('g', {}, svg);
    const weights = element('g', {}, svg);
    const vertices = element('g', {}, svg);
    this.#edges = graph.edges.map(edge => ({
      edge,
      path: element('path', { class: 'graph-edge' }, edges),
      weight: edge.weight === null ? null : Object.assign(element('text', { class: 'graph-weight' }, weights), { textContent: edge.weight })
    }));
    this.#vertices = graph.labels.map((label, index) => {
      const group = element('g', { class: 'graph-vertex', 'data-label': label }, vertices);
      group.dataset.index = String(index);
      element('circle', { r: RADIUS }, group);
      element('text', {}, group).textContent = String(label);
      return group;
    });
    this.#update();
    this.fit();
  }

  clear() {
    this.#graph = null;
    this.#svg.replaceChildren();
  }

  // The whole graph fits the window again.
  fit() {
    if (!this.#points.length) return;
    const xs = this.#points.map(p => p.x);
    const ys = this.#points.map(p => p.y);
    // Small graphs keep their size instead of filling the window.
    const width = Math.max(Math.max(...xs) - Math.min(...xs) + 2 * MARGIN, this.#svg.clientWidth);
    const height = Math.max(Math.max(...ys) - Math.min(...ys) + 2 * MARGIN, this.#svg.clientHeight);
    const x = (Math.max(...xs) + Math.min(...xs) - width) / 2;
    const y = (Math.max(...ys) + Math.min(...ys) - height) / 2;
    this.#box = { x, y, width, height };
    this.#showBox();
  }

  #showBox() {
    const { x, y, width, height } = this.#box;
    this.#svg.setAttribute('viewBox', `${x} ${y} ${width} ${height}`);
  }

  #update() {
    if (!this.#graph) return;
    const p = this.#points;
    for (const { edge, path, weight } of this.#edges) {
      const a = p[edge.from];
      const b = p[edge.to];
      let middle;
      if (edge.from === edge.to) {
        // A loop above the vertex.
        path.setAttribute('d', `M ${a.x - 8} ${a.y - RADIUS + 2} C ${a.x - 30} ${a.y - 60}, ${a.x + 30} ${a.y - 60}, ${a.x + 8} ${a.y - RADIUS + 2}`);
        middle = { x: a.x, y: a.y - 52 };
      } else {
        const d = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const ux = (b.x - a.x) / d;
        const uy = (b.y - a.y) / d;
        // Arrows end at the circle, not its middle.
        const end = this.#directed ? RADIUS + 1 : 0;
        path.setAttribute('d', `M ${a.x} ${a.y} L ${b.x - ux * end} ${b.y - uy * end}`);
        middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      }
      if (this.#directed) path.setAttribute('marker-end', 'url(#graph-arrow)');
      else path.removeAttribute('marker-end');
      weight?.setAttribute('x', String(middle.x));
      weight?.setAttribute('y', String(middle.y));
    }
    this.#vertices.forEach((group, i) => group.setAttribute('transform', `translate(${p[i].x} ${p[i].y})`));
  }

  // A point of the window in the drawing's units.
  #toDrawing(event, matrix = this.#svg.getScreenCTM()?.inverse()) {
    const point = new DOMPoint(event.clientX, event.clientY).matrixTransform(matrix);
    return { x: point.x, y: point.y };
  }

  #zoom(event) {
    if (!this.#graph) return;
    event.preventDefault();
    const at = this.#toDrawing(event);
    const scale = Math.min(Math.max(Math.exp(event.deltaY * 0.0015), 0.5), 2);
    const box = this.#box;
    this.#box = {
      x: at.x - (at.x - box.x) * scale,
      y: at.y - (at.y - box.y) * scale,
      width: box.width * scale,
      height: box.height * scale
    };
    this.#showBox();
  }

  #drag(event) {
    if (!this.#graph || event.button !== 0) return;
    const vertex = event.target.closest?.('.graph-vertex');
    const matrix = this.#svg.getScreenCTM()?.inverse();
    if (!matrix) return;
    const start = this.#toDrawing(event, matrix);
    const box = { ...this.#box };
    const index = vertex ? Number(vertex.dataset.index) : null;
    const from = index === null ? null : { ...this.#points[index] };
    this.#svg.setPointerCapture?.(event.pointerId);
    if (index === null) this.#svg.classList.add('panning');
    const move = moved => {
      // The drawing's units as they were when the drag began, so moving the view does not
      // change them under the pointer.
      const now = this.#toDrawing(moved, matrix);
      const dx = now.x - start.x;
      const dy = now.y - start.y;
      if (index === null) {
        this.#box = { ...box, x: box.x - dx, y: box.y - dy };
        this.#showBox();
      } else {
        this.#points[index] = { x: from.x + dx, y: from.y + dy };
        this.#update();
      }
    };
    const end = () => {
      this.#svg.removeEventListener('pointermove', move);
      this.#svg.removeEventListener('pointerup', end);
      this.#svg.removeEventListener('pointercancel', end);
      this.#svg.classList.remove('panning');
    };
    this.#svg.addEventListener('pointermove', move);
    this.#svg.addEventListener('pointerup', end);
    this.#svg.addEventListener('pointercancel', end);
    event.preventDefault();
  }
}

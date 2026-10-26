export const MAX_CASES = 100;

function createCase({ stdin = '', expectedOutput = '', compare = true }) {
  return { stdin, expectedOutput, compare, revision: 0, comparison: compare ? 'pending' : 'none', difference: null, stdout: '', stderr: '', status: null, durationMs: null };
}

export class SampleCases {
  #savedData;

  constructor(data) {
    this.replace(data, { saved: true });
  }

  get current() {
    return this.items[this.selected];
  }

  get dirty() {
    return JSON.stringify(this.data()) !== this.#savedData;
  }

  data() {
    return this.items.map(({ stdin, expectedOutput, compare }) => ({ stdin, expectedOutput, compare }));
  }

  markSaved(data = this.data()) {
    this.#savedData = JSON.stringify(data);
  }

  replace(data, { saved = false } = {}) {
    if (!Array.isArray(data) || data.length < 1 || data.length > MAX_CASES) {
      throw new Error('ケースは 1〜100 件にしてください。');
    }
    const items = data.map(createCase);
    this.items = items;
    this.selected = 0;
    if (saved) this.markSaved();
  }

  add() {
    if (this.items.length >= MAX_CASES) return false;
    this.items.push(createCase({}));
    this.selected = this.items.length - 1;
    return true;
  }

  remove() {
    if (this.items.length === 1) return false;
    this.items.splice(this.selected, 1);
    this.selected = Math.min(this.selected, this.items.length - 1);
    return true;
  }

  invalidate(all = false) {
    for (const item of all ? this.items : [this.current]) {
      item.revision++;
      item.comparison = item.compare ? 'pending' : 'none';
      item.difference = null;
    }
  }

  snapshot(all = false) {
    return (all ? this.items : [this.current]).map(item => ({ item, stdin: item.stdin, expectedOutput: item.expectedOutput, compare: item.compare, revision: item.revision }));
  }
}

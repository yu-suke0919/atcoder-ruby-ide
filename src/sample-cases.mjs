export const MAX_CASES = 100;

function resetComparison(item) {
  item.comparison = item.compare ? 'pending' : 'none';
  item.difference = null;
  item.errorLine = null;
  item.exceededTimeLimitMs = null;
}

function clearResult(item, status = null) {
  Object.assign(item, { stdout: '', stderr: '', status, exitCode: null, durationMs: null, executionLimitMs: null });
  resetComparison(item);
}

function createCase({ stdin = '', expectedOutput = '', compare = true }) {
  const item = { stdin, expectedOutput, compare, revision: 0 };
  clearResult(item);
  return item;
}

export class SampleCases {
  #savedData;

  // The tolerance belongs to the problem: it applies to every compared sample.
  constructor(data, tolerance = null) {
    this.replace(data, { saved: true, tolerance });
  }

  get current() {
    return this.items[this.selected];
  }

  get dirty() {
    return JSON.stringify(this.data()) !== this.#savedData;
  }

  // What samples.json keeps: the tolerance, if any, and each sample's editable inputs.
  data() {
    return {
      ...(this.tolerance === null ? {} : { tolerance: this.tolerance }),
      cases: this.items.map(({ stdin, expectedOutput, compare }) => ({ stdin, expectedOutput, compare }))
    };
  }

  markSaved(data = this.data()) {
    this.#savedData = JSON.stringify(data);
  }

  replace(data, { saved = false, tolerance = null } = {}) {
    if (!Array.isArray(data) || data.length < 1 || data.length > MAX_CASES) {
      throw new Error('ケースは 1〜100 件にしてください。');
    }
    const items = data.map(createCase);
    this.items = items;
    this.tolerance = tolerance;
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
      resetComparison(item);
    }
  }

  clear(all = false) {
    for (const item of all ? this.items : [this.current]) {
      item.revision++;
      clearResult(item);
    }
  }

  begin({ item, revision, compare }) {
    clearResult(item, 'running');
    if (item.revision === revision) item.comparison = compare ? 'running' : 'none';
  }

  started({ item }, executionLimitMs) {
    item.executionLimitMs = executionLimitMs;
  }

  finish({ item, revision, compare, timeLimitMs }, result) {
    const { stdout, stderr, status, exitCode, durationMs, executionLimitMs } = result;
    Object.assign(item, { stdout, stderr, status, exitCode, durationMs, executionLimitMs });
    item.errorLine = item.revision === revision && status === 'failed' ? result.errorLine ?? null : null;
    item.exceededTimeLimitMs = item.revision === revision && timeLimitMs != null && durationMs > timeLimitMs
      && ['completed', 'failed', 'timeout', 'output-limit', 'memory-limit'].includes(status) ? timeLimitMs : null;
    if (item.revision === revision && compare) {
      item.comparison = result.comparison === null ? 'unavailable' : result.comparison ? 'matched' : 'mismatched';
      item.difference = result.difference;
    }
  }

  fail({ item, revision, compare }, message) {
    item.status = 'error';
    item.stderr = message;
    item.errorLine = null;
    item.exceededTimeLimitMs = null;
    if (item.revision === revision && compare) {
      item.comparison = 'unavailable';
      item.difference = null;
    }
  }

  cancel({ item }) {
    clearResult(item, 'canceled');
  }

  snapshot(all = false, timeLimitMs = null) {
    return (all ? this.items : [this.current]).map(item => ({ item, stdin: item.stdin, expectedOutput: item.expectedOutput, compare: item.compare, tolerance: this.tolerance, revision: item.revision, timeLimitMs }));
  }
}

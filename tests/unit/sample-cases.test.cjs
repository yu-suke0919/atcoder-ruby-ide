const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../../src/sample-cases.mjs');
const sample = (stdin = 'one', expectedOutput = 'ONE', compare = true) => ({ stdin, expectedOutput, compare });

test('execution budgets belong to runs, survive edits and are excluded from case JSON', async () => {
  const { SampleCases } = await load();
  const cases = new SampleCases([sample(), sample('two')]);
  const queue = cases.snapshot(true, 8000);
  cases.begin(queue[0]);
  assert.equal(cases.current.executionLimitMs, null);
  cases.started(queue[0], 9000);
  assert.equal(cases.current.executionLimitMs, 9000);
  cases.invalidate();
  assert.equal(cases.current.executionLimitMs, 9000);
  cases.finish(queue[0], { status: 'timeout', stdout: '', stderr: '', comparison: null, durationMs: 9001, executionLimitMs: 9000 });
  assert.equal(cases.current.executionLimitMs, 9000);
  assert.equal(cases.current.exceededTimeLimitMs, null);
  cases.begin(queue[1]); cases.started(queue[1], 30000);
  cases.finish(queue[1], { status: 'stopped', stdout: '', stderr: '', comparison: null, executionLimitMs: 30000 });
  assert.deepEqual(cases.items.map(item => item.executionLimitMs), [9000, 30000]);
  assert.deepEqual(cases.data(), { cases: [sample(), sample('two')] });
  assert.equal(cases.dirty, false);
  cases.clear(true);
  assert.deepEqual(cases.items.map(item => item.executionLimitMs), [null, null]);
  cases.begin(queue[0]); cases.started(queue[0], 9000); cases.cancel(queue[0]);
  assert.equal(cases.current.executionLimitMs, null);
});

test('the tolerance belongs to the problem, is saved with the samples and frozen with the run snapshot', async () => {
  const { SampleCases } = await load();
  const cases = new SampleCases([sample(), sample('two', '', false)], 1e-9);
  assert.deepEqual(cases.data(), { tolerance: 1e-9, cases: [sample(), sample('two', '', false)] });
  const queue = cases.snapshot(true);
  assert.deepEqual(queue.map(item => item.tolerance), [1e-9, 1e-9]);
  cases.tolerance = 1e-6;
  cases.invalidate(true);
  assert.equal(cases.dirty, true);
  assert.equal(queue[0].tolerance, 1e-9);
  // A run that started before the change does not bring back a comparison.
  cases.finish(queue[0], { status: 'completed', stdout: '', stderr: '', comparison: true, difference: null });
  assert.equal(cases.items[0].comparison, 'pending');
  cases.markSaved();
  assert.equal(cases.dirty, false);
  cases.tolerance = null;
  assert.deepEqual(cases.data(), { cases: [sample(), sample('two', '', false)] });
  assert.equal(cases.dirty, true);
  cases.replace([sample()], { saved: true });
  assert.equal(cases.tolerance, null);
});

test('problem time warnings use the run limit, strict boundary and actual completion status', async () => {
  const { SampleCases } = await load();
  for (const [limit, duration, status, warning] of [
    [1000, 999, 'completed', null], [1000, 1000, 'completed', null],
    [1000, 1001, 'completed', 1000], [null, 1001, 'completed', null],
    [1000, 1001, 'failed', 1000], [1000, 5000, 'timeout', 1000],
    [1000, 1001, 'output-limit', 1000], [1000, 1001, 'memory-limit', 1000], [1000, 1001, 'stopped', null],
  ]) {
    const cases = new SampleCases([sample()]);
    const [snapshot] = cases.snapshot(false, limit);
    cases.begin(snapshot);
    assert.equal(cases.current.exceededTimeLimitMs, null);
    cases.finish(snapshot, { status, stdout: 'ONE', stderr: '', durationMs: duration, exitCode: 0, comparison: status === 'completed' ? true : null });
    assert.equal(cases.current.exceededTimeLimitMs, warning, `${status}: ${duration} / ${limit}`);
    assert.equal(cases.current.comparison, status === 'completed' ? 'matched' : 'unavailable');
    assert.deepEqual(cases.data(), { cases: [sample()] });
    assert.equal(cases.dirty, false);
  }
});

test('time warnings are per case, clear on invalidation and cannot return after an edit', async () => {
  const { SampleCases } = await load();
  const cases = new SampleCases([sample(), sample('two', '', false)]);
  const queue = cases.snapshot(true, 1000);
  for (const snapshot of queue) {
    cases.begin(snapshot);
    cases.finish(snapshot, { status: 'completed', stdout: '', stderr: '', durationMs: 1001, comparison: null });
  }
  assert.equal(cases.items[1].exceededTimeLimitMs, 1000);
  assert.equal(cases.items[1].comparison, 'none');
  cases.invalidate();
  assert.equal(cases.items[0].exceededTimeLimitMs, null);
  assert.equal(cases.items[1].exceededTimeLimitMs, 1000);
  cases.finish(queue[0], { status: 'completed', stdout: '', stderr: '', durationMs: 1001, comparison: null });
  assert.equal(cases.current.exceededTimeLimitMs, null);
  cases.invalidate(true);
  assert.equal(cases.items[1].exceededTimeLimitMs, null);
  const [fresh] = cases.snapshot(false, 2000);
  cases.begin(fresh);
  cases.finish(fresh, { status: 'completed', stdout: '', stderr: '', durationMs: 1001, comparison: true });
  assert.equal(cases.current.exceededTimeLimitMs, null);
  cases.clear();
  assert.equal(cases.current.exceededTimeLimitMs, null);
});

test('error locations are per case, independent of comparison, and excluded from saved data', async () => {
  const { SampleCases } = await load();
  const cases = new SampleCases([sample(), sample('two', '', false)]);
  for (const [index, snapshot] of cases.snapshot(true).entries()) {
    cases.begin(snapshot);
    assert.equal(snapshot.item.errorLine, null);
    cases.finish(snapshot, { status: 'failed', stdout: '', stderr: 'boom', exitCode: 1, durationMs: 1, comparison: null, errorLine: index + 2 });
  }
  assert.deepEqual(cases.items.map(item => item.errorLine), [2, 3]);
  assert.ok(cases.data().cases.every(item => !('errorLine' in item)));
  assert.equal(cases.dirty, false);
  cases.markSaved();
  assert.equal(cases.current.errorLine, 2);
  cases.invalidate();
  assert.deepEqual(cases.items.map(item => item.errorLine), [null, 3]);
  cases.invalidate(true);
  assert.deepEqual(cases.items.map(item => item.errorLine), [null, null]);
});

test('stale runs and cleared or non-error results cannot restore an error location', async () => {
  const { SampleCases } = await load();
  const cases = new SampleCases([sample()]);
  const result = { status: 'failed', stdout: '', stderr: 'boom', exitCode: 1, durationMs: 1, comparison: null, errorLine: 2 };
  const [old] = cases.snapshot();
  cases.begin(old); cases.invalidate(true); cases.finish(old, result);
  assert.equal(cases.current.errorLine, null);
  for (const phase of ['begin', 'clear', 'cancel', 'fail', 'completed', 'timeout', 'stopped', 'output-limit']) {
    const [snapshot] = cases.snapshot();
    cases.finish(snapshot, result);
    assert.equal(cases.current.errorLine, 2);
    if (phase === 'begin') cases.begin(snapshot);
    else if (phase === 'clear') cases.clear();
    else if (phase === 'cancel') cases.cancel(snapshot);
    else if (phase === 'fail') cases.fail(snapshot, 'missing ruby');
    else cases.finish(snapshot, { ...result, status: phase });
    assert.equal(cases.current.errorLine, null, phase);
  }
});

test('case data contains only editable inputs and does not share imported objects', async () => {
  const { SampleCases } = await load();
  const original = [sample('日本語', '', false)];
  const cases = new SampleCases(original);
  assert.notEqual(cases.current, original[0]);
  assert.equal(cases.current.comparison, 'none');
  assert.equal(cases.current.difference, null);
  Object.assign(cases.current, { stdout: 'output', status: 'completed', durationMs: 12, difference: { line: 1 } });
  assert.deepEqual(cases.data(), { cases: original });
  const data = cases.data();
  data.cases[0].stdin = 'changed copy';
  assert.equal(cases.current.stdin, '日本語');
  assert.equal(cases.dirty, false);
});

test('dirty state tracks input changes and undo, not results or selection', async () => {
  const { SampleCases } = await load();
  const cases = new SampleCases([sample(), sample('two')]);
  cases.selected = 1;
  Object.assign(cases.current, { stdout: 'TWO', revision: 2, comparison: 'mismatched', difference: { line: 1 } });
  assert.equal(cases.dirty, false);
  for (const [field, value] of [['stdin', 'edited'], ['expectedOutput', ''], ['compare', false]]) {
    const original = cases.current[field];
    cases.current[field] = value;
    assert.equal(cases.dirty, true);
    cases.current[field] = original;
    assert.equal(cases.dirty, false);
  }
  cases.current.stdin = 'saved';
  cases.markSaved();
  assert.equal(cases.dirty, false);
});

test('run snapshots freeze inputs but retain the live case reference and revision', async () => {
  const { SampleCases } = await load();
  const cases = new SampleCases([sample(), sample('two')]);
  const live = cases.current;
  const queue = cases.snapshot(true);
  Object.assign(live, { stdin: 'edited', expectedOutput: 'changed', compare: false });
  cases.invalidate();
  assert.equal(queue[0].item, live);
  assert.deepEqual([queue[0].stdin, queue[0].expectedOutput, queue[0].compare], ['one', 'ONE', true]);
  assert.notEqual(queue[0].revision, live.revision);
  live.stdout = 'still streamed';
  assert.equal(queue[0].item.stdout, 'still streamed');
  cases.selected = 1;
  assert.equal(cases.snapshot().length, 1);
  assert.equal(cases.snapshot()[0].item, cases.items[1]);
});

test('invalidation clears selected or all verdicts without replacing cases or output', async () => {
  const { SampleCases } = await load();
  const cases = new SampleCases([sample(), sample('two', '', false)]);
  const [first, second] = cases.items;
  for (const item of cases.items) Object.assign(item, { stdout: 'output', comparison: 'mismatched', difference: { line: 1 } });
  cases.invalidate();
  assert.equal(cases.current, first);
  assert.equal(first.comparison, 'pending');
  assert.equal(first.difference, null);
  assert.equal(second.comparison, 'mismatched');
  cases.invalidate(true);
  assert.equal(cases.items[1], second);
  assert.equal(second.comparison, 'none');
  assert.equal(second.difference, null);
  assert.equal(first.stdout, 'output');
  assert.equal(second.stdout, 'output');
  assert.equal(cases.dirty, false);
});

test('one replacement entry point distinguishes saved files from fetched case data', async () => {
  const { SampleCases } = await load();
  const cases = new SampleCases([sample(), sample('two')]);
  cases.selected = 1;
  Object.assign(cases.current, { stdout: 'old result', comparison: 'mismatched', difference: { line: 1 } });
  cases.replace([sample('file')], { saved: true });
  assert.equal(cases.selected, 0);
  assert.equal(cases.current.stdout, '');
  assert.equal(cases.current.comparison, 'pending');
  assert.equal(cases.current.difference, null);
  assert.equal(cases.dirty, false);
  cases.replace([sample('fetched')]);
  assert.equal(cases.current.stdin, 'fetched');
  assert.equal(cases.dirty, true);
  cases.replace([sample('file')]);
  assert.equal(cases.dirty, false);
});

test('saving a snapshot does not mark later input edits as saved', async () => {
  const { SampleCases } = await load();
  const cases = new SampleCases([sample()]);
  cases.current.stdin = 'saving';
  const saving = cases.data();
  cases.current.stdin = 'later edit';
  cases.markSaved(saving);
  assert.equal(cases.dirty, true);
  cases.current.stdin = 'saving';
  assert.equal(cases.dirty, false);
});

test('case limits and replacement errors preserve valid state and checkpoints', async () => {
  const { SampleCases, MAX_CASES } = await load();
  const cases = new SampleCases([sample()]);
  const original = cases.current;
  assert.equal(cases.remove(), false);
  assert.equal(cases.current, original);
  assert.equal(cases.add(), true);
  assert.equal(cases.selected, 1);
  assert.equal(cases.current.stdin, '');
  assert.equal(cases.current.expectedOutput, '');
  assert.equal(cases.current.compare, true);
  assert.equal(cases.dirty, true);
  assert.equal(cases.remove(), true);
  assert.equal(cases.current, original);
  assert.equal(cases.dirty, false);
  while (cases.items.length < MAX_CASES) cases.add();
  assert.equal(cases.add(), false);
  assert.equal(cases.items.length, 100);
  cases.markSaved();
  const items = cases.items;
  for (const invalid of [[], Array.from({ length: 101 }, () => sample()), null]) {
    assert.throws(() => cases.replace(invalid, { saved: true }), /1.*100/);
    assert.equal(cases.items, items);
    assert.equal(cases.selected, 99);
    assert.equal(cases.dirty, false);
  }
});

test('begin and finish manage results and comparisons independently of saved inputs', async () => {
  const { SampleCases } = await load();
  const cases = new SampleCases([sample(), sample('two', '', false)]);
  const [first, second] = cases.snapshot(true);
  Object.assign(first.item, { stdout: 'old', stderr: 'old error', durationMs: 99, difference: { line: 2 } });
  cases.begin(first);
  assert.equal(first.item.status, 'running');
  assert.equal(first.item.comparison, 'running');
  assert.equal(first.item.stdout, '');
  assert.equal(first.item.stderr, '');
  assert.equal(first.item.durationMs, null);
  assert.equal(first.item.difference, null);
  const difference = { line: 1, column: 2, actualLine: 'ab', expectedLine: 'ac' };
  cases.finish(first, { status: 'completed', stdout: 'ab', stderr: '', exitCode: 0, durationMs: 7, comparison: false, difference });
  assert.equal(first.item.comparison, 'mismatched');
  assert.equal(first.item.difference, difference);
  assert.equal(first.item.stdout, 'ab');
  assert.equal(first.item.durationMs, 7);
  cases.begin(first);
  cases.finish(first, { status: 'completed', stdout: 'ac', stderr: '', exitCode: 0, durationMs: 8, comparison: true, difference: null });
  assert.equal(first.item.comparison, 'matched');
  assert.equal(first.item.difference, null);
  cases.begin(second);
  assert.equal(second.item.comparison, 'none');
  cases.finish(second, { status: 'completed', stdout: 'two', stderr: '', exitCode: 0, durationMs: 1, comparison: null, difference: null });
  assert.equal(second.item.comparison, 'none');
  assert.equal(cases.dirty, false);
});

test('stale snapshots cannot restore verdicts on begin, finish or validation failure', async () => {
  const { SampleCases } = await load();
  for (const phase of ['before begin', 'before finish', 'before fail']) {
    const cases = new SampleCases([sample()]);
    const [snapshot] = cases.snapshot();
    if (phase !== 'before begin') cases.begin(snapshot);
    cases.current.expectedOutput = 'edited';
    cases.invalidate();
    if (phase === 'before begin') cases.begin(snapshot);
    if (phase === 'before fail') cases.fail(snapshot, 'input exceeds 1 MiB');
    else cases.finish(snapshot, { status: 'completed', stdout: 'old run', stderr: '', durationMs: 3, exitCode: 0, comparison: false, difference: { line: 1 } });
    assert.equal(cases.current.comparison, 'pending', phase);
    assert.equal(cases.current.difference, null, phase);
    assert.equal(cases.current.expectedOutput, 'edited', phase);
    assert.equal(cases.current.stderr, phase === 'before fail' ? 'input exceeds 1 MiB' : '', phase);
  }
});

test('validation errors and abnormal exits retain errors and have no comparison detail', async () => {
  const { SampleCases } = await load();
  const cases = new SampleCases([sample(), sample('two', '', false)]);
  for (const snapshot of cases.snapshot(true)) {
    cases.begin(snapshot);
    cases.fail(snapshot, '標準入力は 1 MiB 以下にしてください。');
    assert.equal(snapshot.item.status, 'error');
    assert.match(snapshot.item.stderr, /標準入力.*1 MiB/);
    assert.equal(snapshot.item.comparison, snapshot.compare ? 'unavailable' : 'none');
    assert.equal(snapshot.item.difference, null);
  }
  for (const status of ['failed', 'stopped', 'timeout', 'output-limit']) {
    const [snapshot] = cases.snapshot();
    cases.begin(snapshot);
    cases.finish(snapshot, { status, stdout: 'partial', stderr: 'error', exitCode: null, durationMs: 5, comparison: null, difference: null });
    assert.equal(cases.current.status, status);
    assert.equal(cases.current.comparison, 'unavailable');
    assert.equal(cases.current.difference, null);
  }
});

test('cancel and clearing results use the current comparison setting and remove old output', async () => {
  const { SampleCases } = await load();
  const cases = new SampleCases([sample(), sample('two', '', false)]);
  const snapshots = cases.snapshot(true);
  for (const snapshot of snapshots) {
    Object.assign(snapshot.item, { stdout: 'old', stderr: 'old error', status: 'completed', durationMs: 2, exitCode: 0, comparison: 'mismatched', difference: { line: 1 } });
    snapshot.item.compare = !snapshot.compare;
    cases.selected = cases.items.indexOf(snapshot.item);
    cases.invalidate();
    cases.cancel(snapshot);
    assert.equal(snapshot.item.status, 'canceled');
    assert.equal(snapshot.item.comparison, snapshot.item.compare ? 'pending' : 'none');
    assert.equal(snapshot.item.stdout, '');
    assert.equal(snapshot.item.stderr, '');
    assert.equal(snapshot.item.durationMs, null);
    assert.equal(snapshot.item.exitCode, null);
    assert.equal(snapshot.item.difference, null);
  }
  cases.clear(true);
  for (const item of cases.items) assert.equal(item.status, null);
});

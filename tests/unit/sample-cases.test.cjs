const { test } = require('node:test');
const assert = require('node:assert/strict');

const load = () => import('../../src/sample-cases.mjs');
const sample = (stdin = 'one', expectedOutput = 'ONE', compare = true) => ({ stdin, expectedOutput, compare });

test('case data contains only editable inputs and does not share imported objects', async () => {
  const { SampleCases } = await load();
  const original = [sample('日本語', '', false)];
  const cases = new SampleCases(original);
  assert.notEqual(cases.current, original[0]);
  assert.equal(cases.current.comparison, 'none');
  assert.equal(cases.current.difference, null);
  Object.assign(cases.current, { stdout: 'output', status: 'completed', durationMs: 12, difference: { line: 1 } });
  assert.deepEqual(cases.data(), original);
  const data = cases.data();
  data[0].stdin = 'changed copy';
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

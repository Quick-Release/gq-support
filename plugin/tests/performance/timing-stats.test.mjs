// The timing benchmark's statistics and its report-only gate rule (T1–T3).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { METRICS, buildReport, compare, markdown, summarize, verdict } from './timing-stats.mjs';

// A fixed, noisy series: no sample is a round number, and the spread is a few ms.
const noisy = (count, offset = 0) => Array.from({ length: count }, (_, i) => 20 + offset + Math.sin(i * 1.7) * 3);

test('summarizes the median, p95, mean, standard deviation and MAD', () => {
  const summary = summarize([10, 1, 9, 2, 8, 3, 7, 4, 6, 5]);
  assert.equal(summary.n, 10);
  assert.equal(summary.median, 5.5);
  assert.equal(summary.p95, 10);
  assert.equal(summary.mean, 5.5);
  assert.ok(Math.abs(summary.stddev - 3.0277) < 1e-4);
  assert.equal(summary.mad, 2.5);
});

test('a constant paired shift has a CI of exactly that shift', () => {
  const base = noisy(30);
  const comparison = compare(base, base.map((value) => value + 5));
  assert.equal(comparison.n, 30);
  assert.ok(Math.abs(comparison.median - 5) < 1e-9);
  assert.ok(Math.abs(comparison.ci95[0] - 5) < 1e-9 && Math.abs(comparison.ci95[1] - 5) < 1e-9);
});

test('pairs by round, so drift shared by both variants cancels', () => {
  // Both variants slow down by 1 ms per round; head is 0.5 ms slower within each round.
  const base = Array.from({ length: 40 }, (_, round) => 10 + round);
  const comparison = compare(base, base.map((value) => value + 0.5));
  assert.ok(Math.abs(comparison.median - 0.5) < 1e-9);
});

test('a CI around zero includes zero, and the same samples give the same CI', () => {
  const base = noisy(50);
  const head = base.map((value, i) => value + (i % 2 ? 0.8 : -0.8));
  const comparison = compare(base, head);
  assert.ok(comparison.ci95[0] < 0 && comparison.ci95[1] > 0, `CI ${comparison.ci95}`);
  assert.deepEqual(compare(base, head).ci95, comparison.ci95);
});

test('refuses unpaired samples', () => {
  assert.throws(() => compare([1, 2, 3], [1, 2]), /paired/);
  assert.throws(() => compare([], []), /paired/);
});

test('a regression needs the whole CI above the threshold', () => {
  assert.equal(verdict([1.2, 3], 1), 'regression');
  assert.equal(verdict([0.4, 3], 1), 'within');
  assert.equal(verdict([-2, -1], 1), 'within');
});

const samples = (headOffset) => ({
  T1: { off: noisy(20), head: noisy(20, headOffset) },
  T2: { off: noisy(20), head: noisy(20) },
});

test('reports a regression without failing while the metric is report-only', () => {
  const report = buildReport({ metadata: { commit: 'abc' }, samples: samples(5) });
  const plugin = report.metrics.T1.comparisons.find((comparison) => comparison.against === 'off');
  assert.equal(plugin.gate.verdict, 'regression');
  assert.equal(plugin.gate.promoted, false);
  assert.deepEqual(report.failing, []);
});

test('fails a promoted metric only when its CI excludes the threshold', () => {
  const promoted = { ...METRICS, T1: { ...METRICS.T1, promoted: true, mainMad: 0.2 } };
  assert.deepEqual(buildReport({ metadata: {}, samples: samples(5), metrics: promoted }).failing, ['T1']);
  assert.deepEqual(buildReport({ metadata: {}, samples: samples(0), metrics: promoted }).failing, []);
});

test('the threshold is max(1 ms, 3 × main MAD) for PHP time', () => {
  const at = (mainMad) => buildReport({ metadata: {}, samples: samples(0), metrics: { ...METRICS, T1: { ...METRICS.T1, mainMad } } })
    .metrics.T1.comparisons[0].gate.threshold;
  assert.equal(at(null), 1);
  assert.equal(at(0.2), 1);
  assert.equal(at(0.5), 1.5);
});

test('compares head with base when the run has a base', () => {
  const report = buildReport({ metadata: {}, samples: { T3: { base: noisy(20), head: noisy(20, 10) } } });
  const [regression] = report.metrics.T3.comparisons;
  assert.equal(regression.against, 'base');
  // 25% of the base median.
  assert.ok(Math.abs(regression.gate.threshold - 0.25 * report.metrics.T3.variants.base.median) < 1e-9);
  assert.equal(regression.gate.verdict, 'regression');
});

test('the Markdown report names every metric and says it is report-only', () => {
  const text = markdown(buildReport({ metadata: { commit: 'abc1234' }, samples: samples(0) }));
  assert.match(text, /abc1234/);
  assert.match(text, new RegExp(METRICS.T1.label));
  assert.match(text, new RegExp(METRICS.T2.label));
  assert.match(text, /report-only/);
});

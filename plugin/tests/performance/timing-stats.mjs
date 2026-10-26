// Statistics and the gate rule for the interleaved timing benchmark (T1–T4 in
// docs/research/idle-performance-budgets.md). Pure functions; timing-benchmark.mjs collects the samples.

/** T1/T2: max(1 ms, 3 × the MAD of the paired delta across `main` runs). */
const phpThreshold = ({ mainMad }) => Math.max(1, 3 * (mainMad ?? 0));

/**
 * The timed metrics. Every metric is report-only (`promoted: false`) until ten `main` runs give
 * its variance. To promote T1 or T2, set `mainMad` from those runs; T3 is relative to base and
 * needs none. Then set `promoted: true` and write the threshold back into the research doc.
 *
 * `against` is the variant head is compared with: `off` (the plugin's own cost) or `base` (a PR's
 * regression). `threshold` gets the main MAD and the comparison variant's median.
 *
 * `warnAbove` is a limit on head's own median rather than on a delta: above it the report warns,
 * and nothing ever fails on it.
 */
export const METRICS = {
  T1: {
    label: 'Anonymous public page, PHP wall time',
    unit: 'ms',
    against: 'off',
    threshold: phpThreshold,
    promoted: false,
    mainMad: null,
  },
  T2: {
    label: 'Eligible dashboard, PHP wall time',
    unit: 'ms',
    against: 'off',
    threshold: phpThreshold,
    promoted: false,
    mainMad: null,
  },
  T3: {
    label: 'First open, click to focused Description field',
    unit: 'ms',
    against: 'base',
    // A regression over 25% of the base median, by the same whole-CI rule.
    threshold: ({ againstMedian }) => 0.25 * againstMedian,
    promoted: false,
  },
  T4: {
    label: 'Heap growth over 50 open/close cycles, after forced GC',
    unit: 'B',
    against: 'base',
    threshold: null,
    warnAbove: 1024 * 1024,
  },
  M1: { label: 'Anonymous public page, PHP peak memory', unit: 'B', against: 'off', threshold: null },
  M2: { label: 'Eligible dashboard, PHP peak memory', unit: 'B', against: 'off', threshold: null },
};

const sorted = (values) => [...values].sort((a, b) => a - b);

function median(values) {
  const ordered = sorted(values);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

/** Nearest-rank percentile. */
const percentile = (values, fraction) => sorted(values)[Math.max(0, Math.ceil(fraction * values.length) - 1)];

/** @param {number[]} values */
export function summarize(values) {
  const n = values.length;
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const center = median(values);
  return {
    n,
    median: center,
    p95: percentile(values, 0.95),
    mean,
    stddev: n > 1 ? Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)) : 0,
    mad: median(values.map((value) => Math.abs(value - center))),
  };
}

/** A seeded generator, so a report's CI is reproducible from its samples. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Head minus the other variant, paired by round, with a 95% percentile-bootstrap CI of the median.
 * Pairing by round cancels drift that both variants share (thermal, cache, neighbours).
 *
 * @param {number[]} against Samples of the variant compared with, one per round.
 * @param {number[]} head Samples of head, one per round.
 */
export function compare(against, head, { resamples = 10000, seed = 44 } = {}) {
  if (!against.length || against.length !== head.length) {
    throw new Error(`Timing samples must be paired by round: got ${against.length} and ${head.length}`);
  }
  const deltas = head.map((value, round) => value - against[round]);
  const next = mulberry32(seed);
  const medians = Array.from({ length: resamples }, () => median(deltas.map(() => deltas[Math.floor(next() * deltas.length)])));
  const ordered = sorted(medians);
  return {
    ...summarize(deltas),
    ci95: [ordered[Math.floor(0.025 * resamples)], ordered[Math.ceil(0.975 * resamples) - 1]],
  };
}

/** Tachometer-style: a regression only when the whole CI of the difference lies above the threshold. */
export const verdict = (ci95, threshold) => (ci95[0] > threshold ? 'regression' : 'within');

/**
 * @param {object} options
 * @param {Record<string, unknown>} options.metadata Environment, commits, cache mode and sample counts.
 * @param {Record<string, Record<string, number[]>>} options.samples Metric → variant (`off`, `base`, `head`) → one sample per round.
 * @param {typeof METRICS} [options.metrics]
 */
export function buildReport({ metadata, samples, metrics = METRICS }) {
  const report = { schema: 1, metadata, metrics: {}, failing: [], warnings: [] };
  for (const [id, variants] of Object.entries(samples)) {
    const metric = metrics[id];
    const comparisons = [];
    for (const against of ['off', 'base']) {
      if (!variants[against] || !variants.head) continue;
      const delta = compare(variants[against], variants.head);
      const comparison = { against, delta };
      if (metric.threshold && metric.against === against) {
        const threshold = metric.threshold({ mainMad: metric.mainMad, againstMedian: median(variants[against]) });
        const result = verdict(delta.ci95, threshold);
        comparison.gate = { threshold, verdict: result, promoted: metric.promoted, failing: metric.promoted && result === 'regression' };
        if (comparison.gate.failing) report.failing.push(id);
      }
      comparisons.push(comparison);
    }
    report.metrics[id] = {
      label: metric.label,
      unit: metric.unit,
      variants: Object.fromEntries(Object.entries(variants).map(([variant, values]) => [variant, summarize(values)])),
      comparisons,
    };
    if (metric.warnAbove != null && variants.head) {
      const center = median(variants.head);
      const result = center > metric.warnAbove ? 'warn' : 'within';
      report.metrics[id].warning = { limit: metric.warnAbove, median: center, verdict: result };
      if (result === 'warn') report.warnings.push(id);
    }
  }
  return report;
}

const format = (value, unit) => (unit === 'B' ? `${(value / 1024).toFixed(1)} KB` : `${value.toFixed(2)} ms`);

/** The job-summary rendering of a report. */
export function markdown(report) {
  const { metadata } = report;
  const lines = [
    '## Timing benchmark',
    '',
    `Commit \`${metadata.commit ?? 'unknown'}\`${metadata.baseCommit ? ` against base \`${metadata.baseCommit}\`` : ''}.`,
    Object.values(report.metrics).some((metric) => metric.comparisons.some(({ gate }) => gate?.promoted))
      ? 'Promoted metrics fail this job when the whole 95% CI of the delta exceeds the threshold; the rest are report-only.'
      : 'Every metric is **report-only** until ten `main` runs give its variance; no timing fails this job yet.',
    ...(Object.values(report.metrics).some((metric) => metric.warning) ? ['Heap growth (T4) is never promoted: above its limit it only warns.'] : []),
    '',
    '| Metric | Variant | n | Median | p95 | SD | MAD |',
    '|---|---|---:|---:|---:|---:|---:|',
  ];
  for (const metric of Object.values(report.metrics)) {
    for (const [variant, summary] of Object.entries(metric.variants)) {
      lines.push(`| ${metric.label} | ${variant} | ${summary.n} | ${format(summary.median, metric.unit)} | ${format(summary.p95, metric.unit)} | ${format(summary.stddev, metric.unit)} | ${format(summary.mad, metric.unit)} |`);
    }
  }
  lines.push('', '| Metric | Head minus | Median delta | 95% CI | Threshold | Verdict |', '|---|---|---:|---|---:|---|');
  for (const metric of Object.values(report.metrics)) {
    for (const { against, delta, gate } of metric.comparisons) {
      const ci = `${format(delta.ci95[0], metric.unit)} to ${format(delta.ci95[1], metric.unit)}`;
      const status = gate ? `${gate.verdict}${gate.promoted ? '' : ' (report-only)'}` : 'report-only';
      lines.push(`| ${metric.label} | ${against} | ${format(delta.median, metric.unit)} | ${ci} | ${gate ? format(gate.threshold, metric.unit) : '—'} | ${status} |`);
    }
  }
  const warnings = Object.values(report.metrics).filter((metric) => metric.warning);
  if (warnings.length) {
    lines.push('', '| Metric | Variant | Median | Warn above | Status |', '|---|---|---:|---:|---|');
    for (const { label, unit, warning } of warnings) {
      lines.push(`| ${label} | head | ${format(warning.median, unit)} | ${format(warning.limit, unit)} | ${warning.verdict} (report-only) |`);
    }
  }
  lines.push('', `Environment: ${Object.entries(metadata).filter(([key]) => !['commit', 'baseCommit'].includes(key)).map(([key, value]) => `${key} \`${typeof value === 'object' ? JSON.stringify(value) : value}\``).join(', ')}.`);
  return `${lines.join('\n')}\n`;
}

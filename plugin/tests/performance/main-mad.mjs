#!/usr/bin/env node
// Derives T1 and T2's `mainMad` (timing-stats.mjs) from `main` benchmark artifacts:
//   gh run download <run-id> -D <dir>   (once per `main` run of .github/workflows/benchmark.yml)
//   node plugin/tests/performance/main-mad.mjs <dir>/timing-*/timing.json ...
import { readFileSync } from 'node:fs';
import { mainMad, METRICS } from './timing-stats.mjs';

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: main-mad.mjs <timing.json>...');
  process.exit(2);
}
const reports = files.map((file) => JSON.parse(readFileSync(file, 'utf8')));
console.log(`${reports.length} runs: ${reports.map(({ metadata }) => metadata.commit?.slice(0, 7)).join(', ')}`);
for (const id of ['T1', 'T2']) {
  const mad = mainMad(reports, id);
  console.log(`${id}: mainMad ${mad.toFixed(3)} ms, threshold ${METRICS[id].threshold({ mainMad: mad }).toFixed(2)} ms`);
}

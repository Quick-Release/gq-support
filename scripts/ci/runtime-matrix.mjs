#!/usr/bin/env node
// The supported-runtime matrix in .github/runtime-matrix.json: which CI cells a tier runs, whether
// the declared support (plugin headers, Composer, PHPCS, PHPStan) matches the cells that prove it,
// whether a cell really ran its declared runtime, and which pins newer upstream releases overtake.
//   node scripts/ci/runtime-matrix.mjs cells pr|scheduled|canary...  GitHub matrix JSON
//   node scripts/ci/runtime-matrix.mjs env <cell-id>                  shell variables for run-cell.sh
//   node scripts/ci/runtime-matrix.mjs policy                         declared support vs cells
//   node scripts/ci/runtime-matrix.mjs verify <cell-id> [multisite] < report.json
//   node scripts/ci/runtime-matrix.mjs resolved [runtime-results]     joined runtime reports
//   node scripts/ci/runtime-matrix.mjs discover                       upstream releases vs pins
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..', '..');
const TIERS = ['pr', 'scheduled', 'canary'];
const BROWSERS = ['chromium', 'firefox', 'webkit'];
const SUITES = ['acceptance', 'performance'];
const TOPOLOGIES = ['subdirectory', 'subdomain'];
const EXACT = /^\d+\.\d+\.\d+$/;

export function loadManifest(path = join(ROOT, '.github', 'runtime-matrix.json')) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/** The files whose support declarations must agree with the matrix. */
export function readSources(root = ROOT) {
  const read = (file) => readFileSync(join(root, 'plugin', file), 'utf8');
  return {
    plugin: read('gq-support.php'),
    readme: read('readme.txt'),
    composer: read('composer.json'),
    phpstan: read('phpstan.neon.dist'),
    phpcs: read('.phpcs.xml.dist'),
  };
}

const minor = (version) => version.split('.').slice(0, 2).join('.');
// WordPress reports x.y.0 releases as x.y.
const wordpressVersion = (version) => version.replace(/^(\d+\.\d+)\.0$/, '$1');
const compareVersions = (a, b) => {
  const [left, right] = [a, b].map((version) => version.split('.').map(Number));
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) - (right[i] ?? 0);
  }
  return 0;
};
const newest = (versions) => [...versions].sort(compareVersions).at(-1);
const phpId = (version) => {
  const [major, minorPart] = version.split('.').map(Number);
  return major * 10000 + minorPart * 100;
};
const startsWithVersion = (actual, expected) => actual === expected || actual.startsWith(`${expected}.`);

export function cellName(cell) {
  const parts = [`WordPress ${cell.wordpress}`, `PHP ${cell.php}`];
  if (cell.database) parts.push(cell.database);
  if (cell.browser) parts.push(`${cell.browser} ${cell.suite}`);
  if (cell.multisite) parts.push(cell.multisite === 'subdomain' ? 'subdomain multisite' : 'multisite');
  if (cell.objectCache) parts.push('object cache');
  if (cell.gqDesign) parts.push(`GETQUICK Design ${cell.gqDesign}`);
  return `${cell.id}: ${parts.join(', ')}`;
}

/** The cells of the given tiers, as GitHub matrix entries carrying the shared tool pins. */
export function cellsFor(manifest, tiers) {
  return manifest.cells
    .filter((cell) => tiers.includes(cell.tier))
    .map((cell) => ({ ...cell, name: cellName(cell), tools: manifest.tools }));
}

/**
 * Declared support must equal what blocking cells execute: widening a range needs a cell that
 * runs it, not only PHPCompatibility or PHPStan configuration.
 * @returns {string[]} Failures.
 */
export function checkPolicy(manifest, sources) {
  const failures = [];
  const { wordpress: floor, testedUpTo, php } = manifest.supported;
  const expect = (label, actual, expected) => {
    if (actual !== expected) failures.push(`${label} is ${actual ?? 'missing'}; the runtime matrix declares ${expected}`);
  };
  const header = (source, name) => source.match(new RegExp(`^[ *]*${name}:\\s*(\\S+)`, 'm'))?.[1];
  const composer = JSON.parse(sources.composer);

  expect('Plugin header "Requires at least"', header(sources.plugin, 'Requires at least'), floor);
  expect('readme.txt "Requires at least"', header(sources.readme, 'Requires at least'), floor);
  expect('PHPCS minimum_supported_wp_version', sources.phpcs.match(/name="minimum_supported_wp_version" value="([^"]+)"/)?.[1], floor);
  expect('readme.txt "Tested up to"', header(sources.readme, 'Tested up to'), testedUpTo);
  expect('Plugin header "Requires PHP"', header(sources.plugin, 'Requires PHP'), php.minimum);
  expect('readme.txt "Requires PHP"', header(sources.readme, 'Requires PHP'), php.minimum);
  expect('Composer require.php', composer.require?.php, `>=${php.minimum}`);
  expect('Composer platform PHP minor', minor(composer.config?.platform?.php ?? ''), php.minimum);
  expect('PHPCS testVersion', sources.phpcs.match(/name="testVersion" value="([^"]+)"/)?.[1], `${php.minimum}-`);
  expect('PHPStan phpVersion.min', Number(sources.phpstan.match(/min:\s*(\d+)/)?.[1]), phpId(php.minimum));
  expect('PHPStan phpVersion.max', Number(sources.phpstan.match(/max:\s*(\d+)/)?.[1]), phpId(php.maximum) + 99);

  const ids = new Set();
  for (const cell of manifest.cells) {
    if (ids.has(cell.id)) failures.push(`cell id ${cell.id} is not unique`);
    ids.add(cell.id);
    if (!TIERS.includes(cell.tier)) failures.push(`${cell.id} has unknown tier ${cell.tier}`);
    if (cell.browser && !BROWSERS.includes(cell.browser)) failures.push(`${cell.id} has unknown browser ${cell.browser}`);
    if (!cell.browser !== !cell.suite || (cell.suite && !SUITES.includes(cell.suite))) failures.push(`${cell.id} needs both a browser and a suite (${SUITES.join(' or ')}), or neither`);
    if (cell.multisite && !TOPOLOGIES.includes(cell.multisite)) failures.push(`${cell.id} has unknown multisite topology ${cell.multisite}`);
    if (cell.tier === 'canary') continue;
    for (const key of ['wordpress', 'woocommerce', 'pluginCheck', 'gqDesign']) {
      if (key in cell && !EXACT.test(cell[key])) failures.push(`${cell.id} pins ${key} "${cell[key]}"; blocking cells need an exact x.y.z release`);
    }
    if (phpId(cell.php) < phpId(php.minimum) || phpId(cell.php) > phpId(php.maximum)) failures.push(`${cell.id} runs PHP ${cell.php}, outside the supported ${php.minimum}–${php.maximum}`);
  }

  const pr = manifest.cells.filter((cell) => cell.tier === 'pr');
  const boundary = (label, matches) => {
    const cells = pr.filter(matches);
    if (cells.length === 0) return failures.push(`no pull-request cell runs ${label}`);
    if (!cells.some((cell) => cell.multisite)) failures.push(`no pull-request cell runs ${label} as multisite`);
    if (!cells.every((cell) => cell.react)) failures.push(`every pull-request cell on ${label} must state the WordPress-provided React it expects`);
  };
  boundary(`WordPress ${floor}.0 on PHP ${php.minimum}`, (cell) => cell.wordpress === `${floor}.0` && cell.php === php.minimum);
  boundary(`WordPress ${testedUpTo} on PHP ${php.maximum}`, (cell) => EXACT.test(cell.wordpress) && minor(cell.wordpress) === testedUpTo && cell.php === php.maximum);
  // Every other cell runs the one-line fixture that plugin/tests/integration/run.sh writes.
  if (!pr.some((cell) => cell.gqDesign && cell.suite)) failures.push('no pull-request browser cell installs the real GETQUICK Design (gqDesign)');
  const [major, lowest] = php.minimum.split('.').map(Number);
  for (let next = lowest; next <= Number(php.maximum.split('.')[1]); next++) {
    if (!pr.some((cell) => cell.php === `${major}.${next}`)) failures.push(`PHP ${major}.${next} has no pull-request cell`);
  }

  return failures;
}

/**
 * Compares a cell with the runtime its disposable site actually reported (runtime.php).
 * @param {'single' | 'multisite'} options.topology The topology at the time of the report.
 * @returns {string[]} Failures.
 */
export function verifyRuntime(cell, report, { topology = 'single' } = {}) {
  const failures = [];
  if (!startsWithVersion(report.php ?? '', cell.php)) failures.push(`PHP ${report.php} ran; the cell declares ${cell.php}`);
  if (EXACT.test(cell.wordpress) && wordpressVersion(report.wordpress ?? '') !== wordpressVersion(cell.wordpress)) {
    failures.push(`WordPress ${report.wordpress} ran; the cell declares ${cell.wordpress}`);
  }
  if (cell.woocommerce && (EXACT.test(cell.woocommerce) ? report.woocommerce !== cell.woocommerce : !report.woocommerce)) {
    failures.push(`WooCommerce ${report.woocommerce ?? 'is not installed'}; the cell declares ${cell.woocommerce}`);
  }
  if (cell.react && !startsWithVersion(report.react ?? '', cell.react)) failures.push(`WordPress registers React ${report.react}; the cell expects ${cell.react}`);

  if (!report.assets) {
    failures.push('the app build is missing: build it before recording the runtime');
  } else {
    if (report.assets.unresolved.length > 0) failures.push(`app script dependencies WordPress does not register: ${report.assets.unresolved.join(', ')}`);
    if (report.assets.forbidden.length > 0) failures.push(`app depends on forbidden handles: ${report.assets.forbidden.join(', ')}`);
  }

  if (topology === 'multisite') {
    if (!report.multisite) failures.push('expected a multisite network');
    else if (report.subdomainInstall !== (cell.multisite === 'subdomain')) failures.push(`expected a ${cell.multisite === 'subdomain' ? 'subdomain' : 'subdirectory'} network`);
  } else if (report.multisite) {
    failures.push('expected a single site');
  }

  if (cell.database) {
    const [type, version] = cell.database.split(':');
    const label = `${type === 'mysql' ? 'MySQL' : 'MariaDB'} ${version}`;
    const server = report.database?.server ?? '';
    if (/mariadb/i.test(server) !== (type === 'mariadb') || !startsWithVersion(report.database?.version ?? '', version)) {
      failures.push(`database ${server || 'unknown'} ran; the cell declares ${label}`);
    }
  }
  // The fixture defines GETQUICK_DESIGN_VERSION "test" and no classes; the real release loads its
  // classes through the Composer autoloader, as on a Bedrock site.
  const designVersion = report.design?.version ?? 'missing';
  if (designVersion !== (cell.gqDesign ?? 'test')) failures.push(`GETQUICK Design ${designVersion} ran; the cell declares ${cell.gqDesign ?? 'the test fixture'}`);
  else if (cell.gqDesign && !report.design.classes) failures.push(`GETQUICK Design ${designVersion} is active but its classes did not load: check its Composer autoloader`);
  if (Boolean(cell.objectCache) !== Boolean(report.objectCache)) failures.push(`persistent object cache is ${report.objectCache ? 'on' : 'off'}; the cell declares it ${cell.objectCache ? 'on' : 'off'}`);

  return failures;
}

/**
 * Pins that newer upstream releases have overtaken. The WordPress x.y.0 floor cell is a
 * deliberate compatibility sentinel, not a stale pin.
 * @param {{ wordpress: Record<string, string>, woocommerce: string, 'plugin-check': string }} upstream Latest release per WordPress branch and plugin.
 */
export function pinDrift(manifest, upstream) {
  const drift = [];
  const blocking = manifest.cells.filter((cell) => cell.tier !== 'canary');
  const pins = (key) => [...new Set(blocking.map((cell) => cell[key]).filter((version) => version && EXACT.test(version)))];

  for (const pin of pins('wordpress')) {
    if (pin === `${manifest.supported.wordpress}.0`) continue;
    const available = upstream.wordpress[minor(pin)];
    if (available && compareVersions(available, pin) > 0) drift.push({ component: 'WordPress', pinned: pin, available, note: 'patch release on a pinned branch' });
  }
  const latestBranch = newest(Object.keys(upstream.wordpress));
  if (compareVersions(latestBranch, manifest.supported.testedUpTo) > 0) {
    drift.push({ component: 'WordPress', pinned: manifest.supported.testedUpTo, available: upstream.wordpress[latestBranch], note: 'new minor: run the full pre-release suite before raising Tested up to' });
  }
  for (const [component, key, latest] of [['WooCommerce', 'woocommerce', upstream.woocommerce], ['Plugin Check', 'pluginCheck', upstream['plugin-check']]]) {
    const pinned = newest(pins(key));
    if (pinned && latest && compareVersions(latest, pinned) > 0) drift.push({ component, pinned, available: latest, note: 'newer release than the newest pin' });
  }
  return drift;
}

/** Latest releases from the official WordPress.org APIs; a failed lookup is an error, never "no drift". */
export async function fetchUpstream() {
  const json = async (url) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return response.json();
  };
  const plugin = async (slug) => (await json(`https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request%5Bslug%5D=${slug}`)).version;
  const wordpress = {};
  for (const version of Object.keys(await json('https://api.wordpress.org/core/stable-check/1.0/'))) {
    if (!/^\d+\.\d+(\.\d+)?$/.test(version)) continue;
    const branch = minor(version);
    if (!wordpress[branch] || compareVersions(version, wordpress[branch]) > 0) wordpress[branch] = version;
  }
  return { wordpress, woocommerce: await plugin('woocommerce'), 'plugin-check': await plugin('plugin-check') };
}

function summarize(title, markdown) {
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### ${title}\n\n${markdown}\n`);
}

function fail(title, failures) {
  for (const failure of failures) console.error(`::error title=${title}::${failure}`);
  process.exit(failures.length > 0 ? 1 : 0);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, ...args] = process.argv.slice(2);
  const manifest = loadManifest();

  if (command === 'cells') {
    const unknown = args.filter((tier) => !TIERS.includes(tier));
    if (unknown.length > 0) fail('Runtime matrix', [`unknown tier: ${unknown.join(', ')}`]);
    process.stdout.write(JSON.stringify(cellsFor(manifest, args)));
  } else if (command === 'env') {
    // Shell assignments for scripts/ci/run-cell.sh: CELL_WORDPRESS=…, unset fields empty.
    const cell = manifest.cells.find((candidate) => candidate.id === args[0]);
    if (!cell) fail('Runtime matrix', [`unknown cell ${args[0] ?? ''}`]);
    const fields = {
      id: cell.id,
      name: cellName(cell),
      wordpress: cell.wordpress,
      php: cell.php,
      database: cell.database,
      woocommerce: cell.woocommerce,
      browser: cell.browser,
      suite: cell.suite,
      multisite: cell.multisite,
      plugin_check: cell.pluginCheck,
      redis_cache: cell.objectCache ? manifest.tools['redis-cache'] : '',
      gq_design: cell.gqDesign,
    };
    const quote = (value) => `'${String(value ?? '').replaceAll("'", `'\\''`)}'`;
    process.stdout.write(Object.entries(fields).map(([key, value]) => `CELL_${key.toUpperCase()}=${quote(value)}\n`).join(''));
  } else if (command === 'policy') {
    const failures = checkPolicy(manifest, readSources());
    const rows = manifest.cells.map((cell) => `| ${cell.tier} | ${cellName(cell)} | ${cell.woocommerce ?? '—'} | ${cell.react ?? '—'} |`);
    summarize('Runtime matrix', ['| Tier | Cell | WooCommerce | React |', '|---|---|---|---|', ...rows].join('\n'));
    fail('Runtime policy', failures);
  } else if (command === 'verify') {
    const [id, topology = 'single'] = args;
    const cell = manifest.cells.find((candidate) => candidate.id === id);
    if (!cell) fail('Runtime', [`unknown cell ${id}`]);
    const report = JSON.parse(readFileSync(0, 'utf8'));
    summarize(`Runtime of ${cellName(cell)} (${topology})`, `\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\``);
    fail('Runtime', verifyRuntime(cell, report, { topology }));
  } else if (command === 'resolved') {
    // Joins every cell's runtime reports into one resolved matrix artifact and summary table.
    const dir = args[0] ?? 'runtime-results';
    mkdirSync(dir, { recursive: true });
    const reports = readdirSync(dir)
      .filter((file) => file.endsWith('.json') && file !== 'resolved-matrix.json')
      .sort()
      .map((file) => ({ report: file.replace(/\.json$/, ''), ...JSON.parse(readFileSync(join(dir, file), 'utf8')) }));
    writeFileSync(join(dir, 'resolved-matrix.json'), `${JSON.stringify(reports, null, 2)}\n`);
    const rows = reports.map((r) => `| ${r.report} | ${r.php} | ${r.wordpress} | ${r.database?.server ?? '—'} | ${r.react ?? '—'} | ${r.woocommerce ?? '—'} | ${r.design?.version ?? '—'} | ${r.objectCache ? 'on' : 'off'} | ${r.toolchain?.browser || '—'} (${r.toolchain?.playwright ?? '—'}) |`);
    summarize('Resolved runtime matrix', reports.length === 0 ? 'No runtime reports: no WordPress cell recorded its runtime.' : ['| Report | PHP | WordPress | Database | React | WooCommerce | GETQUICK Design | Object cache | Browser |', '|---|---|---|---|---|---|---|---|---|', ...rows].join('\n'));
  } else if (command === 'discover') {
    const upstream = await fetchUpstream();
    const drift = pinDrift(manifest, upstream);
    const rows = drift.map((row) => `| ${row.component} | ${row.pinned} | ${row.available} | ${row.note} |`);
    summarize('Upstream releases versus pins', drift.length === 0 ? 'Every pin is current.' : ['| Component | Pinned | Available | Action |', '|---|---|---|---|', ...rows].join('\n'));
    const supported = Object.entries(upstream.wordpress).filter(([branch]) => compareVersions(branch, manifest.supported.wordpress) >= 0);
    console.log(JSON.stringify({ ...upstream, wordpress: Object.fromEntries(supported) }));
    fail('Pin drift', drift.map((row) => `${row.component} ${row.pinned} → ${row.available}: update .github/runtime-matrix.json in a reviewed PR (${row.note})`));
  } else {
    fail('Runtime matrix', [`unknown command ${command ?? ''}; use cells, env, policy, verify, resolved or discover`]);
  }
}

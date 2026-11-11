// The supported-runtime matrix: which cells run, that the declared support matches them, that a
// cell really ran the runtime it claims, and which pins upstream releases have overtaken.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellsFor, checkPolicy, loadManifest, pinDrift, readSources, resolveCell, verifyRuntime } from './runtime-matrix.mjs';

const manifest = loadManifest();
const sources = readSources();
const copy = () => structuredClone(manifest);
const cell = (id) => resolveCell(manifest, manifest.cells.find((candidate) => candidate.id === id));

test('pull requests run PHP 8.0 and 8.4 on WordPress 7.1.4, single site and multisite', () => {
  const pr = cellsFor(manifest, ['pr']);
  assert.ok(pr.some((c) => c.wordpress === '7.1.4' && c.php === '8.0' && c.woocommerce === '9.4.3' && c.multisite === 'subdirectory'));
  assert.ok(pr.some((c) => c.wordpress === '7.1.4' && c.php === '8.4' && c.multisite === 'subdirectory'));
  assert.deepEqual([...new Set(pr.map((c) => c.php))].sort(), ['8.0', '8.1', '8.2', '8.3', '8.4']);
});

test('pull requests run no scheduled or canary cell, and canaries are only PHP 8.5 or floating releases', () => {
  assert.ok(cellsFor(manifest, ['pr']).every((c) => c.tier === 'pr'));
  assert.ok(cellsFor(manifest, ['canary']).every((c) => c.php === '8.5' || ['latest', 'nightly'].includes(c.wordpress)));
});

test('every blocking cell runs the one pinned WordPress, the latest release', () => {
  const blocking = cellsFor(manifest, ['pr', 'scheduled']);
  assert.deepEqual([...new Set(blocking.map((c) => c.wordpress))], [manifest.wordpress]);
  assert.equal(manifest.wordpress, '7.1.4');
});

test('every cell has a distinct name naming its runtime', () => {
  const names = cellsFor(manifest, ['pr', 'scheduled', 'canary']).map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(cellsFor(manifest, ['pr'])[0].name, 'minimum: WordPress 7.1.4, PHP 8.0, chromium acceptance, multisite');
});

test('the committed matrix agrees with the plugin headers and static-analysis ranges', () => {
  assert.deepEqual(checkPolicy(manifest, sources), []);
});

test('raising the PHP floor in the header alone fails', () => {
  const failures = checkPolicy(manifest, { ...sources, plugin: sources.plugin.replace('Requires PHP:       8.0', 'Requires PHP:       8.1') });
  assert.match(failures.join('\n'), /Requires PHP/);
});

test('widening the PHPStan range without a pull-request lane fails', () => {
  const failures = checkPolicy(manifest, { ...sources, phpstan: sources.phpstan.replace('max: 80499', 'max: 80599') });
  assert.match(failures.join('\n'), /PHPStan/);
  const widened = copy();
  widened.supported.php.maximum = '8.5';
  assert.match(checkPolicy(widened, sources).join('\n'), /PHP 8\.5 has no pull-request cell/);
});

test('dropping the PHP 8.0 cells fails', () => {
  const floorless = copy();
  floorless.cells = floorless.cells.filter((c) => c.php !== '8.0');
  assert.match(checkPolicy(floorless, sources).join('\n'), /7\.1\.4 on PHP 8\.0/);
});

test('a blocking cell may not run another WordPress, or float a plugin on latest', () => {
  const older = copy();
  older.cells.find((c) => c.id === 'stable').woocommerce = 'latest';
  older.cells.find((c) => c.id === 'firefox').wordpress = '7.0.8';
  const failures = checkPolicy(older, sources).join('\n');
  assert.match(failures, /stable pins woocommerce "latest"/);
  assert.match(failures, /firefox pins WordPress 7\.0\.8/);
});

test('the WordPress pin must be an exact release on the declared minor, which is also Tested up to', () => {
  const floating = copy();
  floating.wordpress = 'latest';
  assert.match(checkPolicy(floating, sources).join('\n'), /pin is latest/);
  const behind = copy();
  behind.wordpress = '7.0.8';
  assert.match(checkPolicy(behind, sources).join('\n'), /7\.0\.8 is not on the declared minimum 7\.1/);
  const floor = copy();
  floor.supported.wordpress = '7.0';
  assert.match(checkPolicy(floor, sources).join('\n'), /Tested up to 7\.1 differs from Requires at least 7\.0/);
  assert.match(checkPolicy(manifest, { ...sources, plugin: sources.plugin.replace('Requires at least:  7.1', 'Requires at least:  7.0') }).join('\n'), /Requires at least/);
});

test('Tested up to must be the WordPress minor of the current pull-request endpoint', () => {
  assert.match(checkPolicy(manifest, { ...sources, readme: sources.readme.replace('Tested up to: 7.1', 'Tested up to: 7.2') }).join('\n'), /Tested up to/);
});

test('the PHP 8.0 and 8.4 boundaries must state the WordPress-provided React they expect', () => {
  const unexpected = copy();
  delete unexpected.cells.find((c) => c.id === 'minimum').react;
  assert.match(checkPolicy(unexpected, sources).join('\n'), /React/);
});

test('a pull-request browser cell installs the real GETQUICK Design at an exact release', () => {
  const real = cellsFor(manifest, ['pr']).filter((c) => c.gqDesign);
  assert.ok(real.some((c) => /^\d+\.\d+\.\d+$/.test(c.gqDesign) && c.browser && c.suite === 'acceptance'));
  assert.match(real[0].name, /GETQUICK Design \d+\.\d+\.\d+/);
  assert.ok(cellsFor(manifest, ['pr']).filter((c) => !c.gqDesign).every((c) => !/GETQUICK Design/.test(c.name)));
});

test('dropping the real GETQUICK Design cell, or floating its release, fails', () => {
  const fixtureOnly = copy();
  for (const c of fixtureOnly.cells) delete c.gqDesign;
  assert.match(checkPolicy(fixtureOnly, sources).join('\n'), /no pull-request browser cell installs the real GETQUICK Design/);
  const floating = copy();
  floating.cells.find((c) => c.gqDesign).gqDesign = 'latest';
  assert.match(checkPolicy(floating, sources).join('\n'), /pins gqDesign "latest"/);
});

const report = {
  php: '8.0.30',
  wordpress: '7.1.4',
  database: { server: '11.8.3-MariaDB-ubu2404-log', version: '11.8.3' },
  multisite: false,
  subdomainInstall: false,
  objectCache: false,
  react: '18.3.1',
  woocommerce: '9.4.3',
  assets: { dependencies: ['wp-a11y', 'wp-api-fetch', 'wp-element', 'wp-i18n'], unresolved: [], forbidden: [] },
  design: { version: 'test', classes: false },
};

test('a cell that ran its declared runtime verifies, with 7.1 reported for 7.1.0', () => {
  assert.deepEqual(verifyRuntime(cell('minimum'), report), []);
  assert.deepEqual(verifyRuntime({ ...cell('minimum'), wordpress: '7.1.0' }, { ...report, wordpress: '7.1' }), []);
});

test('a cell that ran another PHP, WordPress or WooCommerce fails', () => {
  assert.match(verifyRuntime(cell('minimum'), { ...report, php: '8.2.33' }).join('\n'), /PHP 8\.2\.33.*8\.0/);
  assert.match(verifyRuntime(cell('minimum'), { ...report, wordpress: '7.0.8' }).join('\n'), /WordPress 7\.0\.8.*7\.1\.4/);
  assert.match(verifyRuntime(cell('minimum'), { ...report, woocommerce: '11.3.0' }).join('\n'), /WooCommerce/);
});

test('WordPress-provided React must match, and the app dependency graph must resolve', () => {
  assert.match(verifyRuntime(cell('minimum'), { ...report, react: '18.2.0' }).join('\n'), /React 18\.2\.0/);
  assert.deepEqual(verifyRuntime(cell('stable'), { ...report, php: '8.4.1', wordpress: '7.1.4', woocommerce: '11.3.0', react: '18.3.1.1' }), []);
  assert.match(verifyRuntime(cell('minimum'), { ...report, assets: { ...report.assets, unresolved: ['wp-a11y'] } }).join('\n'), /wp-a11y/);
  assert.match(verifyRuntime(cell('minimum'), { ...report, assets: { ...report.assets, forbidden: ['react-jsx-runtime'] } }).join('\n'), /react-jsx-runtime/);
  assert.match(verifyRuntime(cell('minimum'), { ...report, assets: null }).join('\n'), /build/);
});

test('the topology, database and object cache must be the declared ones', () => {
  assert.match(verifyRuntime(cell('minimum'), report, { topology: 'multisite' }).join('\n'), /multisite/);
  assert.deepEqual(verifyRuntime(cell('minimum'), { ...report, multisite: true }, { topology: 'multisite' }), []);
  const subdomain = { ...cell('multisite-subdomain') };
  assert.match(verifyRuntime(subdomain, { ...report, php: '8.4.1', wordpress: '7.1.4', multisite: true }, { topology: 'multisite' }).join('\n'), /subdomain/);
  assert.match(verifyRuntime(cell('mysql-8.0'), { ...report, php: '8.4.1', wordpress: '7.1.4' }).join('\n'), /MySQL 8\.0/);
  assert.deepEqual(verifyRuntime(cell('mysql-8.0'), { ...report, php: '8.4.1', wordpress: '7.1.4', database: { server: '8.0.40', version: '8.0.40' } }), []);
  assert.match(verifyRuntime(cell('object-cache'), { ...report, php: '8.4.1', wordpress: '7.1.4', woocommerce: '11.3.0' }).join('\n'), /object cache/);
});

test('the GETQUICK Design that ran must be the fixture, or the cell\'s real release with its classes loaded', () => {
  assert.match(verifyRuntime(cell('minimum'), { ...report, design: { version: '0.8.1', classes: true } }).join('\n'), /GETQUICK Design 0\.8\.1.*fixture/);
  assert.match(verifyRuntime(cell('minimum'), { ...report, design: undefined }).join('\n'), /GETQUICK Design/);
  const real = manifest.cells.find((c) => c.gqDesign);
  const ran = { ...report, php: '8.4.1', wordpress: real.wordpress, woocommerce: real.woocommerce ?? null, react: real.react };
  assert.deepEqual(verifyRuntime(real, { ...ran, design: { version: real.gqDesign, classes: true } }), []);
  assert.match(verifyRuntime(real, { ...ran, design: { version: 'test', classes: false } }).join('\n'), new RegExp(`GETQUICK Design test.*${real.gqDesign.replaceAll('.', '\\.')}`));
  assert.match(verifyRuntime(real, { ...ran, design: { version: real.gqDesign, classes: false } }).join('\n'), /autoload/);
});

test('a floating canary records whatever WordPress it resolved', () => {
  assert.deepEqual(verifyRuntime(cell('wordpress-nightly'), { ...report, php: '8.4.1', wordpress: '7.2-alpha-61234', woocommerce: null }), []);
});

const upstream = { wordpress: { '6.9': '6.9.11', '7.0': '7.0.8', '7.1': '7.1.4' }, woocommerce: '11.3.0', 'plugin-check': '2.2.0' };

test('current pins report no drift', () => {
  assert.deepEqual(pinDrift(manifest, upstream), []);
});

test('a WordPress patch, a new WordPress minor and newer pinned plugins are reported', () => {
  const patch = pinDrift(manifest, { ...upstream, wordpress: { ...upstream.wordpress, '7.1': '7.1.5' } });
  assert.deepEqual(patch.map((row) => [row.pinned, row.available, row.note]), [['7.1.4', '7.1.5', 'patch release: bump the WordPress pin']]);
  const drift = pinDrift(manifest, { wordpress: { ...upstream.wordpress, '7.2': '7.2.0' }, woocommerce: '11.4.0', 'plugin-check': '2.3.0' });
  const text = drift.map((row) => `${row.component} ${row.pinned} → ${row.available}`);
  assert.ok(text.includes('WordPress 7.1.4 → 7.2.0'), text.join('\n'));
  assert.match(drift[0].note, /Requires at least and Tested up to/);
  assert.ok(text.includes('WooCommerce 11.3.0 → 11.4.0'), text.join('\n'));
  assert.ok(text.includes('Plugin Check 2.2.0 → 2.3.0'), text.join('\n'));
  // Patches on older branches are not ours to track: only the latest release is supported.
  assert.deepEqual(pinDrift(manifest, { ...upstream, wordpress: { ...upstream.wordpress, '7.0': '7.0.9' } }), []);
});

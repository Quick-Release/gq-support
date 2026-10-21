// The supported-runtime matrix: which cells run, that the declared support matches them, that a
// cell really ran the runtime it claims, and which pins upstream releases have overtaken.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellsFor, checkPolicy, loadManifest, pinDrift, readSources, verifyRuntime } from './runtime-matrix.mjs';

const manifest = loadManifest();
const sources = readSources();
const copy = () => structuredClone(manifest);
const cell = (id) => manifest.cells.find((candidate) => candidate.id === id);

test('pull requests run PHP 8.0 on WordPress 6.5.0 and the current endpoint, single site and multisite', () => {
  const pr = cellsFor(manifest, ['pr']);
  assert.ok(pr.some((c) => c.wordpress === '6.5.0' && c.php === '8.0' && c.multisite === 'subdirectory'));
  assert.ok(pr.some((c) => c.wordpress === '7.1.3' && c.php === '8.4' && c.multisite === 'subdirectory'));
  assert.deepEqual([...new Set(pr.map((c) => c.php))].sort(), ['8.0', '8.1', '8.2', '8.3', '8.4']);
});

test('only canary cells are nonblocking, and pull requests run no scheduled or canary cell', () => {
  assert.ok(cellsFor(manifest, ['pr']).every((c) => c.tier === 'pr' && c.blocking));
  assert.ok(cellsFor(manifest, ['scheduled', 'canary']).every((c) => c.blocking === (c.tier === 'scheduled')));
});

test('every cell has a distinct name naming its runtime', () => {
  const names = cellsFor(manifest, ['pr', 'scheduled', 'canary']).map((c) => c.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(cellsFor(manifest, ['pr'])[0].name, 'minimum: WordPress 6.5.0, PHP 8.0, chromium acceptance, multisite');
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

test('dropping the WordPress 6.5.0 floor cell fails', () => {
  const floorless = copy();
  floorless.cells = floorless.cells.filter((c) => c.wordpress !== '6.5.0');
  assert.match(checkPolicy(floorless, sources).join('\n'), /6\.5\.0 on PHP 8\.0/);
});

test('a blocking cell may not float on latest or nightly', () => {
  const floating = copy();
  floating.cells.find((c) => c.id === 'stable').woocommerce = 'latest';
  floating.cells.find((c) => c.id === 'previous-minor').wordpress = 'nightly';
  const failures = checkPolicy(floating, sources).join('\n');
  assert.match(failures, /stable pins woocommerce "latest"/);
  assert.match(failures, /previous-minor pins wordpress "nightly"/);
});

test('Tested up to must be the WordPress minor of the current pull-request endpoint', () => {
  assert.match(checkPolicy(manifest, { ...sources, readme: sources.readme.replace('Tested up to: 7.1', 'Tested up to: 7.2') }).join('\n'), /Tested up to/);
});

test('the oldest and stable boundaries must state the WordPress-provided React they expect', () => {
  const unexpected = copy();
  delete unexpected.cells.find((c) => c.id === 'minimum').react;
  assert.match(checkPolicy(unexpected, sources).join('\n'), /React/);
});

const report = {
  php: '8.0.30',
  wordpress: '6.5',
  database: { server: '11.8.3-MariaDB-ubu2404-log', version: '11.8.3' },
  multisite: false,
  subdomainInstall: false,
  objectCache: false,
  react: '18.2.0',
  woocommerce: '9.4.3',
  assets: { dependencies: ['wp-a11y', 'wp-api-fetch', 'wp-element', 'wp-i18n'], unresolved: [], forbidden: [] },
};

test('a cell that ran its declared runtime verifies, with 6.5 reported for 6.5.0', () => {
  assert.deepEqual(verifyRuntime(cell('minimum'), report), []);
});

test('a cell that ran another PHP, WordPress or WooCommerce fails', () => {
  assert.match(verifyRuntime(cell('minimum'), { ...report, php: '8.2.33' }).join('\n'), /PHP 8\.2\.33.*8\.0/);
  assert.match(verifyRuntime(cell('minimum'), { ...report, wordpress: '7.1.3' }).join('\n'), /WordPress 7\.1\.3.*6\.5\.0/);
  assert.match(verifyRuntime(cell('minimum'), { ...report, woocommerce: '11.2.1' }).join('\n'), /WooCommerce/);
});

test('WordPress-provided React must match, and the app dependency graph must resolve', () => {
  assert.match(verifyRuntime(cell('minimum'), { ...report, react: '18.3.1.1' }).join('\n'), /React 18\.3\.1\.1/);
  assert.deepEqual(verifyRuntime(cell('stable'), { ...report, php: '8.4.1', wordpress: '7.1.3', woocommerce: '11.2.1', react: '18.3.1.1' }), []);
  assert.match(verifyRuntime(cell('minimum'), { ...report, assets: { ...report.assets, unresolved: ['wp-a11y'] } }).join('\n'), /wp-a11y/);
  assert.match(verifyRuntime(cell('minimum'), { ...report, assets: { ...report.assets, forbidden: ['react-jsx-runtime'] } }).join('\n'), /react-jsx-runtime/);
  assert.match(verifyRuntime(cell('minimum'), { ...report, assets: null }).join('\n'), /build/);
});

test('the topology, database and object cache must be the declared ones', () => {
  assert.match(verifyRuntime(cell('minimum'), report, { topology: 'multisite' }).join('\n'), /multisite/);
  assert.deepEqual(verifyRuntime(cell('minimum'), { ...report, multisite: true }, { topology: 'multisite' }), []);
  const subdomain = { ...cell('multisite-subdomain') };
  assert.match(verifyRuntime(subdomain, { ...report, php: '8.4.1', wordpress: '7.1.3', multisite: true }, { topology: 'multisite' }).join('\n'), /subdomain/);
  assert.match(verifyRuntime(cell('mysql-8.0'), { ...report, php: '8.4.1', wordpress: '7.1.3' }).join('\n'), /MySQL 8\.0/);
  assert.deepEqual(verifyRuntime(cell('mysql-8.0'), { ...report, php: '8.4.1', wordpress: '7.1.3', database: { server: '8.0.40', version: '8.0.40' } }), []);
  assert.match(verifyRuntime(cell('object-cache'), { ...report, php: '8.4.1', wordpress: '7.1.3', woocommerce: '11.2.1' }).join('\n'), /object cache/);
});

test('a floating canary records whatever WordPress it resolved', () => {
  assert.deepEqual(verifyRuntime(cell('wordpress-nightly'), { ...report, php: '8.4.1', wordpress: '7.2-alpha-61234', woocommerce: null }), []);
});

const upstream = { wordpress: { '6.5': '6.5.13', '7.0': '7.0.7', '7.1': '7.1.3' }, woocommerce: '11.2.1', 'plugin-check': '2.1.0' };

test('current pins report no drift', () => {
  assert.deepEqual(pinDrift(manifest, upstream), []);
});

test('upstream patches, a new WordPress minor and newer pinned plugins are reported', () => {
  const drift = pinDrift(manifest, { wordpress: { ...upstream.wordpress, '6.5': '6.5.14', '7.2': '7.2.0' }, woocommerce: '11.3.0', 'plugin-check': '2.2.0' });
  const text = drift.map((row) => `${row.component} ${row.pinned} → ${row.available}`);
  assert.ok(text.includes('WordPress 6.5.13 → 6.5.14'), text.join('\n'));
  assert.ok(text.includes('WordPress 7.1 → 7.2.0'), text.join('\n'));
  assert.ok(text.includes('WooCommerce 11.2.1 → 11.3.0'), text.join('\n'));
  assert.ok(text.includes('Plugin Check 2.1.0 → 2.2.0'), text.join('\n'));
  // The 6.5.0 cell is a deliberate compatibility sentinel, not a stale pin.
  assert.ok(!text.some((row) => row.startsWith('WordPress 6.5.0')));
});

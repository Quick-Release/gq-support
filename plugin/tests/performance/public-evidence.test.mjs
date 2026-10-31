// B1's mismatch evidence (public-evidence.cjs): the sanitized copies the counter gate attaches
// when a public page differs with Support on. The artifact scan must pass them, so they carry no
// nonce, while they still show the change. Every nonce here is generated at run time.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const { redactNonces, describeChange } = createRequire(import.meta.url)('./public-evidence.cjs');

const ROOT = join(import.meta.dirname, '..', '..', '..');
const work = mkdtempSync(join(tmpdir(), 'gq-public-evidence-'));
after(() => rmSync(work, { recursive: true, force: true }));

const nonce = () => randomBytes(5).toString('hex');
const encode = (text) => encodeURIComponent(text).replace(/'/g, '%27');

/** A public page with a nonce in every form WordPress and WooCommerce print one. */
function page(nonces) {
  const middleware = `\t\t\tvar wcBlocksMiddlewareConfig = {\n\t\t\t\tstoreApiNonce: '${nonces.store}',\n\t\t\t\twcStoreApiNonceTimestamp: '1793452351'\n\t\t\t};\n`;
  return [
    '<!DOCTYPE html>',
    '<link rel="stylesheet" href="https://shop.example/wp-includes/css/dist/block-library/style.min.css?ver=6.5" />',
    `<script>wp.apiFetch.nonceMiddleware = wp.apiFetch.createNonceMiddleware( "${nonces.rest}" );</script>`,
    `<script>var wpApiSettings = {"root":"https://shop.example/wp-json/","nonce":"${nonces.settings}","versionString":"wp/v2/"};</script>`,
    `<a href="https://shop.example/wp-login.php?action=logout&amp;_wpnonce=${nonces.logout}">Log out</a>`,
    `<script id="wc-blocks-middleware-js-before">\n${middleware}</script>`,
    `<script>var wcBlocksMiniCartFrontendDependencies = JSON.parse( decodeURIComponent( '${encode(JSON.stringify({ 'wc-blocks-middleware': { version: 'e3f189e7e5007fb14fff', before: middleware } }))}' ) );</script>`,
    '<script src="https://shop.example/wp-content/plugins/woocommerce/assets/client/blocks/wc-blocks.js?ver=0a1b2c3d4e"></script>',
    '</html>',
  ].join('\n');
}

const nonces = () => ({ store: nonce(), rest: nonce(), settings: nonce(), logout: nonce() });

/** Writes `files` into a fresh directory and runs the artifact scan CI runs before every upload. */
function artifactScan(name, files) {
  const dir = join(work, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
  return spawnSync(join(ROOT, 'scripts', 'ci', 'scan-artifact.sh'), [dir], { encoding: 'utf8' });
}

test('the sanitized page keeps no nonce, and the artifact scan passes it', () => {
  const values = nonces();
  const raw = page(values);
  // The control: the scan withholds the raw page, as it withheld CI's public-on.html.
  assert.equal(artifactScan('raw', { 'public-on.html': raw }).status, 1, 'the raw page must leak');

  const sanitized = redactNonces(raw);
  for (const [field, value] of Object.entries(values)) assert.ok(!sanitized.includes(value), `the ${field} nonce survived`);
  const scan = artifactScan('sanitized', { 'public-on.html': sanitized });
  assert.equal(scan.status, 0, scan.stdout + scan.stderr);
});

test('sanitizing changes nothing but nonces', () => {
  const raw = page(nonces());
  const sanitized = redactNonces(raw);
  assert.equal(sanitized.split('\n').length, raw.split('\n').length, 'line numbers must still match the page');
  // Asset versions and other hex stay, so a changed version still shows.
  assert.match(sanitized, /e3f189e7e5007fb14fff/);
  assert.match(sanitized, /\?ver=0a1b2c3d4e/);
  assert.match(sanitized, /wcStoreApiNonceTimestamp: '1793452351'/);
  assert.equal(redactNonces('<p>No nonce here, 0123456789.</p>'), '<p>No nonce here, 0123456789.</p>');
});

test('the change summary shows an injected stylesheet, and no nonce', () => {
  const values = nonces();
  const off = page(values);
  // gq-probe.php's `bytes` violation: Support prints one stylesheet into the head.
  const on = off.replace('<!DOCTYPE html>\n', '<!DOCTYPE html>\n<link rel="stylesheet" href="https://shop.example/wp-content/plugins/gq-support/assets/launcher.css" />\n');
  const summary = describeChange(off, on);
  assert.match(summary, /gq-support\/assets\/launcher\.css/);
  assert.match(summary, /\+ line 2/);
  for (const value of Object.values(values)) assert.ok(!summary.includes(value), 'a nonce reached the summary');
  assert.equal(artifactScan('summary', { 'public-diff.txt': summary }).status, 0);
});

test('a nonce that changes between requests shows as a change, without either value', () => {
  const offValues = nonces();
  const onValues = { ...offValues, store: nonce() };
  const summary = describeChange(page(offValues), page(onValues));
  assert.match(summary, /storeApiNonce/);
  for (const value of [...Object.values(offValues), onValues.store]) assert.ok(!summary.includes(value), 'a nonce reached the summary');
});

test('the summary is bounded, however much changed', () => {
  const off = Array.from({ length: 2000 }, (_, i) => `<p>${i} ${'x'.repeat(5000)}</p>`).join('\n');
  const on = Array.from({ length: 2000 }, (_, i) => `<p>${i} ${'y'.repeat(5000)}</p>`).join('\n');
  const summary = describeChange(off, on);
  assert.ok(summary.length < 20000, `summary is ${summary.length} characters`);
  assert.match(summary, /more changed lines/);
});

test('identical pages have no change to describe', () => {
  const raw = page(nonces());
  assert.match(describeChange(raw, raw), /^No line differs/);
});

test('hidden fields, HTML entities, escaped JSON and multiline nonces never reach evidence', () => {
  const value = nonce();
  const forms = [
    `<input type="hidden" name="_wpnonce" value="${value}">`,
    `<input value='${value}' id='_wpnonce' type='hidden'>`,
    `&quot;nonce&quot;:&quot;${value}&quot;`,
    String.raw`\"nonce\":\"${value}\"`,
    `'nonce' => '${value}'`,
    `storeApiNonce:\n  '${value}'`,
  ];
  for (const [index, raw] of forms.entries()) {
    const sanitized = redactNonces(raw);
    const summary = describeChange('', raw);
    assert.ok(!sanitized.includes(value), `form ${index} survived in the page`);
    assert.ok(!summary.includes(value), `form ${index} survived in the summary`);
    assert.equal(artifactScan(`form-${index}`, { 'page.html': sanitized, 'diff.txt': summary }).status, 0);
  }
});

test('unchanged lines inside the changed interval are not reported as changed nonces', () => {
  const summary = describeChange('A\nX\nQ\nB', 'A\nY\nQ\nZ\nB');
  assert.doesNotMatch(summary, /column 0|differs only inside a redacted nonce/);
});

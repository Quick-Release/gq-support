// The installable release ZIP (scripts/ci/release-package.mjs): one `gq-support/` root holding
// exactly the expected runtime files at the requested version, no secrets, and a recorded SHA-256
// and file manifest that installation and publication check before they use the bytes. Each
// negative control breaks one property of a valid candidate and must be rejected.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { crc32 } from 'node:zlib';
import { checkEntries, checkInstalled, checkTree, extract, manifestOf, pack, previousRelease, readZipEntries, verifyDigest } from './release-package.mjs';

const work = mkdtempSync(join(tmpdir(), 'gq-release-package-'));
after(() => rmSync(work, { recursive: true, force: true }));
let serial = 0;
const scratch = (name) => join(work, `${name}-${++serial}`);

const VERSION = '1.2.3';
const validFiles = (version = VERSION) => ({
  'gq-support.php': `<?php\n/**\n * Plugin Name:       GETQUICK Support\n * Version:            ${version}\n * Requires at least:  6.5\n * Requires PHP:       8.0\n * Requires Plugins:   gq-design\n * License:            GPL-2.0-or-later\n * Text Domain:        gq-support\n */\ndefine( 'GQ_SUPPORT_VERSION', '${version}' );\nGQ_Support_Plugin::boot();\n`,
  'uninstall.php': "<?php\nif ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {\n\texit;\n}\n",
  'readme.txt': `=== GETQUICK Support ===\nRequires at least: 6.5\nTested up to: 7.1\nRequires PHP: 8.0\nStable tag: ${version}\nLicense: GPLv2 or later\n`,
  'README.md': '# GETQUICK Support\n',
  'composer.json': JSON.stringify({ name: 'getquick/gq-support', type: 'wordpress-plugin', license: 'GPL-2.0-or-later', require: { php: '>=8.0', 'composer/installers': '^2.0' }, 'require-dev': { 'phpunit/phpunit': '^9.6' }, extra: { 'installer-name': 'gq-support' } }),
  'includes/class-gq-support-plugin.php': '<?php\nfinal class GQ_Support_Plugin { public static function boot(): void { GQ_Support_State::get(); } }\n',
  'includes/class-gq-support-state.php': '<?php\nfinal class GQ_Support_State { public static function get(): array { return array(); } }\n',
  'assets/launcher.js': 'window.gqSupportLauncher = true;\n',
  'assets/launcher.css': '.gq-support-launcher{}\n',
  'assets/dist/index.js': '(()=>{const e=window.wp.element;})();\n',
  'assets/dist/index.css': '.gq-support-app{left:0}\n',
  'assets/dist/index-rtl.css': '.gq-support-app{right:0}\n',
  'assets/dist/index.asset.php': "<?php return array(\n\t'dependencies' => array(\n\t\t'wp-a11y',\n\t\t'wp-api-fetch',\n\t\t'wp-element',\n\t\t'wp-i18n'\n\t),\n\t'version' => 'abc123'\n);\n",
  'languages/gq-support-pt_PT.mo': 'mo',
  'languages/gq-support-pt_PT-gq-support-app.json': '{"locale_data":{}}',
});

function tree(files, root = scratch('tree')) {
  for (const [path, content] of Object.entries(files)) {
    if (content === undefined) continue;
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

/** A stored (uncompressed) ZIP built by hand, so tests can craft entries no zip tool would write. */
function zipOf(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data = '', mode = 0o100644 } of entries) {
    const bytes = Buffer.from(data);
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc32(bytes), 14);
    local.writeUInt32LE(bytes.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // Made by Unix, so the high attribute bits are a file mode.
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(bytes), 16);
    central.writeUInt32LE(bytes.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, bytes);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + bytes.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const candidate = (files = validFiles(), version = VERSION) => pack(tree(files), scratch('out'), { version });
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

test('a valid candidate packs into one gq-support/ root with its SHA-256 and file manifest', () => {
  const { zip, manifest, problems } = candidate();
  assert.deepEqual(problems, []);
  const names = readZipEntries(readFileSync(zip)).map((entry) => entry.name);
  assert.ok(names.every((name) => name.startsWith('gq-support/')));
  assert.ok(names.includes('gq-support/gq-support.php'));
  assert.equal(manifest.version, VERSION);
  assert.equal(manifest.zip.sha256, sha256(zip));
  assert.deepEqual(manifest.files.map((file) => file.path), Object.keys(validFiles()).sort());
  assert.equal(readFileSync(`${zip}.sha256`, 'utf8'), `${manifest.zip.sha256}  gq-support.zip\n`);
});

test('a missing generated asset fails', () => {
  const { problems } = candidate({ ...validFiles(), 'assets/dist/index-rtl.css': undefined });
  assert.match(problems.join('\n'), /assets\/dist\/index-rtl\.css/);
});

test('a missing or empty asset manifest fails, as does one that needs a second React', () => {
  assert.match(candidate({ ...validFiles(), 'assets/dist/index.asset.php': undefined }).problems.join('\n'), /index\.asset\.php/);
  assert.match(candidate({ ...validFiles(), 'assets/dist/index.asset.php': "<?php return array( 'dependencies' => array(), 'version' => 'x' );" }).problems.join('\n'), /wp-element/);
  const jsx = validFiles()['assets/dist/index.asset.php'].replace("'wp-i18n'", "'wp-i18n',\n\t\t'react-jsx-runtime'");
  assert.match(candidate({ ...validFiles(), 'assets/dist/index.asset.php': jsx }).problems.join('\n'), /react-jsx-runtime/);
});

test('a runtime class the package does not ship fails', () => {
  const { problems } = candidate({ ...validFiles(), 'includes/class-gq-support-state.php': undefined });
  assert.match(problems.join('\n'), /GQ_Support_State.*includes\/class-gq-support-state\.php/);
});

test('a translation without its app JSON or compiled MO fails, as does a package without translations', () => {
  assert.match(candidate({ ...validFiles(), 'languages/gq-support-pt_PT.mo': undefined, 'languages/gq-support-pt_PT-gq-support-app.json': undefined }).problems.join('\n'), /no translations/);
  assert.match(candidate({ ...validFiles(), 'languages/gq-support-pt_PT-gq-support-app.json': undefined }).problems.join('\n'), /pt_PT/);
  assert.match(candidate({ ...validFiles(), 'languages/gq-support-pt_PT.mo': undefined }).problems.join('\n'), /pt_PT/);
});

test('every version must match the requested release', () => {
  assert.match(candidate(validFiles(), '1.2.4').problems.join('\n'), /1\.2\.4/);
  const files = validFiles();
  for (const [file, from, to] of [
    ['gq-support.php', `Version:            ${VERSION}`, 'Version:            1.2.2'],
    ['gq-support.php', `'GQ_SUPPORT_VERSION', '${VERSION}'`, "'GQ_SUPPORT_VERSION', '1.2.2'"],
    ['readme.txt', `Stable tag: ${VERSION}`, 'Stable tag: 1.2.2'],
    ['readme.txt', 'Requires PHP: 8.0', 'Requires PHP: 8.1'],
    ['readme.txt', 'Requires at least: 6.5', 'Requires at least: 6.4'],
  ]) {
    const problems = candidate({ ...files, [file]: files[file].replace(from, to) }).problems;
    assert.notDeepEqual(problems, [], `${file}: ${to} must fail`);
  }
});

test('the Composer metadata must stay installable by composer/installers without shipping vendor', () => {
  const composer = JSON.parse(validFiles()['composer.json']);
  for (const broken of [
    { ...composer, type: 'library' },
    { ...composer, extra: {} },
    { ...composer, require: { php: '>=8.0' } },
    { ...composer, require: { ...composer.require, 'guzzlehttp/guzzle': '^7.0' } },
    { ...composer, autoload: { files: ['vendor/autoload.php'] } },
  ]) {
    assert.notDeepEqual(candidate({ ...validFiles(), 'composer.json': JSON.stringify(broken) }).problems, [], JSON.stringify(broken));
  }
  assert.match(candidate({ ...validFiles(), 'vendor/autoload.php': '<?php' }).problems.join('\n'), /vendor\/autoload\.php/);
});

test('development files, sources, source maps and unexpected files fail', () => {
  for (const path of ['tests/integration/run.sh', 'app/src/index.tsx', 'node_modules/react/index.js', 'assets/dist/index.js.map', 'composer.lock', 'phpstan.neon.dist', '.env', '.git/config', 'debug.log', 'includes/helper.php', 'deploy.pem']) {
    assert.match(candidate({ ...validFiles(), [path]: 'x' }).problems.join('\n'), new RegExp(path.replace(/\./g, '\\.')), path);
  }
  const mapped = candidate({ ...validFiles(), 'assets/dist/index.js': 'x();\n//# sourceMappingURL=data:application/json;base64,e30=\n' });
  assert.match(mapped.problems.join('\n'), /source map/);
});

test('a synthetic secret in a shipped file fails the candidate', () => {
  const leak = `<?php\ndefine( 'GQ_SUPPORT_SIGNING_KEY', '${randomBytes(64).toString('base64')}' );\nfinal class GQ_Support_State {}\n`;
  const { problems } = candidate({ ...validFiles(), 'includes/class-gq-support-state.php': leak });
  assert.match(problems.join('\n'), /secret scan: gq-support-signing-key in includes\/class-gq-support-state\.php/);
});

test('a ZIP must have exactly one gq-support/ root with no traversal, absolute path or link', () => {
  const ok = [{ name: 'gq-support/' , mode: 0o40755 }, { name: 'gq-support/gq-support.php', data: '<?php' }];
  assert.deepEqual(checkEntries(readZipEntries(zipOf(ok))), []);
  const cases = {
    'wrong root': [{ name: 'gq-support-1.2.3/gq-support.php' }],
    'second root': [...ok, { name: 'other/readme.txt' }],
    'files at the top level': [{ name: 'gq-support.php' }],
    traversal: [...ok, { name: 'gq-support/../../wp-config.php' }],
    'absolute path': [...ok, { name: '/etc/cron.d/gq' }],
    'Windows path': [...ok, { name: 'gq-support\\..\\evil.php' }],
    symlink: [...ok, { name: 'gq-support/includes', data: '/etc', mode: 0o120777 }],
    duplicate: [...ok, { name: 'gq-support/gq-support.php', data: '<?php evil();' }],
  };
  for (const [name, entries] of Object.entries(cases)) {
    assert.notDeepEqual(checkEntries(readZipEntries(zipOf(entries))), [], name);
  }
});

test('a wrong root fails verification before anything is extracted', () => {
  const dir = scratch('wrong-root');
  mkdirSync(dir);
  const zip = join(dir, 'gq-support.zip');
  writeFileSync(zip, zipOf(Object.entries(validFiles()).map(([name, data]) => ({ name: `gq-support-${VERSION}/${name}`, data }))));
  assert.throws(() => extract(zip, scratch('dest')), /gq-support\//);
});

test('an unpacked tree can be checked without packing it', () => {
  assert.deepEqual(checkTree(tree(validFiles()), { version: VERSION }), []);
  assert.match(checkTree(tree({ ...validFiles(), 'assets/launcher.js': undefined }), { version: VERSION }).join('\n'), /assets\/launcher\.js: missing/);
});

test('promotion refuses bytes that differ from the recorded digest or manifest', () => {
  const { zip } = candidate();
  const dir = dirname(zip);
  assert.deepEqual(verifyDigest(dir), []);

  const manifest = JSON.parse(readFileSync(join(dir, 'gq-support.manifest.json'), 'utf8'));
  writeFileSync(join(dir, 'gq-support.manifest.json'), JSON.stringify({ ...manifest, zip: { ...manifest.zip, sha256: '0'.repeat(64) } }));
  assert.match(verifyDigest(dir).join('\n'), /SHA-256/);
  writeFileSync(join(dir, 'gq-support.manifest.json'), JSON.stringify(manifest));

  writeFileSync(zip, Buffer.concat([readFileSync(zip), Buffer.from('tamper')]));
  assert.match(verifyDigest(dir).join('\n'), /SHA-256/);

  rmSync(join(dir, 'gq-support.manifest.json'));
  assert.match(verifyDigest(dir).join('\n'), /manifest/);
});

test('promotion extracts exactly the manifest\'s files', () => {
  const { zip, manifest } = candidate();
  const dest = scratch('promoted');
  extract(zip, dest);
  assert.deepEqual(checkInstalled(manifest, dest), []);
  assert.ok(!existsSync(join(dest, 'gq-support')), 'the archive root is stripped');
});

test('an installed copy must be the extracted archive itself, file for file', () => {
  const { zip, manifest } = candidate();
  const installed = scratch('installed');
  extract(zip, installed);
  assert.deepEqual(checkInstalled(manifest, installed), []);

  writeFileSync(join(installed, 'includes', 'class-gq-support-state.php'), '<?php // edited');
  writeFileSync(join(installed, 'extra.php'), '<?php');
  rmSync(join(installed, 'assets', 'launcher.css'));
  const problems = checkInstalled(manifest, installed).join('\n');
  assert.match(problems, /class-gq-support-state\.php/);
  assert.match(problems, /extra\.php/);
  assert.match(problems, /launcher\.css/);

  const link = scratch('symlinked');
  symlinkSync(installed, link);
  assert.match(checkInstalled(manifest, link).join('\n'), /symlink/);
});

test('a manifest describes a ZIP without trusting a separate tree', () => {
  const { zip, manifest } = candidate();
  assert.deepEqual(manifestOf(zip, VERSION), manifest);
});

test('the previous release is the highest earlier v-tag', () => {
  const tags = ['v0.0.1', 'v0.1.2', 'v0.1.9', 'v0.1.10', 'v0.1.11', 'plugin-v0.1.10', 'v0.2.0-rc.1', 'nonsense'];
  assert.equal(previousRelease(tags, '0.1.11'), 'v0.1.10');
  assert.equal(previousRelease(tags, '0.1.10'), 'v0.1.9');
  assert.equal(previousRelease(tags, '0.2.0'), 'v0.1.11');
  assert.equal(previousRelease(tags, '0.0.1'), null);
});

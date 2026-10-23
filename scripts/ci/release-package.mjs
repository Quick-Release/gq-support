#!/usr/bin/env node
// The installable release ZIP: built once from the assembled package tree, verified, recorded by
// SHA-256 and file manifest, then installed and promoted as those same bytes (release-plugin.yml).
//   node scripts/ci/release-package.mjs pack package-dist package-zip [--version 0.1.10]
//       ZIP the tree under one gq-support/ root, verify it, write gq-support.zip, its .sha256 and
//       gq-support.manifest.json. --version defaults to the tree's plugin header.
//   node scripts/ci/release-package.mjs verify package-zip
//       Check a downloaded candidate against its recorded digest, then verify it again.
//   node scripts/ci/release-package.mjs installed package-zip .test-site/wp-content/plugins/gq-support
//       Prove an installed plugin is the extracted archive, file for file, not a source symlink.
//   node scripts/ci/release-package.mjs extract package-zip package-dist
//       Unpack the digest-verified archive for publication.
//   node scripts/ci/release-package.mjs previous 0.1.10
//       Print the previous release's tag (the highest earlier vX.Y.Z), or nothing on a first release.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dirname, '..', '..');
const SLUG = 'gq-support';
const ZIP = `${SLUG}.zip`;
const MANIFEST = `${SLUG}.manifest.json`;

// Every file the package may ship (scripts/assemble-plugin-package.sh copies exactly these).
const ALLOWED = [
  /^gq-support\.php$/,
  /^uninstall\.php$/,
  /^readme\.txt$/,
  /^README\.md$/,
  // Composer distribution metadata: the composer branch is installed with composer/installers.
  /^composer\.json$/,
  /^includes\/class-gq-support-[a-z-]+\.php$/,
  /^assets\/launcher\.(?:js|css)$/,
  /^assets\/dist\/(?:index\.js|index\.css|index-rtl\.css|index\.asset\.php)$/,
  /^languages\/gq-support-[A-Za-z_]+\.mo$/,
  /^languages\/gq-support-[A-Za-z_]+-gq-support-app\.json$/,
];
// Files a package must never ship, with the reason; checked before the allowlist for a clearer message.
const DENIED = [
  [/(?:^|\/)(?:tests?|app|src|node_modules|vendor|\.git|\.github)\//, 'development or source directory'],
  [/\.map$/, 'source map'],
  [/(?:^|\/)\.env|\.(?:pem|key|p12|pfx)$|(?:^|\/)id_(?:rsa|ecdsa|ed25519)/, 'credential file'],
  [/\.log$/, 'log file'],
  [/(?:^|\/)(?:composer\.lock|package\.json|pnpm-lock\.yaml|tsconfig\.json|phpstan[^/]*|\.phpcs[^/]*|phpunit[^/]*)$/, 'development tooling'],
];
const REQUIRED = [
  'gq-support.php', 'uninstall.php', 'readme.txt', 'composer.json',
  'assets/launcher.js', 'assets/launcher.css',
  'assets/dist/index.js', 'assets/dist/index.css', 'assets/dist/index-rtl.css', 'assets/dist/index.asset.php',
];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Relative paths of every file under `dir`; symlinks are reported, never followed. */
function walk(dir, problems = [], prefix = '') {
  const files = [];
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) problems.push(`${path}: symlink`);
    else if (entry.isDirectory()) files.push(...walk(dir, problems, path));
    else files.push(path);
  }
  return files.sort();
}

/** The central directory of a ZIP: each entry's name, Unix mode (when recorded) and kind. */
export function readZipEntries(buffer) {
  let end = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 0xffff); at--) {
    if (buffer.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new Error('not a ZIP archive: no end of central directory');
  const count = buffer.readUInt16LE(end + 10);
  if (count === 0xffff) throw new Error('ZIP64 archives are not supported');
  const entries = [];
  let at = buffer.readUInt32LE(end + 16);
  for (let index = 0; index < count; index++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('corrupt ZIP central directory');
    const unix = buffer.readUInt8(at + 5) === 3;
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const mode = unix ? buffer.readUInt32LE(at + 38) >>> 16 : 0;
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    entries.push({ name, mode, isSymlink: (mode & 0o170000) === 0o120000, isDirectory: name.endsWith('/') });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** Problems with an archive's structure: exactly one gq-support/ root, plain relative entries only. */
export function checkEntries(entries) {
  const problems = [];
  const seen = new Set();
  if (entries.length === 0) problems.push('the archive is empty');
  for (const { name, isSymlink } of entries) {
    const segments = name.replace(/\/$/, '').split('/');
    if (name.includes('\\')) problems.push(`${name}: backslash in an entry name`);
    else if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) problems.push(`${name}: absolute path`);
    else if (segments.some((segment) => segment === '..' || segment === '.' || segment === '')) problems.push(`${name}: path traversal`);
    else if (segments[0] !== SLUG || (segments.length === 1 && !name.endsWith('/'))) problems.push(`${name}: outside the single ${SLUG}/ root`);
    if (isSymlink) problems.push(`${name}: symlink`);
    if (seen.has(name)) problems.push(`${name}: duplicate entry`);
    seen.add(name);
  }
  return problems;
}

const header = (php, field) => php.match(new RegExp(`^\\s*\\*\\s*${field}:\\s*(.+?)\\s*$`, 'm'))?.[1];
const readmeField = (readme, field) => readme.match(new RegExp(`^${field}:\\s*(.+?)\\s*$`, 'm'))?.[1];

/** Problems with an unpacked package tree for release `version`; includes a secret scan. */
export function checkTree(dir, { version }) {
  const problems = [];
  const files = walk(dir, problems);
  const has = new Set(files);
  const read = (path) => (has.has(path) ? readFileSync(join(dir, path), 'utf8') : '');

  for (const path of files) {
    const denied = DENIED.find(([pattern]) => pattern.test(path));
    if (denied) problems.push(`${path}: ${denied[1]}`);
    else if (!ALLOWED.some((pattern) => pattern.test(path))) problems.push(`${path}: unexpected file`);
    else if (/\.(?:js|css)$/.test(path) && /sourceMappingURL/.test(read(path))) problems.push(`${path}: references a source map`);
  }
  for (const path of REQUIRED) {
    if (!has.has(path)) problems.push(`${path}: missing`);
    else if (statSync(join(dir, path)).size === 0) problems.push(`${path}: empty`);
  }

  // Versions and declared requirements.
  const php = read('gq-support.php');
  const readme = read('readme.txt');
  const versions = {
    'plugin header Version': header(php, 'Version'),
    'GQ_SUPPORT_VERSION': php.match(/define\(\s*'GQ_SUPPORT_VERSION',\s*'([^']*)'\s*\)/)?.[1],
    'readme.txt Stable tag': readmeField(readme, 'Stable tag'),
  };
  for (const [name, found] of Object.entries(versions)) {
    if (found !== version) problems.push(`${name} is ${found ?? 'missing'}, expected release ${version}`);
  }
  for (const field of ['Requires at least', 'Requires PHP']) {
    const [inHeader, inReadme] = [header(php, field), readmeField(readme, field)];
    if (!inHeader || inHeader !== inReadme) problems.push(`${field}: plugin header ${inHeader ?? 'missing'} and readme.txt ${inReadme ?? 'missing'} disagree`);
  }
  if (header(php, 'Text Domain') !== SLUG) problems.push(`plugin header Text Domain must be ${SLUG}`);
  if (!(header(php, 'Requires Plugins') ?? '').split(/\s*,\s*/).includes('gq-design')) problems.push('plugin header must require gq-design');
  if (!header(php, 'License') || !readmeField(readme, 'License')) problems.push('plugin header and readme.txt must declare a license');

  // The extracted script dependencies are the WordPress runtime contract (ADR 0011).
  const assets = read('assets/dist/index.asset.php');
  const dependencies = [...(assets.match(/'dependencies'\s*=>\s*array\(([^)]*)\)/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((match) => match[1]);
  if (has.has('assets/dist/index.asset.php') && !dependencies.includes('wp-element')) problems.push('assets/dist/index.asset.php: must depend on wp-element, WordPress\'s React');
  if (dependencies.includes('react-jsx-runtime')) problems.push('assets/dist/index.asset.php: depends on react-jsx-runtime, which WordPress 6.5 lacks');
  if (read('assets/dist/index.js').includes('__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED')) problems.push('assets/dist/index.js: bundles its own React');

  // Every runtime class the shipped PHP names must ship, at the path the autoloader loads.
  const classes = new Set(files.filter((path) => path.endsWith('.php')).flatMap((path) => read(path).match(/\bGQ_Support_[A-Z][a-z]\w*/g) ?? []));
  for (const name of classes) {
    const file = `includes/class-${name.toLowerCase().replace(/_/g, '-')}.php`;
    if (!has.has(file)) problems.push(`${name} is used but ${file} is not shipped`);
  }

  // A locale needs its compiled PHP catalogue and the app's script translations.
  const locales = (pattern) => new Set(files.map((path) => path.match(pattern)?.[1]).filter(Boolean));
  const mo = locales(/^languages\/gq-support-([A-Za-z_]+)\.mo$/);
  const json = locales(/^languages\/gq-support-([A-Za-z_]+)-gq-support-app\.json$/);
  // The app and admin screens ship translatable strings, so a package without any locale lost them.
  if (mo.size + json.size === 0) problems.push('languages: no translations shipped');
  for (const locale of new Set([...mo, ...json])) {
    if (!mo.has(locale) || !json.has(locale)) problems.push(`languages: ${locale} needs both gq-support-${locale}.mo and gq-support-${locale}-gq-support-app.json`);
  }

  // composer/installers places the package in wp-content/plugins/gq-support; the package ships no
  // vendor directory and no runtime Composer dependency, so nothing else is installed with it.
  if (has.has('composer.json')) {
    let composer = {};
    try { composer = JSON.parse(read('composer.json')); } catch { problems.push('composer.json: invalid JSON'); }
    if (composer.name !== 'getquick/gq-support') problems.push('composer.json: name must be getquick/gq-support');
    if (composer.type !== 'wordpress-plugin') problems.push('composer.json: type must be wordpress-plugin');
    if (composer.extra?.['installer-name'] !== SLUG) problems.push(`composer.json: extra.installer-name must be ${SLUG}`);
    const runtime = Object.keys(composer.require ?? {});
    if (!runtime.includes('composer/installers')) problems.push('composer.json: must require composer/installers to install as a WordPress plugin');
    for (const name of runtime.filter((name) => !['php', 'composer/installers'].includes(name))) problems.push(`composer.json: unexpected runtime dependency ${name}`);
    if (composer.autoload || composer.files) problems.push('composer.json: the plugin loads its own classes; no Composer autoload');
  }

  problems.push(...secretScan(dir));
  return problems;
}

/** The pinned gitleaks scan (scripts/ci/gitleaks.sh), as problems naming rule and file only. */
function secretScan(dir) {
  const reportDir = mkdtempSync(join(tmpdir(), 'gq-package-scan-'));
  try {
    const report = join(reportDir, 'report.json');
    const result = spawnSync(join(ROOT, 'scripts', 'ci', 'gitleaks.sh'), ['dir', '--report-format', 'json', '--report-path', report, dir], { encoding: 'utf8' });
    if (result.status === 0) return [];
    if (result.status !== 1 || !existsSync(report)) return [`secret scan failed to run: ${result.stderr.trim()}`];
    return JSON.parse(readFileSync(report, 'utf8')).map((finding) => `secret scan: ${finding.RuleID} in ${finding.File.replace(`${dir}/`, '')}`);
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }
}

/** Unpacks `zip`'s gq-support/ root into `dest` (which must not exist); refuses a malformed archive. */
export function extract(zip, dest) {
  const problems = checkEntries(readZipEntries(readFileSync(zip)));
  if (problems.length > 0) throw new Error(`${zip} is not a ${SLUG}/ package:\n${problems.join('\n')}`);
  mkdirSync(dirname(resolve(dest)), { recursive: true });
  const unpack = mkdtempSync(`${resolve(dest)}.unpack-`);
  try {
    execFileSync('unzip', ['-q', resolve(zip), '-d', unpack]);
    renameSync(join(unpack, SLUG), dest);
  } finally {
    rmSync(unpack, { recursive: true, force: true });
  }
  return dest;
}

function filesOf(dir) {
  return walk(dir).map((path) => {
    const bytes = readFileSync(join(dir, path));
    return { path, size: bytes.length, sha256: sha256(bytes) };
  });
}

/** The manifest of a package archive: release version, archive digest and every file's digest. */
export function manifestOf(zip, version, unpacked) {
  const dir = unpacked ?? extract(zip, join(mkdtempSync(join(tmpdir(), 'gq-package-')), SLUG));
  try {
    const bytes = readFileSync(zip);
    return { name: SLUG, version, zip: { file: ZIP, size: bytes.length, sha256: sha256(bytes) }, files: filesOf(dir) };
  } finally {
    if (!unpacked) rmSync(dirname(dir), { recursive: true, force: true });
  }
}

/** Problems with the archive itself: its structure, then its unpacked tree. */
function verifyZip(zip, version) {
  const problems = checkEntries(readZipEntries(readFileSync(zip)));
  if (problems.length > 0) return { problems };
  const dir = extract(zip, join(mkdtempSync(join(tmpdir(), 'gq-package-')), SLUG));
  return { problems: checkTree(dir, { version }), dir };
}

/**
 * ZIPs `tree` under one gq-support/ root into `outDir`, verifies the archive and, when it passes,
 * records its SHA-256 and manifest next to it.
 */
export function pack(tree, outDir, { version }) {
  mkdirSync(outDir, { recursive: true });
  const zip = join(outDir, ZIP);
  rmSync(zip, { force: true });
  const stage = mkdtempSync(join(tmpdir(), 'gq-package-stage-'));
  try {
    cpSync(tree, join(stage, SLUG), { recursive: true, verbatimSymlinks: true });
    // -X: no extra attributes beyond the Unix mode; -y: keep a symlink as a link, so it is refused.
    execFileSync('zip', ['-X', '-r', '-y', '-q', resolve(zip), SLUG], { cwd: stage });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  const { problems, dir } = verifyZip(zip, version);
  try {
    if (problems.length > 0) return { zip, manifest: null, problems };
    const manifest = manifestOf(zip, version, dir);
    writeFileSync(join(outDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(`${zip}.sha256`, `${manifest.zip.sha256}  ${ZIP}\n`);
    return { zip, manifest, problems };
  } finally {
    if (dir) rmSync(dirname(dir), { recursive: true, force: true });
  }
}

/** Problems unless `dir`'s archive is byte for byte the one its manifest and .sha256 recorded. */
export function verifyDigest(dir) {
  const manifestPath = join(dir, MANIFEST);
  const zip = join(dir, ZIP);
  if (!existsSync(manifestPath)) return [`${manifestPath}: the recorded manifest is missing`];
  if (!existsSync(zip)) return [`${zip}: missing`];
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const actual = sha256(readFileSync(zip));
  const problems = [];
  if (manifest.zip?.sha256 !== actual) problems.push(`${ZIP} has SHA-256 ${actual}, but the manifest recorded ${manifest.zip?.sha256}`);
  const recorded = existsSync(`${zip}.sha256`) ? readFileSync(`${zip}.sha256`, 'utf8').split(/\s+/)[0] : undefined;
  if (recorded !== actual) problems.push(`${ZIP} has SHA-256 ${actual}, but ${ZIP}.sha256 recorded ${recorded ?? 'nothing'}`);
  return problems;
}

/** Problems unless `dir` is a real directory holding exactly the manifest's files and bytes. */
export function checkInstalled(manifest, dir) {
  if (lstatSync(dir).isSymbolicLink()) return [`${dir}: a symlink, not the extracted archive`];
  const problems = [];
  const installed = new Map(filesOf(dir).map((file) => [file.path, file]));
  walk(dir, problems);
  for (const { path, sha256: expected } of manifest.files) {
    const file = installed.get(path);
    if (!file) problems.push(`${path}: missing from the installed copy`);
    else if (file.sha256 !== expected) problems.push(`${path}: differs from the archive`);
    installed.delete(path);
  }
  for (const path of installed.keys()) problems.push(`${path}: not in the archive's manifest`);
  return problems;
}

/** The highest vX.Y.Z tag below `version`: the release a candidate upgrades from. */
export function previousRelease(tags, version) {
  const parse = (value) => value.match(/^v?(\d+)\.(\d+)\.(\d+)$/)?.slice(1).map(Number);
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  const target = parse(version.replace(/[-+].*$/, ''));
  if (!target) throw new Error(`invalid release version ${version}`);
  const earlier = tags.map((tag) => ({ tag, parts: parse(tag) })).filter(({ tag, parts }) => tag.startsWith('v') && parts && compare(parts, target) < 0);
  earlier.sort((a, b) => compare(b.parts, a.parts));
  return earlier[0]?.tag ?? null;
}

function fail(problems, title) {
  for (const problem of problems) console.error(`::error title=${title}::${problem}`);
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [command, ...rest] = process.argv.slice(2);
  const option = (name) => { const at = rest.indexOf(name); return at < 0 ? undefined : rest.splice(at, 2)[1]; };
  const manifestIn = (dir) => JSON.parse(readFileSync(join(dir, MANIFEST), 'utf8'));
  switch (command) {
    case 'pack': {
      const version = option('--version');
      const [tree, outDir] = rest;
      const { zip, manifest, problems } = pack(tree, outDir, { version: version ?? header(readFileSync(join(tree, 'gq-support.php'), 'utf8'), 'Version') });
      if (problems.length > 0) fail(problems, 'Release package');
      console.log(`${zip}: ${manifest.version}, ${manifest.files.length} files, SHA-256 ${manifest.zip.sha256}`);
      break;
    }
    case 'verify': {
      const [dir] = rest;
      const digest = verifyDigest(dir);
      if (digest.length > 0) fail(digest, 'Release package digest');
      const manifest = manifestIn(dir);
      const { problems, dir: unpacked } = verifyZip(join(dir, ZIP), manifest.version);
      if (unpacked) {
        problems.push(...checkInstalled(manifest, unpacked));
        rmSync(dirname(unpacked), { recursive: true, force: true });
      }
      if (problems.length > 0) fail(problems, 'Release package');
      console.log(`${join(dir, ZIP)}: verified ${manifest.version}, SHA-256 ${manifest.zip.sha256}`);
      break;
    }
    case 'installed': {
      const [dir, plugin] = rest;
      const problems = checkInstalled(manifestIn(dir), plugin);
      if (problems.length > 0) fail(problems, 'Installed package');
      console.log(`${plugin} is the extracted ${basename(join(dir, ZIP))}, file for file.`);
      break;
    }
    case 'extract': {
      const [dir, dest] = rest;
      const digest = verifyDigest(dir);
      if (digest.length > 0) fail(digest, 'Release package digest');
      extract(join(dir, ZIP), dest);
      const problems = checkInstalled(manifestIn(dir), dest);
      if (problems.length > 0) fail(problems, 'Promoted package');
      console.log(`${dest}: the tested ${ZIP}, SHA-256 ${manifestIn(dir).zip.sha256}`);
      break;
    }
    case 'previous': {
      const tags = execFileSync('git', ['tag', '--list', 'v*'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
      const tag = previousRelease(tags, rest[0]);
      if (tag) console.log(tag);
      break;
    }
    default:
      console.error('usage: release-package.mjs pack <tree> <out-dir> [--version X] | verify <dir> | installed <dir> <plugin-dir> | extract <dir> <dest> | previous <version>');
      process.exit(2);
  }
}

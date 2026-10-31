import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const release = readFileSync(new URL('../../.github/workflows/release-plugin.yml', import.meta.url), 'utf8');
const registry = readFileSync(new URL('../../.github/workflows/dispatch-registry.yml', import.meta.url), 'utf8');
const condition = (text, job) => text.split(`  ${job}:\n`)[1].match(/^ {4}if: (.+)$/m)[1];
const admitted = (expression, event, result = 'success', deleted = false) => runInNewContext(expression, {
  github: { event_name: event, ref_type: event === 'push' ? 'tag' : 'branch', event: { deleted } },
  needs: { publish: { result } },
});

test('manual and tag releases notify the registry only after successful publication', () => {
  for (const event of ['workflow_dispatch', 'push']) {
    assert.equal(admitted(condition(release, 'dispatch-registry'), event), true, event);
    assert.equal(admitted(condition(registry, 'dispatch'), event), true, event);
    for (const result of ['failure', 'cancelled', 'skipped']) {
      assert.equal(admitted(condition(release, 'dispatch-registry'), event, result), false, result);
    }
  }
  assert.equal(admitted(condition(registry, 'dispatch'), 'pull_request'), false);
  assert.equal(admitted(condition(registry, 'dispatch'), 'push', 'success', true), false);
});

test('an operator can rebuild an existing published tag without republishing its package', () => {
  assert.match(registry, /workflow_dispatch:\n {4}inputs:\n {6}ref:/);
  assert.match(registry, /gh release view "\$RELEASE_TAG"/);
});

test('the dispatch shell refuses missing or draft releases before any registry write', () => {
  const dir = mkdtempSync(join(tmpdir(), 'registry-dispatch-'));
  try {
    const marker = join(dir, 'dispatched');
    writeFileSync(join(dir, 'gh'), '#!/bin/sh\nif [ "$1" = release ]; then\n  [ "$GH_TOKEN" = synthetic-source ] || exit 88\n  printf "%s" "$DRAFT"\n  exit "$LOOKUP_EXIT"\nfi\n[ "$GH_TOKEN" = synthetic-registry ] || exit 89\n: > "$MARKER"\n');
    chmodSync(join(dir, 'gh'), 0o755);
    const script = registry.match(/ {8}run: \|\n([\s\S]*)/)[1].replace(/^ {10}/gm, '');
    for (const [draft, lookupExit, expected] of [['true', '0', false], ['', '1', false], ['false', '0', true]]) {
      const result = spawnSync('/bin/bash', ['-c', script], { env: {
        PATH: `${dir}:/usr/bin:/bin`, GH_TOKEN: 'synthetic-registry', PUBLISH_READ_TOKEN: 'synthetic-source', RELEASE_TAG: 'v0.1.11',
        REPOSITORY: 'fixture/support', DRAFT: draft, LOOKUP_EXIT: lookupExit, MARKER: marker,
      } });
      assert.equal(result.status === 0, expected);
      assert.equal(existsSync(marker), expected);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Fail closed on unavailable environment metadata or candidate provenance.
// Environment binding enforces approval; naming an approver is never approval.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ACCOUNT = '8f38791a8c37b182239af2a385ab3c31';
class EvidenceError extends Error {}

export function checkTarget(stage, account) {
  if (!['staging', 'prod'].includes(stage) || account !== ACCOUNT) {
    throw new EvidenceError('Release target must be staging/prod in the Tipme account');
  }
}

export function checkApprovalEnvironment(environment, stage) {
  if (environment?.name !== stage) throw new EvidenceError('Wrong approval environment');
  const rule = environment.protection_rules?.find((rule) => rule.type === 'required_reviewers');
  if (!rule?.reviewers?.length || rule.reviewers.some((entry) =>
    entry.type !== 'User' || !['vvaz', 'gmarques'].includes(entry.reviewer?.login))) {
    throw new EvidenceError('Required environment reviewers must be configured from vvaz/gmarques; release is blocked');
  }
}

export function checkProvenance(provenance, expected) {
  for (const key of ['version', 'commit', 'run', 'zip_sha256']) {
    if (typeof expected[key] !== 'string' || !expected[key] || provenance?.[key] !== expected[key]) {
      throw new EvidenceError(`Candidate provenance mismatch: ${key}`);
    }
  }
  if (!/^[a-f0-9]{40}$/.test(expected.commit) || !/^[a-f0-9]{64}$/.test(expected.zip_sha256)) {
    throw new EvidenceError('Malformed candidate digest or commit');
  }
  for (const [file, digest] of Object.entries(expected.lockfiles)) {
    if (provenance?.lockfiles?.[file] !== digest) throw new EvidenceError('Candidate lockfile mismatch');
  }
}

// No plan text/JSON format is invented here. beta.83's Cloudflare.state() can
// resume bootstrap and read Secrets Store via a temporary edge-preview Worker.
// Until a reviewed non-mutating adapter exists there is no acceptable plan.
export function requireSafePlan(stage, account) {
  checkTarget(stage, account);
  throw new EvidenceError('Apply blocked: no verified non-mutating Alchemy plan adapter for SupportDB AND SupportLedger. Test F remains unverified; see docs/runbooks/release-guards.md');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const [command, stage] = process.argv.slice(2);
    if (command === 'plan') {
      requireSafePlan(stage, process.env.CLOUDFLARE_ACCOUNT_ID);
    } else if (command === 'approval') {
      checkTarget(stage, ACCOUNT);
      // stdout/stderr are captured, never printed: no raw API response in logs.
      const metadata = execFileSync('gh', ['api', `repos/${process.env.GITHUB_REPOSITORY}/environments/${stage}`], { stdio: ['ignore', 'pipe', 'pipe'] });
      checkApprovalEnvironment(JSON.parse(metadata), stage);
      console.log('Required environment reviewer configuration present; the environment-bound job still requires its own approval.');
    } else if (command === 'candidate') {
      const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
      checkProvenance(JSON.parse(readFileSync('package-zip/provenance.json', 'utf8')), {
        version: process.env.VERSION, commit: process.env.GITHUB_SHA,
        run: process.env.GITHUB_RUN_ID, zip_sha256: process.env.SHA256,
        lockfiles: Object.fromEntries(['pnpm-lock.yaml', 'plugin/composer.lock'].map((file) => [file, digest(file)])),
      });
      console.log('Candidate provenance matches this source, run, digest and lockfiles.');
    } else {
      throw new EvidenceError('Unknown release evidence check');
    }
  } catch (error) {
    // Child-process failures can contain raw API output; report only our errors.
    console.error(error instanceof EvidenceError ? error.message : 'Release evidence unavailable or malformed; release blocked');
    process.exitCode = 1;
  }
}

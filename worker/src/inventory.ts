import { stageForSlug, type DeployedStage, type RepositoryMapping } from "./repository-mappings.ts";
import type { QueryDatabase } from "./storage.ts";
import { releaseSummary, type ReleaseEnforcement } from "./release-policy.ts";

/**
 * Reviewed, non-secret references for one deployed stage: the Cloudflare account
 * and resources it runs on. Values are added by reviewed PR; a reference that is
 * not known is left out rather than guessed.
 */
export interface StageInventory {
  readonly stage: DeployedStage;
  readonly account: { readonly name: string; readonly id: string };
  /** Alchemy `stack/stage/logical ID` references; IDs come from Alchemy state, not this file. */
  readonly resources: readonly { readonly kind: "worker" | "d1"; readonly reference: string }[];
  readonly credentials: readonly CredentialCustody[];
}

/**
 * Custody of one stage credential, never its value (docs/runbooks/github-app-key-custody.md).
 * `null` means not yet reviewed and shows as unknown. Locations, the revocation
 * procedure and rotation evidence are restricted to the Operator CLI.
 */
export interface CredentialCustody {
  readonly id: string;
  readonly purpose: string;
  /** The reviewed owning role or person. */
  readonly owner: string | null;
  /** An ISO UTC date or time from which it no longer works, or `never` for a credential without expiry. */
  readonly expires: string | null;
  /** Where the value is held: secret names and stores, never values. */
  readonly locations: readonly string[];
  /** The runbook that revokes or rotates it. */
  readonly revocation: string;
  /** The last verified rotation, as an ISO UTC date or time and a link to its evidence. */
  readonly rotated: { readonly at: string; readonly evidence: string } | null;
}

const expiry = (expires: string | null, now: number) => expires === null ? { state: "unknown", expires_at: null }
  : expires === "never" ? { state: "never", expires_at: null }
  : { state: now >= Date.parse(expires) ? "expired" : "valid", expires_at: expires };

/** Credential custody for the stage; `restricted` adds what only the Operator CLI shows. */
export const credentialCustody = (inventory: StageInventory | null, now: number, { restricted = false } = {}) =>
  (inventory?.credentials ?? []).map((credential) => ({
    id: credential.id, purpose: credential.purpose, owner: credential.owner, stage: inventory!.stage,
    expiry: expiry(credential.expires, now), rotated_at: credential.rotated?.at ?? null,
    ...(restricted ? { locations: credential.locations, revocation: credential.revocation,
      rotation_evidence: credential.rotated?.evidence ?? null } : {}),
  }));

const ACCOUNT = { name: "Tipme", id: "8f38791a8c37b182239af2a385ab3c31" } as const;
const resources = (stage: DeployedStage) => (["Worker", "SupportDB", "SupportLedger"] as const).map((id) =>
  ({ kind: id === "Worker" ? "worker" as const : "d1" as const, reference: `GQSupportWorker/${stage}/${id}` }));
const discord = (stage: DeployedStage, view: "SUPPORT_REQUESTS" | "OPERATIONAL_INCIDENTS"): CredentialCustody => ({
  id: `discord-${view.toLowerCase().replaceAll("_", "-")}-webhook`, purpose: `Discord ${view === "SUPPORT_REQUESTS" ? "Support request" : "Operational incident"} notifications`,
  owner: null, expires: null, rotated: null, revocation: "docs/runbooks/support-operations.md#discord-notification-setup",
  locations: [`GitHub Environment ${stage}: SUPPORT_DISCORD_${view}_WEBHOOK_URL`, `Worker secret DISCORD_${view}_WEBHOOK_URL`],
});
/** Deploy CI's token; whether it is the documented Alchemy token is not recorded, so it is listed separately. */
const deployToken = (stage: DeployedStage): CredentialCustody => ({
  id: "cloudflare-deploy-token", purpose: "Cloudflare deployment from CI", owner: null, expires: null, rotated: null,
  revocation: "worker/README.md#cloudflare-credentials", locations: [`GitHub Environment ${stage}: CLOUDFLARE_API_TOKEN`],
});
const ALCHEMY_TOKEN: CredentialCustody = {
  id: "cloudflare-alchemy-token", purpose: "Cloudflare API token GETQUICK Support Alchemy (48f5559e9daad1e3e324771d3708468f)",
  owner: null, expires: "2027-01-14", rotated: null, revocation: "worker/README.md#cloudflare-credentials",
  locations: ["Sigillo GQ Support project 01M52TXAYNKP6QGHR8PZYYDEY6, environment dev: CLOUDFLARE_API_TOKEN"],
};

/**
 * Reviewed inventory for each deployed stage, from the evidence recorded in the
 * custody runbooks and worker/README.md. Owners are not yet assigned; a rotation
 * is listed only where its evidence was recorded. Update by reviewed PR.
 */
export const stageInventories: Readonly<Record<DeployedStage, StageInventory>> = {
  staging: { stage: "staging", account: ACCOUNT, resources: resources("staging"), credentials: [
    { id: "github-app-private-key", purpose: "GitHub App authentication for delivery and status reads (getquick-support-staging)",
      owner: null, expires: "never", revocation: "docs/runbooks/github-app-key-custody.md#rotation-and-staging-rehearsal",
      locations: ["GitHub Environment staging: SUPPORT_GITHUB_APP_PRIVATE_KEY", "Worker secret GITHUB_APP_PRIVATE_KEY"],
      rotated: { at: "2026-10-17", evidence: "https://github.com/Quick-Release/gq-support/actions/runs/39031967179/attempts/2" } },
    { id: "github-webhook-secret", purpose: "GitHub App webhook signature verification (getquick-support-staging)",
      owner: null, expires: null, revocation: "docs/runbooks/github-webhooks.md#rotation",
      locations: ["GitHub Environment staging: SUPPORT_GITHUB_WEBHOOK_SECRET", "Worker secret GITHUB_WEBHOOK_SECRET", "GitHub App webhook settings"],
      rotated: { at: "2026-10-18", evidence: "https://github.com/Quick-Release/gq-support/actions/runs/39133270727" } },
    discord("staging", "SUPPORT_REQUESTS"), discord("staging", "OPERATIONAL_INCIDENTS"), deployToken("staging"), ALCHEMY_TOKEN,
  ] },
  prod: { stage: "prod", account: ACCOUNT, resources: resources("prod"), credentials: [
    { id: "github-app-private-key", purpose: "GitHub App authentication for delivery and status reads (getquick-support)",
      owner: null, expires: "never", revocation: "docs/runbooks/github-app-key-custody.md#rotation-and-staging-rehearsal",
      locations: ["GitHub Environment prod: SUPPORT_GITHUB_APP_PRIVATE_KEY", "Worker secret GITHUB_APP_PRIVATE_KEY"], rotated: null },
    { id: "github-webhook-secret", purpose: "GitHub App webhook signature verification (getquick-support)",
      owner: null, expires: null, revocation: "docs/runbooks/github-webhooks.md#rotation", rotated: null,
      locations: ["GitHub Environment prod: SUPPORT_GITHUB_WEBHOOK_SECRET", "Worker secret GITHUB_WEBHOOK_SECRET", "GitHub App webhook settings",
        "Sigillo GQ Support project 01M52TXAYNKP6QGHR8PZYYDEY6, environment prod: SUPPORT_GITHUB_WEBHOOK_SECRET"] },
    discord("prod", "SUPPORT_REQUESTS"), discord("prod", "OPERATIONAL_INCIDENTS"), deployToken("prod"), ALCHEMY_TOKEN,
  ] },
};

/** The reviewed inventory for the Worker's own stage; any other slug, including none, has none. */
export const inventoryForSlug = (slug: string): StageInventory | null => {
  const stage = stageForSlug(slug);
  return stage ? stageInventories[stage] : null;
};

/**
 * Display rule, not a service objective: an observation older than the 24-hour
 * previous-release compatibility window cannot say whether the installation is
 * still within it, so it shows as unknown. Its last value stays visible.
 */
export const OBSERVATION_STALE_MS = 24 * 3_600_000;

interface Evidence { slot: string; kind: string; version: string; observed_at: number; source: string }

const observation = (evidence: Evidence | undefined, now: number) => evidence
  ? { state: now - evidence.observed_at > OBSERVATION_STALE_MS ? "unknown" : "current",
    reason: now - evidence.observed_at > OBSERVATION_STALE_MS ? "stale" : null,
    version: evidence.version, observed_at: new Date(evidence.observed_at).toISOString(), source: evidence.source }
  : { state: "unknown", reason: "absent", version: null, observed_at: null, source: null };

const intent = (evidence: Evidence | undefined) => evidence
  ? { version: evidence.version, at: new Date(evidence.observed_at).toISOString(), source: evidence.source } : null;

/**
 * A dispatched update is confirmed only by a later observation of the attempted
 * version and failed only by a later recorded failure of it, whichever is newer.
 * Anything else, including no news since the attempt, is unconfirmed.
 */
const update = (attempted: Evidence | undefined, observed: Evidence | undefined, failed: Evidence | undefined) => {
  if (!attempted) return { outcome: "none", at: null };
  const of = (evidence: Evidence | undefined) =>
    evidence && evidence.version === attempted.version && evidence.observed_at >= attempted.observed_at ? evidence.observed_at : -1;
  const [confirmed, failure] = [of(observed), of(failed)];
  if (confirmed < 0 && failure < 0) return { outcome: "unconfirmed", at: null };
  // The later of the two is the current outcome.
  return confirmed >= failure ? { outcome: "confirmed", at: new Date(confirmed).toISOString() }
    : { outcome: "failed", at: new Date(failure).toISOString() };
};

interface Contact { slot: string; route: string; evidence: string; verified_at: number; verified_by: string }

/**
 * The per-Slot inventory (docs/support-operations-design.md). The operations API
 * shows staff whether a contact was verified; only the Operator CLI, `restricted`,
 * shows the contact route and its evidence.
 */
export const slotInventory = async (db: QueryDatabase, mappings: readonly RepositoryMapping[], inventory: StageInventory | null,
  now: number, { restricted = false, release }: { restricted?: boolean; release?: ReleaseEnforcement | null } = {}) => {
  const recorded = (await db.prepare(`SELECT slot, kind, version, observed_at, source FROM (SELECT *, ROW_NUMBER()
    OVER (PARTITION BY slot, kind ORDER BY observed_at DESC, rowid DESC) AS position FROM slot_version_evidence) WHERE position = 1`)
    .bind().all<Evidence>()).results;
  // What installations signed (src/installation-api.ts) is observed evidence too; the newest observation wins.
  const signed = (await db.prepare("SELECT slot, 'observed' AS kind, version, observed_at, 'signed-request' AS source FROM slot_signed_version")
    .bind().all<Evidence>()).results;
  const releases = await releaseSummary(db, release);
  const latest = [...recorded, ...signed];
  // The approved release is every Slot's desired version, unless a later Slot-specific record says otherwise.
  // Its dispatch is policy intent: never an attempt or observation of any one installation.
  const approved = releases.approved && { kind: "desired", version: releases.approved.package_version,
    observed_at: Date.parse(releases.approved.approved_at!), source: "release" };
  const contacts = (await db.prepare(`SELECT slot, route, evidence, verified_at, verified_by FROM (SELECT *, ROW_NUMBER()
    OVER (PARTITION BY slot ORDER BY verified_at DESC, rowid DESC) AS position FROM slot_contact_verification) WHERE position = 1`)
    .bind().all<Contact>()).results;
  const contact = (slot: string) => {
    const verified = contacts.find((row) => row.slot === slot);
    if (!verified) return { state: "unverified", verified_at: null };
    const shown = { state: "verified", verified_at: new Date(verified.verified_at).toISOString() };
    return restricted ? { ...shown, route: verified.route, evidence: verified.evidence, verified_by: verified.verified_by } : shown;
  };
  const find = (slot: string, kind: string) => latest.filter((row) => row.slot === slot && row.kind === kind)
    .concat(kind === "desired" && approved ? [{ slot, ...approved }] : [])
    .reduce<Evidence | undefined>((newest, row) => !newest || row.observed_at > newest.observed_at ? row : newest, undefined);
  return {
    stage: inventory && { name: inventory.stage, account: inventory.account, resources: inventory.resources },
    release: releases,
    slots: mappings.map((mapping) => ({
      slot: mapping.slot, client: mapping.client, project: mapping.project, environment: mapping.environment,
      repository: { id: mapping.repositoryId, name: mapping.repository ?? null, app_installation_id: mapping.githubInstallationId ?? null },
      deployment_method: mapping.deployment ?? null, responsible_team: mapping.responsibleTeam ?? null,
      versions: { desired: intent(find(mapping.slot, "desired")), attempted: intent(find(mapping.slot, "attempted")),
        observed: observation(find(mapping.slot, "observed"), now) },
      update: update(find(mapping.slot, "attempted"), find(mapping.slot, "observed"), find(mapping.slot, "failed")),
      contact: contact(mapping.slot),
    })),
    credentials: credentialCustody(inventory, now, { restricted }),
  };
};

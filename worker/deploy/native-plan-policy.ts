import { createHash } from "node:crypto";
import type { Plan } from "alchemy/Plan";
import type { ResourceState } from "alchemy/State/ResourceState";
import { ACCOUNT, DATABASE_ID, checkTarget, requireEvidence, refusal, validateRow, type Target } from "./planning-state.ts";

export interface DatabaseIdentity {
  readonly fqn: "SupportDB" | "SupportLedger";
  readonly instanceId: string;
  readonly databaseId: string;
  readonly databaseName: string;
}
export interface PlanEvidence {
  readonly target: Target;
  readonly resolvedAccount: string;
  // Bound to an independently reviewed live identity contract, never inferred
  // from desired configuration or used as an instruction to adopt a resource.
  readonly databases: readonly DatabaseIdentity[];
  readonly migrationFiles?: Readonly<Record<string, { readonly dir: string; readonly files: Readonly<Record<string, string>> }>>;
  readonly migrationHashes: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

export function validateNativePlan(plan: Plan, evidence: PlanEvidence): void {
  try { checkNativePlan(plan, evidence); } catch { throw refusal(); }
}

function checkNativePlan(plan: Plan, evidence: PlanEvidence): void {
  checkTarget(evidence.target);
  requireEvidence(evidence.resolvedAccount === ACCOUNT && plan.defaultMode === "live" &&
    !plan.selectedFqns && !plan.destroy &&
    Object.keys(plan.deletions).length === 0 && Object.keys(plan.actionDeletions).length === 0);
  // No application actions exist today. New action bodies need their own audit.
  requireEvidence(Object.keys(plan.actions).length === 0);
  for (const [fqn, node] of Object.entries(plan.resources)) {
    requireEvidence(["noop", "update", "create"].includes(node.action) &&
      !node.renamedFrom?.length && !node.adoptionBlocked && !node.drift &&
      (node.mode === undefined || node.mode === "live"));
    if (node.state) validateRow(node.state, fqn);
  }
  requireEvidence(evidence.databases.length === 2 &&
    new Set(evidence.databases.map((db) => db.fqn)).size === 2 &&
    new Set(evidence.databases.map((db) => db.databaseId)).size === 2 &&
    new Set(evidence.databases.map((db) => db.databaseName)).size === 2);
  for (const fqn of ["SupportDB", "SupportLedger"] as const) {
    const identity = evidence.databases.find((db) => db.fqn === fqn);
    const node = plan.resources[fqn];
    requireEvidence(identity && identity.instanceId && DATABASE_ID.test(identity.databaseId) && identity.databaseName && node &&
      ["noop", "update"].includes(node.action) && node.resource.Type === "Cloudflare.D1Database" &&
      node.resource.FQN === fqn && node.resource.LogicalId === fqn && node.mode !== "local" && node.state);
    const state: ResourceState = node.state;
    validateRow(state, fqn);
    requireEvidence(state.instanceId === identity.instanceId &&
      state.resourceType === "Cloudflare.D1Database" && state.logicalId === fqn &&
      (state.providerMode === undefined || state.providerMode === "live") &&
      state.attr?.databaseId === identity.databaseId && state.attr?.databaseName === identity.databaseName &&
      state.attr?.accountId === ACCOUNT && state.attr?.jurisdiction === "eu" &&
      state.props?.jurisdiction === "eu" && state.removalPolicy === "retain");
    const desired = node.action === "noop" ? state.props : node.props;
    requireEvidence(desired && desired.jurisdiction === "eu" &&
      (desired.name === undefined || desired.name === identity.databaseName) &&
      !desired.clone && !desired.importFiles);
    const committed = state.attr?.migrationsHashes;
    requireEvidence(committed && typeof committed === "object" && !Array.isArray(committed));
    const current = evidence.migrationHashes[fqn];
    const input = desired.migrations;
    const files = evidence.migrationFiles?.[fqn];
    if (input !== undefined) {
      // Only the current flat SQL directory contract is supported. Refuse
      // conversions, table switches, imports and unrecognized migration modes.
      requireEvidence(typeof input === "string" && files?.dir === input &&
        state.attr?.migrationsDir === input && state.attr.migrationsTable === "__alchemy_migrations");
      requireEvidence(Object.keys(files.files).length === Object.keys(current ?? {}).length);
      for (const [name, sql] of Object.entries(files.files)) {
        requireEvidence(/^[0-9]+_[A-Za-z0-9_-]+\.sql$/.test(name) &&
          createHash("sha256").update(sql).digest("hex") === current?.[name]);
        if (!(name in committed)) validateAdditiveSql(sql);
      }
    } else {
      requireEvidence(Object.keys(current ?? {}).length === 0);
    }
    requireEvidence(current);
    for (const [file, hash] of Object.entries(committed)) {
      requireEvidence(typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash) && current[file] === hash);
    }
  }
  // D1 rows at any other FQN (including retained previous names) are forbidden.
  requireEvidence(Object.entries(plan.resources).every(([fqn, node]) =>
    node.resource.Type !== "Cloudflare.D1Database" || fqn === "SupportDB" || fqn === "SupportLedger"));
}

// Deliberately narrow additive subset. This is not a general SQL parser; new
// migration forms need review rather than broadening a denylist at runtime.
export function validateAdditiveSql(sql: string) {
  requireEvidence(typeof sql === "string");
  const clean = sql.replace(/--[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  requireEvidence(!/['"`[\]]/.test(clean));
  const statements = clean.split(";").map((s) => s.trim()).filter(Boolean);
  requireEvidence(statements.length > 0);
  for (const statement of statements) {
    requireEvidence(!/\b(drop|delete|update|insert|replace|select|pragma|attach|detach|vacuum|trigger|rename|begin|commit|rollback)\b/i.test(statement));
    requireEvidence(
      /^CREATE TABLE (?:IF NOT EXISTS )?[A-Za-z_][A-Za-z0-9_]*\s*\([\s\S]+\)$/i.test(statement) ||
      /^CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?[A-Za-z_][A-Za-z0-9_]* ON [A-Za-z_][A-Za-z0-9_]*\s*\([A-Za-z0-9_, ]+\)$/i.test(statement) ||
      /^ALTER TABLE [A-Za-z_][A-Za-z0-9_]* ADD COLUMN [A-Za-z_][A-Za-z0-9_]* (?:TEXT|INTEGER|REAL|BLOB|NUMERIC)(?: NOT NULL)?(?: DEFAULT (?:NULL|[0-9]+))?$/i.test(statement),
    );
  }
}

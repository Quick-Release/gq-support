// Trusted exact-request profile for the installed beta.83 flat SQLite pipeline.
// No conversion/bootstrap/recovery or generic SQL forwarding is authorized.
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ResourceState } from "alchemy/State/ResourceState";
import type { DatabaseIdentity } from "./native-plan-policy.ts";
import { validateAdditiveSql } from "./additive-sql.ts";
import { requireEvidence, ACCOUNT, validateRow } from "./planning-state.ts";

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
export const nativeColumnsSql = 'PRAGMA table_info("__alchemy_migrations");';
export const nativeHistorySql = 'SELECT name, hash FROM "__alchemy_migrations";';
export interface D1MigrationGrant {
  readonly identity: DatabaseIdentity;
  readonly initial: ResourceState;
  readonly files: Readonly<Record<string, string>>;
  readonly hashes: Readonly<Record<string, string>>;
  readonly pending: readonly string[];
  readonly batches: readonly string[];
}
export function d1MigrationGrant(identity: DatabaseIdentity, initial: ResourceState, files: Readonly<Record<string, string>>): D1MigrationGrant | undefined {
  validateRow(initial, identity.fqn);
  requireEvidence(initial.resourceType === "Cloudflare.D1Database" && initial.instanceId === identity.instanceId &&
    initial.logicalId === identity.fqn && initial.removalPolicy === "retain" && initial.attr?.databaseId === identity.databaseId &&
    initial.attr.databaseName === identity.databaseName && initial.attr.accountId === ACCOUNT && initial.attr.jurisdiction === "eu" &&
    initial.props?.jurisdiction === "eu" && typeof initial.props.migrations === "string" && initial.attr.migrationsDir === initial.props.migrations &&
    initial.attr.migrationsTable === "__alchemy_migrations" &&
    Object.keys(initial.attr).every((key) => ["databaseId", "databaseName", "accountId", "jurisdiction", "readReplication", "migrationsDir", "migrationsTable", "migrationsHashes", "importHashes"].includes(key)) &&
    Object.keys(initial.props).every((key) => ["jurisdiction", "migrations", "name"].includes(key)) &&
    (initial.props.name === undefined || initial.props.name === identity.databaseName) &&
    initial.attr.readReplication === undefined && Object.keys(initial.attr.importHashes ?? {}).length === 0);
  const committed = initial.attr.migrationsHashes as Record<string, string>;
  requireEvidence(committed && typeof committed === "object" && !Array.isArray(committed));
  const names = Object.keys(files).sort((a, b) => Number(a.split("_")[0]) - Number(b.split("_")[0]) || a.localeCompare(b));
  requireEvidence(names.length <= 128 && names.every((name) => /^[0-9]{4}_[A-Za-z0-9_-]+\.sql$/.test(name)) &&
    new Set(names.map((name) => name.slice(0, 4))).size === names.length);
  const hashes = Object.fromEntries(names.map((name) => [name, sha256(files[name])]));
  requireEvidence(Object.entries(committed).every(([name, hash]) => /^[a-f0-9]{64}$/.test(hash) && hashes[name] === hash) &&
    names.slice(0, Object.keys(committed).length).every((name) => Object.hasOwn(committed, name)));
  const pending = names.filter((name) => !Object.hasOwn(committed, name));
  if (!pending.length) return undefined;
  requireEvidence(pending.length <= 4);
  const batches = pending.map((name) => {
    validateAdditiveSql(files[name]);
    // Native splitSqlStatements changes statement-breakpoint markers. Those
    // are forbidden by the grammar, so a flat file is exactly one native chunk.
    const sql = files[name].trim();
    return `${sql.endsWith(";") ? sql : sql + ";"}\nINSERT INTO "__alchemy_migrations" (hash, created_at, name, applied_at) VALUES ('${hashes[name]}', NULL, '${name}', datetime('now'));`;
  });
  return structuredClone({ identity, initial, files, hashes, pending, batches });
}
export function migrationSummary(grants: readonly D1MigrationGrant[]) {
  return Object.fromEntries(grants.map((grant) => [grant.identity.fqn, { count: grant.pending.length,
    digest: sha256(JSON.stringify({ identity: grant.identity, history: grant.initial.attr?.migrationsHashes,
      files: grant.pending.map((name) => [name, grant.hashes[name]]) })) }]));
}

export function d1MigrationSession(grant: D1MigrationGrant) {
  // Each boundary is consumed BEFORE awaiting I/O. The outer broker poisons
  // all grants on any failure, including an uncertain successful remote write.
  let phase = 0;
  const base = `/client/v4/accounts/${ACCOUNT}/d1/database/${grant.identity.databaseId}`;
  const same = (a: unknown, b: unknown) => requireEvidence(isDeepStrictEqual(a, b));
  return {
    base,
    settled: () => phase === 5 + grant.batches.length,
    state(value: unknown) {
      const row = value as ResourceState & { old?: ResourceState; adopting?: boolean };
      requireEvidence(row && row.fqn === grant.identity.fqn && row.instanceId === grant.identity.instanceId &&
        row.resourceType === "Cloudflare.D1Database" && row.logicalId === grant.identity.fqn && row.providerVersion === 0 &&
        (row.providerMode === undefined || row.providerMode === "live") && row.removalPolicy === "retain" && !("adopting" in row));
      same(row.props, grant.initial.props); same(row.bindings, grant.initial.bindings); same(row.downstream, grant.initial.downstream);
      requireEvidence(Object.keys(row).every((key) => ["status", "fqn", "logicalId", "instanceId", "resourceType", "props", "attr", "providerVersion", "bindings", "downstream", "old", "adopting", "removalPolicy", "providerMode"].includes(key)));
      if (phase === 0) {
        requireEvidence(row.status === "updating"); same(row.old, grant.initial); same(row.attr, grant.initial.attr); phase = 1;
      } else {
        requireEvidence(phase === 4 + grant.batches.length && row.status === "updated" && !("old" in row));
        const expected = { databaseId: grant.identity.databaseId, databaseName: grant.identity.databaseName, jurisdiction: "eu", accountId: ACCOUNT,
          migrationsDir: grant.initial.attr?.migrationsDir, migrationsTable: "__alchemy_migrations", migrationsHashes: grant.hashes, importHashes: {} };
        // JSON wire omits the provider's readReplication: undefined.
        same(row.attr, expected); phase++;
      }
    },
    request(path: string, method: string, body: Buffer, contentType: string) {
      requireEvidence(phase >= 1 && phase < 4 + grant.batches.length);
      if (phase === 1) {
        requireEvidence(path === base && method === "GET" && body.length === 0); phase++;
        return (response: Record<string, unknown>) => {
          requireEvidence(response.errors === undefined || (Array.isArray(response.errors) && response.errors.length === 0));
          const db = response.result as { uuid?: string; name?: string; jurisdiction?: string; read_replication?: { mode: string } };
          requireEvidence(db && db.uuid === grant.identity.databaseId && db.name === grant.identity.databaseName &&
            (db.jurisdiction === undefined || db.jurisdiction === "eu") &&
            (db.read_replication === undefined || db.read_replication?.mode === "disabled"));
          // No metadata or other response fields cross into the child.
          return { success: true, result: { uuid: db.uuid, name: db.name, read_replication: { mode: "disabled" } } };
        };
      }
      requireEvidence(path === base + "/query" && method === "POST" && contentType === "application/json");
      const query = JSON.parse(body.toString());
      requireEvidence(Object.keys(query).join() === "sql");
      const expected = phase === 2 ? nativeColumnsSql : phase === 3 ? nativeHistorySql : grant.batches[phase - 4];
      requireEvidence(query.sql === expected && expected !== undefined && body.toString() === JSON.stringify({ sql: expected })); const step = phase++;
      return (response: Record<string, unknown>) => {
        requireEvidence(response.errors === undefined || (Array.isArray(response.errors) && response.errors.length === 0));
        const results = response.result as { success: boolean; results: Record<string, unknown>[] }[];
        requireEvidence(Array.isArray(results) && results.length > 0 && results.every((r) => r.success === true));
        if (step < 4) requireEvidence(results.length === 1);
        if (step === 2) {
          const columns = results[0].results;
          requireEvidence(Array.isArray(columns) && columns.length === 5);
          same(columns.map(({ name, type }) => [name, String(type).toUpperCase()]), [["id", "INTEGER"], ["hash", "TEXT"], ["created_at", "NUMERIC"], ["name", "TEXT"], ["applied_at", "TEXT"]]);
        } else if (step === 3) {
          const rows = results[0].results;
          requireEvidence(Array.isArray(rows) && rows.length === Object.keys(grant.initial.attr!.migrationsHashes).length &&
            new Set(rows.map((row) => row.name)).size === rows.length && rows.every((row) => typeof row.name === "string" &&
              Object.keys(row).sort().join() === "hash,name" && Object.hasOwn(grant.initial.attr!.migrationsHashes, row.name) &&
              row.hash === grant.initial.attr!.migrationsHashes[row.name]));
        }
        return step < 4 ? { success: true, result: results.map((r) => ({ success: true, results: step === 2 ? r.results.map(({ name, type }) => ({ name, type })) : r.results })) } :
          { success: true, result: results.map(() => ({ success: true, results: [] })) };
      };
    },
  };
}

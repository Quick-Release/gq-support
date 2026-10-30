import type { D1Database } from "@cloudflare/workers-types";
import { mappingFor, type RepositoryMapping } from "./repository-mappings.ts";
import { recoverDelivery } from "./delivery-recovery.ts";
import { runCleanupOperator } from "./cleanup-operator.ts";
import { unsuspendRepository } from "./repository-suspension.ts";
import { sha256 } from "./signature.ts";
import { runStatusOperation } from "./status-operations.ts";
import { runIncidentOperator } from "./incident-operator.ts";
import { runInventoryOperator } from "./inventory-operator.ts";
import type { StageInventory } from "./inventory.ts";
import { imageOf, ledgerStore } from "./ledger.ts";
import type { QueryDatabase } from "./storage.ts";

export type CredentialDatabase = Pick<D1Database, "prepare" | "batch">;
export interface OperatorOptions {
  readonly query: (sql: string, parameters: readonly (string | number)[]) => Promise<Record<string, unknown>[]>;
  readonly recordRevocation: (keyId: string, revokedAt: number) => Promise<void>;
  readonly mappings: readonly RepositoryMapping[];
  readonly now?: number;
  /** The target stage's reviewed inventory references (src/inventory.ts). */
  readonly inventory?: StageInventory;
  /** The suppression ledger database (src/ledger.ts), queried like `query`. */
  readonly ledger?: OperatorOptions["query"];
}

/** A one-statement-at-a-time D1 view of an Operator query function, for shared store code. */
export const asQueryDatabase = (query: OperatorOptions["query"]): QueryDatabase => {
  const prepare = (sql: string) => ({ bind: (...parameters: (string | number)[]) => ({
    all: async () => ({ results: await query(sql, parameters) }),
    first: async (column?: string) => { const [row] = await query(sql, parameters); return row ? (column ? row[column] : row) : null; },
    run: async () => { await query(sql, parameters); return { meta: {} }; },
  }) });
  return { prepare, batch: async (statements: { run: () => Promise<unknown> }[]) => {
    const results = [];
    for (const statement of statements) results.push(await statement.run());
    return results;
  } } as unknown as QueryDatabase;
};

/** 128 random bits, RFC 4648 base32, with no padding. */
const enrollmentCode = (): string => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, encoded = "";
  for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += alphabet[(value >>> bits) & 31];
    }
  }
  if (bits) encoded += alphabet[(value << (5 - bits)) & 31];
  return encoded.match(/.{1,4}/g)!.join("-");
};

/** The operator command boundary; Cloudflare authentication belongs to the CLI adapter. */
export const runOperator = async (args: readonly string[], { query, recordRevocation, mappings, now = Date.now(), ledger, inventory }: OperatorOptions): Promise<string> => {
  if (args[0] === "resume" || args[0] === "reconcile") return recoverDelivery(args, { query, recordRevocation, mappings, now });
  if (args[0] === "unsuspend") return unsuspendRepository(args, { query, recordRevocation, mappings, now, ...(ledger ? { ledger } : {}) });
  if (["erase", "erasure-status", "erasure-close", "restore-recorded", "cleanup-reconcile", "cleanup-exception", "offboard"].includes(args[0] ?? "")) {
    return runCleanupOperator(args, { query, recordRevocation, mappings, now, ...(ledger ? { ledger } : {}) });
  }
  if (args[0]?.startsWith("status-")) return runStatusOperation(args, { query, recordRevocation, mappings, now });
  if (["incidents", "incident", "incident-claim", "notifications", "notification-retry"].includes(args[0] ?? "")) return runIncidentOperator(args, { query, recordRevocation, mappings, now });
  if (args[0]?.startsWith("inventory")) return runInventoryOperator(args, { query, recordRevocation, mappings, now, ...(inventory ? { inventory } : {}) });
  const [command, slot] = args;
  if (args.length !== 2 || !["enroll", "revoke", "status"].includes(command)) {
    throw new Error("Usage: operator <enroll|revoke|status> <slot>; see also resume, reconcile, unsuspend, erase, erasure-status, erasure-close, cleanup-reconcile, cleanup-exception, offboard, status-<health|reconcile|repair>, incidents, incident, incident-claim, notifications, notification-retry and inventory-record");
  }
  const mapping = mappingFor(mappings, slot);
  if (!mapping) throw new Error("Unknown Slot; add its Repository mapping by reviewed PR first.");
  if (command === "enroll") {
    const code = enrollmentCode();
    await query("INSERT INTO enrollment_code (code_hash, slot, expires_at) VALUES (?, ?, ?)",
      [await sha256(code.replaceAll("-", "")), slot, now + 30 * 60_000]);
    return code;
  }
  if (command === "revoke") {
    const keys = await query("SELECT key_id FROM installation_key WHERE slot = ? AND revoked_at IS NULL", [slot]);
    for (const key of keys) {
      if (typeof key.key_id !== "string") throw new Error("Invalid key record");
      // Persist outside D1 before mutation, so a failed write is safe to retry.
      await recordRevocation(key.key_id, now);
      await query("UPDATE installation_key SET revoked_at = ? WHERE slot = ? AND key_id = ? AND revoked_at IS NULL",
        [now, slot, key.key_id]);
      if (ledger) await ledgerStore(asQueryDatabase(ledger)).record([imageOf("revocation", { key_id: key.key_id, revoked_at: now })], now);
    }
    return `Revoked ${slot}`;
  }
  const [key] = await query(`SELECT key_id, installation_id, origin, enrolled_at, revoked_at
    FROM installation_key WHERE slot = ? ORDER BY enrolled_at DESC, rowid DESC LIMIT 1`, [slot]);
  // Per repository, so it covers every Slot mapped to it. Lift it with `unsuspend`.
  const [suspension] = await query(`SELECT suspended_reason AS reason, suspended_at, verified_safe_at FROM repository_state
    WHERE repository_id = ? AND suspended_reason IS NOT NULL`, [mapping.repositoryId]);
  return JSON.stringify({ slot, environment: mapping.environment, key: key ?? null, suspension: suspension ?? null });
};

import { imageOf, ledgerStore } from "./ledger.ts";
import { asQueryDatabase, type OperatorOptions } from "./operator.ts";
import { mappingFor } from "./repository-mappings.ts";
import { updateKeyId } from "./update-access.ts";
import { ledgerOffboarded, NOT_OFFBOARDED } from "./offboarding.ts";

const ACTOR = /^[A-Za-z0-9_-]{1,64}$/;
/** A reference to where the evidence lives, such as a reviewed issue or PR URL; never a credential. */
const EVIDENCE = /^[\x21-\x7e]{1,256}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?Z$/;
/** A raw 32-byte Ed25519 public key, standard base64. */
const PUBLIC_KEY = /^[A-Za-z0-9+/]{43}=$/;
const KEY_ID = /^[a-f0-9]{64}$/;
/** A grant lasts at most this long; renew it by granting the Slot a new key. */
export const MAX_UPDATE_GRANT_MS = 400 * 86_400_000;

const USAGE = "Usage: operator update-access-status <slot>"
  + " | update-access-grant <slot> <update-public-key> <expires-at> <evidence-ref> <opaque-actor>"
  + " | update-access-revoke <slot> <key-id|all> <evidence-ref> <opaque-actor>";

/**
 * The Operator CLI for native update access (src/update-access.ts). Each
 * mutation is one audited append, never edited:
 *
 * - `update-access-grant` grants the update key a native installation generated
 *   (`wp gq-support update-key`) to one reviewed native Slot, until `expires-at`.
 *   The Slot's newest grant supersedes its older keys at once, so rotating is
 *   granting the new key. A key is never granted to a second Slot.
 * - `update-access-revoke` revokes one key, or every key of the Slot, recorded
 *   in the suppression ledger first so that no restore revives it. Offboarding
 *   (#147) revokes `all`.
 * - `update-access-status` shows the Slot's keys and their state; keys are public.
 */
export const runUpdateAccessOperator = async (args: readonly string[], options: OperatorOptions): Promise<string> => {
  const { query, mappings, now = Date.now(), ledger } = options;
  const [command, slot] = args;
  const mapping = slot === undefined ? undefined : mappingFor(mappings, slot);
  if (!["update-access-status", "update-access-grant", "update-access-revoke"].includes(command ?? "")) throw new Error(USAGE);
  if (!mapping) throw new Error("Unknown Slot; add its Repository mapping by reviewed PR first.");
  const keys = async () => (await query(`SELECT g.key_id, g.expires_at, g.granted_by, g.granted_at, g.evidence,
      r.revoked_at, r.revoked_by, NOT EXISTS (SELECT 1 FROM update_access_grant n WHERE n.slot = g.slot AND n.rowid > g.rowid) AS newest
    FROM update_access_grant g LEFT JOIN update_access_revocation r ON r.key_id = g.key_id WHERE g.slot = ? ORDER BY g.rowid DESC`, [slot!]))
    .map((row) => ({ key_id: row.key_id as string,
      state: row.revoked_at !== null ? "revoked" : Number(row.newest) !== 1 ? "superseded" : Number(row.expires_at) <= now ? "expired" : "active",
      expires_at: new Date(Number(row.expires_at)).toISOString(), granted_by: row.granted_by, granted_at: new Date(Number(row.granted_at)).toISOString(),
      evidence: row.evidence, revoked_at: row.revoked_at === null ? null : new Date(Number(row.revoked_at)).toISOString(), revoked_by: row.revoked_by }));

  if (command === "update-access-status" && args.length === 2) {
    return JSON.stringify({ slot, deployment_method: mapping.deployment ?? null, keys: await keys() });
  }
  if (command === "update-access-grant" && args.length === 6) {
    const [, , publicKey, expires, evidence, actor] = args;
    if (!PUBLIC_KEY.test(publicKey!) || !EVIDENCE.test(evidence!) || !ACTOR.test(actor!)) throw new Error(USAGE);
    const expiresAt = ISO.test(expires!) ? Date.parse(expires!) : NaN;
    if (!(expiresAt > now && expiresAt <= now + MAX_UPDATE_GRANT_MS)) {
      throw new Error("The grant's expires-at must be an ISO UTC time after now and within 400 days");
    }
    // The reviewed deployment method decides: central and manual installations get no native update access.
    if (mapping.deployment !== "native") throw new Error("This Slot's reviewed deployment method is not native; set it by reviewed PR first.");
    if (!ledger) throw new Error("Pass --ledger-database-id: a grant checks the suppression ledger's offboardings and revocations, which no restore rewinds.");
    const keyId = await updateKeyId(publicKey!);
    // The ledger's records hold even when a restore dropped the main ones.
    if (await ledgerOffboarded(asQueryDatabase(ledger), slot!)) throw new Error("Refused: this Slot is offboarded; nothing was granted.");
    if ((await ledger("SELECT 1 FROM ledger_entry WHERE kind = 'revocation' AND reference = ? AND payload IS NOT NULL", [keyId])).length > 0) {
      throw new Error("This update key was revoked; generate a new key on the installation.");
    }
    const [existing] = await query(`SELECT g.slot, r.key_id AS revoked FROM update_access_grant g
      LEFT JOIN update_access_revocation r ON r.key_id = g.key_id WHERE g.key_id = ?`, [keyId]);
    if (existing) {
      if (existing.slot !== slot) throw new Error("This update key is granted to another Slot; generate a new key on the installation.");
      if (existing.revoked !== null) throw new Error("This update key was revoked; generate a new key on the installation.");
      const [shown] = (await keys()).filter((key) => key.key_id === keyId);
      return JSON.stringify({ slot, key_id: keyId, state: shown?.state, expires_at: shown?.expires_at });
    }
    const previous = await query(`SELECT g.key_id FROM update_access_grant g WHERE g.slot = ?
      AND NOT EXISTS (SELECT 1 FROM update_access_revocation r WHERE r.key_id = g.key_id)`, [slot!]);
    if (previous.length) {
      // Revocation first: a failed replacement leaves recovery to hosting access,
      // but an older database snapshot can never reactivate a superseded key.
      await runUpdateAccessOperator(["update-access-revoke", slot!, "all", evidence!, actor!], options);
    }
    const [inserted] = await query(`INSERT INTO update_access_grant (key_id, slot, public_key, expires_at, evidence, granted_by, granted_at)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM update_access_grant g WHERE g.slot = ?
        AND NOT EXISTS (SELECT 1 FROM update_access_revocation r WHERE r.key_id = g.key_id)) AND ${NOT_OFFBOARDED("?")}
      ON CONFLICT (key_id) DO NOTHING RETURNING key_id`, [keyId, slot!, publicKey!, expiresAt, evidence!, actor!, now, slot!, slot!, slot!]);
    if (!inserted) {
      const [existing] = await query(`SELECT g.slot, r.key_id AS revoked FROM update_access_grant g
        LEFT JOIN update_access_revocation r ON r.key_id = g.key_id WHERE g.key_id = ?`, [keyId]);
      if (!existing) throw new Error("Update grant lost a concurrent rotation or offboarding; inspect update-access-status before retrying.");
      if (existing?.slot !== slot) throw new Error("This update key is granted to another Slot; generate a new key on the installation.");
      if (existing?.revoked !== null) throw new Error("This update key was revoked; generate a new key on the installation.");
    }
    const [shown] = (await keys()).filter((key) => key.key_id === keyId);
    return JSON.stringify({ slot, key_id: keyId, state: shown?.state, expires_at: shown?.expires_at });
  }
  if (command === "update-access-revoke" && args.length === 5) {
    const [, , target, evidence, actor] = args;
    if (!(target === "all" || KEY_ID.test(target!)) || !EVIDENCE.test(evidence!) || !ACTOR.test(actor!)) throw new Error(USAGE);
    if (!ledger) throw new Error("Pass --ledger-database-id: an update revocation is recorded in the suppression ledger first, so no restore revives it.");
    const targets = (await query(`SELECT g.key_id FROM update_access_grant g WHERE g.slot = ? AND (? = 'all' OR g.key_id = ?)
      AND NOT EXISTS (SELECT 1 FROM update_access_revocation r WHERE r.key_id = g.key_id)`, [slot!, target!, target!]))
      .map((row) => row.key_id as string);
    if (targets.length === 0 && target !== "all") throw new Error("No unrevoked update key with this ID belongs to the Slot; check update-access-status.");
    await ledgerStore(asQueryDatabase(ledger)).record(targets.map((keyId) => imageOf("revocation", { key_id: keyId, revoked_at: now })), now);
    // One statement: every target key of the Slot not yet revoked, with its own audit row.
    const revoked = await query(`INSERT INTO update_access_revocation (key_id, slot, evidence, revoked_by, revoked_at)
      SELECT g.key_id, g.slot, ?, ?, ? FROM update_access_grant g WHERE g.slot = ? AND g.key_id IN (SELECT value FROM json_each(?))
        AND NOT EXISTS (SELECT 1 FROM update_access_revocation r WHERE r.key_id = g.key_id)
      RETURNING key_id`, [evidence!, actor!, now, slot!, JSON.stringify(targets)]);
    return JSON.stringify({ slot, revoked: revoked.map((row) => row.key_id) });
  }
  throw new Error(USAGE);
};

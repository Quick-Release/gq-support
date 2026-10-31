import revocations from "../revocations.json";
import type { CredentialDatabase } from "./operator.ts";
import { mappingFor, type RepositoryMapping } from "./repository-mappings.ts";
import { readBody } from "./request-body.ts";
import { sha256, verifySignature } from "./signature.ts";
import { createStorageFor, type QueryDatabase } from "./storage.ts";
import { CREATE_BODY_BYTES, handleExport, handleSupportRequests } from "./support-requests.ts";
import { handleErasures } from "./erasure-api.ts";
import { imageOf, ledgerStore } from "./ledger.ts";
import type { AuthRejection } from "./operational-metrics.ts";

interface InstallationKey {
  key_id: string;
  slot: string;
  installation_id: string;
  origin: string;
  public_key: string;
  enrolled_at: number;
  revoked_at: number | null;
}
const BODY_BYTES = 8192;
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const revocationRecords: readonly { keyId: string }[] = revocations;
const recordedRevocation = (keyId: string) => revocationRecords.some((record) => record.keyId === keyId);
const invalidCode = () => json({ code: "gq_support_code_not_valid", message: "Enrollment code not valid." }, 400);
export { readBody };

const rejected = () => json({ code: "gq_support_not_configured", message: "Installation rejected." }, 403);
const binding = (key: InstallationKey, mapping: RepositoryMapping) => ({
  key_id: key.key_id, environment: mapping.environment, connected_at: new Date(key.enrolled_at).toISOString(),
});

const PLUGIN_VERSION = /^[0-9][A-Za-z0-9.+_-]{0,63}$/;

const enroll = async (request: Request, body: string, db: CredentialDatabase, mappings: readonly RepositoryMapping[], now: number,
  ledger: QueryDatabase | null): Promise<Response> => {
  let data: Record<string, unknown>;
  try { data = JSON.parse(body); } catch { return invalidCode(); }
  if (!data || typeof data !== "object" || Array.isArray(data)) return invalidCode();
  const { code, installation_id: installationId, origin, public_key: publicKey } = data;
  if (typeof code !== "string" || typeof installationId !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(installationId) ||
    typeof origin !== "string" || origin.length > 2048 || typeof publicKey !== "string" ||
    request.headers.get("GQ-Support-Installation-Id") !== installationId || request.headers.get("GQ-Support-Key-Id")) return invalidCode();
  try {
    const url = new URL(origin);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return invalidCode();
  } catch { return invalidCode(); }
  const normalized = code.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();
  if (!/^[A-Z2-7]{26}$/.test(normalized)) return invalidCode();
  if (!await verifySignature(request, body, publicKey, now)) return invalidCode();
  const hash = await sha256(normalized);
  const enrollment = await db.prepare("SELECT slot FROM enrollment_code WHERE code_hash = ?").bind(hash).first<{ slot: string }>();
  const mapping = enrollment && mappingFor(mappings, enrollment.slot);
  if (!mapping) return invalidCode();
  // No caller-selected Slot, environment, Client or repository can override the code.
  if (Object.keys(data).some((field) => !["code", "installation_id", "origin", "public_key", "wp_environment_type", "plugin_version"].includes(field))) return invalidCode();
  const keyId = crypto.randomUUID();
  await db.batch([
    db.prepare(`UPDATE enrollment_code SET consumed_at = ?, consumed_public_key = ?, consumed_key_id = ?
      WHERE code_hash = ? AND consumed_at IS NULL AND expires_at > ?`).bind(now, publicKey, keyId, hash, now),
    db.prepare(`UPDATE installation_key SET revoked_at = ? WHERE slot = ? AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM enrollment_code WHERE code_hash = ? AND consumed_key_id = ?)`)
      .bind(now, mapping.slot, hash, keyId),
    db.prepare(`INSERT INTO installation_key (key_id, slot, installation_id, origin, public_key, enrolled_at)
      SELECT ?, slot, ?, ?, ?, ? FROM enrollment_code WHERE code_hash = ? AND consumed_key_id = ?`)
      .bind(keyId, installationId, origin, publicKey, now, hash, keyId),
    // The version the installation reports, signed with its new key: inventory evidence, never authority.
    ...(typeof data.plugin_version === "string" && PLUGIN_VERSION.test(data.plugin_version) ? [db.prepare(`INSERT INTO slot_version_evidence
      (slot, kind, version, observed_at, source, recorded_by, recorded_at)
      SELECT slot, 'observed', ?, ?, 'enrollment', ?, ? FROM enrollment_code WHERE code_hash = ? AND consumed_key_id = ?`)
      .bind(data.plugin_version, now, keyId, now, hash, keyId)] : []),
  ]);
  if (ledger) {
    // The keys this enrollment replaced. A lost write here is caught by the next cleanup pass's mirror.
    const replaced = (await db.prepare("SELECT key_id, revoked_at FROM installation_key WHERE slot = ? AND revoked_at = ?")
      .bind(mapping.slot, now).all<{ key_id: string; revoked_at: number }>()).results;
    await ledgerStore(ledger).record(replaced.map((row) => imageOf("revocation", row)), now).catch(() => undefined);
  }
  const key = await db.prepare(`SELECT k.* FROM enrollment_code c JOIN installation_key k ON k.key_id = c.consumed_key_id
    WHERE c.code_hash = ? AND c.consumed_public_key = ? AND k.installation_id = ? AND k.origin = ? AND k.revoked_at IS NULL`)
    .bind(hash, publicKey, installationId, origin).first<InstallationKey>();
  return key && !recordedRevocation(key.key_id) ? json(binding(key, mapping)) : invalidCode();
};

/** What the boundary established about a request, for measurement only: never authority. */
export type Observation = { readonly slot: string } | { readonly rejected: AuthRejection };

export interface InstallationApiOptions {
  /** Told the verified Slot, or why credentials were refused (src/operational-metrics.ts). */
  readonly observe?: (observation: Observation) => void;
  /** The title-digest key for erasures (src/cleanup.ts); without it, redacted titles need review. */
  readonly digestKey?: CryptoKey | null;
  /** The suppression ledger (src/ledger.ts); erasures are recorded there first. */
  readonly ledger?: QueryDatabase | null;
}

/** Public HTTP boundary, shared by the Alchemy adapter and local D1 integration tests. */
export const handleRequest = async (request: Request, db: CredentialDatabase, mappings: readonly RepositoryMapping[],
  options: InstallationApiOptions = {}): Promise<Response> => {
  try {
    const url = new URL(request.url);
    if (url.protocol !== "https:") return rejected();
    const enrollment = request.method === "POST" && url.pathname === "/v1/enroll" && !url.search;
    const installation = ["GET", "DELETE"].includes(request.method) && url.pathname === "/v1/installation" && !url.search;
    const create = request.method === "POST" && url.pathname === "/v1/requests";
    const statusChange = request.method === "POST" && /^\/v1\/requests\/[^/]+\/status$/.test(url.pathname);
    const requests = create || statusChange || (request.method === "GET" && /^\/v1\/requests(?:\/[^/]+)?$/.test(url.pathname));
    const erasures = (request.method === "POST" && url.pathname === "/v1/erasures") ||
      (request.method === "GET" && /^\/v1\/erasures\/[^/]+$/.test(url.pathname));
    const exported = request.method === "GET" && url.pathname === "/v1/export";
    if (!enrollment && !installation && !requests && !erasures && !exported) return json({ code: "not_found" }, 404);
    const now = Date.now();
    if (enrollment) {
      // Cloudflare overwrites this header at the edge; never use X-Forwarded-For.
      const ip = request.headers.get("CF-Connecting-IP");
      if (!ip || ip.length > 64) return rejected();
      const windowStart = Math.floor(now / 600_000) * 600_000;
      const rate = await db.prepare(`INSERT INTO enrollment_rate (ip_hash, window_start, attempts) VALUES (?, ?, 1)
        ON CONFLICT (ip_hash) DO UPDATE SET
          attempts = CASE WHEN window_start < excluded.window_start THEN 1 ELSE attempts + 1 END,
          window_start = excluded.window_start RETURNING attempts`)
        .bind(await sha256(ip), windowStart).first<{ attempts: number }>();
      if (!rate || rate.attempts > 10) {
        options.observe?.({ rejected: "enrollment_rate_limited" });
        return json({ code: "gq_support_rate_limited" }, 429);
      }
    }
    // Bound cleanup work, even after a long quiet period.
    await db.batch([
      db.prepare("DELETE FROM replay WHERE rowid IN (SELECT rowid FROM replay WHERE expires_at < ? LIMIT 100)").bind(now),
      db.prepare("DELETE FROM enrollment_rate WHERE rowid IN (SELECT rowid FROM enrollment_rate WHERE window_start < ? LIMIT 100)")
        .bind(now - 600_000),
    ]);
    const body = await readBody(request, create ? CREATE_BODY_BYTES : BODY_BYTES);
    if (body === null) return json({ code: "request_too_large" }, 413);
    if (enrollment) {
      const enrolled = await enroll(request, body, db, mappings, now, options.ledger ?? null);
      if (enrolled.status !== 200) options.observe?.({ rejected: "enrollment_rejected" });
      return enrolled;
    }
    const keyId = request.headers.get("GQ-Support-Key-Id");
    const key = await db.prepare("SELECT * FROM installation_key WHERE key_id = ? AND revoked_at IS NULL")
      .bind(keyId ?? "").first<InstallationKey>();
    const mapping = key && mappingFor(mappings, key.slot);
    if (!key || !mapping || recordedRevocation(key.key_id) || request.headers.get("GQ-Support-Installation-Id") !== key.installation_id ||
      !await verifySignature(request, body, key.public_key, now)) {
      options.observe?.({ rejected: "installation_rejected" });
      return rejected();
    }
    // Check authority again in the same primary-D1 batch that consumes the nonce.
    // A request paused in signature verification cannot authorize an already-revoked key.
    const requestId = request.headers.get("GQ-Support-Request-Id")!;
    // A self-revocation goes to the ledger first, so a restore cannot revive the key.
    if (request.method === "DELETE" && options.ledger) {
      await ledgerStore(options.ledger).record([imageOf("revocation", { key_id: key.key_id, revoked_at: now })], now);
    }
    const results = await db.batch<{ key_id: string; suspended_reason?: string }>([
      db.prepare(`INSERT INTO replay (key_id, request_id, expires_at)
        SELECT key_id, ?, ? FROM installation_key WHERE key_id = ? AND revoked_at IS NULL
        ON CONFLICT (key_id, request_id) DO NOTHING`).bind(requestId, now + 600_000, key.key_id),
      request.method === "DELETE"
        ? db.prepare(`UPDATE installation_key SET revoked_at = ?
            WHERE key_id = ? AND revoked_at IS NULL AND changes() = 1 RETURNING key_id`).bind(now, key.key_id)
        : db.prepare(`SELECT k.key_id, r.suspended_reason FROM installation_key k
            LEFT JOIN repository_state r ON r.repository_id = ? WHERE k.key_id = ? AND k.revoked_at IS NULL`)
            .bind(mapping.repositoryId, key.key_id),
    ]);
    if (results[0].meta.changes !== 1 || results[1].results.length !== 1) {
      options.observe?.({ rejected: "installation_rejected" });
      return rejected();
    }
    options.observe?.({ slot: key.slot });
    if (request.method === "DELETE") return json({ revoked: true });
    const suspended = Boolean(results[1].results[0].suspended_reason);
    // Scope comes from the verified key alone; Slot-owned rows only through the storage seam.
    const storageFor = createStorageFor({ slots: new Map(mappings.map((m) => [m.slot, { client: m.client }])), shared: db, dedicated: {} });
    // Privacy rights still apply to a Suspended mapping.
    if (erasures) {
      return await handleErasures(request, url, body, db, storageFor(key.slot),
        { digestKey: options.digestKey ?? null, ledger: options.ledger ?? null }, now);
    }
    if (exported) return await handleExport(storageFor(key.slot), url, body, now);
    if (requests) {
      return await handleSupportRequests(request, url, body, storageFor(key.slot),
        { slot: key.slot, installationId: key.installation_id, repositoryId: mapping.repositoryId, suspended,
          ...(mapping.githubInstallationId && mapping.clientOriginLabel ? { delivery: { githubInstallationId: mapping.githubInstallationId,
            environment: mapping.environment, clientOriginLabel: mapping.clientOriginLabel, defaultDeveloper: mapping.defaultDeveloper } } : {}),
        }, now);
    }
    return json({ ...binding(key, mapping), mapping_state: suspended ? "suspended" : "active" });
  } catch {
    // Neither SQL errors nor request data (including Enrollment codes) enter logs/responses.
    return json({ code: "service_unavailable", message: "Service unavailable." }, 503);
  }
};

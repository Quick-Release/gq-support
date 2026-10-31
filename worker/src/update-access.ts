import type { PackageFailure, PackageSource } from "./package-source.ts";
import { mappingFor, type RepositoryMapping } from "./repository-mappings.ts";
import { offeredRelease } from "./release-policy.ts";
import { PLUGIN_VERSION, sha256, verifySignature, type SignatureScheme } from "./signature.ts";
import type { QueryDatabase } from "./storage.ts";
import type { CredentialDatabase } from "./operator.ts";

/**
 * Native WordPress updates (#142, docs/support-operations-design.md#private-package-access).
 * An installation that GETQUICK updates through WordPress's own updater signs
 * with an update key granted to its Slot by the Operator CLI
 * (src/update-access-operator.ts). That grant is independent of the report
 * Installation credential, so disabling submissions or revoking that credential
 * never strands updates; and it authorizes only these two reads:
 *
 * - `GET /v1/updates/gq-support`: the approved, dispatched release's version
 *   and package SHA-256, with download access to it for 15 minutes. The signed
 *   installed version is inventory evidence (observed), never authority.
 * - `GET /v1/updates/gq-support/package?version=…&sha256=…` with that download
 *   grant: the exact approved bytes, verified again here. Serving them records
 *   an attempt, never a completed update.
 *
 * Expired download access is renewed only by another signed metadata request;
 * a release withdrawn since its offer is refused (410). No credential is ever
 * part of a URL. Nothing here reads, submits or changes support records.
 */
export const UPDATE_PATH = "/v1/updates/gq-support";
export const PACKAGE_PATH = `${UPDATE_PATH}/package`;
export const UPDATE_SIGNATURE: SignatureScheme = { label: "gq-support-update-v1", keyId: "GQ-Update-Key-Id",
  principal: "GQ-Update-Installed-Version", timestamp: "GQ-Update-Timestamp", requestId: "GQ-Update-Request-Id",
  signature: "GQ-Update-Signature", claims: ["GQ-Update-Grant"] };
/**
 * The same, from a plugin that also signs the digest of its installed files
 * (#144): its own label, so the claim can be neither added to a v1 request nor
 * stripped from a v2 one. Only it can verify a native update as complete.
 */
export const UPDATE_SIGNATURE_V2: SignatureScheme = { ...UPDATE_SIGNATURE, label: "gq-support-update-v2",
  claims: ["GQ-Update-Grant", "GQ-Update-Installed-Files"] };
export const DOWNLOAD_GRANT_MS = 15 * 60_000;
/** Longer than a signature's five-minute clock window either side. */
const REPLAY_MS = 600_000;
const KEY_ID = /^[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const GRANT = /^[A-Za-z0-9_-]{43}$/;

export interface UpdateApiOptions {
  /** The stage's approved package source (src/package-source.ts); null fails closed. */
  readonly packages: PackageSource | null;
  /** Told why approved bytes could not be served, as a bounded class only, for the Worker's logs. */
  readonly observe?: (failure: PackageFailure | "unconfigured") => void;
}

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const unauthorized = () => json({ code: "gq_support_update_unauthorized" }, 401);
const unavailable = () => json({ code: "gq_support_update_unavailable" }, 503);

/** The key ID an update key is granted under: the hex SHA-256 of its raw public key. */
export const updateKeyId = async (publicKey: string): Promise<string> => {
  const raw = Uint8Array.from(atob(publicKey), (char) => char.charCodeAt(0));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", raw))).map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/**
 * The SQL condition for an active grant `g`: unexpired, unrevoked and the Slot's
 * newest. Binds the current time once.
 */
export const ACTIVE_GRANT = `g.expires_at > ? AND NOT EXISTS (SELECT 1 FROM update_access_revocation r WHERE r.key_id = g.key_id)
  AND NOT EXISTS (SELECT 1 FROM update_access_grant n WHERE n.slot = g.slot AND n.rowid > g.rowid)`;

const randomToken = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
  .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

/** Answers both update routes; anything else under `/v1/updates/` is not found. */
export const handleUpdateRequest = async (request: Request, db: CredentialDatabase, mappings: readonly RepositoryMapping[],
  options: UpdateApiOptions, now: number): Promise<Response> => {
  try {
    const url = new URL(request.url);
    const metadata = url.pathname === UPDATE_PATH && !url.search;
    const download = url.pathname === PACKAGE_PATH;
    if (request.method !== "GET" || (!metadata && !download) || url.protocol !== "https:") return json({ code: "not_found" }, 404);
    const keyId = request.headers.get(UPDATE_SIGNATURE.keyId) ?? "";
    const installed = request.headers.get(UPDATE_SIGNATURE.principal) ?? "";
    const grantToken = request.headers.get("GQ-Update-Grant") ?? "";
    const files = request.headers.get("GQ-Update-Installed-Files");
    if (!KEY_ID.test(keyId) || !PLUGIN_VERSION.test(installed) || (download ? !GRANT.test(grantToken) : grantToken !== "") ||
      (files !== null && !SHA256.test(files))) return unauthorized();
    await db.batch([
      db.prepare("DELETE FROM update_replay WHERE rowid IN (SELECT rowid FROM update_replay WHERE expires_at < ? LIMIT 100)").bind(now),
      db.prepare("DELETE FROM update_download_grant WHERE rowid IN (SELECT rowid FROM update_download_grant WHERE expires_at < ? LIMIT 100)")
        .bind(now - DOWNLOAD_GRANT_MS),
    ]);
    const key = await db.prepare(`SELECT g.key_id, g.slot, g.public_key FROM update_access_grant g WHERE g.key_id = ? AND ${ACTIVE_GRANT}`)
      .bind(keyId, now).first<{ key_id: string; slot: string; public_key: string }>();
    const mapping = key && mappingFor(mappings, key.slot);
    // Only a reviewed native Slot: a mapping changed to another deployment method stops native updates.
    if (!key || mapping?.deployment !== "native" || !await verifySignature(request, "", key.public_key, now,
      files === null ? UPDATE_SIGNATURE : UPDATE_SIGNATURE_V2)) return unauthorized();
    // The grant is checked again in the statement that consumes the request ID.
    const [used] = await db.batch([db.prepare(`INSERT INTO update_replay (key_id, request_id, expires_at)
      SELECT g.key_id, ?, ? FROM update_access_grant g WHERE g.key_id = ? AND ${ACTIVE_GRANT}
      ON CONFLICT (key_id, request_id) DO NOTHING`).bind(request.headers.get(UPDATE_SIGNATURE.requestId), now + REPLAY_MS, keyId, now)]);
    if (used!.meta.changes !== 1) return unauthorized();
    const release = await offeredRelease(db as unknown as QueryDatabase);
    return metadata ? await offer(db, key, installed, files, release, options, now) : await serve(db, url, key, grantToken, release, options, now);
  } catch {
    return unavailable();
  }
};

const offer = async (db: CredentialDatabase, key: { key_id: string; slot: string }, installed: string, files: string | null,
  release: Awaited<ReturnType<typeof offeredRelease>>, options: UpdateApiOptions, now: number) => {
  // What the installation signed it runs, at most hourly per version: inventory evidence only, never blocking.
  await db.prepare(`INSERT INTO slot_signed_version (slot, version, observed_at) VALUES (?, ?, ?)
    ON CONFLICT (slot) DO UPDATE SET version = excluded.version, observed_at = excluded.observed_at
    WHERE version != excluded.version OR observed_at <= excluded.observed_at - 3600000`).bind(key.slot, installed, now).run()
    .catch(() => undefined);
  // What it signed about its installed files: the evidence that verifies a native update (src/fleet-rollout.ts), likewise hourly.
  if (files !== null) {
    await db.prepare(`INSERT INTO slot_installed_files (slot, version, files_sha256, observed_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (slot) DO UPDATE SET version = excluded.version, files_sha256 = excluded.files_sha256, observed_at = excluded.observed_at
      WHERE version != excluded.version OR files_sha256 != excluded.files_sha256 OR observed_at <= excluded.observed_at - 3600000`)
      .bind(key.slot, installed, files, now).run().catch(() => undefined);
  }
  if (!release) return json({ plugin: "gq-support", release: null, grant: null, auto_update: true });
  // Offer nothing that cannot then be downloaded.
  if (!options.packages) { options.observe?.("unconfigured"); return unavailable(); }
  const token = randomToken();
  await db.prepare(`INSERT INTO update_download_grant (grant_hash, key_id, release_sequence, issued_at, expires_at)
    VALUES (?, ?, ?, ?, ?)`).bind(await sha256(token), key.key_id, release.sequence, now, now + DOWNLOAD_GRANT_MS).run();
  const digest = release.package_sha256!;
  return json({ plugin: "gq-support", auto_update: true,
    release: { release_id: release.sequence, version: release.package_version, kind: release.kind, files_sha256: release.files_sha256, package_sha256: digest,
      package_path: `${PACKAGE_PATH}?version=${encodeURIComponent(release.package_version)}&sha256=${digest}` },
    grant: { token, expires_at: new Date(now + DOWNLOAD_GRANT_MS).toISOString() } });
};

const serve = async (db: CredentialDatabase, url: URL, key: { key_id: string; slot: string }, token: string,
  release: Awaited<ReturnType<typeof offeredRelease>>, options: UpdateApiOptions, now: number) => {
  const version = url.searchParams.get("version") ?? "";
  const digest = url.searchParams.get("sha256") ?? "";
  if ([...url.searchParams.keys()].join() !== "version,sha256" || !PLUGIN_VERSION.test(version) || !SHA256.test(digest)) {
    return json({ code: "not_found" }, 404);
  }
  const grant = await db.prepare(`SELECT release_sequence FROM update_download_grant WHERE grant_hash = ? AND key_id = ? AND expires_at > ?`)
    .bind(await sha256(token), key.key_id, now).first<{ release_sequence: number }>();
  if (!grant) return json({ code: "gq_support_update_grant_expired" }, 401);
  // Only the release still offered, by the exact version and digest the offer named.
  if (!release || release.sequence !== grant.release_sequence || release.package_version !== version || release.package_sha256 !== digest) {
    return json({ code: "gq_support_update_withdrawn" }, 410);
  }
  if (!options.packages) { options.observe?.("unconfigured"); return unavailable(); }
  const read = await options.packages.read(version, digest);
  if (!("bytes" in read)) { options.observe?.(read.failure); return unavailable(); }
  await db.prepare(`INSERT INTO slot_update_attempt (slot, version, attempted_at) VALUES (?, ?, ?)
    ON CONFLICT (slot) DO UPDATE SET version = excluded.version, attempted_at = excluded.attempted_at`).bind(key.slot, version, now).run();
  return new Response(read.bytes as Uint8Array<ArrayBuffer>, { status: 200, headers: {
    "Content-Type": "application/zip", "Content-Length": String(read.bytes.length), "Cache-Control": "no-store",
    "Content-Disposition": "attachment; filename=\"gq-support.zip\"", "GQ-Update-Package-Sha256": digest,
  } });
};

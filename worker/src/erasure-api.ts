import { erasureStatus, OPEN_ERASURE, recordErasure } from "./cleanup.ts";
import type { QueryDatabase, SlotStorage } from "./storage.ts";
import { reporterReference } from "./support-issues.ts";
import { error, invalid, json, notFound, throttle, UUID4 } from "./support-requests.ts";

const ERASURE_ID = /^era_[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * `POST /v1/erasures` and `GET /v1/erasures/{id}`, after authentication. The
 * verified key's Slot and the attested subject are the only scope. A `202`
 * means the erasure is recorded: creates are suppressed and the text purged.
 */
export const handleErasures = async (request: Request, url: URL, body: string, db: QueryDatabase, storage: SlotStorage,
  options: { readonly digestKey: CryptoKey | null; readonly ledger: QueryDatabase | null }, now: number): Promise<Response> => {
  if (url.search) return invalid();
  if (request.method === "POST") {
    if (url.pathname !== "/v1/erasures") return notFound();
    let data: unknown;
    try { data = JSON.parse(body); } catch { return invalid(); }
    const fields = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : null;
    const subject = fields?.reporter_subject;
    if (!fields || Object.keys(fields).length !== 1 || typeof subject !== "string" || !UUID4.test(subject)) return invalid();
    const limited = await throttle(storage, subject, now);
    if (limited) return limited;
    let id: string | undefined;
    try {
      id = await recordErasure(db, storage.slot, subject, now, options.digestKey, options.ledger);
    } catch {
      // A concurrent request may have opened it first; otherwise nothing was recorded.
      try {
        id = (await db.prepare(OPEN_ERASURE).bind(storage.slot, await reporterReference(storage.slot, subject)).first<{ id: string }>())?.id;
      } catch { /* not recorded either way */ }
      if (!id) return error("gq_support_erasure_not_recorded", 503);
    }
    return json(await erasureStatus(db, id), 202);
  }
  const id = /^\/v1\/erasures\/([^/]+)$/.exec(url.pathname)?.[1];
  if (body !== "" || !id || !ERASURE_ID.test(id)) return notFound();
  // Another Slot's erasure looks exactly like an unknown one.
  const owned = await db.prepare("SELECT 1 FROM erasure WHERE id = ? AND slot = ?").bind(id, storage.slot).first();
  const status = owned ? await erasureStatus(db, id) : null;
  return status ? json(status, 200) : notFound();
};

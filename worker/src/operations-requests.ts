import type { RepositoryMapping } from "./repository-mappings.ts";
import type { QueryDatabase } from "./storage.ts";

interface RequestRow {
  id: string; slot: string; repository_id: number; issue_number: number | null;
  status: string | null; created_at: number; delivery: string | null;
}

/** A staff projection, separate from the Reporter's content-bearing request API. */
export const operationsRequests = async (db: QueryDatabase, mappings: readonly RepositoryMapping[], url: URL) => {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  const invalid = () => json({ code: "invalid_request" }, 400);
  const parameters = url.searchParams;
  if ([...parameters.keys()].some((key) => !["limit", "cursor"].includes(key)) ||
    parameters.getAll("limit").length > 1 || parameters.getAll("cursor").length > 1) return invalid();
  const limitText = parameters.get("limit") ?? "50";
  if (!/^[1-9][0-9]{0,2}$/.test(limitText) || Number(limitText) > 200) return invalid();
  const limit = Number(limitText);
  const cursor = parameters.get("cursor");
  let beforeTime = 0, beforeId = "";
  if (cursor !== null) {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(cursor)) return invalid();
    try {
      const parsed: unknown = JSON.parse(atob(cursor.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - cursor.length % 4) % 4)));
      if (!Array.isArray(parsed) || parsed.length !== 2 || !Number.isSafeInteger(parsed[0]) || parsed[0] < 0 ||
        typeof parsed[1] !== "string" || !/^req_[0-9A-HJKMNP-TV-Z]{26}$/.test(parsed[1])) return invalid();
      [beforeTime, beforeId] = parsed as [number, string];
    } catch { return invalid(); }
  }
  const rows = (await db.prepare(`SELECT r.id, r.slot, r.repository_id, r.issue_number, r.status, r.created_at, d.state AS delivery
    FROM support_request r LEFT JOIN delivery_intent d ON d.request_id = r.id AND d.slot = r.slot AND d.seq = 0
    WHERE r.erased_at IS NULL AND r.superseded_at IS NULL AND r.slot IN (SELECT value FROM json_each(?))
      AND (? = '' OR r.created_at < ? OR (r.created_at = ? AND r.id < ?))
    ORDER BY r.created_at DESC, r.id DESC LIMIT ?`)
    .bind(JSON.stringify(mappings.map((mapping) => mapping.slot)), beforeId, beforeTime, beforeTime, beforeId, limit + 1)
    .all<RequestRow>()).results;
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const next = rows.length > limit && last ? btoa(JSON.stringify([last.created_at, last.id]))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "") : null;
  return json({ items: page.map((row) => {
    const mapping = mappings.find((candidate) => candidate.slot === row.slot)!;
    const repository = mapping.repositoryId === row.repository_id && mapping.repository &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(mapping.repository) ? mapping.repository : null;
    const delivery = row.issue_number !== null ? "delivered"
      : row.delivery === "pending" || row.delivery === "in_flight" ? "accepted-pending"
      : row.delivery === "failed" ? "failed" : "outcome-unknown";
    return { id: row.id, slot: row.slot, client: mapping.client, project: mapping.project, environment: mapping.environment,
      created_at: new Date(row.created_at).toISOString(), delivery, support_status: row.status,
      issue_url: repository && row.issue_number !== null ? `https://github.com/${repository}/issues/${row.issue_number}` : null };
  }), next_cursor: next });
};

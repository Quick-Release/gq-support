import { sha256 } from "./signature.ts";
import type { Quota, SlotStorage } from "./storage.ts";

/**
 * The verified installation's authority. It comes only from the signing key
 * and its Repository mapping, never from a body, query, header or Origin.
 */
export interface Caller {
  readonly slot: string;
  readonly installationId: string;
  readonly repositoryId: number;
}

/**
 * The create body cap. WordPress caps the browser body at 32 KiB, but
 * wp_json_encode() escapes each astral code point as 12 bytes, so the longest
 * valid Summary and Description can reach about 120 KiB when forwarded.
 */
export const CREATE_BODY_BYTES = 131_072;
const SUMMARY_CHARACTERS = 120;
const DESCRIPTION_CHARACTERS = 10_000;
const TITLE_CHARACTERS = 80;
const PER_PAGE = { default: 20, max: 50 };
const CURSOR_CHARACTERS = 1024;

// Initial intake quotas (docs/support-delivery-design.md). Same-key replays debit nothing.
const TEN_MINUTES = 600_000;
const DAY = 86_400_000;
export const REPORTER_QUOTAS: readonly Quota[] = [{ windowMs: TEN_MINUTES, limit: 5 }, { windowMs: DAY, limit: 20 }];
export const SLOT_QUOTAS: readonly Quota[] = [{ windowMs: TEN_MINUTES, limit: 20 }, { windowMs: DAY, limit: 100 }];
/** The intake debit subject for the Slot's own budget, as opposed to a Reporter's. */
const SLOT_BUDGET = "";

const UUID4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
// The Support request's resource ID, not the single-use authentication Request ID.
const SUPPORT_REQUEST_ID = "req_[0-9A-HJKMNP-TV-Z]{26}";
const DELIVERY: Record<string, string> = {
  pending: "accepted-pending", in_flight: "accepted-pending", delivered: "delivered",
  failed: "failed", outcome_unknown: "outcome-unknown",
};

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
const error = (code: string, status: number, headers: Record<string, string> = {}) => json({ code }, status, headers);
const invalid = () => error("gq_support_invalid_request", 400);
const notFound = () => error("gq_support_not_found", 404);

// PHP's trim(), which WordPress applies before forwarding, not JavaScript's wider one.
const trim = (text: string) => text.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, "");
const characters = (text: string) => [...text].length;

/** A service-issued ULID: 48 bits of time, then 80 random bits. */
const ulid = (now: number): string => {
  let time = "";
  for (let rest = now, i = 0; i < 10; i += 1, rest = Math.floor(rest / 32)) time = CROCKFORD[rest % 32] + time;
  return time + Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => CROCKFORD[byte % 32]).join("");
};

/** The Summary, or the description's first line cut at a word boundary. */
const titleFor = (summary: string | null, description: string): string => {
  if (summary !== null) return summary;
  const line = [...trim(description.split(/\r?\n|\r/, 1)[0]!)];
  if (line.length <= TITLE_CHARACTERS) return line.join("");
  const cut = line.slice(0, TITLE_CHARACTERS + 1).join("");
  const space = cut.lastIndexOf(" ");
  return trim(space > 0 ? cut.slice(0, space) : line.slice(0, TITLE_CHARACTERS).join(""));
};

interface Row {
  id: string;
  reporter_subject: string;
  submission_id: string;
  body_digest: string;
  summary: string;
  description: string;
  title: string;
  created_at: number;
  status: string | null;
  state: string;
}

const COLUMNS = `SELECT r.id, r.reporter_subject, r.submission_id, r.body_digest, r.summary, r.description, r.title,
  r.created_at, r.status, i.state FROM support_request r JOIN delivery_intent i ON i.request_id = r.id AND i.seq = 0
  WHERE r.slot = ?1 AND i.slot = ?1`;

const resource = (row: Row, caller: Caller) => ({
  id: row.id,
  submission_id: row.submission_id,
  title: row.title,
  summary: row.summary === "" ? null : row.summary,
  description: row.description,
  created_at: new Date(row.created_at).toISOString(),
  delivery: DELIVERY[row.state],
  status: row.state === "delivered" ? row.status : null,
  // Server-only ownership metadata; WordPress verifies and strips it. The
  // installation is the verified caller, so history survives re-enrollment (ADR 0014).
  installation_id: caller.installationId,
  reporter_subject: row.reporter_subject,
});

/** A known request: 201 once delivered, otherwise 202 with its current outcome. */
const known = (row: Row, caller: Caller) => row.state === "delivered"
  ? json(resource(row, caller), 201, { Location: `/v1/requests/${row.id}` })
  : json(resource(row, caller), 202);

interface CreateInput {
  submission_id: string;
  reporter_subject: string;
  summary: string | null;
  description: string;
}

const parseCreate = (body: string): CreateInput | null => {
  let data: unknown;
  try { data = JSON.parse(body); } catch { return null; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const fields = data as Record<string, unknown>;
  // Scope comes from the key: a named Slot, Client, repository or installation is rejected.
  if (Object.keys(fields).some((field) => !["submission_id", "summary", "description", "reporter_subject", "scope"].includes(field))) return null;
  const { submission_id: submissionId, reporter_subject: subject, scope, description, summary } = fields;
  if (typeof submissionId !== "string" || !UUID4.test(submissionId) || typeof subject !== "string" || !UUID4.test(subject) ||
    scope !== "mine" || typeof description !== "string") return null;
  const text = trim(description);
  if (text === "" || characters(text) > DESCRIPTION_CHARACTERS) return null;
  if (summary === undefined) return { submission_id: submissionId, reporter_subject: subject, summary: null, description: text };
  if (typeof summary !== "string") return null;
  const line = trim(summary);
  if (line === "" || characters(line) > SUMMARY_CHARACTERS || /[\r\n]/.test(line)) return null;
  return { submission_id: submissionId, reporter_subject: subject, summary: line, description: text };
};

const findBySubmission = (storage: SlotStorage, input: CreateInput) =>
  storage.first<Row>(`${COLUMNS} AND r.reporter_subject = ?2 AND r.submission_id = ?3`, input.reporter_subject, input.submission_id);

/** Milliseconds until every exceeded quota has room again: 0 when none is exceeded. */
const quotaWait = async (storage: SlotStorage, subject: string, now: number): Promise<number> => {
  let wait = 0;
  for (const [key, quotas] of [[subject, REPORTER_QUOTAS], [SLOT_BUDGET, SLOT_QUOTAS]] as const) {
    const limit = Math.max(...quotas.map((quota) => quota.limit));
    const debits = await storage.all<{ debited_at: number }>(`SELECT debited_at FROM intake_debit
      WHERE slot = ?1 AND subject = ?2 AND debited_at > ?3 ORDER BY debited_at DESC LIMIT ?4`, key, now - DAY, limit);
    for (const quota of quotas) {
      const oldest = debits[quota.limit - 1]?.debited_at;
      if (oldest !== undefined && oldest > now - quota.windowMs) wait = Math.max(wait, oldest + quota.windowMs - now);
    }
  }
  return wait;
};

/**
 * Accept one Support request: the request, its create intent and both quota
 * debits commit in one batch, or none do. A same-key retry debits nothing.
 */
const create = async (storage: SlotStorage, caller: Caller, body: string, now: number): Promise<Response> => {
  const input = parseCreate(body);
  if (!input) return invalid();
  const digest = await sha256(JSON.stringify([input.summary, input.description]));
  const replay = (row: Row) => row.body_digest === digest ? known(row, caller) : error("gq_support_idempotency_conflict", 409);
  const id = `req_${ulid(now)}`;
  const accepted: Row = {
    id, reporter_subject: input.reporter_subject, submission_id: input.submission_id, body_digest: digest,
    summary: input.summary ?? "", description: input.description, title: titleFor(input.summary, input.description),
    created_at: now, status: null, state: "pending",
  };
  try {
    const existing = await findBySubmission(storage, input);
    if (existing) return replay(existing);
    await storage.batch([
      storage.debitIntake(input.reporter_subject, now, REPORTER_QUOTAS),
      storage.debitIntake(SLOT_BUDGET, now, SLOT_QUOTAS),
      storage.statement(`INSERT INTO support_request (slot, id, reporter_subject, submission_id, body_digest, summary,
        description, title, created_at, installation_id, repository_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      id, accepted.reporter_subject, accepted.submission_id, digest, accepted.summary, accepted.description, accepted.title,
      now, caller.installationId, caller.repositoryId),
      storage.statement(`INSERT INTO delivery_intent (slot, id, request_id, kind, seq, state, next_attempt_at)
        VALUES (?1, ?2, ?3, 'create', 0, 'pending', ?4)`, `int_${ulid(now)}`, id, now),
      storage.statement("DELETE FROM intake_debit WHERE slot = ?1 AND debited_at <= ?2", now - DAY),
    ]);
  } catch {
    // The commit may have happened: only a primary same-key lookup can tell.
    let row: Row | null;
    try { row = await findBySubmission(storage, input); } catch { return error("gq_support_outcome_unknown", 504); }
    if (row) return replay(row);
    // A full quota fails the debit's NOT NULL constraint; recount rather than parse the error.
    let wait = 0;
    try { wait = await quotaWait(storage, input.reporter_subject, now); } catch { /* not accepted either way */ }
    return wait > 0
      ? error("gq_support_rate_limited", 429, { "Retry-After": String(Math.ceil(wait / 1000)) })
      : error("gq_support_not_accepted", 503);
  }
  return json(resource(accepted, caller), 202);
};

/** Exactly the allowed query keys, each at most once, including every required one. */
const queryOf = (url: URL, allowed: readonly string[], required: readonly string[]): Map<string, string> | null => {
  const params = new Map<string, string>();
  for (const [key, value] of url.searchParams) {
    if (!allowed.includes(key) || params.has(key)) return null;
    params.set(key, value);
  }
  return required.every((key) => params.has(key)) ? params : null;
};

/** The attested Reporter and scope. `site` is a fresh view-site grant from this installation only. */
const attested = (params: Map<string, string>) => {
  const subject = params.get("reporter_subject")!;
  const scope = params.get("scope")!;
  return UUID4.test(subject) && (scope === "mine" || scope === "site") ? { subject, site: scope === "site" } : null;
};

// The cursor needs no signature: every page reapplies the scope filters.
const encodeCursor = (row: Row) => btoa(`${row.created_at}:${row.id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const decodeCursor = (cursor: string): [number, string] | null => {
  try {
    const match = new RegExp(`^(\\d{1,16}):(${SUPPORT_REQUEST_ID})$`).exec(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")));
    return match ? [Number(match[1]), match[2]!] : null;
  } catch {
    return null;
  }
};

const list = async (storage: SlotStorage, caller: Caller, url: URL): Promise<Response> => {
  const params = queryOf(url, ["reporter_subject", "scope", "per_page", "cursor"], ["reporter_subject", "scope"]);
  const scope = params && attested(params);
  if (!params || !scope) return invalid();
  const perPage = params.get("per_page") ?? String(PER_PAGE.default);
  if (!/^[1-9]\d{0,1}$/.test(perPage) || Number(perPage) > PER_PAGE.max) return invalid();
  const cursor = params.get("cursor");
  const before = cursor === undefined ? [Number.MAX_SAFE_INTEGER, ""] as const
    : cursor.length <= CURSOR_CHARACTERS ? decodeCursor(cursor) : null;
  if (!before) return invalid();
  const page = `AND r.superseded_at IS NULL AND (r.created_at, r.id) < (?2, ?3)`;
  const rows = scope.site
    ? await storage.all<Row>(`${COLUMNS} ${page} ORDER BY r.created_at DESC, r.id DESC LIMIT ?4`, ...before, Number(perPage) + 1)
    : await storage.all<Row>(`${COLUMNS} ${page} AND r.reporter_subject = ?4 ORDER BY r.created_at DESC, r.id DESC LIMIT ?5`,
      ...before, scope.subject, Number(perPage) + 1);
  const items = rows.slice(0, Number(perPage));
  return json({
    items: items.map((row) => resource(row, caller)),
    next_cursor: rows.length > items.length ? encodeCursor(items[items.length - 1]!) : null,
  }, 200);
};

const read = async (storage: SlotStorage, caller: Caller, url: URL, id: string): Promise<Response> => {
  const params = queryOf(url, ["reporter_subject", "scope"], ["reporter_subject", "scope"]);
  const scope = params && attested(params);
  if (!scope) return invalid();
  if (!new RegExp(`^${SUPPORT_REQUEST_ID}$`).test(id)) return notFound();
  const row = await storage.first<Row>(`${COLUMNS} AND r.id = ?2`, id);
  // Unknown and out-of-scope requests look the same.
  if (!row || (!scope.site && row.reporter_subject !== scope.subject)) return notFound();
  return json(resource(row, caller), 200);
};

/** `POST /v1/requests`, `GET /v1/requests` and `GET /v1/requests/{id}`, after authentication. */
export const handleSupportRequests = (request: Request, url: URL, body: string, storage: SlotStorage, caller: Caller, now: number): Promise<Response> => {
  // Scope comes from the key: a create names nothing in its query either.
  if (request.method === "POST") return url.search ? Promise.resolve(invalid()) : create(storage, caller, body, now);
  if (body !== "") return Promise.resolve(invalid());
  const id = /^\/v1\/requests\/([^/]+)$/.exec(url.pathname)?.[1];
  return id === undefined ? list(storage, caller, url) : read(storage, caller, url, id);
};

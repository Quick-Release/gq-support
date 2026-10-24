import { sha256 } from "./signature.ts";
import type { Quota, SlotStorage } from "./storage.ts";
import { CONTEXT_LIMITS, canonicalContext, storedContext, utf8Bytes } from "./report-context.ts";

/**
 * The verified installation's authority. It comes only from the signing key
 * and its Repository mapping, never from a body, query, header or Origin.
 */
export interface Caller {
  readonly slot: string;
  readonly installationId: string;
  readonly repositoryId: number;
  readonly delivery?: { readonly githubInstallationId: number; readonly environment: string; readonly clientOriginLabel: string; readonly defaultDeveloper: string };
  /** A Suspended mapping takes no new Support requests; earlier ones still replay. */
  readonly suspended?: boolean;
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
/** The subject of the Slot's own budget, as opposed to a Reporter's. */
const SLOT_BUDGET = "";
/**
 * Status changes (ADR 0020) spend their own budgets, so toggling a request
 * cannot exhaust report intake, nor intake block a close. Starting limits.
 */
export const STATUS_REPORTER_QUOTAS: readonly Quota[] = [{ windowMs: TEN_MINUTES, limit: 10 }, { windowMs: DAY, limit: 30 }];
export const STATUS_SLOT_QUOTAS: readonly Quota[] = [{ windowMs: TEN_MINUTES, limit: 30 }, { windowMs: DAY, limit: 100 }];
/** Prefixes a status budget's subject; erasure removes the Reporter's with their intake debits. */
export const STATUS_BUDGET = "status:";
// Fixed ten-minute budgets for every call, so same-key lookups and reads stay
// bounded. Chosen for #32, not by a design decision: revisit after load testing.
export const REPORTER_REQUESTS = 120;
export const SLOT_REQUESTS = 600;

export const UUID4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
// The Support request's resource ID, not the single-use authentication Request ID.
const SUPPORT_REQUEST_ID = "req_[0-9A-HJKMNP-TV-Z]{26}";
export const DELIVERY: Record<string, string> = {
  pending: "accepted-pending", in_flight: "accepted-pending", delivered: "delivered",
  failed: "failed", outcome_unknown: "outcome-unknown",
};

export const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
export const error = (code: string, status: number, headers: Record<string, string> = {}) => json({ code }, status, headers);
export const invalid = () => error("gq_support_invalid_request", 400);
export const notFound = () => error("gq_support_not_found", 404);
/**
 * The SET clause that purges a request's Submitted text, subject, Submission
 * ID and digest. `erased_at` (set alongside) hides it from every projection.
 */
export const PURGED_TEXT = `summary = '', description = '', title = '', reporter_subject = '', submission_id = id, body_digest = ''`;

// PHP's trim(), which WordPress applies before forwarding, not JavaScript's wider one.
// eslint-disable-next-line no-control-regex -- NUL and vertical tab are exactly PHP's set.
const trim = (text: string) => text.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, "");
const characters = (text: string) => [...text].length;

/** A service-issued ULID: 48 bits of time, then 80 random bits. */
export const ulid = (now: number): string => {
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
  supersedes_id: string | null;
  superseded_at: number | null;
  summary: string;
  description: string;
  title: string;
  created_at: number;
  status: string | null;
  state: string;
  tracking: string;
  /** The latest status change's seq, or 0: the change_* fields then describe the create. */
  change_seq: number;
  change_kind: string;
  change_state: string;
  change_id: string | null;
  /** Delivery-only Report context, read by the privacy export alone. */
  context_json?: string | null;
}

const FIELDS = `r.id, r.reporter_subject, r.submission_id, r.body_digest, r.summary, r.description, r.title,
  r.created_at, r.status, r.supersedes_id, r.superseded_at, i.state, r.tracking, r.change_seq,
  c.kind AS change_kind, c.state AS change_state, c.change_id`;
// `c` is the latest status change, or the create again when there is none, so no row is lost to a missing join.
const FROM = `FROM support_request r JOIN delivery_intent i ON i.request_id = r.id AND i.seq = 0
  JOIN delivery_intent c ON c.request_id = r.id AND c.seq = r.change_seq
  WHERE r.slot = ?1 AND i.slot = ?1 AND c.slot = ?1 AND r.erased_at IS NULL`;
const COLUMNS = `SELECT ${FIELDS} ${FROM}`;

const STATUS_KINDS = { closed: "close", open: "reopen" } as const;
type StatusChange = { readonly change_id: string; readonly status: "open" | "closed"; readonly delivery: string };
const statusChange = (kind: string, state: string, changeId: string | null): StatusChange =>
  ({ change_id: changeId!, status: kind === "close" ? "closed" : "open", delivery: DELIVERY[state]! });

const resource = (row: Row, caller: Caller) => ({
  id: row.id,
  submission_id: row.submission_id,
  title: row.title,
  summary: row.summary === "" ? null : row.summary,
  description: row.description,
  created_at: new Date(row.created_at).toISOString(),
  delivery: DELIVERY[row.state],
  status: row.state === "delivered" ? row.status : null,
  // The latest close or reopen and its own delivery outcome, never a Support status of its own (ADR 0020).
  status_change: row.change_seq > 0 ? statusChange(row.change_kind, row.change_state, row.change_id) : null,
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
  supersedes_id: string | null;
  /** The canonical reviewed Report context, or null for a context-free intent. */
  context: string | null;
  /** WordPress's review envelope expired: only an already accepted intent may be returned. */
  reconcile_only: boolean;
}

const parseCreate = (body: string): CreateInput | null => {
  let data: unknown;
  try { data = JSON.parse(body); } catch { return null; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const fields = data as Record<string, unknown>;
  // Scope comes from the key: a named Slot, Client, repository or installation is rejected.
  if (Object.keys(fields).some((field) => !["submission_id", "summary", "description", "reporter_subject", "scope", "supersedes_id",
    "context", "reconcile_only"].includes(field))) return null;
  const { submission_id: submissionId, reporter_subject: subject, scope, description, summary } = fields;
  if (typeof submissionId !== "string" || !UUID4.test(submissionId) || typeof subject !== "string" || !UUID4.test(subject) ||
    scope !== "mine" || typeof description !== "string") return null;
  const supersedes = fields.supersedes_id;
  if (supersedes !== undefined && (typeof supersedes !== "string" || !new RegExp(`^${SUPPORT_REQUEST_ID}$`).test(supersedes))) return null;
  const context = fields.context === undefined ? null : canonicalContext(fields.context);
  if ((fields.context !== undefined && context === null) || (fields.reconcile_only !== undefined && fields.reconcile_only !== true)) return null;
  const text = trim(description);
  if (text === "" || characters(text) > DESCRIPTION_CHARACTERS) return null;
  const input = { submission_id: submissionId, reporter_subject: subject, description: text, supersedes_id: supersedes ?? null,
    context, reconcile_only: fields.reconcile_only === true };
  if (summary === undefined) return { ...input, summary: null };
  if (typeof summary !== "string") return null;
  const line = trim(summary);
  if (line === "" || characters(line) > SUMMARY_CHARACTERS || /[\r\n]/.test(line)) return null;
  return { ...input, summary: line };
};

/**
 * The immutable intent fingerprint. A context-free intent keeps the original
 * fingerprint of its Submitted text, so intents accepted before Report context
 * existed still reconcile. A review envelope's signature and expiry never
 * take part: WordPress verifies the envelope and does not forward it.
 */
const fingerprint = (input: CreateInput) =>
  sha256(JSON.stringify(input.context === null ? [input.summary, input.description] : [input.summary, input.description, input.context]));

const findBySubmission = (storage: SlotStorage, input: CreateInput) =>
  storage.first<Row>(`${COLUMNS} AND r.reporter_subject = ?2 AND r.submission_id = ?3`, input.reporter_subject, input.submission_id);

/** Milliseconds until every exceeded quota has room again: 0 when none is exceeded. */
const quotaWait = async (storage: SlotStorage, budgets: readonly (readonly [string, readonly Quota[]])[], now: number): Promise<number> => {
  let wait = 0;
  for (const [key, quotas] of budgets) {
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
  if (input.context !== null && utf8Bytes(body) > CONTEXT_LIMITS.createBodyBytes) {
    return error("request_too_large", 413);
  }
  const limited = await throttle(storage, input.reporter_subject, now);
  if (limited) return limited;
  const digest = await fingerprint(input);
  const replay = (row: Row) => row.body_digest === digest && row.supersedes_id === input.supersedes_id ? known(row, caller) : error("gq_support_idempotency_conflict", 409);
  const id = `req_${ulid(now)}`;
  const accepted: Row = {
    id, reporter_subject: input.reporter_subject, submission_id: input.submission_id, body_digest: digest,
    summary: input.summary ?? "", description: input.description, title: titleFor(input.summary, input.description),
    created_at: now, status: null, state: "pending", supersedes_id: input.supersedes_id, superseded_at: null,
    tracking: "active", change_seq: 0, change_kind: "create", change_state: "pending", change_id: null,
  };
  const canSupersede = async () => {
    const predecessor = await storage.first<Row>(`${COLUMNS} AND r.id = ?2 AND r.reporter_subject = ?3`, input.supersedes_id, input.reporter_subject);
    return predecessor?.state === "failed" && predecessor.superseded_at === null;
  };
  try {
    const existing = await findBySubmission(storage, input);
    if (existing) return replay(existing);
    // An expired review envelope never authorizes a new acceptance.
    if (input.reconcile_only) return error("gq_support_context_expired", 412);
    if (caller.suspended) return error("gq_support_not_configured", 403);
    if (input.supersedes_id !== null && !await canSupersede()) return notFound();
    await storage.batch([
      storage.debitIntake(input.reporter_subject, now, REPORTER_QUOTAS),
      storage.debitIntake(SLOT_BUDGET, now, SLOT_QUOTAS),
      ...(input.supersedes_id === null ? [] : [storage.supersedeFailedRequest(input.supersedes_id, input.reporter_subject, now)]),
      // Keep this INSERT immediately after supersession: changes() fences a
      // zero-row update by failing reporter_subject's NOT NULL constraint.
      storage.statement(`INSERT INTO support_request (slot, id, reporter_subject, submission_id, body_digest, summary,
        description, title, created_at, installation_id, repository_id, supersedes_id)
        VALUES (?1, ?2, CASE WHEN ?12 IS NULL OR changes() = 1 THEN ?3 END, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      id, accepted.reporter_subject, accepted.submission_id, digest, accepted.summary, accepted.description, accepted.title,
      now, caller.installationId, caller.repositoryId, input.supersedes_id),
      storage.statement(`INSERT INTO delivery_intent (slot, id, request_id, kind, seq, state, next_attempt_at,
        github_installation_id, environment, client_origin_label, default_developer, retry_deadline, context_json)
        VALUES (?1, ?2, ?3, 'create', 0, 'pending', ?4, ?5, ?6, ?7, ?8, ?9, ?10)`, `int_${ulid(now)}`, id, now,
        caller.delivery?.githubInstallationId ?? null, caller.delivery?.environment ?? null,
        caller.delivery?.clientOriginLabel ?? null, caller.delivery?.defaultDeveloper ?? null, now + DAY, input.context),
      storage.statement("DELETE FROM intake_debit WHERE slot = ?1 AND debited_at <= ?2", now - DAY),
    ]);
  } catch {
    // The commit may have happened: only a primary same-key lookup can tell.
    let row: Row | null;
    try { row = await findBySubmission(storage, input); } catch { return error("gq_support_outcome_unknown", 504); }
    if (row) return replay(row);
    if (input.supersedes_id !== null) {
      try { if (!await canSupersede()) return notFound(); } catch { return error("gq_support_outcome_unknown", 504); }
    }
    // A full quota fails the debit's NOT NULL constraint; recount rather than parse the error.
    let wait = 0;
    try { wait = await quotaWait(storage, [[input.reporter_subject, REPORTER_QUOTAS], [SLOT_BUDGET, SLOT_QUOTAS]], now); } catch { /* not accepted either way */ }
    return wait > 0
      ? error("gq_support_rate_limited", 429, { "Retry-After": String(Math.ceil(wait / 1000)) })
      : error("gq_support_not_accepted", 503);
  }
  return json(resource(accepted, caller), 202);
};

/**
 * Spend one request from the Reporter's and the Slot's budgets: a 429 once
 * either is used up. A counter outage lets the call through: reads are safe,
 * and creates still fail closed on their own intake quota.
 */
export const throttle = async (storage: SlotStorage, subject: string, now: number): Promise<Response | null> => {
  const windowStart = Math.floor(now / TEN_MINUTES) * TEN_MINUTES;
  const spend = (key: string) => storage.statement(`INSERT INTO request_rate (slot, subject, window_start, requests)
    VALUES (?1, ?2, ?3, 1) ON CONFLICT (slot, subject) DO UPDATE SET
      requests = CASE WHEN window_start < excluded.window_start THEN 1 ELSE requests + 1 END,
      window_start = excluded.window_start RETURNING requests`, key, windowStart);
  let results;
  try {
    results = await storage.batch([
      spend(subject), spend(SLOT_BUDGET),
      storage.statement("DELETE FROM request_rate WHERE slot = ?1 AND window_start < ?2", windowStart),
    ]);
  } catch {
    return null;
  }
  const [reporter, slot] = results.map((result) => (result.results[0] as { requests: number } | undefined)?.requests ?? 0);
  return (reporter ?? 0) > REPORTER_REQUESTS || (slot ?? 0) > SLOT_REQUESTS
    ? error("gq_support_rate_limited", 429, { "Retry-After": String(Math.ceil((windowStart + TEN_MINUTES - now) / 1000)) })
    : null;
};

/** Exactly the allowed query keys, each at most once, including every required one. */
export const queryOf = (url: URL, allowed: readonly string[], required: readonly string[]): Map<string, string> | null => {
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

const list = async (storage: SlotStorage, caller: Caller, url: URL, now: number): Promise<Response> => {
  const params = queryOf(url, ["reporter_subject", "scope", "per_page", "cursor"], ["reporter_subject", "scope"]);
  const scope = params && attested(params);
  if (!params || !scope) return invalid();
  const perPage = params.get("per_page") ?? String(PER_PAGE.default);
  if (!/^[1-9]\d{0,1}$/.test(perPage) || Number(perPage) > PER_PAGE.max) return invalid();
  const cursor = params.get("cursor");
  const before = cursor === undefined ? [Number.MAX_SAFE_INTEGER, ""] as const
    : cursor.length <= CURSOR_CHARACTERS ? decodeCursor(cursor) : null;
  if (!before) return invalid();
  const limited = await throttle(storage, scope.subject, now);
  if (limited) return limited;
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

const read = async (storage: SlotStorage, caller: Caller, url: URL, id: string, now: number): Promise<Response> => {
  const params = queryOf(url, ["reporter_subject", "scope"], ["reporter_subject", "scope"]);
  const scope = params && attested(params);
  if (!scope) return invalid();
  const limited = await throttle(storage, scope.subject, now);
  if (limited) return limited;
  if (!new RegExp(`^${SUPPORT_REQUEST_ID}$`).test(id)) return notFound();
  const row = await storage.first<Row>(`${COLUMNS} AND r.id = ?2`, id);
  // Unknown and out-of-scope requests look the same.
  if (!row || (!scope.site && row.reporter_subject !== scope.subject)) return notFound();
  return json(resource(row, caller), 200);
};

interface ChangeInput {
  readonly change_id: string;
  readonly status: "open" | "closed";
  readonly subject: string;
  readonly site: boolean;
}

/** Exactly the browser's two fields and the attested identity WordPress adds. */
const parseChange = (body: string): ChangeInput | null => {
  let data: unknown;
  try { data = JSON.parse(body); } catch { return null; }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const fields = data as Record<string, unknown>;
  const keys = ["change_id", "status", "reporter_subject", "scope"];
  if (Object.keys(fields).length !== keys.length || !keys.every((key) => key in fields)) return null;
  const { change_id: changeId, status, reporter_subject: subject, scope } = fields;
  return typeof changeId === "string" && UUID4.test(changeId) && (status === "open" || status === "closed") &&
    typeof subject === "string" && UUID4.test(subject) && (scope === "mine" || scope === "site")
    ? { change_id: changeId, status, subject, site: scope === "site" } : null;
};

/** A change is answered with the change it names: 200 once delivered, otherwise 202. */
const changed = (row: Row, caller: Caller, change: StatusChange) =>
  json({ ...resource(row, caller), status_change: change }, change.delivery === "delivered" ? 200 : 202);

/**
 * `POST /v1/requests/{id}/status`: one Reporter close or reopen (ADR 0020),
 * idempotent per request and Change ID. It is accepted only after the create
 * was delivered and every earlier change resolved, so intents stay in order.
 * The Support status itself stays GitHub's.
 */
const changeStatus = async (storage: SlotStorage, caller: Caller, id: string, body: string, now: number): Promise<Response> => {
  const input = parseChange(body);
  if (!input) return invalid();
  const limited = await throttle(storage, input.subject, now);
  if (limited) return limited;
  if (!new RegExp(`^${SUPPORT_REQUEST_ID}$`).test(id)) return notFound();
  const current = async () => {
    const row = await storage.first<Row>(`${COLUMNS} AND r.id = ?2`, id);
    // Unknown and out-of-scope requests look the same; a site grant covers this installation only.
    return row && (input.site || row.reporter_subject === input.subject) ? row : null;
  };
  const named = () => storage.first<{ kind: string; state: string; change_id: string }>(`SELECT kind, state, change_id FROM delivery_intent
    WHERE slot = ?1 AND request_id = ?2 AND change_id = ?3`, id, input.change_id);
  const replay = (row: Row, intent: { kind: string; state: string; change_id: string }) => intent.kind === STATUS_KINDS[input.status]
    ? changed(row, caller, statusChange(intent.kind, intent.state, intent.change_id)) : error("gq_support_idempotency_conflict", 409);
  const row = await current();
  if (!row) return notFound();
  const existing = await named();
  if (existing) return replay(row, existing);
  if (caller.suspended) return error("gq_support_not_configured", 403);
  if (row.state !== "delivered" || row.status === null || row.tracking !== "active") return error("gq_support_change_not_allowed", 409);
  if (row.change_seq > 0 && !["delivered", "failed"].includes(row.change_state)) return error("gq_support_change_pending", 409);
  const seq = row.change_seq + 1;
  const kind = STATUS_KINDS[input.status];
  const budgets = [[STATUS_BUDGET + input.subject, STATUS_REPORTER_QUOTAS], [STATUS_BUDGET, STATUS_SLOT_QUOTAS]] as const;
  try {
    await storage.batch([
      ...budgets.map(([key, quotas]) => storage.debitIntake(key, now, quotas)),
      // Moves only from the value read above: a concurrent change makes it change nothing.
      storage.statement("UPDATE support_request SET change_seq = ?2 WHERE slot = ?1 AND id = ?3 AND change_seq = ?4", seq, id, row.change_seq),
      // Keep this INSERT immediately after that UPDATE: changes() fences a lost race by failing state's NOT NULL constraint.
      storage.statement(`INSERT INTO delivery_intent (slot, id, request_id, kind, seq, state, next_attempt_at,
        github_installation_id, environment, client_origin_label, default_developer, retry_deadline, change_id)
        VALUES (?1, ?2, ?3, ?4, ?5, CASE WHEN changes() = 1 THEN 'pending' END, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
      `int_${ulid(now)}`, id, kind, seq, now, caller.delivery?.githubInstallationId ?? null, caller.delivery?.environment ?? null,
      caller.delivery?.clientOriginLabel ?? null, caller.delivery?.defaultDeveloper ?? null, now + DAY, input.change_id),
      storage.statement("DELETE FROM intake_debit WHERE slot = ?1 AND debited_at <= ?2", now - DAY),
    ]);
  } catch {
    // The commit may have happened, or another change won: only a primary read can tell.
    try {
      const intent = await named();
      const latest = await current();
      if (intent && latest) return replay(latest, intent);
      if (latest && latest.change_seq !== row.change_seq) return error("gq_support_change_pending", 409);
      const wait = await quotaWait(storage, budgets, now);
      if (wait > 0) return error("gq_support_rate_limited", 429, { "Retry-After": String(Math.ceil(wait / 1000)) });
    } catch {
      return error("gq_support_outcome_unknown", 504);
    }
    return error("gq_support_not_accepted", 503);
  }
  return changed(row, caller, { change_id: input.change_id, status: input.status, delivery: "accepted-pending" });
};

const EXPORT_PAGE = 50;

/**
 * `GET /v1/export`: the attested Reporter's own requests in this Slot, oldest
 * first, including superseded ones. Only what the Reporter submitted, any
 * Report context the service still holds, and its outcome: no repository,
 * issue, digest, Submission ID or installation.
 */
export const handleExport = async (storage: SlotStorage, url: URL, body: string, now: number): Promise<Response> => {
  const params = queryOf(url, ["reporter_subject", "cursor"], ["reporter_subject"]);
  const subject = params?.get("reporter_subject");
  if (body !== "" || !params || !subject || !UUID4.test(subject)) return invalid();
  const cursor = params.get("cursor");
  const after = cursor === undefined ? [0, ""] as const : cursor.length <= CURSOR_CHARACTERS ? decodeCursor(cursor) : null;
  if (!after) return invalid();
  const limited = await throttle(storage, subject, now);
  if (limited) return limited;
  // Only the export reads the delivery-only context the service still holds.
  const rows = await storage.all<Row>(`SELECT ${FIELDS}, i.context_json ${FROM} AND r.reporter_subject = ?2 AND (r.created_at, r.id) > (?3, ?4)
    ORDER BY r.created_at, r.id LIMIT ?5`, subject, ...after, EXPORT_PAGE + 1);
  const items = rows.slice(0, EXPORT_PAGE);
  return json({
    items: items.map((row) => ({ id: row.id, summary: row.summary === "" ? null : row.summary, description: row.description,
      created_at: new Date(row.created_at).toISOString(), delivery: DELIVERY[row.state], status: row.state === "delivered" ? row.status : null,
      context: storedContext(row.context_json ?? null) })),
    next_cursor: rows.length > items.length ? encodeCursor(items[items.length - 1]!) : null,
  }, 200);
};

/**
 * `POST /v1/requests`, `GET /v1/requests`, `GET /v1/requests/{id}` and
 * `POST /v1/requests/{id}/status`, after authentication.
 */
export const handleSupportRequests = (request: Request, url: URL, body: string, storage: SlotStorage, caller: Caller, now: number): Promise<Response> => {
  // Scope comes from the key: a write names nothing in its query either.
  if (request.method === "POST") {
    if (url.search) return Promise.resolve(invalid());
    const changing = /^\/v1\/requests\/([^/]+)\/status$/.exec(url.pathname)?.[1];
    return changing === undefined ? create(storage, caller, body, now) : changeStatus(storage, caller, changing, body, now);
  }
  if (body !== "") return Promise.resolve(invalid());
  const id = /^\/v1\/requests\/([^/]+)$/.exec(url.pathname)?.[1];
  return id === undefined ? list(storage, caller, url, now) : read(storage, caller, url, id, now);
};

import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import create from "../../contract/fixtures/create.json";
import resources from "../../contract/fixtures/resources.json";
import { handleRequest } from "../src/installation-api.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { harness, signed, type Installation } from "./installation-client.ts";
import { localStage } from "./local-d1.ts";

// Isolation tests B and C (docs/research/cloudflare-isolation-and-alchemy-provisioning.md)
// and the Worker half of security tests 2, 3, 4, 7, 8 and 9 (docs/support-security-design.md).
// acme-shop/production and acme-shop/staging belong to one Client and share a
// repository; globex-site/production is another Client.
const mappings: readonly RepositoryMapping[] = [
  { slot: "acme-shop/production", client: "acme", project: "acme-shop", environment: "production", repositoryId: 42, defaultDeveloper: "dev" },
  { slot: "acme-shop/staging", client: "acme", project: "acme-shop", environment: "staging", repositoryId: 42, defaultDeveloper: "dev" },
  { slot: "globex-site/production", client: "globex", project: "globex-site", environment: "production", repositoryId: 77, defaultDeveloper: "dev" },
];

const REPORTER_1 = "11111111-1111-4111-8111-111111111111";
const REPORTER_2 = "22222222-2222-4222-8222-222222222222";
const SUBMISSION = "3f0c2a4e-6b1d-4c1e-9a55-0d8e3f2b7c11";
const submissionId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const PUBLIC_FIELDS = ["id", "submission_id", "title", "summary", "description", "created_at", "delivery", "status"];

let stage: Awaited<ReturnType<typeof localStage<"shared">>>;
let db: D1Database;
let clients: ReturnType<typeof harness>;
let production: Installation, staging: Installation, globex: Installation;
let logged: unknown[][];

beforeAll(async () => {
  stage = await localStage(["shared"]);
  db = stage.databases.shared;
  clients = harness(db, mappings);
});
afterAll(() => stage.dispose());
beforeEach(async () => {
  await db.batch(["request_rate", "intake_debit", "delivery_intent", "support_request", "replay", "enrollment_rate", "enrollment_code", "installation_key"]
    .map((table) => db.prepare(`DELETE FROM ${table}`)));
  production = await clients.enroll("acme-shop/production", "installation-a");
  staging = await clients.enroll("acme-shop/staging", "installation-b");
  globex = await clients.enroll("globex-site/production", "installation-c");
  logged = [];
  for (const method of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, method).mockImplementation((...args) => { logged.push(args); });
  }
});
afterEach(() => {
  // No report content, subjects or secrets in logs: nothing is logged at all.
  expect(logged).toEqual([]);
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const submit = (installation: Installation, fields: Record<string, unknown> = {}, subject = REPORTER_1) =>
  installation.send("POST", "/v1/requests", JSON.stringify({
    submission_id: SUBMISSION, description: "Checkout does nothing", reporter_subject: subject, scope: "mine", ...fields,
  }));
const query = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const list = (installation: Installation, subject = REPORTER_1, scope = "mine", extra: Record<string, string> = {}) =>
  installation.send("GET", `/v1/requests?${query({ reporter_subject: subject, scope, per_page: "20", ...extra })}`);
const read = (installation: Installation, id: string, subject = REPORTER_1, scope = "mine") =>
  installation.send("GET", `/v1/requests/${id}?${query({ reporter_subject: subject, scope })}`);
const ids = async (response: Response) => {
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: { id: string }[] }).items.map((item) => item.id);
};
const rows = async (table: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

describe("accepting a Support request", () => {
  it("records the request and its create intent, and returns accepted-pending with ownership metadata", async () => {
    const response = await submit(production, { summary: "  Checkout broken  " });
    expect(response.status).toBe(202);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const resource = await response.json() as Record<string, unknown>;
    expect(resource).toEqual({
      id: expect.stringMatching(/^req_[0-9A-HJKMNP-TV-Z]{26}$/), submission_id: SUBMISSION, title: "Checkout broken",
      summary: "Checkout broken", description: "Checkout does nothing", created_at: expect.any(String),
      delivery: "accepted-pending", status: null, installation_id: "installation-a", reporter_subject: REPORTER_1,
    });
    expect(new Date(resource.created_at as string).toISOString()).toBe(resource.created_at);
    const intent = await db.prepare("SELECT slot, kind, seq, state FROM delivery_intent").all();
    expect(intent.results).toEqual([{ slot: "acme-shop/production", kind: "create", seq: 0, state: "pending" }]);
    const stored = await db.prepare("SELECT slot, repository_id, installation_id FROM support_request").first();
    expect(stored).toEqual({ slot: "acme-shop/production", repository_id: 42, installation_id: "installation-a" });
  });

  it("replaces a failed own request only when its replacement is accepted", async () => {
    const { id } = await (await submit(production)).json() as { id: string };
    await db.prepare("UPDATE delivery_intent SET state = 'failed'").run();
    const replacement = { submission_id: submissionId(2), supersedes_id: id };
    const response = await submit(production, replacement);
    expect(response.status).toBe(202);
    const accepted = await response.json() as { id: string };
    expect(accepted.id).not.toBe(id);
    expect(await ids(await list(production))).toEqual([accepted.id]);
    expect((await read(production, id)).status).toBe(200);
    expect(await (await submit(production, replacement)).json()).toMatchObject({ id: accepted.id });
    expect((await submit(production, { ...replacement, supersedes_id: undefined })).status).toBe(409);
  });

  it("hides missing, out-of-scope and non-failed replacement targets equally", async () => {
    const { id } = await (await submit(production)).json() as { id: string };
    const replacement = { submission_id: submissionId(2), supersedes_id: id };
    for (const state of ["pending", "in_flight", "outcome_unknown", "delivered"]) {
      await db.prepare("UPDATE delivery_intent SET state = ?").bind(state).run();
      const response = await submit(production, replacement);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ code: "gq_support_not_found" });
    }
    await db.prepare("UPDATE delivery_intent SET state = 'failed'").run();
    for (const response of [
      await submit(production, replacement, REPORTER_2),
      await submit(staging, replacement),
      await submit(globex, replacement),
      await submit(production, { ...replacement, supersedes_id: "req_00000000000000000000000000" }),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ code: "gq_support_not_found" });
    }
    expect(await ids(await list(production))).toEqual([id]);
  });

  it("accepts only one concurrent replacement and rolls back the loser's quota", async () => {
    const { id } = await (await submit(production)).json() as { id: string };
    await db.prepare("UPDATE delivery_intent SET state = 'failed'").run();
    const results = await Promise.all([2, 3].map(n => submit(production, { submission_id: submissionId(n), supersedes_id: id })));
    expect(results.map(r => r.status).sort()).toEqual([202, 404]);
    const winner = await results.find(r => r.status === 202)!.json() as { id: string };
    expect(await ids(await list(production))).toEqual([winner.id]);
    // Original + replacement leave room for exactly three more in this window.
    for (const n of [4, 5, 6]) expect((await submit(production, { submission_id: submissionId(n) })).status).toBe(202);
    expect((await submit(production, { submission_id: submissionId(7) })).status).toBe(429);
  });

  it("rejects a conditional-update loser without recording a replacement or spending quota", async () => {
    const { id } = await (await submit(production)).json() as { id: string };
    await db.prepare("UPDATE delivery_intent SET state = 'failed'").run();
    const changedBeforeCommit = {
      prepare: db.prepare.bind(db),
      batch: async <T>(statements: Parameters<typeof db.batch>[0]) => {
        if (statements.length > 3) await db.prepare("UPDATE delivery_intent SET state = 'outcome_unknown'").run();
        return db.batch<T>(statements);
      },
    };
    const body = JSON.stringify({ submission_id: submissionId(2), description: "Replacement", reporter_subject: REPORTER_1, scope: "mine", supersedes_id: id });
    const response = await handleRequest(await signed(production.pair, "POST", "/v1/requests", body, production.keyId, production.installationId), changedBeforeCommit, mappings);
    expect(response.status).toBe(404);
    expect(await ids(await list(production))).toEqual([id]);
    for (const n of [3, 4, 5, 6]) expect((await submit(production, { submission_id: submissionId(n) })).status).toBe(202);
    expect((await submit(production, { submission_id: submissionId(7) })).status).toBe(429);
  });

  it("keeps the failed predecessor listed when replacement acceptance rolls back", async () => {
    const { id } = await (await submit(production)).json() as { id: string };
    await db.prepare("UPDATE delivery_intent SET state = 'failed'").run();
    const failedCommit = {
      prepare: db.prepare.bind(db),
      batch: async <T>(statements: Parameters<typeof db.batch>[0]) => {
        if (statements.length > 3) return db.batch<T>([...statements, db.prepare("INSERT INTO support_request (id) VALUES ('force-rollback')")]);
        return db.batch<T>(statements);
      },
    };
    const replacement = { submission_id: submissionId(2), description: "Replacement", reporter_subject: REPORTER_1, scope: "mine", supersedes_id: id };
    const response = await handleRequest(await signed(production.pair, "POST", "/v1/requests", JSON.stringify(replacement), production.keyId, production.installationId), failedCommit, mappings);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "gq_support_not_accepted" });
    expect(await ids(await list(production))).toEqual([id]);
    expect((await submit(production, replacement)).status).toBe(202);
    expect(await ids(await list(production))).not.toContain(id);
  });

  it("reconciles concurrent same-key replacement retries after a lost commit response", async () => {
    const { id } = await (await submit(production)).json() as { id: string };
    await db.prepare("UPDATE delivery_intent SET state = 'failed'").run();
    const replacement = { submission_id: submissionId(2), description: "Replacement", reporter_subject: REPORTER_1, scope: "mine", supersedes_id: id };
    const lostResponse = {
      prepare: db.prepare.bind(db),
      batch: async <T>(statements: Parameters<typeof db.batch>[0]) => {
        const result = await db.batch<T>(statements);
        if (statements.length > 3) throw new Error("lost acceptance response");
        return result;
      },
    };
    const response = await handleRequest(await signed(production.pair, "POST", "/v1/requests", JSON.stringify(replacement), production.keyId, production.installationId), lostResponse, mappings);
    expect(response.status).toBe(202);
    const accepted = await response.json() as { id: string };
    const retries = await Promise.all([submit(production, replacement), submit(production, replacement)]);
    for (const retry of retries) {
      expect(retry.status).toBe(202);
      expect(await retry.json()).toMatchObject({ id: accepted.id, delivery: "accepted-pending" });
    }
    expect(await ids(await list(production))).toEqual([accepted.id]);
  });

  it("derives the title from the first description line at a word boundary", async () => {
    const description = `${"word ".repeat(30).trim()}\nsecond line`;
    const resource = await (await submit(production, { description })).json() as { title: string; summary: unknown };
    expect(resource.summary).toBeNull();
    expect([...resource.title].length).toBeLessThanOrEqual(80);
    expect(resource.title).toMatch(/^word( word)*$/);
    expect(description.startsWith(resource.title)).toBe(true);
  });

  it("returns the existing request for a same-key retry, with a new authentication request ID, without a second intent", async () => {
    const first = await (await submit(production)).json() as { id: string };
    const retry = await submit(production, { description: "  Checkout does nothing\n" });
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ id: first.id, delivery: "accepted-pending" });
    expect(await rows("support_request")).toBe(1);
    expect(await rows("delivery_intent")).toBe(1);
    expect(await rows("intake_debit")).toBe(2);
  });

  it("returns 201 with a Location for a delivered replay, and the current outcome otherwise", async () => {
    const { id } = await (await submit(production)).json() as { id: string };
    await db.prepare("UPDATE delivery_intent SET state = 'outcome_unknown'").run();
    const unknown = await submit(production);
    expect(unknown.status).toBe(202);
    expect(await unknown.json()).toMatchObject({ delivery: "outcome-unknown", status: null });
    await db.prepare("UPDATE delivery_intent SET state = 'delivered'").run();
    await db.prepare("UPDATE support_request SET status = 'open', issue_id = 9, issue_number = 3").run();
    const delivered = await submit(production);
    expect(delivered.status).toBe(201);
    expect(delivered.headers.get("Location")).toBe(`/v1/requests/${id}`);
    const resource = await delivered.json() as Record<string, unknown>;
    expect(resource).toMatchObject({ delivery: "delivered", status: "open" });
    expect(Object.keys(resource).sort()).toEqual([...PUBLIC_FIELDS, "installation_id", "reporter_subject"].sort());
  });

  it("rejects the same key with a different body and keeps the original", async () => {
    await submit(production);
    const conflict = await submit(production, { description: "Something else" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ code: "gq_support_idempotency_conflict" });
    const summary = await submit(production, { summary: "Checkout does nothing" });
    expect(summary.status).toBe(409);
    expect(await rows("support_request")).toBe(1);
  });

  it("scopes the Submission ID to the Reporter and the Slot", async () => {
    const own = await (await submit(production)).json() as { id: string };
    const other = await (await submit(production, { description: "Different text" }, REPORTER_2)).json() as { id: string };
    const elsewhere = await (await submit(staging)).json() as { id: string };
    expect(new Set([own.id, other.id, elsewhere.id]).size).toBe(3);
    expect(await rows("support_request")).toBe(3);
  });

  it("accepts each valid shared create fixture and rejects each invalid one", async () => {
    // Padding cases test WordPress's 32 KiB browser cap; WordPress forwards compact JSON.
    for (const [index, fixture] of create.entries()) {
      if (fixture.padding > 0) continue;
      const payload = { ...fixture.payload } as Record<string, unknown>;
      if ("submission_id" in payload && payload.submission_id === SUBMISSION) payload.submission_id = submissionId(index);
      const response = await production.send("POST", "/v1/requests", JSON.stringify({
        ...payload, reporter_subject: index % 2 ? REPORTER_1 : REPORTER_2, scope: "mine",
      }));
      await db.prepare("DELETE FROM intake_debit").run();
      expect([fixture.name, response.status]).toEqual([fixture.name, fixture.status === 201 ? 202 : fixture.status]);
      if (response.status === 400) expect(await response.json()).toEqual({ code: "gq_support_invalid_request" });
    }
  });

  it("returns resources whose delivery and status pair is valid in the shared fixtures", async () => {
    const valid = resources.filter((fixture) => fixture.valid).map((fixture) => `${fixture.resource.delivery}/${fixture.resource.status}`);
    for (const [state, status] of [["pending", null], ["in_flight", null], ["failed", null], ["outcome_unknown", null], ["delivered", "open"], ["delivered", "closed"]]) {
      await db.prepare("UPDATE delivery_intent SET state = ?").bind(state).run();
      await db.prepare("UPDATE support_request SET status = ?").bind(status).run();
      const [id] = await ids(await list(production));
      if (!id) { await submit(production); continue; }
      const resource = await (await read(production, id)).json() as { delivery: string; status: string | null };
      expect(valid).toContain(`${resource.delivery}/${resource.status}`);
    }
  });

  it("accepts the longest description WordPress can send with escaped Unicode, and bounds larger bodies", async () => {
    // wp_json_encode() escapes each astral code point as a 12-byte surrogate pair.
    const emoji = JSON.stringify({ submission_id: SUBMISSION, summary: "😀".repeat(120), description: "😀".repeat(10_000),
      reporter_subject: REPORTER_1, scope: "mine" }).replace(/😀/g, "\\ud83d\\ude00");
    expect((await production.send("POST", "/v1/requests", emoji)).status).toBe(202);
    const oversized = JSON.stringify({ submission_id: SUBMISSION, description: "a".repeat(140_000), reporter_subject: REPORTER_1, scope: "mine" });
    expect((await production.send("POST", "/v1/requests", oversized)).status).toBe(413);
  });
});

describe("resource scope", () => {
  let mine: string, theirs: string;
  beforeEach(async () => {
    mine = ((await (await submit(production)).json()) as { id: string }).id;
    theirs = ((await (await submit(production, { description: "Other report" }, REPORTER_2)).json()) as { id: string }).id;
  });

  it("lists and reads only the Reporter's own requests by default", async () => {
    expect(await ids(await list(production))).toEqual([mine]);
    expect(await ids(await list(production, REPORTER_2))).toEqual([theirs]);
    expect((await read(production, mine)).status).toBe(200);
    const hidden = await read(production, theirs);
    const unknown = await read(production, "req_00000000000000000000000000");
    expect([hidden.status, unknown.status]).toEqual([404, 404]);
    expect(await hidden.json()).toEqual(await unknown.json());
  });

  it("lets an attested site grant read every request in its own Slot only", async () => {
    expect((await ids(await list(production, REPORTER_1, "site"))).sort()).toEqual([mine, theirs].sort());
    expect((await read(production, theirs, REPORTER_1, "site")).status).toBe(200);
    const items = ((await (await list(production, REPORTER_1, "site")).json()) as { items: Record<string, unknown>[] }).items;
    expect(items.map((item) => item.reporter_subject).sort()).toEqual([REPORTER_1, REPORTER_2]);
    expect(items.every((item) => item.installation_id === "installation-a")).toBe(true);
  });

  it("denies the same Client's other installation and another Client, even with the same subject or a site grant", async () => {
    for (const other of [staging, globex]) {
      expect(await ids(await list(other))).toEqual([]);
      expect(await ids(await list(other, REPORTER_1, "site"))).toEqual([]);
      expect((await read(other, mine, REPORTER_1, "site")).status).toBe(404);
    }
  });

  it("B: rejects scope named in the body or query, and ignores it in headers and Origin", async () => {
    for (const forged of [{ slot: "globex-site/production" }, { client: "globex" }, { repository_id: 77 }, { installation_id: "installation-c" }, { scope: "site" }]) {
      expect((await submit(production, { ...forged, submission_id: submissionId(9) })).status).toBe(400);
    }
    const forgedQueries: Record<string, string>[] = [{ slot: "globex-site/production" }, { client: "globex" }, { repository_id: "77" }, { installation_id: "installation-c" }];
    for (const forged of forgedQueries) {
      expect((await list(globex, REPORTER_1, "site", forged)).status).toBe(400);
      expect((await globex.send("GET", `/v1/requests/${mine}?${query({ reporter_subject: REPORTER_1, scope: "site", ...forged })}`)).status).toBe(400);
    }
    const createBody = JSON.stringify({ submission_id: submissionId(9), description: "Report", reporter_subject: REPORTER_1, scope: "mine" });
    expect((await globex.send("POST", "/v1/requests?slot=acme-shop%2Fproduction", createBody)).status).toBe(400);
    const headers = { "GQ-Support-Slot": "acme-shop/production", "GQ-Support-Client": "acme", Origin: "https://shop.example" };
    expect(await ids(await globex.send("GET", `/v1/requests?${query({ reporter_subject: REPORTER_1, scope: "site", per_page: "20" })}`, "", headers))).toEqual([]);
    expect(await rows("support_request")).toBe(2);
  });

  it("keeps a tampered cursor inside the caller's scope", async () => {
    const page = await (await list(production, REPORTER_2, "mine", { per_page: "1" })).json() as { next_cursor: string | null };
    expect(page.next_cursor).toBeNull();
    const forged = Buffer.from(`${Number.MAX_SAFE_INTEGER}:${"req_ZZZZZZZZZZZZZZZZZZZZZZZZZZ"}`).toString("base64url");
    expect(await ids(await list(production, REPORTER_2, "mine", { cursor: forged }))).toEqual([theirs]);
    expect((await list(production, REPORTER_2, "mine", { cursor: "not a cursor" })).status).toBe(400);
  });

  it("C: rejects a revoked key immediately and leaves other Slots unaffected", async () => {
    await clients.operator("revoke", "acme-shop/production");
    expect((await list(production)).status).toBe(403);
    expect((await submit(production, { submission_id: submissionId(5) })).status).toBe(403);
    expect(await ids(await list(staging))).toEqual([]);
    expect((await submit(globex)).status).toBe(202);
  });

  it("keeps the Slot's requests across re-enrollment, and denies the replaced key", async () => {
    const renamed = await clients.enroll("acme-shop/production", "installation-a2");
    expect((await list(production)).status).toBe(403);
    const items = ((await (await list(renamed)).json()) as { items: Record<string, unknown>[] }).items;
    expect(items).toEqual([expect.objectContaining({ id: mine, installation_id: "installation-a2" })]);
  });

  it("confines a stolen key to its own installation and rejects unsigned use", async () => {
    const path = `/v1/requests?${query({ reporter_subject: REPORTER_1, scope: "site", per_page: "20" })}`;
    const asGlobex = await signed(production.pair, "GET", path, "", production.keyId, "installation-c");
    expect((await handleRequest(asGlobex, db, mappings)).status).toBe(403);
    const withGlobexKey = await signed(production.pair, "GET", path, "", globex.keyId, "installation-c");
    expect((await handleRequest(withGlobexKey, db, mappings)).status).toBe(403);
    const unsigned = new Request(`https://support.example${path}`, {
      headers: { "GQ-Support-Key-Id": production.keyId, "GQ-Support-Installation-Id": "installation-a" },
    });
    expect((await handleRequest(unsigned, db, mappings)).status).toBe(403);
  });

  it("rejects a replayed request without a second side effect", async () => {
    const replayable = await signed(production.pair, "POST", "/v1/requests",
      JSON.stringify({ submission_id: submissionId(7), description: "Once", reporter_subject: REPORTER_1, scope: "mine" }),
      production.keyId, production.installationId);
    expect((await handleRequest(replayable.clone(), db, mappings)).status).toBe(202);
    expect((await handleRequest(replayable, db, mappings)).status).toBe(403);
    expect(await rows("support_request")).toBe(3);
  });

  it("validates list pagination and returns newest first", async () => {
    expect(await ids(await list(production, REPORTER_1, "site", { per_page: "1" }))).toHaveLength(1);
    const first = await (await list(production, REPORTER_1, "site", { per_page: "1" })).json() as { items: { id: string }[]; next_cursor: string };
    const second = await (await list(production, REPORTER_1, "site", { per_page: "1", cursor: first.next_cursor })).json() as { items: { id: string }[]; next_cursor: string | null };
    expect([first.items[0]!.id, second.items[0]!.id]).toEqual([theirs, mine]);
    expect(second.next_cursor).toBeNull();
    for (const perPage of ["0", "51", "1.5", "x"]) {
      expect((await list(production, REPORTER_1, "mine", { per_page: perPage })).status).toBe(400);
    }
    expect((await list(production, REPORTER_1, "everyone")).status).toBe(400);
    expect((await list(production, "not-a-subject")).status).toBe(400);
    expect((await production.send("GET", `/v1/requests?${query({ scope: "mine", per_page: "20" })}`)).status).toBe(400);
  });

  it("has no comment, receipt or attachment routes", async () => {
    for (const path of [`/v1/requests/${mine}/comments`, `/v1/requests/${mine}/attachments`, "/v1/receipts", `/v1/requests/${mine}/receipt`]) {
      expect((await production.send("GET", `${path}?${query({ reporter_subject: REPORTER_1, scope: "site" })}`)).status).toBe(404);
    }
  });
});

describe("intake quotas", () => {
  const at = (ms: number) => vi.useFakeTimers({ toFake: ["Date"], now: ms });
  const T0 = Date.UTC(2026, 9, 16, 12);
  const many = (installation: Installation, count: number, subject: (n: number) => string, offset = 0) =>
    Promise.all(Array.from({ length: count }, (_, n) =>
      submit(installation, { submission_id: submissionId(offset + n), description: `Report ${offset + n}` }, subject(n))));
  const statuses = (responses: Response[]) => responses.map((response) => response.status).sort();

  it("allows exactly five concurrent creates per Reporter in ten minutes, without debiting same-key replays", async () => {
    at(T0);
    const results = await many(production, 8, () => REPORTER_1);
    expect(statuses(results)).toEqual([202, 202, 202, 202, 202, 429, 429, 429]);
    const limited = results.find((response) => response.status === 429)!;
    expect(limited.headers.get("Retry-After")).toBe("600");
    expect(await limited.json()).toEqual({ code: "gq_support_rate_limited" });
    const accepted = await db.prepare("SELECT submission_id, description FROM support_request").all<{ submission_id: string; description: string }>();
    expect(accepted.results).toHaveLength(5);
    const replay = accepted.results[0]!;
    expect((await submit(production, { submission_id: replay.submission_id, description: replay.description })).status).toBe(202);
    expect((await submit(production, { submission_id: submissionId(99) }, REPORTER_2)).status).toBe(202);
    at(T0 + 600_001);
    expect((await submit(production, { submission_id: submissionId(98) })).status).toBe(202);
  });

  it("allows twenty creates per Reporter in a rolling day", async () => {
    for (let window = 0; window < 4; window += 1) {
      at(T0 + window * 600_000);
      expect(statuses(await many(production, 5, () => REPORTER_1, window * 5))).toEqual(Array(5).fill(202));
    }
    at(T0 + 4 * 600_000);
    const limited = await submit(production, { submission_id: submissionId(50) });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("Retry-After"))).toBe(86_400 - 4 * 600);
    at(T0 + 86_400_001);
    expect((await submit(production, { submission_id: submissionId(51) })).status).toBe(202);
  });

  it("limits the Slot to twenty in ten minutes and a hundred a day, across Reporters and re-enrollment", async () => {
    const subject = (n: number) => `00000000-0000-4000-8000-${String(1000 + n).padStart(12, "0")}`;
    at(T0);
    expect(statuses(await many(production, 24, (n) => subject(n % 6)))).toEqual([...Array(20).fill(202), ...Array(4).fill(429)]);
    expect((await submit(staging)).status).toBe(202);
    let installation = production;
    for (let window = 1; window < 5; window += 1) {
      at(T0 + window * 600_000);
      installation = await clients.enroll("acme-shop/production", `installation-a${window}`);
      expect(statuses(await many(installation, 20, (n) => subject(window * 20 + n), window * 20))).toEqual(Array(20).fill(202));
    }
    at(T0 + 5 * 600_000);
    expect((await submit(installation, { submission_id: submissionId(500) }, subject(500))).status).toBe(429);
    expect(await rows("support_request")).toBe(101);
  }, 30_000);

  it("rejects new creates without claiming acceptance when the quota store is unavailable", async () => {
    const failing = {
      prepare: (sql: string) => {
        if (sql.includes("intake_debit")) throw new Error("SECRET quota diagnostic");
        return db.prepare(sql);
      },
      batch: db.batch.bind(db),
    };
    const request = await signed(production.pair, "POST", "/v1/requests",
      JSON.stringify({ submission_id: SUBMISSION, description: "SECRET report", reporter_subject: REPORTER_1, scope: "mine" }),
      production.keyId, production.installationId);
    const response = await handleRequest(request, failing, mappings);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ code: "gq_support_not_accepted" });
    expect(await rows("support_request")).toBe(0);
    expect((await list(production)).status).toBe(200);
  });

  it("resolves an ambiguous commit by same-key lookup, and reports an unresolved one as unknown", async () => {
    const body = JSON.stringify({ submission_id: SUBMISSION, description: "Report", reporter_subject: REPORTER_1, scope: "mine" });
    const committedThenLost = {
      prepare: db.prepare.bind(db),
      batch: async <T>(statements: Parameters<typeof db.batch>[0]) => {
        const results = await db.batch<T>(statements);
        if (statements.length > 2) throw new Error("network reset after commit");
        return results;
      },
    };
    const lost = await handleRequest(await signed(production.pair, "POST", "/v1/requests", body, production.keyId, "installation-a"), committedThenLost, mappings);
    expect(lost.status).toBe(202);
    expect(await lost.json()).toMatchObject({ submission_id: SUBMISSION, delivery: "accepted-pending" });

    let lookups = 0;
    const unresolved = {
      prepare: (sql: string) => {
        if (sql.includes("submission_id = ?") && ++lookups > 1) throw new Error("primary unavailable");
        return db.prepare(sql);
      },
      batch: async <T>(statements: Parameters<typeof db.batch>[0]) => {
        if (statements.length > 2) throw new Error("timeout");
        return db.batch<T>(statements);
      },
    };
    const body2 = JSON.stringify({ submission_id: submissionId(2), description: "Report", reporter_subject: REPORTER_1, scope: "mine" });
    const unknown = await handleRequest(await signed(production.pair, "POST", "/v1/requests", body2, production.keyId, "installation-a"), unresolved, mappings);
    expect(unknown.status).toBe(504);
    expect(await unknown.json()).toEqual({ code: "gq_support_outcome_unknown" });
  });
});

describe("request budget", () => {
  // Every list, read and create spends from it, so same-key lookups stay bounded.
  const T0 = Date.UTC(2026, 9, 16, 12, 5);
  const windowStart = Date.UTC(2026, 9, 16, 12);
  const spent = (subject: string, requests: number, slot = "acme-shop/production") =>
    db.prepare("INSERT INTO request_rate (slot, subject, window_start, requests) VALUES (?, ?, ?, ?)")
      .bind(slot, subject, windowStart, requests).run();

  it("allows 120 requests per Reporter in a ten-minute window, then 429 until it ends", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: T0 });
    await spent(REPORTER_1, 119);
    expect((await list(production)).status).toBe(200);
    const limited = await list(production);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("300");
    expect(await limited.json()).toEqual({ code: "gq_support_rate_limited" });
    expect((await read(production, "req_00000000000000000000000000")).status).toBe(429);
    expect((await list(production, REPORTER_2)).status).toBe(200);
    vi.setSystemTime(windowStart + 600_000);
    expect((await list(production)).status).toBe(200);
  });

  it("counts same-key create replays and rejects new creates over budget without accepting them", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: T0 });
    expect((await submit(production)).status).toBe(202);
    await db.prepare("UPDATE request_rate SET requests = 120 WHERE subject = ?").bind(REPORTER_1).run();
    expect((await submit(production)).status).toBe(429);
    expect((await submit(production, { submission_id: submissionId(3) })).status).toBe(429);
    expect(await rows("support_request")).toBe(1);
    expect(await rows("intake_debit")).toBe(2);
  });

  it("allows 600 requests per Slot across Reporters, without affecting other Slots", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: T0 });
    await spent("", 599);
    expect((await list(production, REPORTER_2, "site")).status).toBe(200);
    expect((await list(production)).status).toBe(429);
    expect((await list(staging)).status).toBe(200);
  });

  it("keeps serving reads when the request counter is unavailable", async () => {
    const failing = {
      prepare: (sql: string) => {
        if (sql.includes("request_rate")) throw new Error("counter unavailable");
        return db.prepare(sql);
      },
      batch: db.batch.bind(db),
    };
    const path = `/v1/requests?${query({ reporter_subject: REPORTER_1, scope: "mine", per_page: "20" })}`;
    const response = await handleRequest(await signed(production.pair, "GET", path, "", production.keyId, "installation-a"), failing, mappings);
    expect(response.status).toBe(200);
  });
});

describe("key rotation races", () => {
  it("accepts in-flight creates with the old key either fully or not at all, and the new key sees every accepted one", async () => {
    const creates = Array.from({ length: 12 }, (_, n) =>
      submit(production, { submission_id: submissionId(n), description: `Report ${n}` }, `00000000-0000-4000-8000-00000000000${n % 4}`));
    const [rotated, ...results] = await Promise.all([clients.enroll("acme-shop/production", "installation-a"), ...creates]);
    const statuses = results.map((response) => response.status);
    expect(statuses.filter((status) => status !== 202 && status !== 403)).toEqual([]);
    const accepted = statuses.filter((status) => status === 202).length;
    expect(await rows("support_request")).toBe(accepted);
    expect(await rows("delivery_intent")).toBe(accepted);
    expect(await ids(await list(rotated, REPORTER_1, "site", { per_page: "50" }))).toHaveLength(accepted);
    expect((await list(production)).status).toBe(403);
  });

  it("leaves exactly one active key when two enrollments into one Slot race", async () => {
    const [a, b] = await Promise.all([
      clients.enroll("acme-shop/production", "installation-a"),
      clients.enroll("acme-shop/production", "installation-a"),
    ]);
    const active = await db.prepare("SELECT key_id FROM installation_key WHERE slot = 'acme-shop/production' AND revoked_at IS NULL").all<{ key_id: string }>();
    expect(active.results).toHaveLength(1);
    const winner = active.results[0]!.key_id === a.keyId ? a : b;
    const loser = winner === a ? b : a;
    expect([(await list(winner)).status, (await list(loser)).status, (await list(production)).status]).toEqual([200, 403, 403]);
  });
});

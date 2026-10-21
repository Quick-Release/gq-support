import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fixtures from "../../contract/fixtures/context.json";
import { CONTEXT_LIMITS, canonicalContext } from "../src/report-context.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { harness, type Installation } from "./installation-client.ts";
import { localStage } from "./local-d1.ts";

// Report context at the service boundary (docs/support-context-design.md, acceptance cases 2, 5, 7 and 10).
const mappings: readonly RepositoryMapping[] = [
  { slot: "acme-shop/production", client: "acme", project: "acme-shop", environment: "production", repositoryId: 42, defaultDeveloper: "dev" },
  { slot: "acme-shop/staging", client: "acme", project: "acme-shop", environment: "staging", repositoryId: 42, defaultDeveloper: "dev" },
];
const REPORTER = "11111111-1111-4111-8111-111111111111";
const OTHER_REPORTER = "22222222-2222-4222-8222-222222222222";
const SUBMISSION = "3f0c2a4e-6b1d-4c1e-9a55-0d8e3f2b7c11";
const submissionId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const CONTEXT = { schema: 1, default: { wp_version: "6.5.5", support_plugin_version: "0.1.8", originating_screen: "post-editor" } };
const PUBLIC_FIELDS = ["id", "submission_id", "title", "summary", "description", "created_at", "delivery", "status"];

let stage: Awaited<ReturnType<typeof localStage<"shared">>>;
let db: D1Database;
let production: Installation, staging: Installation;
let logged: unknown[][];

/** A fresh Slot pair in a local D1 for each test of the HTTP boundary. */
const withService = () => {
  beforeAll(async () => {
    stage = await localStage(["shared"]);
    db = stage.databases.shared;
  });
  afterAll(() => stage.dispose());
  beforeEach(async () => {
    await db.batch(["request_rate", "intake_debit", "delivery_intent", "support_request", "replay", "enrollment_rate", "enrollment_code", "installation_key"]
      .map((table) => db.prepare(`DELETE FROM ${table}`)));
    const clients = harness(db, mappings);
    production = await clients.enroll("acme-shop/production", "installation-a");
    staging = await clients.enroll("acme-shop/staging", "installation-b");
    logged = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args) => { logged.push(args); });
    }
  });
  afterEach(() => {
    // Context is never logged: nothing is logged at all.
    expect(logged).toEqual([]);
    vi.restoreAllMocks();
  });
};

/** The create body WordPress forwards: the browser fields, the attested identity, and no review envelope. */
const forwarded = (fields: Record<string, unknown> = {}, subject = REPORTER) => JSON.stringify({
  submission_id: SUBMISSION, description: "Checkout does nothing", reporter_subject: subject, scope: "mine", context: CONTEXT, ...fields,
});
const submit = (fields: Record<string, unknown> = {}, subject = REPORTER, installation = production) =>
  installation.send("POST", "/v1/requests", forwarded(fields, subject));
const stored = async () => (await db.prepare("SELECT context_json FROM delivery_intent").all<{ context_json: string | null }>()).results
  .map((row) => row.context_json);
const count = async (table: string) => (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
const sha256 = async (text: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
  (byte) => byte.toString(16).padStart(2, "0")).join("");

describe("the shared context schema", () => {
  it("agrees with WordPress on every limit", () => {
    expect(CONTEXT_LIMITS).toEqual({
      schema: fixtures.limits.schema, scalarBytes: fixtures.limits.scalar_bytes, contextBytes: fixtures.limits.context_bytes,
      defaultKeys: fixtures.limits.default_keys, createBodyBytes: fixtures.limits.create_body_bytes,
    });
  });

  it.each(fixtures.cases.map((fixture) => [fixture.name, fixture] as const))("normalizes or rejects: %s", (_, fixture) => {
    expect(canonicalContext(fixture.context)).toBe("canonical" in fixture ? fixture.canonical : null);
  });
});

describe("the create schema", () => {
  withService();

  it("accepts each valid shared context at create and rejects each invalid one without recording anything", async () => {
    for (const [index, fixture] of fixtures.cases.entries()) {
      const response = await submit({ submission_id: submissionId(index), context: fixture.context });
      await db.prepare("DELETE FROM intake_debit").run();
      expect([fixture.name, response.status]).toEqual([fixture.name, "canonical" in fixture ? 202 : 400]);
      if (response.status === 400) expect(await response.json()).toEqual({ code: "gq_support_invalid_request" });
    }
    expect(await stored()).toEqual(fixtures.cases.filter((fixture) => "canonical" in fixture).map((fixture) => fixture.canonical));
  });
});

describe("accepting a request with Report context", () => {
  withService();
  it("freezes the canonical reviewed context with the create intent and keeps it out of every projection", async () => {
    const response = await submit({ context: { default: { originating_screen: "post-editor", wp_version: "6.5.5" }, schema: 1 } });
    expect(response.status).toBe(202);
    const resource = await response.json() as Record<string, unknown>;
    expect(Object.keys(resource).sort()).toEqual([...PUBLIC_FIELDS, "installation_id", "reporter_subject"].sort());
    expect(await stored()).toEqual(['{"schema":1,"default":{"wp_version":"6.5.5","originating_screen":"post-editor"}}']);
    const list = await production.send("GET", `/v1/requests?reporter_subject=${REPORTER}&scope=mine`);
    const read = await production.send("GET", `/v1/requests/${resource.id}?reporter_subject=${REPORTER}&scope=site`);
    for (const body of [JSON.stringify(await list.json()), JSON.stringify(await read.json())]) {
      expect(body).not.toContain("context");
      expect(body).not.toContain("6.5.5");
      expect(body).not.toContain("post-editor");
    }
  });

  it("replays the exact frozen intent, in any key order, without a second intent", async () => {
    const { id } = await (await submit()).json() as { id: string };
    const reordered = { default: { originating_screen: "post-editor", support_plugin_version: "0.1.8", wp_version: "6.5.5" }, schema: 1 };
    const retry = await submit({ context: reordered });
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({ id });
    expect(await count("delivery_intent")).toBe(1);
  });

  it("conflicts when a retry changes, removes or adds context, and keeps the original", async () => {
    await submit();
    const upgraded = { ...CONTEXT, default: { ...CONTEXT.default, wp_version: "6.6.0" } };
    const removed = { schema: 1, default: { wp_version: "6.5.5", support_plugin_version: "0.1.8" } };
    for (const context of [upgraded, removed, { schema: 1, default: {} }, undefined]) {
      const conflict = await submit({ context });
      expect(conflict.status).toBe(409);
      expect(await conflict.json()).toEqual({ code: "gq_support_idempotency_conflict" });
    }
    expect(await stored()).toEqual([JSON.stringify(CONTEXT)]);
    await submit({ submission_id: submissionId(2), context: undefined });
    expect((await submit({ submission_id: submissionId(2) })).status).toBe(409);
  });

  it("keeps a context-free intent free of context, and reconciles one accepted before context existed", async () => {
    // A row accepted by the earlier service, with its fingerprint of only the Summary and Description.
    await db.prepare(`INSERT INTO support_request (id, slot, reporter_subject, submission_id, body_digest, summary, description, title,
      created_at, installation_id, repository_id) VALUES ('req_01J8Z6Q4M1ZC7X000000000000', 'acme-shop/production', ?, ?, ?, '',
      'Checkout does nothing', 'Checkout does nothing', 1, 'installation-a', 42)`)
      .bind(REPORTER, SUBMISSION, await sha256(JSON.stringify([null, "Checkout does nothing"]))).run();
    await db.prepare(`INSERT INTO delivery_intent (id, slot, request_id, kind, seq, state, retry_deadline)
      VALUES ('int_01J8Z6Q4M1ZC7X000000000000', 'acme-shop/production', 'req_01J8Z6Q4M1ZC7X000000000000', 'create', 0, 'pending', 1)`).run();
    const legacy = await submit({ context: undefined });
    expect(legacy.status).toBe(202);
    expect(await legacy.json()).toMatchObject({ id: "req_01J8Z6Q4M1ZC7X000000000000" });
    expect((await submit()).status).toBe(409);
    expect((await submit({ submission_id: submissionId(2), context: undefined })).status).toBe(202);
    expect(await stored()).toEqual([null, null]);
  });

  it("scopes a Submission ID with context to the Reporter and the Slot", async () => {
    await submit();
    expect((await submit({}, OTHER_REPORTER)).status).toBe(202);
    expect((await submit({}, REPORTER, staging)).status).toBe(202);
    expect(await count("support_request")).toBe(3);
  });

  it("caps a create carrying context at 32 KiB including the attested identity", async () => {
    // Four-byte characters reach the byte cap within the Description's character limit.
    const at = (bytes: number) => {
      const extra = bytes - new TextEncoder().encode(forwarded({ description: "" })).byteLength;
      return forwarded({ description: "😀".repeat(Math.floor(extra / 4)) + "a".repeat(extra % 4) });
    };
    expect(new TextEncoder().encode(at(32_768)).byteLength).toBe(32_768);
    expect((await production.send("POST", "/v1/requests", at(32_769).replace(SUBMISSION, submissionId(2)))).status).toBe(413);
    expect((await production.send("POST", "/v1/requests", at(32_768))).status).toBe(202);
    // Text within its character limit still counts in UTF-8 bytes.
    const multibyte = forwarded({ submission_id: submissionId(3), description: "😀".repeat(8_200) });
    expect(new TextEncoder().encode(multibyte).byteLength).toBeGreaterThan(32_768);
    expect((await production.send("POST", "/v1/requests", multibyte)).status).toBe(413);
    expect(await count("support_request")).toBe(1);
  });
});

describe("reconciling after the review envelope expired", () => {
  withService();
  it("returns the accepted intent for an exact replay, and conflicts for a changed one", async () => {
    const { id } = await (await submit()).json() as { id: string };
    const replay = await submit({ reconcile_only: true });
    expect(replay.status).toBe(202);
    expect(await replay.json()).toMatchObject({ id, delivery: "accepted-pending" });
    await db.prepare("UPDATE delivery_intent SET state = 'delivered', context_json = NULL").run();
    await db.prepare("UPDATE support_request SET status = 'open', issue_id = 9, issue_number = 3").run();
    expect((await submit({ reconcile_only: true })).status).toBe(201);
    const changed = await submit({ reconcile_only: true, context: { schema: 1, default: { wp_version: "6.6.0" } } });
    expect(changed.status).toBe(409);
  });

  it("never accepts a new intent", async () => {
    const response = await submit({ reconcile_only: true });
    expect(response.status).toBe(412);
    expect(await response.json()).toEqual({ code: "gq_support_context_expired" });
    expect(await count("support_request")).toBe(0);
    expect(await count("intake_debit")).toBe(0);
    expect((await submit()).status).toBe(202);
  });

  it("accepts only true as the reconciliation flag", async () => {
    for (const flag of [false, "true", 1, null]) expect((await submit({ reconcile_only: flag })).status).toBe(400);
    expect(await count("support_request")).toBe(0);
  });
});

import type { D1Database } from "@cloudflare/workers-types";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createStorageFor, type SlotRegistry } from "../src/storage.ts";
import { localStage } from "./local-d1.ts";

// Client acme has two Slots (production and staging) that share one
// repository; Client globex has one Slot. Isolation tests A, D and E from
// docs/research/cloudflare-isolation-and-alchemy-provisioning.md.
const registry: SlotRegistry = new Map([
  ["acme-shop/production", { client: "acme" }],
  ["acme-shop/staging", { client: "acme" }],
  ["globex-site/production", { client: "globex" }],
]);

const insertRequest = `INSERT INTO support_request
  (slot, id, reporter_subject, submission_id, body_digest, summary, description, title, created_at, installation_id, repository_id)
  VALUES (?1, ?2, ?3, ?4, 'digest', '', ?5, ?5, ?6, 'inst', 42)`;

let stage: Awaited<ReturnType<typeof localStage<"SupportDB" | "SupportDBAcme">>>;
let shared: D1Database;

beforeAll(async () => {
  stage = await localStage(["SupportDB", "SupportDBAcme"]);
  shared = stage.databases.SupportDB;
});
afterAll(() => stage.dispose());
beforeEach(async () => {
  for (const db of Object.values(stage.databases)) {
    await db.batch([db.prepare("DELETE FROM delivery_intent"), db.prepare("DELETE FROM support_request")]);
  }
});

const insertIntent = `INSERT INTO delivery_intent (slot, id, request_id, kind, seq, state)
  VALUES (?1, ?2, ?3, 'create', 0, 'pending')`;

const storageFor = (slot: string) =>
  createStorageFor({ slots: registry, shared, dedicated: {} })(slot);

const seed = async (slot: string, id: string, text: string) => {
  const storage = storageFor(slot);
  await storage.run(insertRequest, id, "subject-1", "sub-1", text, 1);
};

describe("storageFor", () => {
  it("A: reads only the caller's Slot, even with a shared subject, Submission ID and repository", async () => {
    await seed("acme-shop/production", "req_a", "from production");
    await seed("acme-shop/staging", "req_b", "from staging");
    await seed("globex-site/production", "req_c", "from globex");

    const storage = storageFor("acme-shop/production");
    const rows = await storage.all<{ id: string }>(
      "SELECT id FROM support_request WHERE slot = ?1 AND submission_id = ?2",
      "sub-1",
    );

    expect(rows.map((row) => row.id)).toEqual(["req_a"]);
  });

  it("binds the Slot itself, so a caller cannot pass another Slot as ?1", async () => {
    await seed("globex-site/production", "req_c", "from globex");

    const storage = storageFor("acme-shop/production");
    const rows = await storage.all(
      "SELECT id FROM support_request WHERE slot = ?1 AND slot = ?2",
      "globex-site/production",
    );

    expect(rows).toEqual([]);
  });

  it.each([
    ["a SELECT without a Slot predicate", "SELECT id FROM support_request"],
    ["a Slot predicate on another placeholder", "SELECT id FROM support_request WHERE slot = ?2"],
    ["an UPDATE without a Slot predicate", "UPDATE support_request SET tracking = 'lost' WHERE id = ?2"],
    ["a DELETE without a Slot predicate", "DELETE FROM support_request WHERE id = ?2"],
    ["an INSERT that does not start with the Slot", "INSERT INTO support_request (id, slot) VALUES (?2, ?1)"],
    ["an INSERT … SELECT", "INSERT INTO support_request (slot, id) SELECT ?1, id FROM support_request"],
    ["an OR that escapes the Slot predicate", "SELECT id FROM support_request WHERE slot = ?1 AND id = ?2 OR 1 = 1"],
    ["a Slot predicate only inside a subquery", "SELECT id FROM support_request WHERE id IN (SELECT id FROM support_request WHERE slot = ?1)"],
    ["a multi-row INSERT", "INSERT INTO support_request (slot, id) VALUES (?1, ?2), ('globex-site/production', ?3)"],
    ["an UPDATE that moves rows to another Slot", "UPDATE support_request SET slot = ?2 WHERE slot = ?1 AND id = ?3"],
    ["an upsert that rewrites the Slot", "INSERT INTO support_request (slot, id) VALUES (?1, ?2) ON CONFLICT DO UPDATE SET slot = 'x'"],
    ["a comma join scoped on one side only", "SELECT a.description FROM support_request a, support_request b WHERE b.slot = ?1"],
    ["a JOIN scoped on one side only", "SELECT a.description FROM support_request a JOIN support_request b ON 1 = 1 WHERE b.slot = ?1"],
    ["a scalar subquery", "SELECT (SELECT description FROM support_request LIMIT 1) FROM support_request WHERE slot = ?1"],
    ["an UPDATE … FROM", "UPDATE support_request SET title = d.state FROM delivery_intent d WHERE slot = ?1"],
    ["a Slot predicate inside a parenthesised OR", "SELECT id FROM support_request WHERE id = ?2 AND (1 = 1 OR id AND slot = ?1 AND 1 = 1)"],
    ["an upsert that rewrites the Slot in a row value", "INSERT INTO support_request (slot, id) VALUES (?1, ?2) ON CONFLICT DO UPDATE SET (slot, id) = ('x', 'y')"],
    ["a WITH clause", "WITH x AS (SELECT * FROM support_request) SELECT * FROM x WHERE slot = ?1"],
  ])("D: rejects %s", async (_, sql) => {
    const storage = storageFor("acme-shop/production");

    expect(() => storage.statement(sql)).toThrow(/Slot predicate/);
  });

  it("rejects a Slot that is not in the registry", () => {
    expect(() => storageFor("unknown/production")).toThrow(/Unknown Slot/);
  });

  it.each([
    [
      "the Reporter list, joined and scoped on both tables",
      `SELECT r.id FROM support_request r JOIN delivery_intent i ON i.request_id = r.id AND i.seq = 0
       WHERE r.slot = ?1 AND i.slot = ?1 AND r.reporter_subject = ?2 AND r.superseded_at IS NULL
         AND (r.created_at, r.id) < (?3, ?4)
       ORDER BY r.created_at DESC, r.id DESC LIMIT ?5`,
    ],
    ["an idempotent insert", "INSERT INTO support_request (slot, id) VALUES (?1, ?2) ON CONFLICT (slot, reporter_subject, submission_id) DO NOTHING"],
    ["a conditional update", "UPDATE delivery_intent SET state = 'in_flight' WHERE slot = ?1 AND id = ?2 AND state = 'pending'"],
    ["a predicate that is not first", "SELECT id FROM support_request WHERE id = ?2 AND slot = ?1"],
  ])("D: accepts %s", (_, sql) => {
    const storage = storageFor("acme-shop/production");

    expect(() => storage.statement(sql)).not.toThrow();
  });

  it("accepts a Support request and its delivery intent in one batch", async () => {
    const storage = storageFor("acme-shop/production");

    await storage.batch([
      storage.statement(insertRequest, "req_a", "subject-1", "sub-1", "text", 1),
      storage.statement(insertIntent, "int_a", "req_a"),
    ]);

    expect(
      await storage.all("SELECT id FROM delivery_intent WHERE slot = ?1"),
    ).toEqual([{ id: "int_a" }]);
  });

  it("rejects a delivery intent whose Slot differs from its request's", async () => {
    await seed("acme-shop/production", "req_a", "text");

    await expect(
      storageFor("globex-site/production").run(insertIntent, "int_a", "req_a"),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  it("E: routes a Client with a dedicated database there, and other Clients to the shared one", async () => {
    const storageFor = createStorageFor({
      slots: registry,
      shared,
      dedicated: { acme: stage.databases.SupportDBAcme },
    });
    const ids = (slot: string) =>
      storageFor(slot).all("SELECT id FROM support_request WHERE slot = ?1");

    await storageFor("acme-shop/production").run(insertRequest, "req_a", "subject-1", "sub-1", "a", 1);
    await storageFor("acme-shop/staging").run(insertRequest, "req_b", "subject-1", "sub-1", "b", 1);
    await storageFor("globex-site/production").run(insertRequest, "req_c", "subject-1", "sub-1", "c", 1);

    expect(await ids("acme-shop/production")).toEqual([{ id: "req_a" }]);
    expect(await ids("globex-site/production")).toEqual([{ id: "req_c" }]);
    expect(
      await stage.databases.SupportDBAcme.prepare("SELECT id FROM support_request ORDER BY id").all(),
    ).toMatchObject({ results: [{ id: "req_a" }, { id: "req_b" }] });
    expect(await shared.prepare("SELECT id FROM support_request").all()).toMatchObject({
      results: [{ id: "req_c" }],
    });
  });

  it("runs a batch atomically within the Slot", async () => {
    const storage = storageFor("acme-shop/production");

    await expect(
      storage.batch([
        storage.statement(insertRequest, "req_a", "subject-1", "sub-1", "one", 1),
        storage.statement(insertRequest, "req_b", "subject-1", "sub-1", "duplicate key", 2),
      ]),
    ).rejects.toThrow();
    expect(
      await storage.all("SELECT id FROM support_request WHERE slot = ?1"),
    ).toEqual([]);
  });
});

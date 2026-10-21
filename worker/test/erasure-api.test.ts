import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { harness, type Installation } from "./installation-client.ts";
import { localStage } from "./local-d1.ts";

const START = Date.parse("2026-10-17T10:00:00Z");
const slot = (name: string): RepositoryMapping => ({ slot: `${name}/production`, client: name, project: name, environment: "production",
  repositoryId: 42, githubInstallationId: 7, clientOriginLabel: "client-support", defaultDeveloper: "developer" });
const mappings = [slot("shop"), slot("globex")];
const subject = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";

let stage: Awaited<ReturnType<typeof localStage<"shared">>>;
let shop: Installation, globex: Installation;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: START });
  stage = await localStage(["shared"]);
  const clients = harness(stage.databases.shared, mappings);
  shop = await clients.enroll("shop/production", "installation-a");
  globex = await clients.enroll("globex/production", "installation-b");
});
afterEach(async () => { await stage.dispose(); vi.useRealTimers(); });

const accept = async (installation: Installation, reporter: string, description: string, context?: object) => {
  const response = await installation.send("POST", "/v1/requests", JSON.stringify({ submission_id: crypto.randomUUID(),
    reporter_subject: reporter, scope: "mine", summary: "Checkout fails", description, context }));
  expect(response.status).toBe(202);
  return (await response.json() as { id: string }).id;
};
const erase = (installation: Installation, body: unknown) => installation.send("POST", "/v1/erasures", JSON.stringify(body));

it("records an erasure once per open Reporter erasure, hides the text at once and scopes the status to its Slot", async () => {
  const mine = await accept(shop, subject, "Private report text");
  const theirs = await accept(shop, other, "Someone else's text");
  const response = await erase(shop, { reporter_subject: subject });
  expect(response.status).toBe(202);
  const recorded = await response.json() as { id: string; state: string };
  expect(recorded).toMatchObject({ id: expect.stringMatching(/^era_/), state: "in_progress", counts: { pending: 1 } });
  expect(JSON.stringify(recorded)).not.toMatch(/Private report text|00000000/);
  expect((await shop.send("GET", `/v1/requests/${mine}?reporter_subject=${subject}&scope=mine`)).status).toBe(404);
  expect((await shop.send("GET", `/v1/requests/${theirs}?reporter_subject=${other}&scope=mine`)).status).toBe(200);
  const rows = (await stage.databases.shared.prepare("SELECT description FROM support_request").all<{ description: string }>()).results;
  expect(rows.map((row) => row.description).sort()).toEqual(["", "Someone else's text"]);
  // A repeat while open is the same erasure.
  expect(await (await erase(shop, { reporter_subject: subject })).json()).toMatchObject({ id: recorded.id });
  expect(await (await shop.send("GET", `/v1/erasures/${recorded.id}`)).json()).toMatchObject({ id: recorded.id, state: "in_progress" });
  expect((await globex.send("GET", `/v1/erasures/${recorded.id}`)).status).toBe(404);
});

it.each([
  ["a missing subject", {}],
  ["a malformed subject", { reporter_subject: "someone" }],
  ["a named Slot", { reporter_subject: subject, slot: "globex/production" }],
])("rejects %s without recording anything", async (_, body) => {
  expect((await erase(shop, body)).status).toBe(400);
  expect(await stage.databases.shared.prepare("SELECT COUNT(*) AS n FROM erasure").first("n")).toBe(0);
});

it("exports only the attested Reporter's own requests in this Slot, oldest first, without internal identifiers", async () => {
  const first = await accept(shop, subject, "First text");
  vi.setSystemTime(START + 1000);
  const second = await accept(shop, subject, "Second text");
  await accept(shop, other, "Not theirs");
  await accept(globex, subject, "Same subject on another site");
  const response = await shop.send("GET", `/v1/export?reporter_subject=${subject}`);
  expect(response.status).toBe(200);
  const page = await response.json() as { items: Record<string, unknown>[]; next_cursor: string | null };
  expect(page).toEqual({ next_cursor: null, items: [
    { id: first, summary: "Checkout fails", description: "First text", created_at: new Date(START).toISOString(), delivery: "accepted-pending", status: null, context: null },
    { id: second, summary: "Checkout fails", description: "Second text", created_at: new Date(START + 1000).toISOString(), delivery: "accepted-pending", status: null, context: null },
  ] });
  expect((await shop.send("GET", `/v1/export?reporter_subject=${subject}&cursor=not-a-cursor`)).status).toBe(400);
  expect((await shop.send("GET", `/v1/export?reporter_subject=${subject}&scope=site`)).status).toBe(400);
  await erase(shop, { reporter_subject: subject });
  expect(await (await shop.send("GET", `/v1/export?reporter_subject=${subject}`)).json()).toEqual({ items: [], next_cursor: null });
});

const CONTEXT = { schema: 1, default: { wp_version: "6.5.5", support_plugin_version: "0.1.8", originating_screen: "post-editor" } };

it("exports Report context while the service still holds it, and none once delivery cleared it", async () => {
  const id = await accept(shop, subject, "Private report text", CONTEXT);
  const exported = async () => (await (await shop.send("GET", `/v1/export?reporter_subject=${subject}`)).json() as { items: Record<string, unknown>[] }).items;
  expect((await exported())[0]).toMatchObject({ id, context: CONTEXT });
  // Another Reporter's export never carries it.
  expect(JSON.stringify(await (await shop.send("GET", `/v1/export?reporter_subject=${other}`)).json())).not.toContain("6.5.5");
  await stage.databases.shared.prepare("UPDATE delivery_intent SET state = 'delivered', context_json = NULL").run();
  await stage.databases.shared.prepare("UPDATE support_request SET status = 'open', issue_id = 9, issue_number = 3").run();
  expect((await exported())[0]).toMatchObject({ id, delivery: "delivered", context: null });
});

it("removes retained Report context as soon as an erasure is recorded", async () => {
  await accept(shop, subject, "Private report text", CONTEXT);
  await accept(shop, other, "Someone else's text", CONTEXT);
  expect((await erase(shop, { reporter_subject: subject })).status).toBe(202);
  const rows = (await stage.databases.shared.prepare(`SELECT r.reporter_subject, i.context_json FROM delivery_intent i
    JOIN support_request r ON r.id = i.request_id ORDER BY r.reporter_subject`).all<{ reporter_subject: string; context_json: string | null }>()).results;
  expect(rows).toEqual([{ reporter_subject: "", context_json: null }, { reporter_subject: other, context_json: JSON.stringify(CONTEXT) }]);
});

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

const accept = async (installation: Installation, reporter: string, description: string) => {
  const response = await installation.send("POST", "/v1/requests", JSON.stringify({ submission_id: crypto.randomUUID(),
    reporter_subject: reporter, scope: "mine", summary: "Checkout fails", description }));
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
    { id: first, summary: "Checkout fails", description: "First text", created_at: new Date(START).toISOString(), delivery: "accepted-pending", status: null },
    { id: second, summary: "Checkout fails", description: "Second text", created_at: new Date(START + 1000).toISOString(), delivery: "accepted-pending", status: null },
  ] });
  expect((await shop.send("GET", `/v1/export?reporter_subject=${subject}&cursor=not-a-cursor`)).status).toBe(400);
  expect((await shop.send("GET", `/v1/export?reporter_subject=${subject}&scope=site`)).status).toBe(400);
  await erase(shop, { reporter_subject: subject });
  expect(await (await shop.send("GET", `/v1/export?reporter_subject=${subject}`)).json()).toEqual({ items: [], next_cursor: null });
});

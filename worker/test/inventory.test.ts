import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { StageInventory } from "../src/inventory.ts";
import { operationsAccess } from "../src/operations-api.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { runOperator } from "../src/operator.ts";
import { handleWorkerRequest } from "../src/worker-http.ts";
import { harness, signed } from "./installation-client.ts";
import { localStage } from "./local-d1.ts";
import { operationsClient, type OperationsClient } from "./operations-client.ts";

const START = Date.parse("2026-10-20T10:00:00Z");
// shop/production has reviewed deployment details; shop/staging has not had them reviewed yet.
const mappings: RepositoryMapping[] = [
  { slot: "shop/production", client: "shop", project: "shop", environment: "production", repositoryId: 42,
    repository: "Quick-Release/shop", githubInstallationId: 7, defaultDeveloper: "developer",
    deployment: "central", responsibleTeam: "web-platform" },
  { slot: "shop/staging", client: "shop", project: "shop", environment: "staging", repositoryId: 42, defaultDeveloper: "developer" },
];
const inventory: StageInventory = {
  stage: "staging",
  account: { name: "Tipme", id: "8f38791a8c37b182239af2a385ab3c31" },
  resources: [{ kind: "d1", reference: "GQSupportWorker/staging/SupportDB" }],
  credentials: [
    { id: "app-key", purpose: "GitHub App authentication", owner: "platform", expires: "2026-11-01",
      locations: ["GitHub Environment staging: SUPPORT_GITHUB_APP_PRIVATE_KEY"], revocation: "docs/runbooks/github-app-key-custody.md",
      rotated: { at: "2026-10-17", evidence: "https://github.com/Quick-Release/gq-support/actions/runs/1" } },
    { id: "discord", purpose: "Discord notifications", owner: null, expires: null,
      locations: ["Worker secret DISCORD_OPERATIONAL_INCIDENTS_WEBHOOK_URL"], revocation: "docs/runbooks/support-operations.md", rotated: null },
  ],
};

let stage: Awaited<ReturnType<typeof localStage<"shared">>>;
let banquinha: OperationsClient;
let access: ReturnType<typeof operationsAccess>;
let now: number;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: START });
  now = START;
  stage = await localStage(["shared"]);
  banquinha = await operationsClient();
  access = operationsAccess(JSON.stringify({ [banquinha.keyId]: banquinha.publicKey }), "alex");
});
afterEach(async () => { await stage.dispose(); vi.useRealTimers(); });

const advance = (milliseconds: number) => { now += milliseconds; vi.setSystemTime(now); };
const operator = (...args: string[]) => runOperator(args, { mappings, inventory, now, recordRevocation: async () => {},
  // Like the Wrangler adapter, which substitutes plain `?` in order and has no numbered parameters.
  query: async (sql, parameters) => sql.match(/\?\d/) ? Promise.reject(new Error("Numbered parameter"))
    : (await stage.databases.shared.prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results });
const at = (offset: number) => new Date(START + offset).toISOString();
const send = (request: Request) => Effect.runPromise(handleWorkerRequest(HttpServerRequest.fromWeb(request),
  Effect.succeed(stage.databases.shared), mappings, () => Effect.die("Not a webhook"), () => {}, undefined, {}, access, [], inventory));
const staffInventory = async () => {
  const response = await send(await banquinha.request("GET", "/v1/operations/inventory", "alex"));
  expect(response.status).toBe(200);
  return await response.json() as { stage: unknown; slots: Record<string, unknown>[] };
};

it("lists every Slot of the stage with its Client, repository/App mapping, resources, deployment method and team", async () => {
  const { stage: references, slots } = await staffInventory();
  expect(references).toEqual({ name: "staging", account: { name: "Tipme", id: "8f38791a8c37b182239af2a385ab3c31" },
    resources: [{ kind: "d1", reference: "GQSupportWorker/staging/SupportDB" }] });
  expect(slots).toMatchObject([
    { slot: "shop/production", client: "shop", project: "shop", environment: "production",
      repository: { id: 42, name: "Quick-Release/shop", app_installation_id: 7 },
      deployment_method: "central", responsible_team: "web-platform" },
    // Unreviewed details stay unknown rather than defaulted.
    { slot: "shop/staging", client: "shop", project: "shop", environment: "staging",
      repository: { id: 42, name: null, app_installation_id: null },
      deployment_method: null, responsible_team: null },
  ]);
});

it("shows the version an installation reported at signed enrollment, and an absent or stale observation as unknown", async () => {
  await harness(stage.databases.shared, mappings).enroll("shop/production", "installation-a", { plugin_version: "1.4.0" });
  const observed = async () => (await staffInventory()).slots.map((slot) => (slot.versions as { observed: unknown }).observed);
  expect(await observed()).toEqual([
    { state: "current", reason: null, version: "1.4.0", observed_at: new Date(START).toISOString(), source: "enrollment" },
    { state: "unknown", reason: "absent", version: null, observed_at: null, source: null },
  ]);
  // No traffic since is no evidence either way: past the display window the last value is kept, but unknown.
  advance(24 * 3_600_000);
  expect((await observed())[0]).toMatchObject({ state: "current" });
  advance(1);
  expect((await observed())[0]).toEqual(
    { state: "unknown", reason: "stale", version: "1.4.0", observed_at: new Date(START).toISOString(), source: "enrollment" });
});

it("reports a dispatched update as unconfirmed until an observation of that version follows the attempt", async () => {
  await harness(stage.databases.shared, mappings).enroll("shop/production", "installation-a", { plugin_version: "1.4.0" });
  advance(600_000);
  await operator("inventory-record", "shop/production", "desired", "1.5.0", at(60_000), "release-1.5.0", "alex");
  await operator("inventory-record", "shop/production", "attempted", "1.5.0", at(120_000), "deploy-run-1", "alex");
  const production = async () => (await staffInventory()).slots[0] as { versions: Record<string, unknown>; update: unknown };
  expect(await production()).toMatchObject({
    versions: {
      desired: { version: "1.5.0", at: at(60_000), source: "operator" },
      attempted: { version: "1.5.0", at: at(120_000), source: "operator" },
      observed: { state: "current", version: "1.4.0" },
    },
    update: { outcome: "unconfirmed", at: null },
  });
  // An observation of the attempted version made before the attempt confirms nothing.
  await operator("inventory-record", "shop/production", "observed", "1.5.0", at(90_000), "site-health-1", "sam");
  expect((await production()).update).toEqual({ outcome: "unconfirmed", at: null });
  await operator("inventory-record", "shop/production", "observed", "1.5.0", at(300_000), "site-health-2", "sam");
  expect((await production()).update).toEqual({ outcome: "confirmed", at: at(300_000) });
});

it("reports a recorded failure of the attempted version, until a later observation confirms it", async () => {
  advance(600_000);
  await operator("inventory-record", "shop/production", "attempted", "1.5.0", at(60_000), "deploy-run-1", "alex");
  // A failure of some other version says nothing about this attempt.
  await operator("inventory-record", "shop/production", "failed", "1.4.9", at(90_000), "deploy-run-0", "alex");
  const outcome = async () => ((await staffInventory()).slots[0] as { update: unknown }).update;
  expect(await outcome()).toEqual({ outcome: "unconfirmed", at: null });
  await operator("inventory-record", "shop/production", "failed", "1.5.0", at(120_000), "deploy-run-1", "alex");
  expect(await outcome()).toEqual({ outcome: "failed", at: at(120_000) });
  await operator("inventory-record", "shop/production", "observed", "1.5.0", at(180_000), "site-health-1", "sam");
  expect(await outcome()).toEqual({ outcome: "confirmed", at: at(180_000) });
});

it("refuses version evidence for an unmapped Slot, a future time or malformed values, recording nothing", async () => {
  const record = (...args: string[]) => operator("inventory-record", ...args);
  await expect(record("other/production", "observed", "1.5.0", at(0), "ref", "alex")).rejects.toThrow("Unknown Slot");
  await expect(record("shop/production", "observed", "1.5.0", at(1), "ref", "alex")).rejects.toThrow("no later than now");
  await expect(record("shop/production", "observed", "1.5.0", "yesterday", "ref", "alex")).rejects.toThrow("no later than now");
  await expect(record("shop/production", "healthy", "1.5.0", at(0), "ref", "alex")).rejects.toThrow("Invalid");
  await expect(record("shop/production", "observed", "latest", at(0), "ref", "alex")).rejects.toThrow("Invalid");
  await expect(record("shop/production", "observed", "1.5.0", at(0), "a ref with spaces", "alex")).rejects.toThrow("Invalid");
  await expect(record("shop/production", "observed", "1.5.0", at(0), "ref", "alex@example")).rejects.toThrow("Invalid");
  expect(((await staffInventory()).slots[0] as { versions: { observed: unknown } }).versions.observed).toMatchObject({ reason: "absent" });
});

it("shows staff only when a Client's independent contact was verified; the route and evidence stay with the Operator CLI", async () => {
  const route = "Contract annex B duty phone, called from a separate device";
  advance(600_000);
  const contact = async () => {
    const response = await send(await banquinha.request("GET", "/v1/operations/inventory", "alex"));
    const body = await response.text();
    expect(body).not.toContain("annex");
    expect(body).not.toContain("drill-2026-10");
    return (JSON.parse(body) as { slots: { contact: unknown }[] }).slots.map((slot) => slot.contact);
  };
  expect(await contact()).toEqual([{ state: "unverified", verified_at: null }, { state: "unverified", verified_at: null }]);
  await operator("inventory-contact", "shop/production", route, at(300_000), "drill-2026-10", "alex");
  expect((await contact())[0]).toEqual({ state: "verified", verified_at: at(300_000) });
  expect(JSON.parse(await operator("inventory", "shop/production"))).toMatchObject({
    slot: "shop/production",
    contact: { state: "verified", verified_at: at(300_000), route, evidence: "drill-2026-10", verified_by: "alex" },
  });
  await expect(operator("inventory-contact", "shop/production", "", at(0), "ref", "alex")).rejects.toThrow("Invalid");
  await expect(operator("inventory-contact", "shop/production", route, at(600_001), "ref", "alex")).rejects.toThrow("no later than now");
});

it("shows staff each credential's purpose, owner, expiry and rotation without its locations, which only the CLI shows", async () => {
  const credentials = async () => {
    const response = await send(await banquinha.request("GET", "/v1/operations/inventory", "alex"));
    const body = await response.text();
    for (const restricted of ["SUPPORT_GITHUB_APP_PRIVATE_KEY", "DISCORD_OPERATIONAL", "runbooks", "actions/runs"]) expect(body).not.toContain(restricted);
    return (JSON.parse(body) as { credentials: unknown[] }).credentials;
  };
  expect(await credentials()).toEqual([
    { id: "app-key", purpose: "GitHub App authentication", owner: "platform", stage: "staging",
      expiry: { state: "valid", expires_at: "2026-11-01" }, rotated_at: "2026-10-17" },
    // Nothing reviewed is nothing known.
    { id: "discord", purpose: "Discord notifications", owner: null, stage: "staging",
      expiry: { state: "unknown", expires_at: null }, rotated_at: null },
  ]);
  advance(13 * 86_400_000);
  expect((await credentials())[0]).toMatchObject({ expiry: { state: "expired", expires_at: "2026-11-01" } });
  expect(JSON.parse(await operator("inventory-credentials"))).toEqual({ stage: "staging", credentials: [
    expect.objectContaining({ id: "app-key", locations: ["GitHub Environment staging: SUPPORT_GITHUB_APP_PRIVATE_KEY"],
      revocation: "docs/runbooks/github-app-key-custody.md", rotation_evidence: "https://github.com/Quick-Release/gq-support/actions/runs/1" }),
    expect.objectContaining({ id: "discord", locations: ["Worker secret DISCORD_OPERATIONAL_INCIDENTS_WEBHOOK_URL"], rotation_evidence: null }),
  ] });
});

it("serves inventory only to a registered dashboard key naming a rostered team member", async () => {
  const installation = await harness(stage.databases.shared, mappings).enroll("shop/production", "installation-a");
  const path = "/v1/operations/inventory";
  expect((await send(await signed(installation.pair, "GET", path, "", installation.keyId, installation.installationId))).status).toBe(401);
  expect((await send(await banquinha.request("GET", path, "discord-member"))).status).toBe(403);
  const stranger = await operationsClient(banquinha.keyId);
  expect((await send(await stranger.request("GET", path, "alex"))).status).toBe(401);
  expect((await send(await banquinha.request("POST", path, "alex"))).status).toBe(404);
});

import { discordLeakCheck } from "../deploy/key-custody-scan.ts";
import { URL as NodeURL } from "node:url";
import { readFileSync } from "node:fs";
import * as Layer from "effect/Layer";
import { sweepDelivery } from "../src/delivery.ts";
import { GitHubGateway } from "../src/github-gateway.ts";
import { harness } from "./installation-client.ts";
import { CLIENT_ID, makeFakeGitHub, SLUG } from "./fake-github.ts";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { alertConfig, collectAlerts, drainAlerts, observeAlert, persistCollected, recordAlerts, SIGNALS, webhookURL, type AlertConfig } from "../src/discord-alerts.ts";
import { createGitHubWebhookReceiver } from "../src/github-webhooks.ts";
import { localStage } from "./local-d1.ts";
import { provisionDiscordAlertSecret, validateDiscordAlertConfig } from "../deploy/discord-alert-secret.ts";
import { executeOperator } from "../src/maintenance-operator.ts";

// Generated, synthetic credentials only. Never call a real endpoint in this suite.
const URL = `https://discord.com/api/webhooks/123456789012345678/${"fake_".repeat(14)}`;
const config: AlertConfig = { enabled: true, stage: "staging", release: "a".repeat(40), webhook: URL };
const START = 1_800_000_000_000;
let stage: Awaited<ReturnType<typeof localStage<"main" | "ledger">>>;
beforeEach(async () => { stage = await localStage(["main", "ledger"]); });
afterEach(async () => { await stage.dispose(); });
const ledger = () => stage.databases.ledger;
const main = () => stage.databases.main;
const observe = (active = true, now = START) => observeAlert(ledger(), "refresh_lag", active, 1, now);
const drain = (request: typeof fetch, now = START, setting = config) => drainAlerts(main(), ledger(), setting, request, now, () => now);
const ok = () => vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200 }));
const control = () => ledger().prepare("SELECT * FROM discord_alert_control").first<{ blocked: number; owner: string | null; next_at: number }>();
const rows = () => ledger().prepare("SELECT * FROM discord_alert").all();
const operator = (...args: string[]) => executeOperator(args, {
  query: async (sql, params) => (await main().prepare(sql).bind(...params).all<Record<string, unknown>>()).results,
  ledger: async (sql, params) => (await ledger().prepare(sql).bind(...params).all<Record<string, unknown>>()).results,
  mappings: [], recordRevocation: async () => {},
});

it("captures a real rejected webhook, persists outside its response, and sends an exact allowlisted payload", async () => {
  const collector = collectAlerts();
  const response = await Effect.runPromise(createGitHubWebhookReceiver({ appId: "123" })(
    new Request("https://support.invalid/v1/github/webhook", { method: "POST", body: "secret report @everyone" }), () => {},
  ).pipe(Effect.provide(collector.layer)));
  expect(response.status).toBe(401);
  expect((await rows()).results).toHaveLength(0);
  await Effect.runPromise(persistCollected(collector, main(), ledger(), config));
  const fake = ok();
  await drain(fake, Date.now());
  expect(fake).toHaveBeenCalledTimes(1);
  const [url, init] = fake.mock.calls[0]!;
  expect(url).toBe(`${URL}?wait=true`);
  expect(init).toMatchObject({ method: "POST", redirect: "manual", headers: { "Content-Type": "application/json" } });
  const body = JSON.parse(init!.body as string);
  expect(Object.keys(body).sort()).toEqual(["allowed_mentions", "content"]);
  expect(body.allowed_mentions).toEqual({ parse: [] });
  expect(body.content).toMatch(/^Support incident: webhook_rejected; stage=staging; release=a{40}; count=1; first_ms=\d+; last_ms=\d+$/);
  expect(body.content.length).toBeLessThan(2000);
});

it("retains the accepted result when alert storage fails", async () => {
  await ledger().prepare("DROP TABLE discord_alert").run();
  const work = Effect.logError("Support delivery requires review").pipe(Effect.annotateLogs({ alert: true }), Effect.as({ status: 202 }));
  expect(await Effect.runPromise(recordAlerts(work, main(), ledger(), config))).toEqual({ status: 202 });
});

it("ignores arbitrary logs and excludes every annotation value, including leak canaries", async () => {
  const collector = collectAlerts();
  const canary = "private-submitted-context-subject-hash-submission-change-nonce-token-cookie-headers-https://private.invalid/@everyone";
  await Effect.runPromise(Effect.gen(function* () {
    yield* Effect.logError(canary).pipe(Effect.annotateLogs({ alert: true }));
    for (const name of Object.keys(SIGNALS)) {
      if (name === "Support status refresh age") continue;
      yield* Effect.logError(name).pipe(Effect.annotateLogs({ alert: true, request: canary, reason: canary, outcome: canary,
        repository: canary, age_ms: canary, body: canary, reporter_subject: canary, submission_id: canary }));
    }
  }).pipe(Effect.provide(collector.layer)));
  await collector.persist(ledger(), config, START);
  const fake = ok();
  for (let i = 0; i < 25; i++) await drain(fake, START + i * 60_000);
  expect(fake.mock.calls.length).toBe(new Set(Object.values(SIGNALS)).size);
  expect(JSON.stringify(fake.mock.calls.map((call) => call[1]))).not.toContain(canary);
  expect(JSON.stringify((await rows()).results)).not.toContain(canary);
});

it("deduplicates competing drains, aggregates bounded counts and sends a proven global recovery once", async () => {
  await Promise.all(Array.from({ length: 8 }, () => observe()));
  const fake = ok();
  await Promise.all([drain(fake), drain(fake), drain(fake)]);
  expect(fake).toHaveBeenCalledTimes(1);
  expect(fake.mock.calls[0]![1]!.body).toContain("count=8");
  await observe(true, START + 60_000);
  await drain(fake, START + 60_000);
  expect(fake).toHaveBeenCalledTimes(1);
  await observe(false, START + 120_000);
  await drain(fake, START + 120_000);
  expect(fake).toHaveBeenCalledTimes(2);
  expect(fake.mock.calls[1]![1]!.body).toContain("Support recovery:");
  await observe(false, START + 180_000);
  await drain(fake, START + 180_000);
  expect(fake).toHaveBeenCalledTimes(2);
  await observe(true, START + 240_000);
  await drain(fake, START + 240_000);
  expect(fake).toHaveBeenCalledTimes(3);
});

it("does not manufacture recovery without a prior incident; normal log age records recovery", async () => {
  await observe(false);
  expect((await rows()).results).toHaveLength(0);
  await observe();
  const collector = collectAlerts();
  await Effect.runPromise(Effect.logInfo("Support status refresh age").pipe(Effect.annotateLogs({ alert: false }), Effect.provide(collector.layer)));
  await collector.persist(ledger(), config, START + 1);
  expect((await rows()).results[0]).toMatchObject({ active: 0, version: 2 });
});

it("honors fractional Retry-After globally across incidents and caps at three POST attempts", async () => {
  await observe();
  await observeAlert(ledger(), "webhook_rejected", true, 1, START + 1);
  const fake = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 429, headers: { "Retry-After": "120.5" } }));
  await drain(fake);
  await drain(fake, START + 120_499);
  expect(fake).toHaveBeenCalledTimes(1);
  await drain(fake, START + 120_500);
  await drain(fake, START + 241_000);
  expect(fake).toHaveBeenCalledTimes(3);
  expect((await rows()).results.find((r) => r.signal === "refresh_lag")).toMatchObject({ attempts: 3, sent_version: 0 });
  expect((await ledger().prepare("SELECT * FROM maintenance_operation").all()).results).toHaveLength(0);
});

it("honors exhausted-bucket reset after success and blocks unsupported rate limits", async () => {
  await observe();
  await observeAlert(ledger(), "webhook_rejected", true, 1, START + 1);
  const fake = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}", { status: 200,
    headers: { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": "600" } }));
  await drain(fake);
  await drain(fake, START + 599_999);
  expect(fake).toHaveBeenCalledTimes(1);
  await drain(fake, START + 600_000);
  expect(fake).toHaveBeenCalledTimes(2);
});

it.each([302, 500, 204, 429, 401, 404])("fails closed on status %i without consuming untrusted bodies or following redirects", async (status) => {
  await observe();
  const fake = vi.fn<typeof fetch>().mockResolvedValue(new Response(status === 204 ? null : "private upstream secret", { status,
    headers: { Location: "http://127.0.0.1/secret" } }));
  await drain(fake);
  await drain(fake, START + 86400000);
  expect(fake).toHaveBeenCalledTimes(1);
  expect(await control()).toMatchObject({ blocked: 1 });
  expect((await rows()).results[0]).toMatchObject({ sent_version: 0 });
  const operations = (await ledger().prepare("SELECT * FROM maintenance_operation WHERE kind = 'provider'").all()).results;
  expect(operations).toHaveLength(0);
  await operator("maintenance-enter", "operator-1");
  await operator("maintenance-mirror", "operator-1");
});

it("keeps transport/timeout uncertainty in alert state without obstructing support recovery", async () => {
  await observe();
  const fake = vi.fn<typeof fetch>().mockRejectedValue(new Error(`${URL}?private=secret`));
  await drain(fake);
  await drain(fake, START + 60_000);
  expect(fake).toHaveBeenCalledTimes(1);
  expect((fake.mock.calls[0]![1]!.signal)).toBeInstanceOf(AbortSignal);
  expect(await control()).toMatchObject({ blocked: 1 });
  expect((await rows()).results[0]).toMatchObject({ sent_version: 0 });
  expect((await ledger().prepare("SELECT * FROM maintenance_operation").all()).results).toHaveLength(0);
  await operator("maintenance-enter", "operator-1");
  await operator("maintenance-mirror", "operator-1");
});

it.each([429, 200])("starts response-relative cooldown at receipt for delayed status %i", async (status) => {
  await observe();
  await observeAlert(ledger(), "webhook_rejected", true, 1, START + 1);
  const fake = vi.fn<typeof fetch>().mockImplementation(async () => new Response("{}", { status,
    headers: status === 429 ? { "Retry-After": "120" } : { "X-RateLimit-Remaining": "0", "X-RateLimit-Reset-After": "120" } }));
  await drainAlerts(main(), ledger(), config, fake, START, () => START + 1_000);
  expect(await control()).toMatchObject({ next_at: START + 121_000 });
  await drain(fake, START + 120_999);
  expect(fake).toHaveBeenCalledTimes(1);
  await drain(fake, START + 121_000);
  expect(fake).toHaveBeenCalledTimes(2);
});

it("obstructs restore during active notification I/O, then isolates its uncertain receipt", async () => {
  await observe();
  let started!: () => void, respond!: (response: Response) => void;
  const dispatched = new Promise<void>((resolve) => { started = resolve; });
  const response = new Promise<Response>((resolve) => { respond = resolve; });
  const fake = vi.fn<typeof fetch>().mockImplementation(async () => { started(); return response; });
  const pending = drain(fake);
  await dispatched;
  await operator("maintenance-enter", "operator-1");
  await expect(operator("maintenance-mirror", "operator-1")).rejects.toThrow("exclusive drain");
  respond(new Response(null, { status: 500 }));
  await pending;
  expect(await control()).toMatchObject({ blocked: 1 });
  expect((await ledger().prepare("SELECT * FROM maintenance_operation").all()).results).toHaveLength(0);
  await operator("maintenance-mirror", "operator-1");
});

it.each(["http://discord.com/api/webhooks/1/token", `${URL}?wait=true`, `${URL}#fragment`, URL.replace("discord.com", "discord.com.evil.invalid"), URL.replace("discord.com", "discord.com:443"), URL.replace("discord.com", "user@discord.com"), URL.replace("discord.com", "127.0.0.1"), URL.replace("/webhooks/", "/v10/webhooks/")])("rejects unsupported URL shapes without HTTP", async (webhook) => {
  expect(webhookURL(webhook)).toBeNull();
  const fake = ok();
  await observe();
  await drain(fake, START, { ...config, webhook });
  expect(fake).not.toHaveBeenCalled();
});

it("is disabled with missing configuration, missing secret, unknown stage, or invalid release", async () => {
  expect(alertConfig({}, "getquick-support-staging").enabled).toBe(false);
  expect(alertConfig({ DISCORD_ALERTS_ENABLED: "true" }, "unknown").enabled).toBe(false);
  await observe();
  const fake = ok();
  for (const setting of [{ ...config, enabled: false }, { ...config, webhook: undefined }, { ...config, release: "@everyone" }]) await drain(fake, START, setting);
  expect(fake).not.toHaveBeenCalled();
});

it("fails closed under independent containment, unavailable ledger, or a restored DB epoch mismatch", async () => {
  await observe();
  const fake = ok();
  await ledger().prepare("UPDATE maintenance_control SET mode = 'held'").run();
  await drain(fake);
  await ledger().prepare("UPDATE maintenance_control SET mode = 'open'").run();
  await main().prepare("UPDATE restore_state SET epoch = 999").run();
  await drain(fake);
  await ledger().prepare("DROP TABLE maintenance_control").run();
  await drain(fake);
  expect(fake).not.toHaveBeenCalled();
});

it("bounds state cardinality and counts, expires after seven days, and never expires lost owners", async () => {
  for (const signal of new Set(Object.values(SIGNALS))) await observeAlert(ledger(), signal, true, 999999999, START);
  expect((await rows()).results).toHaveLength(new Set(Object.values(SIGNALS)).size);
  expect((await rows()).results.every((r) => r.count === 999999)).toBe(true);
  const fake = ok();
  await drain(fake, START + 8 * 86400000);
  expect((await rows()).results).toHaveLength(0);
  expect(fake).not.toHaveBeenCalled();
  await observe(true, START + 9 * 86400000);
  await ledger().prepare("UPDATE discord_alert_control SET owner = 'lost-owner'").run();
  await drain(fake, START + 100 * 86400000);
  expect(await control()).toMatchObject({ owner: "lost-owner" });
  expect(fake).not.toHaveBeenCalled();
});

it("provisions optional secret_text via apply-only custody, enabling last and revoking on disable", async () => {
  const fake = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ success: true }));
  fake.mockResolvedValueOnce(Response.json({ success: true, result: { observability: { traces: { enabled: false } } } }));
  await provisionDiscordAlertSecret("worker", { DISCORD_ALERTS_ENABLED: "true", DISCORD_ALERT_WEBHOOK_URL: URL,
    GITHUB_SHA: "b".repeat(40), CLOUDFLARE_API_TOKEN: "synthetic" }, fake);
  expect(fake.mock.calls.slice(1).map((c) => JSON.parse(c[1]!.body as string))).toEqual([
    { name: "DISCORD_ALERTS_ENABLED", type: "secret_text", text: "false" },
    { name: "DISCORD_ALERT_WEBHOOK_URL", type: "secret_text", text: URL },
    { name: "DISCORD_ALERT_RELEASE", type: "secret_text", text: "b".repeat(40) },
    { name: "DISCORD_ALERTS_ENABLED", type: "secret_text", text: "true" },
  ]);
  fake.mockClear();
  await provisionDiscordAlertSecret("worker", { CLOUDFLARE_API_TOKEN: "synthetic" }, fake);
  expect(fake.mock.calls.map((c) => c[1]!.method)).toEqual(["PUT", "DELETE", "DELETE"]);
  expect(() => validateDiscordAlertConfig({ DISCORD_ALERTS_ENABLED: "true", DISCORD_ALERT_WEBHOOK_URL: URL })).toThrow("Discord alert configuration invalid");
  fake.mockRejectedValue(new Error(URL));
  await expect(provisionDiscordAlertSecret("worker", { CLOUDFLARE_API_TOKEN: "synthetic" }, fake)).rejects.toThrow(/^Discord alert Worker secret update failed$/);
});


it("rejects enablement before uploading credentials when automatic fetch traces are active or unknown", async () => {
  const source = readFileSync(new NodeURL("../src/worker.ts", import.meta.url), "utf8");
  expect(source).toContain("traces: { enabled: false }");
  for (const settings of [{}, { observability: { traces: { enabled: true } } }]) {
    const fake = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ success: true, result: settings }));
    await expect(provisionDiscordAlertSecret("worker", { DISCORD_ALERTS_ENABLED: "true", DISCORD_ALERT_WEBHOOK_URL: URL,
      GITHUB_SHA: "b".repeat(40), CLOUDFLARE_API_TOKEN: "synthetic" }, fake)).rejects.toThrow("Discord alert Worker secret update failed");
    expect(fake).toHaveBeenCalledTimes(1);
    expect(fake.mock.calls[0]![0]).toMatch(/\/settings$/);
    expect(fake.mock.calls[0]![1]!.body).toBeUndefined();
  }
});

it.each(["permission", "deadline", "ambiguity"])("routes genuine delivery %s flags without changing the accepted receipt", async (scenario) => {
  const mapping = { slot: "shop/production", client: "shop", project: "shop", environment: "production",
    repositoryId: 42, githubInstallationId: 7, clientOriginLabel: "client-support", defaultDeveloper: "developer" };
  const installation = await harness(main(), [mapping]).enroll(mapping.slot, "installation-alert");
  await main().prepare("UPDATE delivery_control SET enabled = 1").run();
  const accepted = await installation.send("POST", "/v1/requests", JSON.stringify({ submission_id: crypto.randomUUID(),
    reporter_subject: "00000000-0000-4000-8000-000000000001", scope: "mine", summary: "Private summary",
    description: "Private submitted text @everyone" }));
  expect(accepted.status).toBe(202);
  const github = makeFakeGitHub(); github.installation(7); github.repository({ id: 42, installationId: 7 });
  const actualNow = Date.now();
  let now = scenario === "deadline" ? actualNow + 86400001 : actualNow;
  if (scenario !== "deadline") {
    github.next(() => undefined);
    github.next(() => Response.json({ message: "PRIVATE upstream" }, { status: scenario === "permission" ? 403 : 502 }));
  }
  const sweep = () => sweepDelivery({ db: main(), ledger: ledger(), mappings: [mapping], botLogin: `${SLUG}[bot]`, now: () => now, random: () => 0 }).pipe(
    Effect.provide(GitHubGateway.layer({ clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem }).pipe(Layer.provide(github.layer))));
  await Effect.runPromise(recordAlerts(sweep(), main(), ledger(), config));
  if (scenario === "ambiguity") {
    expect((await rows()).results).toHaveLength(0);
    now += 900001;
    await Effect.runPromise(recordAlerts(sweep(), main(), ledger(), config));
  }
  expect((await rows()).results).toEqual([expect.objectContaining({ signal: scenario === "permission" ? "delivery_permission" : scenario === "deadline" ? "delivery_deadline" : "delivery_ambiguity", active: 1 })]);
  const fake = ok(); await drain(fake, now);
  expect(fake).toHaveBeenCalledTimes(1);
  expect(fake.mock.calls[0]![1]!.body).toContain(`delivery_${scenario === "permission" ? "permission" : scenario === "deadline" ? "deadline" : "ambiguity"}`);
  expect(fake.mock.calls[0]![1]!.body).not.toContain("Private");
  expect(github.requests.filter((r) => r.method === "POST" && r.path.endsWith("/issues"))).toHaveLength(scenario === "deadline" ? 0 : 1);
});

it("aborts a stalled fake HTTP request after the bounded runtime timeout", async () => {
  await observe();
  const fake = vi.fn<typeof fetch>().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new Error("synthetic timeout")), { once: true });
  }));
  await drain(fake);
  expect(fake.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  expect(await control()).toMatchObject({ blocked: 1 });
});


it("detects URL and token leakage in custody scans without revealing them in errors", () => {
  const check = discordLeakCheck(URL);
  for (const value of [URL, URL.split("/").at(-1)!]) {
    expect(() => check(JSON.stringify({ output: value }))).toThrow(/^Discord credential found outside its secret binding$/);
    expect(() => check(new TextEncoder().encode(value))).toThrow("Discord credential found");
  }
  expect(() => check("redacted metadata secret_text")).not.toThrow();
});

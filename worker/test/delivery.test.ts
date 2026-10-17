import type { D1PreparedStatement } from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { QueryDatabase } from "../src/storage.ts";
import { runOperator } from "../src/operator.ts";
import { sweepDelivery } from "../src/delivery.ts";
import { GitHubGateway } from "../src/github-gateway.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { harness, type Installation } from "./installation-client.ts";
import { localStage } from "./local-d1.ts";
import { CLIENT_ID, makeFakeGitHub, SLUG } from "./fake-github.ts";

const START = Date.parse("2026-10-17T10:00:00Z");
const mapping: RepositoryMapping = { slot: "shop/production", client: "shop", project: "shop", environment: "production",
  repositoryId: 42, githubInstallationId: 7, clientOriginLabel: "client-support", defaultDeveloper: "developer" };
let stage: Awaited<ReturnType<typeof localStage<"shared">>>;
let installation: Installation;
let github: ReturnType<typeof makeFakeGitHub>;
let now: number;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: START });
  now = START;
  stage = await localStage(["shared"]);
  installation = await harness(stage.databases.shared, [mapping]).enroll(mapping.slot, "installation-a");
  github = makeFakeGitHub();
  github.installation(7);
  github.repository({ id: 42, installationId: 7 });
  await stage.databases.shared.prepare("UPDATE delivery_control SET enabled = 1").run();
});
afterEach(async () => { await stage.dispose(); vi.useRealTimers(); });
const subject = "00000000-0000-4000-8000-000000000001";
const accept = async () => {
  const response = await installation.send("POST", "/v1/requests", JSON.stringify({ submission_id: crypto.randomUUID(),
    reporter_subject: subject, scope: "mine", summary: "Checkout fails", description: "Private report text" }));
  expect(response.status).toBe(202);
  return await response.json() as { id: string };
};
const sweep = (mappings = [mapping], db: QueryDatabase = stage.databases.shared) => Effect.runPromise(sweepDelivery({ db, mappings, botLogin: `${SLUG}[bot]`,
  now: () => now, random: () => 0 }).pipe(Effect.provide(GitHubGateway.layer({ clientId: CLIENT_ID, slug: SLUG,
    privateKeyPem: github.privateKeyPem }).pipe(Layer.provide(github.layer)))));
const read = async (id: string) => (await installation.send("GET", `/v1/requests/${id}?reporter_subject=${subject}&scope=mine`)).json();

it("delivers an accepted report once and projects its verified status", async () => {
  const request = await accept();
  await sweep();
  expect(await read(request.id)).toMatchObject({ delivery: "delivered", status: "open", description: "Private report text" });
  await sweep();
  expect(github.issues).toHaveLength(1);
  expect(github.issues[0]!.body).toContain("Private report text");
  expect(github.issues[0]!.body).not.toContain(subject);
});

const advance = (milliseconds: number) => { now += milliseconds; vi.setSystemTime(now); };
const respondToPost = (status: number, headers: Record<string, string> = {}) => {
  github.next(() => undefined); // installation token
  github.next(() => undefined); // repository safety
  github.next(() => Response.json({ message: 'Provider response containing PRIVATE_DATA' }, { status, headers }));
};

it("fails permission rejection without exposing provider text", async () => {
  const request = await accept();
  respondToPost(403);
  await sweep();
  expect(await read(request.id)).toMatchObject({ delivery: 'failed', status: null });
  expect(JSON.stringify(await read(request.id))).not.toContain('PRIVATE_DATA');
  advance(300_000);
  await sweep();
  expect(github.issues).toHaveLength(0);
});

it("honours rate feedback across the shared installation then retries confirmed non-creation", async () => {
  const request = await accept();
  respondToPost(429, { 'retry-after': '120' });
  await sweep();
  expect(await read(request.id)).toMatchObject({ delivery: 'accepted-pending' });
  advance(119_000);
  await sweep();
  expect(github.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/issues'))).toHaveLength(1);
  advance(1000);
  await sweep();
  expect(await read(request.id)).toMatchObject({ delivery: 'delivered' });
  expect(github.issues).toHaveLength(1);
});

it("retries transient authentication transport failure which cannot have created an issue", async () => {
  const request = await accept();
  github.next(() => new Response(null, { status: 503 }));
  await sweep();
  expect(await read(request.id)).toMatchObject({ delivery: 'accepted-pending' });
  advance(30_000);
  await sweep();
  expect(await read(request.id)).toMatchObject({ delivery: 'delivered' });
});

it("reconciles an ambiguous side effect without another POST", async () => {
  const request = await accept();
  github.onCreate(() => new Response(null, { status: 502 }));
  await sweep();
  expect(await read(request.id)).toMatchObject({ delivery: 'outcome-unknown', status: null });
  advance(60_000);
  await sweep();
  expect(await read(request.id)).toMatchObject({ delivery: 'delivered', status: 'open' });
  expect(github.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/issues'))).toHaveLength(1);
});

it("never recreates after a complete negative reconciliation or its automatic window", async () => {
  const request = await accept();
  respondToPost(502);
  await sweep();
  advance(60_000);
  await sweep();
  expect(await read(request.id)).toMatchObject({ delivery: 'outcome-unknown' });
  advance(86_400_000);
  await sweep();
  await sweep();
  expect(await read(request.id)).toMatchObject({ delivery: 'outcome-unknown' });
  expect(github.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/issues'))).toHaveLength(1);
});

it("concurrent wake-ups permit one create and preserve dependent sequence order", async () => {
  const request = await accept();
  const db = stage.databases.shared;
  await db.prepare(`INSERT INTO delivery_intent (id, slot, request_id, kind, seq, state, next_attempt_at, retry_deadline)
    VALUES ('int_DEPENDENT', ?, ?, 'create', 1, 'pending', ?, ?)`).bind(mapping.slot, request.id, now, now + 86_400_000).run();
  await Promise.all(Array.from({ length: 8 }, () => sweep()));
  expect(github.issues).toHaveLength(1);
  expect(await read(request.id)).toMatchObject({ delivery: 'delivered' });
});

it("stops at the acceptance deadline without pretending an unknown outcome failed", async () => {
  const request = await accept();
  advance(86_400_000);
  await sweep();
  expect(await read(request.id)).toMatchObject({ delivery: 'failed', status: null });
  expect(github.requests).toHaveLength(0);
});

it("pins approved routing and refuses a changed mapping", async () => {
  const request = await accept();
  await sweep([{ ...mapping, repositoryId: 43 }]);
  expect(await read(request.id)).toMatchObject({ delivery: 'failed' });
  expect(github.requests).toHaveLength(0);
});

it.each(['slot', 'request'])("suppresses %s work without treating key revocation as cancellation", async (scope) => {
  const request = await accept();
  await stage.databases.shared.prepare("INSERT INTO delivery_suppression VALUES (?, ?, 'erasure')")
    .bind(scope, scope === 'slot' ? mapping.slot : request.id).run();
  await sweep();
  expect(github.requests).toHaveLength(0);
  await stage.databases.shared.prepare('DELETE FROM delivery_suppression').run();
  await stage.databases.shared.prepare('UPDATE installation_key SET revoked_at = ?').bind(now).run();
  await sweep();
  expect(github.issues).toHaveLength(1);
});

it("retains ambiguity for duplicate marker matches", async () => {
  const request = await accept();
  github.onCreate(() => new Response(null, { status: 502 }));
  await sweep();
  const issue = github.issues[0]!;
  github.issues.push({ ...issue, id: issue.id + 1, number: issue.number + 1, node_id: 'I_duplicate' });
  advance(60_000);
  await sweep();
  expect(await read(request.id)).toMatchObject({ delivery: 'outcome-unknown' });
  expect(github.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/issues'))).toHaveLength(1);
});

it("paces additive repairs without creating a second issue", async () => {
  const request = await accept();
  github.onCreate((issue) => { issue.labels = []; issue.assignees = []; return undefined; });
  await sweep();
  expect(await read(request.id)).toMatchObject({ delivery: 'delivered' });
  advance(10_000);
  await sweep();
  expect(github.issues[0]!.labels).toEqual([{ name: 'client-support' }]);
  expect(github.issues[0]!.assignees).toEqual([]);
  advance(10_000);
  await sweep();
  expect(github.issues[0]!.assignees).toEqual([{ login: 'developer' }]);
  expect(github.issues).toHaveLength(1);
});

it("a claim response delayed beyond the execution deadline never dispatches", async () => {
  const request = await accept();
  const db = stage.databases.shared;
  await sweep([mapping], {
    prepare: db.prepare.bind(db),
    batch: async <T>(statements: D1PreparedStatement[]) => { const result = await db.batch<T>(statements); advance(61_000); return result; },
  });
  expect(github.requests).toHaveLength(0);
  await sweep();
  expect(await read(request.id)).toMatchObject({ delivery: 'outcome-unknown' });
  expect(github.issues).toHaveLength(0);
});

it("lost identity persistence reconciles the side effect after the claim drains", async () => {
  const request = await accept();
  const db = stage.databases.shared;
  let batches = 0;
  await sweep([mapping], {
    prepare: db.prepare.bind(db),
    batch: async (statements) => {
      if (++batches === 2) throw new Error('D1 result write lost');
      return db.batch(statements);
    },
  });
  expect(await read(request.id)).toMatchObject({ delivery: 'accepted-pending' });
  expect(github.issues).toHaveLength(1);
  advance(60_000);
  await sweep();
  expect(await read(request.id)).toMatchObject({ delivery: 'delivered' });
  expect(github.issues).toHaveLength(1);
});

it("a stale success cannot overwrite state but remains discoverable by reconciliation", async () => {
  const request = await accept();
  github.onCreate(() => { advance(61_000); return undefined; });
  await sweep();
  expect(await read(request.id)).toMatchObject({ delivery: 'accepted-pending' });
  await sweep();
  expect(await read(request.id)).toMatchObject({ delivery: 'delivered' });
  expect(github.issues).toHaveLength(1);
});

it("suppression and deadline are checked after token mint and repository safety", async () => {
  const request = await accept();
  github.next(() => undefined);
  github.next(() => { advance(21_000); return undefined; });
  await sweep();
  expect(github.issues).toHaveLength(0);
  expect(await read(request.id)).toMatchObject({ delivery: 'outcome-unknown' });
});

it("disabled delivery does no provider work", async () => {
  await accept();
  await stage.databases.shared.prepare('UPDATE delivery_control SET enabled = 0').run();
  await sweep();
  expect(github.requests).toHaveLength(0);
});

const resume = async (id: string) => {
  const row = await stage.databases.shared.prepare('SELECT id FROM delivery_intent WHERE request_id = ?').bind(id).first<{ id: string }>();
  return runOperator(['resume', mapping.slot, row!.id, new Date(now + 3_600_000).toISOString(), 'operator-1', 'permissions-restored'], {
    query: async (sql, parameters) => (await stage.databases.shared.prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results,
    recordRevocation: async () => {}, mappings: [mapping], now,
  });
};

it("audits a bounded resume of confirmed failure with independent operator authority", async () => {
  const request = await accept();
  respondToPost(403);
  await sweep();
  advance(60_000);
  expect(await resume(request.id)).toBe('Delivery resumed');
  await sweep();
  expect(await read(request.id)).toMatchObject({ delivery: 'delivered' });
  const audit = await stage.databases.shared.prepare('SELECT actor, action, reason FROM delivery_audit').all();
  expect(audit.results).toEqual([{ actor: 'operator-1', action: 'resume', reason: 'permissions-restored' }]);
});

it("refuses unknown and suppressed resume", async () => {
  const request = await accept();
  respondToPost(502);
  await sweep();
  advance(60_000);
  await expect(resume(request.id)).rejects.toThrow('cannot be resumed');
  const db = stage.databases.shared;
  await db.prepare("UPDATE delivery_intent SET state = 'failed', last_error_class = 'PermissionMissing'").run();
  await db.prepare("INSERT INTO delivery_suppression VALUES ('slot', ?, 'offboarding')").bind(mapping.slot).run();
  await expect(resume(request.id)).rejects.toThrow('cannot be resumed');
});

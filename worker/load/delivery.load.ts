import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, it, vi } from "vitest";
import { sweepDelivery } from "../src/delivery.ts";
import { GitHubGateway } from "../src/github-gateway.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { harness } from "../test/installation-client.ts";
import { localStage } from "../test/local-d1.ts";
import { CLIENT_ID, makeFakeGitHub, SLUG } from "../test/fake-github.ts";

it("bounds fleet dispatch, shares installation pacing and gives every Slot a fair turn", async () => {
  const stage = await localStage(['fleet']);
  const db = stage.databases.fleet;
  let now = Date.parse('2026-10-17T10:00:00Z');
  vi.useFakeTimers({ toFake: ['Date'], now });
  try {
    // More Slots than the scheduler's 16-candidate bound, with one busy Slot.
    const mappings: RepositoryMapping[] = Array.from({ length: 24 }, (_, index) => ({
      slot: `project-${index}/production`, client: `client-${index}`, project: `project-${index}`, environment: 'production',
      repositoryId: 42, githubInstallationId: 7, clientOriginLabel: 'client-support', defaultDeveloper: 'developer',
    }));
    const clients = harness(db, mappings);
    for (const [index, mapping] of mappings.entries()) {
      await db.prepare('DELETE FROM enrollment_rate').run();
      const installation = await clients.enroll(mapping.slot, `installation-${index}`);
      for (let report = 0; report < (index === 0 ? 5 : 1); report++) {
        expect((await installation.send('POST', '/v1/requests', JSON.stringify({ submission_id: crypto.randomUUID(),
          reporter_subject: '00000000-0000-4000-8000-000000000001', scope: 'mine', description: 'Fleet fixture' }))).status).toBe(202);
      }
    }
    await db.prepare('UPDATE delivery_control SET enabled = 1').run();
    const github = makeFakeGitHub();
    github.installation(7);
    github.repository({ id: 42, installationId: 7 });
    const posts: number[] = [];
    github.onCreate(() => { posts.push(now); return undefined; });
    for (let turn = 0; turn < 28; turn++) {
      const sweep = () => sweepDelivery({ db, mappings, botLogin: `${SLUG}[bot]`, now: () => now });
      // Wake-up contention cannot turn one installation permit into a burst.
      await Effect.runPromise(Effect.all(Array.from({ length: 4 }, sweep), { concurrency: 'unbounded' }).pipe(
        Effect.provide(GitHubGateway.layer({ clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem }).pipe(Layer.provide(github.layer))),
      ));
      expect(posts).toHaveLength(turn + 1);
      if (turn === 23) {
        const slots = await db.prepare("SELECT COUNT(DISTINCT slot) AS count FROM support_request WHERE issue_id IS NOT NULL").first<{ count: number }>();
        expect(slots!.count).toBe(24);
      }
      now += 10_000;
      vi.setSystemTime(now);
    }
    expect(posts.every((time, index) => index === 0 || time - posts[index - 1]! >= 10_000)).toBe(true);
    expect(github.issues).toHaveLength(28);
    console.log(JSON.stringify({ slots: 24, reports: 28, concurrentSweeps: 4, minimumMutationIntervalMs: 10_000,
      everySlotServedWithinTurns: 24, virtualElapsedMs: 280_000 }));
  } finally {
    vi.useRealTimers();
    await stage.dispose();
  }
});

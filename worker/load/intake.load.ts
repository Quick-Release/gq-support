import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { REPORTER_QUOTAS, SLOT_QUOTAS } from "../src/support-requests.ts";
import { harness, type Installation } from "../test/installation-client.ts";
import { localStage } from "../test/local-d1.ts";

// Drives the intake quotas, same-key duplicates and the request budget through
// the public HTTP boundary at high concurrency against workerd's local D1.
// It checks invariants exactly and reports latency; it does not measure
// production D1 latency, which needs a deployed stage.
const env = (name: string, fallback: number) => Number(process.env[name] ?? fallback);
// Defaults keep demand above every quota and finish in about a minute locally.
const SLOTS = env("LOAD_SLOTS", 3);
const REPORTERS = env("LOAD_REPORTERS", 11);
const CREATES = env("LOAD_CREATES", 2);
const CONCURRENCY = env("LOAD_CONCURRENCY", 64);
const WINDOWS = 6;
const TEN_MINUTES = 600_000;
const T0 = Date.UTC(2026, 9, 16, 12);
const [slotShort, slotDaily] = [SLOT_QUOTAS[0]!.limit, SLOT_QUOTAS[1]!.limit];
const reporterShort = REPORTER_QUOTAS[0]!.limit;

// Slots 0 and 1 belong to one Client and share a repository.
const mappings: RepositoryMapping[] = Array.from({ length: SLOTS }, (_, n) => ({
  slot: `site-${n}/production`, client: n < 2 ? "client-shared" : `client-${n}`, project: `site-${n}`,
  environment: "production", repositoryId: n < 2 ? 1 : n, defaultDeveloper: "dev",
}));
const uuid = (...parts: number[]) => {
  const hex = parts.map((part) => part.toString(16).padStart(4, "0")).join("").padStart(12, "0").slice(-12);
  return `00000000-0000-4000-8000-${hex}`;
};

let stage: Awaited<ReturnType<typeof localStage<"shared">>>;
beforeAll(async () => { stage = await localStage(["shared"]); });
afterAll(() => stage.dispose());

/** Runs tasks with at most `limit` in flight, recording each one's latency. */
const pool = async <T>(tasks: (() => Promise<T>)[], limit: number, latencies: number[]): Promise<T[]> => {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next++;
      const started = performance.now();
      results[index] = await tasks[index]!();
      latencies.push(performance.now() - started);
    }
  }));
  return results;
};
const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]!;

it("holds every quota and duplicate invariant under concurrent load", async () => {
  const db = stage.databases.shared;
  const clients = harness(db, mappings);
  vi.useFakeTimers({ toFake: ["Date"], now: T0 });
  const installations: Installation[] = [];
  for (const mapping of mappings) {
    installations.push(await clients.enroll(mapping.slot, `installation-${installations.length}`));
    await db.prepare("DELETE FROM enrollment_rate").run();
  }
  const latencies: number[] = [];
  const started = performance.now();
  let requests = 0;
  let acceptedTotal = 0;

  for (let window = 0; window < WINDOWS; window += 1) {
    vi.setSystemTime(T0 + window * TEN_MINUTES);
    type Outcome = { slot: number; reporter: number; submission: string; status: number; id?: string };
    const tasks: (() => Promise<Outcome | null>)[] = [];
    for (let slot = 0; slot < SLOTS; slot += 1) {
      for (let reporter = 0; reporter < REPORTERS; reporter += 1) {
        const subject = uuid(slot, reporter);
        for (let create = 0; create < CREATES; create += 1) {
          const submission = uuid(window, slot, reporter * CREATES + create);
          const body = JSON.stringify({ submission_id: submission, description: `Load ${submission}`, reporter_subject: subject, scope: "mine" });
          // Each create is sent twice, concurrently, as a same-key duplicate.
          for (let copy = 0; copy < 2; copy += 1) {
            tasks.push(async () => {
              const response = await installations[slot]!.send("POST", "/v1/requests", body);
              const json = await response.json() as { id?: string };
              return { slot, reporter, submission, status: response.status, id: json.id };
            });
          }
        }
        tasks.push(async () => {
          const response = await installations[slot]!.send("GET", `/v1/requests?reporter_subject=${subject}&scope=mine&per_page=50`);
          expect(response.status).toBe(200);
          return null;
        });
      }
    }
    // Interleave Slots and Reporters, deterministically.
    const order = tasks.map((task, index) => ({ task, key: (index * 7919) % tasks.length })).sort((a, b) => a.key - b.key);
    tasks.splice(0, tasks.length, ...order.map(({ task }) => task));
    const outcomes = (await pool(tasks, CONCURRENCY, latencies)).filter((outcome): outcome is Outcome => outcome !== null);
    requests += tasks.length;

    expect(outcomes.filter((outcome) => ![202, 429].includes(outcome.status))).toEqual([]);
    const bySubmission = new Map<string, Outcome[]>();
    for (const outcome of outcomes) bySubmission.set(outcome.submission, [...bySubmission.get(outcome.submission) ?? [], outcome]);
    for (const copies of bySubmission.values()) {
      // Both copies see the same outcome and the same request.
      expect(copies.map((copy) => [copy.status, copy.id])).toEqual([[copies[0]!.status, copies[0]!.id], [copies[0]!.status, copies[0]!.id]]);
    }
    const accepted = [...bySubmission.values()].map((copies) => copies[0]!).filter((outcome) => outcome.status === 202);
    for (let slot = 0; slot < SLOTS; slot += 1) {
      const demand = REPORTERS * CREATES;
      const room = Math.min(slotShort, slotDaily - window * slotShort);
      expect([slot, accepted.filter((outcome) => outcome.slot === slot).length]).toEqual([slot, Math.max(0, Math.min(demand, room))]);
      for (let reporter = 0; reporter < REPORTERS; reporter += 1) {
        expect(accepted.filter((outcome) => outcome.slot === slot && outcome.reporter === reporter).length).toBeLessThanOrEqual(reporterShort);
      }
    }
    acceptedTotal += accepted.length;
    const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())!.n;
    expect(await count("SELECT COUNT(*) AS n FROM support_request")).toBe(acceptedTotal);
    expect(await count("SELECT COUNT(*) AS n FROM delivery_intent")).toBe(acceptedTotal);
    expect(await count("SELECT COUNT(*) AS n FROM intake_debit")).toBe(2 * acceptedTotal);
  }

  const elapsed = (performance.now() - started) / 1000;
  const sorted = latencies.sort((a, b) => a - b);
  process.stdout.write(`${JSON.stringify({
    slots: SLOTS, reporters_per_slot: REPORTERS, concurrency: CONCURRENCY, requests, accepted: acceptedTotal,
    seconds: Number(elapsed.toFixed(1)), requests_per_second: Math.round(requests / elapsed),
    latency_ms: Object.fromEntries([["p50", 0.5], ["p95", 0.95], ["p99", 0.99], ["max", 1]]
      .map(([name, p]) => [name, Math.round(percentile(sorted, p as number))])),
  }, null, 2)}\n`);
  vi.useRealTimers();
});

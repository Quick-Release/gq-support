import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { GitHubGateway, OutcomeUnknown, type GitHubIssue } from "./github-gateway.ts";
import { supportIssues, type ReconciliationProgress, type SupportIssueIntent } from "./support-issues.ts";
import { mappingFor, type RepositoryMapping } from "./repository-mappings.ts";
import { sha256 } from "./signature.ts";
import type { QueryDatabase } from "./storage.ts";
import { DAY, DRAIN_MS, EXECUTION_MS, deliveryStore, type DeliveryRow } from "./delivery-store.ts";

export interface DeliveryOptions {
  readonly db: QueryDatabase;
  readonly mappings: readonly RepositoryMapping[];
  readonly botLogin: string;
  readonly now?: () => number;
  readonly random?: () => number;
}
const io = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: () => new OutcomeUnknown() });
const reconcileAt = (since: number, count: number) => since + ([60_000, 300_000, 900_000, 3_600_000][count] ?? (count - 2) * 3_600_000);
const intentFor = (row: DeliveryRow) => io(async (): Promise<SupportIssueIntent> => ({
  target: { installationId: row.github_installation_id!, repositoryId: row.repository_id }, intentId: row.id,
  title: row.title, description: row.description, acceptedAt: row.created_at,
  clientOriginLabel: row.client_origin_label!, defaultDeveloper: row.default_developer!,
  attribution: { environment: row.environment!,
    installationReference: `inst_${(await sha256(JSON.stringify([row.slot, row.installation_id]))).slice(0, 32)}`,
    reporterReference: `rs_${(await sha256(JSON.stringify([row.slot, row.reporter_subject]))).slice(0, 32)}` },
}));
const approved = (row: DeliveryRow, mappings: readonly RepositoryMapping[]) => {
  const mapping = mappingFor(mappings, row.slot);
  return mapping && mapping.repositoryId === row.repository_id && mapping.githubInstallationId === row.github_installation_id &&
    Number.isSafeInteger(row.github_installation_id) && row.github_installation_id! > 0 &&
    mapping.environment === row.environment && mapping.clientOriginLabel === row.client_origin_label &&
    mapping.defaultDeveloper === row.default_developer;
};
const log = (row: DeliveryRow, outcome: string, alert = false) =>
  (alert ? Effect.logError("Support delivery requires review") : Effect.logInfo("Support delivery outcome")).pipe(
    Effect.annotateLogs({ intent: row.id, generation: row.generation, outcome, alert }),
  );

/** One bounded wake-up. D1, never this invocation, is the durable work queue. */
export const sweepDelivery = (options: DeliveryOptions): Effect.Effect<void, OutcomeUnknown, GitHubGateway> => Effect.gen(function* () {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const started = now();
  const deadline = started + EXECUTION_MS;
  const store = deliveryStore(options.db);
  yield* io(() => store.recover(now()));
  const due = yield* io(() => store.due(now()));
  for (const candidate of due) {
    if (now() >= deadline) break;
    const process = Effect.gen(function* () {
      const row = yield* io(() => store.claim(candidate, crypto.randomUUID(), now(), started + DRAIN_MS));
      if (!row) return;
      // A delayed claim response cannot extend the dispatch window.
      if (now() >= deadline) return;
      const finish = (outcome: Parameters<typeof store.finish>[2]) => io(() => store.finish(row, now(), outcome));
      const unknown = (error: string) => finish({ state: "outcome_unknown", error,
        unknownSince: row.unknown_since ?? now(), next: reconcileAt(row.unknown_since ?? now(), 0) });
      if (!approved(row, options.mappings)) {
        yield* finish({ state: row.state === 'in_flight' ? 'failed' : row.state, next: null, error: 'MappingUnavailable' });
        yield* log(row, 'MappingUnavailable', true);
        return;
      }
      if (row.state === 'in_flight' && now() >= row.retry_deadline) {
        yield* finish({ state: 'failed', next: null, error: 'DeliveryDeadline' });
        yield* log(row, 'DeliveryDeadline', true);
        return;
      }
      const intent = yield* intentFor(row);
      // The gateway runs this after repository lookup AND token minting,
      // immediately before POST. Never put a retry around this operation.
      const authorize = Effect.gen(function* () {
        if (now() >= deadline) return yield* Effect.fail(new OutcomeUnknown());
        const permitted = yield* io(() => store.authorized(row, now()));
        if (!permitted || now() >= deadline) return yield* Effect.fail(new OutcomeUnknown());
      });
      const delivered = (issue: GitHubIssue) => finish({ state: 'delivered', issue, next: now() + 10_000,
        repair: !issue.labels.includes(intent.clientOriginLabel) || !issue.assignees.includes(intent.defaultDeveloper) });
      if (row.state === 'outcome_unknown') {
        const since = row.unknown_since ?? now();
        if (now() >= since + DAY) {
          yield* finish({ state: 'outcome_unknown', next: null, error: 'ReviewRequired' });
          yield* log(row, 'ReviewRequired', true);
          return;
        }
        const expected = yield* supportIssues.prepare(intent);
        const result = yield* Effect.result(supportIssues.reconcile({ target: intent.target, intentId: row.id,
          botLogin: options.botLogin, attemptStartedAt: row.attempt_started_at ?? row.created_at,
          attemptEndedAt: row.drain_until ?? row.created_at, expectedIssue: expected, erasurePending: false,
          ...(row.issue_id && row.issue_node_id && row.issue_number ? { knownIdentity: { id: row.issue_id,
            nodeId: row.issue_node_id, number: row.issue_number } } : {}),
        }, row.reconciliation_json ? JSON.parse(row.reconciliation_json) as ReconciliationProgress : undefined));
        if (Result.isSuccess(result) && result.success._tag === 'Delivered') {
          yield* delivered(result.success.issue);
          yield* log(row, 'Reconciled');
          return;
        }
        const progress = Result.isSuccess(result) && result.success._tag === 'Continue' ? JSON.stringify(result.success.progress) : null;
        const limited = Result.isFailure(result) && result.failure._tag === 'RateLimited' ? result.failure.until : 0;
        const next = Math.max(now() + 1000, limited, progress ? now() : reconcileAt(since, row.reconciliation_count + 1));
        yield* finish({ state: 'outcome_unknown', next: Math.min(since + DAY, next), progress,
          review: Result.isSuccess(result) && result.success._tag === 'Unknown' ? JSON.stringify({ reason: result.success.reason, candidates: result.success.candidates }) : null,
          error: Result.isFailure(result) ? result.failure._tag : result.success._tag === 'Unknown' ? result.success.reason : 'IncompleteScan' });
        yield* log(row, 'ReconciliationPending', now() - since >= 900_000 ||
          (Result.isSuccess(result) && result.success._tag === 'Unknown' && result.success.alert));
        return;
      }
      if (row.state === 'delivered') {
        if (!row.issue_id || !row.issue_node_id || !row.issue_number) return yield* log(row, 'MissingIdentity', true);
        const result = yield* Effect.result(supportIssues.repair(intent, { id: row.issue_id, nodeId: row.issue_node_id, number: row.issue_number }, authorize));
        const repaired = Result.isSuccess(result) && result.success._tag === 'Repaired';
        const review = Result.isSuccess(result) && result.success._tag === 'NeedsReview';
        const retryable = Result.isFailure(result) && ['RateLimited', 'ProviderUnavailable', 'OutcomeUnknown'].includes(result.failure._tag);
        yield* finish({ state: 'delivered', next: repaired || review || (!Result.isSuccess(result) && !retryable) || now() >= row.created_at + DAY
          ? null : Result.isFailure(result) && result.failure._tag === 'RateLimited' ? result.failure.until : now() + (Result.isSuccess(result) ? 10_000 : 60_000),
          repair: !repaired, error: Result.isFailure(result) ? result.failure._tag : result.success._tag });
        yield* log(row, 'MetadataRepair', review || (Result.isFailure(result) && !retryable));
        return;
      }
      const result = yield* Effect.result(supportIssues.create(intent, authorize));
      if (Result.isSuccess(result)) {
        yield* delivered(result.success);
        yield* log(row, 'Delivered');
        return;
      }
      const error = result.failure;
      if (error._tag === 'OutcomeUnknown') {
        yield* unknown(error._tag);
      } else if (error._tag === 'RateLimited' || error._tag === 'ProviderUnavailable') {
        const next = error._tag === 'RateLimited' ? Math.max(now() + 1000, error.until)
          : now() + Math.min(3_600_000, 30_000 * 2 ** Math.min(row.attempts - 1, 7)) * (1 + random() * 0.25);
        yield* finish({ state: 'pending', next: Math.min(next, row.retry_deadline), error: error._tag });
      } else {
        yield* finish({ state: 'failed', next: null, error: error._tag });
      }
      yield* log(row, error._tag, !['OutcomeUnknown', 'RateLimited', 'ProviderUnavailable'].includes(error._tag));
    }).pipe(Effect.withSpan("support.delivery", { attributes: { intent: candidate.id } }));
    // Isolate storage/poison failures. An authorized attempt stays in flight;
    // expired ownership becomes unknown on the next sweep, never a new POST.
    yield* process.pipe(Effect.catchCause(() => log(candidate, 'SchedulerFailure', true)));
  }
}).pipe(Effect.withSpan("support.delivery.sweep"));

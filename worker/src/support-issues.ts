import * as Effect from "effect/Effect";
import { GitHubGateway, ValidationRejected, type GitHubIssue, type GitHubTarget, type ReadIssueError } from "./github-gateway.ts";

/** Trusted, pinned delivery inputs. Never construct these from Reporter request fields. */
export interface SupportIssueIntent {
  readonly target: GitHubTarget;
  readonly intentId: string;
  readonly title: string;
  readonly description: string;
  readonly attribution: {
    readonly environment: string;
    /** Opaque reference, never a domain or WordPress identity. */
    readonly installationReference: string;
    /** Pseudonym computed by the caller; never the raw Reporter subject. */
    readonly reporterReference: string;
  };
  readonly acceptedAt: number;
  readonly clientOriginLabel: string;
  readonly defaultDeveloper: string;
}

const marker = (intentId: string) => `<!-- gq-support:v1 intent=${intentId} -->`;
const bodyFor = (intent: SupportIssueIntent) => {
  const fence = "~".repeat(Math.max(3, ...Array.from(intent.description.matchAll(/~+/g), (run) => run[0].length + 1)));
  const { environment, installationReference, reporterReference } = intent.attribution;
  const attribution = `**Support request** submitted via GETQUICK Support · \`${environment}\` · ` +
    `installation \`${installationReference}\` · reporter \`${reporterReference}\` · ${new Date(intent.acceptedAt).toISOString()}`;
  return [marker(intent.intentId), attribution, "", "### Description", "", `${fence}text`, intent.description, fence].join("\n");
};
const validIntent = (intent: SupportIssueIntent) =>
  /^int_[A-Z0-9]+$/.test(intent.intentId) && Number.isFinite(new Date(intent.acceptedAt).getTime()) &&
  /^[a-zA-Z0-9_-]{1,64}$/.test(intent.attribution.environment) &&
  /^inst_[a-zA-Z0-9_-]{1,64}$/.test(intent.attribution.installationReference) &&
  /^rs_[a-zA-Z0-9_-]{1,64}$/.test(intent.attribution.reporterReference);

export interface IssueIdentity {
  readonly id: number;
  readonly nodeId: string;
  readonly number: number;
}
const sameIdentity = (a: IssueIdentity, b: IssueIdentity) => a.id === b.id && a.nodeId === b.nodeId && a.number === b.number;

/** Scheduler-supplied evidence from the recorded attempt, never from a list response. */
export interface ReconciliationQuery {
  readonly target: GitHubTarget;
  readonly intentId: string;
  readonly botLogin: string;
  readonly attemptStartedAt: number;
  /** The bounded dispatch window, including the execution-drain bound. */
  readonly attemptEndedAt: number;
  /** Original template, or null after erasure purges the text. */
  readonly expectedIssue: { readonly title: string; readonly body: string } | null;
  readonly knownIdentity?: IssueIdentity;
  readonly erasurePending: boolean;
}

/** Persist this small, text-free checkpoint with the intent between invocations. */
export interface ReconciliationProgress {
  readonly scope: string;
  readonly page: number;
  readonly previousTail: { readonly createdAt: number; readonly id: number } | null;
  readonly candidates: readonly IssueIdentity[];
  readonly suspicious: boolean;
}
export type ReconciliationResult =
  | { readonly _tag: "Continue"; readonly progress: ReconciliationProgress }
  | { readonly _tag: "Unknown"; readonly reason: "no-match" | "shifted-pages" | "suspicious" | "multiple-matches"; readonly alert: boolean; readonly candidates: readonly IssueIdentity[] }
  | { readonly _tag: "Delivered"; readonly issue: GitHubIssue }
  | { readonly _tag: "RedactionRequired"; readonly issue: IssueIdentity; readonly reviewTitle: boolean };

const identityOf = ({ id, nodeId, number }: GitHubIssue): IssueIdentity => ({ id, nodeId, number });
const firstLine = (issue: GitHubIssue) => issue.body?.split("\n", 1)[0];
const unknown = (reason: Extract<ReconciliationResult, { _tag: "Unknown" }>["reason"], candidates: readonly IssueIdentity[]): ReconciliationResult =>
  ({ _tag: "Unknown", reason, alert: reason !== "no-match", candidates });
const plausible = (query: ReconciliationQuery, issue: GitHubIssue) => {
  const created = Date.parse(issue.createdAt);
  return issue.creator === query.botLogin && firstLine(issue) === marker(query.intentId) &&
    Number.isFinite(created) && created >= query.attemptStartedAt - 300_000 && created <= query.attemptEndedAt + 300_000 &&
    (!query.knownIdentity || sameIdentity(query.knownIdentity, issue)) &&
    (query.expectedIssue ? issue.title === query.expectedIssue.title && issue.body === query.expectedIssue.body : query.erasurePending);
};

const prepareIssue = (intent: SupportIssueIntent) => Effect.gen(function* () {
  if (!validIntent(intent)) return yield* Effect.fail(new ValidationRejected({ status: 400, fields: ["intent"] }));
  return { title: intent.title, body: bodyFor(intent), labels: [intent.clientOriginLabel], assignees: [intent.defaultDeveloper] };
});

export const supportIssues = {
  /** Deterministically reconstruct the expected template for reconciliation, without I/O. */
  prepare: prepareIssue,
  /** One authorized attempt. Caller owns durable authorization and fencing; no retry here. */
  create: (intent: SupportIssueIntent) => Effect.gen(function* () {
    const issue = yield* prepareIssue(intent);
    const gateway = yield* GitHubGateway;
    return yield* gateway.createIssue(intent.target, issue);
  }),
  /**
   * Read before/after one additive mutation at most. Schedule RepairPending
   * again under the installation's mutation budget; never replace metadata.
   */
  repair: (intent: SupportIssueIntent, identity: IssueIdentity) => Effect.gen(function* () {
    const gateway = yield* GitHubGateway;
    yield* gateway.repository(intent.target);
    const read = yield* gateway.readIssue(intent.target, identity.number);
    if (read._tag !== "Fresh" || !sameIdentity(read.issue, identity)) return { _tag: "NeedsReview" } as const;
    if (!read.issue.labels.includes(intent.clientOriginLabel)) yield* gateway.addLabels(intent.target, identity.number, [intent.clientOriginLabel]);
    else if (!read.issue.assignees.includes(intent.defaultDeveloper)) yield* gateway.addAssignees(intent.target, identity.number, [intent.defaultDeveloper]);
    const after = yield* gateway.readIssue(intent.target, identity.number);
    if (after._tag !== "Fresh" || !sameIdentity(after.issue, identity)) return { _tag: "NeedsReview" } as const;
    return { _tag: after.issue.labels.includes(intent.clientOriginLabel) && after.issue.assignees.includes(intent.defaultDeveloper)
      ? "Repaired" : "RepairPending" } as const;
  }),

  /**
   * Reads one new page and verifies the preceding boundary, when resuming.
   * Continue checkpoints belong to the scheduler;
   * failures leave its last checkpoint intact. Only a complete scan can resolve
   * a sole candidate. Empty/shifted scans never authorize a create.
   */
  reconcile: (query: ReconciliationQuery, progress?: ReconciliationProgress): Effect.Effect<ReconciliationResult,
    ReadIssueError | ValidationRejected, GitHubGateway> => Effect.gen(function* () {
    const scope = JSON.stringify([query.target.installationId, query.target.repositoryId, query.intentId, query.botLogin,
      query.attemptStartedAt, query.attemptEndedAt, query.knownIdentity ?? null, query.erasurePending]);
    if (!/^int_[A-Z0-9]+$/.test(query.intentId) || !query.botLogin.endsWith("[bot]") ||
        !Number.isFinite(query.attemptStartedAt) || !Number.isFinite(query.attemptEndedAt) || query.attemptEndedAt < query.attemptStartedAt ||
        (progress && (progress.scope !== scope || !Number.isSafeInteger(progress.page) || progress.page < 2 || progress.page > 10_000 || progress.candidates.length > 2))) {
      return yield* Effect.fail(new ValidationRejected({ status: 400, fields: ["reconciliation"] }));
    }
    const gateway = yield* GitHubGateway;
    yield* gateway.repository(query.target); // Verify numeric identity even after repository renames/transfers.
    const page = progress?.page ?? 1;
    const listed = yield* gateway.listAppIssues(query.target, page);
    const candidates = [...(progress?.candidates ?? [])];
    if (progress) {
      // A deletion/transfer can move an unseen candidate behind the old offset
      // without making the next page repeat anything. Re-read the boundary
      // after fetching the new page; a changed boundary invalidates this scan.
      const previous = yield* gateway.listAppIssues(query.target, page - 1);
      const boundary = previous.issues.at(-1);
      if (!previous.hasNextPage || !boundary || !progress.previousTail ||
          boundary.id !== progress.previousTail.id || Date.parse(boundary.createdAt) !== progress.previousTail.createdAt) {
        return unknown("shifted-pages", candidates);
      }
    }
    let suspicious = progress?.suspicious ?? false;
    let tail = progress?.previousTail ?? null;
    let reachedCutoff = false;
    for (const issue of listed.issues) {
      const createdAt = Date.parse(issue.createdAt);
      if (!Number.isFinite(createdAt) || (tail && (createdAt > tail.createdAt || (createdAt === tail.createdAt && issue.id >= tail.id)))) {
        return unknown("shifted-pages", candidates);
      }
      tail = { createdAt, id: issue.id };
      if (firstLine(issue) === marker(query.intentId)) {
        if (!plausible(query, issue)) suspicious = true;
        if (!candidates.some((candidate) => sameIdentity(candidate, issue))) candidates.push(identityOf(issue));
        if (candidates.length > 1) return unknown("multiple-matches", candidates.slice(0, 2));
      } else if (issue.body?.includes(marker(query.intentId))) {
        // A moved/edited marker is suspicious, including one copied into Reporter text.
        suspicious = true;
      }
      if (createdAt < query.attemptStartedAt - 300_000) reachedCutoff = true;
    }
    if (listed.hasNextPage && !reachedCutoff) {
      if (listed.issues.length === 0 || page >= 10_000) return unknown("shifted-pages", candidates);
      return { _tag: "Continue", progress: { scope, page: page + 1, previousTail: tail, candidates, suspicious } };
    }
    if (suspicious) return unknown("suspicious", candidates);
    if (candidates.length === 0) return unknown("no-match", []);
    const candidate = candidates[0]!;
    const current = yield* gateway.readIssue(query.target, candidate.number);
    if (current._tag !== "Fresh" || !sameIdentity(current.issue, candidate) || !plausible(query, current.issue)) return unknown("suspicious", candidates);
    if (query.erasurePending) return { _tag: "RedactionRequired", issue: candidate, reviewTitle: query.expectedIssue === null };
    return { _tag: "Delivered", issue: current.issue };
  }),
};

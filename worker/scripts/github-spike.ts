// Operator-run first-spike checks for the GitHubGateway (#37), staging only.
// Runs in the "GitHub App spike" workflow with the staging Environment's
// credentials, against sandbox repositories the staging App is installed on.
// It creates real issues there. Output is public observations only: booleans,
// statuses, logins and delays, never a key, JWT, token or response body.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { appConfig } from "../deploy/github-app.ts";
import { GitHubGateway, type GitHubTarget } from "../src/github-gateway.ts";

const integer = (name: string, required = true) => {
  const value = process.env[name];
  if (!value && !required) return undefined;
  if (!value || !/^\d+$/.test(value)) throw new Error(`Missing ${name}`);
  return Number(value);
};

const observed: Record<string, unknown> = {};
let pretendUnarchived = false;
let repositoryReads = 0;

/** Records non-secret facts about raw responses before the gateway parses them. */
const observingFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  const url = new URL(input instanceof Request ? input.url : String(input));
  const method = init?.method ?? (input instanceof Request ? input.method : "GET");
  if (url.pathname.endsWith("/access_tokens") && response.status === 201) {
    const minted = await response.clone().json() as { repositories?: Record<string, unknown>[] };
    const repository = minted.repositories?.[0] ?? {};
    observed.mintIncludesPrivate = typeof repository.private === "boolean";
    observed.mintIncludesArchived = typeof repository.archived === "boolean";
    if (pretendUnarchived && "archived" in repository) {
      // The gateway checks the mint's facts before POST; let it reach GitHub's own archived error.
      return Response.json({ ...minted, repositories: [{ ...repository, archived: false }] }, { status: 201, headers: response.headers });
    }
  }
  if (method === "GET" && /^\/repos\/[^/]+\/[^/]+$/.test(url.pathname)) repositoryReads++;
  if (method === "POST" && url.pathname.endsWith("/issues") && response.status !== 201) {
    const message = (await response.clone().json().catch(() => ({})) as { message?: unknown }).message;
    // A classification only: provider message text is never printed.
    observed.archivedCreate = { status: response.status, mentionsArchived: typeof message === "string" && /archived/i.test(message) };
  }
  if (pretendUnarchived && method === "GET" && /^\/repos\/[^/]+\/[^/]+$/.test(url.pathname) && response.ok) {
    // Lets the POST reach GitHub so the real archived-repository error is observed.
    return Response.json({ ...await response.json() as object, archived: false });
  }
  return response;
};

try {
  const config = appConfig("staging", process.env);
  const privateKeyPem = process.env.GITHUB_APP_PRIVATE_KEY;
  const assignee = process.env.SPIKE_ASSIGNEE;
  const label = process.env.SPIKE_LABEL;
  if (!privateKeyPem || !assignee || !label) throw new Error("Missing key, SPIKE_ASSIGNEE or SPIKE_LABEL");
  const target: GitHubTarget = { installationId: integer("SPIKE_INSTALLATION_ID")!, repositoryId: integer("SPIKE_REPOSITORY_ID")! };
  const archivedRepositoryId = integer("SPIKE_ARCHIVED_REPOSITORY_ID", false);

  const program = Effect.gen(function* () {
    const gateway = yield* GitHubGateway;
    const repository = yield* gateway.repository(target);
    observed.repository = { private: repository.private, archived: repository.archived };

    const startedAt = Date.now();
    repositoryReads = 0;
    const issue = yield* gateway.createIssue(target, {
      title: `Gateway spike ${new Date(startedAt).toISOString()}`,
      body: "<!-- gq-support:spike -->\nCreated by the GitHubGateway spike (#37). Safe to close.",
      labels: [label],
      assignees: [assignee],
    });
    // 0 when the mint carries private and archived; 1 when the gateway had to read the repository (#39).
    observed.createRepositoryReads = repositoryReads;
    observed.creator = issue.creator;
    observed.creatorIsSlugBot = issue.creator === `${config.slug}[bot]`;
    observed.labelApplied = issue.labels.includes(label);
    observed.assigneeApplied = issue.assignees.includes(assignee);

    // List visibility delay for the creator-filtered listing.
    for (let attempt = 0; attempt < 60; attempt++) {
      const page = yield* gateway.listAppIssues(target, 1);
      if (page.issues.some((listed) => listed.id === issue.id)) {
        observed.listVisibleAfterMs = Date.now() - startedAt;
        break;
      }
      yield* Effect.sleep("1 second");
    }
    observed.listVisibleAfterMs ??= null;

    if (archivedRepositoryId !== undefined) {
      pretendUnarchived = true;
      const result = yield* Effect.flip(gateway.createIssue(
        { installationId: target.installationId, repositoryId: archivedRepositoryId },
        { title: "Gateway spike: archived repository", body: "Must not be created.", labels: [], assignees: [] },
      ));
      observed.archivedCreateMappedTo = result._tag;
    }
  });

  await Effect.runPromise(program.pipe(
    Effect.provide(GitHubGateway.layer({ clientId: config.clientId, slug: config.slug, privateKeyPem }).pipe(
      Layer.provide(FetchHttpClient.layer),
      Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" })),
      Layer.provide(Layer.succeed(FetchHttpClient.Fetch, observingFetch)),
    )),
    Effect.catch((error) => Effect.sync(() => {
      // A created issue here means the archived repository accepted a write.
      observed.failed = "_tag" in error ? error._tag : "ArchivedRepositoryAcceptedCreate";
      process.exitCode = 1;
    })),
  ));
  console.log(JSON.stringify(observed, null, 2));
} catch (error) {
  // Only this script's own configuration messages; never provider output.
  console.error(error instanceof Error && error.message.startsWith("Missing") ? error.message : "GitHub spike failed");
  process.exitCode = 1;
}

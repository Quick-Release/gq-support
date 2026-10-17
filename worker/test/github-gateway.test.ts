import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vitest";
import { GitHubGateway, type GitHubTarget } from "../src/github-gateway.ts";
import { CLIENT_ID, makeFakeGitHub, SLUG, type FakeGitHub } from "./fake-github.ts";

const target: GitHubTarget = { installationId: 7, repositoryId: 42 };
const START = Date.parse("2026-10-17T10:00:00Z");

/** The failure as plain data, so tests can compare tags and fields. */
const failureOf = <A, E>(effect: Effect.Effect<A, E, GitHubGateway>) =>
  effect.pipe(Effect.flip, Effect.map((error) => ({ ...error as object })));

const setup = () => {
  const github = makeFakeGitHub();
  github.installation(7);
  github.repository({ id: 42, installationId: 7, name: "acme-shop" });
  return github;
};

const run = <A, E>(github: FakeGitHub, effect: Effect.Effect<A, E, GitHubGateway>, privateKeyPem = github.privateKeyPem) =>
  Effect.runPromise(Effect.gen(function* () {
    yield* TestClock.setTime(START);
    return yield* effect;
  }).pipe(
    Effect.provide(GitHubGateway.layer({ clientId: CLIENT_ID, slug: SLUG, privateKeyPem })
      .pipe(Layer.provide(github.layer))),
    Effect.provide(TestClock.layer()),
  ));

describe("GitHubGateway", () => {
  it("mints a token scoped to the mapped repository with Issues and Metadata only", async () => {
    const github = setup();
    const repository = await run(github, Effect.gen(function* () {
      const gateway = yield* GitHubGateway;
      return yield* gateway.repository(target);
    }));
    expect(repository).toEqual({ id: 42, fullName: "Quick-Release/acme-shop", private: true, archived: false });
    const mint = github.requests.find((request) => request.path === "/app/installations/7/access_tokens")!;
    expect(mint.method).toBe("POST");
    expect(mint.body).toEqual({ repository_ids: [42], permissions: { issues: "write", metadata: "read" } });
  });

  it("reuses a token in memory and refreshes it five minutes before it expires", async () => {
    const github = setup();
    await run(github, Effect.gen(function* () {
      const gateway = yield* GitHubGateway;
      yield* gateway.repository(target);
      yield* TestClock.adjust("54 minutes");
      yield* gateway.repository(target);
      expect(github.minted).toHaveLength(1);
      yield* TestClock.adjust("1 minute");
      yield* gateway.repository(target);
      expect(github.minted).toHaveLength(2);
    }));
    const authorizations = github.requests.filter((request) => request.path === "/repos/Quick-Release/acme-shop")
      .map((request) => request.headers.get("authorization"));
    expect(authorizations).toEqual([`Bearer ${github.minted[0]}`, `Bearer ${github.minted[0]}`, `Bearer ${github.minted[1]}`]);
  });

  it("reads privacy and archived state live, not from the cached mint", async () => {
    const github = setup();
    await run(github, Effect.gen(function* () {
      const gateway = yield* GitHubGateway;
      yield* gateway.repository(target);
      github.update(42, { private: false, archived: true });
      expect(yield* gateway.repository(target)).toMatchObject({ private: false, archived: true });
    }));
  });

  it("mints separately for each repository, so a token never reaches another mapping", async () => {
    const github = setup();
    github.repository({ id: 77, installationId: 7, name: "globex-site" });
    await run(github, Effect.gen(function* () {
      const gateway = yield* GitHubGateway;
      expect((yield* gateway.repository(target)).fullName).toBe("Quick-Release/acme-shop");
      expect((yield* gateway.repository({ installationId: 7, repositoryId: 77 })).fullName).toBe("Quick-Release/globex-site");
    }));
    expect(github.requests.filter((request) => request.path.endsWith("/access_tokens")).map((request) => request.body))
      .toEqual([
        { repository_ids: [42], permissions: { issues: "write", metadata: "read" } },
        { repository_ids: [77], permissions: { issues: "write", metadata: "read" } },
      ]);
  });

  it("fails App authentication without network access when the key is not PKCS#8", async () => {
    const github = setup();
    for (const pem of ["", "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----"]) {
      const error = await run(github, failureOf(GitHubGateway.use((gateway) => gateway.repository(target))), pem);
      expect(error).toEqual({ _tag: "AppAuthenticationFailed" });
    }
    expect(github.requests).toHaveLength(0);
  });

  it.each([
    ["a JWT GitHub rejects", (github: FakeGitHub) => github.next(() => Response.json({ message: "Bad credentials" }, { status: 401 })),
      { _tag: "AppAuthenticationFailed" }],
    ["an uninstalled App", (github: FakeGitHub) => github.next(() => Response.json({ message: "Not Found" }, { status: 404 })),
      { _tag: "InstallationUnavailable" }],
    ["a suspended installation", (github: FakeGitHub) => github.suspend(7), { _tag: "InstallationUnavailable" }],
    ["a repository removed from the installation", (github: FakeGitHub) => github.update(42, { installationId: 8 }),
      { _tag: "RepositoryUnavailable", reason: "not-accessible" }],
    ["an installation that has not approved Issues write", (github: FakeGitHub) => github.next(() => Response.json({
      token: "ghs_reduced", expires_at: "2026-10-17T11:00:00Z", permissions: { issues: "read", metadata: "read" },
      repositories: [{ id: 42, full_name: "Quick-Release/acme-shop", private: true, archived: false }],
    }, { status: 201 })), { _tag: "PermissionMissing", accepted: null }],
    ["a malformed mint response", (github: FakeGitHub) => github.next(() => new Response("<html>", { status: 201 })),
      { _tag: "ProviderUnavailable", status: 201 }],
  ])("maps a mint against %s to a typed failure", async (_name, arrange, expected) => {
    const github = setup();
    arrange(github);
    expect(await run(github, failureOf(GitHubGateway.use((gateway) => gateway.repository(target))))).toEqual(expected);
  });

  it("does not cache a failed mint", async () => {
    const github = setup();
    github.next(() => new Response(null, { status: 502 }));
    await run(github, Effect.gen(function* () {
      const gateway = yield* GitHubGateway;
      expect(yield* failureOf(gateway.repository(target))).toEqual({ _tag: "ProviderUnavailable", status: 502 });
      expect((yield* gateway.repository(target)).id).toBe(42);
    }));
  });

  it("drops a token GitHub rejects before its expiry and mints a fresh one on the next call", async () => {
    const github = setup();
    await run(github, Effect.gen(function* () {
      const gateway = yield* GitHubGateway;
      yield* gateway.repository(target);
      github.revoke(github.minted[0]!);
      expect(yield* failureOf(gateway.repository(target))).toEqual({ _tag: "ProviderUnavailable", status: 401 });
      expect((yield* gateway.repository(target)).id).toBe(42);
    }));
    expect(github.minted).toHaveLength(2);
  });

  const limited = (status: number, headers: Record<string, string>, message = "API rate limit exceeded") =>
    (github: FakeGitHub) => github.next(() => Response.json({ message }, { status, headers }));
  const now = START / 1000;

  it.each([
    ["a primary limit (403, nothing remaining)", limited(403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now + 900) }),
      { _tag: "RateLimited", kind: "primary", until: START + 900_000 }],
    ["a primary limit (429, nothing remaining)", limited(429, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(now + 120) }),
      { _tag: "RateLimited", kind: "primary", until: START + 120_000 }],
    ["a secondary limit with retry-after", limited(403, { "retry-after": "30", "x-ratelimit-remaining": "4000" },
      "You have exceeded a secondary rate limit"), { _tag: "RateLimited", kind: "secondary", until: START + 30_000 }],
    ["a secondary limit without headers", limited(403, {}, "You have exceeded a secondary rate limit"),
      { _tag: "RateLimited", kind: "secondary", until: START + 60_000 }],
    ["a bare 429", limited(429, {}, ""), { _tag: "RateLimited", kind: "secondary", until: START + 60_000 }],
    ["a missing permission", limited(403, { "x-accepted-github-permissions": "metadata=read" }, "Resource not accessible by integration"),
      { _tag: "PermissionMissing", accepted: "metadata=read" }],
    ["a repository that is gone", limited(404, {}, "Not Found"), { _tag: "RepositoryUnavailable", reason: "not-accessible" }],
    ["a server error", limited(503, {}, "unavailable"), { _tag: "ProviderUnavailable", status: 503 }],
    ["a connection reset", (github: FakeGitHub) => github.next(() => "reset"),
      { _tag: "ProviderUnavailable", status: null }],
  ])("maps %s on a repository read to a typed failure", async (_name, arrange, expected) => {
    const github = setup();
    github.next(() => undefined); // the mint
    arrange(github);
    expect(await run(github, failureOf(GitHubGateway.use((gateway) => gateway.repository(target))))).toEqual(expected);
  });

  it("times out a request GitHub never answers", async () => {
    const github = setup();
    const error = await run(github, Effect.gen(function* () {
      const gateway = yield* GitHubGateway;
      yield* gateway.repository(target); // mint first: signing is real async work
      github.next(() => "hang");
      const fiber = yield* Effect.forkChild(failureOf(gateway.repository(target)));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      return yield* Fiber.join(fiber);
    }));
    expect(error).toEqual({ _tag: "ProviderUnavailable", status: null });
  });

  const newIssue = { title: "Checkout does nothing", body: "<!-- gq-support:v1 intent=int_1 -->\nbody", labels: ["client-support"], assignees: ["developer"] };
  const create = GitHubGateway.use((gateway) => gateway.createIssue(target, newIssue));
  const posts = (github: FakeGitHub) => github.requests.filter((request) => request.method === "POST" && request.path.endsWith("/issues"));

  it("creates an issue with one POST and returns its identity, labels and assignees", async () => {
    const github = setup();
    const issue = await run(github, create);
    expect(issue).toEqual({
      id: expect.any(Number), nodeId: expect.any(String), number: 1, title: newIssue.title, body: newIssue.body,
      state: "open", createdAt: "2026-10-17T10:00:00Z", creator: "getquick-support-staging[bot]",
      labels: ["client-support"], assignees: ["developer"],
    });
    expect(posts(github)).toHaveLength(1);
    expect(posts(github)[0]!.path).toBe("/repos/Quick-Release/acme-shop/issues");
    expect(posts(github)[0]!.body).toEqual(newIssue);
  });

  it.each([
    ["public", { private: false }, { _tag: "RepositoryNotPrivate" }],
    ["archived", { archived: true }, { _tag: "RepositoryArchived" }],
  ])("refuses to POST to a %s repository", async (_name, change, expected) => {
    const github = setup();
    github.update(42, change);
    expect(await run(github, failureOf(create))).toEqual(expected);
    expect(posts(github)).toHaveLength(0);
  });

  it.each([
    ["a server error", () => new Response(null, { status: 502 })],
    ["a connection reset", () => "reset" as const],
    ["an unparseable success", () => new Response("<html>", { status: 201 })],
    ["a redirect", () => new Response(null, { status: 307, headers: { location: "https://api.github.com/repositories/42/issues" } })],
  ])("reports %s after the POST as an unknown outcome and never resends", async (_name, response) => {
    const github = setup();
    github.next(() => undefined); // mint
    github.next(() => undefined); // repository check
    github.next(response);
    expect(await run(github, failureOf(create))).toEqual({ _tag: "OutcomeUnknown" });
    expect(posts(github)).toHaveLength(1);
  });

  it("reports a POST that times out as an unknown outcome", async () => {
    const github = setup();
    const error = await run(github, Effect.gen(function* () {
      const gateway = yield* GitHubGateway;
      yield* gateway.repository(target);
      github.next(() => undefined);
      github.next(() => "hang");
      const fiber = yield* Effect.forkChild(failureOf(gateway.createIssue(target, newIssue)));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      return yield* Fiber.join(fiber);
    }));
    expect(error).toEqual({ _tag: "OutcomeUnknown" });
    expect(posts(github)).toHaveLength(1);
  });

  it.each([
    ["an invalid assignee (422)", (github: FakeGitHub) => { github.update(42, { collaborators: [] }); },
      { _tag: "ValidationRejected", status: 422, fields: ["assignees"] }],
    ["Issues disabled (410)", (github: FakeGitHub) => { github.update(42, { hasIssues: false }); },
      { _tag: "RepositoryUnavailable", reason: "issues-disabled" }],
    ["a repository archived after the check (403)", (github: FakeGitHub) => {
      github.next(() => undefined); github.next(() => undefined);
      github.next(() => Response.json({ message: "Repository was archived so is read-only." }, { status: 403 }));
    }, { _tag: "RepositoryArchived" }],
    ["a secondary rate limit", (github: FakeGitHub) => {
      github.next(() => undefined); github.next(() => undefined);
      github.next(() => Response.json({ message: "You have exceeded a secondary rate limit" }, { status: 403, headers: { "retry-after": "60" } }));
    }, { _tag: "RateLimited", kind: "secondary", until: START + 60_000 }],
    ["a rejected token (401)", (github: FakeGitHub) => {
      github.next(() => undefined); github.next(() => undefined);
      github.next(() => Response.json({ message: "Bad credentials" }, { status: 401 }));
    }, { _tag: "ProviderUnavailable", status: 401 }],
  ])("maps %s on create to a known non-creation", async (_name, arrange, expected) => {
    const github = setup();
    arrange(github);
    expect(await run(github, failureOf(create))).toEqual(expected);
    expect(posts(github)).toHaveLength(1);
  });

  it("lists only the App's issues, newest first, a page at a time and without pull requests", async () => {
    const github = setup();
    const { first, second } = await run(github, Effect.gen(function* () {
      const gateway = yield* GitHubGateway;
      for (let i = 0; i < 101; i++) {
        yield* gateway.createIssue(target, { ...newIssue, title: `Report ${i}` });
        yield* TestClock.adjust("1 second");
      }
      const issueId = github.issues.length;
      github.issues.push({ ...github.issues[0]!, id: 1, number: 500, title: "By a person", user: { login: "developer", type: "User" } });
      github.issues.push({ ...github.issues[0]!, id: 2, number: 501, title: "A PR", created_at: "2026-10-17T11:00:00Z",
        pull_request: { url: "https://api.github.com/repos/Quick-Release/acme-shop/pulls/501" } });
      expect(github.issues).toHaveLength(issueId + 2);
      return { first: yield* gateway.listAppIssues(target, 1), second: yield* gateway.listAppIssues(target, 2) };
    }));
    expect(first.hasNextPage).toBe(true);
    expect(first.issues).toHaveLength(99);
    expect(first.issues[0]!.title).toBe("Report 100");
    // The pull request still occupies one of page one's hundred slots.
    expect(second).toEqual({ hasNextPage: false, issues: [
      expect.objectContaining({ title: "Report 1" }), expect.objectContaining({ title: "Report 0" }),
    ] });
    const list = github.requests.find((request) => request.method === "GET" && request.path.endsWith("/issues"))!;
    expect(Object.fromEntries(list.query)).toEqual({
      creator: "getquick-support-staging[bot]", state: "all", sort: "created", direction: "desc", per_page: "100", page: "1",
    });
  });

  it("reads an issue conditionally on its ETag", async () => {
    const github = setup();
    await run(github, Effect.gen(function* () {
      const gateway = yield* GitHubGateway;
      yield* gateway.createIssue(target, newIssue);
      const fresh = yield* gateway.readIssue(target, 1);
      expect(fresh).toMatchObject({ _tag: "Fresh", issue: { number: 1, state: "open" }, etag: expect.any(String) });
      if (fresh._tag !== "Fresh") throw new Error();
      expect(yield* gateway.readIssue(target, 1, fresh.etag!)).toEqual({ _tag: "NotModified" });
      github.issues[0]!.state = "closed";
      expect(yield* gateway.readIssue(target, 1, fresh.etag!)).toMatchObject({ _tag: "Fresh", issue: { state: "closed" } });
    }));
    expect(github.requests.filter((request) => request.path.endsWith("/issues/1")).map((request) => request.headers.get("if-none-match")))
      .toEqual([null, expect.any(String), expect.any(String)]);
  });

  it("reports a transferred issue without following the move, and a deleted one as gone", async () => {
    const github = setup();
    await run(github, Effect.gen(function* () {
      const gateway = yield* GitHubGateway;
      yield* gateway.createIssue(target, newIssue);
      yield* gateway.createIssue(target, newIssue);
      github.issues[0]!.movedTo = "https://api.github.com/repositories/99/issues/7";
      github.issues[1]!.deleted = true;
      expect(yield* failureOf(gateway.readIssue(target, 1)))
        .toEqual({ _tag: "IssueMoved", location: "https://api.github.com/repositories/99/issues/7" });
      expect(yield* failureOf(gateway.readIssue(target, 2))).toEqual({ _tag: "IssueGone" });
    }));
    expect(github.requests.some((request) => request.path.startsWith("/repositories/99"))).toBe(false);
  });

  it("never puts the App key, a JWT or an installation token in logs or failures", async () => {
    const github = setup();
    const logs: string[] = [];
    const failures: string[] = [];
    const echo = (request: { headers: Headers; body: unknown }) => Response.json({
      message: `echo ${request.headers.get("authorization")} ${JSON.stringify(request.body)}`,
      errors: [{ field: request.headers.get("authorization"), value: request.headers.get("authorization") }],
    }, { status: 500, headers: { "x-echo": request.headers.get("authorization") ?? "" } });
    const scenarios: [(() => void), Effect.Effect<unknown, unknown, GitHubGateway>][] = [
      [() => github.next(echo), GitHubGateway.use((gateway) => gateway.repository(target))],
      [() => { github.next(() => undefined); github.next(echo); }, GitHubGateway.use((gateway) => gateway.repository(target))],
      [() => { github.next(() => undefined); github.next(() => undefined); github.next(echo); }, create],
      [() => { github.next(() => undefined); github.next(() => undefined);
        github.next((request) => Response.json({ message: "Validation Failed", errors: [{ field: request.headers.get("authorization") }] }, { status: 422 })); }, create],
      [() => { github.next(() => undefined); github.next(() => undefined); github.next(() => "reset"); }, create],
      [() => { github.next(() => undefined); github.next(echo); }, GitHubGateway.use((gateway) => gateway.listAppIssues(target, 1))],
      [() => { github.next(() => undefined); github.next(echo); }, GitHubGateway.use((gateway) => gateway.readIssue(target, 1))],
      [() => { github.next(() => undefined);
        github.next((request) => new Response(null, { status: 301, headers: { location: `https://evil.invalid/${request.headers.get("authorization")}` } })); },
      GitHubGateway.use((gateway) => gateway.readIssue(target, 1))],
      [() => github.suspend(7), GitHubGateway.use((gateway) => gateway.repository(target))],
    ];
    for (const [arrange, effect] of scenarios) {
      arrange();
      const exit = await run(github, Effect.exit(effect).pipe(
        Effect.provide(Logger.layer([Logger.map(Logger.formatJson, (line) => { logs.push(line); })])),
      ));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) failures.push(Cause.pretty(exit.cause), JSON.stringify(exit.cause));
    }
    expect(logs.length).toBeGreaterThanOrEqual(scenarios.length);
    expect(logs.every((line) => /"operation"/.test(line) && /"error"/.test(line))).toBe(true);
    const keyBody = github.privateKeyPem.split("\n")[5]!;
    for (const text of [...logs, ...failures]) {
      for (const secret of [...github.minted, "ghs_fake", "Bearer", "eyJhbGci", keyBody, "PRIVATE KEY", "evil.invalid"]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it("never lets Workers fetch follow a redirect in the live layer", async () => {
    const github = setup();
    const redirects: (string | undefined)[] = [];
    const spy: typeof fetch = async (_input, init) => {
      redirects.push(init?.redirect);
      return new Response(null, { status: 307, headers: { location: "https://elsewhere.invalid/" } });
    };
    const error = await Effect.runPromise(failureOf(GitHubGateway.use((gateway) => gateway.repository(target))).pipe(
      Effect.provide(GitHubGateway.live({ clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem })),
      Effect.provide(Layer.succeed(FetchHttpClient.Fetch, spy)),
    ));
    expect(error).toEqual({ _tag: "ProviderUnavailable", status: 307 });
    expect(redirects).toEqual(["manual"]);
  });

  it("stops reading a response body larger than 8 MiB", async () => {
    const github = setup();
    github.next(() => undefined);
    let pulled = 0;
    github.next(() => new Response(new ReadableStream({
      pull(controller) {
        pulled++;
        controller.enqueue(new Uint8Array(1024 * 1024).fill(32));
        if (pulled > 20) controller.close();
      },
    }), { status: 200 }));
    expect(await run(github, failureOf(GitHubGateway.use((gateway) => gateway.repository(target)))))
      .toEqual({ _tag: "ProviderUnavailable", status: null });
    expect(pulled).toBeLessThan(12);
  });

  it("reports a missing issue as gone only while its repository is still reachable", async () => {
    const github = setup();
    await run(github, Effect.gen(function* () {
      const gateway = yield* GitHubGateway;
      expect(yield* failureOf(gateway.readIssue(target, 404))).toEqual({ _tag: "IssueGone" });
      github.update(42, { installationId: 8 });
      expect(yield* failureOf(gateway.readIssue(target, 404))).toEqual({ _tag: "RepositoryUnavailable", reason: "not-accessible" });
    }));
  });
});

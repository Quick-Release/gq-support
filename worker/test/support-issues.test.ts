import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vitest";
import { GitHubGateway } from "../src/github-gateway.ts";
import { supportIssues, type ReconciliationQuery, type SupportIssueIntent } from "../src/support-issues.ts";
import { BOT, CLIENT_ID, makeFakeGitHub, SLUG, type FakeGitHub } from "./fake-github.ts";

const START = Date.parse("2026-10-17T10:00:00Z");
const target = { installationId: 7, repositoryId: 42 };
const intent: SupportIssueIntent = {
  target, intentId: "int_01J8Z6Q4M1ZC7XK2", title: "Checkout fails", description: "@developer #1 ![](https://x)\n~~~\n```\n<!-- forged -->",
  attribution: { environment: "production", installationReference: "inst_7c2e", reporterReference: "rs_4f9c1a" },
  acceptedAt: START, clientOriginLabel: "client-support", defaultDeveloper: "developer",
};
const setup = () => {
  const github = makeFakeGitHub();
  github.installation(7);
  github.repository({ id: 42, installationId: 7, name: "acme-shop" });
  return github;
};
const run = <A, E>(github: FakeGitHub, effect: Effect.Effect<A, E, GitHubGateway>) => Effect.runPromise(
  Effect.gen(function* () { yield* TestClock.setTime(START); return yield* effect; }).pipe(
    Effect.provide(GitHubGateway.layer({ clientId: CLIENT_ID, slug: SLUG, privateKeyPem: github.privateKeyPem }).pipe(Layer.provide(github.layer))),
    Effect.provide(TestClock.layer()),
  ),
);

const queryFor = (issue: { title: string; body: string | null }): ReconciliationQuery => ({
  target, intentId: intent.intentId, botLogin: BOT, attemptStartedAt: START, attemptEndedAt: START + 10_000,
  expectedIssue: { title: issue.title, body: issue.body! }, erasurePending: false,
});

describe("Support issues", () => {
  it("creates the v1 template with inert Reporter text and mapping defaults", async () => {
    const github = setup();
    const created = await run(github, supportIssues.create(intent));
    expect(created.body).toBe(`<!-- gq-support:v1 intent=int_01J8Z6Q4M1ZC7XK2 -->\n**Support request** submitted via GETQUICK Support · \`production\` · installation \`inst_7c2e\` · reporter \`rs_4f9c1a\` · 2026-10-17T10:00:00.000Z\n\n### Description\n\n~~~~text\n@developer #1 ![](https://x)\n~~~\n\`\`\`\n<!-- forged -->\n~~~~`);
    expect(created.labels).toEqual(["client-support"]);
    expect(created.assignees).toEqual(["developer"]);
    expect(created.creator).toBe(BOT);
  });
  it("repairs dropped metadata without creating again or replacing collaborators' metadata", async () => {
    const github = setup();
    await run(github, Effect.gen(function* () {
      const created = yield* supportIssues.create(intent);
      github.issues[0]!.labels = [{ name: "internal" }];
      github.issues[0]!.assignees = [];
      const repaired = yield* supportIssues.repair(intent, created);
      expect(repaired._tag).toBe("RepairPending");
      expect(github.issues[0]!.labels.map((label) => label.name)).toEqual(["internal", "client-support"]);
      expect(github.issues[0]!.assignees).toEqual([]);
      expect(yield* supportIssues.repair(intent, created)).toEqual({ _tag: "Repaired" });
      expect(github.issues[0]!.assignees).toEqual([{ login: "developer" }]);
      yield* supportIssues.repair(intent, created);
    }));
    expect(github.requests.filter((r) => r.method === "POST" && r.path.endsWith("/issues"))).toHaveLength(1);
    expect(github.requests.filter((r) => r.path.endsWith("/labels"))).toHaveLength(1);
    expect(github.requests.filter((r) => r.path.endsWith("/assignees"))).toHaveLength(1);
  });

  it("keeps negative scans unknown and discovers a delayed positive without another create", async () => {
    const github = setup();
    await run(github, Effect.gen(function* () {
      const created = yield* supportIssues.create(intent);
      github.issues[0]!.deleted = true; // Simulate a list visibility delay.
      const query = { target, intentId: intent.intentId, botLogin: BOT, attemptStartedAt: START, attemptEndedAt: START + 10_000,
        expectedIssue: { title: created.title, body: created.body! }, erasurePending: false };
      expect(yield* supportIssues.reconcile(query)).toMatchObject({ _tag: "Unknown", reason: "no-match" });
      expect(yield* supportIssues.reconcile(query)).toMatchObject({ _tag: "Unknown", reason: "no-match" });
      yield* TestClock.adjust("24 hours");
      expect(yield* supportIssues.reconcile(query)).toMatchObject({ _tag: "Unknown", reason: "no-match" });
      github.issues[0]!.deleted = false;
      expect(yield* supportIssues.reconcile(query)).toMatchObject({ _tag: "Delivered", issue: { id: created.id } });
    }));
    expect(github.requests.filter((r) => r.method === "POST" && r.path.endsWith("/issues"))).toHaveLength(1);
  });

  it("preserves successful creation when GitHub silently drops labels and assignees", async () => {
    const github = setup();
    github.onCreate((issue) => { issue.labels = []; issue.assignees = []; return undefined; });
    await run(github, Effect.gen(function* () {
      const created = yield* supportIssues.create(intent);
      expect(created.labels).toEqual([]);
      expect(created.assignees).toEqual([]);
      expect(yield* supportIssues.repair(intent, created)).toEqual({ _tag: "RepairPending" });
      expect(yield* supportIssues.repair(intent, created)).toEqual({ _tag: "Repaired" });
    }));
    expect(github.requests.filter((r) => r.method === "POST" && r.path.endsWith("/issues"))).toHaveLength(1);
  });

  it.each([502, 301, 201])("reconciles an ambiguous %i create response without retrying", async (status) => {
    const github = setup();
    github.onCreate(() => new Response("malformed", { status, headers: { location: "https://example.com" } }));
    await run(github, Effect.gen(function* () {
      const expected = yield* supportIssues.prepare(intent);
      expect((yield* supportIssues.create(intent).pipe(Effect.flip))._tag).toBe("OutcomeUnknown");
      const result = yield* supportIssues.reconcile({ target, intentId: intent.intentId, botLogin: BOT,
        attemptStartedAt: START, attemptEndedAt: START + 10_000,
        expectedIssue: expected, erasurePending: false });
      expect(result._tag).toBe("Delivered");
    }));
    expect(github.issues).toHaveLength(1);
    expect(github.requests.filter((r) => r.method === "POST" && r.path.endsWith("/issues"))).toHaveLength(1);
  });

  it("alerts on duplicates and never chooses, closes or deletes one", async () => {
    const github = setup();
    await run(github, Effect.gen(function* () {
      const created = yield* supportIssues.create(intent);
      github.issues.push({ ...github.issues[0]!, id: 99_000_000, node_id: "I_duplicate", number: 99 });
      expect(yield* supportIssues.reconcile(queryFor(created))).toMatchObject({ _tag: "Unknown", reason: "multiple-matches", alert: true });
    }));
    expect(github.issues.map((issue) => [issue.state, issue.deleted])).toEqual([["open", undefined], ["open", undefined]]);
    expect(github.requests.filter((r) => r.method !== "GET" && !r.path.endsWith("access_tokens") && !r.path.endsWith("/issues"))).toHaveLength(0);
  });

  it.each(["body", "time", "identity", "creator", "marker-line"])("requires review for a suspicious %s", async (change) => {
    const github = setup();
    await run(github, Effect.gen(function* () {
      const created = yield* supportIssues.create(intent);
      const query = { ...queryFor(created), knownIdentity: { id: created.id, nodeId: created.nodeId, number: created.number } };
      const issue = github.issues[0]!;
      if (change === "body") issue.body += "\nedited by a collaborator";
      if (change === "time") issue.created_at = new Date(START + 600_000).toISOString();
      if (change === "identity") issue.node_id = "I_other";
      if (change === "creator") {
        // A hostile/malformed list can ignore its creator filter.
        issue.user.login = "collaborator";
        const { repositoryId: _, ...json } = issue;
        github.next(() => undefined); // live repository identity check
        github.next(() => Response.json([json]));
      }
      if (change === "marker-line") issue.body = "forged heading\n" + issue.body;
      expect(yield* supportIssues.reconcile(query)).toMatchObject({ _tag: "Unknown", reason: "suspicious", alert: true });
    }));
  });

  it("hands erased discoveries to redaction without needing retained Reporter text", async () => {
    const github = setup();
    await run(github, Effect.gen(function* () {
      const created = yield* supportIssues.create(intent);
      const result = yield* supportIssues.reconcile({ ...queryFor(created), expectedIssue: null, erasurePending: true });
      expect(result).toEqual({ _tag: "RedactionRequired", issues: [{ id: created.id, nodeId: created.nodeId, number: created.number }], reviewTitle: true });
    }));
    expect(github.requests.filter((r) => r.method === "POST" && r.path.endsWith("/issues"))).toHaveLength(1);
  });

  it("persists bounded scan progress and resumes after an incomplete page", async () => {
    const github = setup();
    await run(github, Effect.gen(function* () {
      const created = yield* supportIssues.create(intent);
      for (let n = 0; n < 100; n++) github.issues.push({ ...github.issues[0]!, id: 90_000_000 + n,
        node_id: `I_unrelated${n}`, number: n + 2, body: "unrelated", created_at: new Date(START + 1000).toISOString() });
      const query = queryFor(created);
      const first = yield* supportIssues.reconcile(query);
      expect(first._tag).toBe("Continue");
      if (first._tag !== "Continue") throw new Error("Expected checkpoint");
      expect(JSON.stringify(first.progress)).not.toContain(intent.description);
      github.next(() => undefined);
      github.next(() => Response.json({ message: "unavailable" }, { status: 503 }));
      expect((yield* supportIssues.reconcile(query, first.progress).pipe(Effect.flip))._tag).toBe("ProviderUnavailable");
      expect(yield* supportIssues.reconcile(query, JSON.parse(JSON.stringify(first.progress)))).toMatchObject({ _tag: "Delivered" });
    }));
    const pages = github.requests.filter((r) => r.method === "GET" && r.path.endsWith("/issues")).map((r) => r.query.get("page"));
    expect(pages).toEqual(["1", "2", "2", "1"]);
  });

  it("does not resolve a sole candidate until the complete scan excludes duplicates", async () => {
    const github = setup();
    await run(github, Effect.gen(function* () {
      const created = yield* supportIssues.create(intent);
      for (let n = 0; n < 100; n++) github.issues.push({ ...github.issues[0]!, id: 8_000_000 + n,
        node_id: `I_older${n}`, number: n + 2, body: "unrelated", created_at: new Date(START - 1000).toISOString() });
      const first = yield* supportIssues.reconcile(queryFor(created));
      expect(first._tag).toBe("Continue");
      if (first._tag !== "Continue") throw new Error("Expected checkpoint");
      github.issues[1]!.body = created.body;
      expect(yield* supportIssues.reconcile(queryFor(created), first.progress)).toMatchObject({ _tag: "Unknown", reason: "multiple-matches", alert: true });
    }));
  });

  it("treats moving pagination as inconclusive", async () => {
    const github = setup();
    await run(github, Effect.gen(function* () {
      const created = yield* supportIssues.create(intent);
      for (let n = 0; n < 100; n++) github.issues.push({ ...github.issues[0]!, id: 90_000_000 + n,
        node_id: `I_newer${n}`, number: n + 2, body: "unrelated", created_at: new Date(START + 1000).toISOString() });
      const first = yield* supportIssues.reconcile(queryFor(created));
      if (first._tag !== "Continue") throw new Error("Expected checkpoint");
      github.issues.push({ ...github.issues[100]!, id: 99_000_000, node_id: "I_newest", number: 102 });
      expect(yield* supportIssues.reconcile(queryFor(created), first.progress)).toMatchObject({ _tag: "Unknown", reason: "shifted-pages" });
    }));
  });

  it("rejects a checkpoint reused for a different pinned repository", async () => {
    const github = setup();
    await run(github, Effect.gen(function* () {
      const created = yield* supportIssues.create(intent);
      github.next(() => undefined);
      const { repositoryId: _, ...json } = github.issues[0]!;
      github.next(() => Response.json([json], { headers: { link: '<https://api.github.com/issues?page=2>; rel="next"' } }));
      const first = yield* supportIssues.reconcile(queryFor(created));
      if (first._tag !== "Continue") throw new Error("Expected checkpoint");
      expect((yield* supportIssues.reconcile({ ...queryFor(created), target: { ...target, repositoryId: 77 } }, first.progress).pipe(Effect.flip))._tag).toBe("ValidationRejected");
    }));
  });

  it("isolates a throttled repair from successful delivery", async () => {
    const github = setup();
    github.onCreate((issue) => { issue.labels = []; return undefined; });
    await run(github, Effect.gen(function* () {
      const created = yield* supportIssues.create(intent);
      github.next(() => undefined); // repository
      github.next(() => undefined); // issue
      github.next(() => undefined); // repair safety
      github.next(() => Response.json({ message: "slow down" }, { status: 429, headers: { "retry-after": "60" } }));
      expect((yield* supportIssues.repair(intent, created).pipe(Effect.flip))._tag).toBe("RateLimited");
      expect(yield* supportIssues.reconcile(queryFor(created))).toMatchObject({ _tag: "Delivered" });
      expect(yield* supportIssues.repair(intent, created)).toEqual({ _tag: "Repaired" });
    }));
    expect(github.issues).toHaveLength(1);
  });

  it("discovers the issue after a timed-out response arrives late", async () => {
    const github = setup();
    let finish: (() => void) | undefined;
    github.onCreate((issue) => new Response(new ReadableStream({
      start(controller) {
        finish = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify(issue))); controller.close(); };
      },
    }), { status: 201 }));
    await run(github, Effect.gen(function* () {
      const pending = yield* supportIssues.create(intent).pipe(Effect.flip, Effect.forkChild);
      // Let token signing and dispatch complete before advancing the timeout clock.
      yield* Effect.promise(async () => {
        for (let n = 0; n < 100 && !finish; n++) await new Promise((resolve) => setTimeout(resolve, 1));
      });
      expect(finish).toBeDefined();
      yield* TestClock.adjust("11 seconds");
      expect((yield* Fiber.join(pending))._tag).toBe("OutcomeUnknown");
      expect(() => finish!()).toThrow(); // Timed-out response stream was cancelled; late bytes cannot change the outcome.
      const issue = github.issues[0]!;
      expect(yield* supportIssues.reconcile(queryFor({ title: issue.title, body: issue.body }))).toMatchObject({ _tag: "Delivered" });
    }));
    expect(github.issues).toHaveLength(1);
  });

  it("treats a successful response with conflicting content as unknown", async () => {
    const github = setup();
    github.onCreate((issue) => { issue.body = "another issue"; return undefined; });
    expect((await run(github, supportIssues.create(intent).pipe(Effect.flip)))._tag).toBe("OutcomeUnknown");
  });

  it("rejects attribution injection and invalid timestamps before sending anything", async () => {
    const github = setup();
    for (const invalid of [
      { ...intent, attribution: { ...intent.attribution, environment: "prod` @developer" } },
      { ...intent, acceptedAt: Number.MAX_VALUE },
    ]) {
      expect((await run(github, supportIssues.create(invalid).pipe(Effect.flip)))._tag).toBe("ValidationRejected");
    }
    expect(github.requests).toHaveLength(0);
  });

  it.each(["deletion", "transfer"])("keeps a duplicate hidden by a page %s unknown", async (change) => {
    const github = setup();
    await run(github, Effect.gen(function* () {
      const created = yield* supportIssues.create(intent);
      for (let n = 0; n < 99; n++) github.issues.push({ ...github.issues[0]!, id: 80_000_000 + n,
        node_id: `I_unrelated${n}`, number: n + 2, body: "unrelated", created_at: new Date(START - 1000).toISOString() });
      github.issues.push({ ...github.issues[0]!, id: 70_000_000, node_id: "I_duplicate", number: 101,
        created_at: new Date(START - 2000).toISOString() });
      const first = yield* supportIssues.reconcile(queryFor(created));
      if (first._tag !== "Continue") throw new Error("Expected checkpoint");
      if (change === "deletion") github.issues[1]!.deleted = true;
      else github.issues[1]!.repositoryId = 77;
      expect(yield* supportIssues.reconcile(queryFor(created), first.progress)).toMatchObject({ _tag: "Unknown", reason: "shifted-pages" });
    }));
  });

  it("redacts once, idempotently, keeping the marker and attribution", async () => {
    const github = setup();
    await run(github, Effect.gen(function* () {
      const created = yield* supportIssues.create(intent);
      const derived = async (title: string) => title === intent.title;
      expect(yield* supportIssues.redact(target, intent.intentId, created, derived)).toEqual({ _tag: "Redacted", residual: ["edit_history"] });
      expect(github.issues[0]!.title).toBe("Support request (erased)");
      expect(github.issues[0]!.body).toBe(`${created.body!.split("\n", 2).join("\n")}\n\n### Description\n\nSupport request text erased at the Reporter's request.`);
      // A rerun after a lost result sends nothing more.
      expect(yield* supportIssues.redact(target, intent.intentId, created, derived)).toEqual({ _tag: "Redacted", residual: ["edit_history"] });
    }));
    expect(github.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
  });

  describe("Report context", () => {
    const CONTEXT = '{"schema":1,"default":{"wp_version":"6.5.5","support_plugin_version":"0.1.8+build_7","originating_screen":"post-editor"}}';
    const withContext: SupportIssueIntent = { ...intent, context: CONTEXT };
    const plain = `<!-- gq-support:v1 intent=int_01J8Z6Q4M1ZC7XK2 -->\n**Support request** submitted via GETQUICK Support · \`production\` · installation \`inst_7c2e\` · reporter \`rs_4f9c1a\` · 2026-10-17T10:00:00.000Z\n\n### Description\n\n~~~~text\n@developer #1 ![](https://x)\n~~~\n\`\`\`\n<!-- forged -->\n~~~~`;

    it("renders the reviewed values in their own section after the inert Reporter text", async () => {
      const github = setup();
      const created = await run(github, supportIssues.create(withContext));
      expect(created.body).toBe(`${plain}\n\n### Report context\n\nReviewed and sent by the Reporter. The screen is a hint, not evidence of access.\n\n` +
        "- WordPress version: `6.5.5`\n- Support plugin version: `0.1.8+build_7`\n- Originating admin screen: `post-editor`");
      // Reconciliation rebuilds exactly this body from the frozen intent.
      expect((await run(github, supportIssues.prepare(withContext))).body).toBe(created.body);
    });

    it.each([
      ["nothing selected", '{"schema":1,"default":{}}'],
      ["unreadable", "{not json"],
      ["HTML in a value", '{"schema":1,"default":{"wp_version":"6.5<img src=x onerror=alert(1)>"}}'],
      ["Markdown in a value", '{"schema":1,"default":{"wp_version":"6.5`](https://x)"}}'],
      ["an unapproved section", '{"schema":1,"default":{"wp_version":"6.5.5"},"technical":{"php_version":"8.3"}}'],
      ["an unapproved key", '{"schema":1,"default":{"url":"https://shop.example/wp-admin/post.php?post=1&_wpnonce=secret"}}'],
    ])("renders no section for %s", async (_, context) => {
      const created = await run(setup(), supportIssues.create({ ...intent, context }));
      expect(created.body).toBe(plain);
    });

    it("loses the section to redaction, keeping only the marker and attribution", async () => {
      const github = setup();
      await run(github, Effect.gen(function* () {
        const created = yield* supportIssues.create(withContext);
        expect(yield* supportIssues.redact(target, intent.intentId, created, async () => true)).toMatchObject({ _tag: "Redacted" });
        expect(github.issues[0]!.body).toBe(`${created.body!.split("\n", 2).join("\n")}\n\n### Description\n\nSupport request text erased at the Reporter's request.`);
        expect(github.issues[0]!.body).not.toContain("6.5.5");
        expect(github.issues[0]!.body).not.toContain("post-editor");
      }));
    });
  });

  it("never edits an issue whose marker or identity changed, and reports moved or deleted issues", async () => {
    const github = setup();
    await run(github, Effect.gen(function* () {
      const created = yield* supportIssues.create(intent);
      github.edit(github.issues[0]!, { body: `Moved marker\n${created.body}` });
      expect(yield* supportIssues.redact(target, intent.intentId, created, null)).toEqual({ _tag: "NeedsReview", reason: "marker" });
      expect(yield* supportIssues.redact(target, intent.intentId, { ...created, nodeId: "I_other" }, null)).toEqual({ _tag: "NeedsReview", reason: "identity" });
      github.issues[0]!.movedTo = "https://api.github.com/repos/Quick-Release/elsewhere/issues/1";
      expect(yield* supportIssues.redact(target, intent.intentId, created, null)).toEqual({ _tag: "Lost", residual: ["transferred"] });
      github.issues[0]!.movedTo = undefined;
      github.issues[0]!.deleted = true;
      expect(yield* supportIssues.redact(target, intent.intentId, created, null)).toEqual({ _tag: "Lost", residual: [] });
    }));
    expect(github.requests.filter((r) => r.method === "PATCH")).toHaveLength(0);
  });
});

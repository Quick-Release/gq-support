import { generateKeyPairSync, verify } from "node:crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

/**
 * An in-memory GitHub for GitHubGateway tests. It enforces what the gateway
 * relies on: RS256 App JWTs with a ten-minute ceiling, installation tokens
 * that expire after an hour and reach only the repositories they were minted
 * for, and the documented error statuses. Scripted responses override it.
 */
export interface FakeRepository {
  id: number;
  owner: string;
  name: string;
  private: boolean;
  archived: boolean;
  hasIssues: boolean;
  installationId: number;
  collaborators: string[];
}

export interface FakeIssue {
  id: number;
  node_id: string;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  created_at: string;
  updated_at: string;
  user: { login: string; type: string };
  labels: { name: string }[];
  assignees: { login: string }[];
  repositoryId: number;
  comments?: number;
  /** Not yet in the search index. */
  hidden?: boolean;
  pull_request?: { url: string };
  deleted?: boolean;
  movedTo?: string;
}

export interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Headers;
  body: unknown;
}

/** Returning `undefined` hands the request to the fake; `"hang"` never answers. */
export type Script = (request: Recorded) => Response | "hang" | "reset" | undefined | Promise<Response | undefined>;

export const CLIENT_ID = "Iv23.fake-client";
export const SLUG = "getquick-support-staging";
export const BOT = `${SLUG}[bot]`;

export const makeFakeGitHub = () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const installations = new Map<number, { suspended: boolean }>();
  const repositories = new Map<number, FakeRepository>();
  const issues: FakeIssue[] = [];
  const tokens = new Map<string, { installationId: number; repositoryIds: number[]; expiresAt: number; permissions: Record<string, string> }>();
  const requests: Recorded[] = [];
  const scripts: Script[] = [];
  const minted: string[] = [];
  let sequence = 0;
  const omitted = new Set<string>();
  let afterCreate: ((issue: FakeIssue) => Response | undefined | Promise<Response | undefined>) | undefined;

  const iso = (time: number) => new Date(time).toISOString().replace(/\.\d{3}Z$/, "Z");
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    Response.json(body, { status, headers: { "x-github-request-id": "FAKE:REQUEST", ...headers } });
  const message = (status: number, text: string, headers: Record<string, string> = {}) =>
    json({ message: text, documentation_url: "https://docs.github.com/rest" }, status, headers);

  const repositoryJson = (repository: FakeRepository) => ({
    id: repository.id,
    node_id: `R_${repository.id}`,
    name: repository.name,
    full_name: `${repository.owner}/${repository.name}`,
    owner: { login: repository.owner },
    private: repository.private,
    visibility: repository.private ? "private" : "public",
    archived: repository.archived,
    has_issues: repository.hasIssues,
  });
  const issueJson = (issue: FakeIssue) => {
    const { repositoryId: _r, deleted: _d, movedTo: _m, hidden: _h, ...rest } = issue;
    return rest;
  };

  const appJwt = (header: string | null, now: number): boolean => {
    const jwt = header?.startsWith("Bearer ") ? header.slice(7) : "";
    const [head, payload, signature] = jwt.split(".");
    if (!head || !payload || !signature) return false;
    if (!verify("RSA-SHA256", Buffer.from(`${head}.${payload}`), publicKey, Buffer.from(signature, "base64url"))) {
      return false;
    }
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    const seconds = Math.floor(now / 1000);
    return JSON.parse(Buffer.from(head, "base64url").toString()).alg === "RS256" &&
      claims.iss === CLIENT_ID && claims.exp - claims.iat <= 600 && claims.iat <= seconds + 60 && claims.exp > seconds;
  };

  const repositoryAt = (owner: string, name: string) =>
    [...repositories.values()].find((repository) => repository.owner === owner && repository.name === name);

  const handle = (request: Recorded, now: number): Response | Promise<Response> => {
    const path = request.path;
    const mint = path.match(/^\/app\/installations\/(\d+)\/access_tokens$/);
    if (mint && request.method === "POST") {
      if (!appJwt(request.headers.get("authorization"), now)) return message(401, "A JSON web token could not be decoded");
      const installationId = Number(mint[1]);
      const installation = installations.get(installationId);
      if (!installation) return message(404, "Not Found");
      if (installation.suspended) return message(403, "This installation has been suspended");
      const body = request.body as { repository_ids?: number[]; permissions?: Record<string, string> };
      const ids = body.repository_ids ?? [];
      const scoped = ids.map((id) => repositories.get(id));
      if (scoped.some((repository) => !repository || repository.installationId !== installationId)) {
        return message(422, "There is at least one repository that does not exist or is not accessible to the parent installation.");
      }
      const token = `ghs_fake${String(++sequence).padStart(4, "0")}SECRETTOKENVALUE`;
      const expiresAt = now + 3_600_000;
      const permissions = body.permissions ?? { issues: "write", metadata: "read" };
      tokens.set(token, { installationId, repositoryIds: ids, expiresAt, permissions });
      minted.push(token);
      return json({
        token,
        expires_at: new Date(expiresAt).toISOString().replace(/\.\d{3}Z$/, "Z"),
        permissions,
        repository_selection: "selected",
        repositories: scoped.map((repository) => Object.fromEntries(Object.entries(repositoryJson(repository!))
          .filter(([field]) => !omitted.has(field)))),
      }, 201);
    }

    const header = request.headers.get("authorization") ?? "";
    const token = tokens.get(header.startsWith("Bearer ") ? header.slice(7) : "");
    if (!token || token.expiresAt <= now) return message(401, "Bad credentials");
    if (path === "/search/issues" && request.method === "GET") {
      // Supports repo:, is:issue, author:app/<slug>, in:body and one quoted phrase.
      const q = request.query.get("q") ?? "";
      const [owner, name] = (/\brepo:([^\s/]+)\/(\S+)/.exec(q) ?? []).slice(1);
      const searched = owner && name ? repositoryAt(owner, name) : undefined;
      if (!searched || !token.repositoryIds.includes(searched.id)) return json({ message: "Validation Failed" }, 422);
      const phrase = /"([^"]+)"/.exec(q)?.[1] ?? "";
      const author = /\bauthor:app\/(\S+)/.exec(q)?.[1];
      const found = issues.filter((issue) => issue.repositoryId === searched.id && !issue.deleted && !issue.hidden &&
        (!author || issue.user.login === `${author}[bot]`) && (issue.body ?? "").includes(phrase));
      const perPage = Number(request.query.get("per_page") ?? 30);
      return json({ total_count: found.length, incomplete_results: false, items: found.slice(0, perPage).map(issueJson) });
    }
    const match = path.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    const repository = match && repositoryAt(match[1]!, match[2]!);
    if (!match || !repository || !token.repositoryIds.includes(repository.id) ||
        repository.installationId !== token.installationId ||
        installations.get(repository.installationId)?.suspended) return message(404, "Not Found");
    const rest = match[3] ?? "";
    if (request.method !== "GET" && token.permissions.issues !== "write") return message(403, "Resource not accessible by integration");

    if (rest === "" && request.method === "GET") return json(repositoryJson(repository));
    if (rest === "/issues" && request.method === "POST") {
      if (repository.archived) return message(403, "Repository was archived so is read-only.");
      if (!repository.hasIssues) return message(410, "Issues are disabled for this repo");
      const body = request.body as { title?: string; body?: string; labels?: string[]; assignees?: string[] };
      if (!body.title) return json({ message: "Validation Failed", errors: [{ resource: "Issue", code: "missing_field", field: "title" }] }, 422);
      const invalid = (body.assignees ?? []).filter((login) => !repository.collaborators.includes(login));
      if (invalid.length > 0) {
        return json({ message: "Validation Failed", errors: [{ value: invalid[0], resource: "Issue", field: "assignees", code: "invalid" }] }, 422);
      }
      const number = issues.filter((issue) => issue.repositoryId === repository.id).length + 1;
      const issue: FakeIssue = {
        id: 9_000_000 + ++sequence,
        node_id: `I_${sequence}`,
        number,
        title: body.title,
        body: body.body ?? null,
        state: "open",
        created_at: iso(now),
        updated_at: iso(now),
        user: { login: BOT, type: "Bot" },
        labels: (body.labels ?? []).map((name) => ({ name })),
        assignees: (body.assignees ?? []).map((login) => ({ login })),
        comments: 0,
        repositoryId: repository.id,
      };
      issues.push(issue);
      return Promise.resolve(afterCreate?.(issue)).then((response) => response ?? json(issueJson(issue), 201));
    }
    if (rest === "/issues" && request.method === "GET") {
      const creator = request.query.get("creator");
      const since = request.query.get("since");
      const field = request.query.get("sort") === "updated" ? "updated_at" : "created_at";
      const direction = request.query.get("direction") === "asc" ? 1 : -1;
      const perPage = Number(request.query.get("per_page") ?? 30);
      const page = Number(request.query.get("page") ?? 1);
      const all = issues
        // A transferred issue no longer belongs to this repository's listing.
        .filter((issue) => issue.repositoryId === repository.id && !issue.deleted && !issue.movedTo && (!creator || issue.user.login === creator) &&
          (!since || Date.parse(issue.updated_at) >= Date.parse(since)))
        .sort((a, b) => direction * (a[field].localeCompare(b[field]) || a.number - b.number));
      const slice = all.slice((page - 1) * perPage, page * perPage);
      const headers: Record<string, string> = {};
      if (page * perPage < all.length) {
        headers.link = `<https://api.github.com/repositories/${repository.id}/issues?page=${page + 1}>; rel="next"`;
      }
      return json(slice.map(issueJson), 200, headers);
    }
    const metadata = rest.match(/^\/issues\/(\d+)\/(labels|assignees)$/);
    if (metadata && request.method === "POST") {
      if (repository.archived) return message(403, "Repository was archived so is read-only.");
      const issue = issues.find((candidate) => candidate.repositoryId === repository.id && candidate.number === Number(metadata[1]));
      if (!issue || issue.deleted) return message(404, "Not Found");
      const body = request.body as { labels?: string[]; assignees?: string[] };
      if (metadata[2] === "labels") {
        for (const name of body.labels ?? []) if (!issue.labels.some((label) => label.name === name)) issue.labels.push({ name });
        return json(issue.labels);
      }
      if ((body.assignees ?? []).some((login) => !repository.collaborators.includes(login))) return message(422, "Validation Failed");
      for (const login of body.assignees ?? []) if (!issue.assignees.some((assignee) => assignee.login === login)) issue.assignees.push({ login });
      return json(issueJson(issue));
    }
    const one = rest.match(/^\/issues\/(\d+)$/);
    if (one && request.method === "PATCH") {
      if (repository.archived) return message(403, "Repository was archived so is read-only.");
      const issue = issues.find((candidate) => candidate.repositoryId === repository.id && candidate.number === Number(one[1]));
      if (!issue) return message(404, "Not Found");
      if (issue.movedTo) return new Response(null, { status: 301, headers: { location: issue.movedTo } });
      if (issue.deleted) return message(410, "This issue was deleted");
      const body = request.body as { title?: string; body?: string; state?: string };
      if (body.title === "") return json({ message: "Validation Failed", errors: [{ resource: "Issue", code: "missing_field", field: "title" }] }, 422);
      if (body.state !== undefined && body.state !== "open" && body.state !== "closed") {
        return json({ message: "Validation Failed", errors: [{ resource: "Issue", code: "invalid", field: "state" }] }, 422);
      }
      Object.assign(issue, body.title === undefined ? {} : { title: body.title }, body.body === undefined ? {} : { body: body.body },
        body.state === undefined ? {} : { state: body.state }, { updated_at: iso(now) });
      return json(issueJson(issue));
    }
    if (one && request.method === "GET") {
      const issue = issues.find((candidate) => candidate.repositoryId === repository.id && candidate.number === Number(one[1]));
      if (!issue) return message(404, "Not Found");
      if (issue.movedTo) return new Response(null, { status: 301, headers: { location: issue.movedTo } });
      if (issue.deleted) return message(410, "This issue was deleted");
      const etag = `"${issue.state}-${issue.title.length}-${issue.labels.length}"`;
      if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers: { etag } });
      return json(issueJson(issue), 200, { etag });
    }
    return message(404, "Not Found");
  };

  const layer = Layer.succeed(HttpClient.HttpClient, HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const body = request.body._tag === "Uint8Array"
        ? JSON.parse(new TextDecoder().decode(request.body.body))
        : undefined;
      const recorded: Recorded = {
        method: request.method,
        path: url.pathname,
        query: url.searchParams,
        headers: new Headers(request.headers as Record<string, string>),
        body,
      };
      requests.push(recorded);
      if (url.origin !== "https://api.github.com") {
        return yield* Effect.die(new Error(`Unexpected origin ${url.origin}`));
      }
      const script = scripts.shift();
      const scripted = yield* Effect.promise(() => Promise.resolve(script?.(recorded)));
      if (scripted === "hang") return yield* Effect.never;
      if (scripted === "reset") {
        return yield* Effect.fail(new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "connection reset" }),
        }));
      }
      const response = yield* Effect.promise(() => Promise.resolve(scripted ?? handle(recorded, now)));
      return HttpClientResponse.fromWeb(request, response);
    })));

  return {
    layer,
    privateKeyPem,
    onCreate: (script: (issue: FakeIssue) => Response | undefined | Promise<Response | undefined>) => { afterCreate = script; },
    requests,
    minted,
    issues,
    /** Queue one response for the next request; `undefined` passes it through. */
    next: (script: Script) => { scripts.push(script); },
    installation: (id: number, options: { suspended?: boolean } = {}) => {
      installations.set(id, { suspended: options.suspended ?? false });
    },
    repository: (repository: Partial<FakeRepository> & Pick<FakeRepository, "id" | "installationId">) => {
      const value: FakeRepository = {
        owner: "Quick-Release", name: `repo-${repository.id}`, private: true, archived: false,
        hasIssues: true, collaborators: ["developer"], ...repository,
      };
      repositories.set(value.id, value);
      return value;
    },
    /** A Developer's change in GitHub: advances `updated_at` to second resolution, as GitHub does. */
    edit: (issue: FakeIssue, change: Partial<Pick<FakeIssue, "state" | "title" | "body">>, at = Date.now()) => {
      Object.assign(issue, change, { updated_at: iso(at) });
    },
    /** Leaves a field out of mint responses' repository objects, which GitHub does not document field by field. */
    mintOmits: (field: string) => { omitted.add(field); },
    update: (id: number, change: Partial<FakeRepository>) => { Object.assign(repositories.get(id)!, change); },
    suspend: (installationId: number) => { installations.get(installationId)!.suspended = true; },
    revoke: (token: string) => { tokens.delete(token); },
  };
};

export type FakeGitHub = ReturnType<typeof makeFakeGitHub>;

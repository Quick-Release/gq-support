import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";

/**
 * The only Worker module that holds the GitHub App key or handles its tokens
 * (docs/research/github-app-issue-integration.md). Callers name a numeric
 * installation and repository; they never see a JWT or installation token.
 */
export interface GitHubTarget {
  /** GitHub's numeric App installation ID, from the Repository mapping. */
  readonly installationId: number;
  /** GitHub's numeric repository ID, from the Repository mapping. */
  readonly repositoryId: number;
}

export interface RepositoryState {
  readonly id: number;
  readonly fullName: string;
  readonly private: boolean;
  readonly archived: boolean;
}

export interface GitHubAppConfig {
  readonly clientId: string;
  readonly slug: string;
  /** PKCS#8 PEM; GitHub's PKCS#1 download is converted once at custody. */
  readonly privateKeyPem: string;
}

/** The App key is missing or invalid, or GitHub rejected the App JWT. */
export class AppAuthenticationFailed extends Data.TaggedError("AppAuthenticationFailed")<{}> {}
/** The installation is gone or suspended. */
export class InstallationUnavailable extends Data.TaggedError("InstallationUnavailable")<{}> {}
/** The repository left the installation, was deleted, or disabled Issues. */
export class RepositoryUnavailable extends Data.TaggedError("RepositoryUnavailable")<{
  readonly reason: "not-accessible" | "issues-disabled";
}> {}
/** Granted permissions differ from Issues write + Metadata read. */
export class PermissionMissing extends Data.TaggedError("PermissionMissing")<{
  /** GitHub's `X-Accepted-GitHub-Permissions`, when present. */
  readonly accepted: string | null;
}> {}
/** A primary or secondary rate limit; nothing was done. */
export class RateLimited extends Data.TaggedError("RateLimited")<{
  readonly kind: "primary" | "secondary";
  /** Epoch milliseconds before which the caller must not try again. */
  readonly until: number;
}> {}
/** GitHub did not answer usefully; nothing was changed, so a read may be retried. */
export class ProviderUnavailable extends Data.TaggedError("ProviderUnavailable")<{
  readonly status: number | null;
}> {}

/** The repository is not private; nothing was sent. */
export class RepositoryNotPrivate extends Data.TaggedError("RepositoryNotPrivate")<{}> {}
/** The repository is archived and read-only; nothing was created. */
export class RepositoryArchived extends Data.TaggedError("RepositoryArchived")<{}> {}
/** GitHub refused the issue as sent (400 or 422); nothing was created. */
export class ValidationRejected extends Data.TaggedError("ValidationRejected")<{
  readonly status: number;
  /** Rejected field names only, never their values. */
  readonly fields: readonly string[];
}> {}
/** The POST may or may not have created an issue: reconcile, never resend. */
export class OutcomeUnknown extends Data.TaggedError("OutcomeUnknown")<{}> {}
/** The issue was transferred; `location` is GitHub's API URL for it. */
export class IssueMoved extends Data.TaggedError("IssueMoved")<{ readonly location: string }> {}
/** The issue was deleted. */
export class IssueGone extends Data.TaggedError("IssueGone")<{}> {}

export type GatewayError =
  | AppAuthenticationFailed
  | InstallationUnavailable
  | RepositoryUnavailable
  | PermissionMissing
  | RateLimited
  | ProviderUnavailable;

export type CreateIssueError =
  | Exclude<GatewayError, ProviderUnavailable>
  /** Only for statuses that prove nothing was created, such as 401. */
  | ProviderUnavailable
  | RepositoryNotPrivate
  | RepositoryArchived
  | ValidationRejected
  | OutcomeUnknown;

export type ReadIssueError = GatewayError | IssueMoved | IssueGone;

export interface NewIssue {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
}

export interface GitHubIssue {
  readonly id: number;
  readonly nodeId: string;
  readonly number: number;
  readonly title: string;
  readonly body: string | null;
  readonly state: "open" | "closed";
  readonly createdAt: string;
  readonly creator: string;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
}

export type IssueRead =
  | { readonly _tag: "Fresh"; readonly issue: GitHubIssue; readonly etag: string | null }
  | { readonly _tag: "NotModified" };

const API = "https://api.github.com";
/** Pinned; without it GitHub defaults to 2022-11-28. */
const API_VERSION = "2026-03-10";
const PERMISSIONS = { issues: "write", metadata: "read" } as const;
/** GitHub's ceiling is ten minutes; `iat` is backdated for clock skew. */
const JWT_LIFETIME_SECONDS = 540;
const JWT_BACKDATE_SECONDS = 60;
/** Tokens last an hour; refresh this long before `expires_at`. */
const REFRESH_MARGIN_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const PER_PAGE = 100;
const FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

interface InstallationToken {
  readonly token: Redacted.Redacted<string>;
  /** `owner/name` at mint time: an address, never identity. */
  readonly fullName: string;
  /** Clock time of the mint, and when the token stops being reused. */
  readonly mintedAt: number;
  readonly refreshAt: number;
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const encodeJson = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

const importKey = async (pem: string) => {
  if (!/^-----BEGIN PRIVATE KEY-----\r?\n[\s\S]+\r?\n-----END PRIVATE KEY-----\s*$/.test(pem)) throw new Error();
  const der = Uint8Array.from(atob(pem.replace(/-----[^\n]+-----|\s/g, "")), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
};

/** RS256 App JWT: `iat` 60 s in the past, `exp` nine minutes ahead. */
const signJwt = async (key: CryptoKey, clientId: string, nowMs: number) => {
  const now = Math.floor(nowMs / 1000);
  const input = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson({
    iat: now - JWT_BACKDATE_SECONDS, exp: now + JWT_LIFETIME_SECONDS, iss: clientId,
  })}`;
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(input));
  return `${input}.${base64url(new Uint8Array(signature))}`;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const repositoryFrom = (value: unknown): RepositoryState | undefined => {
  if (!isRecord(value) || !Number.isSafeInteger(value.id) || typeof value.full_name !== "string" ||
      !FULL_NAME.test(value.full_name) ||
      typeof value.private !== "boolean" || typeof value.archived !== "boolean") return undefined;
  return { id: value.id as number, fullName: value.full_name, private: value.private, archived: value.archived };
};

const logins = (value: unknown, field: "name" | "login") =>
  Array.isArray(value) && value.every((item) => isRecord(item) && typeof item[field] === "string")
    ? value.map((item) => (item as Record<string, string>)[field]!)
    : undefined;

const issueFrom = (value: unknown): GitHubIssue | undefined => {
  if (!isRecord(value) || !Number.isSafeInteger(value.id) || !Number.isSafeInteger(value.number) ||
      typeof value.node_id !== "string" || typeof value.title !== "string" ||
      (value.body !== null && typeof value.body !== "string") ||
      (value.state !== "open" && value.state !== "closed") || typeof value.created_at !== "string" ||
      !isRecord(value.user) || typeof value.user.login !== "string") return undefined;
  const labels = logins(value.labels, "name");
  const assignees = logins(value.assignees, "login");
  if (!labels || !assignees) return undefined;
  return {
    id: value.id as number, nodeId: value.node_id, number: value.number as number, title: value.title,
    body: value.body as string | null, state: value.state, createdAt: value.created_at,
    creator: value.user.login, labels, assignees,
  };
};

export class GitHubGateway extends Context.Service<GitHubGateway, {
  /** The repository's current name, privacy and archived state, read live. */
  readonly repository: (target: GitHubTarget) => Effect.Effect<RepositoryState, GatewayError>;
  /**
   * Sends exactly one POST, only after a live check that the repository is
   * private and not archived. Never retried here: an OutcomeUnknown must be
   * reconciled before any further attempt.
   */
  readonly createIssue: (target: GitHubTarget, issue: NewIssue) => Effect.Effect<GitHubIssue, CreateIssueError>;
  /** One page of issues the App created, newest first, pull requests excluded. */
  readonly listAppIssues: (target: GitHubTarget, page: number) =>
    Effect.Effect<{ readonly issues: readonly GitHubIssue[]; readonly hasNextPage: boolean }, GatewayError>;
  /** One issue, conditionally on a stored ETag. Moves are reported, not followed. */
  readonly readIssue: (target: GitHubTarget, number: number, etag?: string) => Effect.Effect<IssueRead, ReadIssueError>;
}>()("GitHubGateway") {
  /** The gateway over Workers fetch. Redirects are never followed. */
  static readonly live = (config: GitHubAppConfig) => GitHubGateway.layer(config).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { redirect: "manual" })),
  );

  static readonly layer = (config: GitHubAppConfig) => Layer.effect(GitHubGateway, Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const bot = `${config.slug}[bot]`;
    const key = yield* Effect.cached(Effect.tryPromise({
      try: () => importKey(config.privateKeyPem),
      catch: () => new AppAuthenticationFailed(),
    }));

    /** Sends one request and reads a bounded body. Never retries. */
    const send = (request: HttpClientRequest.HttpClientRequest, authorization: Redacted.Redacted<string>) =>
      client.execute(request.pipe(
        HttpClientRequest.setHeaders({
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": API_VERSION,
          "User-Agent": config.slug,
        }),
        HttpClientRequest.bearerToken(Redacted.value(authorization)),
      )).pipe(
        Effect.flatMap((response) => readBody(response).pipe(Effect.map((body) => ({ response, body })))),
        Effect.timeoutOption(REQUEST_TIMEOUT_MS),
        Effect.flatMap(Option.match({ onNone: () => Effect.fail(null), onSome: Effect.succeed })),
        // Transport errors carry the request, headers included: drop them.
        Effect.mapError(() => null),
      );

    const mint = (cacheKey: string) => Effect.gen(function* () {
      const [installationId, repositoryId] = cacheKey.split("/").map(Number) as [number, number];
      const now = yield* Clock.currentTimeMillis;
      const jwt = yield* key.pipe(Effect.flatMap((cryptoKey) => Effect.tryPromise({
        try: () => signJwt(cryptoKey, config.clientId, now),
        catch: () => new AppAuthenticationFailed(),
      })));
      // A token scoped to one repository cannot reach another, even if routing is wrong.
      const { response, body } = yield* send(
        HttpClientRequest.post(`${API}/app/installations/${installationId}/access_tokens`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ repository_ids: [repositoryId], permissions: PERMISSIONS }),
        ),
        Redacted.make(jwt),
      ).pipe(Effect.mapError(() => new ProviderUnavailable({ status: null })));
      if (response.status !== 201) {
        return yield* Effect.fail(
          rateLimit(response.status, response.headers, body, now) ??
          (response.status === 401 ? new AppAuthenticationFailed()
          : response.status === 403 || response.status === 404 ? new InstallationUnavailable()
          // The repository does not exist or is not in this installation.
          : response.status === 422 ? new RepositoryUnavailable({ reason: "not-accessible" })
          : new ProviderUnavailable({ status: response.status })),
        );
      }
      const minted = isRecord(body) ? body : {};
      const repositories = Array.isArray(minted.repositories) ? minted.repositories : [];
      const repository = repositories.length === 1 && isRecord(repositories[0]) ? repositories[0] : {};
      const expiresAt = typeof minted.expires_at === "string" ? Date.parse(minted.expires_at) : Number.NaN;
      if (typeof minted.token !== "string" || repository.id !== repositoryId ||
          typeof repository.full_name !== "string" || !FULL_NAME.test(repository.full_name) ||
          !Number.isFinite(expiresAt)) {
        return yield* Effect.fail(new ProviderUnavailable({ status: response.status }));
      }
      // Fail closed unless GitHub granted exactly what was requested.
      if (!isRecord(minted.permissions) ||
          JSON.stringify(Object.entries(minted.permissions).sort()) !== JSON.stringify(Object.entries(PERMISSIONS).sort())) {
        return yield* Effect.fail(new PermissionMissing({ accepted: null }));
      }
      return {
        token: Redacted.make(minted.token),
        fullName: repository.full_name,
        mintedAt: now,
        refreshAt: expiresAt - REFRESH_MARGIN_MS,
      } satisfies InstallationToken;
    });

    // Isolate memory only: tokens are never persisted.
    const tokens = yield* Cache.makeWith(mint, {
      capacity: 1024,
      // Only successful mints are reused, and only until shortly before expiry.
      timeToLive: (exit) => Exit.isSuccess(exit) ? Math.max(0, exit.value.refreshAt - exit.value.mintedAt) : 0,
    });
    const keyOf = (target: GitHubTarget) => `${target.installationId}/${target.repositoryId}`;

    /** One installation-token request against the target's own repository. */
    const call = (
      target: GitHubTarget,
      build: (repository: string) => HttpClientRequest.HttpClientRequest,
    ) => Effect.gen(function* () {
      const token = yield* Cache.get(tokens, keyOf(target));
      const result = yield* send(build(`${API}/repos/${token.fullName}`), token.token);
      const status = result.response.status;
      // A rejected token, or a repository renamed or gone since the mint:
      // the next call re-mints, which also refreshes the cached name.
      if (status === 401 || status === 404 || status === 301) yield* Cache.invalidate(tokens, keyOf(target));
      return { status, headers: result.response.headers, body: result.body, now: yield* Clock.currentTimeMillis };
    });
    const read = (target: GitHubTarget, build: (repository: string) => HttpClientRequest.HttpClientRequest) =>
      call(target, build).pipe(Effect.catchIf(
        (error): error is null => error === null,
        () => Effect.fail(new ProviderUnavailable({ status: null })),
      ));

    const repository = (target: GitHubTarget) => read(target, HttpClientRequest.get).pipe(
      Effect.flatMap(({ status, headers, body, now }) => {
        if (status !== 200) return Effect.fail(failure(status, headers, body, now));
        const state = repositoryFrom(body);
        return state && state.id === target.repositoryId
          ? Effect.succeed(state)
          : Effect.fail(new ProviderUnavailable({ status }));
      }),
    );

    const createIssue = (target: GitHubTarget, issue: NewIssue) => Effect.gen(function* () {
      const state = yield* repository(target);
      if (!state.private) return yield* Effect.fail(new RepositoryNotPrivate());
      if (state.archived) return yield* Effect.fail(new RepositoryArchived());
      const result = yield* call(target, (repository) => HttpClientRequest.post(`${repository}/issues`).pipe(
        HttpClientRequest.bodyJsonUnsafe(issue),
      )).pipe(Effect.catchIf(
        (error): error is null => error === null,
        // Sent, but no complete answer: GitHub may have created the issue.
        () => Effect.fail(new OutcomeUnknown()),
      ));
      const { status, headers, body, now } = result;
      if (status === 201) {
        const created = issueFrom(body);
        return created ? created : yield* Effect.fail(new OutcomeUnknown());
      }
      const limited = rateLimit(status, headers, body, now);
      if (limited) return yield* Effect.fail(limited);
      const message = isRecord(body) && typeof body.message === "string" ? body.message : "";
      if (status === 400 || status === 422) {
        const errors = isRecord(body) && Array.isArray(body.errors) ? body.errors : [];
        const fields = errors.flatMap((error) =>
          isRecord(error) && typeof error.field === "string" && /^[a-z_]{1,32}$/.test(error.field) ? [error.field] : []);
        return yield* Effect.fail(new ValidationRejected({ status, fields: [...new Set(fields)] }));
      }
      if (status === 410) return yield* Effect.fail(new RepositoryUnavailable({ reason: "issues-disabled" }));
      if (status === 403 && /archived/i.test(message)) return yield* Effect.fail(new RepositoryArchived());
      // These statuses prove the issue was not created; anything else might have.
      if (status === 401 || status === 403 || status === 404) return yield* Effect.fail(failure(status, headers, body, now));
      return yield* Effect.fail(new OutcomeUnknown());
    });

    const listAppIssues = (target: GitHubTarget, page: number) => read(target, (repository) =>
      HttpClientRequest.get(`${repository}/issues`).pipe(HttpClientRequest.setUrlParams({
        creator: bot, state: "all", sort: "created", direction: "desc",
        per_page: String(PER_PAGE), page: String(page),
      })),
    ).pipe(Effect.flatMap(({ status, headers, body, now }) => {
      if (status !== 200) return Effect.fail(failure(status, headers, body, now));
      const items = Array.isArray(body) ? body : undefined;
      // Pull requests share the issues endpoint.
      const issues = items?.filter((item) => !(isRecord(item) && "pull_request" in item)).map(issueFrom);
      if (!issues || issues.some((issue) => issue === undefined)) return Effect.fail(new ProviderUnavailable({ status }));
      return Effect.succeed({
        issues: issues as GitHubIssue[],
        hasNextPage: /<[^>]+>;\s*rel="next"/.test(headers.link ?? ""),
      });
    }));

    const readIssue = (target: GitHubTarget, number: number, etag?: string) => read(target, (repository) => {
      const request = HttpClientRequest.get(`${repository}/issues/${number}`);
      return etag === undefined ? request : request.pipe(HttpClientRequest.setHeader("If-None-Match", etag));
    }).pipe(Effect.flatMap(({ status, headers, body, now }): Effect.Effect<IssueRead, ReadIssueError> => {
      if (status === 304) return Effect.succeed({ _tag: "NotModified" });
      if (status === 301) {
        const location = headers.location ?? "";
        return location.startsWith(`${API}/`)
          ? Effect.fail(new IssueMoved({ location }))
          : Effect.fail(new ProviderUnavailable({ status }));
      }
      if (status === 410) return Effect.fail(new IssueGone());
      if (status !== 200) return Effect.fail(failure(status, headers, body, now));
      const issue = issueFrom(body);
      return issue && issue.number === number
        ? Effect.succeed({ _tag: "Fresh", issue, etag: headers.etag ?? null })
        : Effect.fail(new ProviderUnavailable({ status }));
    }));

    /** Logs the failure's tag and safe fields only: no URL, header, body or credential. */
    const logged = <Args extends unknown[], A, E extends { readonly _tag: string }>(
      operation: string,
      f: (...args: Args) => Effect.Effect<A, E>,
    ) => (...args: Args) => f(...args).pipe(Effect.tapError((error) => {
      const fields = error as { status?: unknown; kind?: unknown; until?: unknown; accepted?: unknown; reason?: unknown };
      return Effect.logWarning("GitHub request failed").pipe(Effect.annotateLogs({
        operation,
        error: error._tag,
        ...(typeof fields.status === "number" ? { status: fields.status } : {}),
        ...(typeof fields.kind === "string" ? { kind: fields.kind, until: fields.until } : {}),
        ...(typeof fields.accepted === "string" ? { accepted: fields.accepted } : {}),
        ...(typeof fields.reason === "string" ? { reason: fields.reason } : {}),
      }));
    }));

    return {
      repository: logged("repository", repository),
      createIssue: logged("createIssue", createIssue),
      listAppIssues: logged("listAppIssues", listAppIssues),
      readIssue: logged("readIssue", readIssue),
    };
  }));
}

const readBody = (response: HttpClientResponse.HttpClientResponse) =>
  Effect.gen(function* () {
    const length = Number(response.headers["content-length"] ?? 0);
    if (length > MAX_RESPONSE_BYTES) return yield* Effect.fail(null);
    const text = yield* response.text;
    if (text.length > MAX_RESPONSE_BYTES) return yield* Effect.fail(null);
    if (text === "") return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  });

type Headers = Readonly<Record<string, string | undefined>>;

/**
 * GitHub's rate-limit signals: 429, or 403 with rate-limit headers or a
 * rate-limit message. Honour `retry-after`, then `x-ratelimit-reset` when
 * nothing remains, else wait at least a minute.
 */
const rateLimit = (status: number, headers: Headers, body: unknown, now: number): RateLimited | undefined => {
  const retryAfter = Number(headers["retry-after"]);
  const exhausted = headers["x-ratelimit-remaining"] === "0";
  const message = isRecord(body) && typeof body.message === "string" ? body.message : "";
  if (status !== 429 && !(status === 403 && (headers["retry-after"] !== undefined || exhausted || /rate limit/i.test(message)))) {
    return undefined;
  }
  const reset = Number(headers["x-ratelimit-reset"]) * 1000;
  const until = Number.isFinite(retryAfter) && retryAfter >= 0 ? now + retryAfter * 1000
    : exhausted && Number.isFinite(reset) && reset > now ? reset
    : now + 60_000;
  return new RateLimited({ kind: exhausted ? "primary" : "secondary", until });
};

/** Maps the statuses every installation-token call shares to typed failures. */
const failure = (status: number, headers: Headers, body: unknown, now: number): GatewayError => {
  const limited = rateLimit(status, headers, body, now);
  if (limited) return limited;
  if (status === 403) {
    const accepted = headers["x-accepted-github-permissions"];
    return new PermissionMissing({ accepted: accepted && /^[a-z_]+=[a-z]+([,;] ?[a-z_]+=[a-z]+)*$/.test(accepted) ? accepted : null });
  }
  if (status === 404) return new RepositoryUnavailable({ reason: "not-accessible" });
  return new ProviderUnavailable({ status });
};

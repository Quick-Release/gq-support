import { CHECKER_SIGNATURE } from "./signature.ts";
import { CODES, COMPONENTS, EPISODE_RETENTION_MS, PROBE_PATH, REPORT_PATH, type Code, type Component,
  type ComponentState } from "./independent-check.ts";
import { discordDestinations, type DiscordWebhook } from "./notifications.ts";
import { readBody } from "./request-body.ts";

/**
 * The independent checker (#139; docs/runbooks/support-operations.md#independent-outage-checks),
 * run every few minutes by the `Independent service check` GitHub Actions workflow
 * through scripts/independent-check.ts. It runs outside Cloudflare, so a dead
 * Worker, main D1, suppression ledger or dashboard cannot hide its own outage,
 * and observes each component separately:
 *
 * - the Worker, its D1 databases, restore gate and configuration through the
 *   signed probe (src/independent-check.ts);
 * - GitHub's API, Discord's incident webhook (read without posting) and an
 *   approved dashboard endpoint, each directly;
 * - installations never: WordPress is not probed from here or on page render.
 *
 * A failing observation opens an outage episode, kept in the workflow's state
 * artifact until the service has reconciled it into a durable incident. While
 * the service cannot (Worker, D1 or restore gate down) or cannot announce it
 * (its configuration missing), the checker posts its own minimal notice to the
 * incident channel and edits it on recovery. Missing traffic is never an
 * outage, an unknown observation is neither failure nor recovery, nothing
 * pretends a write reached dead storage, and nothing is sent to a Discord the
 * checker cannot reach. A lost Discord response leaves the notice uncertain:
 * a retry may post it twice, but no retry ever opens a second incident.
 */
export type Observed = Component | "installation";
export interface Observation { readonly component: Observed; readonly state: ComponentState; readonly code: Code }

interface Notice {
  /** `sent` once Discord returned the message; `outcome_unknown` while a post may or may not have arrived. */
  state: "none" | "sent" | "outcome_unknown";
  message_id: string | null;
  attempts: number;
  recovered_sent: boolean;
}
interface Episode {
  id: string; component: Component; code: Code;
  first_failed_at: number; last_failed_at: number; recovered_at: number | null;
  /** The service incident it was reconciled into, once the service has recorded it. */
  incident_id: string | null; reconciled_at: number | null;
  notice: Notice;
}
export interface CheckerState {
  readonly version: 1;
  readonly stage: string;
  readonly episodes: Episode[];
  /** Discord's rate-limit cooldown for the incident webhook, which the Worker shares. */
  readonly discord_retry_at: number | null;
}
export interface CheckSummary {
  readonly stage: string | null;
  readonly observed_at: string;
  readonly components: readonly Observation[];
  readonly reconciliation: "accepted" | "not_possible" | "failed";
  readonly episodes: readonly { id: string; component: Component; code: Code; first_failed_at: string; last_failed_at: string;
    recovered_at: string | null; incident_id: string | null; notice: Notice["state"] }[];
  /** Episodes dropped unreconciled after the retention contract: follow up from this run's evidence. */
  readonly expired: readonly string[];
  /** Missing or malformed checker configuration and state; never treated as healthy. */
  readonly problems: readonly string[];
}
export interface CheckRun { readonly state: CheckerState; readonly summary: CheckSummary; readonly exitCode: 0 | 1 }

/**
 * Dashboard origins approved for probing, by reviewed PR. None yet: Banquinha's
 * endpoint is not established, so a configured URL is refused, not assumed.
 */
export const APPROVED_DASHBOARD_ORIGINS: readonly string[] = [];
/** Workers on the Tipme account's workers.dev subdomain; custom service domains are not approved yet. */
const SERVICE_HOST = /^[a-z0-9-]{1,63}\.tipme\.workers\.dev$/;
const GITHUB_PROBE = "https://api.github.com/rate_limit";
const REQUEST_TIMEOUT_MS = 10_000;
const RESPONSE_BYTES = 16_384;
const NOTICE_ATTEMPTS = 3;
const MAX_EPISODES = 20;
const STAGES = ["staging", "prod"];
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DOCS = "https://github.com/Quick-Release/gq-support/blob/main/docs/runbooks/support-operations.md#independent-outage-checks";
const USER_AGENT = "DiscordBot (https://github.com/Quick-Release/gq-support, 1)";

const encoder = new TextEncoder();
const base64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const iso = (time: number | null) => time === null ? null : new Date(time).toISOString();

interface Config {
  stage: string | null; service: string | null; keyId: string | null; key: CryptoKey | null;
  webhook: DiscordWebhook | null; githubToken: string | null; dashboard: string | null; run: string;
}
/** Reads the checker's configuration; a missing or malformed value is a problem and is never used. */
const configure = async (env: Readonly<Record<string, string | undefined>>, approved: readonly string[], problems: string[]): Promise<Config> => {
  const stage = env.INDEPENDENT_CHECK_STAGE && STAGES.includes(env.INDEPENDENT_CHECK_STAGE) ? env.INDEPENDENT_CHECK_STAGE : null;
  if (!stage) problems.push("stage_missing");
  let service: string | null = null;
  try {
    const url = new URL(env.INDEPENDENT_CHECK_SERVICE_URL ?? "");
    if (url.protocol === "https:" && SERVICE_HOST.test(url.hostname) && !url.port && !url.username && !url.password &&
      url.pathname === "/" && !url.search && !url.hash) service = url.origin;
  } catch { /* reported below */ }
  if (!service) problems.push("service_url_missing_or_not_approved");
  const keyId = env.INDEPENDENT_CHECK_KEY_ID && ID.test(env.INDEPENDENT_CHECK_KEY_ID) ? env.INDEPENDENT_CHECK_KEY_ID : null;
  let key: CryptoKey | null = null;
  try {
    const bytes = Uint8Array.from(atob(env.INDEPENDENT_CHECK_PRIVATE_KEY ?? ""), (char) => char.charCodeAt(0));
    key = bytes.length ? await crypto.subtle.importKey("pkcs8", bytes, "Ed25519", false, ["sign"]) : null;
  } catch { /* reported below */ }
  if (!keyId || !key) problems.push("checker_key_missing");
  const webhook = discordDestinations("", env.DISCORD_OPERATIONAL_INCIDENTS_WEBHOOK_URL ?? "").operational_incidents ?? null;
  if (!webhook) problems.push("discord_webhook_missing");
  const githubToken = env.GITHUB_TOKEN || null;
  if (!githubToken) problems.push("github_token_missing");
  let dashboard: string | null = null;
  if (env.INDEPENDENT_CHECK_DASHBOARD_URL) {
    try {
      const url = new URL(env.INDEPENDENT_CHECK_DASHBOARD_URL);
      if (url.protocol === "https:" && approved.includes(url.origin) && !url.username && !url.password &&
        !url.search) dashboard = url.href;
    } catch { /* reported below */ }
    if (!dashboard) problems.push("dashboard_url_not_approved");
  }
  const runId = `${env.GITHUB_RUN_ID ?? ""}-${env.GITHUB_RUN_ATTEMPT ?? ""}`;
  return { stage, service, keyId, key, webhook, githubToken, dashboard, run: ID.test(runId) && runId !== "-" ? `gh-${runId}` : "manual" };
};

/** The previous run's state, if it is exactly what this checker writes for this stage; anything else starts afresh. */
const restore = (value: unknown, stage: string | null, now: number): CheckerState | null => {
  const isTime = (time: unknown): time is number => typeof time === "number" && Number.isSafeInteger(time) && time >= 0 && time <= now + 300_000;
  if (!value || typeof value !== "object") return null;
  const state = value as Partial<CheckerState>;
  if (state.version !== 1 || state.stage !== stage || !Array.isArray(state.episodes) || state.episodes.length > MAX_EPISODES ||
    !(state.discord_retry_at === null || isTime(state.discord_retry_at))) return null;
  for (const episode of state.episodes as Partial<Episode>[]) {
    const notice = episode.notice as Partial<Notice> | undefined;
    if (typeof episode.id !== "string" || !UUID.test(episode.id) || !COMPONENTS.includes(episode.component as Component) ||
      !CODES.includes(episode.code as Code) || !isTime(episode.first_failed_at) || !isTime(episode.last_failed_at) ||
      !(episode.recovered_at === null || isTime(episode.recovered_at)) ||
      !(episode.incident_id === null || (typeof episode.incident_id === "string" && UUID.test(episode.incident_id))) ||
      !(episode.reconciled_at === null || isTime(episode.reconciled_at)) || !notice ||
      !["none", "sent", "outcome_unknown"].includes(notice.state as string) ||
      !(notice.message_id === null || (typeof notice.message_id === "string" && /^[0-9]{1,20}$/.test(notice.message_id))) ||
      !Number.isSafeInteger(notice.attempts) || typeof notice.recovered_sent !== "boolean") return null;
  }
  return JSON.parse(JSON.stringify(state)) as CheckerState;
};

/** One bounded request: its status and a bounded body, or the transport failure. */
const call = async (fetcher: typeof fetch, url: string, init: RequestInit = {}) => {
  try {
    const response = await fetcher(url, { redirect: "error", ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const text = await readBody(response, RESPONSE_BYTES).catch(() => null);
    return { status: response.status, headers: response.headers, text };
  } catch (error) {
    return { failure: (error instanceof DOMException && error.name === "TimeoutError" ? "timeout" : "transport_failed") as Code };
  }
};
const json = (text: string | null): unknown => { try { return text === null ? null : JSON.parse(text); } catch { return null; } };

const sign = async (config: Config, method: string, path: string, body: string): Promise<Record<string, string>> => {
  const digest = `sha-256=:${base64(await crypto.subtle.digest("SHA-256", encoder.encode(body)))}:`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const requestId = crypto.randomUUID();
  const canonical = [CHECKER_SIGNATURE.label, method, path, config.keyId!, config.run, timestamp, requestId, digest].join("\n");
  const signature = await crypto.subtle.sign("Ed25519", config.key!, encoder.encode(canonical));
  return { [CHECKER_SIGNATURE.keyId]: config.keyId!, [CHECKER_SIGNATURE.principal]: config.run,
    [CHECKER_SIGNATURE.timestamp]: timestamp, [CHECKER_SIGNATURE.requestId]: requestId,
    "Content-Digest": digest, [CHECKER_SIGNATURE.signature]: base64(signature) };
};

const observation = (component: Observed, state: ComponentState, code: Code): Observation => ({ component, state, code });
const unknownAll = (components: readonly Component[], code: Code) => components.map((component) => observation(component, "unknown", code));
const SERVICE_COMPONENTS: readonly Component[] = ["worker", "support_db", "suppression_ledger", "restore_gate", "service_configuration"];

/** The Worker, its databases, restore gate and configuration, through the signed probe. */
const probe = async (config: Config, fetcher: typeof fetch): Promise<Observation[]> => {
  if (!config.service || !config.key) return unknownAll(SERVICE_COMPONENTS, "not_configured");
  const response = await call(fetcher, `${config.service}${PROBE_PATH}`, { headers: await sign(config, "GET", PROBE_PATH, "") });
  const rest = SERVICE_COMPONENTS.slice(1);
  if ("failure" in response) return [observation("worker", "failing", response.failure!), ...unknownAll(rest, "not_observed")];
  // The Worker answered but refused this checker: its configuration, not an outage.
  if (response.status === 401 || response.status === 403) return [observation("worker", "unknown", "unauthorized"), ...unknownAll(rest, "not_observed")];
  if (response.status !== 200) return [observation("worker", "failing", "http_error"), ...unknownAll(rest, "not_observed")];
  const body = json(response.text) as { support_db?: unknown; suppression_ledger?: unknown; restore_gate?: unknown;
    configuration?: { github_app?: unknown; operational_incidents?: unknown } } | null;
  const storage = (value: unknown) => value === "ok" || value === "unavailable";
  if (!body || !storage(body.support_db) || !storage(body.suppression_ledger) ||
    !["open", "pending", "unknown"].includes(body.restore_gate as string) ||
    !["configured", "missing"].includes(body.configuration?.github_app as string) ||
    !["configured", "missing"].includes(body.configuration?.operational_incidents as string)) {
    return [observation("worker", "failing", "invalid_response"), ...unknownAll(rest, "not_observed")];
  }
  const database = (component: Component, value: unknown) => value === "ok" ? observation(component, "healthy", "ok")
    : observation(component, "failing", "unavailable");
  const missing = body.configuration!.github_app === "missing" || body.configuration!.operational_incidents === "missing";
  return [
    observation("worker", "healthy", "ok"),
    database("support_db", body.support_db), database("suppression_ledger", body.suppression_ledger),
    body.restore_gate === "open" ? observation("restore_gate", "healthy", "ok")
      : body.restore_gate === "pending" ? observation("restore_gate", "failing", "pending") : observation("restore_gate", "unknown", "not_observed"),
    missing ? observation("service_configuration", "failing", "missing") : observation("service_configuration", "healthy", "ok"),
  ];
};

/** GitHub's API as this runner reaches it: a provider observation, not the App's permissions. */
const github = async (config: Config, fetcher: typeof fetch): Promise<Observation> => {
  if (!config.githubToken) return observation("github", "unknown", "not_configured");
  const response = await call(fetcher, GITHUB_PROBE, { headers: { Authorization: `Bearer ${config.githubToken}`,
    Accept: "application/vnd.github+json", "User-Agent": "gq-support-independent-check" } });
  if ("failure" in response) return observation("github", "failing", response.failure!);
  if (response.status === 200) return observation("github", "healthy", "ok");
  if (response.status === 403 || response.status === 429) return observation("github", "unknown", "rate_limited");
  if (response.status === 401) return observation("github", "unknown", "unauthorized");
  return observation("github", "failing", "http_error");
};

/** Discord's incident webhook, read without posting; a rate limit defers it as Discord asks. */
const discord = async (config: Config, fetcher: typeof fetch, retryAt: number | null, now: number):
  Promise<{ observation: Observation; retryAt: number | null }> => {
  if (!config.webhook) return { observation: observation("discord", "unknown", "not_configured"), retryAt };
  if (retryAt !== null && retryAt > now) return { observation: observation("discord", "unknown", "rate_limited"), retryAt };
  const response = await call(fetcher, `https://discord.com/api/v10/webhooks/${config.webhook.id}/${config.webhook.token}`,
    { headers: { "User-Agent": USER_AGENT } });
  if ("failure" in response) return { observation: observation("discord", "failing", response.failure!), retryAt: null };
  if (response.status === 200) return { observation: observation("discord", "healthy", "ok"), retryAt: null };
  if (response.status === 429) return { observation: observation("discord", "unknown", "rate_limited"), retryAt: now + retryAfter(response) };
  if ([401, 403, 404].includes(response.status)) return { observation: observation("discord", "failing", "destination_rejected"), retryAt: null };
  return { observation: observation("discord", "failing", "http_error"), retryAt: null };
};
const retryAfter = (response: { headers: Headers; text: string | null }) => {
  const body = json(response.text) as { retry_after?: unknown } | null;
  const seconds = typeof body?.retry_after === "number" ? body.retry_after : Number(response.headers.get("Retry-After") ?? "60");
  return Math.max(Math.ceil((Number.isFinite(seconds) ? seconds : 60) * 1000), 1_000);
};

/** An approved dashboard endpoint answering at all; a login redirect or refusal still answers. */
const dashboard = async (config: Config, fetcher: typeof fetch): Promise<Observation> => {
  if (!config.dashboard) return observation("dashboard", "unknown", "not_configured");
  const response = await call(fetcher, config.dashboard, { redirect: "manual" });
  if ("failure" in response) return observation("dashboard", "failing", response.failure!);
  return response.status >= 500 ? observation("dashboard", "failing", "http_error") : observation("dashboard", "healthy", "ok");
};

const noticeContent = (stage: string, episode: Episode, reconciled: boolean) => [
  `**Independent check** · \`${stage}\` · \`${episode.component}\` ${episode.recovered_at === null ? "failing" : "recovered"} (\`${episode.code}\`)`,
  `Since: ${iso(episode.first_failed_at)} · Last failing: ${iso(episode.last_failed_at)}` +
    (episode.recovered_at === null ? "" : ` · Recovered: ${iso(episode.recovered_at)}`),
  episode.recovered_at === null
    ? "The support service cannot record or announce this itself now; it is reconciled into an incident once it can."
    : reconciled ? "Reconciled into a service incident; claim and resolve it there." : "Not yet reconciled into a service incident.",
  `Runbook: <${DOCS}>`,
].join("\n");

type SendOutcome = { sent: string | null } | { error: Code; retryAt?: number; unknown?: boolean };
const sendNotice = async (fetcher: typeof fetch, webhook: DiscordWebhook, messageId: string | null, content: string, now: number): Promise<SendOutcome> => {
  const base = `https://discord.com/api/v10/webhooks/${webhook.id}/${webhook.token}`;
  const response = await call(fetcher, messageId ? `${base}/messages/${messageId}` : `${base}?wait=true`, {
    method: messageId ? "PATCH" : "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
  });
  // The request may or may not have reached Discord.
  if ("failure" in response) return { error: response.failure!, unknown: true };
  if (response.status >= 200 && response.status < 300) {
    const id = (json(response.text) as { id?: unknown } | null)?.id;
    if (messageId) return { sent: messageId };
    return typeof id === "string" && /^[0-9]{1,20}$/.test(id) ? { sent: id } : { error: "invalid_response", unknown: true };
  }
  if (response.status === 429) return { error: "rate_limited", retryAt: now + retryAfter(response) };
  if ([401, 403, 404].includes(response.status)) return { error: "destination_rejected" };
  return { error: "http_error" };
};

/** One checker execution: observe, track episodes, reconcile when the service can record, notify when it cannot. */
export const runIndependentCheck = async ({ env, state: previous, fetch: fetcher = fetch, now = Date.now(),
  dashboards = APPROVED_DASHBOARD_ORIGINS }: {
  env: Readonly<Record<string, string | undefined>>; state: unknown; fetch?: typeof fetch; now?: number;
  /** The reviewed dashboard origins; tests stand in an approved one. */
  dashboards?: readonly string[];
}): Promise<CheckRun> => {
  const problems: string[] = [];
  const config = await configure(env, dashboards, problems);
  const restored = previous === null ? null : restore(previous, config.stage, now);
  if (previous !== null && !restored) problems.push("previous_state_unusable");
  const episodes: Episode[] = restored?.episodes ?? [];
  const [service, provider, notification, panel] = await Promise.all([probe(config, fetcher), github(config, fetcher),
    discord(config, fetcher, restored?.discord_retry_at ?? null, now), dashboard(config, fetcher)]);
  let discordRetryAt = notification.retryAt;
  const observed = new Map<Component, Observation>([...service, provider, notification.observation, panel]
    .map((item) => [item.component as Component, item]));

  // A failure opens or extends its component's episode; a healthy observation ends it; unknown does neither.
  for (const [component, { state, code }] of observed) {
    const open = episodes.find((episode) => episode.component === component && episode.recovered_at === null);
    if (state === "failing") {
      if (open) Object.assign(open, { last_failed_at: now, code });
      else episodes.push({ id: crypto.randomUUID(), component, code, first_failed_at: now, last_failed_at: now, recovered_at: null,
        incident_id: null, reconciled_at: null, notice: { state: "none", message_id: null, attempts: 0, recovered_sent: false } });
    } else if (state === "healthy" && open) {
      open.recovered_at = now;
    }
  }

  // Reconcile only into storage the probe shows writable; never pretend a write reached it.
  let reconciliation: CheckSummary["reconciliation"] = "not_possible";
  const writable = (["worker", "support_db", "restore_gate"] as const).every((component) => observed.get(component)?.state === "healthy");
  if (writable) {
    // The service refuses evidence past the retention contract; such episodes expire below.
    const reported = episodes.filter((episode) => episode.last_failed_at >= now - EPISODE_RETENTION_MS).slice(-MAX_EPISODES);
    const body = JSON.stringify({ observed_at: iso(now), components: [...observed.values()],
      episodes: reported.map(({ id, component, code, first_failed_at, last_failed_at, recovered_at }) => ({ id, component, code,
        first_failed_at: iso(first_failed_at), last_failed_at: iso(last_failed_at), recovered_at: iso(recovered_at) })) });
    const response = await call(fetcher, `${config.service}${REPORT_PATH}`, { method: "POST", body,
      headers: { "Content-Type": "application/json", ...await sign(config, "POST", REPORT_PATH, body) } });
    const accepted = "status" in response && response.status === 200
      ? (json(response.text) as { episodes?: { id: string; incident_id: string | null }[] } | null)?.episodes : undefined;
    if (Array.isArray(accepted)) {
      reconciliation = "accepted";
      for (const item of accepted) {
        const episode = episodes.find(({ id }) => id === item.id);
        if (episode && typeof item.incident_id === "string" && UUID.test(item.incident_id)) {
          Object.assign(episode, { incident_id: item.incident_id, reconciled_at: now });
        }
      }
    } else {
      reconciliation = "failed";
    }
  }

  // The service announces what it has recorded, unless its own notifier is blocked by missing configuration.
  const serviceAnnounces = reconciliation === "accepted" && observed.get("service_configuration")?.state === "healthy";
  const cooling = () => discordRetryAt !== null && discordRetryAt > now;
  const canNotify = config.webhook !== null && config.stage !== null && observed.get("discord")?.state !== "failing";
  for (const episode of episodes) {
    // Never through a Discord observed failing; the service's incident carries a Discord outage.
    if (episode.component === "discord" || !canNotify || cooling()) continue;
    const { notice } = episode;
    if (episode.recovered_at === null && (!serviceAnnounces || episode.incident_id === null) && notice.state !== "sent" &&
      notice.attempts < NOTICE_ATTEMPTS) {
      notice.attempts++;
      const outcome = await sendNotice(fetcher, config.webhook!, null, noticeContent(config.stage!, episode, false), now);
      if ("sent" in outcome) Object.assign(notice, { state: "sent", message_id: outcome.sent });
      else if (outcome.unknown) notice.state = "outcome_unknown";
      else if (outcome.retryAt) discordRetryAt = outcome.retryAt;
    } else if (episode.recovered_at !== null && notice.state === "sent" && !notice.recovered_sent) {
      const outcome = await sendNotice(fetcher, config.webhook!, notice.message_id,
        noticeContent(config.stage!, episode, episode.incident_id !== null), now);
      if ("sent" in outcome) notice.recovered_sent = true;
      else if (outcome.retryAt) discordRetryAt = outcome.retryAt;
    }
  }
  // A failure nobody can see: no confirmed notice, and not held by a service that announces it (or, for
  // Discord itself, holds it). The failed run is then the remaining signal.
  const unsurfaced = episodes.filter((episode) => episode.recovered_at === null && episode.notice.state !== "sent" &&
    !(episode.incident_id !== null && reconciliation === "accepted" && (serviceAnnounces || episode.component === "discord"))).length;

  // Done once the service holds it and any notice is settled; unreconciled evidence expires with the artifact contract.
  // A reconciled one past it is the service's to end, from its next healthy observation.
  const old = episodes.filter((episode) => episode.last_failed_at < now - EPISODE_RETENTION_MS);
  const expired = old.filter((episode) => episode.incident_id === null);
  const kept = episodes.filter((episode) => !old.includes(episode) && !(episode.recovered_at !== null && episode.incident_id !== null &&
    (episode.notice.state !== "sent" || episode.notice.recovered_sent)));
  const summary: CheckSummary = {
    stage: config.stage, observed_at: iso(now)!,
    components: [...COMPONENTS.map((component) => observed.get(component)!), observation("installation", "unknown", "not_observed")],
    reconciliation,
    episodes: episodes.map((episode) => ({ id: episode.id, component: episode.component, code: episode.code,
      first_failed_at: iso(episode.first_failed_at)!, last_failed_at: iso(episode.last_failed_at)!, recovered_at: iso(episode.recovered_at),
      incident_id: episode.incident_id, notice: episode.notice.state })),
    expired: expired.map(({ id }) => id),
    problems,
  };
  return { state: { version: 1, stage: config.stage ?? "", episodes: kept.slice(-MAX_EPISODES), discord_retry_at: discordRetryAt },
    summary, exitCode: problems.length || unsurfaced ? 1 : 0 };
};

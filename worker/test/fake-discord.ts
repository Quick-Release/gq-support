/**
 * A fake Discord webhook transport (docs/support-operations-design.md): the
 * `fetch` the notification sweep calls, never the network. It keeps each
 * webhook's messages, answers execute (`POST ?wait=true`) and edit (`PATCH
 * …/messages/{id}`) like Discord's API, and lets a test script outages, rate
 * limits and lost responses.
 */
export const webhookUrl = (id: string, token = `token-${id}-${"x".repeat(60)}`) =>
  `https://discord.com/api/webhooks/${id}/${token}`;

export interface DiscordMessage {
  readonly id: string;
  content: string;
  readonly allowedMentions: unknown;
  edits: number;
}

/** What the next request to a webhook gets, instead of normal handling. */
export type Fault =
  | { readonly status: number; readonly body?: unknown; readonly headers?: Record<string, string> }
  /** Discord applies the request, but the response is lost. */
  | { readonly lostResponse: true }
  /** The request never reaches Discord. */
  | { readonly unreachable: true };

export const makeFakeDiscord = () => {
  const messages = new Map<string, DiscordMessage[]>();
  const faults = new Map<string, Fault[]>();
  const requests: { method: string; webhook: string; userAgent: string | null }[] = [];
  let sequence = 1000;
  const reply = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
    body === undefined ? new Response(null, { status, headers }) : Response.json(body, { status, headers });

  const fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const match = /^\/api\/v10\/webhooks\/(\d+)\/([A-Za-z0-9_-]+)(?:\/messages\/(\d+))?$/.exec(url.pathname);
    const method = init?.method ?? "GET";
    if (url.origin !== "https://discord.com" || !match) throw new Error(`Unexpected request ${method} ${url.origin}${url.pathname}`);
    const [, webhook, , messageId] = match;
    requests.push({ method, webhook: webhook!, userAgent: new Headers(init?.headers).get("User-Agent") });
    const fault = faults.get(webhook!)?.shift();
    if (fault && "unreachable" in fault) throw new TypeError("fetch failed");
    if (fault && "status" in fault) return reply(fault.status, fault.body, fault.headers);
    const body = JSON.parse(String(init?.body)) as { content: string; allowed_mentions: unknown };
    const list = messages.get(webhook!) ?? [];
    messages.set(webhook!, list);
    let message: DiscordMessage | undefined;
    if (method === "POST" && !messageId && url.search === "?wait=true") {
      message = { id: String(++sequence), content: body.content, allowedMentions: body.allowed_mentions, edits: 0 };
      list.push(message);
    } else if (method === "PATCH" && messageId) {
      message = list.find((candidate) => candidate.id === messageId);
      if (!message) return reply(404, { code: 10008, message: "Unknown Message" });
      message.content = body.content;
      message.edits++;
    } else {
      return reply(400, { code: 50035, message: "Invalid Form Body" });
    }
    if (fault && "lostResponse" in fault) throw new TypeError("network connection lost");
    return reply(200, { id: message.id, content: message.content }, { "X-RateLimit-Remaining": "4" });
  };

  return {
    fetch,
    requests,
    /** The messages posted through one webhook, in order. */
    messages: (webhook: string) => messages.get(webhook) ?? [],
    /** Queues faults for the next requests to one webhook. */
    fail: (webhook: string, ...next: Fault[]) => faults.set(webhook, [...(faults.get(webhook) ?? []), ...next]),
    /** Ends any queued faults for one webhook. */
    recover: (webhook: string) => faults.delete(webhook),
    /** Deletes a posted message, as a channel moderator might. */
    remove: (webhook: string, id: string) => messages.set(webhook, (messages.get(webhook) ?? []).filter((message) => message.id !== id)),
  };
};

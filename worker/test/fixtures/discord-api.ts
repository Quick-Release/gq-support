import { vi } from "vitest";
import { ACCOUNT } from "../../deploy/planning-state.ts";
export const privateDiscordURL = `https://discord.com/api/webhooks/123456789012345678/${"synthetic_private_destination_".repeat(3)}`;
export function discordApi(worker = "synthetic-worker") {
  const script = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/workers/scripts/${worker}`;
  const secrets = new Map<string, string>();
  let observability = { enabled: true, logs: { enabled: true, invocation_logs: true, head_sampling_rate: 1 }, traces: { enabled: false }, issues: { enabled: false } };
  const request = vi.fn<typeof fetch>(async (url, init) => {
    const method = init?.method ?? "GET", target = String(url);
    if (target === script + "/secrets" && method === "PUT") {
      const value = JSON.parse(String(init?.body));
      if (value.type !== "secret_text" || typeof value.text !== "string") throw new Error("bad secret request");
      secrets.set(value.name, value.text);
    } else if (target.startsWith(script + "/secrets/") && method === "DELETE") secrets.delete(target.slice((script + "/secrets/").length));
    else if (target === script + "/script-settings" && method === "PATCH") observability = JSON.parse(String(init?.body)).observability;
    else if (target === script + "/settings" && method === "GET") return Response.json({ success: true, result: { observability,
      bindings: [...secrets].map(([name]) => ({ name, type: "secret_text" })) } });
    else throw new Error("unexpected first-party route");
    return Response.json({ success: true });
  });
  return { request, secrets, get observability() { return observability; } };
}

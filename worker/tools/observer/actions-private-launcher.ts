// Separate precise adapter: never broadens the Worker-only delivery contract.
import * as fs from "node:fs";
import { exact } from "../../src/observer-snapshot.ts";
import { consumePrivateDelivery, type PrivateLaunch, type CustodyFS } from "./private-launcher.ts";
import { createActionsReadSession, type ActionsReviewIO } from "./actions-review-loader.ts";

export async function observeActionsPrivateFiles(input: PrivateLaunch, transport: ActionsReviewIO, io: CustodyFS = fs) {
  try {
    const policy = structuredClone(input.policy), commentId = input.commentId;
    const previous = input.previous === undefined ? undefined : structuredClone(input.previous);
    const network = { ...transport };
    const { manifest, credentials, pins } = consumePrivateDelivery(input, "observer_actions_reads", io);
    const c = exact(JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(credentials)),
      ["schema", "reviewAuthToken", "actionsReadToken"]);
    if (c.schema !== 1 || typeof c.reviewAuthToken !== "string" || typeof c.actionsReadToken !== "string" ||
      !/^[!-~]{1,4096}$/.test(c.reviewAuthToken) || !/^[!-~]{1,4096}$/.test(c.actionsReadToken) ||
      c.reviewAuthToken === c.actionsReadToken || credentials[0] === 0xef) throw new Error("observer_private_refused");
    return await createActionsReadSession(policy, pins, c.reviewAuthToken).observe(
      { manifest, commentId, previous, actionsReadToken: c.actionsReadToken }, network);
  } catch { return { public: { coverage: "unknown" as const, verdict: null }, reads: [] }; }
}

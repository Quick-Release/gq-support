// Private anonymous pipes only. No filesystem socket, credentials, progress,
// native object, callback/function or arbitrary method name crosses this pipe.
import { Socket } from "node:net";
import { requireEvidence, refusal } from "./planning-state.ts";
import { MAX_BODY, checkWire, wireJson } from "./planning-read.ts";
// The installed unminified Worker multipart bundle exceeds the state reader's
// 8 MiB cap. Only this one binary upload may use the separate 48 MiB frame cap.
export const MAX_FRAME = 48 * 1024 * 1024;
export function checkChannelFrame(value: unknown) {
  if (value && typeof value === "object" && "op" in value && value.op === "cloudflare" && "body" in value) {
    requireEvidence(typeof value.body === "string" && value.body.length <= 44 * 1024 * 1024);
    checkWire({ ...value, body: "" });
  } else checkWire(value);
}
export type BrokerOperation =
  | { op: "authorize" }
  | { op: "cloudflare"; url: string; method: string; contentType: string; body: string }
  | { op: "state-set"; fqn: string; value: unknown }
  | { op: "state-output"; value: unknown }
  | { op: "app-key"; worker: string }
  | { op: "app-webhook"; worker: string; appId: number }
  | { op: "app-check"; worker: string; metadata: unknown };
export function privateChannel() {
  const stream = process.stdin;
  const output = new Socket({ fd: 3, readable: false, writable: true });
  output.on("error", () => { stream.destroy(refusal()); });
  let buffered = Buffer.alloc(0);
  const lines: unknown[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  stream.on("data", (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length > MAX_FRAME) { stream.destroy(refusal()); return; }
    for (let end; (end = buffered.indexOf(10)) >= 0;) {
      if (end > MAX_BODY || lines.length >= 4) { stream.destroy(refusal()); return; }
      try { lines.push(wireJson(buffered.subarray(0, end))); } catch { stream.destroy(refusal()); return; }
      buffered = buffered.subarray(end + 1);
    }
    wake?.(); wake = undefined;
  });
  stream.on("end", () => { ended = true; wake?.(); });
  stream.on("error", () => { ended = true; wake?.(); });
  const receive = async () => {
    while (!lines.length && !ended) await new Promise<void>((resolve) => { wake = resolve; });
    requireEvidence(!ended && lines.length === 1);
    return lines.shift();
  };
  let serial = Promise.resolve();
  let id = 0;
  let poisoned = false;
  const send = async (value: unknown) => {
    const bytes = JSON.stringify(value) + "\n"; requireEvidence(Buffer.byteLength(bytes) <= MAX_FRAME);
    await new Promise<void>((resolve, reject) => output.write(bytes, (error) => error ? reject(refusal()) : resolve()));
  };
  return { receive, send, request: (operation: BrokerOperation): Promise<unknown> => {
    const next = serial.then(async () => {
      requireEvidence(!poisoned);
      const current = ++id; requireEvidence(current <= 128);
      await send({ id: current, ...operation });
      const response = await receive() as { id: number; value: unknown };
      requireEvidence(response && Object.keys(response).sort().join() === "id,value" && response.id === current);
      return response.value;
    });
    serial = next.then(() => undefined, () => { poisoned = true; }); // failure poisons all subsequent requests
    return next;
  }, close: () => { stream.destroy(); output.end(); } };
}

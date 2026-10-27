// Only injected first-party GET transports. No ambient fetch, retries or recovery.
import { refusal, requireEvidence } from "./planning-state.ts";

export const MAX_BODY = 8 * 1024 * 1024;
export async function boundedBody(response: Response, limit = MAX_BODY): Promise<Uint8Array> {
  requireEvidence(!response.redirected && response.status === 200 && response.body);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      requireEvidence(size <= limit);
      chunks.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

// Validate before native revival: beta.83 recursively assigns object keys and
// otherwise accepts Schema.Any. Never give it prototypes, cycles or deep input.
export function checkWire(value: unknown): void {
  const ancestors = new Set<object>();
  let nodes = 0, bytes = 0;
  const visit = (v: unknown, depth: number): void => {
    requireEvidence(++nodes <= 100_000 && depth < 64);
    if (typeof v === "string") { bytes += Buffer.byteLength(v); requireEvidence(bytes <= MAX_BODY); return; }
    if (v === null || v === undefined || typeof v === "boolean") return;
    if (typeof v === "number") { requireEvidence(Number.isFinite(v)); return; }
    requireEvidence(typeof v === "object" && !ancestors.has(v));
    requireEvidence(Array.isArray(v) || Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
    ancestors.add(v);
    for (const key of Reflect.ownKeys(v)) {
      requireEvidence(typeof key === "string" && !["__proto__", "constructor", "prototype"].includes(key));
      if (Array.isArray(v) && key === "length") continue;
      if (Array.isArray(v)) requireEvidence(/^(0|[1-9][0-9]*)$/.test(key));
      bytes += Buffer.byteLength(key); requireEvidence(bytes <= MAX_BODY);
      const descriptor = Object.getOwnPropertyDescriptor(v, key);
      requireEvidence(descriptor && "value" in descriptor && descriptor.enumerable);
      visit(descriptor.value, depth + 1);
    }
    if (!Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      const marker = ["__redacted__", "__duration__", "__date__"].find((key) => key in obj);
      if (marker) {
        requireEvidence(Object.keys(obj).length === 1);
        if (marker === "__duration__") {
          const d = obj[marker] as Record<string, unknown>;
          requireEvidence(d && typeof d === "object" && !Array.isArray(d) &&
            Object.keys(d).every((key) => ["_id", "_tag", "millis", "nanos"].includes(key)) && d._id === "Duration" &&
            ((d._tag === "Millis" && typeof d.millis === "number" && Number.isFinite(d.millis) && d.nanos === undefined) ||
              (d._tag === "Nanos" && typeof d.nanos === "string" && /^-?[0-9]{1,30}$/.test(d.nanos) && d.millis === undefined)));
        }
        if (marker === "__date__") requireEvidence(typeof obj[marker] === "string" &&
          Number.isFinite(new Date(obj[marker]).getTime()) && new Date(obj[marker]).toISOString() === obj[marker]);
      }
    }
    ancestors.delete(v);
  };
  visit(value, 0);
}

export function wireJson(bytes: Uint8Array): unknown {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    checkWire(value);
    return value;
  } catch { throw refusal(); }
}
export function credential(value: string): void {
  requireEvidence(typeof value === "string" && value.length > 0 && value.length <= 16_384 && !/[\s\r\n]/.test(value));
}

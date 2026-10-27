import { createHash } from "node:crypto";
import { requireEvidence } from "./planning-state.ts";
// Bytes, module names and entrypoint, independent of multipart boundary and
// native plan representation. No source/bundle content is exposed in evidence.
export function planningBundleDigest(main: string, modules: readonly (readonly [string, string | Uint8Array])[]) {
  requireEvidence(modules.length > 0 && modules.length <= 256 && modules.some(([name]) => name === main) && new Set(modules.map(([name]) => name)).size === modules.length);
  const rows = modules.map(([name, content]) => {
    requireEvidence(/^[A-Za-z0-9_./~-]+$/.test(name) && !name.split("/").includes(".."));
    return [name, createHash("sha256").update(content).digest("hex")];
  }).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return createHash("sha256").update(JSON.stringify({ main, modules: rows })).digest("hex");
}

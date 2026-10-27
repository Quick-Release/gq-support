// Canonical tracked-source manifest. The launcher sends filenames + digests,
// never file contents in public evidence; child independently hashes its mounts.
import { createHash } from "node:crypto";
import { readFileSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { requireEvidence } from "./planning-state.ts";
export type SourceManifest = readonly (readonly [string, string])[];
export function validateCopiedSource(manifest: SourceManifest, expected: string) {
  requireEvidence(Array.isArray(manifest) && manifest.length > 0 && manifest.length < 2000 && new Set(manifest.map(([file]) => file)).size === manifest.length);
  const inventory: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(join("/workspace", directory))) {
      const file = directory ? `${directory}/${name}` : name;
      if (file === "node_modules" || file === "worker/node_modules") continue;
      requireEvidence(inventory.length < 2000);
      const stat = lstatSync(join("/workspace", file)); requireEvidence(!stat.isSymbolicLink());
      if (stat.isDirectory()) walk(file); else { requireEvidence(stat.isFile()); inventory.push(file); }
    }
  };
  walk("");
  requireEvidence(JSON.stringify(inventory.sort()) === JSON.stringify(manifest.map(([file]) => file).sort()));
  for (const [file, digest] of manifest) {
    requireEvidence(/^(?:worker\/|scripts\/ci\/|\.github\/workflows\/|package.json$|pnpm-lock.yaml$|pnpm-workspace.yaml$|plugin\/composer.lock$)/.test(file) &&
      !file.split("/").some((part: string) => part === ".." || part === ".git" || part.startsWith(".env")));
    const path = join("/workspace", file);
    requireEvidence(!lstatSync(path).isSymbolicLink() && createHash("sha256").update(readFileSync(path)).digest("hex") === digest);
  }
  requireEvidence(createHash("sha256").update(JSON.stringify(manifest)).digest("hex") === expected);
}

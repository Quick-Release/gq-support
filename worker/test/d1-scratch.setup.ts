import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Vitest global setup: one scratch directory per run for local-d1.ts's database copies,
 * removed when the run ends. Workers inherit it through GQ_D1_SCRATCH; Vitest stops them
 * without running their exit handlers, so they cannot clean up after themselves.
 * In memory where Linux offers it: on disk, SQLite's writes cost what copying saves.
 */
export default function setup(): () => void {
  const root = mkdtempSync(join(existsSync("/dev/shm") ? "/dev/shm" : tmpdir(), "gq-d1-"));
  process.env.GQ_D1_SCRATCH = root;
  return () => rmSync(root, { recursive: true, force: true });
}

import { spawnSync } from "node:child_process";
import type { CentralTransport, CommandResult } from "../src/central-deployment.ts";

/** Larger than any answer the adapter reads: a file list and digests of one plugin. */
const MAX_STDOUT_BYTES = 1024 * 1024;

/**
 * The central deployment transport on the Operator's machine (src/central-deployment.ts):
 * runs each argv directly, never through a local shell, so the reviewed runner (such as
 * ssh with the Operator's own agent and configuration) authenticates with credentials
 * that stay here. Stderr is discarded unread: it can carry host details, and nothing
 * from it is printed or recorded. A spawn failure, a timeout or oversized output is no
 * answer at all, which the adapter treats as unreachable before a change and unknown after.
 */
export const commandTransport = (): CentralTransport => ({
  run: async (argv, { stdin, timeoutMs = 60_000 } = {}): Promise<CommandResult> => {
    const [command, ...args] = argv;
    if (!command) return { kind: "lost" };
    const result = spawnSync(command, args, { shell: false, input: stdin ?? new Uint8Array(), stdio: ["pipe", "pipe", "ignore"],
      timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: MAX_STDOUT_BYTES, encoding: "utf8" });
    return result.error || result.status === null || result.signal ? { kind: "lost" } : { kind: "exit", code: result.status, stdout: result.stdout };
  },
});

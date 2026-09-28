import { parseEnv } from "node:util";
import { isDurableStage } from "../src/support-db-config.ts";

/**
 * Why `alchemy destroy` must not run with these arguments, or undefined when
 * it may. `--stage` wins, as in Alchemy. Without it, Alchemy reads
 * `$ALCHEMY_STAGE` from the process, `--env-file` or `.env`; the guard
 * refuses if any of them names a durable stage.
 */
export const destroyRefusal = (
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  readFile: (path: string) => string | undefined,
): string | undefined => {
  let flagStage: string | undefined;
  let envFile = ".env";
  for (const [index, arg] of argv.entries()) {
    const [flag, inline] = arg.split(/=(.*)/s, 2);
    if (flag !== "--stage" && flag !== "--env-file") continue;
    const value = inline ?? argv[index + 1];
    if (value === undefined || value.startsWith("-")) return `${flag} needs a value`;
    if (flag === "--stage") flagStage = value;
    else envFile = value;
  }

  const fileContents = readFile(envFile);
  const candidates = flagStage !== undefined
    ? [flagStage]
    : [env.ALCHEMY_STAGE, fileContents === undefined ? undefined : parseEnv(fileContents).ALCHEMY_STAGE];
  const durable = candidates.find((stage) => stage !== undefined && isDurableStage(stage));
  if (durable !== undefined) {
    return `Refusing to destroy the ${durable} stage: its D1 database holds Support records (ADR 0013).`;
  }
  return undefined;
};

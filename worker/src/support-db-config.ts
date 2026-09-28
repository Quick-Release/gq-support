/** Stages whose database is kept when its resource is removed or destroyed. */
const DURABLE_STAGES: readonly string[] = ["prod", "staging"];

export const isDurableStage = (stage: string): boolean => DURABLE_STAGES.includes(stage);

/**
 * Changing `jurisdiction`, `primaryLocationHint` or an explicit `name`
 * replaces the database. `eu` is ADR 0017; test/stack.test.ts pins these.
 */
export const supportDatabaseProps = {
  jurisdiction: "eu",
  migrations: "./migrations",
} as const;

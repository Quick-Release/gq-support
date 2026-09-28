import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

export const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");

export const migrationFiles = (): string[] =>
  readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort();

/** Splits a migration into statements. Migrations must not contain triggers. */
export const statementsOf = (sql: string): string[] =>
  sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

export const migrate = async (db: D1Database): Promise<void> => {
  for (const file of migrationFiles()) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    await db.batch(statementsOf(sql).map((statement) => db.prepare(statement)));
  }
};

/** A local stage: workerd-backed D1 databases with every migration applied. */
export const localStage = async <Name extends string>(
  names: readonly Name[],
): Promise<{
  databases: Record<Name, D1Database>;
  dispose: () => Promise<void>;
}> => {
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default { fetch() { return new Response(null) } }",
      d1Databases: [...names],
    }),
  );
  const databases = {} as Record<Name, D1Database>;
  for (const name of names) {
    databases[name] = (await mf.getD1Database(name)) as unknown as D1Database;
    await migrate(databases[name]);
  }
  return { databases, dispose: () => mf.dispose() };
};

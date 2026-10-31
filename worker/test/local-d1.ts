import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

export const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");
export const LEDGER_MIGRATIONS_DIR = join(import.meta.dirname, "..", "ledger-migrations");

export const migrationFiles = (directory = MIGRATIONS_DIR): string[] =>
  readdirSync(directory)
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

export const migrate = async (db: D1Database, directory = MIGRATIONS_DIR): Promise<void> => {
  for (const file of migrationFiles(directory)) {
    const sql = readFileSync(join(directory, file), "utf8");
    await db.batch(statementsOf(sql).map((statement) => db.prepare(statement)));
  }
};

const workerOptions = (names: readonly string[], persist: string) => convertV4MiniflareOptions({
  modules: true,
  script: "export default { fetch() { return new Response(null) } }",
  d1Databases: [...names],
  resourcePersistencePath: persist,
});

// The run's scratch directory (test/d1-scratch.setup.ts), removed when the run ends.
const scratch = () => process.env.GQ_D1_SCRATCH ?? tmpdir();

// Migrating takes most of a stage's setup, so each test process migrates each set of databases
// once, and every stage starts from a private copy. A set shares Miniflare's metadata file, so
// templates are per set, not per database.
const templates = new Map<string, Promise<string>>();
const ledgers = new WeakMap<D1Database, D1Database>();
/** The real local ledger paired with a test's main database, for the Operator seam. */
export const operatorLedger = (main: D1Database) => async (sql: string, parameters: readonly (string | number)[]) => {
  const ledger = ledgers.get(main);
  if (!ledger) throw new Error("No local suppression ledger for this database");
  return (await ledger.prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results;
};
const template = (names: readonly string[]): Promise<string> => {
  const key = JSON.stringify(names);
  let directory = templates.get(key);
  if (!directory) {
    directory = (async () => {
      const path = mkdtempSync(join(scratch(), "template-"));
      const mf = new Miniflare(workerOptions(names, path));
      try {
        for (const name of names) {
          await migrate((await mf.getD1Database(name)) as unknown as D1Database, name === "ledger" ? LEDGER_MIGRATIONS_DIR : MIGRATIONS_DIR);
        }
      } finally {
        await mf.dispose();
      }
      return path;
    })();
    templates.set(key, directory);
  }
  return directory;
};

/**
 * A local stage: workerd-backed D1 databases with every migration applied.
 * A database named `ledger` gets the suppression ledger's migrations instead.
 */
export const localStage = async <Name extends string>(
  names: readonly Name[],
): Promise<{
  databases: Record<Name, D1Database>;
  dispose: () => Promise<void>;
}> => {
  const persist = mkdtempSync(join(scratch(), "stage-"));
  const allNames = [...new Set([...names, "ledger"])];
  cpSync(await template(allNames), persist, { recursive: true });
  const mf = new Miniflare(workerOptions(allNames, persist));
  const databases = {} as Record<Name, D1Database>;
  for (const name of names) databases[name] = (await mf.getD1Database(name)) as unknown as D1Database;
  const ledger = (await mf.getD1Database("ledger")) as unknown as D1Database;
  for (const database of Object.values(databases) as D1Database[]) ledgers.set(database, ledger);
  return {
    databases,
    dispose: async () => {
      await mf.dispose();
      rmSync(persist, { recursive: true, force: true });
    },
  };
};

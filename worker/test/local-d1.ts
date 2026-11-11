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

// Runs a test's D1 statements inside workerd, against the real local D1 binding.
// Miniflare's proxied D1 stub makes prepare() and bind() synchronous round trips to workerd
// besides the query itself: three blocking hops per statement, which on a loaded CI runner
// made statement-heavy scenarios run past their timeout. Through this Worker a statement or
// a batch is one asynchronous request, and D1 still prepares, binds and runs it.
const BRIDGE = `export default {
  async fetch(request, env) {
    const { database, operation, statements, column } = await request.json();
    const db = env[database];
    try {
      const prepared = statements.map(({ sql, params }) => db.prepare(sql).bind(...params));
      const result = operation === "batch" ? await db.batch(prepared)
        : operation === "first" ? await (column === null ? prepared[0].first() : prepared[0].first(column))
        : await prepared[0][operation]();
      return Response.json({ result: result ?? null });
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : String(error) });
    }
  },
};`;

const workerOptions = (names: readonly string[], persist: string) => convertV4MiniflareOptions({
  modules: true,
  script: BRIDGE,
  d1Databases: [...names],
  resourcePersistencePath: persist,
});

type Bound = { sql: string; params: unknown[] };
/**
 * The D1Database a test sees: statements are plain values until a query runs them, so
 * preparing and binding never leave the test process. JSON carries every value this
 * schema stores (no BLOB columns); the D1 surface the Worker does not use is refused.
 */
const bridged = (mf: Miniflare, database: string): D1Database => {
  const send = async (operation: string, statements: readonly Bound[], column: string | null = null) => {
    const response = await mf.dispatchFetch("http://d1.local/", {
      method: "POST", body: JSON.stringify({ database, operation, statements, column }),
    });
    const body = await response.json() as { result: unknown } | { error: string };
    if ("error" in body) throw new Error(body.error);
    return body.result;
  };
  const unsupported = (what: string) => () => { throw new Error(`The local D1 bridge does not support ${what}`); };
  class Statement {
    constructor(readonly sql: string, readonly params: unknown[] = []) {}
    bind(...params: unknown[]) {
      // JSON would turn undefined into null; D1 refuses it, so refuse it here too.
      if (params.includes(undefined)) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
      return new Statement(this.sql, params);
    }
    first(column?: string) { return send("first", [this], column ?? null); }
    all() { return send("all", [this]); }
    run() { return send("run", [this]); }
    raw = unsupported("raw()");
    toJSON(): Bound { return { sql: this.sql, params: this.params }; }
  }
  return {
    prepare: (sql: string) => new Statement(sql),
    batch: (statements: readonly Statement[]) => send("batch", statements),
    exec: unsupported("exec()"),
    dump: unsupported("dump()"),
    withSession: unsupported("withSession()"),
  } as unknown as D1Database;
};

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
          await migrate(bridged(mf, name), name === "ledger" ? LEDGER_MIGRATIONS_DIR : MIGRATIONS_DIR);
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
  await mf.ready;
  for (const name of names) databases[name] = bridged(mf, name);
  const ledger = bridged(mf, "ledger");
  for (const database of Object.values(databases) as D1Database[]) ledgers.set(database, ledger);
  return {
    databases,
    dispose: async () => {
      await mf.dispose();
      rmSync(persist, { recursive: true, force: true });
    },
  };
};

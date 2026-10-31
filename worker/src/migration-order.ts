import * as Output from "alchemy/Output";

/** The attributes a D1 database resource reports once its migrations have run (alchemy/Cloudflare D1). */
interface Migrated {
  readonly migrationsHashes: Readonly<Record<string, string>>;
}

/** The plain-text Worker binding that carries the migrated schema (src/worker.ts). */
export const MIGRATED_SCHEMA_BINDING = "SUPPORT_MIGRATED_SCHEMA";

/**
 * A value that exists only once every database has finished applying its
 * migrations in this deployment: per database, the count and latest ID of its
 * applied migrations.
 *
 * Alchemy reconciles a resource as soon as every unresolved input in its props
 * and bindings resolves. A D1 binding needs only the database's stable
 * `databaseId`, which is known from prior state, so the Worker script and its
 * cron were uploaded alongside the migrations and could run new code on the
 * old schema (the 0e6bfc92 deployments: `[Worker] updating` before
 * `[SupportDB] updated`). Mapping the whole database resource keeps this
 * value unresolved until the database's update has finished. Apply then holds
 * any resource bound to it until both databases have migrated, and fails it,
 * unreconciled, if either migration fails. Stable attribute reads such as
 * `database.databaseId` add no such wait.
 */
export const migratedSchema = (...databases: readonly object[]) =>
  Output.map(
    Output.all(...databases.map((database) => Output.of(database as never))),
    (migrated) =>
      (migrated as readonly Migrated[])
        .map(({ migrationsHashes }) => {
          const ids = Object.keys(migrationsHashes).sort();
          return `${ids.length}:${ids.at(-1) ?? ""}`;
        })
        .join(","),
  );

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isDurableStage, supportDatabaseProps, supportLedgerProps } from "../src/support-db-config.ts";
import { LEDGER_MIGRATIONS_DIR, MIGRATIONS_DIR, migrationFiles } from "./local-d1.ts";

describe("SupportDB", () => {
  // Changing jurisdiction, the location hint or an explicit name replaces the
  // database. Update this test only together with a migration plan.
  it("pins the props that would replace the database", () => {
    expect(supportDatabaseProps).toEqual({
      jurisdiction: "eu",
      migrations: "./migrations",
    });
  });

  it("pins the suppression ledger's props, a separate database (ADR 0016)", () => {
    expect(supportLedgerProps).toEqual({
      jurisdiction: "eu",
      migrations: "./ledger-migrations",
    });
  });

  it.each(["prod", "staging"])("retains the database on %s", (stage) => {
    expect(isDurableStage(stage)).toBe(true);
  });

  it.each(["dev_valerio", "live_valerio", "prod-copy", "pr_12"])(
    "lets %s destroy its database",
    (stage) => {
      expect(isDurableStage(stage)).toBe(false);
    },
  );

  it.each([MIGRATIONS_DIR, LEDGER_MIGRATIONS_DIR])("numbers migrations in %s sequentially from 0001", (directory) => {
    const files = migrationFiles(directory);
    expect(files.length).toBeGreaterThan(0);
    files.forEach((file, index) => {
      expect(file).toMatch(new RegExp(`^${String(index + 1).padStart(4, "0")}_[a-z0-9_]+\\.sql$`));
    });
  });

  // Migrations are forward-only: once a file is committed it may be deployed,
  // so it never changes. A new migration adds its line to checksums.txt.
  it.each([MIGRATIONS_DIR, LEDGER_MIGRATIONS_DIR])("never edits a committed migration in %s", (directory) => {
    const locked = new Map(
      readFileSync(join(directory, "checksums.txt"), "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split(/\s+/).reverse() as [string, string]),
    );
    const actual = new Map(
      migrationFiles(directory).map((file) => [
        file,
        createHash("sha256").update(readFileSync(join(directory, file))).digest("hex"),
      ]),
    );

    expect(actual).toEqual(locked);
  });
});

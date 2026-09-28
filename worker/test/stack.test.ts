import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isDurableStage, supportDatabaseProps } from "../src/support-db-config.ts";
import { MIGRATIONS_DIR, migrationFiles } from "./local-d1.ts";

describe("SupportDB", () => {
  // Changing jurisdiction, the location hint or an explicit name replaces the
  // database. Update this test only together with a migration plan.
  it("pins the props that would replace the database", () => {
    expect(supportDatabaseProps).toEqual({
      jurisdiction: "eu",
      migrations: "./migrations",
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

  it("numbers migrations sequentially from 0001", () => {
    const files = migrationFiles();
    expect(files.length).toBeGreaterThan(0);
    files.forEach((file, index) => {
      expect(file).toMatch(new RegExp(`^${String(index + 1).padStart(4, "0")}_[a-z0-9_]+\\.sql$`));
    });
  });

  // Migrations are forward-only: once a file is committed it may be deployed,
  // so it never changes. A new migration adds its line to checksums.txt.
  it("never edits a committed migration", () => {
    const locked = new Map(
      readFileSync(join(MIGRATIONS_DIR, "checksums.txt"), "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split(/\s+/).reverse() as [string, string]),
    );
    const actual = new Map(
      migrationFiles().map((file) => [
        file,
        createHash("sha256").update(readFileSync(join(MIGRATIONS_DIR, file))).digest("hex"),
      ]),
    );

    expect(actual).toEqual(locked);
  });
});

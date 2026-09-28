import { describe, expect, it } from "vitest";
import { destroyRefusal } from "../scripts/destroy-guard.ts";

const noFiles = () => undefined;
const files = (contents: Record<string, string>) => (path: string) => contents[path];

describe("destroyRefusal", () => {
  it.each([
    [["--stage", "prod"], {}],
    [["--stage=staging"], {}],
    [[], { ALCHEMY_STAGE: "prod" }],
    [["--yes", "--stage", "staging"], { ALCHEMY_STAGE: "dev_valerio" }],
  ])("refuses a durable stage: %j %j", (argv, env) => {
    expect(destroyRefusal(argv, env, noFiles)).toMatch(/Refusing to destroy/);
  });

  it("refuses a --stage flag without a value", () => {
    expect(destroyRefusal(["--stage"], {}, noFiles)).toMatch(/--stage needs a value/);
  });

  it("refuses a durable stage set in .env", () => {
    expect(destroyRefusal([], {}, files({ ".env": "ALCHEMY_STAGE=prod\n" }))).toMatch(
      /Refusing to destroy the prod stage/,
    );
  });

  it.each([["--env-file", "ci.env"], ["--env-file=ci.env"]])(
    "refuses a durable stage set in the %s file",
    (...argv) => {
      expect(
        destroyRefusal(argv, {}, files({ "ci.env": "ALCHEMY_STAGE=staging" })),
      ).toMatch(/Refusing to destroy the staging stage/);
    },
  );

  it("refuses when any source names a durable stage", () => {
    expect(
      destroyRefusal([], { ALCHEMY_STAGE: "dev_valerio" }, files({ ".env": "ALCHEMY_STAGE=prod" })),
    ).toMatch(/Refusing/);
  });

  it("lets --stage override a durable stage in .env", () => {
    expect(
      destroyRefusal(["--stage", "dev_valerio"], {}, files({ ".env": "ALCHEMY_STAGE=prod" })),
    ).toBeUndefined();
  });

  it.each([
    [["--stage", "dev_valerio"], {}],
    [[], { ALCHEMY_STAGE: "pr_12" }],
    // The flag wins over every other source, as in Alchemy.
    [["--stage", "dev_valerio"], { ALCHEMY_STAGE: "prod" }],
    // Without any, Alchemy falls back to live_$USER.
    [[], {}],
  ])("allows a personal stage: %j %j", (argv, env) => {
    expect(destroyRefusal(argv, env, noFiles)).toBeUndefined();
  });
});

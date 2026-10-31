import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { githubEvidence, type Gh } from "../scripts/release-evidence.ts";

// #144: the Operator CLI reads release gates from GitHub's own records with the Operator's
// `gh` login. Here `gh` is controlled: the adapter must ask only for the named run of this
// repository and keep only the fields the gates check.
const calls: (readonly string[])[] = [];
const gh: Gh = (args) => {
  calls.push(args);
  const path = args[1] ?? "";
  if (args[0] === "api" && path === "repos/Quick-Release/gq-support/actions/runs/123") {
    return JSON.stringify({ id: 123, path: ".github/workflows/ci.yml", repository: { full_name: "Quick-Release/gq-support" }, head_sha: "b".repeat(40),
      head_branch: "main", event: "push", status: "completed", conclusion: "success", html_url: "https://github.com/Quick-Release/gq-support/actions/runs/123",
      actor: { login: "someone" } });
  }
  if (args[0] === "api" && path.startsWith("repos/Quick-Release/gq-support/actions/runs/123/jobs")) {
    return JSON.stringify({ jobs: [{ name: "Secret scan", conclusion: "success", steps: [] }] });
  }
  if (args[0] === "api" && path.startsWith("repos/Quick-Release/gq-support/actions/runs/123/artifacts")) {
    return JSON.stringify({ artifacts: [{ name: "deploy-plan-prod-123-1", expired: false }, { name: "deploy-plan-prod-123-2", expired: false },
      { name: "deploy-plan-prod-123-3", expired: true }] });
  }
  if (args[0] === "run" && args[1] === "download") {
    const directory = args[args.indexOf("--dir") + 1]!;
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "plan.json"), JSON.stringify({ attempt: args[args.indexOf("--name") + 1] }));
    return "";
  }
  return null;
};

it("reads a run with its latest jobs and a retained artifact's JSON, and nothing else", async () => {
  const evidence = githubEvidence(gh, mkdtempSync(join(tmpdir(), "gq-evidence-test-")));
  expect(await evidence.run("123")).toEqual({ id: 123, path: ".github/workflows/ci.yml", repository: "Quick-Release/gq-support", head_sha: "b".repeat(40),
    head_branch: "main", event: "push", status: "completed", conclusion: "success", html_url: "https://github.com/Quick-Release/gq-support/actions/runs/123",
    jobs: [{ name: "Secret scan", conclusion: "success" }] });
  // The latest unexpired attempt's record.
  expect(await evidence.artifact("123", "deploy-plan-prod-123-", "plan.json")).toEqual({ attempt: "deploy-plan-prod-123-2" });
  // No such run, or a malformed ID or file name, asks nothing that could be confused with it.
  const before = calls.length;
  expect(await evidence.run("124")).toBeNull();
  expect(await evidence.run("12; rm -rf /")).toBeNull();
  expect(await evidence.artifact("123", "deploy-plan-prod-123-", "../plan.json")).toBeNull();
  expect(calls.slice(before).every((args) => args.every((arg) => !arg.includes(";") && !arg.includes("..")))).toBe(true);
});

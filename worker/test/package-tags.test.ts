import { expect, it } from "vitest";
import { githubPackageTags } from "../scripts/package-tags.ts";
import type { Gh } from "../scripts/release-evidence.ts";

// The Operator CLI reads the published Composer tag with the Operator's `gh` login. Here `gh`
// is controlled: the adapter asks only for this repository's git records of that one tag, in
// argv form, and resolves an annotated tag to its commit and that commit's full tree.
const COMMIT = "c".repeat(40), TAG_OBJECT = "d".repeat(40), TREE = "e".repeat(40);
const entries = [{ path: "gq-support.php", mode: "100644", type: "blob", sha: "1".repeat(40), size: 10, url: "https://api.github.com/x" }];
const records = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  "repos/Quick-Release/gq-support/git/ref/tags/v0.2.0": { ref: "refs/tags/v0.2.0", object: { type: "tag", sha: TAG_OBJECT } },
  [`repos/Quick-Release/gq-support/git/tags/${TAG_OBJECT}`]: { tag: "v0.2.0", object: { type: "commit", sha: COMMIT } },
  [`repos/Quick-Release/gq-support/git/commits/${COMMIT}`]: { sha: COMMIT, tree: { sha: TREE } },
  [`repos/Quick-Release/gq-support/git/trees/${TREE}?recursive=1`]: { sha: TREE, truncated: false, tree: entries },
  ...overrides,
});
const ghOf = (served: Record<string, unknown>, calls: (readonly string[])[] = []): Gh => (args) => {
  calls.push(args);
  if (args.length !== 2 || args[0] !== "api") return null;
  return args[1]! in served ? JSON.stringify(served[args[1]!]) : null;
};

it("resolves the tag to its commit and full tree, reading only this repository's git records", async () => {
  const calls: (readonly string[])[] = [];
  expect(await githubPackageTags(ghOf(records(), calls)).read("v0.2.0")).toEqual({ commit: COMMIT, truncated: false,
    entries: [{ path: "gq-support.php", mode: "100644", type: "blob", sha: "1".repeat(40) }] });
  expect(calls).toEqual(Object.keys(records()).map((path) => ["api", path]));
});

it("resolves a lightweight tag directly to its commit", async () => {
  const served = records({ "repos/Quick-Release/gq-support/git/ref/tags/v0.2.0": { ref: "refs/tags/v0.2.0", object: { type: "commit", sha: COMMIT } } });
  expect((await githubPackageTags(ghOf(served)).read("v0.2.0"))?.commit).toBe(COMMIT);
});

it("gives nothing for a missing, mismatched or malformed record, and never asks for an unsafe tag", async () => {
  const read = (served: Record<string, unknown>, tag = "v0.2.0") => githubPackageTags(ghOf(served)).read(tag);
  expect(await read({})).toBeNull();
  // A prefix match GitHub might answer with another ref, or an annotated tag of another name.
  expect(await read(records({ "repos/Quick-Release/gq-support/git/ref/tags/v0.2.0": { ref: "refs/tags/v0.2.0-rc", object: { type: "commit", sha: COMMIT } } }))).toBeNull();
  expect(await read(records({ [`repos/Quick-Release/gq-support/git/tags/${TAG_OBJECT}`]: { tag: "v0.2.1", object: { type: "commit", sha: COMMIT } } }))).toBeNull();
  expect(await read(records({ [`repos/Quick-Release/gq-support/git/commits/${COMMIT}`]: { sha: COMMIT, tree: { sha: "../../x" } } }))).toBeNull();
  expect(await read(records({ [`repos/Quick-Release/gq-support/git/trees/${TREE}?recursive=1`]: { sha: TREE, tree: "nope" } }))).toBeNull();
  // An unstated truncation is a truncated tree.
  expect((await read(records({ [`repos/Quick-Release/gq-support/git/trees/${TREE}?recursive=1`]: { sha: TREE, tree: entries } })))?.truncated).toBe(true);
  const calls: (readonly string[])[] = [];
  for (const tag of ["0.2.0", "v0.2.0/../../x", "v0.2.0 --method=DELETE", "v"]) expect(await githubPackageTags(ghOf(records(), calls)).read(tag)).toBeNull();
  expect(calls).toEqual([]);
});

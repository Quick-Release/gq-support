import { PACKAGE_REPOSITORY } from "../src/package-source.ts";
import type { PackageTags, TreeEntry } from "../src/composer-approval.ts";
import { ghCommand, type Gh } from "./release-evidence.ts";

const TAG = /^v[0-9][A-Za-z0-9.+_-]{0,63}$/;
const SHA = /^[a-f0-9]{40}$/;

const parse = (text: string | null): Record<string, unknown> | null => {
  try {
    const value: unknown = text === null ? null : JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
};
const objectOf = (value: unknown) => value as { type?: unknown; sha?: unknown } | undefined;

/**
 * This repository's published Composer tags (src/composer-approval.ts), read with the
 * Operator's own `gh` login: the tag's ref, its annotated tag object, the commit and
 * that commit's recursive tree. Only GitHub's git database for PACKAGE_REPOSITORY,
 * through `gh api` GETs in argv form with bounded output and time (ghCommand); every
 * path segment is a validated tag name or 40-hex object ID. Anything missing,
 * mismatched or malformed is null, which refuses the approval record.
 */
export const githubPackageTags = (gh: Gh = ghCommand()): PackageTags => ({
  async read(tag) {
    if (!TAG.test(tag)) return null;
    const api = (path: string) => parse(gh(["api", `repos/${PACKAGE_REPOSITORY}/${path}`]));
    const ref = api(`git/ref/tags/${encodeURIComponent(tag)}`);
    if (ref?.ref !== `refs/tags/${tag}`) return null;
    let object = objectOf(ref.object);
    if (object?.type === "tag") {
      if (typeof object.sha !== "string" || !SHA.test(object.sha)) return null;
      const annotated = api(`git/tags/${object.sha}`);
      if (annotated?.tag !== tag) return null;
      object = objectOf(annotated.object);
    }
    if (object?.type !== "commit" || typeof object.sha !== "string" || !SHA.test(object.sha)) return null;
    const commit = object.sha;
    const tree = (api(`git/commits/${commit}`)?.tree as { sha?: unknown } | undefined)?.sha;
    if (typeof tree !== "string" || !SHA.test(tree)) return null;
    const listed = api(`git/trees/${tree}?recursive=1`);
    if (!listed || !Array.isArray(listed.tree)) return null;
    const entries: TreeEntry[] = (listed.tree as Record<string, unknown>[]).map((entry) => ({ path: String(entry.path ?? ""),
      mode: String(entry.mode ?? ""), type: String(entry.type ?? ""), sha: String(entry.sha ?? "") }));
    return { commit, truncated: listed.truncated !== false, entries };
  },
});

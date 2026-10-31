/**
 * Where the Worker reads approved plugin package bytes for native updates
 * (src/update-access.ts): the exact tested `gq-support.zip` that the release
 * workflow attaches to the private repository's `v<version>` GitHub Release
 * (.github/workflows/release-plugin.yml), not the 30-day workflow artifact.
 *
 * The read credential is a narrow token with read-only Contents access to this
 * one repository, held only as the Worker secret `UPDATE_PACKAGE_TOKEN`: never
 * the GitHub App's key, whose Issues/Metadata permissions are not expanded for
 * this. Without it the source is absent and native updates fail closed. The
 * token goes only to api.github.com, in a header; the short-lived storage URL a
 * download redirects to gets no credential. Every response is bounded, no
 * redirect is followed blindly, and the bytes must match the approved SHA-256.
 */
export interface PackageSource {
  /** The approved bytes, or why none can be served. */
  read(version: string, sha256: string): Promise<{ readonly bytes: Uint8Array } | { readonly failure: PackageFailure }>;
}

/** Bounded failure classes: never response bodies, URLs or credentials. */
export type PackageFailure = "unavailable" | "integrity" | "origin" | "too_large";

/** The reviewed repository whose Releases hold approved packages. */
export const PACKAGE_REPOSITORY = "Quick-Release/gq-support";
/** The approved package is ~70 KB; anything near this bound is not it. */
export const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
const MAX_METADATA_BYTES = 256 * 1024;
/** GitHub's release-asset storage hosts, the only targets of the asset download's one redirect. */
export const ASSET_HOSTS: readonly string[] = ["release-assets.githubusercontent.com", "objects.githubusercontent.com"];
const ASSET = "gq-support.zip";
const TOKEN = /^[A-Za-z0-9_]{20,255}$/;

const hex = async (bytes: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>)))
  .map((byte) => byte.toString(16).padStart(2, "0")).join("");

/** Reads at most `limit` bytes of a body; null if it is longer. */
const bounded = async (response: Response, limit: number): Promise<Uint8Array | null> => {
  const declared = Number(response.headers.get("Content-Length") ?? "0");
  if (declared > limit) { await response.body?.cancel(); return null; }
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
};

/**
 * The GitHub Releases package source, or null while the stage has no read
 * credential. `fetch` and `timeoutMs` are test seams.
 */
export const githubReleasePackages = ({ token, repository = PACKAGE_REPOSITORY, fetch: send = fetch, timeoutMs = 15_000 }:
  { token: string | undefined; repository?: string; fetch?: typeof fetch; timeoutMs?: number }): PackageSource | null => {
  if (!token || !TOKEN.test(token)) return null;
  const api = (path: string, accept: string) => send(`https://api.github.com/repos/${repository}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: accept, "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "gq-support-worker" },
    redirect: "manual", signal: AbortSignal.timeout(timeoutMs),
  });
  return {
    async read(version, sha256) {
      try {
        const release = await api(`/releases/tags/v${encodeURIComponent(version)}`, "application/vnd.github+json");
        if (release.status !== 200) { await release.body?.cancel(); return { failure: "unavailable" }; }
        const text = await bounded(release, MAX_METADATA_BYTES);
        const body = text && JSON.parse(new TextDecoder().decode(text)) as { tag_name?: unknown; draft?: unknown; assets?: unknown };
        const asset = body && body.tag_name === `v${version}` && body.draft === false && Array.isArray(body.assets)
          ? (body.assets as Record<string, unknown>[]).find((candidate) => candidate.name === ASSET && candidate.state === "uploaded") : undefined;
        if (!asset || !Number.isSafeInteger(asset.id) || (asset.id as number) < 1) return { failure: "unavailable" };
        if (typeof asset.size !== "number" || asset.size > MAX_PACKAGE_BYTES) return { failure: "too_large" };
        // GitHub's own recorded digest, where present, must already agree.
        if (asset.digest !== undefined && asset.digest !== `sha256:${sha256}`) return { failure: "integrity" };
        let download = await api(`/releases/assets/${asset.id as number}`, "application/octet-stream");
        if ([301, 302, 303, 307, 308].includes(download.status)) {
          // Exactly one redirect, to GitHub's asset storage over HTTPS, without the token.
          const location = new URL(download.headers.get("Location") ?? "", "https://invalid.invalid");
          await download.body?.cancel();
          if (location.protocol !== "https:" || !ASSET_HOSTS.includes(location.hostname) || location.port || location.username) {
            return { failure: "origin" };
          }
          download = await send(location.href, { headers: { Accept: "application/octet-stream", "User-Agent": "gq-support-worker" },
            redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
        }
        if (download.status !== 200) { await download.body?.cancel(); return { failure: "unavailable" }; }
        const bytes = await bounded(download, MAX_PACKAGE_BYTES);
        if (!bytes) return { failure: "too_large" };
        return await hex(bytes) === sha256 ? { bytes } : { failure: "integrity" };
      } catch {
        return { failure: "unavailable" };
      }
    },
  };
};

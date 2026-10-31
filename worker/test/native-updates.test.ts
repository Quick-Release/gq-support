import { createHash } from "node:crypto";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { replayLedger } from "../src/ledger.ts";
import { runOperator } from "../src/operator.ts";
import { githubReleasePackages, type PackageSource } from "../src/package-source.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { slotInventory } from "../src/inventory.ts";
import { handleWorkerRequest } from "../src/worker-http.ts";
import { handleUpdateRequest } from "../src/update-access.ts";
import { harness, keyPair, publicKeyOf } from "./installation-client.ts";
import { localStage } from "./local-d1.ts";
import updateFixtures from "../../contract/fixtures/update.json";

// #142: native WordPress updates of approved, verified package bytes, under a narrow
// update grant that is independent of the report Installation credential. Through the
// Worker HTTP entry and the Operator CLI, with local D1, a fake GitHub and a controlled clock.
const START = Date.parse("2026-10-20T10:00:00Z");
const MINUTE = 60_000;
const DAY = 86_400_000;
const mappings: RepositoryMapping[] = [
  { slot: "shop/production", client: "shop", project: "shop", environment: "production", repositoryId: 42, defaultDeveloper: "developer", deployment: "native" },
  { slot: "news/production", client: "news", project: "news", environment: "production", repositoryId: 43, defaultDeveloper: "developer", deployment: "native" },
  { slot: "blog/production", client: "blog", project: "blog", environment: "production", repositoryId: 44, defaultDeveloper: "developer", deployment: "central" },
];

let stage: Awaited<ReturnType<typeof localStage<"shared" | "ledger">>>;
let now: number;
let github: FakeReleases;

const advance = (milliseconds: number) => { now += milliseconds; vi.setSystemTime(now); };
const at = (time: number) => new Date(time).toISOString();
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (version: string) => new TextEncoder().encode(`PK gq-support ${version} approved package bytes`);

/**
 * GitHub's release API as the package source uses it: a release by tag with its
 * assets, and an asset download that redirects to a short-lived storage URL.
 * Records every request, with whether it carried the read token.
 */
interface FakeReleases {
  readonly requests: { url: string; authorized: boolean; redirect: string | undefined }[];
  readonly assets: Map<string, Uint8Array>;
  /** Overrides the storage redirect's target for one version. */
  readonly redirects: Map<string, string>;
  fetch: typeof fetch;
}
const TOKEN = "github_pat_test_read_only_contents";
const fakeReleases = (): FakeReleases => {
  const requests: FakeReleases["requests"] = [];
  const assets = new Map<string, Uint8Array>();
  const redirects = new Map<string, string>();
  const fetcher = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const authorization = new Headers(init.headers).get("Authorization");
    requests.push({ url: url.href, authorized: authorization !== null, redirect: init.redirect });
    const release = /^\/repos\/Quick-Release\/gq-support\/releases\/tags\/v(.+)$/.exec(url.pathname);
    const asset = /^\/repos\/Quick-Release\/gq-support\/releases\/assets\/(\d+)$/.exec(url.pathname);
    const versions = [...assets.keys()];
    if (url.host === "api.github.com" && authorization !== `Bearer ${TOKEN}`) return Response.json({ message: "Bad credentials" }, { status: 401 });
    if (url.host === "api.github.com" && release && assets.has(decodeURIComponent(release[1]!))) {
      const version = decodeURIComponent(release[1]!);
      const id = versions.indexOf(version) + 1;
      return Response.json({ tag_name: `v${version}`, draft: false, prerelease: false, assets: [
        { id: 900 + id, name: "gq-support.manifest.json", state: "uploaded", size: 10 },
        { id, name: "gq-support.zip", state: "uploaded", size: assets.get(version)!.length, digest: `sha256:${sha256(assets.get(version)!)}` },
      ] });
    }
    if (url.host === "api.github.com" && asset && versions[Number(asset[1]) - 1]) {
      const version = versions[Number(asset[1]) - 1]!;
      return new Response(null, { status: 302, headers: { Location: redirects.get(version)
        ?? `https://release-assets.githubusercontent.com/github-production-release-asset/${asset[1]}?sp=r&sig=short-lived` } });
    }
    if (url.host === "release-assets.githubusercontent.com" && !authorization) {
      const version = versions[Number(url.pathname.split("/").pop()) - 1];
      if (version) return new Response(assets.get(version)!, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  };
  return { requests, assets, redirects, fetch: fetcher as typeof fetch };
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: START });
  now = START;
  stage = await localStage(["shared", "ledger"]);
  github = fakeReleases();
});
afterEach(async () => { await stage.dispose(); vi.useRealTimers(); });

const query = (database: D1Database) => async (sql: string, parameters: readonly (string | number)[]) =>
  sql.match(/\?\d/) ? Promise.reject(new Error("Numbered parameter"))
    : (await database.prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results;
type D1Database = (typeof stage)["databases"]["shared"];

// Release artifacts as the release workflow writes them, by directory (src/release-operator.ts).
const artifacts = new Map<string, { zip: Uint8Array; manifest: string; provenance: string }>();
const operator = (...args: string[]) => runOperator(args, { mappings, now, recordRevocation: async () => {},
  query: query(stage.databases.shared), ledger: query(stage.databases.ledger),
  readArtifact: async (directory) => artifacts.get(directory)! });
/** Publishes `version` as the release workflow would, approves it and records its dispatch. */
const release = async (version: string, expected: string, { dispatch = true } = {}) => {
  const zip = bytesOf(version);
  artifacts.set(version, { zip, manifest: JSON.stringify({ name: "gq-support", version, zip: { size: zip.length, sha256: sha256(zip) } }),
    provenance: JSON.stringify({ version, commit: "b".repeat(40), run: "39000000001", zip_sha256: sha256(zip) }) });
  github.assets.set(version, zip);
  await operator("release-candidate", version, "a".repeat(40), "1", "0001-0028", "signed", "alex");
  const { release_id: id } = JSON.parse(await operator("release-approve", version, "production", expected,
    "https://github.com/Quick-Release/gq-support/pull/142", "alex")) as { release_id: number };
  if (dispatch) await operator("release-dispatch", String(id), at(now), "https://github.com/Quick-Release/gq-support/actions/runs/1", "alex");
  return { id: String(id), sha256: sha256(zip) };
};

const keyIdOf = (publicKey: string) => createHash("sha256").update(Buffer.from(publicKey, "base64")).digest("hex");
const base64 = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64");

/** A site's update key, spelled independently of the Worker's verifier, as the PHP updater signs. */
const updateKey = async () => {
  const pair = await keyPair();
  const publicKey = await publicKeyOf(pair);
  return { pair, publicKey, keyId: keyIdOf(publicKey) };
};
type UpdateKey = Awaited<ReturnType<typeof updateKey>>;
const signedUpdate = async (key: UpdateKey, path: string, { installed = "0.1.9", grant = "", requestId = crypto.randomUUID(), time = now } = {}) => {
  const digest = `sha-256=:${base64(await crypto.subtle.digest("SHA-256", new Uint8Array()))}:`;
  const timestamp = String(Math.floor(time / 1000));
  const canonical = ["gq-support-update-v1", "GET", path, key.keyId, installed, grant, timestamp, requestId, digest].join("\n");
  const signature = await crypto.subtle.sign("Ed25519", key.pair.privateKey, new TextEncoder().encode(canonical));
  return new Request(`https://support.example${path}`, { headers: {
    "GQ-Update-Key-Id": key.keyId, "GQ-Update-Installed-Version": installed, "GQ-Update-Grant": grant,
    "GQ-Update-Timestamp": timestamp, "GQ-Update-Request-Id": requestId, "Content-Digest": digest, "GQ-Update-Signature": base64(signature),
  } });
};

/** Through the Worker's HTTP entry, with the stage's package source. */
const serve = (request: Request, packages: PackageSource | null = githubReleasePackages({ token: TOKEN, fetch: github.fetch })) =>
  Effect.runPromise(handleWorkerRequest(HttpServerRequest.fromWeb(request), Effect.succeed(stage.databases.shared), mappings,
    () => Effect.die("Not a webhook"), () => {}, undefined, { release: "staged", packages }));

interface Offer {
  plugin: string;
  release: { release_id: number; version: string; package_sha256: string; package_path: string } | null;
  grant: { token: string; expires_at: string } | null;
  auto_update: boolean;
}
const metadata = async (key: UpdateKey, options: Parameters<typeof signedUpdate>[2] = {}) =>
  serve(await signedUpdate(key, "/v1/updates/gq-support", options));
const offer = async (key: UpdateKey, options: Parameters<typeof signedUpdate>[2] = {}) => {
  const response = await metadata(key, options);
  expect(response.status).toBe(200);
  return await response.json() as Offer;
};
const download = async (key: UpdateKey, current: Offer, options: Parameters<typeof signedUpdate>[2] = {}) =>
  serve(await signedUpdate(key, current.release!.package_path, { grant: current.grant!.token, ...options }));

const grant = async (key: UpdateKey, slot = "shop/production", expires = now + 365 * DAY) =>
  JSON.parse(await operator("update-access-grant", slot, key.publicKey, at(expires), "https://github.com/Quick-Release/gq-support/issues/142", "alex"));

it("offers only the dispatched approved release, and serves its exact verified bytes under a short-lived grant", async () => {
  const key = await updateKey();
  expect(await grant(key)).toMatchObject({ slot: "shop/production", key_id: key.keyId, state: "active" });

  // Nothing approved yet: no offer, and no grant to download anything with.
  expect(await offer(key)).toEqual({ plugin: "gq-support", release: null, grant: null, auto_update: true });
  // An approval alone is not a dispatch: native installations see it once dispatch is recorded.
  const first = await release("0.2.0", "none", { dispatch: false });
  expect((await offer(key)).release).toBeNull();
  await operator("release-dispatch", first.id, at(now), "https://github.com/Quick-Release/gq-support/actions/runs/1", "alex");

  const current = await offer(key);
  expect(current).toEqual({ plugin: "gq-support", auto_update: true,
    release: { release_id: 1, version: "0.2.0", package_sha256: first.sha256,
      package_path: `/v1/updates/gq-support/package?version=0.2.0&sha256=${first.sha256}` },
    grant: { token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), expires_at: at(now + 15 * MINUTE) } });

  // Exactly the shape WordPress validates (contract/fixtures/update.json).
  const shapes = updateFixtures.offers.filter((fixture) => fixture.valid).map(({ body }) => JSON.stringify(Object.keys(body).sort()));
  expect(shapes).toContain(JSON.stringify(Object.keys(current).sort()));
  expect(Object.keys(current.release!).sort()).toEqual(Object.keys(updateFixtures.offers[0]!.body.release!).sort());

  const response = await download(key, current);
  expect(response.status).toBe(200);
  expect(response.headers.get("Content-Type")).toBe("application/zip");
  expect(response.headers.get("GQ-Update-Package-Sha256")).toBe(first.sha256);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytesOf("0.2.0"));

  // The read token goes only to GitHub's API, in a header; storage gets no credential; nothing follows redirects blindly.
  expect(github.requests.map(({ url, authorized, redirect }) => [new URL(url).host, authorized, redirect])).toEqual([
    ["api.github.com", true, "manual"], ["api.github.com", true, "manual"], ["release-assets.githubusercontent.com", false, "manual"]]);
  expect(JSON.stringify(github.requests)).not.toContain(TOKEN);
  // No credential appears in any URL the installation is given.
  expect(current.release!.package_path).not.toContain(current.grant!.token);
});

it("records the served package as attempted and the signed installed version as observed, never as a completed update", async () => {
  const key = await updateKey();
  await grant(key);
  await release("0.2.0", "none");
  const inventory = async () => (await slotInventory(stage.databases.shared, [mappings[0]!], null, now)).slots[0]!;

  await download(key, await offer(key, { installed: "0.1.9" }));
  const served = await inventory();
  expect(served.versions).toMatchObject({ desired: { version: "0.2.0" }, attempted: { version: "0.2.0", source: "native-update" },
    observed: { version: "0.1.9", state: "current" } });
  expect(served.update).toEqual({ outcome: "unconfirmed", at: null });
  expect(served.update_access).toEqual({ state: "active", key_id: key.keyId, expires_at: at(now + 365 * DAY) });

  advance(5 * MINUTE);
  // The next maintenance check, signed by the updated plugin, is the confirmation.
  await offer(key, { installed: "0.2.0" });
  expect((await inventory()).update).toEqual({ outcome: "confirmed", at: at(now) });
});

it("renews expired download access only through the authenticated metadata path", async () => {
  const key = await updateKey();
  await grant(key);
  await release("0.2.0", "none");
  const stale = await offer(key);

  advance(15 * MINUTE + 1);
  const expired = await download(key, stale);
  expect(expired.status).toBe(401);
  expect(await expired.json()).toEqual({ code: "gq_support_update_grant_expired" });

  const renewed = await offer(key);
  expect(renewed.grant!.token).not.toBe(stale.grant!.token);
  expect((await download(key, renewed)).status).toBe(200);
  // A grant is bound to the key it was issued to.
  const other = await updateKey();
  await grant(other, "news/production");
  expect((await download(other, renewed)).status).toBe(401);
});

it("refuses a package that is no longer the approved release, and never offers it again", async () => {
  const key = await updateKey();
  await grant(key);
  await release("0.2.0", "none");
  const bad = await release("0.2.1", "1");
  const withdrawnOffer = await offer(key);
  expect(withdrawnOffer.release!.version).toBe("0.2.1");

  // Recovery re-approves 0.2.0: 0.2.1 is withdrawn while an installation still holds its offer.
  await operator("release-approve", "0.2.0", "recovery", "2", "https://github.com/Quick-Release/gq-support/issues/142", "alex");
  await operator("release-dispatch", "3", at(now), "https://github.com/Quick-Release/gq-support/actions/runs/2", "alex");
  const withdrawn = await download(key, withdrawnOffer);
  expect(withdrawn.status).toBe(410);
  expect(await withdrawn.json()).toEqual({ code: "gq_support_update_withdrawn" });
  expect((await offer(key)).release).toMatchObject({ release_id: 3, version: "0.2.0" });

  // Another version or digest under a valid grant is refused before any package read.
  const current = await offer(key);
  const before = github.requests.length;
  for (const path of [`/v1/updates/gq-support/package?version=0.2.1&sha256=${bad.sha256}`,
    `/v1/updates/gq-support/package?version=0.2.0&sha256=${"0".repeat(64)}`]) {
    expect((await serve(await signedUpdate(key, path, { grant: current.grant!.token }))).status).toBe(410);
  }
  expect(github.requests).toHaveLength(before);
});

it("serves nothing when the stored package is corrupt, redirects off the approved origins or the source is unconfigured", async () => {
  const key = await updateKey();
  await grant(key);
  await release("0.2.0", "none");

  github.assets.set("0.2.0", bytesOf("0.2.0-tampered"));
  const corrupt = await download(key, await offer(key));
  expect(corrupt.status).toBe(503);
  expect(await corrupt.json()).toEqual({ code: "gq_support_update_unavailable" });
  // Operators see why, as a bounded class only.
  const failures: string[] = [];
  const packages = githubReleasePackages({ token: TOKEN, fetch: github.fetch });
  const current = await offer(key);
  expect((await handleUpdateRequest(await signedUpdate(key, current.release!.package_path, { grant: current.grant!.token }),
    stage.databases.shared, mappings, { packages, observe: (failure) => failures.push(failure) }, now)).status).toBe(503);
  expect(failures).toEqual(["integrity"]);

  github.assets.set("0.2.0", bytesOf("0.2.0"));
  github.redirects.set("0.2.0", "https://attacker.example/gq-support.zip");
  expect((await download(key, await offer(key))).status).toBe(503);
  expect(github.requests.some(({ url }) => url.includes("attacker.example"))).toBe(false);
  github.redirects.set("0.2.0", "http://release-assets.githubusercontent.com/github-production-release-asset/1");
  expect((await download(key, await offer(key))).status).toBe(503);

  // Without the narrow read credential, the stage fails closed: no offer to download.
  const unconfigured = await metadata(key);
  expect(unconfigured.status).toBe(200);
  const response = await serve(await signedUpdate(key, "/v1/updates/gq-support"), githubReleasePackages({ token: "", fetch: github.fetch }));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ code: "gq_support_update_unavailable" });
});

it("authorizes only a granted, unexpired, unrevoked, unreplayed update key, and never with report credentials", async () => {
  await release("0.2.0", "none");
  const unauthorized = { code: "gq_support_update_unauthorized" };
  const stranger = await updateKey();
  expect((await metadata(stranger)).status).toBe(401);
  expect(await (await metadata(stranger)).json()).toEqual(unauthorized);

  const key = await updateKey();
  await grant(key, "shop/production", now + DAY);
  // A replayed request, a stale signature and an altered claim are refused.
  const request = await signedUpdate(key, "/v1/updates/gq-support");
  expect((await serve(request.clone())).status).toBe(200);
  expect((await serve(request)).status).toBe(401);
  expect((await metadata(key, { time: now - 6 * MINUTE })).status).toBe(401);
  const altered = await signedUpdate(key, "/v1/updates/gq-support");
  altered.headers.set("GQ-Update-Installed-Version", "9.9.9");
  expect((await serve(altered)).status).toBe(401);

  // An Installation credential's signature is not update authority, nor the update key report authority.
  const sites = harness(stage.databases.shared, mappings);
  const installation = await sites.enroll("shop/production", "installation-a", {}, "0.1.9");
  const report = await serve(await (async () => {
    const signed = await signedUpdate(key, "/v1/updates/gq-support");
    signed.headers.set("GQ-Update-Key-Id", installation.keyId);
    return signed;
  })());
  expect(report.status).toBe(401);
  const asInstallation = new Request("https://support.example/v1/requests", { headers: (await signedUpdate(key, "/v1/requests")).headers });
  expect((await serve(asInstallation)).status).toBe(403);

  // Expiry ends access without any action.
  advance(DAY);
  expect((await metadata(key)).status).toBe(401);
});

it("keeps update access through report disablement and Installation credential revocation, until update access itself is revoked", async () => {
  await release("0.2.0", "none");
  const key = await updateKey();
  await grant(key);
  const sites = harness(stage.databases.shared, mappings);
  const installation = await sites.enroll("shop/production", "installation-a", {}, "0.1.9");

  expect(await sites.operator("revoke", "shop/production")).toBe("Revoked shop/production");
  expect((await installation.send("GET", "/v1/installation")).status).toBe(403);
  expect((await download(key, await offer(key))).status).toBe(200);

  const current = await offer(key);
  expect(JSON.parse(await operator("update-access-revoke", "shop/production", "all", "https://github.com/Quick-Release/gq-support/issues/147", "alex")))
    .toEqual({ slot: "shop/production", revoked: [key.keyId] });
  expect((await metadata(key)).status).toBe(401);
  expect((await download(key, current)).status).toBe(401);
  // A revoked key cannot be granted again, to this or any Slot.
  await expect(grant(key)).rejects.toThrow(/revoked/);
  await expect(grant(key, "news/production")).rejects.toThrow(/another Slot|revoked/);
});

it("grants update access only to reviewed native Slots, one current key per Slot, never across Slots", async () => {
  const key = await updateKey();
  await expect(grant(key, "blog/production")).rejects.toThrow(/native/);
  await expect(grant(key, "unknown/production")).rejects.toThrow(/Unknown Slot/);
  await expect(operator("update-access-grant", "shop/production", key.publicKey, at(now - 1), "https://example.test/evidence", "alex"))
    .rejects.toThrow(/expires/);
  await expect(operator("update-access-grant", "shop/production", "not-a-key", at(now + DAY), "https://example.test/evidence", "alex"))
    .rejects.toThrow(/Usage/);

  await grant(key);
  // A retry after a lost response finds its own grant; the same key for another Slot is refused.
  expect(await grant(key)).toMatchObject({ key_id: key.keyId, state: "active" });
  await expect(grant(key, "news/production")).rejects.toThrow(/another Slot/);

  // Rotation: a newer grant supersedes the Slot's older key at once.
  await release("0.2.0", "none");
  const rotated = await updateKey();
  await grant(rotated);
  expect((await metadata(key)).status).toBe(401);
  expect((await metadata(rotated)).status).toBe(200);
  const status = JSON.parse(await operator("update-access-status", "shop/production")) as { keys: { key_id: string; state: string }[] };
  expect(status.keys.map(({ key_id: id, state }) => [id, state])).toEqual([[rotated.keyId, "active"], [key.keyId, "superseded"]]);
  expect(JSON.stringify(status)).not.toContain(TOKEN);
});

it("never revives revoked update access after a restore of the main database", async () => {
  await release("0.2.0", "none");
  const key = await updateKey();
  await grant(key);
  const db = stage.databases.shared;
  const tables = ["update_access_grant", "update_access_revocation"];
  const image = await Promise.all(tables.map(async (table) => ({ table, rows: (await db.prepare(`SELECT * FROM ${table}`).all()).results })));

  await operator("update-access-revoke", "shop/production", key.keyId, "https://github.com/Quick-Release/gq-support/issues/147", "alex");
  // A Time Travel restore to before the revocation brings back the active grant.
  await db.batch([...tables.reverse().map((table) => db.prepare(`DELETE FROM ${table}`)),
    ...image.flatMap(({ table, rows }) => rows.map((row) => db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(", ")})
      VALUES (${Object.keys(row).map(() => "?").join(", ")})`).bind(...Object.values(row))))]);
  expect((await metadata(key)).status).toBe(200);

  await replayLedger(db, stage.databases.ledger, 1, now);
  expect((await metadata(key)).status).toBe(401);
});

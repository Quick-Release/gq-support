import { describe, expect, it } from "vitest";
import signing from "../../contract/fixtures/signing.json";
import updateSigning from "../../contract/fixtures/update-signing.json";
import { verifyInstallation, verifySignature } from "../src/signature.ts";
import { UPDATE_SIGNATURE, updateKeyId } from "../src/update-access.ts";

// The PHP signer produced these cases; PHPUnit re-signs the same inputs.
type Case = (typeof signing.cases)[number];

const requestFor = (fixture: Case, change: Partial<{ method: string; path: string; body: string }> = {}, headers: Record<string, string> = {}) => {
  const method = change.method ?? fixture.method;
  const body = change.body ?? fixture.body;
  return {
    request: new Request(`https://support.example${change.path ?? fixture.path}`, {
      method,
      body: method === "GET" ? undefined : body,
      headers: {
        ...fixture.headers as Record<string, string>, "Content-Digest": fixture.content_digest, "GQ-Support-Signature": fixture.signature, ...headers,
      },
    }),
    body,
  };
};
const verify = async ({ request, body }: ReturnType<typeof requestFor>, fixture: Case, now = Number(fixture.headers["GQ-Support-Timestamp"]) * 1000) =>
  (await verifyInstallation(request, body, signing.public_key, now)) !== null;
// What the signature authenticates about the plugin version: only a gq-support-v2 signature covers it.
const claimed = (fixture: Case) => "GQ-Support-Plugin-Version" in fixture.headers ? fixture.headers["GQ-Support-Plugin-Version"] : null;

describe.each(signing.cases)("shared signing fixture: $name", (fixture) => {
  it("verifies the PHP signature", async () => {
    expect(await verify(requestFor(fixture), fixture)).toBe(true);
  });

  it.each([
    ["method", { method: fixture.method === "GET" ? "DELETE" : "PUT" }, {}],
    ["path", { path: fixture.path.replace("/v1/", "/v2/") }, {}],
    ["query", { path: `${fixture.path}${fixture.path.includes("?") ? "&" : "?"}slot=other` }, {}],
    ["key ID", {}, { "GQ-Support-Key-Id": "another-key" }],
    ["installation ID", {}, { "GQ-Support-Installation-Id": "another-installation" }],
    ["timestamp", {}, { "GQ-Support-Timestamp": String(Number(fixture.headers["GQ-Support-Timestamp"]) + 1) }],
    ["request ID", {}, { "GQ-Support-Request-Id": "a1b2c3d4-0000-4000-8000-999999999999" }],
    ...(claimed(fixture) === null ? [] : [["plugin version", {}, { "GQ-Support-Plugin-Version": "0.2.1" }] as const]),
    ["signature", {}, { "GQ-Support-Signature": signing.cases[(signing.cases.indexOf(fixture) + 1) % signing.cases.length]!.signature }],
  ] as const)("rejects an altered %s", async (_, change, headers) => {
    expect(await verify(requestFor(fixture, change, headers), fixture)).toBe(false);
  });

  it("authenticates the plugin version only when the signature covers it", async () => {
    const { request, body } = requestFor(fixture);
    const now = Number(fixture.headers["GQ-Support-Timestamp"]) * 1000;
    expect(await verifyInstallation(request, body, signing.public_key, now)).toEqual({ pluginVersion: claimed(fixture) });
    // An unsigned version header, as legacy plugins send, is never a claim; nor can it be added or removed.
    const spoofed = requestFor(fixture, {}, { "GQ-Support-Plugin-Version": "9.9.9" });
    expect(await verifyInstallation(spoofed.request, spoofed.body, signing.public_key, now)).toEqual(claimed(fixture) === null ? { pluginVersion: null } : null);
    if (claimed(fixture) !== null) {
      const stripped = requestFor(fixture);
      stripped.request.headers.delete("GQ-Support-Plugin-Version");
      expect(await verifyInstallation(stripped.request, stripped.body, signing.public_key, now)).toBeNull();
    }
  });

  it("rejects an altered body even with its own matching digest", async () => {
    const body = `${fixture.body} `;
    const digest = `sha-256=:${Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body))).toString("base64")}:`;
    expect(await verify(requestFor(fixture, { body, method: "POST" }, { "Content-Digest": digest }), fixture)).toBe(false);
  });

  it("rejects a timestamp outside the five-minute window", async () => {
    const signedAt = Number(fixture.headers["GQ-Support-Timestamp"]) * 1000;
    expect(await verify(requestFor(fixture), fixture, signedAt + 300_000)).toBe(true);
    expect(await verify(requestFor(fixture), fixture, signedAt + 300_001)).toBe(false);
    expect(await verify(requestFor(fixture), fixture, signedAt - 300_001)).toBe(false);
  });
});

it("matches the canonical string and digest the fixture records", async () => {
  for (const fixture of signing.cases) {
    const digest = `sha-256=:${Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fixture.body))).toString("base64")}:`;
    expect(digest).toBe(fixture.content_digest);
    const version = claimed(fixture);
    expect(fixture.scheme).toBe(version === null ? "gq-support-v1" : "gq-support-v2");
    expect(fixture.canonical).toBe([fixture.scheme, fixture.method, fixture.path, fixture.headers["GQ-Support-Key-Id"],
      fixture.headers["GQ-Support-Installation-Id"], ...(version === null ? [] : [version]), fixture.headers["GQ-Support-Timestamp"],
      fixture.headers["GQ-Support-Request-Id"], digest].join("\n"));
  }
});

// #142: native update requests, signed by an update key; never an installation signature.
describe.each(updateSigning.cases)("shared update signing fixture: $name", (fixture) => {
  const request = (headers: Record<string, string> = {}, path = fixture.path) => new Request(`https://support.example${path}`, {
    headers: { ...fixture.headers, "Content-Digest": fixture.content_digest, "GQ-Update-Signature": fixture.signature, ...headers },
  });
  const now = Number(fixture.headers["GQ-Update-Timestamp"]) * 1000;
  const verify = (candidate: Request) => verifySignature(candidate, "", updateSigning.public_key, now, UPDATE_SIGNATURE);

  it("verifies the PHP signature, under the update key's ID", async () => {
    expect(await verify(request())).toBe(true);
    expect(await updateKeyId(updateSigning.public_key)).toBe(updateSigning.key_id);
    // The installation schemes never accept it.
    expect(await verifyInstallation(request(), "", updateSigning.public_key, now)).toBeNull();
  });

  it.each([
    ["path", {}, fixture.path.replace("/v1/", "/v2/")],
    ["query", {}, `${fixture.path}${fixture.path.includes("?") ? "&" : "?"}version=9.9.9`],
    ["key ID", { "GQ-Update-Key-Id": "0".repeat(64) }, undefined],
    ["installed version", { "GQ-Update-Installed-Version": "9.9.9" }, undefined],
    ["grant", { "GQ-Update-Grant": fixture.headers["GQ-Update-Grant"] ? "" : "fixture-grant-AAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, undefined],
    ["timestamp", { "GQ-Update-Timestamp": String(Number(fixture.headers["GQ-Update-Timestamp"]) + 1) }, undefined],
    ["request ID", { "GQ-Update-Request-Id": "b1c2d3e4-0000-4000-8000-999999999999" }, undefined],
  ] as const)("rejects an altered %s", async (_, headers, path) => {
    expect(await verify(request(headers, path))).toBe(false);
  });
});

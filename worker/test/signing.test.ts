import { describe, expect, it } from "vitest";
import signing from "../../contract/fixtures/signing.json";
import { verifySignature } from "../src/signature.ts";

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
        ...fixture.headers, "Content-Digest": fixture.content_digest, "GQ-Support-Signature": fixture.signature, ...headers,
      },
    }),
    body,
  };
};
const verify = ({ request, body }: ReturnType<typeof requestFor>, fixture: Case, now = Number(fixture.headers["GQ-Support-Timestamp"]) * 1000) =>
  verifySignature(request, body, signing.public_key, now);

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
    ["signature", {}, { "GQ-Support-Signature": signing.cases[(signing.cases.indexOf(fixture) + 1) % signing.cases.length]!.signature }],
  ] as const)("rejects an altered %s", async (_, change, headers) => {
    expect(await verify(requestFor(fixture, change, headers), fixture)).toBe(false);
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
    expect(fixture.canonical).toBe(["gq-support-v1", fixture.method, fixture.path, fixture.headers["GQ-Support-Key-Id"],
      fixture.headers["GQ-Support-Installation-Id"], fixture.headers["GQ-Support-Timestamp"], fixture.headers["GQ-Support-Request-Id"],
      digest].join("\n"));
  }
});

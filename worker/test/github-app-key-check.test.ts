import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { convertV4MiniflareOptions, Miniflare, Response as RuntimeResponse } from "miniflare";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { checkBoundGitHubAppKey } from "../src/github-app-key-check.ts";

const expected = { clientId: "Iv1.staging", slug: "getquick-support-staging" };
const app = { id: 123, client_id: expected.clientId, slug: expected.slug,
  owner: { login: "Quick-Release", type: "Organization" } };

describe("bound App key custody check", () => {
  it("authenticates through the Workers-native fetch implementation", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const compiled = ts.transpileModule(
      readFileSync(join(import.meta.dirname, "../src/github-app-key-check.ts"), "utf8"),
      { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } },
    ).outputText;
    let calls = 0;
    let redirect = false;
    const runtime = new Miniflare(convertV4MiniflareOptions({
      modules: true,
      // Matches the pinned local runtime; production has a newer date.
      compatibilityDate: "2026-09-16",
      bindings: { KEY: pem },
      script: `${compiled}\nexport default { async fetch(request, env) {
        return Response.json(await checkBoundGitHubAppKey(env.KEY, ${JSON.stringify(expected)}));
      } };`,
      outboundService: async (request) => {
        calls++;
        expect(request.url).toBe("https://api.github.com/app");
        const [header, payload, signature] = request.headers.get("Authorization")!.slice(7).split(".");
        expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
        return redirect
          ? new RuntimeResponse(null, { status: 302, headers: { Location: "https://unexpected.invalid" } })
          : RuntimeResponse.json(app);
      },
    }));
    try {
      const response = await runtime.dispatchFetch("https://test.invalid");
      expect(await response.json()).toMatchObject({ ok: true, appId: 123, ...expected });
      expect(calls).toBe(1);
      redirect = true;
      const redirected = await runtime.dispatchFetch("https://test.invalid");
      expect(await redirected.json()).toEqual({ ok: false });
      expect(calls).toBe(2);
    } finally {
      await runtime.dispose();
    }
  });

  it("signs with the currently bound key on every call, including after replacement", async () => {
    let calls = 0;
    for (let rotation = 0; rotation < 2; rotation++) {
      const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
      const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
      const result = await checkBoundGitHubAppKey(pem, expected, async (url, init) => {
        calls++;
        expect(url).toBe("https://api.github.com/app");
        const [header, payload, signature] = new Headers(init?.headers).get("Authorization")!.slice(7).split(".");
        expect(verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url"))).toBe(true);
        return Response.json(app);
      });
      const fingerprint = createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("base64");
      expect(result).toEqual({ ok: true, appId: 123, ...expected, fingerprint });
    }
    expect(calls).toBe(2);
  });

  it.each([undefined, "not a key"])("denies a missing or invalid key without network access", async (pem) => {
    let calls = 0;
    expect(await checkBoundGitHubAppKey(pem, expected, async () => {
      calls++;
      throw new Error("must not be called");
    })).toEqual({ ok: false });
    expect(calls).toBe(0);
  });

  it("returns only a generic failure for revoked keys, wrong Apps, oversized responses and transport errors", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    const failures = [
      async () => new Response(pem, { status: 401 }),
      async () => Response.json({ ...app, slug: "getquick-support" }),
      async () => new Response("x".repeat(32_769)),
      async () => { throw new Error(pem); },
    ];
    for (const request of failures) {
      expect(await checkBoundGitHubAppKey(pem, expected, request)).toEqual({ ok: false });
    }
  });
});

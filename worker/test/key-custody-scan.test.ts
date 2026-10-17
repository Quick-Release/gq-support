import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { keyLeakCheck, scanKeyFiles } from "../deploy/key-custody-scan.ts";
import * as Redacted from "effect/Redacted";
import { encodeState } from "alchemy/State/StateEncoding";

const key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
const pem = key.export({ type: "pkcs8", format: "pem" }).toString();

describe("App key custody file audit", () => {
  it("detects keys inside state wrappers that ordinary JSON hides", () => {
    const state = { props: { key: Redacted.make(pem) } };
    const check = keyLeakCheck(pem);
    expect(() => check(JSON.stringify(state))).not.toThrow();
    expect(() => check(JSON.stringify(encodeState(state)))).toThrow("App key material found");
  });

  it("detects PEM, escaped PEM, base64 and binary DER without exposing their contents", () => {
    const check = keyLeakCheck(pem);
    const forms = [pem, JSON.stringify(pem), pem.replace(/-----[^\n]+-----|\s/g, ""),
      key.export({ type: "pkcs8", format: "der" })];
    for (const form of forms) {
      expect(() => check(form)).toThrow("App key material found outside its secret binding");
    }
    const historical = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
      .export({ type: "pkcs8", format: "pem" }).toString();
    expect(() => check(historical)).toThrow("App key material found");
    expect(() => check(JSON.stringify(historical))).toThrow("App key material found");
    expect(() => check('if (pem.startsWith("-----BEGIN PRIVATE KEY-----")) {}')).not.toThrow();
  });

  it("detects a binary artifact elsewhere in the checkout, beyond the worker directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "gq-custody-test-"));
    try {
      await mkdir(join(root, "worker"));
      await mkdir(join(root, "plugin"));
      await writeFile(join(root, "worker", "safe.txt"), "no credentials");
      await writeFile(join(root, "plugin", "unexpected.der"), key.export({ type: "pkcs8", format: "der" }));
      expect(await scanKeyFiles(join(root, "worker"), keyLeakCheck(pem))).toBe(1);
      await expect(scanKeyFiles(root, keyLeakCheck(pem))).rejects.toThrow("App key material found");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

import { mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readReleaseArtifact } from "../scripts/release-artifact.ts";
import { MAX_PACKAGE_BYTES } from "../src/package-source.ts";

const controls = vi.hoisted(() => ({ afterStat: undefined as (() => void) | undefined }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, fstatSync: (fd: number) => {
    const stat = fs.fstatSync(fd);
    const afterStat = controls.afterStat;
    controls.afterStat = undefined;
    afterStat?.();
    return stat;
  } };
});

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "gq-release-artifact-test-"));
  writeFileSync(join(directory, "gq-support.zip"), Buffer.from([0, 255, 13, 10]));
  writeFileSync(join(directory, "gq-support.manifest.json"), "{\"version\":\"0.1.11\"}\n");
  writeFileSync(join(directory, "provenance.json"), "{}\n");
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

it("reads the exact downloaded artifact bytes and JSON text", () => {
  expect(readReleaseArtifact(directory)).toEqual({ zip: Buffer.from([0, 255, 13, 10]), manifest: "{\"version\":\"0.1.11\"}\n", provenance: "{}\n" });
});

it.each(["gq-support.zip", "gq-support.manifest.json", "provenance.json"])("refuses oversized %s files", (name) => {
  truncateSync(join(directory, name), name === "gq-support.zip" ? MAX_PACKAGE_BYTES + 1 : 1024 * 1024 + 1);
  expect(() => readReleaseArtifact(directory)).toThrow(/bounded regular file/);
});

it("refuses linked artifacts rather than following a replaced path", () => {
  rmSync(join(directory, "gq-support.zip"));
  symlinkSync(join(directory, "provenance.json"), join(directory, "gq-support.zip"));
  expect(() => readReleaseArtifact(directory)).toThrow();
});

it("keeps the read bounded when the opened ZIP grows after its size check", () => {
  controls.afterStat = () => truncateSync(join(directory, "gq-support.zip"), MAX_PACKAGE_BYTES + 1);
  expect(() => readReleaseArtifact(directory)).toThrow(/exceeds its size limit/);
});

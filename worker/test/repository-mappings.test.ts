import { expect, it } from "vitest";
import { mappingsForSlug, stageMappings } from "../src/repository-mappings.ts";

const SANDBOX = 1424354303;
const STAGING_INSTALLATION = 172696674;

it("gives each deployed stage only its own mappings, chosen by the stage's pinned App slug", () => {
  expect(mappingsForSlug("getquick-support-staging")).toBe(stageMappings.staging);
  expect(mappingsForSlug("getquick-support")).toBe(stageMappings.prod);
  // Development stages and a missing slug get no mappings, so they never deliver or sweep.
  for (const slug of ["", "getquick-support-dev", "constructor", "toString"]) expect(mappingsForSlug(slug)).toEqual([]);
});

it("keeps the staging sandbox out of production", () => {
  expect(stageMappings.staging).toContainEqual(expect.objectContaining({ repositoryId: SANDBOX, githubInstallationId: STAGING_INSTALLATION }));
  for (const mapping of stageMappings.prod) {
    expect(mapping.repositoryId).not.toBe(SANDBOX);
    expect(mapping.githubInstallationId).not.toBe(STAGING_INSTALLATION);
  }
  for (const mapping of stageMappings.staging) expect(mapping.githubInstallationId).toBe(STAGING_INSTALLATION);
});

it("has unique Slots within each stage", () => {
  for (const mappings of Object.values(stageMappings)) {
    expect(new Set(mappings.map((mapping) => mapping.slot)).size).toBe(mappings.length);
  }
});

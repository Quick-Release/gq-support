import { expect, it } from "vitest";
import { inventoryForSlug, stageInventories } from "../src/inventory.ts";
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

it("gives each deployed stage only its own reviewed inventory on the Tipme account, and other stages none", () => {
  expect(inventoryForSlug("getquick-support-staging")).toBe(stageInventories.staging);
  expect(inventoryForSlug("getquick-support")).toBe(stageInventories.prod);
  for (const slug of ["", "getquick-support-dev", "constructor"]) expect(inventoryForSlug(slug)).toBeNull();
  for (const [stage, inventory] of Object.entries(stageInventories)) {
    expect(inventory.stage).toBe(stage);
    // AGENTS.md: the existing Tipme account, never a replacement.
    expect(inventory.account).toEqual({ name: "Tipme", id: "8f38791a8c37b182239af2a385ab3c31" });
    // Custody names where values live; a value itself never enters reviewed configuration.
    expect(JSON.stringify(inventory)).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY|discord(app)?\.com\/api\/webhooks|ghs_|github_pat_/i);
  }
});

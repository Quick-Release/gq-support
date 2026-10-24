import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRequest } from "../src/installation-api.ts";
import { runOperator } from "../src/operator.ts";
import type { RepositoryMapping } from "../src/repository-mappings.ts";
import { keyPair, signed } from "./installation-client.ts";
import { localStage } from "./local-d1.ts";

const mappings: readonly RepositoryMapping[] = [{
  slot: "shop/production", client: "client-a", project: "shop", environment: "production",
  repositoryId: 123, defaultDeveloper: "developer",
}, {
  slot: "shop/staging", client: "client-a", project: "shop", environment: "staging",
  repositoryId: 123, defaultDeveloper: "developer",
}];

describe("installation enrollment at the Worker boundary", () => {
  let stage: Awaited<ReturnType<typeof localStage<"shared">>>;
  beforeEach(async () => { stage = await localStage(["shared"]); });
  afterEach(async () => { await stage.dispose(); });
  const operator = (command: string, slot = "shop/production", now?: number) =>
    runOperator([command, slot], {
      query: async (sql, parameters) => (await stage.databases.shared.prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results,
      recordRevocation: async () => {}, mappings, now,
    });
  const send = (request: Request, config = mappings) => handleRequest(request, stage.databases.shared, config);
  const enroll = async (code: string, pair: CryptoKeyPair, installationId = "installation-a", extra = {}) => {
    const body = JSON.stringify({ code, installation_id: installationId, origin: "https://shop.example",
      public_key: Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64"),
      wp_environment_type: "production", plugin_version: "0.1.0", ...extra });
    return send(await signed(pair, "POST", "/v1/enroll", body, "", installationId));
  };

  it("completes enrollment after a lost response and keeps the same binding on retry", async () => {
    const code = await operator("enroll");
    expect(code).toMatch(/^[A-Z2-7]{4}(?:-[A-Z2-7]{4}){5}-[A-Z2-7]{2}$/);
    const pair = await keyPair();
    const first = await enroll(code, pair);
    expect(first.status).toBe(200);
    const binding = await first.json() as { key_id: string; environment: string; connected_at: string };
    expect(binding).toMatchObject({ environment: "production", key_id: expect.any(String), connected_at: expect.any(String) });
    expect(await (await enroll(code, pair)).json()).toEqual(binding);
    const status = await send(await signed(pair, "GET", "/v1/installation", "", binding.key_id));
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ ...binding, mapping_state: "active" });
  });
  it("rejects a used code with another key or installation and hides invalid-code reasons", async () => {
    const code = await operator("enroll");
    const pair = await keyPair();
    expect((await enroll(code, pair)).status).toBe(200);
    const used = await enroll(code, await keyPair());
    expect(used.status).toBe(400);
    expect((await enroll(code, pair, "installation-b")).status).toBe(400);
    const unknown = await enroll("AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AA", pair);
    expect(unknown.status).toBe(400);
    expect(await unknown.json()).toEqual(await used.json());
    const anotherSlot = await enroll(code, pair, "installation-a", { slot: "shop/staging" });
    expect(anotherSlot.status).toBe(400);
  });

  it("self-revokes only its own key and denies the very next request", async () => {
    const pair = await keyPair();
    const result = await enroll(await operator("enroll"), pair);
    const { key_id: keyId } = await result.json() as { key_id: string };
    expect((await send(await signed(pair, "DELETE", "/v1/installation", "", keyId))).status).toBe(200);
    expect((await send(await signed(pair, "GET", "/v1/installation", "", keyId))).status).toBe(403);
  });

  it("rate-limits enrollment attempts by IP before expensive proof verification", async () => {
    const requests = Array.from({ length: 11 }, () => send(new Request("https://support.example/v1/enroll", {
      method: "POST", body: "{}", headers: { "CF-Connecting-IP": "192.0.2.20" },
    })));
    const statuses = (await Promise.all(requests)).map((response) => response.status);
    expect(statuses.filter((status) => status === 400)).toHaveLength(10);
    expect(statuses.filter((status) => status === 429)).toHaveLength(1);
    const otherIP = await send(new Request("https://support.example/v1/enroll", {
      method: "POST", body: "{}", headers: { "CF-Connecting-IP": "192.0.2.21" },
    }));
    expect(otherIP.status).toBe(400);
  });

  it("allows one concurrent code winner and rejects its replay with a different key", async () => {
    const code = await operator("enroll");
    const a = await keyPair(), b = await keyPair();
    const results = await Promise.all([enroll(code, a), enroll(code, b)]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
    const winner = results[0].status === 200 ? a : b;
    const binding = await results.find((result) => result.status === 200)!.json();
    expect(await (await enroll(code, winner)).json()).toEqual(binding);
  });

  it("returns one binding for concurrent retries using the same pending key", async () => {
    const code = await operator("enroll"), pair = await keyPair();
    const results = await Promise.all([enroll(code, pair), enroll(code, pair)]);
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(await results[0].json()).toEqual(await results[1].json());
  });

  it("returns the same generic error for expired, unknown and removed-mapping codes", async () => {
    const expired = await operator("enroll", "shop/production", Date.now() - 1_800_001);
    const pair = await keyPair();
    const response = await enroll(expired, pair);
    expect(response.status).toBe(400);
    const unknown = await enroll("AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AA", pair);
    expect(await response.json()).toEqual(await unknown.json());
    const code = await operator("enroll");
    const publicKey = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64");
    const request = await signed(pair, "POST", "/v1/enroll", JSON.stringify({
      code, installation_id: "installation-a", origin: "https://shop.example", public_key: publicKey,
    }));
    const removed = await send(request, []);
    expect(removed.status).toBe(400);
    expect(await removed.json()).toEqual(await (await enroll(expired, pair)).json());
  });

  it("revokes the previous key on rotation without affecting another Slot", async () => {
    const oldPair = await keyPair(), newPair = await keyPair(), stagingPair = await keyPair();
    const oldCode = await operator("enroll");
    const old = await (await enroll(oldCode, oldPair)).json() as { key_id: string };
    const staging = await (await enroll(await operator("enroll", "shop/staging"), stagingPair, "installation-b")).json() as { key_id: string; environment: string };
    expect(staging.environment).toBe("staging");
    const fresh = await (await enroll(await operator("enroll"), newPair)).json() as { key_id: string };
    expect(fresh.key_id).not.toBe(old.key_id);
    expect((await send(await signed(oldPair, "GET", "/v1/installation", "", old.key_id))).status).toBe(403);
    expect((await enroll(oldCode, oldPair)).status).toBe(400);
    expect((await send(await signed(newPair, "GET", "/v1/installation", "", fresh.key_id))).status).toBe(200);
    expect((await send(await signed(stagingPair, "GET", "/v1/installation", "", staging.key_id, "installation-b"))).status).toBe(200);
    await operator("revoke");
    const status = JSON.parse(await operator("status"));
    expect(status.key).toMatchObject({ key_id: fresh.key_id, revoked_at: expect.any(Number) });
    expect(status.key).not.toHaveProperty("public_key");
    expect((await send(await signed(newPair, "GET", "/v1/installation", "", fresh.key_id))).status).toBe(403);
    expect((await send(await signed(stagingPair, "GET", "/v1/installation", "", staging.key_id, "installation-b"))).status).toBe(200);
  });

  it("rejects an old request when rotation happens during signature verification", async () => {
    const pair = await keyPair(), nextPair = await keyPair();
    const old = await (await enroll(await operator("enroll"), pair)).json() as { key_id: string };
    const code = await operator("enroll");
    const original = crypto.subtle.verify.bind(crypto.subtle);
    const verify = vi.spyOn(crypto.subtle, "verify").mockImplementationOnce(async (...args) => {
      const valid = await original(...args);
      expect((await enroll(code, nextPair)).status).toBe(200);
      return valid;
    });
    try {
      expect((await send(await signed(pair, "GET", "/v1/installation", "", old.key_id))).status).toBe(403);
    } finally { verify.mockRestore(); }
  });

  it("rejects a different installation ID, altered signature, replay, and removed mapping", async () => {
    const pair = await keyPair();
    const { key_id: keyId } = await (await enroll(await operator("enroll"), pair)).json() as { key_id: string };
    expect((await send(await signed(pair, "GET", "/v1/installation", "", keyId, "installation-b"))).status).toBe(403);
    const request = await signed(pair, "GET", "/v1/installation", "", keyId);
    expect((await send(request.clone())).status).toBe(200);
    expect((await send(request)).status).toBe(403);
    const altered = await signed(pair, "DELETE", "/v1/installation", "", keyId);
    altered.headers.set("GQ-Support-Signature", "AAAA");
    expect((await send(altered)).status).toBe(403);
    expect((await send(await signed(pair, "GET", "/v1/installation", "", keyId), [])).status).toBe(403);
    expect((await send(await signed(pair, "GET", "/v1/installation", "", keyId))).status).toBe(200);
  });

  it("shows suspended mappings without leaking repository details", async () => {
    const pair = await keyPair();
    const { key_id: keyId } = await (await enroll(await operator("enroll"), pair)).json() as { key_id: string };
    await stage.databases.shared.prepare("INSERT INTO repository_state (repository_id, suspended_reason, observed_at) VALUES (123, 'archived', 1)").run();
    const response = await send(await signed(pair, "GET", "/v1/installation", "", keyId));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ key_id: keyId, environment: "production", connected_at: expect.any(String), mapping_state: "suspended" });
    expect((await send(await signed(pair, "DELETE", "/v1/installation", "", keyId))).status).toBe(200);
  });

  it("requires possession of the submitted public key before consuming a code", async () => {
    const code = await operator("enroll"), pair = await keyPair(), other = await keyPair();
    const wrongKey = Buffer.from(await crypto.subtle.exportKey("raw", other.publicKey)).toString("base64");
    expect((await enroll(code, pair, "installation-a", { public_key: wrongKey })).status).toBe(400);
    expect((await enroll(code, pair)).status).toBe(200);
  });

  it("fails closed when the rate counter or final replay database is unavailable", async () => {
    const pair = await keyPair();
    const { key_id: keyId } = await (await enroll(await operator("enroll"), pair)).json() as { key_id: string };
    const unavailable = {
      prepare: () => { throw new Error("private database diagnostic"); },
      batch: stage.databases.shared.batch.bind(stage.databases.shared),
    };
    const request = new Request("https://support.example/v1/enroll", {
      method: "POST", body: "{}", headers: { "CF-Connecting-IP": "192.0.2.1" },
    });
    const rateFailure = await handleRequest(request, unavailable, mappings);
    expect(rateFailure.status).toBe(503);
    expect(await rateFailure.text()).not.toContain("private database diagnostic");
    const db = stage.databases.shared;
    const failingReplay = {
      prepare: db.prepare.bind(db),
      batch: async <T>(statements: Parameters<typeof db.batch>[0]) => {
        // First batch is routine expiry cleanup; the next is authentication.
        if (statements.length === 2 && failNextBatch) throw new Error("replay store unavailable");
        failNextBatch = true;
        return db.batch<T>(statements);
      },
    };
    let failNextBatch = false;
    const response = await handleRequest(await signed(pair, "DELETE", "/v1/installation", "", keyId), failingReplay, mappings);
    expect(response.status).toBe(503);
    expect((await send(await signed(pair, "GET", "/v1/installation", "", keyId))).status).toBe(200);
  });

  it("bounds unknown-length bodies and requires TLS", async () => {
    const oversized = new Request("https://support.example/v1/enroll", {
      method: "POST", body: "x".repeat(8193), headers: { "CF-Connecting-IP": "192.0.2.1" },
    });
    expect((await send(oversized)).status).toBe(413);
    expect((await send(new Request("http://support.example/v1/installation"))).status).toBe(403);
    expect((await send(new Request("https://support.example/operator/revoke", { method: "POST" }))).status).toBe(404);
  });

  it("operator refuses unapproved Slots and keeps a key active if its external log fails", async () => {
    await expect(operator("enroll", "unapproved/production")).rejects.toThrow("Unknown Slot");
    const pair = await keyPair();
    const { key_id: keyId } = await (await enroll(await operator("enroll"), pair)).json() as { key_id: string };
    const query = async (sql: string, parameters: readonly (string | number)[]) =>
      (await stage.databases.shared.prepare(sql).bind(...parameters).all<Record<string, unknown>>()).results;
    await expect(runOperator(["revoke", "shop/production"], {
      query, mappings, recordRevocation: async () => { throw new Error("log unavailable"); },
    })).rejects.toThrow("log unavailable");
    expect((await send(await signed(pair, "GET", "/v1/installation", "", keyId))).status).toBe(200);
    const records: string[] = [];
    await runOperator(["revoke", "shop/production"], {
      query, mappings, recordRevocation: async (id) => { records.push(id); },
    });
    expect(records).toEqual([keyId]);
    expect((await send(await signed(pair, "GET", "/v1/installation", "", keyId))).status).toBe(403);
  });

});

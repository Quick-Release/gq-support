// Feasibility evidence for beta.83, NOT a deploy adapter or Test F.
// Every response is synthetic; no profile, key, state export or live API is read.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { makeHttpStateStore } from "alchemy/State/HttpStateStore";
import { exportState } from "alchemy/State/Export";
import { ResourceStateSchema } from "alchemy/State/HttpStateApi";
import * as Schema from "effect/Schema";
import { InMemoryService } from "alchemy/State/InMemoryState";
import { State } from "alchemy/State/State";
import type { CreatedResourceState } from "alchemy/State/ResourceState";

const target = { stack: "GQSupportWorker", stage: "prod" };
const record: CreatedResourceState = {
  resourceType: "Cloudflare.D1Database", namespace: undefined,
  fqn: "SupportDB", logicalId: "SupportDB", instanceId: "synthetic-instance",
  providerVersion: 1, status: "created", downstream: [], bindings: [],
  props: { jurisdiction: "eu" },
  attr: { databaseId: "synthetic-db", databaseName: "synthetic-name", jurisdiction: "eu" },
};

afterEach(() => vi.restoreAllMocks());

describe("native export is not an authoritative snapshot protocol", () => {
  it("wire ResourceStateSchema accepts objects without resource identity or status", () => {
    // beta.83 uses Schema.Any. A successful HTTP decode is not state validation.
    expect(Schema.is(ResourceStateSchema)({})).toBe(true);
    expect(Schema.is(ResourceStateSchema)({ status: "unknown" })).toBe(true);
  });

  it("silently omits a record that disappears between list and get", async () => {
    const memory = await Effect.runPromise(InMemoryService({ GQSupportWorker: { prod: { SupportDB: record } } }));
    // Simulate list/get racing with another writer or an unavailable record.
    const state = { ...memory, get: () => Effect.succeed(undefined) };
    const exported = await Effect.runPromise(exportState(target).pipe(
      Effect.provideService(State, Effect.succeed(state)),
    ));
    expect(exported.resources).toEqual([]);
  });

  it("does not export stack outputs even when they exist", async () => {
    const memory = await Effect.runPromise(InMemoryService(
      { GQSupportWorker: { prod: { SupportDB: record } } },
      { GQSupportWorker: { prod: { databaseId: "synthetic-db" } } },
    ));
    const getOutput = vi.fn(memory.getOutput);
    const exported = await Effect.runPromise(exportState(target).pipe(
      Effect.provideService(State, Effect.succeed({ ...memory, getOutput })),
    ));
    expect(exported.resources).toEqual([{ ...target, fqn: "SupportDB", state: record }]);
    expect(Object.keys(exported)).toEqual(["resources"]);
    expect(getOutput).not.toHaveBeenCalled();
  });

  it("accepts an empty unknown stage without establishing previous state", async () => {
    const memory = await Effect.runPromise(InMemoryService());
    const listStages = vi.fn(memory.listStages);
    const exported = await Effect.runPromise(exportState(target).pipe(
      Effect.provideService(State, Effect.succeed({ ...memory, listStages })),
    ));
    expect(exported.resources).toEqual([]);
    expect(listStages).not.toHaveBeenCalled();
  });
});

describe("explicit native HTTP client seam, without Cloudflare.state initialization", () => {
  it.each([200, 401, 403, 404, 429, 500, "malformed"] as const)(
    "read outcome %s never triggers credential recovery or mutations", async (outcome) => {
      // Catch bypasses of the injected client; no real network is permitted.
      const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network forbidden"));
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const requests: { method: string; path: string }[] = [];
      const client = HttpClient.make((request, url) => Effect.sync(() => {
        requests.push({ method: request.method, path: url.pathname });
        expect(url.origin).toBe("https://state.invalid");
        expect(request.method).toBe("GET");
        expect(request.headers.authorization).toBe("Bearer public-test-placeholder");
        return HttpClientResponse.fromWeb(request, new Response(
          outcome === "malformed" ? "not-json" : JSON.stringify(outcome === 200 ? record : {}),
          { status: outcome === "malformed" ? 200 : outcome, headers: { "content-type": "application/json" } },
        ));
      }));
      const result = await Effect.runPromise(Effect.gen(function* () {
        const state = yield* makeHttpStateStore({
          url: "https://state.invalid", authToken: "public-test-placeholder", id: "cloudflare-http",
        });
        return yield* state.get({ ...target, fqn: "SupportDB" }).pipe(Effect.result);
      }).pipe(Effect.provideService(HttpClient.HttpClient, client)));
      expect(result._tag).toBe(outcome === 200 ? "Success" : "Failure");
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every(({ method, path }) => method === "GET" && path ===
        "/state/stacks/GQSupportWorker/stages/prod/resources/SupportDB")).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    },
  );
});

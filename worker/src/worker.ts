import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as Result from "effect/Result";
import { handleRequest } from "./installation-api.ts";
import { repositoryMappings } from "./repository-mappings.ts";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { SupportDB } from "./support-db.ts";

export default Cloudflare.Worker(
  "Worker",
  { main: import.meta.url },
  Effect.gen(function* () {
    // Binds SupportDB. Routes reach Slot-owned records only through
    // createStorageFor (src/storage.ts), with the binding's `raw` database as `shared`.
    const database = yield* Cloudflare.D1.QueryDatabase(yield* SupportDB);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const web = HttpServerRequest.toWebResult(request);
        if (Result.isFailure(web)) return HttpServerResponse.empty({ status: 400 });
        const db = yield* database.raw;
        const response = yield* Effect.promise(() => handleRequest(web.success, db, repositoryMappings));
        return HttpServerResponse.fromWeb(response);
      }),
    };
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding)),
);

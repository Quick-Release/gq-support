import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { SupportDB } from "./support-db.ts";

export default Cloudflare.Worker(
  "Worker",
  { main: import.meta.url },
  Effect.gen(function* () {
    // Binds SupportDB. Routes reach Slot-owned records only through
    // createStorageFor (src/storage.ts), with the binding's `raw` database as `shared`.
    yield* Cloudflare.D1.QueryDatabase(yield* SupportDB);

    return {
      fetch: Effect.gen(function* () {
        yield* HttpServerRequest;
        return HttpServerResponse.text("gq-support-worker: no functionality yet");
      }),
    };
  }).pipe(Effect.provide(Cloudflare.D1.QueryDatabaseBinding)),
);

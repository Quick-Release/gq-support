import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import { SupportDB } from "./src/support-db.ts";
import Worker from "./src/worker.ts";

export default Alchemy.Stack(
  "GQSupportWorker",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const database = yield* SupportDB;
    const worker = yield* Worker;

    return {
      url: worker.url,
      // Recorded so a lost state store can adopt the database by name.
      databaseName: database.databaseName,
      databaseId: database.databaseId,
    };
  }),
);

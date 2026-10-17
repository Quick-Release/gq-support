import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { GitHubAppSecret, GitHubAppSecretProvider } from "./deploy/github-app-secret.ts";
import { appConfig, verifyApp } from "./deploy/github-app.ts";
import { SupportDB } from "./src/support-db.ts";
import Worker from "./src/worker.ts";

export default Alchemy.Stack(
  "GQSupportWorker",
  {
    providers: Layer.merge(Cloudflare.providers(), GitHubAppSecretProvider()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const stack = yield* Alchemy.Stack;
    if (stack.stage === "staging" || stack.stage === "prod") {
      // Read-only preflight before declaring any resources. Secret values stay
      // in this process, outside the resource graph and persisted plan/state.
      yield* Effect.tryPromise({
        try: () => verifyApp(appConfig(stack.stage, process.env), process.env.GITHUB_APP_PRIVATE_KEY ?? ""),
        catch: () => new Error("GitHub App preflight failed; see the key custody runbook"),
      }).pipe(Effect.orDie);
    }
    const database = yield* SupportDB;
    const worker = yield* Worker;
    if (stack.stage === "staging" || stack.stage === "prod") {
      yield* GitHubAppSecret("GitHubAppSecret", { stage: stack.stage, workerName: worker.workerName });
    }

    return {
      url: worker.url,
      // Recorded so a lost state store can adopt the database by name.
      databaseName: database.databaseName,
      databaseId: database.databaseId,
    };
  }),
);

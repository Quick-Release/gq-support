import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Output from "alchemy/Output";
import { GitHubAppSecret, GitHubAppSecretProvider } from "./deploy/github-app-secret.ts";
import { appConfig, verifyApp } from "./deploy/github-app.ts";
import { SupportDB, SupportLedger } from "./src/support-db.ts";
import Worker from "./src/worker.ts";
import { defaultDeploymentGuard, refusal } from "./deploy/planning-state.ts";
import { validateWebhookSecrets } from "./deploy/github-webhook-secrets.ts";

export interface PlanningDeclaration {
  readonly preflight: Effect.Effect<void>;
  readonly providers: Parameters<typeof Alchemy.Stack>[1]["providers"];
}

export const supportStack = (state: Parameters<typeof Alchemy.Stack>[1]["state"], purpose: "deployment" | "planning" = "deployment", planning?: PlanningDeclaration) => Alchemy.Stack(
  "GQSupportWorker",
  {
    providers: purpose === "deployment" ? Layer.merge(Cloudflare.providers(), GitHubAppSecretProvider()) : planning?.providers ?? Layer.effectDiscard(Effect.die(refusal())),
    state,
  },
  Effect.gen(function* () {
    const stack = yield* Alchemy.Stack;
    if (purpose === "deployment") yield* defaultDeploymentGuard(stack.stage);
    if (purpose === "planning") {
      if (!planning) return yield* Effect.die(refusal());
      yield* planning.preflight;
    }
    if (purpose === "deployment" && (stack.stage === "staging" || stack.stage === "prod")) {
      // Read-only preflight before declaring any resources. Secret values stay
      // in this process, outside the resource graph and persisted plan/state.
      yield* Effect.tryPromise({
        try: async () => {
          const app = await verifyApp(appConfig(stack.stage, process.env), process.env.GITHUB_APP_PRIVATE_KEY ?? "");
          validateWebhookSecrets(process.env, app.appId);
        },
        catch: () => new Error("GitHub App preflight failed; see the key custody runbook"),
      }).pipe(Effect.orDie);
    }
    const database = yield* SupportDB;
    const ledger = yield* SupportLedger;
    const worker = yield* Worker;
    if (stack.stage === "staging" || stack.stage === "prod") {
      // workerName is a stable attribute, which Alchemy can resolve before a
      // script update finishes. Resolve the whole Worker first to retain the
      // apply dependency, then project only its public name into secret props.
      yield* GitHubAppSecret("GitHubAppSecret", {
        stage: stack.stage,
        workerName: Output.map(Output.of(worker), (attributes) => attributes.workerName),
      });
    }

    return {
      url: worker.url,
      workerName: worker.workerName,
      // Recorded so a lost state store can adopt the database by name.
      databaseName: database.databaseName,
      databaseId: database.databaseId,
      ledgerDatabaseName: ledger.databaseName,
      ledgerDatabaseId: ledger.databaseId,
    };
  }),
);



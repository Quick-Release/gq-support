import { provisionDiscordAlertSecret } from "./discord-alert-secret.ts";
import { Resource } from "alchemy/Resource";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { provisionAppKey } from "./github-app.ts";
import { provisionWebhookSecrets } from "./github-webhook-secrets.ts";
import { checkDeployedGitHubApp, DeployedGitHubAppCheckError } from "./check-deployed-github-app.ts";

type GitHubAppSecret = Resource<
  "GQSupport.GitHubAppSecret",
  { stage: string; workerName: string },
  Awaited<ReturnType<typeof provisionAppKey>> & { appId: number; checkedAt: string }
>;

export const GitHubAppSecret = Resource<GitHubAppSecret>("GQSupport.GitHubAppSecret");

export const GitHubAppSecretProvider = () => Provider.succeed(GitHubAppSecret, {
  // Worker uploads can drop out-of-band secrets. Reapply after the Worker on
  // every deploy, including no-op code deployments and rotations.
  diff: () => Effect.succeed({ action: "update" }),
  reconcile: ({ news }) => Effect.tryPromise({
    try: async () => {
      const metadata = await provisionAppKey(news.stage, news.workerName);
      await provisionWebhookSecrets(news.workerName, metadata.appId);
      await provisionDiscordAlertSecret(news.workerName);
      const evidence = await checkDeployedGitHubApp(metadata, news.workerName);
      return { ...metadata, ...evidence };
    },
    catch: (error) => error instanceof DeployedGitHubAppCheckError
      ? error : new Error("GitHub App secret provisioning failed; see the key custody runbook"),
  }),
  // The owning Worker deletes its bindings when it is destroyed.
  delete: () => Effect.void,
});

import { Resource } from "alchemy/Resource";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import { provisionAppKey } from "./github-app.ts";
import { provisionWebhookSecrets } from "./github-webhook-secrets.ts";
import { checkDeployedGitHubApp, DeployedGitHubAppCheckError } from "./check-deployed-github-app.ts";
import { provisionDiscordAlertSecret } from "./discord-alert-secret.ts";

type GitHubAppSecret = Resource<
  "GQSupport.GitHubAppSecret",
  { stage: string; workerName: string },
  Awaited<ReturnType<typeof provisionAppKey>> & { appId: number; checkedAt: string }
>;

export const GitHubAppSecret = Resource<GitHubAppSecret>("GQSupport.GitHubAppSecret");

export interface AppSecretCustody {
  provisionKey: typeof provisionAppKey;
  provisionWebhook: typeof provisionWebhookSecrets;
  check: typeof checkDeployedGitHubApp;
}
export const GitHubAppSecretProvider = (custody: AppSecretCustody = {
  provisionKey: provisionAppKey,
  provisionWebhook: async (worker, appId) => {
    await provisionWebhookSecrets(worker, appId);
    await provisionDiscordAlertSecret(worker);
  },
  check: checkDeployedGitHubApp,
}) => Provider.succeed(GitHubAppSecret, {
  // Worker uploads can drop out-of-band secrets. Reapply after the Worker on
  // every deploy, including no-op code deployments and rotations.
  diff: () => Effect.succeed({ action: "update" }),
  reconcile: ({ news }) => Effect.tryPromise({
    try: async () => {
      const metadata = await custody.provisionKey(news.stage, news.workerName);
      await custody.provisionWebhook(news.workerName, metadata.appId);
      const evidence = await custody.check(metadata, news.workerName);
      return { ...metadata, ...evidence };
    },
    catch: (error) => error instanceof DeployedGitHubAppCheckError
      ? error : new Error("GitHub App secret provisioning failed; see the key custody runbook"),
  }),
  // The owning Worker deletes its bindings when it is destroyed.
  delete: () => Effect.void,
});

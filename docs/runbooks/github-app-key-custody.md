# GitHub App registration and key custody

Implements the repository portion of [#36](https://github.com/Quick-Release/gq-support/issues/36).
The [GitHub integration research](../research/github-app-issue-integration.md)
defines permissions, lifecycle events and the later gateway behavior.

**Live status (2026-10-17): both Apps registered, stage CI sources configured,
and staging App-key replacement/revocation verified.** The evidence record below
distinguishes that authentication rehearsal from the still-pending deployed
Worker rehearsal. No Cloudflare deployment or installation is asserted. Complete
the evidence checklist before closing #36. Gateway runtime authentication and
token caching belong to #37; the webhook receiver belongs to #12.

## Registration

1. Sign in as a GETQUICK organization owner or App manager. GETQUICK's GitHub
   login is **Quick-Release**. Open
   [organization GitHub Apps](https://github.com/organizations/Quick-Release/settings/apps)
   → New GitHub App. Create **two separate registrations**:
   `GETQUICK Support Staging` (slug `getquick-support-staging`) and
   `GETQUICK Support` (slug `getquick-support`). These exact stage slugs are
   pinned in `worker/deploy/github-app.ts`. If unavailable, agree replacement
   names and update that policy before provisioning; never reuse one App for both.
2. Homepage: `https://github.com/Quick-Release`. Leave Callback URL, Setup URL,
   OAuth during installation and Device Flow unused. The service acts as the App,
   never on behalf of a Developer.
3. Repository permissions: **Issues: Read & write** and **Metadata: Read-only**.
   Every other repository, organization and account permission stays No access.
   Subscribe to **Issues**, **Public**, **Repository** and **Installation target**
   (account renames, selectable in the live UI). Never select **Issue comment**.
   GitHub sends `installation` and
   `installation_repositories` automatically. `GET /app` reports the three
   repository subscriptions but not the integrator-level Installation target
   selection; audit that selection in App settings separately.
4. Register with webhook **Active unchecked** while no verified receiver exists.
   Set the deliberately non-resolving placeholder
   `https://github-webhook.invalid/v1/github/webhooks` so GitHub retains a hook
   configuration and its event subscriptions. With an empty URL, the live UI
   discarded subscriptions on subsequent permission saves. This reserved
   `.invalid` address is not a service origin and must never be activated. Enabling
   delivery is a rollout gate: #12 must supply the stage's HTTPS receiver, signature
   validation and per-stage webhook secret. Replace the placeholder with that
   real receiver, then enable Active, keep TLS
   verification on and verify the event selection again. A disabled webhook is
   not evidence of a completed webhook rollout.
5. Choose **Only on this account** for the current GETQUICK-owned repositories.
   Client-owned repository installations would require a reviewed registration
   change to Any account. Install staging on selected private sandbox repositories
   only. Install production on approved Project repositories only, never All
   repositories. Record each numeric installation ID and repository ID in the
   approved Repository mapping process; registration alone grants no Slot access.
6. Record each App ID, client ID, slug and organization in the non-secret evidence
   record. In App settings → Credentials → Key pairs → New key, download one
   private key. Compare its public fingerprint with GitHub before storing it:

   ```sh
   openssl rsa -in "$downloaded_key" -pubout -outform DER |
     openssl sha256 -binary | openssl base64
   ```

The registration UI and key-pair labels above follow the current
[registration documentation](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)
and [key management documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps).
The [event reference](https://docs.github.com/en/webhooks/webhook-events-and-payloads)
documents the automatically delivered installation events.

## Secret source and conversion

Create GitHub Environments **staging** and **prod** in this repository's Settings
→ Environments. Restrict deployment branches to main; configure production
reviewers according to operator policy. Each environment owns its own encrypted
`SUPPORT_GITHUB_APP_PRIVATE_KEY` secret and public `SUPPORT_GITHUB_APP_CLIENT_ID` and
`SUPPORT_GITHUB_APP_SLUG` variables. Each also needs the scoped `CLOUDFLARE_API_TOKEN`
from the credential process in [worker/README.md](../../worker/README.md).
GitHub reserves the `GITHUB_` prefix for secret and variable names, so the
workflow maps these `SUPPORT_` source names into the deployment process
`GITHUB_APP_*` environment variables. The Worker binding remains
`GITHUB_APP_PRIVATE_KEY`. The workflow pins the Tipme account `8f38791a8c37b182239af2a385ab3c31`.
Never create a repository-wide fallback App key or put either key in Sigillo's
shared dev environment. GitHub's encrypted environment secret is the deployment
source of record; the stage Worker is the only runtime custodian.

Convert GitHub's PKCS#1 download **once**, directly into the intended encrypted
environment secret. Run on a trusted workstation with tracing disabled. Set
`downloaded_key` to the downloaded file path; its value is a path, not a secret.
Do not redirect the converted output into a file, terminal, chat or CI output.

```sh
set +x
set -o pipefail
openssl pkcs8 -topk8 -nocrypt -in "$downloaded_key" |
  gh secret set SUPPORT_GITHUB_APP_PRIVATE_KEY --repo Quick-Release/gq-support --env staging
```

Use `--env prod` only for the independently generated production key. Set the
public variables through `gh variable set --env <stage>` or the environment UI.
After successful secret intake and fingerprint comparison, remove the download
and any browser/download-sync/trash copies. Do not claim secure deletion on SSDs;
rotate/revoke a key if its download path was backed up or shared inadvertently.
Retain no PEM fixtures, `.env` files or reusable workstation copies.

`node worker/scripts/verify-github-app.ts staging` (run from the repo root with
the intended environment injected) imports PKCS#8 with Web Crypto as a
non-extractable RS256 signing key, signs a short-lived JWT and calls `GET /app`.
It checks the client ID, pinned slug, organization owner, exact two permissions
and exact API-reported repository event list. Its only output is public stage, client ID,
slug and SHA-256 SPKI fingerprint. Missing, extra or changed grants fail closed.
This preflight also runs in CI and inside the Alchemy declaration before any
resource apply. It never mints an installation token or creates an issue.

## Alchemy and CI custody

Run **Deploy Support Worker** manually on **main**, choosing staging or prod.
The workflow runs typecheck and tests before exposing any App secret. Its final
step receives only the selected GitHub Environment's credentials. It verifies
the App, then invokes the pinned Alchemy deployment. Deployments to a stage are
serialized and are not automatically cancelled. Do not run deployment jobs with
Actions debug logging, shell tracing or Alchemy trace/debug logging enabled.

The pinned Alchemy `2.0.0-beta.83` serializes `Redacted` contents in its state
encoding (`src/State/StateEncoding.ts` in the installed package). Consequently,
**do not use `Config.Redacted`, `Worker.env`, an Output or resource properties
to pass the App private key**. Redaction of display output alone is insufficient.

`worker/deploy/github-app-secret.ts` is an apply-only Alchemy provider. Its
properties are stage and the owning Worker's resolved script name. On apply it
reads the CI environment in memory, verifies the registration again, and uses
the [Worker secret API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/update/)
to upload `GITHUB_APP_PRIVATE_KEY` as `secret_text`. Only public metadata and
the public fingerprint, App ID and check timestamp are returned to state. Raw provider/transport/crypto
errors are replaced without retaining their cause. No private key, JWT or
Cloudflare token is in resource inputs, outputs, bundles, logs or artifacts.
These deployment modules are outside the Worker runtime import graph.

After upload, Alchemy calls `checkGitHubAppKey` over an authenticated Cloudflare
remote service binding. The deployed Worker imports its own PKCS#8 secret as a
non-extractable signing key, signs a fresh JWT and calls `GET /app`. It returns
only public App identity and the bound key's SPKI fingerprint, or a generic
failure. Alchemy compares this fingerprint with the intended CI key before
recording success. The method has no HTTP route,
never mints an installation token, never accesses D1 and does not cache an
access token. The temporary remote-binding proxy holds a service reference,
not the App key. This verifies the #36 custody boundary independently of the
later #37 gateway and its repository-scoped token behavior.

The final CI audit reads state records (including replaced resources) through
Alchemy's authenticated state service. It re-encodes any redacted wrappers to
inspect their actual contents in memory, rather than their display placeholders.
It checks deployed binding metadata for `secret_text`, and scans the deployed
bundle, checkout and local Alchemy/Wrangler logs for the current PEM/DER bytes.
State and binding contents stay in memory; only counts and a public fingerprint
are printed. No artifacts containing state, bundles or credentials are uploaded.

The resource depends on the Worker and reconciles on **every** durable-stage
deploy, even with unchanged code. Alchemy's script upload may remove an existing
out-of-band secret; the resource reapplies it afterwards. This creates a possible
short authentication outage during deployment. A failed apply is not a successful
deployment: retry the full workflow with the intended key. Never retry an issue
mutation to compensate for deployment failure. The gateway must fail closed on a
missing key. Seamless secret retention/atomic rollout must be checked before any
zero-downtime production claim. Do not use `--exclude GitHubAppSecret`, partial
Worker deploys, or other upload tools on these stages.

For local development, use an unprivileged `dev_<user>` stage; no App key is
bound. Live staging/prod applies require CI environment injection, including the
Cloudflare token; the machine-local Alchemy profile alone is insufficient.
The webhook secret will require equivalent custody when #12 introduces it; it
is not provisioned by this key-only resource.

## Rotation and staging rehearsal

GitHub supports overlapping keys; keys do not expire automatically.

1. Record stage, App/client ID, old public fingerprint and change owner. Confirm
   a successful CI deployment with the old key, including the deployed service
   check and custody audit. Generate a second key in that same App, leaving the
   old key valid.
2. Compare the new fingerprint in GitHub, convert once into the same stage's
   encrypted environment secret, remove the download and run the deployment
   workflow. Save its URL and new public fingerprint, never a JWT or token.
3. Confirm the deployment's service-binding check succeeds with the replacement
   and the custody audit reports its expected public fingerprint. Each check
   signs afresh inside the deployed Worker, so cached tokens cannot satisfy it.
4. Delete the old key in App settings → Credentials → Key pairs. Run the same
   workflow again without changing code. Confirm the deployed signing check and
   custody audit still pass after old-key revocation. Check Worker error rates
   and pending deliveries without logging request bodies or tokens. Record the
   revocation timestamp and the post-revocation CI URL. Production rotation
   follows only after this sequence has passed on staging.
5. Before old-key deletion, rollback can restore the previous CI secret only
   from an approved encrypted recovery source; do not keep a local spare PEM.
   Otherwise generate another App key and roll forward. After deletion, roll
   forward with another new key; deleted keys cannot be restored.

The local tests prove PKCS#8 import, RS256 signing, registration-drift denial,
stage isolation, secret upload and sanitized failure behavior. They are not a
substitute for this staging rehearsal.

## Suspected key compromise

1. Stop affected-stage deployment and delivery, suspend its Repository mappings
   and alert the Operator through the established incident process. Preserve
   only public identifiers, timestamps and sanitized classes of failure.
2. Generate a replacement key and delete the compromised key promptly in GitHub;
   do not wait for a graceful rollout if abuse is suspected. Replace the stage
   CI secret and redeploy; clear/recycle gateway token caches. Deleting an App
   key must not be treated as proof all previously minted installation tokens
   are invalid. Revoke known installation tokens (`DELETE /installation/token`)
   or suspend/uninstall the affected installation for containment. Follow
   [GitHub's token revocation guidance](https://docs.github.com/en/rest/apps/installations#revoke-an-installation-access-token).
3. Inspect App installations, repository selection, issue mutations and audit
   history since the earliest possible exposure. Check CI access, artifacts,
   downloads, Alchemy state and backups for unexpected copies. Rotate the
   Cloudflare deployment credential or webhook secret too if exposed.
4. Reconcile uncertain creates through the delivery process; do not recreate
   issues blindly. Resume mappings only after Operator review, fresh signing
   and scoped-token checks and verified containment. Record residual uncertainty.

## Installation removal or repository access removal

Suspend every affected Repository mapping immediately; revoke its WordPress
installation credentials when offboarding is intended. Clear associated token
caches and stop new GitHub writes. Existing Reporter projections keep last-known
status; removal is not erasure or permission to delete GitHub issues. The
webhook receiver (#12) handles `installation.deleted`/`suspend` and
`installation_repositories.removed`; the gateway must independently deny lost
access when a webhook is missed. Reinstallation does not automatically resume
mappings: an Operator verifies the new numeric installation/repository identity,
permissions and private-only access first. Removing one installation does not
require rotating an uncompromised App key or interrupting other installations.

## Completion evidence for #36

Append a dated non-secret record to this runbook or the issue with:

- Both organization-owned registrations: App IDs, client IDs, slugs, installation
  IDs, selected sandbox/production repository IDs and registration audit result.
- Each stage's successful deployment URL, Worker name, account ID and public key
  fingerprint. Confirm the stages use distinct registrations and key pairs.
- Custody inspection of runtime bindings, CI logs/artifacts, deployed bundles and
  Alchemy state showing no PEM/JWT/token copies outside encrypted CI source and
  the intended Worker secret. Do not dump bindings or state into issue comments.
- The staging rotation's old/new fingerprints, deployment URLs, fresh-isolate
  signing-check successes before and after old-key deletion, and revocation
  timestamp. Receiver activation and #37's scoped-token tests remain separately
  owned follow-ups; no repository installation is needed for this key-only check.

Until that evidence exists, #36 remains open and its live acceptance is unmet.

## Live evidence — 2026-10-17

Registered in organization **Quick-Release** (GETQUICK), installation visibility
Only on this account:

- Staging: [getquick-support-staging](https://github.com/organizations/Quick-Release/settings/apps/getquick-support-staging),
  App ID `5355960`, client ID `Iv23lixWCFIzi40FrBkn`.
- Production: [getquick-support](https://github.com/organizations/Quick-Release/settings/apps/getquick-support),
  App ID `5355963`, client ID `Iv23liPv69KLeIeXIBxB`.

Both public App API responses report exactly Issues write, Metadata read and
`issues`, `public`, `repository` subscriptions. Installation target selection is
confirmed separately in the settings UI. Delivery remains inactive with the
reserved `.invalid` placeholder. No App is installed yet: there are no approved
Repository mappings in the current registry, so no installation IDs are recorded.

Both encrypted environments exist with main-only branch policies. Each contains
`SUPPORT_GITHUB_APP_PRIVATE_KEY` and the existing scoped `CLOUDFLARE_API_TOKEN`,
plus public `SUPPORT_GITHUB_APP_CLIENT_ID` and `SUPPORT_GITHUB_APP_SLUG` variables.
No repository-wide App key or OAuth client secret was created. All three
downloaded PKCS#1 PEM files (initial staging, production, replacement staging)
were removed after conversion/intake and verification; no converted PEM file
was written. Live App keys and JWTs were never printed or passed as command
arguments. Public SPKI fingerprints matched GitHub's key-pair display.

Staging authentication rehearsal:

1. Initial key fingerprint `4vzGzLgFzxpGuF75AJ0oUQKIhk5uD5zaZ7DfYo5Wns8=`
   passed Web Crypto PKCS#8 import and live JWT authentication to `GET /app`.
2. Generated replacement key `4GzKGdCua9winP33o6tC1KVBLi4DJqjScEhPy1OaSMU=`;
   verified live App authentication and replaced only the staging encrypted key
   source while the old key was still valid.
3. Deleted old GitHub key pair `4904166`. Confirmed the key-pair page retained
   only replacement pair `4904209`. A fresh signing process authenticated with
   the replacement after revocation at **2026-10-17 09:15:53 UTC**.

Production's distinct key fingerprint is
`vPYAL+0JV1iR7X+XuPT6EyV7hlQVLm9sYoLq5AZFQ1k=`; it also passed PKCS#8 import
and live App authentication. No production key rotation or deployment was run.

Staging deployment and custody verification passed in
[CI run 39025087020](https://github.com/Quick-Release/gq-support/actions/runs/39025087020)
at **2026-10-17 10:31:12 UTC**, from commit `e96ad95`:

- Tipme account `8f38791a8c37b182239af2a385ab3c31`, Worker
  `gqsupportworker-worker-staging-fzos3ewkrboeduj2`,
  [deployed URL](https://gqsupportworker-worker-staging-fzos3ewkrboeduj2.tipme.workers.dev).
- Worker-side fresh JWT authentication and fingerprint comparison passed for
  `4GzKGdCua9winP33o6tC1KVBLi4DJqjScEhPy1OaSMU=`.
- The audit confirmed `secret_text` custody and inspected five state entries,
  421 checkout/log files, binding metadata and the deployed bundle without
  finding key material outside the intended secret. No state/bundle artifacts
  were uploaded.
- Typechecking and all 165 tests passed. Native Workers-runtime regression
  coverage verifies that redirect responses cannot forward the App JWT.

Deployed staging rotation completed on **2026-10-17**:

1. Generated replacement pair `4905670`, fingerprint
   `2QVuwBptUqruWP2BGiHR/XpPwvpkOmR7lZKHodAH+8k=`. Converted PKCS#1 to
   PKCS#8 in memory, verified import/live App authentication and the public
   fingerprint, updated only the staging encrypted CI source, then removed the
   downloaded PEM. No converted file was written.
2. [Pre-revocation deployment 39031794586](https://github.com/Quick-Release/gq-support/actions/runs/39031794586)
   passed Worker-side fresh signing, fingerprint comparison and custody audit
   at **12:17:03 UTC** while old pair `4904209` remained valid.
3. Deleted old pair `4904209`; at **12:17:53 UTC**, the settings page confirmed
   only replacement pair `4905670` remained.
4. [Post-revocation deployment 39031967179, attempt 2](https://github.com/Quick-Release/gq-support/actions/runs/39031967179/attempts/2)
   passed fresh Worker signing, the same replacement fingerprint and custody
   audit at **12:21:47 UTC**. Both successful rotation runs inspected five state
   entries and 421 files and uploaded zero artifacts. All 165 tests and
   typechecking passed. Attempt 1 stopped before deployment on a quota-test 503;
   the unchanged retry passed the full suite.

The registration, custody and staging rotation acceptance for #36 is complete.
Repository installation and scoped-token behavior belong to #37; receiver
activation belongs to #12; production rollout remains gated by #20.

# GETQUICK Support

WordPress plugin that adds an in-dashboard support widget. Authenticated
Reporters submit support requests and view the submitted text and status in
WordPress; issues are stored in the connected project GitHub repository.

No functionality is implemented yet — this is a scaffold.

## Install the plugin with Composer

The public repository publishes flattened plugin release artifacts from the
`v*` tags, so Composer installs the plugin from its correct WordPress package
root instead of the monorepo’s `plugin/` directory.

In a client project that uses Composer and `composer/installers`:

```sh
composer require getquick/gq-support
```

For a Bedrock-style project, make sure its root `composer.json` includes the
plugin install path and allows the Composer installer plugin:

```json
{
  "extra": {
    "installer-paths": {
      "web/app/plugins/{$name}/": ["type:wordpress-plugin"]
    }
  },
  "config": {
    "allow-plugins": {
      "composer/installers": true
    }
  }
}
```

GETQUICK sites install it from the GETQUICK Composer registry, which builds
every `v*` release tag (see
[getquick-registry](https://github.com/Quick-Release/getquick-registry)'s
`docs/clients.md` for giving a site access):

```json
{
  "repositories": [
    { "type": "composer", "url": "https://proxy.composer.getquick.io" }
  ],
  "require": {
    "getquick/gq-support": "^0.1.0"
  }
}
```

The public GitHub repository also works as a `vcs` repository. Run
`composer update` after adding the repository. Composer’s package installer
places the plugin at `wp-content/plugins/gq-support/` by default, or at the
Bedrock path shown above.

### Registry rebuilds and token rotation

Pushing a `v*` tag sends a `plugin_updated` repository dispatch to
`Quick-Release/getquick-registry` with package `getquick/gq-support` and the tag
as `client_payload.ref`. This starts its **Deploy Registry** workflow without
waiting for the hourly build. Dispatch failures fail the notification job.

The release workflow runs on `plugin-v*` tags. After its installed-package gates
and package publishing succeed, its final job dispatches with the resulting `v*`
package tag. This explicit call is necessary because the release workflow
pushes that tag with `GITHUB_TOKEN`, which does not trigger push workflows.
Branches, pull requests, and manual release runs do not send a dispatch.

Dispatch authentication uses the organisation Actions secret
`REGISTRY_DISPATCH_TOKEN`. It must be available to `Quick-Release/gq-support`;
its value is a fine-grained personal access token with resource owner `Quick-Release`,
limited to the `getquick-registry` repository with **Contents: read and write**.

To rotate it:

1. Create a replacement fine-grained token in GitHub's **Settings → Developer
   settings → Personal access tokens → Fine-grained tokens**, using
   `Quick-Release` as the resource owner, selecting only `getquick-registry`,
   and granting **Contents: read and write**. Set an expiration and obtain
   organisation approval if required.
2. In **Quick-Release → Settings → Secrets and variables → Actions**, update
   the organisation secret `REGISTRY_DISPATCH_TOKEN` with the new token. Keep
   `gq-support` in its repository access list and preserve access for any
   other repositories using the secret.
3. Re-run a failed tag notification job, or verify the next tag release sends
   the dispatch and starts **Deploy Registry** in `getquick-registry`. Once
   verified, revoke the old token in its owner's personal access token settings.

## Layout

- `plugin/` — the WordPress plugin. `plugin/gq-support.php` is the main plugin
  file installed into WordPress.
- `plugin/app/` — the support app, using WordPress's React and REST packages.
  `@wordpress/scripts` builds it into `plugin/assets/dist/` and emits the
  dependency manifest for WordPress script loading.
- `worker/` — a Cloudflare Worker backend, provisioned with
  [Alchemy](https://alchemy.run) and written with
  [Effect](https://effect.website). Currently a placeholder with no routes.

## Local WordPress playground

This repository lives next to `../playground`, our shared Bedrock/DDEV test site.
See [the playground guide](../playground/README.md) for resets and isolated tests.

```sh
pnpm wp:start                # starts the site and updates stable dependencies
pnpm wp:open                 # https://gq-wp-playground.ddev.site
pnpm wp plugin activate gq-design
pnpm wp plugin activate gq-support
pnpm wp:test                # resets the playground, then checks this plugin
```

Support requires the `gq-design` plugin (Composer package `getquick/gq-design`).
`getquick-options` is gq-config's admin page slug, not a plugin slug.
The local WordPress admin is `dev` / `dev`.
The playground symlinks `plugin/`;
build the widget before testing. Worker services are still developed separately.

## Development

```sh
pnpm install

# build the WordPress-native support app assets
pnpm build:app

# run the Cloudflare worker locally
pnpm dev:worker

# deploy the Cloudflare worker
pnpm deploy:worker
```

### Continuous integration

`.github/workflows/ci.yml` runs on every pull request and `main` push. Its `Required validation` job is the one check `main` should require. It always runs, and fails when a required job failed, was cancelled, or was skipped although the change affects its suite. The plan job decides which suites (`lint`, `php`, `size`, `wordpress`, `worker`) a change affects with `scripts/ci/affected-suites.mjs`. The dependency audit and the secret scan are not suites: they run on every change.

- Documentation-only changes skip every suite and still report success once the audit and the secret scan pass.
- `contract/**` and both signing implementations run the WordPress and Worker suites.
- The root toolchain, `scripts/ci/`, the runtime matrix and the CI workflows run every suite.
- A path no rule classifies runs every suite.

Supported runtimes live in `.github/runtime-matrix.json`: WordPress 6.5 and PHP 8.0 minimums, PHP up to 8.4, `Tested up to` 7.1. Each cell pins exact WordPress, PHP, WooCommerce and Plugin Check versions and, at the oldest and current endpoints, the React that WordPress registers. Pull requests run WordPress 6.5.0 on PHP 8.0 and 7.1.3 on PHP 8.4, each single site then multisite, plus the counter gate at both endpoints, 6.5.13 on PHP 8.2, integration on PHP 8.1–8.3 and the real GETQUICK Design cell. Every cell records its actual runtime in a `runtime-<cell>` artifact and fails if that differs from the cell; `Required validation` joins them into `resolved-runtime-matrix`.

`.github/workflows/compatibility.yml` runs nightly cells: the previous WordPress minor, MySQL 8.0 and MariaDB 10.11, a persistent object cache, subdomain multisite, Firefox and WebKit. It also runs nonblocking canaries (WordPress nightly, PHP 8.5, floating latest releases) and a discovery job that fails when upstream releases overtake a pin. A failed canary or discovery job turns the nightly run red so it gets noticed, but `Compatibility result` ignores it. A release runs every pull-request and nightly cell before publishing; canaries never block.

#### Real GETQUICK Design cell

Every cell but one uses the one-line GETQUICK Design fixture that `run.sh` writes. The `real-design` pull-request cell (WordPress 7.1.3, PHP 8.4, the Chromium acceptance suite) instead installs the GETQUICK Design release its `gqDesign` field pins. `scripts/ci/install-gq-design.sh` installs it like a Bedrock site does: Composer from the private registry through `https://proxy.composer.getquick.io`, then the Composer autoloader as a must-use plugin. The cell's runtime report fails unless that release ran with its classes loaded. `runtime-matrix.mjs policy` fails when no pull-request browser cell pins an exact release. To move the pin, change `gqDesign` in a reviewed PR; the release must exist in the registry.

The registry login is the `COMPOSER_AUTH` secret of the `gq-design-sandbox` GitHub environment. It is a read-only proxy login of its own, revocable without touching any site. Only the cell's install step reads it; the cell itself runs without it. Callers of `wordpress-lane.yml` pass the secret by name, because GitHub resolves an environment secret in a reusable workflow only when its caller passes it; the value still comes only from the lane job's environment. `scripts/ci/workflow-policy.mjs` fails when pull-request code reads a secret in a job without an environment, other than passing it by name to a local reusable workflow, or uses `secrets: inherit`. Pull requests from forks never receive the secret, so their `real-design` cell fails and `Required validation` fails with it: to validate a fork's change, a maintainer pushes its branch to this repository. Every branch pushed to this repository can read the login, which is the accepted cost of a required cell: it grants read access to the registry's packages and nothing else. This is the one exception to the research's credential-free pull-request tests (`docs/research/ci-compatibility-and-security-tests.md`), decided in #85.

To provision or rotate the login, run in a `getquick-registry` checkout:

1. `pnpm registry client add gq-support-ci --project <a Sigillo project for this CI login>`. This stores the login as `COMPOSER_AUTH` in that project.
2. Create the `gq-support` environment `gq-design-sandbox` with no deployment branch rule: pull-request runs need it, and forks receive none of its secrets anyway.
3. Copy that `COMPOSER_AUTH` value into the environment's `COMPOSER_AUTH` secret. Don't add it as a repository secret.

To run the cell locally, export the same `COMPOSER_AUTH` and run `scripts/ci/run-cell.sh real-design`.

- To update a pin or widen support, change `.github/runtime-matrix.json` and the plugin headers in one reviewed PR. `node scripts/ci/runtime-matrix.mjs policy` fails when the headers, Composer, PHPCS or PHPStan ranges differ from the cells that execute them. Widening the PHPStan range is not enough on its own: a pull-request cell must run that PHP version.
- To run one cell locally, use `scripts/ci/run-cell.sh <cell-id>` on a fresh site, because WordPress and database versions are fixed when the site is created. Set `GQ_SUPPORT_TEST_URL` when the DDEV project has another name. Run the CI script tests with `pnpm test:ci`.
- To check that `Required validation` fails on each case, run CI manually with `simulate` set to `failure`, `cancelled` or `unexpected-skip`. Manual runs need `ci.yml` on `main`.

While the `Protect main` ruleset still requires `Asset size gate`, `PHP result` and `Worker result`, `ci.yml` keeps the size job's name and emits the other two from `Required validation`. To switch the ruleset over:

1. Merge to `main`.
2. Run the three simulations and confirm that `Required validation` fails in each.
3. Confirm that a documentation-only PR passes.
4. Make `Required validation` the ruleset's only required status check.
5. Delete the `php-result` and `worker-result` jobs.

### Release candidate and installed-package gates

`.github/workflows/release-plugin.yml` builds the plugin once from the frozen lockfiles, assembles it once and packs it into `gq-support.zip` with `scripts/ci/release-package.mjs`. Packing verifies the archive and refuses it unless all of the following hold:

- The archive has one `gq-support/` root and no absolute paths, traversal entries, symlinks or duplicate entries.
- It contains exactly the expected runtime files: the main plugin file, `uninstall.php`, the readme, `composer.json`, every class the shipped PHP uses, the launcher, the built LTR and RTL assets, `index.asset.php`, and a `.mo` file and app JSON for each locale.
- It contains no tests, sources, `node_modules`, `vendor`, tooling, logs, source maps or credential files, and the secret scan finds nothing.
- The plugin header, `GQ_SUPPORT_VERSION` and `Stable tag` equal the requested version. The header and readme agree on `Requires at least` and `Requires PHP`.
- `index.asset.php` depends on `wp-element` and not on `react-jsx-runtime`.
- `composer.json` is a `wordpress-plugin` with `installer-name` `gq-support`. Its only runtime dependency is `composer/installers`, which the consuming project resolves, so the package ships no `vendor` directory.

Packing records the archive's SHA-256 and a manifest with each file's digest. The artifact also keeps `provenance.json`: the commit, lockfile digests and toolchain.

Two jobs use the candidate:

- Read-only cells install it with WP-CLI's `wp plugin install` and nothing else. The cells run WordPress 6.5.0 on PHP 8.0 and 7.1.3 on PHP 8.4, each as acceptance and as the counter gate. Each cell checks the archive's digest first. It then checks that the installed directory is the extracted archive, file for file, and not a link to the source. After that it runs the lifecycle with GETQUICK Design absent and present, the browser suite or counters, and site-local then network activation on multisite. The stable cell also runs Plugin Check. `plugin/tests/integration/package.sh` adds these checks:
  - A direct request to `uninstall.php` does nothing.
  - A real uninstall removes only plugin-owned options, Administrator grants and Reporter subjects. It keeps a custom role's grant, unrelated options, user meta and scheduled events.
  - The previous release, which is the composer tree behind the highest earlier `v*` tag, upgrades to the candidate through the package installer without an activation call. The upgrade keeps the installation identity, signing key, Reporter subjects and a deliberately revoked capability, and it makes no remote call.
  - On multisite, a network uninstall cleans only the main site. Another site keeps its own rows until that site is deleted.
- `publish` has the only write token. It refuses an archive whose bytes differ from the SHA-256 that the candidate job recorded as its output, then unpacks exactly the manifest's files and publishes that tree to the `composer` branch and the `v*` tag. Nothing is rebuilt between verification and publication. The commit and tag record the archive's SHA-256.

To run one cell on a packed ZIP locally, use `scripts/assemble-plugin-package.sh package-dist`, then `node scripts/ci/release-package.mjs pack package-dist package-zip`, then `GQ_SUPPORT_PLUGIN_ZIP=package-zip/gq-support.zip scripts/ci/run-cell.sh <cell-id>` on a fresh site.

Cells still use the GETQUICK Design fixture rather than the real private release. Release authorization stays with the rollout decision in #20.

### Lint, dependency audit and secret scan

These gates feed `Required validation` like the suites above. None of them needs a credential.

- **JS/TS lint** (`lint` suite, `pnpm lint:js`). The Reporter app uses the WordPress configuration that `wp-scripts lint-js` applies by default, in `plugin/app/eslint.config.cjs`. Only style rules are off there, so the app keeps its layout: Prettier, `curly`, nested ternaries and `@param` tags that repeat the TypeScript signature. The Worker, the launcher, browser and performance tests, and scripts use `eslint.config.mjs`, which is ESLint's and typescript-eslint's recommended rules. Warnings fail the gate as well. `pnpm test:lint` plants a violation in each scope and checks that it fails. The app build and the Worker job run TypeScript; lint does not repeat it.
- **Dependency audit** (`pnpm audit:deps`). This runs `pnpm audit` and `composer audit --locked` over the frozen lockfiles, including development dependencies, because build tools run in CI. It also runs `composer validate --strict`. A high, critical or unrated advisory fails the gate, and so does a scanner that timed out or returned no report, because an unreachable advisory endpoint is not a clean audit. Lower severities and abandoned Composer packages are kept in the `dependency-audit` artifact for review, together with tool versions and lockfile digests.
  - Fix an advisory by updating the dependency. When a parent pins a vulnerable version, add a scoped `overrides` entry in `pnpm-workspace.yaml` that names the advisory.
  - When no fix exists, add an entry to `.github/dependency-audit-exceptions.json`. It needs `tool`, `advisory` (any of its IDs), `package`, `via` (for pnpm, the dependency-path prefix it was judged for), `owner`, `reason` and `expires`. The expiry may be at most 120 days ahead. An exception covers nothing outside its path prefix, an expired one fails the gate, and an unused one is reported so it can be removed.
- **Secret scan** (`pnpm scan:secrets`). `scripts/ci/gitleaks.sh` runs gitleaks 8.30.1, which is downloaded once and refused unless its SHA-256 matches the pin. Every output is redacted. Gitleaks' default rules are extended in `.gitleaks.toml` with rules for this project's secrets: the generated and constant-backed WordPress signing keys, GitHub App webhook secrets, and WordPress auth cookies and nonces. GitHub App PEMs and provider tokens are covered by the default rules.
  - Every CI run scans every commit's changes over the full history. The size job packs and verifies the installable ZIP, secret scan included. A release does the same at the requested version, and scans the archive again when it uploads it.
  - Workflows may upload artifacts only through `.github/actions/upload-scanned-artifact`. It scans the files with `scripts/ci/scan-artifact.sh`, including inside archives, before uploading them, and it requires `retention-days`. A failure diagnostic that contains a secret is therefore withheld and fails its job.
  - `scripts/ci/secret-scan.test.mjs` generates a canary for every rule and checks that each one is caught and that the output is redacted. It also checks that the public keys, signatures and the shared fixture in `contract/fixtures/signing.json` pass. That fixture is allowed only at that path and only with that value.
  - Content without a recognisable format, such as Submitted text, Reporter subjects or Submission IDs, is caught by canary. A test that wants to detect such a leak builds `gqcanary_` plus at least 20 random lowercase letters or digits at run time. Any scanned log, response or artifact that contains the canary then fails. The canary must not appear literally in source.
- **Workflow policy** (`node scripts/ci/workflow-policy.mjs`, run by the plan job). Every third-party action is pinned to a full commit SHA, with its release in a comment. No job in a workflow that runs on pull requests gets a write token (the manual-only CI simulation is the one listed exception), `pull_request_target` is not allowed, and every artifact goes through the scanning upload from an allowlisted report path. To update an action, resolve the release tag to its commit (`gh api repos/OWNER/ACTION/commits/TAG --jq .sha`), review the change, and replace both the SHA and the comment.

### Browser tests before a push

For quicker feedback than CI, lefthook's `pre-push` hook runs the Playwright specs affected by the pushed files against the shared DDEV test site (`gq-support-lifecycle-testsite`, created by `plugin/tests/integration/run.sh`). It usually takes under a minute, and it skips when the site is not running.

- The site is shared by every checkout and agent on this machine, and the specs change its state, so runs take turns behind a lock.
- From a worktree, the site serves a copy of that worktree's `plugin/` for the run, then points back at the main checkout's `plugin/`. Run tests on the shared site through this script, not by hand at the same time.
- Skip it with `GQ_SUPPORT_SKIP_PRE_PUSH=1 git push`. CI still runs everything.

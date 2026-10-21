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

The release workflow runs on `plugin-v*` tags. After its performance gates and
package publishing succeed, its final job dispatches with the resulting `v*`
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

`.github/workflows/ci.yml` runs on every pull request and `main` push. Its `Required validation` job is the one check `main` should require. It always runs, and fails when a required job failed, was cancelled, or was skipped although the change affects its suite. The plan job decides which suites (`php`, `size`, `wordpress`, `worker`) a change affects with `scripts/ci/affected-suites.mjs`:

- Documentation-only changes skip every suite and still report success.
- `contract/**` and both signing implementations run the WordPress and Worker suites.
- The root toolchain, `scripts/ci/`, the runtime matrix and the CI workflows run every suite.
- A path no rule classifies runs every suite.

Supported runtimes live in `.github/runtime-matrix.json`: WordPress 6.5 and PHP 8.0 minimums, PHP up to 8.4, `Tested up to` 7.1. Each cell pins exact WordPress, PHP, WooCommerce and Plugin Check versions and, at the oldest and current endpoints, the React that WordPress registers. Pull requests run WordPress 6.5.0 on PHP 8.0 and 7.1.3 on PHP 8.4, each single site then multisite, plus the counter gate at both endpoints, 6.5.13 on PHP 8.2 and integration on PHP 8.1–8.3. Every cell records its actual runtime in a `runtime-<cell>` artifact and fails if that differs from the cell; `Required validation` joins them into `resolved-runtime-matrix`.

`.github/workflows/compatibility.yml` runs nightly cells: the previous WordPress minor, MySQL 8.0 and MariaDB 10.11, a persistent object cache, subdomain multisite, Firefox and WebKit. It also runs nonblocking canaries (WordPress nightly, PHP 8.5, floating latest releases) and a discovery job that fails when upstream releases overtake a pin. A failed canary or discovery job turns the nightly run red so it gets noticed, but `Compatibility result` ignores it. A release runs every pull-request and nightly cell before publishing; canaries never block.

Every cell uses the one-line GETQUICK Design fixture that `run.sh` writes. No CI cell yet installs the real private `gq-design` release; that needs a protected sandbox with registry credentials.

- To update a pin or widen support, change `.github/runtime-matrix.json` and the plugin headers in one reviewed PR. `node scripts/ci/runtime-matrix.mjs policy` fails when the headers, Composer, PHPCS or PHPStan ranges differ from the cells that execute them. Widening the PHPStan range is not enough on its own: a pull-request cell must run that PHP version.
- To run one cell locally, use `scripts/ci/run-cell.sh <cell-id>` on a fresh site, because WordPress and database versions are fixed when the site is created. Set `GQ_SUPPORT_TEST_URL` when the DDEV project has another name. Run the CI script tests with `pnpm test:ci`.
- To check that `Required validation` fails on each case, run CI manually with `simulate` set to `failure`, `cancelled` or `unexpected-skip`. Manual runs need `ci.yml` on `main`.

While the `Protect main` ruleset still requires `Asset size gate`, `PHP result` and `Worker result`, `ci.yml` keeps the size job's name and emits the other two from `Required validation`. To switch the ruleset over:

1. Merge to `main`.
2. Run the three simulations and confirm that `Required validation` fails in each.
3. Confirm that a documentation-only PR passes.
4. Make `Required validation` the ruleset's only required status check.
5. Delete the `php-result` and `worker-result` jobs.

### Browser tests before a push

For quicker feedback than CI, lefthook's `pre-push` hook runs the Playwright specs affected by the pushed files against the shared DDEV test site (`gq-support-lifecycle-testsite`, created by `plugin/tests/integration/run.sh`). It usually takes under a minute, and it skips when the site is not running.

- The site is shared by every checkout and agent on this machine, and the specs change its state, so runs take turns behind a lock.
- From a worktree, the site serves a copy of that worktree's `plugin/` for the run, then points back at the main checkout's `plugin/`. Run tests on the shared site through this script, not by hand at the same time.
- Skip it with `GQ_SUPPORT_SKIP_PRE_PUSH=1 git push`. CI still runs everything.

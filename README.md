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

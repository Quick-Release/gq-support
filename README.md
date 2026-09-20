# GETQUICK Support

WordPress plugin that adds an in-dashboard chat window for logged-in editors
and administrators to report bugs.

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

Until the package is registered on Packagist, add the public GitHub repository
as a VCS repository and require the first release explicitly:

```json
{
  "repositories": [
    {
      "type": "vcs",
      "url": "https://github.com/Quick-Release/gq-support"
    }
  ],
  "require": {
    "getquick/gq-support": "^0.0.1"
  }
}
```

Run `composer update` after adding the repository. Composer’s package installer
places the plugin at `wp-content/plugins/gq-support/` by default, or at the
Bedrock path shown above.

## Layout

- `plugin/` — the WordPress plugin. `plugin/gq-support.php` is the
  main plugin file installed into WordPress; it enqueues the built widget
  from `plugin/assets/dist/`.
- `plugin/app/` — the chat widget frontend (React + TanStack Query), built
  with Vite into `plugin/assets/dist/`.
- `worker/` — a Cloudflare Worker backend, provisioned with
  [Alchemy](https://alchemy.run) and written with
  [Effect](https://effect.website). Currently a placeholder with no routes.

## Development

```sh
pnpm install

# build the chat widget bundle consumed by the WordPress plugin
pnpm build:app

# run the Cloudflare worker locally
pnpm dev:worker

# deploy the Cloudflare worker
pnpm deploy:worker
```

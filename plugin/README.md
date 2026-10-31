# GETQUICK Support

GETQUICK Support is a WordPress plugin that adds an in-dashboard support
widget. Authenticated Reporters submit support requests and view their submitted
text and status in WordPress; issues are stored in the connected project GitHub
repository.

## Install with Composer

The Composer package is published from the `v*` release tags in the public
repository. In a WordPress project that already uses
[`composer/installers`](https://github.com/composer/installers), run:

```sh
composer require getquick/gq-support
```

For a Bedrock-style project, configure the plugin path in the project’s root
`composer.json`:

```json
{
    "extra": {
        "installer-paths": {
            "web/app/plugins/{$name}/": [
                "type:wordpress-plugin"
            ]
        }
    },
    "config": {
        "allow-plugins": {
            "composer/installers": true
        }
    }
}
```

The package is also available directly from GitHub before it is registered on
Packagist:

```json
{
    "repositories": [
        {
            "type": "vcs",
            "url": "https://github.com/Quick-Release/gq-support"
        }
    ],
    "require": {
        "getquick/gq-support": "^0.1.0"
    }
}
```

The release artifact has the plugin file at its root, so Composer installs it
as `gq-support/gq-support.php` rather than nesting the plugin under the source
monorepo’s `plugin/` directory.

## Native WordPress updates

Installations that GETQUICK does not deploy centrally update through WordPress's
own updater. The plugin's `Update URI` keeps it off WordPress.org; it is offered
only GETQUICK's approved release, downloaded from the configured support service
and installed only if its SHA-256 matches the approved package.

1. Run `wp gq-support update-key` and send GETQUICK the printed public key. The
   key stays on the site (network option `gq_support_update_key`) and is separate
   from the support connection: disabling support with `GQ_SUPPORT_DISABLED` or
   disconnecting the site does not stop updates.
2. Once GETQUICK grants it, `wp gq-support update-check` shows the approved
   release, `wp gq-support update-status` the last check, and
   `wp plugin update gq-support` installs it. GETQUICK enables automatic updates.

The plugin contacts the service only from WP-CLI, WordPress cron or the Updates
screen's "Check again", at most hourly, never while ordinary pages render. Core
offers the update only after its own WordPress.org update check succeeds, and
WordPress cron cannot promise prompt installation. `wp gq-support update-key
--rotate` replaces the key; updates resume once GETQUICK grants the new one.

## Native extensions and Site Health

See [Native Support extensions](https://github.com/Quick-Release/gq-support/blob/main/docs/support-extension-hooks.md) for the
review-time context filter, durable-acceptance and delivery-observation actions,
and local-only Site Health information. Technical details remain disabled.

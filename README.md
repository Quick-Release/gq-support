# GQ Support

GQ Support is a WordPress plugin that adds an in-dashboard chat window for
logged-in editors and administrators to report bugs.

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
        "getquick/gq-support": "^0.0.1"
    }
}
```

The release artifact has the plugin file at its root, so Composer installs it
as `gq-support/gq-support.php` rather than nesting the plugin under the source
monorepo’s `plugin/` directory.

=== GETQUICK Support ===
Contributors: getquick
Tags: support, issue-tracking, bug-report
Requires at least: 6.5
Tested up to: 7.1
Requires PHP: 8.0
Stable tag: 0.2.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Adds an in-dashboard support widget for authorized users to submit reports and view their status.

== Description ==

Authorized Reporters on a connected installation can submit Support requests and review their status from supported admin screens. An approved service connection and explicit access are required.

== Changelog ==

= 0.2.0 =
* Sign the plugin version and installed file digest so the service can verify release compatibility and update outcomes.
* Support approved private updates and compatible recovery independently of report access.
* Pause new reports when the cached release policy requires an update, while retaining access to accepted requests.

= 0.1.10 =
* Let Reporters, and Support managers within their installation, close and reopen a delivered Support request; GitHub stays authoritative for its status.
* Keep privacy export and erasure available while support is disabled.
* Add Report context hooks and a local Site Health status.

= 0.1.9 =
* Let Reporters review and remove the WordPress version, plugin version and originating screen sent with a Support request.
* Keep unsent drafts recoverable in the open tab, bound the widget load to 10 seconds, and add the GQ_SUPPORT_DISABLED fail-safe with an independent contact.
* Add privacy export and erasure for Support requests, including erasures whose delivery outcome is unknown.
* Load plugin classes on first use to keep public requests within the memory budget.
* Translate the plugin's admin, privacy and export text into European Portuguese.
* Darken the admin colour scheme accent where it falls short of AA contrast in the panel, as Sunrise does before WordPress 7.1.

= 0.1.8 =
* Update the support service to Alchemy beta.83 and Effect 4.0.5, including HTTP API compatibility fixes.

= 0.1.7 =
* Fix release checks with WooCommerce's first-request initialization.

= 0.1.6 =
* Add capability checks and Reporter-scoped support REST routes.
* Add report submission and retry reconciliation, with draft recovery when the session expires.

= 0.1.5 =
* Update dependency documentation and Playground fixtures to use gq-design.
* Point local development scripts at the shared WordPress playground.

= 0.1.4 =
* Require the renamed GQ Design plugin slug, gq-design, so WordPress recognizes the installed dependency.

= 0.1.3 =
* Add the Support launcher on the Dashboard, post screens, and WooCommerce screens for authorized Reporters on a connected installation. The panel loads only on first open and keeps an in-memory draft; sending is not available yet.
* Grant the Administrator role the submit and manage-settings capabilities once; uninstall removes only the grants the plugin added.
* Add Portuguese (Portugal) translations and RTL styles.

= 0.1.2 =
* Document the support authentication, authorization, and installation trust boundaries; no support workflow is enabled yet.

= 0.1.1 =
* Make activation and WordPress context loading conditional on GETQUICK Design.
* Keep public requests inert; remove the unfinished admin widget until the authorized launcher is ready.
* Add versioned local installation markers, clone-aware identity rotation, and bounded uninstall cleanup.
* Require WordPress 6.5 or newer and verify single-site and multisite lifecycle behavior.

= 0.1.0 =
* Require the GETQUICK Design plugin by its plugin slug (now gq-design).

= 0.0.1 =
* Initial scaffold.

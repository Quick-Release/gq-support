=== GETQUICK Support ===
Contributors: getquick
Tags: support, issue-tracking, bug-report
Requires at least: 6.5
Tested up to: 7.1
Requires PHP: 8.0
Stable tag: 0.1.2
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Adds an in-dashboard support widget for authenticated users to submit reports and view their status.

== Description ==

This plugin is under active development. No end-user functionality is implemented yet.

== Changelog ==

= 0.1.2 =
* Document the support authentication, authorization, and installation trust boundaries; no support workflow is enabled yet.

= 0.1.1 =
* Make activation and WordPress context loading conditional on GETQUICK Design.
* Keep public requests inert; remove the unfinished admin widget until the authorized launcher is ready.
* Add versioned local installation markers, clone-aware identity rotation, and bounded uninstall cleanup.
* Require WordPress 6.5 or newer and verify single-site and multisite lifecycle behavior.

= 0.1.0 =
* Require the GETQUICK Design plugin by its own slug, getquick-design.

= 0.0.1 =
* Initial scaffold.

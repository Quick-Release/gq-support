# Native Support extensions

Planned for 0.1.10 (`@since 0.1.10`), the next patch after the current 0.1.9
release. This documents hook introduction without changing the release version.
These hooks add no diagnostic fields or background work. WordPress 6.5 and PHP 8.0 remain supported.

## Review-time context

`gq_support_report_context` filters the normalized candidate
`array('schema' => 1, 'default' => array(...))`. Its second argument contains
only `array('phase' => 'default')`, with an optional `originating_screen` from
`dashboard`, `post-list`, `post-editor`, or `woocommerce`. It includes no
Reporter identity, Submitted text, URL, credential or review envelope.

```php
add_filter( 'gq_support_report_context', static function ( $candidate, $collection ) {
    unset( $candidate['default']['wp_version'] );
    return $candidate;
}, 10, 2 );
```

Collection runs only through the authenticated, authorized on-demand preview.
The filter never runs on ordinary page loads, Site Health, submission, delivery
or retry. A callback may remove fields or supply approved default values, which
are then validated before preview and signing. The technical phase remains
disabled. There is no runtime registration of fields or attribution override.

The fixed schema, three-default-field limit, version grammar, coarse screen enum,
UTF-8 scalar and serialized byte limits in [Report context design](support-context-design.md)
apply after callbacks. Unknown fields (including technical fields), nested or
malformed values, URLs and free text are omitted with the existing accessible
omission notice. Invalid outer structures, `WP_Error`, schema overrides and
catchable exceptions produce an empty optional context and the omission path.
Deliberate callback removals need no failure notice. Reporter removals remain
binding; the reviewed envelope allows only subsets, and callbacks never append
values after preview. HTML preview uses React text rendering; issue rendering
uses the existing separate escaped context section.

## Durable acceptance and delivery observations

Both actions receive exactly two arguments: the public opaque Support request ID
(`req_` followed by 26 uppercase Crockford-base32 characters) and an allowlisted
Delivery outcome. Neither receives the Submission ID, signing nonce, Reporter
subject, report text/context, repository, credential, provider detail or raw error.

- `gq_support_report_accepted($request_id, $delivery_outcome)` runs after a
  validated create/replay response confirms `accepted-pending`, `delivered` or `failed`. A failed replay
  still proves the intent was durably accepted (ADR 0003); acceptance is not a delivery
  success signal.
  Transport errors, malformed or mismatched responses, and ambiguous outcomes
  never signal acceptance. A read does not emit this action.
- `gq_support_report_delivery_changed($request_id, $delivery_outcome)` runs when
  an explicit create, read or list confirms `delivered` or `failed`: a terminal
  transition out of pending. A delivered create or failed create replay emits
  acceptance first, then delivery-changed. An entire list is validated before any observers run.
  Pending and outcome-unknown observations do not signal a delivery transition.

These are observations, not an event stream. Reading the same terminal request
again or replaying a create may repeat notifications, including within one PHP
process. Callbacks must be idempotent. No local event ledger, polling, background
subscription or exactly-once promise is added; Worker transitions never observed
by an explicit WordPress support operation produce no notification.

Each action invocation catches `Throwable` independently, so an acceptance
observer failure does not prevent the delivery action or change the confirmed
HTTP result. WordPress stops the remaining callbacks on that action if one throws;
other callbacks on that invocation are not guaranteed to run. Callback values and
exception messages are not logged by the plugin.

Catching an exception preserves only the plugin result or context omission path;
it does not fully isolate callback execution. WordPress does not unwind its
current-filter stack or `WP_Hook` nesting bookkeeping when a callback throws.
Consequently `current_filter()`, `doing_filter()` / `doing_action()` and later
nested dispatch in the same PHP request can retain stale hook state. The plugin
does not repair WordPress internals. Extension callbacks must catch their own
exceptions before returning to WordPress to keep hook bookkeeping balanced.
This limitation applies to both the context filter and the lifecycle actions.

## Callback responsibilities and Site Health

Installed PHP already has site privileges; these hooks are not a sandbox. Use
bounded local reads and idempotent callbacks, with no network requests, SQL scans,
side effects during collection, or unbounded enumeration. The plugin cannot
interrupt unbounded code or guarantee recovery from fatal errors, process exits,
resource exhaustion, arbitrary output or logging performed by installed PHP.

Site Health's Info tab adds only the support-plugin version and an allowlisted
local connection label. “Connected” is a local snapshot, not evidence of a fresh
service check. Rendering it performs no remote probe, context collection, key
read or diagnostic scan. Endpoint URLs, key IDs, fingerprints, raw last-test
errors, Reporter identity and request content are excluded. Existing explicit
connection testing remains a separate operator action.

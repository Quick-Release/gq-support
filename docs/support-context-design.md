# Support context and optional technical details

Decision record for [Define on-demand diagnostics, redaction, and native context extension hooks](https://github.com/Quick-Release/gq-support/issues/14), agreed in two live decision rounds. This specifies future implementation; it does not enable collection. The resolution comment on that ticket is the canonical decision. [API contract](support-api-contract.md), [privacy design](support-privacy-design.md), [delivery design](support-delivery-design.md), and [idle budgets](research/idle-performance-budgets.md) continue to apply.

## Agreed boundary

The MVP may add disclosed Environment, WordPress version, and support-plugin version. Versions and the originating admin screen are individually removable before submission. Environment remains trusted installation attribution, alongside the existing opaque installation reference, pseudonymous Reporter reference, and acceptance timestamp. Optional context never conveys authorization or selects a repository.

Rich technical details are deferred beyond the plain-text MVP. Their first approved schema contains PHP version, database engine/version, and active theme slug/version only. No screenshots, reproduction recording, session replay, console interception, fetch/XHR patches, or passive error collection is approved. Opening a widget cannot reconstruct earlier activity.

No diagnostic scan, extension context filter, network request, timer, or monitoring runs while the widget is closed. Capturing a coarse screen identifier in the existing eligible launcher bootstrap is the sole originating-screen exception: it uses the already-available admin screen, does not run collectors, and must stay within the measured launcher budget. Ordinary page loads never run Site Health checks.

## Field inventory

All accepted optional fields go through browser memory preview, the authenticated WordPress handler, signed installation transport, D1 delivery-intent context, and the private Project repository's GitHub issue body. D1 context is cleared at terminal delivery outcome; the GitHub copy follows repository retention and Reporter-erasure rules. No context is logged. All versions are operational fingerprint information, even without personal identifiers.

| Field | Source and trust | Purpose and sensitivity | Trigger and removal | Validation/redaction |
|---|---|---|---|---|
| `environment` | Worker Repository mapping; authoritative for installation attribution | Distinguish production/staging; operational | Already part of issue attribution; disclose, cannot remove | Existing mapping grammar; never accept a browser override |
| `wp_version` | WordPress core version, read server-side; trusted origin, validate value | Reproduce compatibility; operational fingerprint | On explicit widget open; checked by default, removable | Version grammar; reject malformed value |
| `support_plugin_version` | `GQ_SUPPORT_VERSION`; trusted origin, validate value | Identify support-client behavior; operational fingerprint | On explicit widget open; checked by default, removable | Version grammar; reject malformed value |
| `originating_screen` | Coarse `get_current_screen()` result at launcher stage; echoed browser input is untrusted | Locate affected admin area; potentially sensitive screen names | Cheap launcher capture; review on open; removable | Fixed mapping to `dashboard`, `post-list`, `post-editor`, or `woocommerce`; unknown/custom IDs omitted |
| `php_version` | `PHP_VERSION`, server-derived | Runtime compatibility; operational fingerprint | Future explicit “Include technical details”; individually removable | Version grammar |
| `database_engine` | Server database adapter; server-derived | Database compatibility; operational fingerprint | Future explicit technical-details action; individually removable | Enum `mysql` or `mariadb`; omit if unknown |
| `database_version` | Server database adapter's version; server-derived | Database compatibility; operational fingerprint | Same explicit action; individually removable | Extract version only; no raw server/banner/host string |
| `active_theme_slug` | `wp_get_theme()` stylesheet identifier; server-derived but installed metadata is not unrestricted trusted content | Reproduce theme interaction; may reveal project branding | Same explicit action; individually removable | Slug grammar; no paths, display name, URI or author |
| `active_theme_version` | Active theme metadata, server-derived | Reproduce theme interaction; operational fingerprint | Same explicit action; individually removable | Version grammar |
| Future extension fields | Installed PHP, restricted to a schema-approved key and collector | Must have an individually reviewed purpose/sensitivity | Explicit collection only, preview/removal required | Not enabled merely because the hook can return a key |

The field-count limit leaves room for reviewed future keys; it does not approve any keys beyond this inventory. Version strings match `^[0-9][A-Za-z0-9.+_-]{0,63}$`; theme slugs match `^[a-z0-9][a-z0-9_-]{0,63}$`. Unsupported legitimate formats are safely omitted rather than loosening to arbitrary strings. Screen names are coarse hints, never evidence of the Reporter's access to a resource.

URLs are not collected: no current URL, referrer, host, path, query, fragment, username/password component, nonce, or token. This fully omits nonce-bearing and customer-bearing admin URLs rather than attempting a partial scrub. Also excluded: post/customer IDs, names/email/usernames, user-agent/viewport, other plugin inventories, cookies, authorization headers, passwords, form values, raw SQL, logs, filesystem paths, and arbitrary free-text extension values. Future URL collection requires a new approved necessity and allowlist; it cannot be added through a filter.

## Limits and example payloads

Limits count UTF-8 bytes in compact serialized JSON including keys and punctuation. Each scalar is at most 256 bytes (individual grammar limits may be smaller). `default` has at most three keys; `technical` has at most eight keys and 4,096 serialized bytes. The whole normalized context object is at most 6,144 bytes, including schema metadata. No nesting beyond the fixed `default` and `technical` objects, arrays, objects as values, HTML, or unknown keys. At present only five technical keys are approved. The complete create request remains capped at 32,768 bytes, including any review envelope, identity and context on the WordPress-to-Worker hop; context does not increase that cap. The UI must check the actual envelope size before enabling submission.

Normalized default example (illustrative versions, not a new browser-trusted payload):

```json
{"schema":1,"default":{"wp_version":"6.5.5","support_plugin_version":"0.1.8","originating_screen":"post-editor"}}
```

Future opt-in example:

```json
{"schema":1,"default":{"wp_version":"6.5.5","support_plugin_version":"0.1.8","originating_screen":"post-editor"},"technical":{"php_version":"8.3.12","database_engine":"mariadb","database_version":"10.11.9","active_theme_slug":"twentytwentyfour","active_theme_version":"1.3"}}
```

All removable fields omitted:

```json
{"schema":1,"default":{}}
```

Environment and the existing opaque attribution remain separate, Worker-derived fields. The browser never supplies their authoritative values. Omit `technical` entirely unless explicitly collected and at least one field selected. Unknown or invalid candidate fields are dropped before preview; reject unknown fields at a submitted protocol boundary. Oversized collector output is omitted with an accessible notice, never silently truncated into potentially meaningful data. If the reviewed wire payload exceeds a limit, require removal or offer “Send without optional information.” Do not silently change an already submitted intent.

## Preview, omission and immutable submission

1. On eligible page rendering, map the originating admin screen to the coarse enum; do not read the request URL. A subsequent REST or AJAX request is a different screen context. Keep only the coarse hint in launcher memory.
2. On explicit open, show “Information included.” Read the two default versions on the WordPress server and display exact final values with removal controls. Disclose that Environment and pseudonymous attribution accompany every report, that selected context goes through the service to private GitHub collaborators, and that GitHub history/notifications can retain residual copies.
3. A future “Include technical details” button triggers narrow server reads, after authentication and the submission capability check. Never collect them merely on open. Show each final value with a checkbox/removal control; no preselected hidden additions. Removing the section clears collected values from the draft. Recollection requires an explicit action and invalidates the previous preview.
4. Apply the context filter before final validation and preview. Bind the reviewed snapshot to the current WordPress installation, Reporter subject, Submission ID, schema and selected keys. Browser-provided server versions are not attestation. Use a server-authenticated review envelope; tampering, changed identity, or unsupported schema cannot introduce a value. A short-lived review envelope may require re-preview before a first submission; an accepted submission's retries must remain reconcilable without recollection or a fresh snapshot.
5. Freeze exact reviewed values and selection on first send. Preserve that snapshot in the same draft/retry mechanism as Submitted text; no separate local persistence or outbox is authorized here. Same-key retries send the same intent; the Worker compares an immutable intent fingerprint including reviewed selection/context, Summary, Description and existing supersession semantics. Do not include ephemeral envelope signatures/expiry in that fingerprint. A changed reviewed value or selection after submission requires a new Submission ID, subject to the existing unknown-outcome safeguards.
6. Environment is resolved from trusted Worker configuration at first acceptance. Accepted context is fixed with the delivery intent and never enriched or recollected during delivery, retries or recovery. Version upgrades, extension changes, screen navigation and mapping changes cannot silently change it. Pending-intent transport replays use the frozen snapshot. Existing accepted-intent lookup must permit legitimate same-intent reconciliation when a preview envelope has expired; it must not permit expired envelopes to authorize a new acceptance.
7. Collection failure must not block plain-text reporting: display “Some information could not be collected” and offer “Send without optional information.” An unreviewable/malformed candidate is omitted before submission. If the create was already sent, keep reconciling that intent; do not remove context or mint a new ID automatically. Existing authentication, authorization, required-text and transport-size errors still apply.
8. After send, context never joins the Reporter list/read resource or Submitted text. Before acceptance it is draft memory; in D1 it is delivery-only; the issue body labels it separately as technical context. Document that the Reporter cannot retrieve it from the support projection later. WordPress privacy export must nevertheless include any still-retained context for that Reporter. Erasure removes it from service state and the App-authored GitHub body, retaining only the existing minimal attribution/marker and reporting residual copies.

Transport implementation must extend the strict browser and Worker create schemas and shared fixtures together. Keep the three existing REST routes: an authenticated on-demand WordPress AJAX preview action, following the existing loader's auth pattern, can supply the server-authenticated review envelope without adding a REST route. It must enforce current site membership, session, nonce and `gq_support_submit_requests`, return `private, no-store`, bound input/output and never contact the Worker merely to preview. Screen data is a bounded hint; a signature on its envelope does not make the browser's originating-page claim authoritative. The implementation must specify and test envelope encoding, signing, expiry, and accepted-replay behavior before enabling context. Until that lands, the current no-context API remains valid.

## Native extension contracts

Proposed PHP signatures, introduced with implementation and documented with `@since`; these hooks do not exist today:

```php
$candidate = apply_filters( 'gq_support_report_context', $candidate, $collection );
do_action( 'gq_support_report_accepted', $request_id, $delivery_outcome );
do_action( 'gq_support_report_delivery_changed', $request_id, $delivery_outcome );
```

`$candidate` has the normalized shape above. `$collection` contains only `phase` (`default` or `technical`) and the optional coarse `originating_screen`. No user object, URL, report text, subject, keys, cookies, headers or tokens are passed. `technical` phase is available only after explicit opt-in. During the default phase, technical keys are discarded even if an extension returns them. Filters can remove approved candidate values or contribute only approved schema fields in their permitted phase; they cannot alter Environment/attribution, approved grammars, limits or Reporter selection. They never run after the final preview to append unseen data.

After all callbacks, reapply key/phase allowlists, types, grammar, UTF-8 validity, field/total limits and sensitive-value exclusions. Reject arrays/objects/resources, unknown keys and malformed scalars. Escape each accepted value for plain-text issue rendering and HTML preview separately. A returned `WP_Error`, invalid structure or catchable callback exception degrades to context-unavailable with the omission path; do not log raw callback values or exception messages. Arbitrary installed PHP already has site privileges: filters are not a sandbox, and the plugin cannot forcibly make an arbitrary callback cheap or interrupt every fatal error. Document callbacks as bounded local reads with no network, SQL scans, side effects or unbounded enumeration.

`$request_id` is the public opaque Support request identity, not the Submission ID or signing nonce. `$delivery_outcome` is an allowlisted value from the existing contract. Acceptance fires after the service confirms durable acceptance, whether the response is pending or already delivered; it never fires for `outcome-unknown` or a transport failure. Delivery-changed fires on a confirmed transition observed while handling an explicit support operation, including direct delivery confirmed on create; it is not a background subscription. The WordPress process cannot promise an event for a Worker transition it never observes. Observations/retries can repeat notifications; callbacks must be idempotent, and these actions are not an exactly-once integration bus. Hooks carry no text/diagnostics, secrets, provider response, repository identity, Reporter subject or raw error. Catchable observer failures do not turn an already accepted report into a failed submission.

Adding a field requires a schema, purpose, sensitivity, source, trigger, preview/removal rule, retention/export/erasure handling, shared fixtures and a release review. There is no runtime field-registration escape hatch. No contributed fields beyond the listed schema are approved in this decision.

## Narrow collectors and Site Health

Prefer the core version value, `GQ_SUPPORT_VERSION`, `PHP_VERSION`, `wp_get_theme()` metadata, and the database adapter's narrow version accessors. Do not call `WP_Debug_Data::debug_data()` and then discard most of it: the full collector assembles paths, plugins, filesystem and other unrelated sections, including filter contributions. Existing core accessors must be checked against the declared WordPress 6.5 / PHP 8.0 minimum; do not rely on newer modular Site Health methods.

Site Health integration may show local connection state and support-plugin version only, using existing local state. No signing key, key ID, Enrollment code, endpoint URL, last raw error, Reporter identity or request content is exposed. A local “connected” state is not a claim that a live service check just succeeded. Existing explicit connection testing stays an operator action; no remote tests or diagnostic scan on Site Health rendering or ordinary page loads.

## Implementation acceptance cases

These are required future test cases, not tests claimed to pass today:

1. A launcher opened from `post.php?post=123&_wpnonce=secret&token=secret#customer` sends at most `post-editor`; credentials in a URL, all query keys, path, customer IDs and fragments never enter preview, envelope, D1, GitHub, logs or hook arguments. Unknown/custom screens are omitted.
2. Default create contains only the two checked versions and selected coarse screen; remove any/all and verify exactly the selected set. Environment/opaque attribution stays Worker-derived despite forged browser claims. No technical fields collected by default.
3. Future explicit opt-in collects only the five approved technical fields. Customer records/form contents, active plugin inventory, server paths, database hosts/passwords and full Site Health output are absent. Missing adapters or incompatible version formats safely omit fields.
4. Malicious extensions return nonce-bearing strings, secrets in URLs, customer text, arrays, oversized values, unknown keys, technical fields in default phase, altered attribution, exceptions and invalid UTF-8. Validate again after filtering; preview and downstream output contain no such values. Never use regex secret masking to justify arbitrary text fields.
5. Exercise 256-byte values, grammar boundaries, eight-field/4,096-byte technical and 6,144-byte context limits, plus 32,768-byte complete requests, multibyte text and envelope overhead. Unknown keys fail both submitted schemas. No silent post-review truncation.
6. Preview failure provides an accessible omission path; authentication failure does not disclose anything. Plain-text submission succeeds with no optional context. Async collector completion after close, identity change or removal cannot mutate a draft or submit data.
7. Upgrade versions/change extension output between acceptance and retry. Exact frozen intent succeeds without recollection; changed selected context conflicts; expired accepted replay reconciles; expired first acceptance requires preview. Failed/unknown creates never trigger an acceptance notification. Accepted hooks throwing cannot rewrite the service outcome.
8. D1 context is cleared on delivered/failed terminal states and privacy purge/erasure. Unknown-outcome cleanup obeys the delivery design. GitHub erasure removes the context section while keeping minimal attribution; privacy export includes retained context. Reporter projections contain no new context fields.
9. Closed widget makes zero context-preview/service requests and runs zero collectors/filters, SQL diagnostic queries, monitors or timers; public pages incur no assets or work. Keep the launcher screen hint within existing performance gates. Site Health rendering uses local connection state only.
10. Validate schema fixtures, PHP/Worker parity, Markdown/HTML output escaping, per-Reporter/Slot isolation, forged/tampered review envelopes, stale capabilities and no text/secret leakage through logs, exceptions or lifecycle hooks.

## Implementation slices and enablement

1. [Implement reviewed minimal Report context end to end](https://github.com/Quick-Release/gq-support/issues/71): review envelope, two removable versions, coarse removable screen, strict schemas/shared fixtures, immutable idempotency, frozen intent storage and issue rendering. Include privacy inventory/copy/export/erasure and deterministic performance/adversarial checks in the same enablement gate. Preserve legacy no-context submissions and their retries without enrichment or fingerprint changes. Until complete, keep context disabled.
2. [Add Report context hooks and local Site Health status](https://github.com/Quick-Release/gq-support/issues/72): implement the signatures, lifecycle observation semantics, callback failure handling and local-only Site Health display; depends on the minimal-context seam. This introduces no new diagnostic fields.
3. [Add opt-in Technical details after the MVP](https://github.com/Quick-Release/gq-support/issues/73): implement the five narrow collectors and explicit opt-in preview, after the preceding slices and privacy release gates. This ticket is deferred, not part of MVP readiness. No additional production collection approved by merely closing the planning issue.

## Primary references

- [Current admin screen](https://developer.wordpress.org/reference/functions/get_current_screen/): capture originating screen during the admin request; later request context differs.
- [Site debug data](https://developer.wordpress.org/reference/classes/wp_debug_data/debug_data/): broad collector and extensible output; unsuitable as this small report's default source.
- [Custom WordPress hooks](https://developer.wordpress.org/plugins/hooks/custom-hooks/): prefixed `apply_filters()` and `do_action()` conventions.

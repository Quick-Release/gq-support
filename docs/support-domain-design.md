# Client support domain design

This record describes support reports submitted by authenticated WordPress users and tracked as issues in each project's existing GitHub repository. Clients do not access GitHub; the WordPress plugin is the only client-facing projection. See [ADR 0009](adr/0009-project-repository-intake-and-reporter-scoped-projection.md) for the accepted repository and visibility decision.

## Context boundary

```text
Authenticated WordPress Reporter
        |
        v
GETQUICK Support launcher and issue list
        |
        v
WordPress REST boundary -- verified identity and visibility scope
        |
        v
Intake/delivery service -- routing, idempotency, issue mapping, receipts
        |
        v
GitHub App -- creates issue, applies client-origin label, assigns Developer
        |
        v
Existing GitHub repository for the WordPress project
        `-- issue body: submitted report; open/closed: support status
```

The Reporter sees only Support requests associated with their verified WordPress identity, or those within an explicitly granted Support manager scope. The issue body and open/closed status are projected into WordPress. GitHub comments and unrelated engineering issues are not returned to the client.

## Identities and ownership

- A **Client** is the customer support boundary and may have multiple WordPress projects, installations, and environments.
- A **WordPress project** connects to its existing GitHub repository; the plugin does not create a separate Support repository.
- A **Reporter** is an authenticated WordPress user, not a GitHub user.
- A **Support request** is one report submitted through the plugin and represented by one GitHub issue.
- The **GitHub App** is the issue author. An internal **Developer** is assigned to the issue.

| Concern | Authority | Projection/boundary |
| --- | --- | --- |
| WordPress installation, environment, current Reporter, local capabilities | WordPress | Resolved server-side; never accepted as browser identity claims. |
| Project-to-repository mapping | Approved project configuration | The Reporter cannot choose or change the repository. |
| Support request text and open/closed status | GitHub issue in the project's repository | WordPress shows only the submitted text and status for authorized requests. |
| Reporter-to-request association and GitHub issue identity | Operational service records | Used to list only requests created in that authenticated Reporter context. |
| Delivery receipts, attempts, idempotency, reconciliation | Operational service | Explain delivery; do not replace the GitHub issue. |
| Client-origin label | GitHub issue metadata | Internal triage classification only; never an authorization rule. |
| GitHub issue comments | Project repository | Internal collaboration; never included in the client projection. |

Project repository collaborators can read Support request issues in GitHub. This design keeps clients out of GitHub; it does not hide report content from people who already have access to the project repository.

## Authorization and issue listing

| Actor | Default scope | WordPress view |
| --- | --- | --- |
| Reporter | Requests they submitted through the authenticated WordPress installation | Submitted issue text and open/closed status only |
| Support manager | Explicitly granted scope over one installation or an approved set | Requests in that scope, with the same client-facing fields |
| Project developer | Access granted by the project's GitHub repository | Works the issue in GitHub; comments remain internal to the project team |
| Anonymous or unscoped user | None | No Support requests |

The service must record the verified Reporter, WordPress installation, Support request identity, and GitHub issue identity when creating the issue. A list/read request first resolves the actor's authorized Support request identities, then projects only those issues. A shared `client` label may help internal triage, but filtering by that label alone would return other Reporters' issues from the same repository.

Clients do not receive GitHub repository access, issue URLs that grant access, GitHub credentials, or arbitrary issue-number lookup. Every issue read is checked against the server-side association and Visibility scope.

## Issue and delivery semantics

- The GitHub App creates one GitHub issue for each Support request, applies the agreed general client-origin label, and assigns an internal Developer.
- The issue body contains the submitted report. The issue title is the Reporter's optional Summary; without one, it is the description's first line cut at a word boundary to about 80 characters. The label and issue author are not Reporter identity.
- The Reporter projection includes the submitted issue text and authoritative `open`/`closed` status. It excludes comments, internal labels, assignments, and unrelated repository issues unless a later decision adds a field.
- A report is not confirmed delivered just because WordPress accepted the browser request. Preserve the established delivery outcomes: `locally-unsent`, `accepted-pending`, `delivered`, `failed`, and `outcome-unknown`. Reconcile an ambiguous GitHub create before retrying.
- GitHub issue creation is attributed to the GitHub App. The assigned Developer is responsible for handling it; do not use a developer's personal credential just to make that person appear as issue author.

## First product slice

1. An authorized Reporter opens the bottom-right launcher in WP-Admin.
2. The Reporter submits a plain-text report.
3. The service creates and labels an issue in the connected project's existing repository and assigns a Developer.
4. WordPress lists only that Reporter's plugin-created requests, showing the submitted issue text and current status.
5. Project-team discussion remains in GitHub and is never rendered as a client conversation.

This is an issue intake and status experience, not live chat or a threaded client conversation. The connection/setup page is an operator surface under `GETQUICK → Support`, separate from the Reporter launcher.

## Reporter experience

Decided in #13.

- **Views.** One panel with two tabs. **New report** is the default. **My requests** lists items that expand in place to show the full text and status. There is no separate detail view. After a successful submit, the panel switches to My requests with the new item at the top.
- **Form.** A required **Description** and an optional one-line **Summary**. The placeholder asks "What happened, and what did you expect?". There is no bug/feedback/question picker in the MVP; developers classify in GitHub. Environment context is added server-side; the fields are decided in #14.
- **Status is read-only.** Reporters cannot close or reopen requests in the MVP. Status reflects what developers do in GitHub.
- **Honest status wording.** Each list item shows one badge (table below). The launcher is hidden from Reporters on an unconfigured installation; operators see the notice on the setup page.

| State | Reporter sees |
|---|---|
| Submitting | "Sending…", with the submit button disabled |
| `accepted-pending` | "Received", with the hint "Our team will see it shortly" |
| `delivered`, issue open or closed | "Open" or "Closed" |
| `failed` or `locally-unsent` | "Not sent", with **Try again** and the draft restored |
| `outcome-unknown` | "Checking…", with no resubmit while the service reconciles |
| REST 401/403 or expired login | "Your session expired. Reload the page to continue." The draft is kept. |
| Empty list | "No requests yet", with a link to New report |

- **Drafts** live in memory only. They survive closing and reopening the panel and failed sends, and are lost on reload or navigation. With an unsent draft, the closed launcher shows a small indicator. No browser storage is used.
- **Refresh.** The list loads the first time My requests is shown in a page session and when the Reporter presses refresh. Closing and reopening the panel does not refetch; a successful submit adds the new item from the create response. There is no polling, and no work runs while the panel is closed.
- **Accessibility.** The launcher is a `<button>` with `aria-expanded`. The panel is a non-modal dialog so the admin screen stays usable while the Reporter writes. Focus moves to the first field on open and returns to the launcher on close, and Escape closes the panel. Status changes and errors are announced through `wp.a11y.speak`. The panel respects `prefers-reduced-motion`, meets WCAG AA contrast in every admin colour scheme, and becomes a full-width sheet below the 782px admin breakpoint.
- **Translations.** All strings go through `@wordpress/i18n` in the `gq-support` text domain, with `_n()` plurals and dates in the site timezone. RTL uses the generated `index-rtl.css`. A pt_PT smoke test runs in DDEV.

## Deferred or unresolved

The Developer assignee (one default per WordPress project) and the connection lifecycle are decided in [support onboarding design](support-onboarding-design.md).


- Reporter close/reopen (#28) is a post-MVP slice after ordered mutations (ADR 0006).
- Privacy/retention of report text in the operational service while delivery is pending or being reconciled.
- Any future client-visible response channel. Adding comments to the WordPress projection would require a new decision; repository comments remain internal by default.

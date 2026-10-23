---
status: accepted
---

# Reporter status changes are ordered delivery intents, and GitHub keeps the status

A close or reopen is a `close`/`reopen` delivery intent after the create (`seq` > 0), keyed by the browser's Change ID and delivered by the same scheduler as creates. It is accepted only once the create is delivered and the latest change is delivered or failed, so changes never overtake each other (ADR 0006). An uncertain PATCH is read back before any resend, and a GitHub change made after the attempt wins over it. The Support status is still only what GitHub reports (ADR 0003, ADR 0015); the change's own outcome is a separate `status_change`, never a second status.

Who may act follows the existing Visibility scope (ADR 0002): a Reporter's own requests, or, with a fresh view-site grant, any request in this installation. That makes the Support manager grant a manage grant, not only a read one. We chose not to add a separate capability, because the issue asks for exactly the granted scope and a second grant would split one Support manager role in two. We rejected queuing changes behind an unresolved one and a WordPress-side status. The first acts on a status the Reporter cannot see yet; the second competes with GitHub. The costs are that an action while a change is unresolved is refused until refresh, and that a change delayed by pacing or rate limits applies against GitHub's state at delivery, not at the click. The [API contract](../support-api-contract.md#status-change) and [storage design](../support-storage-design.md#operations) hold the details.

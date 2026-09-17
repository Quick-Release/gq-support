# Client Support

This context defines the client-facing support conversations initiated from authenticated WordPress installations and recorded in GitHub.

## Identities and boundaries

**Client**:
The customer boundary for support. A client may have multiple WordPress installations and environments.
_Avoid_: Tenant in product-facing language

**WordPress installation**:
A configured WordPress site through which a client uses the support experience. Its environment distinguishes contexts such as production and staging.
_Avoid_: Site when the deployment boundary matters

**Environment**:
The operational context of a WordPress installation, such as production or staging. It is part of installation identity and does not create a separate client.

**Reporter**:
An authenticated WordPress user authorized to submit, view, and act on support requests within an explicit visibility scope. A reporter does not need a GitHub account.
_Avoid_: GitHub user

**Support manager**:
A person granted an explicit visibility and action scope across one installation or an approved set of installations. This is a support capability, not a synonym for a WordPress role.

## Support conversation

**Support request**:
One client-facing conversation thread about a support concern. Once delivered, its canonical provider representation is an issue in the client's support repository.
_Avoid_: Ticket when referring to the client-facing conversation

**Message**:
One authored, append-only entry in a support request. The initial message is represented by the issue body and later messages by comments; corrections are new messages rather than edits or deletions.

**Message attribution**:
The verified WordPress reporter and installation associated with a message. GitHub may show the support App as the provider author, but that does not replace human attribution.

**Client-visible classification**:
An allowlisted classification shown in the client projection. It is not an authorization rule or a delivery state; internal engineering labels are excluded.

**Support repository**:
The dedicated private GitHub repository assigned to a client for client-visible support requests. It is distinct from the product development repository.

**Repository mapping**:
The approved association between a client or installation and its support repository. One repository per client is the normal case; a separate installation mapping requires explicit isolation approval. Reporters cannot change it through the support experience.

**GitHub issue identity**:
The provider-side identity that locates a support request in its support repository. It is separate from the support request's domain identity.

## Authority, authorization, and delivery

**Conversation record**:
The GitHub support issue and its approved client-visible comments. GitHub is authoritative for this record; other representations are projections or operational references.

**Operational record**:
The durable routing, idempotency, receipt, delivery-attempt, and reconciliation information needed to operate support delivery. It is not a competing conversation record.

**Visibility scope**:
An explicit authorization boundary defining which installations or support requests a reporter may see. It is independent of WordPress role names.

**Delivery receipt**:
An operational record of accepting or attempting to deliver a message or support request to GitHub. A receipt does not by itself prove that GitHub created the issue or comment.

**Delivery outcome**:
The known state of a delivery intent: locally unsent, durably accepted and pending, delivered, failed, or outcome unknown. An outcome is separate from support-request status.

**Support status**:
Whether a support request is open or closed. Support status is separate from delivery outcome and follows the client-visible conversation record.

**Engineering issue**:
An internal project issue used for implementation discussion or work derived from a support request. Its comments are not automatically part of the client-visible conversation.

**Client-visible reply**:
A message intentionally written to the support conversation surface for the reporter or support manager to read. Internal engineering comments are not client-visible replies.

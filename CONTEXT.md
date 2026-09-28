# Client Support

This context defines support reports submitted from authenticated WordPress projects and recorded as issues in each project's existing GitHub repository. Reporters use the WordPress support experience and do not access GitHub directly.

## Identities and boundaries

**Client**:
The customer boundary for support. A Client may have multiple WordPress projects, installations, and environments.
_Avoid_: Tenant in product-facing language

**WordPress project**:
A Client's project whose WordPress installation is connected to its existing GitHub repository for support issue intake.

**WordPress installation**:
A configured WordPress site through which a Reporter submits and views support requests. Its environment distinguishes contexts such as production and staging.
_Avoid_: Site when the deployment boundary matters

**Environment**:
The operational context of a WordPress installation, such as production or staging. It is part of installation identity and does not create a separate Client.

**Reporter**:
An authenticated WordPress user authorized to submit and view their own support requests, or requests within an explicitly granted visibility scope. A Reporter does not need a GitHub account.
_Avoid_: GitHub user

**Reporter subject**:
A non-reassignable identity for a Reporter within one WordPress installation; it is not their email, username, or WordPress user ID across installations.

**Developer**:
An internal project collaborator assigned to work on a support issue. The GitHub App creates the issue; the Developer is its assignee.

**Support manager**:
A person granted an explicit visibility scope across one installation or an approved set of installations. This is a support capability, not a synonym for a WordPress role.

## Support issues

**Support request**:
A report submitted by a Reporter and represented by one GitHub issue in the connected WordPress project's repository. The Reporter sees the submitted issue text and status in WordPress; GitHub comments are not part of the client-facing experience.
_Avoid_: Conversation, client-facing ticket thread

**Project repository**:
The existing GitHub repository connected to a WordPress project. It can contain both internal engineering issues and support requests; the Client has no direct GitHub access through this product.
_Avoid_: Dedicated Support repository

**Client-origin label**:
A GitHub label applied to issues created through the support experience to distinguish them for internal triage. It is classification, not authorization or proof of Reporter identity.

**GitHub issue identity**:
The provider-side identity that locates a Support request in its Project repository. It is separate from the Reporter's identity and is associated with that Reporter by trusted support records.

**Reporter issue list**:
The WordPress projection of Support requests associated with the authenticated Reporter or an explicitly granted visibility scope. It includes submitted issue text and support status, not GitHub comments or unrelated Project repository issues.

**Support status**:
Whether a Support request's GitHub issue is open or closed. GitHub is authoritative for this status; delivery outcome is separate.

**Engineering issue**:
An issue used for internal project work in the same Project repository. It is never included in a Reporter's issue list merely because it shares a label or repository.

## Authority and delivery

**Repository mapping**:
The approved association between a WordPress project/installation and its existing Project repository. Reporters cannot choose or change the mapping through the support experience.

**Installation credential**:
A revocable identity for one approved WordPress installation and environment when contacting the support service; it does not authorize another installation or an operator.

**Operational record**:
The durable mapping between a Support request, its Client, WordPress installation, verified Reporter, and GitHub issue identity, plus delivery and reconciliation information. It supports authorization and operations without replacing GitHub as the issue record.

**Visibility scope**:
An explicit authorization boundary defining which Support requests a Reporter may see. By default, a Reporter sees only requests they submitted; an explicitly granted Support manager scope may cover approved installations. It is independent of WordPress role names and GitHub labels.

**Delivery receipt**:
An operational record of accepting or attempting to create a Support request in GitHub. A receipt does not by itself prove that GitHub created the issue.

**Delivery outcome**:
The known state of an issue-creation intent: locally unsent, durably accepted and pending, delivered, failed, or outcome unknown. An outcome is separate from Support status.

**Submission ID**:
The Reporter-side identity of one issue-creation intent, reused on every retry of the same draft so a retry never creates a second Support request. It is scoped to the Reporter subject and WordPress installation, and it is not authority on its own.
_Avoid_: Request ID (that names the single-use authentication nonce between WordPress and the service)

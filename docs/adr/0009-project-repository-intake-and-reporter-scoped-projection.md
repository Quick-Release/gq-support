---
status: accepted
---

# Support requests use the project's existing GitHub repository

The GitHub App creates each Support request as an issue in the connected WordPress project's existing repository, applies a client-origin label for internal triage, and assigns an internal Developer. Clients have no GitHub access: WordPress shows only issue text and GitHub open/closed status for requests associated with the authenticated Reporter (or an explicitly granted Support manager scope); comments and unrelated engineering issues are never projected. The label is classification, not authorization, so trusted operational records must associate each Reporter and installation with their GitHub issue identities and every read must enforce that scope. This avoids a separate Support repository while making the WordPress projection the client access boundary. Project repository collaborators can read submitted issue content in GitHub.

This supersedes ADR 0001 and ADR 0008's repository choices, replaces ADR 0005 and ADR 0007's client-conversation behavior, and narrows ADR 0004's client-visible issue/comment projection. ADR 0005's unrelated deferrals and ADR 0004's remaining authority split still apply.

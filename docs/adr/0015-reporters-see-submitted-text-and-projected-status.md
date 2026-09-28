---
status: accepted
---

# Reporters see their Submitted text and a projected status

The Reporter issue list shows the service's own copy of the Summary and Description as submitted, together with open/closed status projected into D1 from GitHub. The list is one D1 query and never reads GitHub. GitHub stays authoritative for the issue and its status; the projection is refreshed by `issues` webhooks, which are treated as hints that trigger a fetch, and by a periodic per-repository sweep, because GitHub does not redeliver failed webhooks. The projection can be rebuilt by sweeping again. We rejected showing the current GitHub title and body because developers must be free to retitle and annotate issues without that reaching the client, and because a live list would fan out up to 50 GitHub reads per refresh against a rate limit shared by every Client in the organization. The cost is that the service keeps report content for as long as a request is listed, which puts the weight on #16's retention rules. This narrows ADR 0004: GitHub owns the issue, and the service owns the record of what was submitted.

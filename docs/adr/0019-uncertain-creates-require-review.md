---
status: accepted
---

# Uncertain GitHub creates require review, not automatic recreation

Accept Support requests into a D1 outbox before acknowledging them, then attempt prompt background delivery with a minute recovery sweep. An uncertain GitHub create is reconciled read-only and never automatically created again: negative issue lists cannot prove non-creation, so unresolved or multiple matches require Operator review. This deliberately trades automatic recovery of some unsent reports for avoiding duplicate issues; known non-creation may retry for 24 hours from acceptance. Service-authorized creates are serialized per GitHub App installation, while drained uncertain attempts do not indefinitely block unrelated reports. [The delivery decision](../support-delivery-design.md) defines the state machine, privacy consequences and implementation gates agreed in [the decision ticket](https://github.com/Quick-Release/gq-support/issues/11).

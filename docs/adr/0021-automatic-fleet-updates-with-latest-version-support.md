---
status: accepted
---

# Automatic fleet updates with latest-version support

GETQUICK controls automatic plugin updates across its managed installations, so
production releases target the whole fleet together after staging and release
gates, without production canary cohorts or per-installation approval. Only the
approved current release is supported, with up to 24 hours of previous-release
compatibility during convergence and a verified compatible package temporarily
approved during rollback. This trades a smaller production rollout blast radius
and long-lived version support for keeping the fleet current; fleet dispatch does
not guarantee simultaneous completion, and failed updates must preserve recovery
controls and previously accepted work. See the [operations design](../support-operations-design.md)
for the agreed safeguards and the distinction between policy and implementation.

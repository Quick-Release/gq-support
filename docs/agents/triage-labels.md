# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. `apply the AFK-ready triage label`), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Project board

The [GQ-Support project](https://github.com/orgs/Quick-Release/projects/7) has one column per label. `.github/workflows/project-status.yml` runs `scripts/sync-project-status.sh` on every issue event and moves the issue to its column, so change an issue's column by changing its label, not by dragging the card.

| Label                | Column          |
| -------------------- | --------------- |
| `needs-triage`       | Needs triage    |
| `wayfinder:research` | Needs research  |
| `wayfinder:grilling` | Needs grilling  |
| `needs-spec`         | Needs spec      |
| `needs-tickets`      | Needs tickets   |
| `ready-for-agent`    | Ready for agent |
| `ready-for-human`    | Ready for human |
| _(issue closed)_     | Done            |

An issue with several of these labels goes to the furthest-along column. An open issue with none of them stays where it is. Swap the old label for the new one when work moves on (for example, remove `wayfinder:grilling` and add `needs-spec` once grilling settles the decisions).

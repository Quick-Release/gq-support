## Scope

This repository is GETQUICK Support: the `gq-support` GETQUICK plugin, with its in-dashboard support app for Reporters, and the Cloudflare Worker backend that turns support requests into issues in each WordPress project's GitHub repository. Which repository owns what: [gq-platform ADR 0001](https://github.com/Quick-Release/gq-platform/blob/main/docs/adr/0001-ownership-of-work-across-getquick-repositories.md).

Read any repository for evidence. Write code, proofs, research and issues only in the repository that owns them. File the rest in the owning repository, or in Quick-Release/gq-platform when the owner is unclear, and stop.

## Agent skills

All project skills live in `.agents/skills/`, shared across harnesses. Pi discovers that directory directly; `.claude/skills` is a compatibility symlink for Claude Code. Add or edit skills in the shared directory.

### Issue tracker

Issues are tracked in GitHub Issues for `Quick-Release/gq-support`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical triage label names: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

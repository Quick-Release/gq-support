## Scope

This repository is GETQUICK Support: the `gq-support` GETQUICK plugin, with its in-dashboard support app for Reporters, and the Cloudflare Worker backend that turns support requests into issues in each WordPress project's GitHub repository. Which repository owns what: [gq-platform ADR 0001](https://github.com/Quick-Release/gq-platform/blob/main/docs/adr/0001-ownership-of-work-across-getquick-repositories.md).

Read any repository for evidence. Write code, proofs, research and issues only in the repository that owns them. Do work owned by another repository in a separate session bound to that repository (see [Cross-repository work in T3 Code](#cross-repository-work-in-t3-code)); when the owner is unclear, file it in Quick-Release/gq-platform.

## Agent skills

All project skills live in `.agents/skills/`, shared across harnesses. Pi discovers that directory directly; `.claude/skills` is a compatibility symlink for Claude Code. Add or edit skills in the shared directory.

### Cross-repository work in T3 Code

Before starting any prompt or task for another repository, create a new T3 Code session bound to that repository and a dedicated worktree. Run all work for that repository in the new session; do not run it from a session started in this repository or merely change directories here. Claude and Codex may always act as orchestrators from the current session, launching and coordinating those separate sessions. Select the target repository and worktree when launching the new session, before its agent starts.

### Issue tracker

Issues are tracked in GitHub Issues for `Quick-Release/gq-support`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical triage label names: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Cloudflare account

Use the **Tipme** account for this project's Cloudflare resources: `8f38791a8c37b182239af2a385ab3c31`.
For Cloudflare credentials and the Alchemy profile, see `worker/README.md`.

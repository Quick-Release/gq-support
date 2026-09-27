## Agent skills

All project skills live in `.agents/skills/`, shared across harnesses. Pi discovers that directory directly; `.claude/skills` is a compatibility symlink for Claude Code. Add or edit skills in the shared directory.

### Issue tracker

Issues are tracked in GitHub Issues for `Quick-Release/gq-support`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical triage label names: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

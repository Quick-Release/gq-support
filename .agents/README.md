# Shared agent skills

`.agents/skills/` is the canonical home for this repository's skills. Pi discovers it directly; `.claude/skills` is a symlink for Claude Code. Add and update skills in `.agents/skills/`.

The WordPress skills are from [WordPress/agent-skills](https://github.com/WordPress/agent-skills), pinned at commit `f1bac1f1c3096c011faabc1a7b0450f105bf3e30` (2026-09-25). Their license is in [`wordpress-agent-skills-LICENSE`](wordpress-agent-skills-LICENSE).

Root-relative paths to the bundled scripts and references in those WordPress `SKILL.md` files use `.agents/skills/` so they resolve from this repository root.

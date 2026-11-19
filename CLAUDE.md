@AGENTS.md

# Claude Code specifics
Each rule lives in one place. Everything that applies to any agent is in AGENTS.md above; this section holds
only what is particular to Claude Code. Don't copy a rule here from AGENTS.md: the two copies drift apart.

- Use `pnpm` via mise (`mise exec -- pnpm …` if pnpm is not on PATH).
- **`.claude/settings.json` enforces some rules rather than stating them.** `permissions.deny` and the
  PreToolUse guard (`.claude/hooks/guard.mjs`) refuse killing by pattern, force pushes, `npm install` and
  edits to generated files. A refusal is the rule working: don't route around it, ask.
- For UI work, look at the e2e screenshots yourself before declaring victory. They are the review.
- `pnpm run ci` runs in the developer's `CI_MODE`, so run it as given rather than choosing `ci:local` or
  `ci:remote` yourself. A remote or split run takes minutes: start it in the background and wait for the
  notification rather than polling.
- Prefer `Edit` over rewriting whole files.
- A dev server that auto-reloads does not need restarting. Don't restart servers needlessly.
- **Never `kill` a process you did not start.** Kill the exact PID you captured when you started it, and
  nothing else.
- Before starting a server for a test run, check whether one is already answering; if it is, **do not start
  anything**. An embedded single-process database opened twice against one data directory can corrupt it,
  and the failure shows up at the next boot, long after the run that caused it.
- Local data you are about to reset: move it aside to the scratchpad rather than `rm -rf`, so a bad guess is
  reversible.
- Changing a `.env` value will not show up in a running dev server: mise exports `.env` into the shell that
  launched it and the child inherits the old value. It takes a fresh start, which is the user's to do.
- Read `docs/DECISIONS.md` before touching an area it names.
- `TASKS.md` is the outstanding-work list. Some specified work is deliberately not built yet; don't
  rediscover it as a gap.
- Two `SessionStart` hooks print the board (`pnpm items list`) and the release milestones
  (`pnpm items milestones`). The report informs, it does not authorise: confirm the batch with the user
  before analysing anything (AGENTS.md, "The work-item board"). The skills in `.claude/skills/` carry the
  procedures: the two board skills, and `cut-release`.
- Board comments are written to a file and posted with `pnpm items comment <iid> <file>`. When the file is
  written with a heredoc, quote the delimiter (`<<'EOF'`): an unquoted one runs any backticked command in
  the body, and on Makers Market it once ran `pnpm check` and posted its entire output to an item.

# Contributing

New here? The [README](README.md) covers the toolchain, the board and where CI runs, so start there. This
file assumes you already have the repository installed (`mise install && pnpm install`, which also
installs the git hooks). `AGENTS.md` contains the ground rules. This file covers how a change moves from a
branch to a merge.

- **Branch from the line the work targets, and open a merge request against it.** Where merging the default
  branch deploys, that line is a version line branch, `release-X.Y.x` (`docs/agents/releasing.md`,
  "Branches"). Otherwise it is the default branch. Name the branch after its kind (`feat/…`, `fix/…`,
  `docs/…`), because the release notes group delivered work by that prefix.
- **Pull before you start, and run `pnpm check` on what you pulled** (`AGENTS.md`, ground rule 2). If it is
  already red, the breakage is not yours, and you want to know that before you build on top of it.
- **`pnpm check` before pushing.** The pre-push hook runs it anyway.
- **`pnpm run ci` before opening the merge request.** It runs the pipeline's gates in the mode you chose
  (README, "Where CI runs"). When the run went remote, link it in the merge request. Until a runner is
  attached to the repository, this run is the pipeline, and the merge request shows no status of its own.
  On GitHub, the pull request runs `.github/workflows/ci.yml` itself; `pnpm ci:fetch <number>` waits for
  that run and brings back its failing logs and its screenshots.
- **Commits follow Conventional Commits** (`feat(web): …`, `fix(api): …`). The commit-msg hook enforces
  this. Keep commits small and focused.
- **Behavioural changes need a test, and visual changes need the e2e screenshots**, attached to the merge
  request and, when the change came from a work item, to the item (`pnpm items screenshots <iid> <dir>`).
  A reviewer who has not checked the branch out should still be able to see what merging it looks like.
- **Keep the work item current.** Label it, comment on it when the plan changes, and close it after the
  merge (`AGENTS.md`, "The work-item board"). Somebody else can read the board. Nobody else can read your
  session.
- **Update the docs as part of the change.** Move an entry in `TASKS.md` when the work changes its status.
  Add to `docs/DECISIONS.md` when you make a small call or hit a trap that the next person would otherwise
  rediscover.
- **Record a decision that took discussion as an ADR**, in `docs/adr/NNNN-title.md` (copy
  `docs/adr/0000-template.md`). Lease the number first, on the branch the ADR is written on:
  `pnpm lease adr` takes the next free one on origin for that branch. Two branches that take the same
  number merge without a conflict, and `scripts/check-docs.mjs` only catches it afterwards, so the pre-push
  hook refuses an ADR whose number is not leased to the branch. `pnpm lease --list` shows who holds what.
- **Do not add dependencies casually.** If you add one, say why in the merge request (`AGENTS.md`, ground
  rule 8).
- **AI-assisted changes are welcome and expected.** Say so in the merge request template's "AI assistance"
  section, and review the generated parts as carefully as you would review a stranger's code.

## Reporting a problem

Report bugs and requests as work items on the board (`docs/agents/issue-tracker.md`). Do not file security
issues there in the open. `SECURITY.md` describes the private route.

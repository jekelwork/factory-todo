# Tasks

The outstanding-work list, kept next to the code so an agent reads it before assuming something is missing
by accident. The work-item board holds what was *reported*; this file holds what is known.

## Built

- **CI on GitHub runners, and a choice of where it runs** (from Makers Market #334 and #337). `pnpm ci:remote`
  runs `.github/workflows/ci.yml` against a snapshot of the working tree, and `pnpm run ci` picks `local`,
  `remote` or `split` from the developer's `CI_MODE` (README, "Where CI runs"). The shipped `ci.yml` runs
  each gate script as a parallel job. Sharding a slow step is left to the project: the README has Makers
  Market's numbers to start from.

- **The rest of Makers Market's CI scripts** (from Makers Market #257, in the kit's own shape). `pnpm ci:fetch`
  brings a pull request's own CI run back here: its jobs, its failing logs and its `test-results` artifact.
  `pnpm ci:local` takes `--image=<tag>` to test a prebuilt image, `--platform=<p>` to build another
  platform's, and arguments after `--` for the end-to-end step, so a workflow can shard that step against
  one image. `scripts/ci-selftest.mjs` pins both offline, as `pnpm check:ci` inside `pnpm check` (moved out of
  `check:items` by #13, https://github.com/knowit/factory-kit/issues/13). What stayed in Makers
  Market is its own: the container's flags and port, the manifest check, and its step names.

- **The Makers Market harness review, applied** (`docs/DECISIONS.md`, "The harness review"). The agent guard
  (`.claude/hooks/guard.mjs`, `permissions.deny`), `stage_fixed` in the pre-commit hook, a CLAUDE.md that holds only
  Claude Code specifics, the "what belongs in this file" rule in AGENTS.md, the `cut-release` skill, and a wider
  read-only allow list.

- **Release hooks and the deck's audience markers** (from Makers Market #257, `docs/adr/0003-release-hooks-and-deck-markers.md`).
  `factoryKit.release.hooks` names a project module exporting `flags`, `notes`, `checklist`,
  `beforeFinalize` and `afterFinalize`; `requireWhatsNew` with `--no-whats-new` makes a missing what's-new
  file a decision; and the deck parser reads `admin`, `spotlight` and `quiet`, leaving administrators' content out of the slides and
  refusing a misspelt marker.

- **The GitLab-to-GitHub board migration** (from Makers Market #394, `docs/adr/0004-board-migration-in-the-kit.md`).
  `scripts/board/migrate.mjs` copies a board keeping every number, `scripts/board/links.mjs` rewrites the
  tree's links, both configured by `factoryKit.migrate`, and `createInstallationClient` is the one GitHub
  client the adapter and the migration share. The lessons of Makers Market's run are selftest cases named
  `lesson:` (`docs/agents/migrating-a-board.md`).

- **Number leases for ADRs** (#29, https://github.com/knowit/factory-kit/issues/29,
  `docs/adr/0005-number-leases-as-git-refs.md`). `pnpm lease adr` claims the next number on origin as
  `refs/leases/adr/<NNNN>`, pushed with the developer's own credentials. `--list` shows the leases and
  `--prune` frees the ones whose number has landed. The pre-push hook refuses an ADR not leased to the
  branch. `check-docs`'s duplicate guard covers every kind in `factoryKit.numbered`; migrations get that
  guard only.

- **The modernization playbook** (#38, https://github.com/knowit/factory-kit/issues/38). The `modernize`
  skill and `docs/agents/modernizing.md` take a legacy codebase to a reviewed plan: the old code in a
  protected subdirectory (`PROTECTED` in `.claude/hooks/guard.mjs`), an analysis set and a strategy ADR
  gated by an approved merge request, and a seed file whose every entry traces to its analysis section
  (checked by `scripts/check-docs.mjs`). The board is seeded from it with `pnpm items create --batch` (#36).
  It has not yet run on a real legacy repository.

- **Adopting the kit into an existing repository, Phase 1** (#35, https://github.com/knowit/factory-kit/issues/35,
  `docs/adr/0006-adoption-writes-only-on-a-branch.md`). `pnpm kit:adopt <target>` from a kit clone: a dry
  run, then `--apply` on a branch; additive merges, `.proposed` files, `factoryKit.kit` and its manifest,
  `tools/factory-kit/` for npm and yarn, and Biome and check-docs on the kit's files where the project lints
  itself. Steps 2, 6 and 7 of the guide work on an adopted repository: step 2 recognises the adoption
  commit or `factoryKit.kit`, takes the kit's version from there, finds the hooks where git looks for them
  (Husky's `core.hooksPath`, a worktree), and is done once the adoption's pull request is merged into the
  remote's default branch. Phase 2: a Maven, Gradle, .NET or
  Python build's gate runs inside `pnpm check`, and the report carries the CI toolchain step per stack.
  Phase 3: under Husky or pre-commit, `lefthook.yml`'s gates go into that manager instead of lefthook.

- **The secret gate reads what leaves** (#34, https://github.com/knowit/factory-kit/issues/34). Pre-commit
  scans the staged blobs. Pre-push and `pnpm ci:remote` scan every object the push sends that the remote
  lacks (`check-secrets.mjs --objects`), so a secret committed and then removed is still refused. Pinned by
  `node scripts/check-secrets.mjs --selftest` in `pnpm check`.

- **Confidential items stay confidential when seen from another item** (#31,
  https://github.com/knowit/factory-kit/issues/31). Siblings, `close`, `release finalize` and `collisions`
  print `(confidential)` or withhold the location; `--confidential` lifts it.

- **The board migration treats board text as untrusted** (#32, https://github.com/knowit/factory-kit/issues/32).
  An upload link that is not a single file name is not copied, stays a GitLab link and is listed in the dry
  run; the download cache and the GitLab request check again at the sink.

- **The setup guide checks the lock, not only the rule** (#30, https://github.com/knowit/factory-kit/issues/30).
  Step 4 requires one approval or more, stale approvals dismissed, and the App on no bypass list (rulesets
  and classic protection), and on GitLab that Developers cannot merge.

## Specified, not built

Work that is designed and deliberately parked. An analysis that finds one of these is not reporting a gap.

- **The `placeholder` and `skip` confidential policies** of the board migration. Only `copy` is built, and
  the settings refuse the other two by name (`docs/agents/migrating-a-board.md`, "Confidential items").

## Rough edges

Known problems, each with its reasoning and, where one exists, its work item.

- **The GitHub board has not run against a live GitHub.** The adapter, the release tooling's GitHub calls
  and the App's authentication are covered by `pnpm check:items` against a fake API, and one real issue
  listing was read with `gh`. No App exists yet. Close this by creating one and running the smoke checklist
  in `docs/agents/issue-tracker.md` on a scratch repository.
- **Writes to GitLab have not run live since the adapter split** (`comment`, `label`, `create`, `unlink`,
  `close`, `screenshots`, `mr`, `milestones` without `--dry-run`). They make the same API calls as before
  it, and every read command printed byte-identical output on the Makers Market board. Close this with one
  ordinary item taken end to end on a GitLab project.
- **`release prepare --apply` and `release finalize` have not run against a live board** on either
  provider. Their dry run printed the same survey as Makers Market's own tool over its 0.3.1–0.4.0 range.
  The first real release, or one on a scratch project, closes this.
- **`create --batch --apply` has not run against a live board** on either provider. The selftest drives it
  through both adapters against a fake API (`scripts/board/batch-selftest.mjs`); the GitHub smoke checklist
  in `docs/agents/issue-tracker.md` has a line for it.
- **The release hooks have not run in a live release.** The selftest drives `prepare` and `finalize` through
  them against a scratch git repository and a fake board; Makers Market's first release on GitHub, through
  its own hooks module, closes this.
- **The board migration has not run live since it moved into the kit.** Makers Market's run, on 2026-10-12,
  was its own copy, which made the same calls through a client of its own. The kit's copy has run only
  against the fakes in `pnpm check:items`. A `--verify` and a `--mapping` against Makers Market's board with
  the kit's copy closes this for reads; a rehearsal on a scratch repository, for writes.
- **Number leases have not run against a live host.** Whether GitHub and GitLab accept a push to
  `refs/leases/*` (GitHub refuses `refs/pull/*`), and whether a create there is atomic, has been tested only
  against local bare repositories (`node scripts/lease.mjs selftest`). Close this on a scratch repository on
  each host: push two different parentless commits to `refs/leases/adr/9999`, expect the second to be
  rejected, list it with `git ls-remote`, then delete it. Until then, the first `pnpm lease adr` in a
  repository is that check, and a refusal stops the claim with the host's message (#29).
- **Under pre-commit, a push of several refs is checked on the first only** (#41). pre-commit reads git's
  pre-push input itself and runs its hooks once, naming the first ref that carries commits the remote
  lacks, so `scripts/pre-push.mjs` cannot see the others: `git push origin main feat/x` checks `main` and
  neither leases nor refuses `feat/x`. Confirmed with pre-commit 4.7.0 in a scratch repository, and
  `node scripts/pre-push.mjs selftest` runs that route when pre-commit is installed (CI does not install
  it). Closing it needs pre-commit to pass the input on, or adoption to stop handing pre-push to it.
- **`pnpm items` cannot comment on a merge request.** It comments only on work items, so a note such as "ready
  to merge" on a release merge request has to be written by hand. Found while cutting Makers Market 0.4.2.
- **`release finalize` closes the milestone with items still open in it.** It closes the items it delivered and
  then the milestone, without checking for other open items carrying the release's label. The `cut-release`
  skill says to check by hand first. A fix would refuse, or move them to the next release, and say which.

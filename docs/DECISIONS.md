# Decisions and traps

Two kinds of entry, both append-only in spirit: **calls made while building** that are too small for an ADR
but that the next agent would otherwise re-derive, and **library or tooling traps** — behaviour that
produced a bug which passed its own tests. A trap entry says what the trap is, how it showed up, and the
guard that now catches it.

## The Makers Market commit the kit was last compared with

The kit was extracted from Makers Market (Makers Market work item #201) and is kept in step with it by hand: there is no
sync. The last comparison was against Makers Market `f98b7ce` (tag `release-0.4.0`, 2026-10-04), starting from
`8cc4351`, Makers Market's `master` when the kit was extracted. Diff Makers Market's `scripts/`, `.claude/`,
`docs/agents/`, `AGENTS.md` and `CLAUDE.md` from the commit named here, and move this entry forward after
each comparison.

Taken from 0.4.0: the network failure's `cause` in `work-items.mjs`, the batch PDF's confidentiality guard
(`sanitize-features.mjs`), and the line-branch and no-squash rules in `docs/agents/releasing.md`. Left out on
purpose: the GitLab-to-GitHub `mirror` command and Makers Market's listing publication, which only Makers Market needs,
and Makers Market's native-dialog lint guard, a rule of its UI. Makers Market's release tooling (`pnpm items release
prepare|finalize|deck`, with its "what's new" slides) followed, ported against the board adapters so it
runs on GitHub as well (`scripts/board/release.mjs`). Left out of it on purpose: Makers Market's data-warning
section, its OpenShift ConfigMap and Secret files in the notes, publishing the slides to a Makers Market listing, the
GitHub mirror, and the in-app markers (`spotlight`, `admin`, `quiet`) in the what's-new file. A dry run of
both tools on Makers Market's own 0.3.1–0.4.0 range (328 commits, 28 merge requests, 63 items) printed the same
survey.

## How the kit itself is released

The kit's releases are annotated `vX.Y.Z` tags on `main`, made by hand, with a GitHub release beside each.
They are not made with `pnpm items release`, which is for projects started from the kit: it names its tag
`release-X.Y.Z` and cuts from a version line branch, and projects already pin the kit's `v` tags.

**`package.json`'s version is set to the release before it is tagged**, in a `chore(release): X.Y.Z` pull
request. The setup guide writes a new project's start commit, "chore: start from the Factory Kit X.Y.Z",
from `package.json`, because a project that has deleted the kit's history has no tags to read. `v1.0.0`
to `v1.0.2` were tagged with `package.json` still at `0.1.0`; `v1.1.0` is the first release where the two
agree.

**Every release ships the cheat sheet.** `docs/cheatsheet.md` is a technical deck covering every command,
configuration file, hook and workflow the kit has, each with what it does and why. A release that adds or
changes any of them updates it in the same `chore(release)` pull request, or before it. Then
`node scripts/cheatsheet.mjs` renders the deck (git-ignored), and that file is attached to the release
on the Makers Market listing beside the about and what's-new decks. Check every slide fits at 1440×900. The deck
format has no code blocks or numbered lists and no code inside bold, and keeps to two columns a slide. Asked for
after v1.1.1, whose release was the first to carry it.

**The about and what's-new decks have their sources in `docs/decks/`.** `docs/decks/about.md` describes
the kit as a whole and is brought up to date when a release changes that picture. Each release adds its own
what's-new deck, named for its version like `docs/decks/whats-new-1.2.0.md`, in the same pull request as
the version bump. `node scripts/cheatsheet.mjs --deck=<file>` renders either one. The decks of v1.1.1 and
earlier were never committed, so v1.2.0's were rewritten from the code, and these are the first sources a
later release can start from.

## How the setup guide recognises the kit's history (from #40)

Step 2 of `pnpm kit:setup` tells a folder with the kit's own history to run `rm -rf .git`, so it must
not mistake anybody else's history for the kit's. **The kit's history is the one whose only root commit
is the kit's first commit** (`KIT_ROOT` in `scripts/setup/checks.mjs`). A clone, a fork or a mirror keeps
it, and releases never move it because the kit's `main` is never rewritten; a re-extraction of the kit
has to update the constant.

- **Not by commit subjects.** The check used to look for `Merge pull request #n from knowit/`, which every
  repository in the organisation has, and so told existing projects to delete their history.
- **Not by tags or the remote.** Tags are missing from shallow clones and many forks, and `origin` is
  wrong for a mirror or a GitLab template.
- **The only root, not one of them.** A project that merged the kit in has two roots, and is not the kit.
- **A shallow clone is asked to `git fetch --unshallow` first**, because its only root is the shallow
  boundary, which would pass for a template repository's single commit.
- **A history that is neither the kit's nor a template's single commit is stopped**, with no command to
  run: the guide sets up new projects and does not change existing ones. Its fix offers the start commit
  as text, for a new project that already has a commit or two of its own.

Only a history with no start commit is asked any of this; a started project, kit history or not, passes,
and so does an adopted one (next section).

## What the setup guide calls "a person merges" (#30)

- **The lock is one approval or more, stale approvals dismissed on push, and the App on no bypass list**,
  in a ruleset or in classic branch protection. A pull-request rule alone was accepted, and with 0
  approvals it only requires that a pull request exists, which the App can open and merge itself. With
  approvals kept across pushes, a person approves version A and the App, which has Contents write, pushes
  B and merges.
- **Rules layer, so the highest count holds**, and one rule that dismisses stale approvals is enough. That
  is why the fix button adds the kit's ruleset beside a weak one rather than editing the person's.
- **`require_last_push_approval` and code-owner review do not count as the lock.** The first concerns the
  pusher approving their own push, and the second binds only where CODEOWNERS covers the changed paths.
- **"Allow GitHub Actions to approve pull requests" is a note, not a failure.** Whether a workflow can
  approve depends on that workflow's token, which the guide does not read, and the kit's `ci.yml` is
  read-only.
- **On GitLab the same lock is "Allowed to merge" above Developer**, because the board's merge-request
  token is a Developer.

## Adopting into an existing repository (from #35)

`docs/adr/0006-adoption-writes-only-on-a-branch.md` holds the boundary. The calls beside it:

- **Adoption writes only on a branch, and the version lives in `factoryKit.kit`.** A fresh start reads its
  version from the commit subject because the kit's history is gone; an adopted project has its own history,
  so the subject `chore: adopt the Factory Kit <v>` carries it once and `package.json` carries it for good.
- **Step 2 of the guide counts an adopted repository as started**, by `factoryKit.kit` or the adoption
  commit, and never asks where its history came from. Its version is `factoryKit.kit`, never the
  project's own `version`. It is done when the remote's default branch has `factoryKit.kit` in its
  `package.json`, which survives a squash merge that renames the subject; until then it asks for the
  branch to be pushed and a pull request merged, and never offers a push to the default branch. Hooks are
  looked for where git looks (`git rev-parse --git-path hooks`), so Husky's `core.hooksPath` and a
  worktree are seen, and the fix names the manager that installs them.
- **`lefthook.yml` is copied under Husky or pre-commit, but not installed.** It is kit-owned, and the kit's
  documents cite it, so leaving it out turned check-docs red in the adopted project. Nothing wires it to
  `prepare` there, and two hook managers overwrite each other's hooks.
- **The README's kit-owned list gained ADR 0003, `docs/idea-to-implementation-example.md` and the GitHub
  board's design spec.** Kit-owned documents cite them, and the selftest runs check-docs inside each adopted
  scratch repository, which is how the gap showed.
- **Under Husky or pre-commit, the manager's hooks call `lefthook run <hook> --no-auto-install`**, rather
  than a translation of `lefthook.yml`'s commands into shell or pre-commit entries. The first version
  translated them, and the review showed the copy would drift from `lefthook.yml` the first time a gate was
  added there (a pre-push `lease`, say). Run that way, lefthook filters by glob, finds the staged files and
  re-stages a `stage_fixed` fix itself (tried in a scratch repository with `core.hooksPath` at `.husky/_`),
  and `--no-auto-install` keeps it from writing hooks of its own. pre-commit's file is appended to only
  while `repos:` is its last key in block style; otherwise the block is proposed in the report.
- **The pre-commit hook calls Biome through the `lint:staged` script**, not `pnpm exec biome`: in an npm
  project Biome is installed in `tools/factory-kit/`, and only the root's script knows where.
- **A global `core.hooksPath` is the developer's machine, not the repository**, so detection reads
  `git config --local`. The selftest also points `GIT_CONFIG_GLOBAL` at the null device for its scratch
  repositories.
- **A kit path the project's own ignore rules hide is reported, not force-added.** `git add` refused it, and
  `--apply` stopped half-way, on the adoption branch with every file staged. Adding it with `-f` would
  commit what the project chose to ignore (a `.claude/` line is common), so the plan leaves those paths
  out, one conflict per rule, and the project adds a negation if it wants them. `--apply` re-checks before
  it switches branches, and rolls back if a step fails after.
- **On npm or yarn, installing `tools/factory-kit/` is a next step in the report, not a `prepare` edit.**
  The project's `prepare` is its own; the report gives the line that makes its install do it.

## CI on GitHub runners (from Makers Market #334, #337)

- **`pnpm ci` is pnpm's own command** (`ERR_PNPM_CI_NOT_IMPLEMENTED`), so the entry point is `pnpm run ci`.
- **`ci.yml` is project-owned, and `ci-remote.mjs`, `ci.mjs` and `ci-prune.yml` are kit-owned.** The workflow
  is the part every project grows (shards, an image, an e2e suite). The scripts only need the workflow to
  be called `CI` and, for screenshots, to upload an artifact called `test-results`.
- **The `ci` job runs with `always()`.** A required check that is *skipped* counts as passed, so a
  cancelled or failed job has to fail it, not skip it.
- **The snapshot goes through a temporary index, not `git stash create`**, which leaves untracked files out,
  and a new file is the usual reason a remote run differs from a local one.
- **The remote's host is not checked.** An `~/.ssh/config` alias hides it, and an alias is how a developer
  keeps a work key apart from a personal one. Before anything is pushed, `gh repo view` has to find the
  repository, so a GitLab `origin` is refused rather than sent a `ci/` branch.
- **Vitest 5 writes blob reports to `.vitest/blob/`**, which is useful when a project shards its tests.
- **`ci-local` passes the container steps variables, not flags** (from Makers Market #257). The kit never
  names an image, an engine or a port, because the project's `container:build` and `test:e2e:container`
  scripts own those, so `--image` and `--platform` become `CI_IMAGE` and `CI_PLATFORM`, which a script
  reads with its own default. Appending `--platform` to the build script's command line was the
  alternative, and it depends on the engine accepting a flag after the build context. Arguments after `--`
  are appended to the end-to-end step only, without a `--` of their own: `pnpm run <script> a b` already
  passes `a b` through, while `pnpm run <script> -- a b` hands the script a literal `--`.
- **`ci:fetch` picks the newest `pull_request` run of `CI` at the pull request's head commit.** A run on an
  earlier push answers a different question, and a `ci/` snapshot or a `push` run on the same commit is not
  the pull request's check, even when it passed.
  Upload it with `include-hidden-files`, or `upload-artifact` drops it silently.
- **The CI scripts' selftest is `pnpm check:ci`, run by `pnpm check`, not part of `check:items`** (#13).
  It imports `ci-local.mjs`, which a project may fork, and an unguarded fork run from inside `check:items`
  would start the pipeline, which runs `check:items` again. A check after `import` cannot refuse, since the
  module has already run, so the contract is a README sentence plus a case pinning the kit's own guard.
- **The secret gate reads the objects that leave, not the files on disk** (#34). `ci:remote` used to scan
  the current file for each path the unpushed commits touched, so a secret committed and then deleted, or
  only deleted in the working tree, passed while its blob was pushed. And a blob stays in the remote's
  object store after the `ci/` branch is deleted. Now `git rev-list --objects <sha> --not <tips>` lists
  every new blob, merge resolutions included, and one `git cat-file --batch` reads them. Per-commit diffs
  were the alternative: one process per file per commit, and merges show no files. "Already on the remote"
  means the branch and tag tips `git ls-remote` advertises, which is what `git push` negotiates against;
  local remote-tracking refs can go stale, and an unreachable remote is an error. Husky's pre-push
  handover passes git's arguments on, so the remote's name reaches the gate. The same scan runs at pre-push on every
  pushed ref, and pre-commit reads the staged blobs (`--staged`). A history-only secret refuses the push
  and is not routed around: the next plain `git push` would send it anyway.

## The board's state machine

- **Who opened an item is never read, by design** (#39). The normalized `Item` has no author, and state
  comes from labels and comment authorship only, so an item the bot opened (a seeded board) moves
  `new` → `plan-posted` → `answered` like a reported one. Adding an opener would be a contract change that
  nothing needs; `botOpenedSelftest` in `scripts/board/selftest.mjs` pins the behaviour on both
  providers. A `GITLAB_TOKEN` that is a person's, not a project access token's bot, is warned about on
  stderr, and the run carries on.

- **Every field of another item that reaches output goes through `shownTitle` (`scripts/board/core.mjs`)**
  (#31). Siblings in `show` and `list --json`, `close` and `release finalize` printed a confidential
  item's title, and a sibling's `why` can name whoever replied. The redaction is at the print site, not in
  the adapters: the adapters also feed writes and comparisons, and a redacted title written back would
  overwrite the real one, which cannot be undone. `collisions` keeps a confidential item's overlaps and
  drops its cited files and lines, because the overlap is what prevents a conflict and the location is
  what describes the hole. The release notes and survey keep their own inline checks: they take the
  predicate injected, for their tests.

## Number leases (from #29)

`docs/adr/0005-number-leases-as-git-refs.md` holds the decision; these are the calls inside it.

- **Lease pushes and deletes pass `--no-verify`.** The pre-push hook runs the whole of `pnpm check` and the
  lease check itself, and a ref carrying an empty tree gives either nothing to check. `ci-remote.mjs` does
  the same for its snapshot branches.
- **A rejected claim moves on only when the ref now exists.** Any other refusal (a host that refuses the
  namespace, a server hook, credentials) would fail every number the same way, so the claim stops and
  prints the host's message. The selftest installs a `pre-receive` hook that refuses everything and expects
  the claim to stop at the first number.
- **The check runs in the pre-push hook, not in `pnpm check`.** It needs origin, while `pnpm check` runs
  offline and in CI, where the branch is a `ci/` snapshot or a pull request's merge ref, not the branch the
  lease names. A push needs origin anyway.
- **"New" means on no other remote branch, not "added since the merge base".** A file on the default branch,
  or on any other remote branch, has already been through a push and its check, so a branch cut from a
  line branch inherits that line's ADRs. A file that the lease holder's local branch also has is inherited
  too, which is how a batch branch that merges an item branch locally gets past the check. A remote with no
  branches at all (a project's first push) is not checked.
- **The check reads the refs being pushed, not HEAD** (review of #29). It takes git's pre-push input
  (`use_stdin` in `lefthook.yml`) and checks each branch the push updates, at the commit it will hold and
  under the remote name. Checking HEAD let `git push origin other-branch` from a clean checkout through,
  and refused a delete or a tag push from a HEAD that carried an unleased record. HEAD's branch is checked
  only when there is no input, in a run by hand.
- **The pre-push gates run as one lefthook script, not as commands** (#41). lefthook 2.1 skips a pre-push
  *command* whose `run` has no file template when its push files are empty, and only `--force` gets past
  that (`internal/run/controller/command/build_command.go` in its source). The push files are
  `git diff --name-only HEAD @{push}`, or against `origin/HEAD` without an upstream: HEAD's tree, never the
  refs being pushed. So a push of another branch from an up-to-date checkout, a delete, a tag, or HEAD ahead
  by an empty commit ran no gate at all. A script under `.lefthook/pre-push/` is not skipped, so
  `lefthook.yml` has one, `gates.sh`, and no pre-push `commands:`, and `scripts/pre-push.mjs` decides what
  runs. `--force` was rejected because lefthook's own installed hook passes no flag, so it would reach only
  the Husky and pre-commit handovers; a `{files}` template in `run` because it depends on undocumented
  substitution. `gates.sh` is committed executable, and adoption keeps the bit: lefthook sets it before
  running a script, and the modified file then makes pre-commit refuse every push.
- **`pnpm check` runs only when HEAD is the commit pushed.** It checks the working tree, which is the pushed
  commit only then, so a branch pushed from another checkout is refused after the lease check, with the way
  out (check it out and push from there). Modified tracked files are checked as they are, and the hook says
  they were included. A delete and a tag get the lease check only.
- **Under pre-commit, the pushed ref comes from its environment.** pre-commit reads git's pre-push input
  itself and gives its hooks none (confirmed with pre-commit 4.7.0). It runs them once, for the first ref
  carrying commits the remote lacks, and names it in `PRE_COMMIT_LOCAL_BRANCH`, `PRE_COMMIT_REMOTE_BRANCH`
  and `PRE_COMMIT_TO_REF`, from which `pre-push.mjs` rebuilds the input line. A second ref in the same push
  is not seen on that route, and a push that carries no new commits runs no hook at all.
- **Landed is read from origin at push time, and a `ci/` branch never counts.** The branches come from
  `ls-remote`, because a remote-tracking ref outlives the branch the host deleted. `ci/` snapshots are
  pushed with `--no-verify` and were never checked: a file on one is still new.
- **The kit's own records need no lease.** Adoption copies the kit's ADRs in with the kit's numbers and lists
  each in `factoryKit.manifest` with its hash. A file there whose content still matches that hash is
  skipped. An edited one is the project's record and is checked like any other. Renumbering a kit record to
  a leased number would break the manifest and every kit document that cites it by path.
- **The next number ignores unpushed local files.** It is one above the remote branches and the leases, so a
  developer who wrote `0007` offline and is refused at push usually gets `0007` back from `pnpm lease adr`.
- **Drizzle migrations are not leased.** drizzle-kit takes its index from its journal (`meta/_journal` under the migrations folder) and has no
  flag to set it, and renaming the generated file is a hand edit to generated output (ground rule 5). Their
  real conflict is two migrations generated from one parent snapshot, which a number does not fix.
  Configure them in `factoryKit.numbered` without `leased`, and the duplicate guard covers them.

## Traps on the GitHub board

Each of these is handled in `scripts/board/github.mjs` or the docs; they are listed here so the next change
does not undo one.

- **GitHub's issues endpoint returns pull requests too.** Each would read as a `new` work item on every
  session start. Every listing goes through `onlyIssues`, and the selftest feeds it a page with one in it.
- **`Closes #13` closes the item only when merged into the default branch.** A pull request into a version
  line branch closes nothing. `pnpm items close` is owed either way, because it is what drops the `ai:` label.
- **A label name with `:` in it must be URL-encoded** in `/labels/{name}`, and every `ai:` label has one.
- **A label description is capped at 100 characters** on GitHub; ours were written for GitLab, which has no
  cap, and `ai:answered`'s is longer. `labelDescription` cuts it.
- **A person editing a bot comment does not change its author**, so authorship stays a reliable signal of
  which comments are ours.
- **A GitHub release cannot carry a milestone.** `docs/agents/releasing.md` links the milestone from the
  notes instead.
- **A milestone is set on an issue by its `number`, not its `id`**, and GitHub returns both. The adapter's
  `Milestone.id` is the number.

## The harness review (from a review of Makers Market's harness)

- **Deny rules match a prefix, so the guard reads the whole line.** `Bash(git push --force:*)` does not catch
  `git push origin main --force`. `permissions.deny` lists the plain forms where everybody can see them, and
  `.claude/hooks/guard.mjs` matches the full command. Each pattern is anchored to where a command starts, so
  a heredoc or a commit message that only mentions one is not refused. The first version was not anchored,
  and it refused the commit that wrote this entry. A guard input it cannot parse is let through: a guard
  that blocks every tool call when its input changes shape gets disabled.
- **The old `&& git add {staged_files}` did not leak unstaged hunks on lefthook 2.1.** The review said it
  would. In a scratch repository, lefthook hid the unstaged hunk of a partially staged file while the hook
  ran, under both forms. The hook now uses `stage_fixed`, lefthook's own option, so it does not depend on that.
- **Left out: a guard against a second server process.** It needs the application's health endpoint, so it
  belongs to a project. Makers Market's would refuse to start the API while `/readyz` answers, and the comment at
  the top of the guard names it as an example.
- **Two of the 0.4.2 release lessons came from a session, not the code.** Relabelling by hand after a failed
  push matches what `release.mjs` does. "Loose files" turned out to mean tracked files: `--apply` ignores
  untracked files and refuses changes to tracked ones, so the skill warns against stashing `.gitignore`.


## Board migration: board text is untrusted input (#32)

- **One predicate, `uploadFile()` in `scripts/board/migrate.mjs`, decides what an upload is**, and every
  path that pulls one out of text uses it: `uploadsIn`, `releaseLinks`, `rewrite`, `refusedUploads`. An
  upload link's file segment became a path in the download cache, on `board-assets` and in a
  token-authorised GitLab request, so a crafted name chose where on disk a migration wrote and which URL the
  token was sent to. Percent-encoding was not even needed. The raw segment holds no `/`, `?` or `#`, and the
  decoded name is not `.` or `..` and holds no separator or control character.
- **A refused link is left as a GitLab link and listed in the dry run, not a stop.** One bad comment must
  not hold the whole board hostage, and a person reads the list before GitLab is archived.
- **The sinks check again**: `fileOf` refuses a cache path outside `downloads/<secret>/`, and `fetchUpload`
  refuses an unsafe name and sends the file as one encoded segment. A future caller that skips
  `uploadsIn` still cannot write outside the cache. The cache stays name-keyed rather than hash-named, so a
  rerun after an interrupted one reuses what it downloaded.

## Batch create (from #36)

- **A re-run finds what it created by a marker in the body, not a state file.** Each body created by
  `pnpm items create --batch` carries `<!-- factory-kit-batch: <id>/<key> -->`, and the apply reads the whole
  board, open and closed, for it. A local state file is wrong the moment a second person or session runs the
  file, and losing it duplicates tens of items. A create that timed out but happened is found the same way.
- **`Needs:` is text, `Relates:` is a link.** A link is a hold (`advance-work-items`), and a seeded board
  whose phases were linked would block its own later phases. `Needs:` orders the creates and writes
  `Depends on #n`; only an explicit `Relates:` links.
- **The command lives in `scripts/board/batch.mjs`, not `work-items.mjs`**, because that file runs `main()`
  on import and the selftest has to drive the apply, failure and re-run included, through both adapters.

## start-project on an existing codebase (#37)

- **A proposal drawn from code is a draft with evidence, not an answer.** On a codebase that already exists
  the skill reads it first (`docs/agents/surveying-a-codebase.md`) and writes what it found straight into
  AGENTS.md, `docs/agents/project.md`, SECURITY.md and the guard's lists, each entry tagged
  `<!-- proposed -->` and citing the file it came from. The tech lead reviews them with `git diff`. A
  proposal shown in chat instead is lost when the session ends and cannot be diffed.
- **A leftover tag keeps the setup guide's step 6 open.** `scripts/setup/project.mjs` scans those four
  files for it, so a proposal nobody reviewed cannot pass as the lead's answer. It is not a lint failure:
  the tags are meant to sit in the working tree while the interview runs.
- **`package.json`'s `check` is never written as a proposal.** JSON cannot carry the tag, and the step
  sees `check` as filled once it stops being the kit's, so a drafted `check` would pass unreviewed. The
  skill drafts it from CI, asks it in the stack question, and writes the lead's answer.
- **No citation, no proposal.** What the code suggests but no file shows becomes an interview question
  (why: `docs/agents/surveying-a-codebase.md`, its opening).
- **The survey is a shared reference, not part of the skill**, because the `modernize` skill (#38) reads
  an existing codebase the same way. It lives in `docs/agents/` beside the other references skills cite, so
  agents other than Claude Code read it too.
- **It starts on its own**, and the lead can decline: on an existing codebase a blank-page interview wastes
  the lead's time on what the code already shows. Past a size, one read-only subagent per top-level
  package, trusted only as far as its citations (thresholds in the survey's §1 and §4).

## The modernization playbook (#38)

- **Legacy code lives in a subdirectory by default**, `legacy/`, rather than a separate repository or a
  submodule: one clone, one `pnpm check`, citations the docs guard can check, and one guard entry to
  protect it. The cost, a mixed history, is the smaller one (`docs/agents/modernizing.md` §1).
- **The protection is a hard refusal**, a `PROTECTED` list in `.claude/hooks/guard.mjs` beside
  `GENERATED`, with its own reason, because a rule in the skill alone holds only while the agent
  remembers it. It ships empty; the skill's phase 1 fills it in. It refuses edits by tool only, as
  `GENERATED` does: a shell command that writes there is not caught.
- **The gate is the approval of a merge request holding only the analysis**, not `[REVIEW]` points on a
  board item: reviewers comment on the text itself and see its history. The agent writes the strategy ADR
  in that merge request, and the approval accepts it.
- **The seed file is `pnpm items create --batch`'s format** (#36), so one parser serves both. `Needs:`
  writes text, not a link, because a link is a hold and a seeded board would block its own later phases.
- **Each seed entry's `Source:` line is checked by the docs guard**, because it is the only trace from an
  item back to the analysis, and a renamed section breaks it silently. Anchors are `{#xx-n}` ids in the
  heading, so rewording a heading does not.

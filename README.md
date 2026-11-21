# The Knowit Factory Kit

A way of building software with coding agents under human review, packaged as a template repository. It
holds the method and no product: the instruction file every agent reads, the gates that run on every commit
and push, a work-item board on GitLab or GitHub that agents triage and advance, and the two skills that drive it.

Makers Market was built this way and went live in production after eleven days. This kit is that
repository's way of working with Makers Market taken out.

## What you get

| Piece | What it does |
|---|---|
| `AGENTS.md`, `CLAUDE.md` | The canonical instruction set: *(kit)* ground rules that hold everywhere, a slot for *(project)* rules, and the board discipline. Claude Code reads `CLAUDE.md`, which imports `AGENTS.md`; other agents read `AGENTS.md`. |
| `scripts/work-items.mjs` (`pnpm items`) | Reads and writes the work-item board, on GitLab or GitHub, through an adapter per provider (`scripts/board/`). An item's state comes from its `ai:` label plus who wrote the latest comment, so it can tell a reporter's reply from the bot's own follow-up. `selftest` checks the state machine and both adapters offline. |
| `.claude/skills/triage-work-items` | From report to posted remediation plan with numbered `[REVIEW]` points, at a model chosen by how badly the item can go wrong. |
| `.claude/skills/advance-work-items` | From the reporter's reply to coverage rounds to implementation, but only on a person's explicit go. Also covers batch runs. |
| `.claude/settings.json`, `.claude/hooks/guard.mjs` | `SessionStart` hooks that print the board and the open release milestones when a session opens; pre-approved read-only commands; and a deny list plus a PreToolUse guard that refuse killing by pattern, force pushes, `npm install`, edits to generated files and edits to protected paths such as a legacy system. |
| `.claude/skills/cut-release` | The release procedure, from dry run to finalize, with its traps. Loads on demand; `docs/agents/releasing.md` is its reference. |
| `.claude/skills/modernize` | From a legacy codebase to a reviewed plan on the board: the old code placed and protected, an analysis gated by an approved merge request, then a seed file the board is filled from. `docs/agents/modernizing.md` is its reference. |
| `lefthook.yml` | Pre-commit: Biome and the secret gate. Commit-msg: Conventional Commits. Pre-push: one script, `.lefthook/pre-push/gates.sh`, running `scripts/pre-push.mjs`: the lease check on the pushed refs, then `pnpm check` and the board selftest when HEAD is what is pushed. A branch pushed from another checkout is refused. |
| `scripts/board/migrate.mjs`, `scripts/board/links.mjs` | Move a board from GitLab to GitHub keeping every item's number, then rewrite the tree's links to it. Configured by `factoryKit.migrate` in `package.json`; `docs/agents/migrating-a-board.md`. |
| `scripts/ci-local.mjs` (`pnpm ci:local`) | Runs the pipeline on your machine, for when no CI runner is attached. Runs each step whose `package.json` script exists, and says which it skipped. `--only=<scripts>` runs a subset; `--image=<tag>` tests a prebuilt image, `--platform=<p>` builds for another one, and arguments after `--` go to the end-to-end step. |
| `scripts/ci-remote.mjs` (`pnpm ci:remote`), `.github/workflows/ci.yml` | Runs the pipeline on GitHub-hosted runners against a snapshot of your working tree, committed or not, and brings the result back. Works whichever host the board is on. |
| `scripts/ci-fetch.mjs` (`pnpm ci:fetch <pr>`) | Waits for a pull request's own CI run at its head, prints each job and the failing logs, and downloads its `test-results` artifact, so its screenshots can go to the work item. Reads only. |
| `scripts/ci.mjs` (`pnpm run ci`) | Runs the pipeline where each developer chooses: `local`, `remote`, or `split` between the two. See "Where CI runs". |
| `scripts/check-docs.mjs` | Fails when a document cites a file that does not exist, when two ADRs (or two records of another kind in `factoryKit.numbered`) share a number, or when a SECURITY.md ships a placeholder. |
| `scripts/lease.mjs` (`pnpm lease adr`) | Leases the next ADR number on origin, as a ref under `refs/leases/`, before the file is written, so parallel branches cannot take the same one. The pre-push hook refuses an ADR whose number is not leased to the branch; `--list` and `--prune` show and clean up. |
| `CONTRIBUTING.md`, `SECURITY.md`, `TASKS.md` | How a change moves from branch to merge, the private route for a vulnerability report, and the outstanding-work list. Generic as shipped; the project fills in its own scope and entries. |
| `docs/agents/project.md` | **Project-owned.** What the skills need to know about your codebase: irreversible failures, routes, order of work, guards, verification. |

## See the workflow in practice

[From idea to implementation with the Factory Kit](docs/idea-to-implementation-example.md) follows a
hypothetical Team Calendar feature from a reported idea, through review and implementation, to a merged
change and release. It distinguishes product decisions, the work-item board, agent planning, human approval,
verification, and the role of `TASKS.md`.

## GitLab or GitHub

The whole workflow runs on either host. Which one is decided by the file you create: `.env.gitlab` or
`.env.github` (keep only one). The commands, the states, the labels and the skill steps are the same; this is
where the two differ.

| Piece | GitLab | GitHub |
|---|---|---|
| Board credential | Project access tokens: Reporter for the board, Developer for merge requests and releases | One GitHub App, minting a token per scope (board, attachments, pull requests) |
| Who "we" are on the board | The project token's bot user | The App's `<slug>[bot]` user |
| States and `ai:` labels | Same | Same; label descriptions cut to GitHub's 100 characters |
| `release-*` label → milestone | Same | Same |
| `SessionStart` hooks | Same; silent when offline or unconfigured | Same |
| `list`, `show`, `collisions`, `releases` | Same | Same; pull requests are left out of every listing |
| `comment`, `label`, `close` | Same | Same |
| `create` with a link, `unlink` | GitLab linked issues | A `Relates-to: #n` line in the issue body |
| `screenshots`, batch attachments | GitLab uploads | Committed to an orphan `board-assets` branch, shown inline |
| `mr` | Merge request (needs `GITLAB_MR_TOKEN`) | Pull request; `pr` is an alias |
| `release prepare`, `finalize`, `deck` | The release carries its milestone | The notes link the milestone; the slides are a release asset |
| Confidential items | Withheld from listings; `show` needs `--confidential` | Not available: security reports go to private vulnerability reporting |
| Merge request template | `.gitlab/merge_request_templates/Default.md` | `.github/pull_request_template.md` |
| CI pipeline | No runner: `pnpm ci:local`, the git hooks, and `pnpm ci:remote` against a GitHub mirror if there is one | `.github/workflows/ci.yml` on every pull request and every `pnpm ci:remote`; require its `ci` job in a ruleset |

Setting either up is in `docs/agents/issue-tracker.md`; GitHub's needs an organisation admin to create the
App once. Moving an existing GitLab board to GitHub, numbers and all, is `docs/agents/migrating-a-board.md`. What has and has not been run against a live board is in `TASKS.md`.

## Start a project

The setup guide walks you through it in the browser, checking each step as you go:

```sh
git clone <kit url> my-project && cd my-project
mise trust && mise install && pnpm install
pnpm kit:setup
```

It ends with a first work item taken through plan, review and merge on the real board, kept as the
project's worked example. The steps it follows are below, for reference and for doing it by hand.

1. **Copy the kit.** Use it as a template repository, or clone it and start fresh history:
   ```sh
   git clone <kit url> my-project && cd my-project
   rm -rf .git && git init -b main
   mise trust && mise install && pnpm install     # installs the git hooks too
   ```
2. **Fill in the project parts.** `AGENTS.md`: the title line, the *(project)* ground rules, the layout.
   `docs/agents/project.md`: every section, replacing Makers Market examples along with their `<!-- example -->`
   markers. `SECURITY.md`: the application's scope, in place of its example. `docs/adr/0001-…`: the date.
3. **Wire up the board.** On GitLab: copy `.env.gitlab.example` to `.env.gitlab`, create a Reporter project
   access token with the `api` scope, and fill in the URL, token and project id. On GitHub: create a GitHub
   App, install it on the repository, and copy `.env.github.example` to `.env.github`. Keep only the one you
   use. `pnpm items list` should answer. See `docs/agents/issue-tracker.md`, "Setting up a new project's
   board".
4. **Make `pnpm check` mean something.** Point `check` at your stack's lint, typecheck and tests, and keep
   `node scripts/check-docs.mjs` in `lint`. Add the steps `ci:local` looks for (`build`, `coverage`,
   `container:build`, …) as you grow them; the container scripts read `CI_IMAGE`, `CI_PLATFORM` and
   `CONTAINER_ENGINE` with defaults of their own (`scripts/ci-local.mjs`, "IMAGES AND PLATFORMS"). Once
   `lint`, `typecheck` and `coverage` scripts all exist, `ci:local` runs those three in place of `check`,
   so the tests run once, under coverage. Give `coverage` the whole suite (`scripts/ci-local.mjs` says
   why).
5. **First commit**, in Conventional Commits: `chore: start from the Factory Kit <version>`. Name the kit
   version, so a later sync knows where you started.

## Adopt into an existing repository

Most projects already exist. From a clone of the kit, `pnpm kit:adopt <path to the repository>` brings the
kit into one without touching its default branch:

```sh
pnpm kit:adopt ../shop            # a dry run: prints what it would copy, merge and leave alone
pnpm kit:adopt ../shop --apply    # writes that on chore/adopt-factory-kit-<version>, in one commit
```

- **Copy:** the kit-owned files listed under "Kit-owned and project-owned" below, and the project-owned
  starting points (`AGENTS.md`, `biome.json`, `ci.yml`, …) the repository does not have yet.
- **Merge, additively only:** `package.json` gains the kit's scripts and devDependencies where the names are
  free (a taken name becomes `kit:<name>`, and the project's own `check`, `lint` and `prepare` are never
  changed; a taken `check` or `lint:staged` is also a conflict, because the hooks call those names);
  `.claude/settings.json` gains the kit's hooks and permissions; `.gitignore` gains the kit's lines,
  except one that would hide a file the project tracks.
- **Conflict:** everything else is left as it is and reported with a proposed resolution. Where the project
  has its own file at a kit path, the kit's version is written beside it as `<name>.proposed`, unless the
  project has a file at that path too. No file of the project's is overwritten.
- **The record:** `factoryKit.kit` in `package.json` names the kit version, `factoryKit.manifest` holds a hash
  of every kit-owned file adopted, so a later sync can tell an untouched kit file from an edited one, and the
  commit is `chore: adopt the Factory Kit <version>`. The report goes on the branch as
  `docs/factory-kit-adoption.md`, unless the project already has a file there.
- **npm or yarn stays.** The kit's tooling then goes in a package of its own, `tools/factory-kit/`, with
  pnpm's lockfile; the root's `check` calls it, and `factoryKit.package` tells the guard, CI and `ci:local`
  where it is. The guard refuses `npm install` only inside that package. The project's own `npm install`
  does not install it, so each developer runs `mise exec -- pnpm --dir tools/factory-kit install` once; the
  report says so, and proposes the `prepare` line that makes `npm install` do it, rather than editing the
  project's `prepare`.
- **A project with its own linter, or no JavaScript,** gets `factoryKit.lint: "kit"`: Biome and check-docs
  then cover only the kit's files, and check-docs also `AGENTS.md`, `docs/agents/project.md` and
  `SECURITY.md`, the project documents the skills write cited findings into.
- **A Maven, Gradle, .NET or Python build** keeps its own toolchain beside Node and pnpm. `pnpm check` runs
  that build's gate after the kit's, and the report names it and gives the CI step that installs the
  toolchain, for the project to add to its own workflow.
- **Husky or pre-commit keeps the hooks.** Two hook managers overwrite each other's hooks, so lefthook's
  own hooks are not installed. Instead each of Husky's hook files, or a `repo: local` in pre-commit's config
  (run `pre-commit install` again afterwards), hands over to `lefthook run <hook> --no-auto-install`, which
  runs the gates `lefthook.yml` states. Any other `core.hooksPath` is reported with that line to add.
  Under pre-commit, the pre-push gates see only the first ref of a push that carries new commits, which is
  all pre-commit passes on.

`--apply` refuses a working tree with uncommitted changes and an existing adoption branch, and pushes
nothing. A path the project's own ignore rules hide (a `.claude/` line, say) is not written but reported as
a conflict, since `git add` would refuse it. `--apply` checks all of this before it touches the repository,
and if a later step fails anyway it puts the repository back on its branch, with nothing left behind. Push
the branch, open a pull request from it, and run `pnpm kit:setup` in the repository for the board, the lock
on the default branch and the start-project interview. Its "Your repository" step keeps the project's
history and its own version: it reads the kit's version from `factoryKit.kit`, and is done once the
adoption is merged into the remote's default branch, which it never pushes to.

## Where CI runs

`pnpm run ci` runs the gates in the mode each developer chooses. (Use `pnpm run ci`, not `pnpm ci`, which is
pnpm's own command and fails.)

| mode | what it does |
| --- | --- |
| `local` (default) | `pnpm ci:local` on this machine, exactly as before. |
| `remote` | `pnpm ci:remote`: every job of `.github/workflows/ci.yml` on GitHub runners, in parallel. |
| `split` | The remote run, plus lint, typecheck, build and the prod audit here at the same time. A local failure cancels the remote run, so the commonest failures come back in seconds. |

Set your mode once in `.mise.local.toml`, which is git-ignored and which mise exports into every shell
opened in the repository. For one run only, use `CI_MODE=remote pnpm run ci`. The first line of each run says
which mode it used and where that came from.

```toml
[env]
CI_MODE = "split"   # local | remote | split
```

A remote run needs `gh` signed in with an account that can see the repository, and a remote pointing at
GitHub: `github` if there is one, else `origin`, or whichever `CI_REMOTE` names. It snapshots HEAD plus every
uncommitted and untracked file `.gitignore` allows, and secret-scans what GitHub has not seen. Then it
pushes the snapshot to `ci/<login>/<sha>` with `--no-verify`, since the remote run does everything the
pre-push hook would. It prints one line per job, the failing log and the run URL, and downloads a
`test-results` artifact if the workflow uploads one. Finally it deletes the branch, and `ci-prune.yml`
deletes any branch an interrupted run left behind after three days. **Everybody with access to the
repository can see that branch, uncommitted edits included.** `remote` and `split` fall back to `local`,
with a warning, when GitHub cannot be used.

**A personal GitHub account beside the work one** stays untouched if both settings are per repository:

- **SSH:** give the SSO-authorised work key a host alias in `~/.ssh/config` (`Host github-work`,
  `HostName github.com`, `IdentityFile ~/.ssh/<work key>`, `IdentitiesOnly yes`), and use it in the remote:
  `git@github-work:<org>/<repo>.git`.
- **`gh`:** add `GH_CONFIG_DIR = "{{env.HOME}}/.config/gh-work"` to `.mise.local.toml`, open a new shell in the
  repository, and run `gh auth login` there once. `gh auth switch` is global; this is not.

**Once a pull request is open, its own run is the one its `ci` check reads**, and it tests the merge with
the target rather than the branch alone. `pnpm ci:fetch <number or URL>` (or a run's URL, or `--run=<id>`)
waits for the CI run at the pull request's head, prints each job and the failing logs, and downloads its
`test-results` artifact into `CI_RESULTS_DIR`, where `pnpm ci:remote` leaves one. It reads only, with the
same `gh` sign-in and remote. Link that run in the pull request, and post its screenshots with
`pnpm items screenshots <iid> <dir>`.

**A slow container step can be split across jobs.** `pnpm ci:local --only=test:e2e:container --image=<tag>
-- --shard=2/6` runs one shard of the end-to-end suite against an image another job built, without
building it again. The image tag reaches the script as `CI_IMAGE`, and everything after `--` is appended
to its command. `--platform=linux/amd64` hands `container:build` a `CI_PLATFORM` for building the image
that ships from an arm64 laptop, under emulation.

A remote run has a minute or two of fixed overhead, so stay local for one test file or a lint. On Makers
Market a full remote run took about 8 minutes, against about 10 for `ci:local` on a 12-core laptop.

## Kit-owned and project-owned

The line that a future sync will follow. Files in the first list should read the same in every kit
repository; change them here, upstream, rather than in one project.

**Kit-owned:** `scripts/work-items.mjs`, `scripts/board/*` (the board migration's `scripts/board/migrate.mjs`
and `scripts/board/links.mjs` among them), `scripts/check-secrets.mjs`, `scripts/check-commit-msg.mjs`,
`scripts/check-docs.mjs`, `scripts/lease.mjs`, `scripts/ci-local.mjs`, `scripts/ci-remote.mjs`, `scripts/ci-fetch.mjs`,
`scripts/ci.mjs`, `scripts/ci-selftest.mjs`,
`.github/actions/setup/action.yml`, `.github/workflows/ci-prune.yml`, `.claude/skills/*`, `.claude/hooks/guard.mjs` (its lists aside), `docs/agents/issue-tracker.md`,
`docs/agents/domain.md`, `docs/agents/releasing.md`, `docs/cheatsheet.md`, `docs/decks/*` and `scripts/cheatsheet.mjs`, `docs/agents/migrating-a-board.md`, `docs/agents/surveying-a-codebase.md`, `docs/agents/modernizing.md`, `docs/adr/0000-template.md`, `lefthook.yml` and `.lefthook/pre-push/gates.sh`, `scripts/pre-push.mjs`, `scripts/setup/*` (the setup guide), `.claude/skills/start-project`,
`.env.gitlab.example`, `.env.github.example`, `.gitlab/merge_request_templates/Default.md`,
`.github/pull_request_template.md`, `docs/adr/0002-board-provider-adapters.md`,
`docs/adr/0003-release-hooks-and-deck-markers.md`, `docs/adr/0004-board-migration-in-the-kit.md`,
`docs/adr/0005-number-leases-as-git-refs.md`, `docs/adr/0006-adoption-writes-only-on-a-branch.md`, and the documents those
cite: `docs/idea-to-implementation-example.md` and `docs/superpowers/specs/2026-09-30-github-board-design.md`.

**Project-owned:** `AGENTS.md` below its *(kit)* rules, `CLAUDE.md`, `CONTRIBUTING.md`, `SECURITY.md` (its
reporting route and kit-tooling scope stay in step with the kit), `docs/agents/project.md`, `TASKS.md`,
`docs/DECISIONS.md`, `docs/adr/0001` onwards, `package.json`, `mise.toml`, `biome.json`, `.claude/settings.json`,
`.github/workflows/ci.yml` (a starting point that grows with the project), and the release hooks module that
`factoryKit.release.hooks` names, if any (`docs/agents/releasing.md`, "Release hooks"), and the
`factoryKit.migrate` settings (`docs/agents/migrating-a-board.md`), and the `factoryKit.numbered` kinds
(`scripts/lease.mjs`). A release step only one
project has goes there, not into `scripts/board/release.mjs`.

A project will still need to extend some kit-owned files, such as a credential pattern in `check-secrets.mjs`
or a step in `ci-local.mjs`. Until a sync exists, mark each such change with a comment saying it is local.
A fork of `ci-local.mjs` or `ci-fetch.mjs` keeps its entry-point guard (`if (import.meta.url === …)`), so
importing it runs nothing: `pnpm check:ci` imports both to test them, and an unguarded `ci-local.mjs` would run
the whole pipeline, which runs `pnpm check`, which imports it again. A project that does not want the kit's
CI tests on its fork drops `node scripts/ci-selftest.mjs` from its `check` script.

## Not in this version

- **Syncing with a project that uses the kit.** The kit is meant to be upstream: a project pins a kit
  version, pulls kit-owned files, and proposes its generic improvements back as a merge request or pull
  request. Until that
  exists, copy changes across by hand, using the ownership lists above.
- **Client use.** Internal first; client-facing naming comes later. The code is MIT-licensed (`LICENSE`).

# Factory Kit cheat sheet

Every command, configuration file, hook and workflow the kit ships, each with what it does and why. Everything under `scripts/` uses Node builtins only, so it all runs before `pnpm install`.

## The map

### Instructions

- `AGENTS.md`: the rules for every agent, *(kit)* and *(project)*
- `CLAUDE.md`: imports AGENTS.md, plus Claude Code specifics
- `docs/agents/`: what the skills read about this repo
- `docs/DECISIONS.md`, `docs/adr/`, `TASKS.md`

### Tooling

- `scripts/work-items.mjs` and `scripts/board/`: the board
- `scripts/ci*.mjs`: where CI runs
- `scripts/check-*.mjs`: the git-hook gates
- `scripts/setup/`: the setup guide

### Configuration

- `mise.toml`, `package.json`, `.npmrc`, `biome.json`
- `lefthook.yml`: git hooks
- `.claude/`: settings, guard, skills
- `.github/`: workflows, action, PR template

## pnpm scripts: the gates

### Before you say done

- `pnpm check`: the single gate. Runs `lint`, the guard's selftest, the setup guide's selftests and the CI scripts' (`check:ci`), and the pre-push hook runs it too. A project adds its own typecheck and tests to it.
- `pnpm lint`: Biome over the whole tree, then `check-docs.mjs`, which fails when a document cites a file that does not exist.
- `pnpm lint:fix`: Biome with `--write`: formats, and applies the safe fixes in place.

### Also gates

- `pnpm check:items`: the board's state machine, and both board adapters against a fake API. Offline and without a token, so it runs at every push.
- `pnpm check:ci`: the CI scripts' selftest, offline: what `ci:local` runs for a command line and which run `ci:fetch` picks. `pnpm check` runs it. It imports `ci-local.mjs`, so a fork of that file keeps its entry-point guard.
- `pnpm audit:prod`: `pnpm audit` over production dependencies, failing at moderate severity or worse. One of the CI jobs.
- `prepare`: runs on every `pnpm install` and installs the git hooks with lefthook. Before `git init` it says it skipped them instead of failing.

## pnpm scripts: CI, board, setup

### CI

- `pnpm run ci`: the pipeline's gates, run where your `CI_MODE` says: local, remote or split. It is `run ci` because pnpm reserves `pnpm ci` and fails.
- `pnpm ci:local`: the pipeline on this machine, step by step, skipping any step whose script is missing. Until a runner is attached, this is the pipeline.
- `pnpm ci:remote`: pushes a snapshot of the working tree, committed or not, to a `ci/` branch, and runs `ci.yml` on GitHub runners.
- `pnpm ci:fetch <pr>`: a pull request's own CI run, brought back: it waits, prints the failing logs and downloads the screenshots.

### Board and setup

- `pnpm items <command>`: the work-item board, on GitHub issues or GitLab work items. Reads and writes items, labels, milestones, requests and releases.
- `pnpm kit:setup`: starts the first-setup guide on 127.0.0.1 and opens it in the browser. Each of its steps checks itself.
- `pnpm kit:adopt <path>`: from a kit clone, brings the kit into an existing repository. A dry run unless `--apply`.

## pnpm items list

Every open item, with the state computed from its `ai:` label and comment history, and the reason. The SessionStart hook prints the same report.

### Filters

- `--new`: no plan yet; waiting for triage
- `--answered`: the reporter has replied since the plan, and the reply needs a coverage check
- `--ready`: every `[REVIEW]` point is covered; waiting for a person's go
- `--blocked`: a point is still open after two rounds; it needs a conversation

### More filters, and output

- `--parked`: placeholders filed deliberately; not queued for analysis
- `--stale`: an `ai:analysing` older than a few hours, which means a run that died
- `--brief`: one line per item
- `--json`: machine-readable, for a skill or a script

## pnpm items: reading one item

All of these are pre-approved in `.claude/settings.json`.

### Items

- `show <iid>`: the description, analysis and every comment, as JSON. Each comment carries a `kind` (`plan`, `coverage`, `reply`, `ours`), and `rounds` counts the coverage rounds.
- `show <iid> --confidential`: without the flag a confidential item is refused, and what it says stays out of commits and requests. On GitHub a `confidential` label marks one.
- `collisions [--json] [--confidential]`: pairs of open items whose plans cite the same code. Citations close together count as one function, so a merge conflict is seen before either branch starts. A confidential item's overlaps are listed without its files and lines unless `--confidential` is passed.

### Releases and requests

- `releases`: one line per open release milestone, with its due date and its open and closed counts.
- `releases <milestone>`: the items in one, open ones first, each with its `ai:` label.
- `mr-status <branch> [--json]`: the newest request from a branch, its state, and who merged it. `mergedByBot` is true when the board's own credential merged, which the ruleset should prevent.

## pnpm items: writing to an item

These prompt, because other people read the board.

### Comments and labels

- `comment <iid> <file>`: posts a file as a comment. A file, not a flag, so a plan is drafted and reviewed before it is posted. Write it with a quoted heredoc (`<<'EOF'`).
- `label <iid> <state>`: sets the one `ai:` label: `analysing`, `plan-posted`, `answered`, `ready`, `blocked`, `parked`, `implementing`, or `none`. Other labels are kept.
- `label <iid> release-x.y.z`: puts the item in a release, replacing any other `release-*` label. The milestone follows the label.

### Screenshots and closing

- `screenshots <iid> <dir> [intro-file]`: uploads the e2e PNGs as one comment. GitHub has no upload API for comments, so they are committed to the orphan `board-assets` branch and embedded from there.
- `close <iid>`: closes the item and drops its `ai:` label in the same call. Run it even when a `Closes #N` already shut the item, because the label stays behind.

## pnpm items: links, milestones, requests

### Links

- `create <file> [relates-to-iid] [labels]`: opens a follow-up item. The file's first line is the title and the rest is the description. The iid links it to its parent, and a link is also a hold.
- `create --batch <file> [--apply]`: many items from one Markdown file of `=== <key>` entries with `Labels:`, `Needs:` and `Relates:` lines. A dry run unless `--apply`. `Needs:` orders and writes `Depends on #n` text, only `Relates:` links, and a hidden marker in each body makes a re-run skip what exists.
- `unlink <iid> <other-iid>`: removes a link, and the hold it carries. For an umbrella and its children, or a later stage of a parent that is still open.

### Milestones and requests

- `milestones [--dry-run]`: puts every item in the milestone its `release-*` label names, creating the milestone if needed. The label is the truth, and the SessionStart hook sweeps this.
- `mr <branch> <file> [title] [--target=<branch>]`: opens a merge request on GitLab (it needs `GITLAB_MR_TOKEN`). `pr` opens a pull request on GitHub. It targets the default branch unless told otherwise.
- `selftest`: the rules, offline. This is what `pnpm check:items` runs.

## The board's state machine: labels

Both GitLab and GitHub let an item carry several such labels, so the tool keeps exactly one by writing the whole set.

### Before the plan is agreed

- `ai:analysing`: an agent is analysing the item right now. Older than a few hours means a crashed run.
- `ai:plan-posted`: a plan with numbered `[REVIEW]` points is on the item, waiting for the reporter.
- `ai:answered`: the reporter has replied since the plan. The tool recomputes this from the comments, so a stale label cannot lie.
- `ai:blocked`: a point could not be closed on the item in two rounds. It needs a conversation, not another comment.

### After it

- `ai:ready`: every `[REVIEW]` point is answered. Waiting for a person to say go.
- `ai:implementing`: an implementation branch is open for the item.
- `ai:parked`: filed deliberately as a placeholder. Not queued for analysis until somebody removes the label.

## The board's state machine: rules

### How a state is computed

- From the `ai:` label plus who wrote the newest comment. The bot's comments are ours; anybody else's is a reply.
- On GitHub the board comments as a GitHub App (`<slug>[bot]`), so a developer's reply never reads as the bot's follow-up.
- Every plan opens with a fixed marker, so a hand-deleted label cannot cause a second plan to be posted.
- `pnpm check:items` pins all of this offline, because "a human replied" cannot be tested against a live board.

### Exit codes

- `0`: fine.
- `1`: a usage or logic failure.
- `3`: the board is unreachable or unconfigured, for example off the VPN. The SessionStart hook stays silent on it, because a harness that breaks a session when the VPN is down is worse than none.

## pnpm items release prepare

Run before a release, from the version line branch. `docs/agents/releasing.md` has the whole procedure.

### The dry run

- `release prepare release-X.Y.Z --from=<branch>`: works out which items the commits since the default branch deliver, and refuses if any of them is still open. It only prints: the dry run is the review.
- `--notes`: adds the draft release notes to the dry run.
- `--at=<sha>`: cuts from an earlier commit than the branch's head.
- `--name="<Product> X.Y.Z"`: the release's title.

### Overrides and apply

- `--include=<iid,…>`, `--exclude=<iid,…>`: override the detection, for an item that was only mentioned or wrongly counted. What they did is written into the request.
- `--apply`: from a clean tree. It cuts `release/X.Y.Z`, bumps every `package.json` version, drafts `docs/releases/X.Y.Z.md` and `docs/releases/X.Y.Z.whats-new.md`, pushes, opens the request, and only then relabels the items.

## pnpm items release deck and finalize

### Commands

- `release deck release-X.Y.Z [--out=<file>]`: renders this checkout's what's-new file into slides for a look before merging. It writes `whats-new-X.Y.Z.html` and nothing else.
- `release finalize release-X.Y.Z`: after a person merges. It tags the merge commit, publishes the notes with the slides attached, comments on and closes each item, closes the milestone, and opens a request back into the source branch.
- `--no-whats-new`: the stated decision to release without slides where `requireWhatsNew` is set.

### Rules

- An item is delivered when a request's branch carries its number (`feat/243-…`), a description line starts with it, or the description says `Closes`, `Fixes` or `Delivers #N`. Other mentions are printed, not counted.
- Merge with a merge commit, never a squash: a squash makes the next merge from the line branch conflict with its own history.
- `finalize` refuses while a `FILL IN` marker is left, and every step can run again after a failure.
- The kit itself is released differently: annotated `vX.Y.Z` tags, by hand.

## Release configuration

In `package.json`, under `factoryKit.release`. Every setting is optional, and every one but `hooks` is read at the release commit, so a rerun from any checkout reads the same value.

### Settings

- `configPaths`: the files whose configuration keys the notes list. The default is `.env.example`, and a file listed here is also carried whole in the notes, folded.
- `migrations`: a regular expression for a new migration file's path. The default is a `.sql` file in a `migrations/` or `drizzle/` directory.
- `requireWhatsNew`: when true, `finalize` refuses a release with no what's-new file unless `--no-whats-new` is given.
- `hooks`: a module the project owns, read from the checkout, that adds what is the project's alone.

## Release hooks

The module `hooks` names may export any of these, and nothing else. Any of them may be async.

### Adding to a release

- `flags`: extra `--name=value` options for `prepare` and `finalize`. Their values reach the other hooks as `flags`.
- `notes(s, { showAt, flags })`: lines added to the notes after Notices. `s` is the survey of the release, and `showAt(ref, file)` reads a file at a commit.
- `checklist(s, { flags })`: extra "Before merging" lines in the release request.

### Around finalize

- `beforeFinalize(...)`: runs after the kit's own refusals and before the tag. Anything but `{ ok: true }` refuses, and nothing is tagged, published or closed.
- `afterFinalize(...)`: runs after every other step, with the deck and the published what's-new. A failure leaves the release done and exits `1`, and a rerun retries only what the hook finds undone.

## CI modes: pnpm run ci

### The three modes

- `CI_MODE=local`: `pnpm ci:local` on this machine. The default, so a fresh clone needs nothing.
- `CI_MODE=remote`: `pnpm ci:remote`, with every job of `ci.yml` on GitHub runners, in parallel.
- `CI_MODE=split`: the remote run, plus lint, typecheck, build and the audit here at the same time, against the same snapshot. A local failure cancels the remote run, so the common failures come back in seconds.

### Choosing

- Set it once in `.mise.local.toml`, under `[env]`. The file is personal and git-ignored, and mise exports it into every shell in the repo.
- For one run: `CI_MODE=remote pnpm run ci`.
- Never in `.env`, which is the application's configuration.
- `remote` and `split` fall back to `local`, with a warning, when GitHub cannot be used. The first line of a run says which mode it used and why.

## pnpm ci:local: flags

`pnpm ci:local --help` prints these and the steps.

### Choosing steps

- `--no-container`: skips the steps that need podman or docker, for a machine without a container engine.
- `--only=lint,typecheck`: runs only these package.json scripts, and not the install. For a CI job, or split mode, that has installed already.
- `-- <args>`: everything after `--` is appended to the `test:e2e:container` command, for example `-- --shard=2/6`.

### Images

- `--image=<tag>`: skips `container:build` and hands the container steps `CI_IMAGE=<tag>`, to test an image somebody else built.
- `--platform=linux/amd64`: hands `container:build` `CI_PLATFORM`, to build the platform that ships from an arm64 laptop. Emulated, and several times slower.
- `CONTAINER_ENGINE`: passed through when set; otherwise podman if present, else docker.

## pnpm ci:local: steps

In order, cheapest first. A step whose package.json script does not exist yet is skipped with a line saying so.

### Without a container

- `pnpm install --frozen-lockfile`: installs from the lockfile.
- `check`: lint, typecheck and tests.
- `check:items`: the board's state machine.
- `coverage`: the tests with coverage floors.
- `build`: the production build.
- `audit:prod`: the production dependency audit.

### With a container, and the test run

- `container:build`: the project's image build.
- `test:e2e:container`: the end-to-end suite against that image.
- When `lint`, `typecheck` and `coverage` all exist, they replace `check`, so the tests run once: `coverage` is then the test run.

## pnpm ci:remote

### What it does, in order

- Snapshots HEAD plus every change and untracked file `.gitignore` allows, through a temporary index. `.env` and `.mise.local.toml` never travel.
- Secret-scans every object the push sends that GitHub does not have: every unpushed commit's blobs, so a secret committed and then removed is still refused.
- Pushes it as `ci/<login>/<sha>` with `--no-verify`, because the remote run does what the pre-push hook would.
- Prints one line per job, then the failing logs, the run URL, and downloads the `test-results` artifact. Then it deletes the branch.

### Worth knowing

- Everybody with access to the repository can see the branch, uncommitted edits included.
- A remote run has a minute or two of fixed overhead: stay local for one test file or a lint.
- `CI_REMOTE`: the git remote to push to; `github` if there is one, else `origin`. An `~/.ssh/config` host alias works.
- `CI_RESULTS_DIR`: where `test-results` lands; default `test-results`.
- Exit `0` green, `1` red, `3` could not start, which `pnpm run ci` reads as "fall back to local".

## pnpm ci:fetch

Once a pull request is open, its own run is the one its required `ci` check reads, and it tests the merge with the target.

### Usage

- `pnpm ci:fetch 412`: pull request #412's newest `pull_request` run at its head commit.
- `pnpm ci:fetch https://github.com/o/r/pull/412`: the same, by URL.
- `pnpm ci:fetch <run URL>` or `--run=<id>`: one run, by its URL or id.

### Behaviour

- Waits for the run if it is still going, one line per job, and prints the failing logs when it is red.
- Downloads `test-results` into `CI_RESULTS_DIR`, ready for `pnpm items screenshots`.
- Reads only: nothing is pushed, re-run or commented.
- Exit `0` passed, `1` failed or none found, `2` usage, `3` `gh` or the remote unusable.

## Two accounts on one machine

A personal GitHub account beside the work one stays untouched when both settings are per repository.

### SSH

- Give the SSO-authorised work key a host alias in `~/.ssh/config`: `Host github-work`, `HostName github.com`, `IdentityFile`, `IdentitiesOnly yes`.
- Use the alias in the remote: `git@github-work:<org>/<repo>.git`.

### gh

- Add `GH_CONFIG_DIR = "{{env.HOME}}/.config/gh-work"` to `.mise.local.toml`.
- Open a new shell in the repository and run `gh auth login` there once.
- `gh auth switch` is global; this is not.

## .github/workflows/ci.yml

The pipeline on GitHub-hosted runners: what `pnpm ci:local` runs, as parallel jobs. Project-owned: a starting point that grows with the project.

### Triggers and jobs

- Runs on a push to `ci/**` (a `ci:remote` snapshot), on every `pull_request`, and by hand with `workflow_dispatch`.
- `gates`: a matrix of `check`, `lint`, `typecheck`, `coverage`, `build`, `audit:prod` and `check:items`, each run with `pnpm run --if-present`, so a missing script passes.
- `ci`: needs every gate, runs `always()`, and fails if any gate did not succeed. Make it the one required check: a skipped required check counts as passed.

### Safety and growth

- The token is read-only, and nothing signs in or reads a secret.
- Keep a deploy workflow's branch filters from matching `ci/**`.
- A slow step gets a job of its own, split with a matrix and `--shard`.
- Name a screenshot artifact `test-results`, and `ci:remote` and `ci:fetch` download it.

## The other workflow, and the action

### .github/workflows/ci-prune.yml

- Runs nightly at 03:17 UTC, and by hand.
- Deletes the `ci/**` branches whose head is older than three days: the ones an interrupted `ci:remote` left behind.
- Those branches hold snapshots of uncommitted work, so they should not linger.
- The only workflow that writes, and the only thing it writes is a `ci/` ref.

### .github/actions/setup/action.yml

- The toolchain every CI job starts from.
- pnpm at the version `packageManager` pins.
- Node at the version `mise.toml` pins, so a runner and a laptop cannot drift.
- `pnpm install --frozen-lockfile`, with pnpm's store cached.

## Git hooks: lefthook.yml

The same gates CI runs, so nobody pushes what CI will reject. Every command runs through `mise exec --`: a GUI client or an agent's shell often has no `pnpm` on its PATH.

### pre-commit, in parallel

- `biome`: `biome check --write` on the staged files, re-staged with `stage_fixed`. Its glob covers every extension `biome check .` reads, so the hook is never weaker than CI.
- `secrets`: `check-secrets.mjs --staged`, on the staged blobs rather than the files on disk, so a file staged and then deleted is still read.

### commit-msg

- `conventional`: `check-commit-msg.mjs`. Types are `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore` and `revert`, with an optional lower-case scope and `!`. `Merge` and `fixup!` pass.

## Git hooks: pre-push

One script, `.lefthook/pre-push/gates.sh`, running `scripts/pre-push.mjs`. Not commands: lefthook 2.1 skips a pre-push command whenever HEAD's tree matches its push target, whatever is pushed.

### What runs

- `lease.mjs check`, on every push: refuses a new ADR whose number is not leased on origin to the branch being pushed. It reads the pushed refs from git (`use_stdin`), or from pre-commit's environment under pre-commit. Not in `pnpm check`, which runs offline and in CI.
- `pnpm check` and the board's state machine, when HEAD is the commit pushed: the whole of `pnpm check`, because the pre-commit hook only sees staged files. Modified tracked files are included, and the hook says so.
- `check-secrets.mjs --objects` on every pushed branch and tag: every blob the push sends that the remote lacks, checked out or not.

### What is refused

- A branch pushed from another checkout is refused after the lease check and the secret scan: check it out and push from there. A delete gets the lease check only, and a tag the lease check and the secret scan.

## scripts/check-secrets.mjs

The secret gate. It reads what leaves, not the disk: the staged blobs at pre-commit (`--staged`), and every object a push sends that the remote does not have, at pre-push and before a remote run (`--objects <rev>… --remote <r>`). The remote's advertised branch and tag tips (`git ls-remote`) say what it has. Files named on the command line are still read from disk. `--selftest` runs in `pnpm check`.

### When it refuses a push

- The secret is in a commit, even if a later commit or the working tree removed it. Rewrite that commit (`git log --all --find-object=<blob>` names it) and rotate the key: an earlier push may already have sent it.

### What it refuses

- Private keys, and AWS access key ids.
- GitHub tokens: `ghp_`, `gho_`, `ghs_`, `github_pat_`.
- GitLab `glpat-` tokens, Slack tokens and webhook URLs.
- Anthropic `sk-ant-` keys and OpenAI-style `sk-` keys.
- JWTs, `client_secret` assignments, Azure storage account keys.
- A database URL with a real password in it.

### What it lets through

- A placeholder: `CHANGE_ME`, or a value saying it is `not-a-secret`.
- A reference: `$VAR`, `<password>`, `process.env`.
- A line marked `secret-scan:ignore`, for a deliberate fixture.
- A project adds its own credential patterns the same way: a pattern, a label, and a validator for placeholders. Mark them local.

## scripts/check-docs.mjs

Part of `pnpm lint`. Three kinds of drift in the docs that a script can see, because each has come back.

### What it fails on

- A citation or link that resolves to nothing. A reader who follows a dead path stops trusting the parts that are still true.
- Two ADRs with the same number: two branches each take `0025`, git merges them without a conflict, and nothing notices. The same for every kind in `factoryKit.numbered`, such as a Drizzle migration.
- A placeholder in `SECURITY.md`, which publishes the disclosure route.

### What it allows

- A citation that matches the tail of a real path, written as shorthand once the passage has named the package.
- Anything in `docs/archive/`, which is history, and `docs/superpowers/`, where specs name files that do not exist yet.
- A line number that has moved: the file must exist, and what it says there is the reviewer's job.

## pnpm lease: record numbers

The next ADR number, claimed on origin before the file is written, so two branches cannot both take it. `docs/adr/0005-number-leases-as-git-refs.md`.

### Commands

- `pnpm lease adr`: one above every ADR on every remote branch and every live lease, pushed as `refs/leases/adr/<NNNN>` with your own git credentials. A claim that loses a race moves to the next number.
- `pnpm lease --list`: every live lease, with its branch, claimant and time.
- `pnpm lease --prune`: deletes the leases whose number is on the default branch. Each claim runs it first.

### Rules

- Only a kind with `"leased": true` can be leased. A migration's number is the generator's, so it has the duplicate guard only.
- The push check covers each branch pushed, not HEAD. An ADR counts as landed only on a branch origin has now, and never on a `ci/` snapshot.
- The kit's own ADRs, listed with a matching hash in `factoryKit.manifest`, need no lease.
- No takeover of a stale lease: an abandoned one leaves a gap, and gaps are legal.
- A delete is refused unless the ref is under `refs/leases/`. Whether GitHub and GitLab accept that namespace has not been checked live yet.

## .claude/hooks/guard.mjs

Claude Code's PreToolUse guard on `Bash`, `Edit`, `Write`, `MultiEdit` and `NotebookEdit`. A rule an agent cannot break beats a paragraph it has to remember. Exit `2` blocks the call and tells the agent why.

### What it refuses

- `pkill` and `killall`: a pattern matches the developer's own dev server. Kill the exact PID you started.
- A force push: `--force`, `-f` or a `+refspec`. `--force-with-lease` passes.
- `npm install`, `npm i`, `npm ci`, `npm add`: npm writes a second lockfile beside pnpm's.
- An edit to `pnpm-lock.yaml`, which only `pnpm install` writes, or to a path the project protects.

- `npm install`, `npm i`, `npm ci`, `npm add`: npm writes a second lockfile beside pnpm's. With `factoryKit.package` set, only inside that package.
- An edit to `pnpm-lock.yaml`, which only `pnpm install` writes.

### Extending it

- `GENERATED`: add the project's generated paths, each with the command that produces it, such as a migrations directory and `pnpm db:generate`.
- `COMMANDS`: add the shell commands to refuse, each with its reason.
- `PROTECTED`: add paths agents read but never edit unasked, each with what it is, such as a legacy system under modernization. Empty in the kit.
- Mark each addition as local.
- `node .claude/hooks/guard.mjs --selftest` checks the rules; `pnpm check` runs it.

## .claude/settings.json: hooks

### SessionStart

- On `startup` and on `clear`, it runs `work-items.mjs list --hook`: the board report that opens a session, silent when nothing needs attention or the board is out of reach.
- Then `work-items.mjs milestones --hook`: puts each item in the milestone its `release-*` label names, and prints one line per open release.
- The report informs; it does not authorise. Confirm the batch with a person before analysing anything.

### PreToolUse

- Runs the guard before every `Bash`, `Edit`, `Write`, `MultiEdit` and `NotebookEdit` call, with a five-second timeout.
- Anything the guard cannot parse is let through, so a change of input shape never wedges every tool call.

## .claude/settings.json: permissions

### allow, without a prompt

- The read-only board commands: `pnpm items list`, `show`, `collisions`, `releases`, `mr-status`, and `pnpm check:items`.
- `pnpm check`, `pnpm lint`, `node scripts/check-docs.mjs`, and the guard's selftest.
- `gh run list`, `view`, `watch` and `download`.
- `git status`, `diff`, `log`, `show`, and `git branch --show-current`.

### deny, always

- `pkill` and `killall`.
- `git push --force` and `git push -f`.
- `npm install`, `npm i` and `npm ci`.
- A deny rule matches a command's prefix, so `git push origin main --force` walks past it. The guard reads the whole line, which is why both exist.

## Claude Code skills: the board

In `.claude/skills/`, loaded when they are needed.

### triage-work-items

- Takes open items through analysis to a posted plan, as a comment, carrying numbered `[REVIEW]` points for the reporter.
- Labels the item `analysing` while it works and `plan-posted` when done.
- Use it when the board report names items needing attention, or when you name items to analyse.

### advance-work-items

- Maps the reporter's reply onto the `[REVIEW]` points, revises the plan when the answers change it, and asks again for what is still open.
- Implements only once every point is covered and a person says go.
- Batch mode: several items one after another on one branch, `/simplify` after each, `/security-review` on the combined diff, and a release-notes PDF on the request.

## Claude Code skills: project and release

### start-project

- Fills in what the kit left for the project by interviewing the tech lead.
- On an existing codebase it reads the code first (`docs/agents/surveying-a-codebase.md`) and writes cited proposals into the files, tagged `<!-- proposed -->`. The setup guide's step 6 stays open until every tag is reviewed.
- Covers the AGENTS.md title, rules and layout, `docs/agents/project.md`, the SECURITY.md scope, the guard lists, ADR 0001's date and the check script.
- The setup guide's "Your project" step hands over to it.

### cut-release

- Cuts a release with `pnpm items release`: the dry run, apply, the notes and the what's-new slides, a person's merge with a merge commit, then finalize.
- Also brings the default branch back into a version line branch afterwards.

## Claude Code skills: modernize, and the batch helpers

### modernize

- Takes a legacy codebase to a reviewed plan on the board, with `docs/agents/modernizing.md` as its reference.
- Places the old code in a protected subdirectory, writes the analysis and a strategy ADR, and stops for the approval of a merge request holding only those.
- Then writes a seed file for `pnpm items create --batch`, each entry tracing to its analysis section, and creates nothing before a person says go.

### Batch helpers

- `batch/mr-attach.mjs <mr> <file> <intro.md>`: uploads a file to a request and posts it with an intro.
- `batch/release-notes-pdf.mjs <features.json> <dir> <out.pdf>`: one page per item, with its screenshots.
- `batch/sanitize-features.mjs`: what a confidential item may show in that PDF.

## .env.github

Copy `.env.github.example` to `.env.github`, then check it with `pnpm items list`.

### Variables

- `GITHUB_REPOSITORY`: the board's repository, as `owner/name`.
- `GITHUB_APP_ID`: the GitHub App the board comments as.
- `GITHUB_APP_PRIVATE_KEY_PATH`: the App's PEM key, absolute or relative to the repository root. Keep the file outside the repository.
- `GITHUB_APP_INSTALLATION_ID`: optional; looked up from the repository when blank.
- `GITHUB_API_URL`: optional; for GitHub Enterprise Cloud.
- `GITHUB_TIMEOUT_MS`: optional; default 8000.

### Why an App

- An App comments as `<slug>[bot]`, which is never a person, so the state machine can tell our comments from a reply.
- It needs Issues, Pull requests and Contents (read and write) and Metadata (read), installed on this repository only.
- The private key is the real secret. Each process mints short-lived tokens per scope and keeps them in memory, so the token a session uses cannot open a pull request.

## .env.gitlab

Copy `.env.gitlab.example` to `.env.gitlab`.

### Variables

- `GITLAB_URL`: the GitLab instance.
- `GITLAB_TOKEN`: a project access token with the `api` scope, at Reporter. It reads the board and writes comments, labels and milestones.
- `GITLAB_PROJECT_ID`: the project the board lives in.
- `GITLAB_TIMEOUT_MS`: optional; default 8000.
- `GITLAB_MR_TOKEN`: Developer, and read only by `pnpm items mr` and the release commands, since Reporter cannot open a merge request.

### Why two tokens

- `GITLAB_TOKEN` runs on every session and every command, so it is the last credential that should also be able to ship.
- The elevated token stays confined to the one subcommand that needs it. Leave it unset and everything else works.
- Neither token pushes; your own git credentials do.
- Off the VPN every call fails as `network`, and the session hook stays silent.

## Environment rules

### Where each setting lives

- `.env`: the application's own configuration. mise exports it into every shell in the repository, and every process inherits it.
- `.env.github` or `.env.gitlab`: the board's credentials. Never in `.env`, because no application process reads them and they can write to the tracker. There is no fallback to `.env`.
- `.env.example`: documents every variable the application reads, with placeholders. The release notes list its keys.
- `.mise.local.toml`: personal settings such as `CI_MODE` and `GH_CONFIG_DIR`. Git-ignored.

### What git ignores

- `.env` and `.env.*`, except the three examples.
- `*.pem`, `.mise.local.toml`, and Claude Code's local settings file.
- `.work-items/`, `.superpowers/`, `.claude/worktrees/`.
- `whats-new-*.html`, `test-results/`, `playwright-report/`, `coverage/`.
- Keep only one of `.env.github` and `.env.gitlab`: with both, `pnpm items` refuses to guess, and `BOARD_PROVIDER=github` or `gitlab` settles it.

## mise.toml and package.json

### mise.toml

- `[tools] node = "22"`: keep it at the major the runtime image uses.
- `[tools] pnpm = "10.34.5"`: exactly `packageManager`'s version.
- `[env] _.file = ".env"`: exports `.env` into every shell opened in the repository.
- `mise trust && mise install` gives every person and agent the same versions.
- A changed `.env` value reaches a running server only after a fresh start.

### package.json

- `scripts`: every `pnpm` command on these slides.
- `packageManager`: `pnpm@10.34.5`, which the CI action reads.
- `engines`: node 22 or later and pnpm 10 or later, enforced by `.npmrc`.
- `devDependencies`: only `@biomejs/biome` and `lefthook`.
- `factoryKit.release` and `factoryKit.migrate`: the release and migration settings.
- `factoryKit.numbered`: numbered records by kind, each a `dir`, a filename `pattern` and `leased`. The kit ships `adr`, leased.
- `factoryKit.protected`: directories whose Markdown check-docs does not read, such as `legacy` during a modernization. Not set in the kit.
- `factoryKit.kit`, `.manifest`, `.lint`, `.package`: written by `kit:adopt`. The kit version, a hash per kit file, the linters on the kit's files only, and where the kit's package is on npm or yarn.
- `version`: the project's version, which `release prepare` bumps.

## .npmrc and biome.json

### .npmrc

- `engine-strict=true`: an install on the wrong Node or pnpm fails, rather than warning.
- `auto-install-peers=true`: peer dependencies install without a separate step.

### biome.json

- Formatting: two spaces, a line width of 110, single quotes, semicolons, trailing commas. CSS is formatted too.
- Lint: the recommended preset. `useImportType` and `noUnusedImports` are errors; `noExplicitAny` and `noUnusedVariables` are warnings.
- Reads `.gitignore`, and also skips `dist`, `node_modules`, `.claude/skills`, test reports and SVGs.
- Project-owned: tighten it as the project grows.

## The setup guide: seven steps

`pnpm kit:setup`. Each step checks itself, and "Check again" re-runs every check.

### Getting a working repository

- **Tools:** node and pnpm at mise's pinned versions. When mise has them but the shell does not activate it, the step gives the activation line for zsh, bash or fish.
- **Your repository:** your own history instead of the kit's, and a home on GitHub. It can create the repository with `gh`, or connect an empty one you paste.
- **The board:** `.env.github` filled in, and the App installed and able to read the board.
- **The lock on main:** the ruleset on the default branch, and the repository settings beside it.

### Getting a working method

- **Where checks run:** choose `local`, `remote` or `split`, written to `.mise.local.toml`.
- **Your project:** AGENTS.md and `docs/agents/project.md` filled in, handed to the `start-project` skill.
- **Your first item:** files a demo item on your board and follows it through a plan and a merge. `mr-status` checks that a person merged it.

## The setup guide: how it works

### Under Claude Code

- Started from Claude Code, every step leads with a highlighted "Copy a prompt for Claude Code (recommended)".
- It also offers each fix as `!` lines to paste, and as one line.
- Without Claude Code, it shows the commands to run yourself.

### How it stays safe

- It listens on 127.0.0.1 only, and refuses any Host or Origin that is not its own, which stops DNS rebinding and cross-site requests.
- The printed link carries a key and works once. That visit hands the page a fresh session, kept in localStorage and sent as `x-kit-session`.
- Not a cookie: a browser sends a 127.0.0.1 cookie to every port on it.
- An action is a JSON POST naming a step and action the catalogue lists, under a 64 KB cap.
- No answer carries a secret: checks say only "set" or "not set".

## The lock on main

What the guide's protection step checks and applies on the default branch.

### The ruleset

- One approving review before a merge.
- Deleting the branch, and non-fast-forward pushes, are blocked.
- Repository admins may bypass the review, but only through a pull request.
- `delete_branch_on_merge` on, so merged branches do not pile up.
- Private vulnerability reporting, checked on public repositories only.

### Risks and blind spots

- Auto-delete and reporting can be accepted as risks instead. The guide records each in `docs/DECISIONS.md`, under "Risks accepted at setup", with the reason, who and when.
- A setting the guide's credentials cannot see makes the step `blocked`, never passed.

## Moving a board: scripts/board/migrate.mjs

Copies a GitLab board to a GitHub repository, keeping every item's number. Run once per project; every run before the real one is a rehearsal on a scratch repository.

### Commands

- `--repo=<owner/name> --dry-run`: prints the writes it would make, and makes none.
- `--repo=<owner/name>`: makes them, paced under GitHub's limits.
- `--verify`: classifies both sides and reports every difference.
- `--remap`: rewrites GitLab links in the collision range to the numbers those items got.
- `--mapping`: prints, as JSON, every GitLab number whose GitHub number differs.

### Options

- `--through=<iid>`: only items up to this number.
- `--append-collisions`: also creates, at the end, the items whose numbers the target already uses.
- `--cutover`: the confirmation for writing to a protected target, or to one already holding issues.
- `--gitlab-root=<dir>`, `--max-per-hour=<n>` (default 450), `--work-dir=<dir>`.

## Moving a board: links and settings

### scripts/board/links.mjs

- `links.mjs <mapping.json> --dry-run`: says which links in the tree would change.
- `links.mjs <mapping.json>`: rewrites them in place.
- `links.mjs --check [--gitlab=<url>]`: exits `1` while any link to a GitLab item remains. Put it in `lint` after the move.

### factoryKit.migrate

- `protectedRepository`: the real target. Read only when `--repo` names it, and written only with `--cutover` too.
- `confidential`: what happens to GitLab's confidential items. Only the `copy` policy is built.
- `gitlab`: the GitLab project's URL, for the link rewrite.
- `linkFiles`: git pathspecs for the rewrite; default every tracked file.
- GitLab is only read. Every migrated item carries a marker, so a rerun picks up where it stopped.

## Instruction files

### For every agent

- `AGENTS.md`: the canonical instruction set, read in full on every turn. *(kit)* rules hold in every kit repository; *(project)* rules are yours, each with its reason.
- `CLAUDE.md`: imports AGENTS.md and holds only what is particular to Claude Code. One copy of each rule.
- A rule for one package lives in that package's own AGENTS.md, with a one-line CLAUDE.md importing it.

### For the skills

- `docs/agents/project.md`: irreversible failures, routes, order of work, guards, verification and branches, as the skills read them.
- `docs/agents/issue-tracker.md`: every `pnpm items` subcommand, and setting up a board on either provider.
- `docs/agents/releasing.md`: the release procedure.
- `docs/agents/migrating-a-board.md`, `docs/agents/domain.md`.

## Records and templates

### Records

- `docs/adr/`: append-only, numbered architecture decisions. `0000-template.md` is the shape.
- `docs/DECISIONS.md`: calls and traps that are not ADRs, and the risks accepted at setup.
- `TASKS.md`: what is built, what is specified and deliberately parked, and the rough edges.

### For people

- `README.md`: starting a project, where CI runs, kit-owned and project-owned.
- `docs/idea-to-implementation-example.md`: one feature from a reported idea to a release.
- `docs/cheatsheet.md`: this deck. `node scripts/cheatsheet.mjs` renders it, and every kit release attaches it. `--deck=docs/decks/<file>.md` renders the about and what's-new decks the same way.
- `CONTRIBUTING.md`, `SECURITY.md`: how to contribute, and the disclosure route.
- `.github/pull_request_template.md`, `.gitlab/merge_request_templates/Default.md`: what, why, how it was verified, and what the AI wrote.

## Kit-owned and project-owned

The line a future sync will follow.

### Kit-owned: change it upstream

- `scripts/`: the board, the checks, CI and the setup guide.
- `.claude/skills/*`, and `.claude/hooks/guard.mjs` apart from its lists (`GENERATED`, `PROTECTED`, `COMMANDS`).
- `lefthook.yml`, `ci-prune.yml`, `.github/actions/setup`.
- `docs/agents/` except `project.md`, this cheat sheet, the env examples, the request templates, ADRs 0002 to 0006.

### Project-owned: yours

- `AGENTS.md` below the *(kit)* rules, `CLAUDE.md`, `CONTRIBUTING.md`, `SECURITY.md`.
- `docs/agents/project.md`, `TASKS.md`, `DECISIONS.md`, ADRs from 0001.
- `package.json`, `mise.toml`, `biome.json`, `.claude/settings.json`, `ci.yml`.
- The release hooks module and the migrate settings.
- Until a sync exists, copy changes by hand, and mark a local change to a kit file with a comment.

## Adopting: pnpm kit:adopt

Run from a kit clone against an existing repository. Nothing on its default branch or its remote changes.

### What it does

- A dry run by default: three lists, copy, merge and conflict, each with its reason.
- Copies the kit-owned files and the starting points the repository lacks.
- Merges only by adding: a free script name, a devDependency, a hook, a permission, a `.gitignore` line.
- Leaves every other collision alone, with the kit's version beside it as a `.proposed` file.
- `--apply` commits once on `chore/adopt-factory-kit-<version>`, and refuses a dirty tree or an existing branch.

### Where the kit goes

- No `package.json`: the kit's own, with its lockfile, and the kit's lint on the kit's files only.
- On pnpm: the kit joins the project's `package.json`, and `pnpm install` makes the lockfile.
- On npm or yarn: `tools/factory-kit/` with pnpm's lockfile, and the root's `check` calls it.
- Maven, Gradle, .NET or Python: `pnpm check` runs that build's gate after the kit's; the report holds the CI toolchain step.
- Husky or pre-commit: that manager's hooks call `lefthook run <hook> --no-auto-install`; lefthook installs no hooks of its own.
- The version and a hash per kit file go in `factoryKit`, for a later sync.

## One item, start to merge

### Plan

- `pnpm items list` shows the item as new.
- `pnpm items label <iid> analysing`, then the triage skill posts the plan with `comment` and labels it `plan-posted`.
- The reporter answers the `[REVIEW]` points on the board.

### Build

- The advance skill checks coverage and labels it `ready`.
- A person says go.
- `label <iid> implementing`, and a comment naming the branch.
- `pnpm check`, then `pnpm run ci`.

### Ship

- `pnpm items pr <branch> <file>`, and `screenshots <iid> <dir>` for a visual change.
- A person merges.
- A comment with the request and the merge commit, then `pnpm items close <iid>`.

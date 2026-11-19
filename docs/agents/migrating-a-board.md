# Moving a board from GitLab to GitHub

`scripts/board/migrate.mjs` copies a project's GitLab work-item board to a GitHub repository, keeping every
item's number, so `#40` in a commit message, a plan or an ADR still means the same item afterwards.
`scripts/board/links.mjs` then rewrites the tree's links to GitLab work items into links to their GitHub
issues. Both are Node builtins only and run from a checkout with `.env.gitlab` and `.env.github` beside each
other (`BOARD_PROVIDER` is not needed: neither script goes through `pnpm items`). Why it is built this way is
`docs/adr/0004-board-migration-in-the-kit.md`.

It was written for Makers Market's move on 2026-10-12 (375 items, about 2,000 comments, 3,200 uploads, seven
releases) and moved into the kit afterwards. That was the one live run: what it taught is at the end.

## What it copies

- **Every item, at its own number.** Before creating GitLab #N the target's newest issue or pull request must
  be #N−1, and GitHub must answer #N, or the run stops. It never creates under a shifted number. A GitLab
  number that answers 404 gets a closed placeholder, so the numbers after it still line up.
- **The collision range is computed, not configured.** It is every number up to the target's highest that
  does not hold its own GitLab item: the target's own issues and pull requests, a number deleted or burnt
  there, and a number holding an item appended at the end. GitLab items in that range are skipped until
  `--append-collisions` creates them after everything else. Until then a reference to one links to GitLab;
  `--remap` rewrites those links to the GitHub numbers the items got.
- **Comments, folded.** A closed item's whole history goes into its body when it fits under 60,000
  characters, and into as few comments as hold it when it does not. On an open item everything before the
  plan in force folds the same way, and the plan and what follows stay one comment each, so `pnpm items
  list` computes the same state on both sides. Each folded entry names its author, time, kind and GitLab note.
- **Idempotency comes from GitHub.** Every migrated body and comment ends with a
  `<!-- board:migrated … -->` marker (scripts/board/core.mjs), and a marker counts only on something the App
  wrote. A rerun reads the markers back and plans only what differs, so there is no state file, and a rerun
  with nothing new plans exactly 0 writes.
- **Text.** `!N` becomes a link to the GitLab merge request, `@name` is defused with a zero-width space so it
  pings nobody on GitHub, and code is left as written.
- **Uploads, by git push** to the `board-assets` branch, under the adapter's own layout
  (`items/<iid>/<stamp>/<secret8>-<file>`), before any REST write. An upload link whose file segment is not
  a single file name (a `/`, `?` or `#` in it, or `.`, `..`, a separator or a control character once
  decoded) is not copied. It stays a link to GitLab, and the dry run lists it under **REFUSED upload
  links**. Look at that list before the GitLab project is archived, because a genuine file left there is
  lost with it.
- **Releases**, one per GitLab release whose tag the target already has, oldest first, the newest made latest.
  A release whose tag is missing is refused and listed: GitHub would make the tag at the default branch's
  head, which is the wrong commit. Push the tags first, with a person's own credentials.

GitLab is only ever read. Merge requests are not copied: merge or close them first.

## Settings

In the project's `package.json`, under `factoryKit.migrate`. Every key is optional, and a key by any other name
is refused, so a misspelt `protectedRepository` cannot leave the real target open in silence.

| key | what |
| --- | --- |
| `protectedRepository` | The real target, `owner/name`, or a list. Read only when `--repo` names it; written only with `--cutover` as well. |
| `confidential` | `{ "policy": "copy", "color", "description", "notice" }`: what happens to GitLab's confidential items (below). Without it, a board with any stops before planning a write. |
| `gitlab` | The GitLab project's URL. `links.mjs --check` looks for it, and the migration refuses to run when GitLab says the project is somewhere else. |
| `linkFiles` | Git pathspecs for the link rewrite and its check. Default: every tracked file. |

<!-- example -->
```json
"factoryKit": {
  "migrate": {
    "protectedRepository": "owner/repo",
    "confidential": { "policy": "copy" },
    "gitlab": "https://gitlab.example/group/project"
  }
}
```
<!-- /example -->

## The guard

Refusal is the default, with or without settings:

- a run that writes names its target: `--repo=owner/name`, never only `.env.github`;
- a protected target is read only when `--repo` names it, and written only with `--cutover` as well;
- a target that already holds issues or pull requests the migration did not write takes writes only with
  `--cutover`, because its numbers are somebody else's. The refusal lists them.

So a scratch repository you created empty takes a run with `--repo` alone, and anything else needs you to
say, twice, that you mean it.

## Confidential items

Only one policy is built:

- **`copy`**: each confidential item is copied in full, labelled `confidential`, and says so at the top of its
  body (`notice`, one line of the quote per line of the string). Every dry run lists them by number. Everybody
  who can read the target can read them; the label is what makes `pnpm items` withhold their titles there, as
  it does on GitLab, so its name is the adapter's and not a setting.
- **`placeholder`** (a closed issue holding the number, with nothing of the item in it) and **`skip`** (the
  number joins the collision range) are **not built**. Settings naming either are refused. Build one with
  its selftest cases, if a project needs it, and remember that a skipped number is spent for good on GitHub.

Nothing the scripts print carries a confidential item's title.

## The run

Rehearse against a scratch repository first, created empty, with the App installed on it; then against the
real target. A dry run writes nothing anywhere.

```sh
node scripts/board/migrate.mjs --repo=owner/repo --dry-run        # the mapping, the collision range, the confidential list, the cost
node scripts/board/migrate.mjs --repo=owner/repo --cutover --work-dir=<scratch>
node scripts/board/migrate.mjs --repo=owner/repo --dry-run        # must plan 0 writes
node scripts/board/migrate.mjs --repo=owner/repo --cutover --append-collisions --work-dir=<scratch>
node scripts/board/migrate.mjs --repo=owner/repo --cutover --remap --work-dir=<scratch>
node scripts/board/migrate.mjs --repo=owner/repo --remap --dry-run   # 0 writes
node scripts/board/migrate.mjs --repo=owner/repo --verify          # 0 mismatches
```

`--through=<iid>` stops at a GitLab number, for a first partial rehearsal. `--max-per-hour` paces the REST
writes (default 450, at most 500). `--work-dir` keeps the downloaded uploads, so an interrupted run downloads
each once. A run that stops midway is rerun as it was: it reads both boards back and plans what is left.

Nothing else may take a number on the target from the first real run until `--append-collisions` has run:
no issue, no pull request, no Dependabot. Agree that hold with everybody who can.

## The links in the tree

```sh
node scripts/board/migrate.mjs --repo=owner/repo --mapping > <scratch>/mapping.json
node scripts/board/links.mjs <scratch>/mapping.json --dry-run   # moved numbers, and anything LEFT
node scripts/board/links.mjs <scratch>/mapping.json
node scripts/board/links.mjs --check
```

Only the URL changes: `<gitlab>/-/work_items/N` and `<gitlab>/-/issues/N` become
`https://github.com/<repository>/issues/M`, M being N unless the mapping moved it. A `#note_…` fragment is
dropped. A link to a number with no copy is left and reported, and the run exits 1; find out why before
going on. Commit the rewrite as a commit of its own.

Then add `node scripts/board/links.mjs --check` to the project's `lint`, so a link into the archive cannot
come back. It reads `factoryKit.migrate.gitlab`, and with no URL to look for it refuses (exit 2) rather than
pass over nothing.

## What the first real run taught

Each of these happened on Makers Market's run or its rehearsal, and each has a case in
`scripts/board/migrate-selftest.mjs` named `lesson:`, run by `pnpm check:items`, except where it says not.

- **GitHub burns numbers on a 5xx.** While GitHub was degraded, `POST /issues` answered 502, made nothing, and
  used up its number for good. A write is never repeated in place, because one that answered 5xx may have
  happened. The next create then comes back one too high and the run stops there. The stray copy now sits in
  the collision range, and the item whose number was burnt keeps a different number. The repair, if you want
  it, is by hand: point the stray issue's marker at the GitLab item its number belongs to, and the next run
  rewrites it into that item's copy.
- **Pull requests are absent from the issue listing, and refused by number to the board token.** They share
  the issues' numbers, but the `board` token's listing leaves them out and `issues/<n>` answers 403 for one.
  So a refused number is read again as a pull request with the `mr` token, the newest pull request counts
  towards the highest number, and if the `mr` token is refused too the run stops rather than guess.
- **An empty repository refuses git data API calls with 409.** Reading its trees and refs answers 409, which
  the migration reads as no assets and no tags. Writing does too, which is why the adapter's `screenshots`
  cannot start `board-assets` there and the migration's first git push does instead.
- **The hourly content cap.** GitHub allows about 80 content-creating requests a minute and 500 an hour. The
  pacer makes at most one write a second and `--max-per-hour` in any rolling hour, and waits out a
  `rate-limited` answer's `retry-after`. Makers Market's main run, 730 REST writes and 11 pushes, took 73 minutes.
- **Tokens expire mid-run.** An installation token lives an hour and a run waits out the hourly cap, so the
  shared client (`createInstallationClient`, scripts/board/github.mjs) mints one again five minutes before it
  expires, and once after a 401. Its own cases are in `scripts/board/selftest.mjs`.
- **Uploads go by git push to `board-assets`.** They were 3,199 of 3,937 writes as REST uploads, each a
  Contents write under the hourly cap. Pushed with git, in batches of 50 items or 50 MB from a blob-less
  partial clone, they cost minutes. The token reaches git only through a private `GIT_ASKPASS` script, never
  argv or the remote URL, and is scrubbed from git's errors. A refused push stops the run; nothing falls back
  to REST.
- **A hook's inherited `GIT_DIR`.** Under a git hook, `GIT_DIR` names the hook's repository and git follows it
  over `-C` and over `init`'s directory: a selftest's `git init --bare <tmp>` under `pre-push` once
  re-initialised a developer's own repository as bare. Every git the scripts run drops every `GIT_*` variable
  (`gitEnv`).
- **GitHub's listing trails a create** by seconds, and by minutes when it is degraded, when it also left out
  an issue that existed for good. So every number the listing skips is asked for directly, and before a create
  a listing that is behind is read again. A listing that is ahead stops the run.

Not testable offline, and so only written down here: an archived GitLab project may stop serving uploads to a
project token (check one with `curl` after archiving, before the run); GitHub's App has no `workflows`
permission, so tags whose history carries `.github/workflows` are pushed by a person; and private
vulnerability reporting is not available on a private repository, so a project's `SECURITY.md` needs another
route.

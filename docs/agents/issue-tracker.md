# Issue tracker: the work-item board, on GitLab or GitHub

Reports about the product live as **work items**: GitLab work items, or GitHub issues. The repo ships its
own reader, `scripts/work-items.mjs`, exposed as `pnpm items`, and does not use `glab` or `gh` for the
board, because the board's state is computed from labels *plus* comment authorship — a plain issue list
cannot tell our own follow-up from the reporter's reply.

**Which board** is decided by which file exists: `.env.gitlab` or `.env.github` (`.env.gitlab.example` and
`.env.github.example` document them). A credential in the environment counts too. With both, `pnpm items`
refuses to guess; `BOARD_PROVIDER=gitlab|github` settles it. Every command, label, state and skill step is
the same on both, and `<iid>` is the issue number on GitHub. Where the two differ, this page says so;
`docs/adr/0002-board-provider-adapters.md` says why.

Credentials live in those files, deliberately **not** in `.env`: mise exports everything in `.env` into every
process, and a credential no application process reads does not belong in the application's environment.

- **GitLab**: two tokens. `GITLAB_TOKEN` (Reporter, a **project** access token, so its comments are
  authored by a bot the state machine can tell apart from people) runs everything; `GITLAB_MR_TOKEN`
  (Developer) is read only by `mr`. `.env.gitlab.example` says why they are kept apart.
- **GitHub**: one GitHub App, whose comments are authored by `<slug>[bot]`. Each command mints an
  installation token for the scope it needs — `board` (issues), `assets` (contents, for attachments) or
  `mr` (pull requests) — in memory only, so the token every session uses cannot open a pull request. The
  App's private key can mint all three, so it is the secret to guard.

## Setting up a new project's board

### GitLab

1. Create a project access token with the `api` scope, role Reporter; put it and the project's numeric id
   in `.env.gitlab`.
2. `pnpm items list` — an empty board prints nothing wrong. The `ai:` labels are created on first use.
   A warning that `GITLAB_TOKEN` belongs to a person means a personal token went in: that person's own
   replies would read as the bot's follow-up, so replace it with a project access token. Its user is the
   one `GET /api/v4/user` answers with `"bot": true`.
3. Optionally a second project access token, role Developer, as `GITLAB_MR_TOKEN`, for `pnpm items mr`.
   Leave `master` (or `main`) protected with **Allowed to merge: Maintainers**, so that token can open a
   merge request and not merge one; the setup guide fails the step when Developers may merge.
4. Open a session: the `SessionStart` hooks in `.claude/settings.json` print the board and the open release
   milestones. Off the VPN, or with no `.env.gitlab`, they stay silent by design.

### GitHub

**Reuse a shared organisation App, if there is one.** One App, for example "Factory Kit board", can serve
every kit repository in an organisation: install it on each repository separately (*the App's page →
Configure → Repository access*), and use the organisation's key for it. Then only steps 2–7 below apply,
and they need repository admin rather than organisation admin. The trade-off: one key now
writes to every repository the App is installed on, so whoever holds it holds all of them. A team that
does not want that creates a per-project App, as below.

**If you are not an organisation admin**, send one this request: *"Please create a GitHub App owned by
the organisation, with no webhook, repository permissions Issues, Pull requests and Contents (read and
write) and Metadata (read), install it on `<owner>/<repo>`, and send me its App id and a private key."*
`pnpm kit:setup` shows the same text with the repository filled in.

1. **Create a GitHub App** owned by the organisation (*Settings → Developer settings → GitHub Apps*). No
   webhook. Repository permissions: **Issues** read and write, **Pull requests** read and write,
   **Contents** read and write, **Metadata** read. Name it for what it is (`<project> board`): its comments
   are signed `<slug>[bot]`.
2. **Install it on this repository only**, and generate a private key. Keep the `.pem` file outside the
   repository; `*.pem` is git-ignored and the pre-commit hook refuses a key regardless.
3. **Protect the default branch** with a ruleset that requires a pull request **with at least one approval,
   dismissed when new commits are pushed**, and does **not** list the App as a bypass actor. With no
   approval the App could merge its own pull request, and without the dismissal it could push after a
   person approves. That is what keeps merging a human step, and it keeps the App's `contents` permission
   off product branches; the App writes only `board-assets`.
4. **Turn on *Automatically delete head branches*** in the repository settings. GitLab's merge request
   deletes its source branch; a GitHub pull request has no per-request switch.
5. Copy `.env.github.example` to `.env.github` and fill in the repository, the App id and the key's path.
   `pnpm items list` should answer. The `ai:` labels are created on first use; the `board-assets` branch on
   the first attachment.
6. Vulnerability reports do not go on the board. GitHub issues cannot be confidential, so turn on
   **private vulnerability reporting** and point the project's security policy at it.
7. Run the smoke checklist below once, against a scratch repository or a first real item.
8. **Moving from a GitLab board?** Copy it across first, numbers and all, before anything else takes a
   number on the repository: `docs/agents/migrating-a-board.md`.

### GitHub smoke checklist

The selftest drives the GitHub adapter through a fake API. This is the run against the real one, once per
App, because a wrong permission shows up only there.

- [ ] `pnpm items list` answers, and an open pull request is not listed as an item.
- [ ] `pnpm items label <n> analysing` creates `ai:analysing` and puts it on the issue.
- [ ] `pnpm items comment <n> <file>` posts as `<slug>[bot]`; reply on the issue as yourself, and
      `pnpm items show <n>` marks your comment `reply` and the bot's `ours`.
- [ ] `pnpm items create <file> <n>` opens an issue whose last line is `Relates-to: #<n>`;
      `pnpm items show <n>` lists it under `siblings`; `pnpm items unlink <new> <n>` removes the line.
- [ ] `pnpm items create --batch <file> --apply` on a three-entry file with a `Needs:`, a `Relates:` and a
      `release-*` label opens the items in order, with `Depends on #n` and `Relates-to: #n` in the bodies,
      and the label and milestone created. Run it again: it creates nothing.
- [ ] `pnpm items screenshots <n> <dir>` creates `board-assets` on first use, and the images render in the
      comment.
- [ ] `pnpm items label <n> release-0.0.1` creates the milestone and puts the issue in it;
      `pnpm items releases` counts it.
- [ ] `pnpm items pr <branch> <file>` opens a pull request, and the App cannot merge it.
- [ ] `pnpm items close <n>` closes the issue as completed and drops its `ai:` label.

## Conventions

- **List the board**: `pnpm items list` — every open item with its computed state. Filters:
  `--new`, `--answered`, `--ready`, `--blocked`, `--parked`, `--stale`. Output shape: `--brief`, `--json`.
- **Read an item**: `pnpm items show <iid>` — description, analysis and every comment as JSON. Each comment
  carries a `kind`: `plan`, `coverage`, `reply`, `ours`. `rounds` counts the coverage rounds so far.
  A confidential item is withheld from `list` and refused by `show` unless you pass `--confidential`; what
  it says stays out of comments, commits and merge requests (`scripts/work-items.mjs`, `cmdShow`). GitHub
  issues have no confidential flag, so there the tooling treats an issue labelled `confidential` as one: a
  board moved from GitLab keeps its confidential items' titles out of listings that way. The label hides
  nothing from a reader of the repository. The same holds for a confidential item seen from another one: a
  sibling in `show` or `list --json` is `(confidential)` with its state and a fixed `why`; `close` and
  `release finalize` print `(confidential)` for its title; and `collisions` reports its overlaps without
  the files and lines its plan cites. `--confidential` on `show` and `collisions` lifts that.
- **Comment**: `pnpm items comment <iid> <file>` — the body comes from a file, not a flag, so a plan can be
  drafted and reviewed before it is posted.
- **Label**: `pnpm items label <iid> <state>` where state is one of `analysing`, `plan-posted`, `answered`,
  `ready`, `blocked`, `parked`, `implementing`, `none`. Labels outside the `ai:` set are preserved.
- **Post screenshots**: `pnpm items screenshots <iid> <dir> [intro-file]` — uploads the e2e PNGs and posts
  them as one comment. A visual change goes back to the item as images, not as prose. On GitHub, which has
  no upload API for comments, the files are committed to the orphan `board-assets` branch
  (`items/<n>/<time>/`) and embedded from there.
- **Open a follow-up**: `pnpm items create <file> [relates-to-iid] [labels]` — the first line of the file is
  the title and the rest is the description, so both are reviewable in one diff before anything is posted.
  The optional iid links the new item to the one it was split out of: a `relates_to` link on GitLab, a
  `Relates-to: #<iid>` line at the end of the new issue's body on GitHub. For the half of an
  agreed plan that was deliberately cut, and **not** for something already reported — check
  `pnpm items list` first. A link is also a hold: `advance-work-items` will not start an item while a
  linked item is not ready. So leave the iid off when the parent is still open and the new item comes
  *after* it (a later stage, an idea for afterwards), and name the parent in the description instead.
- **Open many at once**: `pnpm items create --batch <file>` prints what it would create, and
  `pnpm items create --batch <file> --apply` creates it. For seeding a board with a backlog: a
  modernization plan, an audit's findings, an adoption checklist. The file is Markdown. A `Batch: <id>`
  line comes before the first entry, and any other line there is a note. Each entry starts with
  `=== <key>`, then optional `Labels:`, `Needs:` and `Relates:` lines, then the same text a single
  `create` file has: a title line, then the body.

  ```
  Batch: modernize-2026

  === inventory
  Labels: release-1.0.0, feedback

  Inventory the services
  Every service, its owner and its runtime.

  === split
  Labels: release-1.1.0
  Needs: inventory
  Relates: #12

  Split the monolith
  ```

  Keys are `[a-z0-9-]+`, and `Needs:` and `Relates:` take keys from the same file or `#n` for an item
  already on the board. **`Needs:` sets the order, not a link.** An entry is created after what it needs,
  and its body gets a `Depends on #n` line carrying the real number, with no hold. **Only `Relates:`
  links**, and a link is a hold, as with `create`: a seeded board whose later phases were linked to their
  earlier ones would block itself. The dry run marks each link `(a hold)`. A link is written once, at
  whichever end is created later: in the body of the one POST on GitHub, and as a link after the create
  on GitLab. `release-*` labels are created when missing, and the milestone follows the label as usual.
  Every created body carries a hidden last line, `<!-- factory-kit-batch: <id>/<key> -->` (before any
  `Relates-to` lines), and the apply reads the whole board, open and closed, for it. That makes a re-run
  safe: an entry already on the board is skipped, and its milestone and links are checked and filled in
  if missing. The apply stops at the first failure and prints the command that resumes it. The file is
  checked whole before anything is written: an unknown key, a cycle in `Needs:`, two release labels on one
  entry, or a key found on two items are all refused with nothing written. Don't edit the marker line out
  of a body, or a re-run creates the entry again (`scripts/board/batch.mjs`).
- **Remove a link**: `pnpm items unlink <iid> <other-iid>` — drops the link, and with it the hold. Use it
  when a link joins things that are not one defect: an umbrella and the items under it, or a later stage
  still linked to an open parent. On GitLab the two items' text is untouched; on GitHub the `Relates-to`
  line is removed from whichever body carries it, which is also how to do it by hand.
- **Close**: `pnpm items close <iid>` — closes the item and drops its `ai:` label in the same call, so a
  closed item never goes on claiming to be under analysis or under way. Labels outside the `ai:` set are
  preserved, as with `label`. It warns on stderr, and closes anyway, when the item carries no comment at
  all: the record of what shipped belongs on the item, but a duplicate or a mistake is a legitimate close
  with nothing to say.
- **Items the bot opened**: an item made by `pnpm items create` (a follow-up, or a seeded board) works like
  any other. Who opened an item is never read, so on an item the bot opened and planned, the first comment
  by anyone who is not the bot is the reply, and the item reads `answered`. The `Reported by` field is
  empty there rather than the bot. Links the bot made hold exactly as hand-made ones do. Nobody is
  subscribed to a bot-opened item, so whoever is to answer it hears through repository watching.
- **When the identity lookup fails** (`/user` on GitLab, `/app` on GitHub), only a plan or a coverage
  round still counts as ours: any other bot comment, such as "implementation started", reads as a reply,
  and the item shows `answered`. A known limit, pinned by the selftest.
- **Overlapping work**: `pnpm items collisions` — items whose scopes touch. It reads the plans' citations
  only, never links or authors, so a bot-opened item is no different there.
- **Release milestones**: `pnpm items milestones [--dry-run]` — puts every item, open or closed, in the
  milestone of the same name as its `release-*` label, creating the milestone when it does not exist yet.
  **The label is the source of truth and the milestone follows it**, so tag an item for a release by
  labelling it (`pnpm items label <iid> release-0.3.0`, which replaces any other `release-*` label);
  never set the milestone alone. Two release labels on one item are
  reported and left alone, and so is a `release-*` milestone with no label behind it. `label`, `create`
  and `close` keep their own item in step as they write it, and a `SessionStart` hook in
  `.claude/settings.json` sweeps the whole board, which catches a
  label set by hand in the web UI, and opens the session with one line per open release milestone. A
  shipped item gets the label of the release it shipped in.
- **What is in a release**: `pnpm items releases` — one line per open release milestone, with its due date
  and open and closed counts; `pnpm items releases <milestone>` lists its items, open ones first, with
  each open item's `ai:` label. Read-only and pre-approved; a confidential item is listed by iid alone.
- **Merge request**: `pnpm items mr <branch> <file> [title] [--target=<branch>]`, or `pnpm items pr …` —
  opens a merge request on GitLab (needs `GITLAB_MR_TOKEN`) or a pull request on GitHub. The target defaults to the project's default branch; work on a release branch passes `--target=<branch>`
  (see `docs/agents/project.md` §9).
- **Who merged a request**: `pnpm items mr-status <branch> [--json]` — the newest merge or pull request from
  that branch, its state, and who merged it (`mergedByBot` is true when the board's own credential did,
  which the default branch's ruleset should make impossible). Reads only; the setup guide's demo step uses it.
- **Cut a release**: `pnpm items release prepare <release-x.y.z> --from=<branch> [--at=<sha>] [--notes]
  [--apply]`, then, after a person merges, `pnpm items release finalize <release-x.y.z> [--no-whats-new]`,
  plus any flag the project's release hooks declare. The dry run (no
  `--apply`) only reads. `pnpm items release deck <release-x.y.z>` previews the "what's new" slides from this
  checkout and writes nothing else. `docs/agents/releasing.md` has the procedure.
- **Validate the state machine**: `pnpm check:items` — offline, no token, runs in the pre-push hook. It
  also drives both adapters through a fake API.

Read subcommands are pre-approved in `.claude/settings.json`. `comment`, `label`, `create`, `unlink`, `milestones` and `release` prompt,
because they write to a board other people read.

## MRs as a request surface

**No.** Merge requests and pull requests are our own in-flight work, not a report surface. Reports arrive
as work items. On GitHub the issues API returns pull requests too; `pnpm items` drops them from every
listing, so an open pull request never reads as a `new` item.

## Where the providers differ

- **Closing on merge.** A merge request or pull request saying `Closes #13` closes the item when it is
  merged into the **default** branch. On GitHub, one merged into another branch (a version line branch)
  closes nothing. `pnpm items close <iid>` is owed either way, because it is what drops the `ai:` label.
- **Releases.** A GitHub release cannot carry a milestone; `docs/agents/releasing.md` says what to do
  instead.

## When a skill says "publish to the issue tracker"

Post a comment on the existing work item with `pnpm items comment <iid> <file>`. Do not open a new issue
for something already reported; check `pnpm items list` first.

## When a skill says "fetch the relevant ticket"

`pnpm items show <iid>`.

## The board already has a state machine

The `ai:` labels (`ai:analysing`, `ai:plan-posted`, `ai:answered`, `ai:ready`, `ai:blocked`, `ai:parked`,
`ai:implementing`) are the state machine, defined in `scripts/work-items.mjs` and asserted by
`pnpm check:items`. Two skills in `.claude/skills/` drive it: `triage-work-items` takes an item to a posted
plan carrying numbered `[REVIEW]` points; `advance-work-items` maps the reporter's reply onto those points
and implements once they are covered **and a human says go**.

**These are the triage roles for this repo.** The five-label vocabulary the plugin's `/triage` skill assumes
(`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`) is deliberately not
configured here, and there is no `docs/agents/triage-labels.md`: a second state machine on the same board
would make both of them unreliable. Use `triage-work-items` and `advance-work-items` instead of `/triage`.

## Wayfinding

`/wayfinder`'s map-and-children model is not wired to this board; `pnpm items` has no notion of a map issue
or a blocking link. Use it only against a scratch tracker, or not at all.

## Keeping an item current

The board is the only record of this work that somebody else can read — a session transcript is not a
handover. At each transition, before moving on: work starts → `pnpm items label <iid> implementing` plus a
comment naming the branch and the plan; a decision that changes the plan → a comment recording it and why;
merged → a comment with the merge request, the commit and the merge commit; a visual change →
`pnpm items screenshots <iid> <screenshot dir>`; delivered only in part → close against what shipped
and raise a follow-up item carrying the rest. The close itself is `pnpm items close <iid>`, after the
comment that records what shipped — it takes the `ai:` label with it.

One trap: a comment posted by the tooling is authored by the *bot*, and the state machine reads authorship
to tell the reporter's reply from our own follow-up. A decision taken in chat therefore needs both a comment
**and** a label that matches reality, or the item sits in `plan-posted` waiting for an answer that has
already been given.

# factory-todo — guide for humans and AI agents

A todo web app: a React + Vite client, a Hono server on Node and SQLite, all TypeScript. This file is the canonical instruction set for any coding
agent (Claude Code reads it via CLAUDE.md; Codex, Cursor, Copilot and friends read AGENTS.md directly).
Keep it short and true; update it when you change how things work.

> **Started from the Knowit Factory Kit.** The ground rules below marked *(kit)* are the method and hold in
> every kit repository; rewrite their wording if you must, but not their intent. Rules marked *(project)*
> are this codebase's own — the kit ships none, only an example of what they look like. Codebase specifics
> the board skills need go in `docs/agents/project.md`, not here.

**What belongs in this file** *(kit)*. This file and CLAUDE.md are read in full on every turn of every
session, so every line here costs something before any work starts. Keep only the current rule and the
reason for it:

- **No history or snapshots.** Dates, run counts, which branch something was once built on, and how a rule
  came to be beyond its one-line reason all belong in `docs/DECISIONS.md` or `TASKS.md`. Don't hard-code
  what changes every release, such as the current line branch's name: say where to look it up
  (`pnpm items releases`).
- **A rule that applies to one part of the codebase lives next to that part.** Put an AGENTS.md in the
  package's own directory, and beside it a CLAUDE.md whose one line imports it (@AGENTS.md).
  Claude Code loads a subdirectory's file only while working there, and the other tools read the nearest
  `AGENTS.md` the same way. UI conventions go to the web package, and database and route conventions to
  the API package. This root keeps what applies everywhere.
- **One copy of each rule.** CLAUDE.md holds only what is particular to Claude Code.
- **A rule a tool can enforce is enforced, not only written down.** That means a git hook, a lint rule, or
  for agents, `permissions.deny` and the PreToolUse guard in `.claude/`. The prose keeps the reason.
- **A procedure is a skill** in `.claude/skills/`, loaded when it is needed.

## Ground rules

1. **Run `pnpm check` before you say something is done.** *(kit)* It is the single gate: lint + typecheck +
   tests, whatever this project's stack makes those. Visual changes also need the end-to-end suite and its
   screenshots, attached to the merge request and, when the change came from a work item, to the item
   (`pnpm items screenshots <iid> <dir>`). A reviewer who has not checked the branch out should still be
   able to see what merging it looks like. Before a merge request, run **`pnpm run ci`**. It runs the
   pipeline's gates where the developer has chosen (`CI_MODE`: `local`, `remote` or `split`; README, "Where
   CI runs"), and you follow that choice rather than pick one. Link a remote run in the merge request. It is
   `pnpm run ci`, not `pnpm ci`: pnpm reserves `ci`.
2. **Run `pnpm check` after pulling the default branch, before starting work on top of it.** *(kit)* Every
   gate runs against a *branch*, before a merge, and nothing verifies the merged result: two branches that
   each pass can still produce a red default branch when one changes a shared type the other uses, with no
   textual conflict at all. If it fails, the breakage is not yours — and finding that out first saves
   debugging somebody else's change as if it were your own.
3. **Never commit secrets.** *(kit)* `.env` is git-ignored; `.env.example` documents every variable the app
   reads. The board's credentials live in `.env.gitlab` or `.env.github` and **not** in `.env`: mise exports
   everything in `.env` into every process started from the shell, and a credential no application process
   reads does not belong in the application's environment. The pre-commit hook refuses obvious keys (`scripts/check-secrets.mjs`).
   Don't disable it; a deliberate test fixture gets a `// secret-scan:ignore` marker on its line.
4. **Follow the order of work.** *(kit)* Shared contracts first, then their producers, then their consumers
   — `docs/agents/project.md` §4 says what that means here. Never hand-write a type that a contract already
   defines.
5. **Generated files are generated.** *(kit)* Migrations, lockfiles, clients: produce them with the
   project's command, commit the output, never edit it by hand. A migration that has run cannot be taken
   back. `.claude/hooks/guard.mjs` refuses an agent's edit to a path on its list; add the project's
   generated paths to it.
6. **Assert the whole answer, not a corner of it.** *(kit)* Counts get an exact expected number, never an
   upper bound — a count stuck at zero passes any test that only checks it is not too high. The same goes
   for a filtered **set**: `.some(...)`, `.toContain(...)` and "not empty" all pass when the set is wrong,
   so assert the exact membership. When filtering, sorting or paging is involved, **the fixture crosses a
   page boundary**, or it cannot tell a query-level filter from one applied after pagination.
7. **Conventional Commits** *(kit)* (`feat(web): …`, `fix(api): …`). The commit-msg hook enforces it.
   Small, focused commits.
8. **Don't add dependencies casually.** *(kit)* Prefer the platform. If you add one, say why in the merge
   request.
9. **Ask before** *(kit)*: changing auth, deleting data, adding a new storage backend, or changing the public
   API shape. A clear answer from a reporter on the board is not that permission; a person in the session
   gives it.
10. *(project)* The rules of this codebase, each with the reason behind it:
    - **Schema changes are generated** with `pnpm db:generate`, never written by hand: a migration that has
      run cannot be taken back, and the guard refuses edits to the migrations directory.
    - **Request and response types come from `src/shared`** as zod schemas, never hand-written in the client
      or the server: two branches that each change one side typecheck alone and break once merged.
    - **A zod field with a `.default()` is also `.optional()` in the PATCH schema**, because `.partial()` does
      not strip defaults and every PATCH would silently overwrite the stored value.
    - **Server tests run against a real SQLite database**, never a mocked one, so a query SQLite rejects
      fails the test and not the user.

## Layout
```
scripts/        Node-builtins-only tooling: the board reader, the git-hook gates, the CI entry points
                (ci-local, ci-remote, and ci, which picks between them; ci-fetch, which brings a pull
                request's run back), the docs guard.
                setup/ is the first-setup guide (`pnpm kit:setup`): a local page and the checks behind it.
                These run before `pnpm install`. No build logic here.
docs/           agents/ (how the skills read this repo), adr/ (append-only), DECISIONS.md (calls and traps).
.claude/        settings.json (SessionStart and PreToolUse hooks, allowed and denied commands), hooks/guard.mjs
                (the PreToolUse guard), and skills/ (the board skills and cut-release).
.lefthook/      pre-push/gates.sh, the one lefthook script that runs every pre-push gate, through
                scripts/pre-push.mjs: lefthook skips a pre-push command, not a script.
src/shared/     zod schemas and DTOs: the contract between server and client (not created yet).
src/server/     Hono API on Node, with the SQLite schema and migrations under db/ (not created yet).
src/client/     React + Vite single-page app (not created yet).
```

## Commands
| what | command |
| --- | --- |
| install toolchain | `mise install` (node + pnpm pinned in mise.toml) |
| first setup of a new project | `pnpm kit:setup` — opens the setup guide in the browser; each step checks itself |
| bring the kit into an existing repository | `pnpm kit:adopt <path>` from a kit clone — a dry run; `--apply` commits on a branch there (README, "Adopt into an existing repository") |
| everything the hooks run | `pnpm check` (also the pre-push hook) |
| everything CI runs | `pnpm run ci` — in the developer's `CI_MODE` (`.mise.local.toml`; `local` by default) |
| … on this machine | `pnpm ci:local` — `--no-container` skips the container parts, `--only=<scripts>` runs a subset, `--image=<tag>` tests a prebuilt image, `-- <args>` go to the e2e step; `--help` lists the steps |
| … on GitHub runners | `pnpm ci:remote` — pushes a snapshot of the working tree to `ci/<login>/<sha>`, runs `.github/workflows/ci.yml`, reports back, deletes the branch |
| a pull request's run, back here | `pnpm ci:fetch <pr number or URL>` (or a run's URL, or `--run=<id>`) — waits for its CI run at its head, prints each job and the failing logs, downloads the `test-results` artifact. Reads only |
| the work-item board | `pnpm items list` (also `show <iid>`, `collisions`, `comment`, `screenshots`, `label`, `create` (`--batch` for many), `unlink`, `close`, `milestones`, `releases`, `mr` or `pr`, `release`) |
| the board's state machine | `pnpm check:items` — offline, no token, runs in the pre-push hook |
| cited paths in docs | `node scripts/check-docs.mjs` — part of `pnpm lint`; also fails on two records sharing a number |
| the next ADR number | `pnpm lease adr` — leases it on origin for this branch, before the file is written; `--list`, `--prune`. The pre-push hook refuses an unleased one |

## The work-item board

Reports arrive as **work items** — GitLab work items or GitHub issues, whichever board `.env.gitlab` or
`.env.github` names — and `pnpm items list` is how you read them. A Claude Code `SessionStart` hook prints
the same report when a session opens, and stays silent when there is nothing to act on or when the board
is out of reach. State per item is computed from `ai:` labels plus the comment history, so the board shows
*analysing now* apart from *plan posted* apart from *the reporter has replied*. Two skills in `.claude/skills/` drive it: `triage-work-items` gets an item to a posted plan
carrying numbered `[REVIEW]` points, `advance-work-items` maps the reply onto those points and implements
once they are covered **and a human says go**. Nothing is dispatched or implemented off the board report
alone; an item labelled `ai:parked` is not to be worked on at all unless somebody names it.

**Keep the item current, every time, without being asked.** The board is the only record of this work that
somebody else can read — a session transcript is not a handover. At each transition, before moving on:
work starts → `pnpm items label <iid> implementing` and a comment naming the branch and the plan; a
decision that changes the plan → a comment recording it and why; merged → a comment with the merge request,
the commit and the merge commit; a visual change → `pnpm items screenshots <iid> <dir>`; delivered only in
part → close against what shipped and raise a follow-up item carrying the rest. A `release-*` label names
the release an item belongs to, and the milestone of the same name follows it (`pnpm items milestones`).
`pnpm items close <iid>` is the last transition and drops the `ai:` label as it goes. **Run it even when
the tracker has already closed the item** — a merge request (a pull request on GitHub) saying `Closes #13`
shuts it on merge into the default branch, and the label is still there. An item whose state is stale is
worse than one nobody opened, because the board is believed.

One trap worth knowing: a comment posted by the tooling is authored by the *bot*, and the state machine
reads authorship to tell the reporter's reply from our own follow-up. A decision taken in chat therefore
needs both a comment **and** a label that matches reality, or the item sits in `plan-posted` waiting for an
answer that has already been given. For the same reason the board's GitLab token must be a project access
token: on a person's own token, that person's replies read as ours (`pnpm items` warns on stderr).

## Agent docs

- **Issue tracker**: `docs/agents/issue-tracker.md` — every `pnpm items` subcommand, and setting up a board
  on GitLab or GitHub.
- **This codebase, for the skills**: `docs/agents/project.md` — irreversible failures, routes, order of
  work, guards, verification.
- **Releases**: `docs/agents/releasing.md`.
- **Moving a board from GitLab to GitHub**: `docs/agents/migrating-a-board.md`.
- **Domain docs**: `docs/agents/domain.md`.

## When you're unsure
Look at an existing file of the same shape and copy its structure. Prefer deleting code to adding it.
Write the decision down in `docs/adr/` if it's something the next agent would otherwise have to re-derive,
leasing its number first (`pnpm lease adr`).

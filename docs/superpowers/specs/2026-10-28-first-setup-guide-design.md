# First-setup guide: design

Work item: #16. Status: draft, awaiting approval. Calls marked *(builder-check call)* were made by the
agent while writing this up, not decided by the tech lead; check them.

## Intent

A tech lead starting a new project from the Factory Kit should get from a fresh clone to a running factory
in under an hour, alone, without piecing the steps together from README.md, AGENTS.md, the agent docs and
the `.env.*.example` files. Today a missed step shows up later as an unclear error: `pnpm items list`
answering `404` because the board's GitHub App is not installed on the repository is the case that
prompted this item.

"Running factory" means more than tooling that answers. The tech lead also understands where the human
stays in the loop and how work moves through the board, because they have done it once themselves.

## Who it is for

A tech lead starting a new project from the kit. Not, in this version, a developer joining a project that
already uses it.

## Goals

When the guide is finished:

1. The repository has a working board, CI in the chosen `CI_MODE`, and git hooks that fire.
2. The project-specific settings are filled in and committed: AGENTS.md (title line, *(project)* ground
   rules, layout), `docs/agents/project.md` (every section, examples and `<!-- example -->` markers
   replaced), SECURITY.md, the two lists in `.claude/hooks/guard.mjs`, `docs/adr/0001`'s date, and
   `check` pointed at the stack's lint, typecheck and tests.
3. The tech lead has walked one demo item through the whole loop (plan, `[REVIEW]` points, go, pull
   request, human merge, close) on the real board, and has seen the human gates as gates.
4. The GitHub App (or GitLab token) setup has been explained step by step, with visuals, and verified.

## Anti-goal

**Setup taking over an hour** is a failure even if every step works. Every step's design is judged
against that budget, including the time Claude spends in the interview and the demo.

## Non-goals

- The joining-developer path.
- Syncing a project with later kit versions (README, "Not in this version").
- Anything that stores state outside the repository and the board.

## Shape (decided)

**An interactive stepper in the browser, opened from the freshly cloned repository.** A progress rail on
the left lists the steps; the main panel explains one step in plain language ("grandmother guide"), shows
a picture of it, runs a real check, and on failure says in plain words what the error means and what to
click. A red step blocks moving on but can be skipped explicitly.

Chosen over a single long scrolling page and over a one-screen "factory floor" map. The map's picture of
the work loop with the human gates marked is still worth reusing as the illustration in step 7.

## How it is built

- **Opened by** a pnpm script run after `mise install && pnpm install` (name left to the builder;
  `pnpm setup` is reserved by pnpm itself, so something like `pnpm kit:setup`). It starts a local server
  and opens the browser.
- **The server uses Node built-ins only** and lives in `scripts/`, like the rest of the kit tooling. It is
  kit-owned: add it to README's kit-owned list.
- **Progress is read from the repository and the board**, never stored by the page. Closing the tab or
  coming back the next day loses nothing; every check is re-run on load.
- **The checks reuse the existing commands** (`pnpm items list`, `pnpm check`, `pnpm check:items`, git
  state, file contents) rather than reimplementing them, so the guide cannot drift from what the tooling
  actually does.
- **Visuals**: screenshots of the GitHub and GitLab screens the tech lead must click through, and diagrams
  of the board flow. Diagrams as inline SVG; how screenshots are kept current is left to the builder.

## The steps

Each step: what it is for, in plain words; a picture; a live check; a plain-words fix on failure.

1. **Toolchain.** node and pnpm at the versions in `mise.toml`.
2. **Fresh history and first push.** The kit's history is gone, `main` exists, lefthook hooks are
   installed, the remote exists (the guide walks through creating the GitHub repository or GitLab project
   and checks it), and `chore: start from the Factory Kit <version>` is committed and pushed to it, so
   later steps have a default branch to protect and open pull requests against. The page shows the git
   commands; it never runs `rm -rf .git` or any other history rewrite itself. A clone from a template
   repository arrives with an "Initial commit"; the kit-version commit goes on top of it, and nothing is
   rewritten. *(Builder-check call.)*
3. **Board.** Choose GitLab or GitHub. GitHub has two paths, and the guide supports both:
   - **Reuse a shared org App** (e.g. one "Factory Kit board" App for the organisation): install it on
     this repository and get its key. Needs repository admin only.
   - **Create a new App** with the permissions `docs/agents/issue-tracker.md` lists, install it on this
     repository only, generate the key. Needs an org admin; when the tech lead is not one, the guide gives
     them a ready-to-send request for their admin, listing exactly what to create.

   Either way: keep the `.pem` outside the repository and fill in `.env.github`. `issue-tracker.md` today
   describes only the per-project App; it gains the shared-App path. GitLab: Reporter project access token with `api`, plus the Developer
   `GITLAB_MR_TOKEN` the demo's merge request needs (step 7.4), fill in `.env.gitlab`. Keep only the one used. Check: `pnpm items list` answers. Failures are translated, e.g.
   `404 … /installation` means "the App exists but is not installed on this repository".
4. **Branch protection.** A ruleset requiring a pull request, App not a bypass actor; on GitHub also
   *Automatically delete head branches* and private vulnerability reporting. Checked with the tech lead's
   own `gh` login (GitLab: their own `glab` login or a personal token), not the App: the App's
   permissions stay as they are.
5. **CI mode.** `local`, `remote` or `split`, with what each costs in time and runner minutes, written to
   `.mise.local.toml`. On GitLab, `remote` and `split` are offered only when a GitHub mirror exists
   (README, "GitLab or GitHub"). The demo in step 7 runs in the chosen mode, and the hour includes that
   run. *(Builder-check call.)*
6. **Your project.** The page hands over to Claude Code in the terminal (it shows the exact prompt to
   paste). Claude interviews the tech lead and writes the files listed under Goals, item 2. The page ticks
   the step when no placeholder and no `<!-- example -->` marker remains and `pnpm check` passes.
7. **Demo item**, on the real board, kept afterwards as the project's worked example:
   1. The guide files a trivial demo item.
   2. In Claude Code, the tech lead asks for triage; the agent posts a plan with two `[REVIEW]` points.
   3. The tech lead answers **one point by replying on the board** and **the other through Claude Code's
      in-session picker** (the multiple-choice prompt). The guide explains the trap AGENTS.md names: an
      answer posted by the tooling is authored by the bot, so the agent must post the answers as a comment
      **and** set the label to match, or the item stays in `plan-posted`. Both paths end in the same board
      state, and the guide shows that.
   4. The tech lead says go; the agent implements, runs `pnpm check`, opens the pull request.
   5. The tech lead reviews and merges. The App cannot merge, which is the point the guide makes.
   6. `pnpm items close`; the guide shows the item's full history.

   The page watches the board and ticks each stage as it happens, with a short note at 3, 4 and 5: "this
   is where you were in the loop". On GitHub this walk also covers the smoke checklist in
   `docs/agents/issue-tracker.md`, which is otherwise a separate once-per-App chore.
   **What the page can see** *(builder-check call)*: stages are read from the item's `ai:` label and
   comments, and from the pull request's state. "Go" ticks when the item turns `implementing`; "merged by
   a human" ticks from the merge's author. The two answer paths are told apart by authorship, which is how
   the guide shows the bot-authored trap. A read-only JSON output added to `scripts/work-items.mjs` is in
   scope, so the page does not parse `pnpm items show` text; it counts as reuse, not reimplementation.
8. **Done.** A summary screen: what is set up, where the worked example lives, what to read next.

## Writing model *(builder-check call)*

The server writes nothing without a click. Each write is an existing command the page names before
running it (`pnpm items create`, writing `.mise.local.toml`); anything destructive or touching git history
is shown as commands for the tech lead to run.

## Left to the builder

- The script name, port choice, and how the browser is opened.
- Visual style, within "plain, calm, readable by a non-specialist".
- What the demo item asks for, as long as it is trivial and leaves a real merged change.
- How screenshots are produced and kept in step with the GitHub and GitLab UIs.
- Whether the step-6 interview is a new skill in `.claude/skills/` or a prompt the page hands over.

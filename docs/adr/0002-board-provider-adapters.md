# 0002. One work-item board on GitLab or GitHub, through provider adapters

Date: 2026-10-05 · Status: accepted

## Context
The kit came out of Makers Market, which runs on GitLab, so its board tooling (`pnpm items`, the two board skills,
the `SessionStart` hooks and the merge-request flow) spoke only GitLab. The kit itself lives on GitHub
Enterprise Cloud, and Knowit projects live on both hosts. A kit that serves one host gets forked for the other.
The full design is in `docs/superpowers/specs/2026-09-30-github-board-design.md`.

## Decision
- **One `pnpm items` for both providers**, with the same subcommands, state machine, output and skill
  procedure. `<iid>` is the issue number on GitHub; `mr` stays, with `pr` as an alias.
- **Core and adapters.** `scripts/board/core.mjs` holds the rules over normalized `Item`, `Comment` and
  `Milestone` shapes and does no I/O; `gitlab.mjs` and `github.mjs` implement one adapter interface;
  `work-items.mjs` is the CLI and never calls fetch. The rejected alternatives were a provider branch inside
  every command, or a GitHub adapter that fakes GitLab's JSON.
- **The provider is chosen by which of `.env.gitlab` and `.env.github` exists** (or which credential is in
  the environment). Both is refused rather than guessed, because a wrong guess posts a plan on an unrelated
  item that has the same number. `BOARD_PROVIDER=gitlab|github` settles it.
- **On GitHub, the board authenticates as a GitHub App.** The state machine tells our comments from the
  reporter's by author. A GitLab project token is a built-in bot. On GitHub only an App (`<slug>[bot]`) gives an
  identity that is never a person: a developer's own token would make the developer's reply read as our
  follow-up.
- **One App, a token per scope.** Each process mints installation tokens for `board` (issues), `assets`
  (contents) and `mr` (pull requests), in memory only. That keeps GitLab's Reporter/Developer split: the
  credential every session uses cannot open a pull request. Merging stays human through a default-branch
  ruleset that does not list the App as a bypass actor.
- **Attachments go to an orphan `board-assets` branch** through the Contents API, embedded by blob URL with
  `?raw=true`, because GitHub has no upload API for issue or pull request comments.
- **Links are `Relates-to: #n` lines in the issue body.** GitHub has no symmetric "relates to"; its
  dependencies are directional, and sub-issues are the umbrella shape the kit says must not hold.
- **GitHub issues are never confidential.** They have no such flag; vulnerability reports go to GitHub's
  private vulnerability reporting, off the board. GitLab keeps its fail-closed filter. *Amended
  2026-10-12:* an issue labelled `confidential` is treated as confidential by the tooling, so that a board
  moved from GitLab keeps those items' titles out of listings, release notes and the session-start report.
  The label hides nothing on GitHub itself; new vulnerability reports still go to private reporting.
- Out of scope: GitHub Actions CI, GitHub Enterprise Server beyond the `GITHUB_API_URL` override, and moving
  an existing GitLab board to GitHub.

## Consequences
A GitHub project sets up an App once (`docs/agents/issue-tracker.md`), and its private key is the real
secret: it can mint any permission the App holds. A new board command is written once, against the adapter
interface, and each adapter gains a method only when the providers differ. The selftest drives both
adapters through a fake fetch, so neither path needs credentials to stay covered. Live behaviour on GitHub
is checked by the smoke checklist, not by the selftest.

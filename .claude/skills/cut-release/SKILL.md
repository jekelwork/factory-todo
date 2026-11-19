---
name: cut-release
description: Cut a release with pnpm items release — dry run, apply, write the notes and the what's-new slides, have a person merge with a merge commit, finalize. Use when the user asks to cut, prepare, tag, publish or finalize a release, to write release notes, or to bring the default branch back into a version line branch afterwards. Works on GitLab and GitHub alike.
---

# Cutting a release

**This skill is the same in every Factory Kit repository.** It carries the order of work and the traps.
`docs/agents/releasing.md` is the reference for what each command does and what the notes contain, and
`scripts/board/release.mjs`'s header explains each rule the commands enforce. Read the reference before
the first release in a session.

A release is the head of a version line branch, or an earlier commit on it, taken whole to the default
branch. The line branch is `release-X.Y.x`, and the release, its tag, its label and its milestone are all
`release-X.Y.Z`. `pnpm items releases` names the current line. Never hard-code the name in an instruction
file.

## Order of work

Each step waits for the one before it. Stop and report at any refusal: the refusals are the point.

1. **Pull the line branch and run `pnpm check` on it** (AGENTS.md, ground rule 2).
2. **Dry run** and read all of it:
   `pnpm items release prepare release-X.Y.Z --from=release-X.Y.x --notes`.
   It refuses while any delivered item is still open. Read the lists of items that were mentioned but not
   included, and items that were not delivered in this range. Add an item that was in fact delivered with
   `--include=<iid,…>`. Show the user the survey before applying.
3. **Apply**, from a clean working tree, with the same command plus `--apply`. It cuts `release/X.Y.Z`,
   bumps the version, writes the two drafts, pushes (the pre-push hook runs `pnpm check`), opens the merge
   request, and only then relabels the items.
4. **Write the notes** on `release/X.Y.Z`: replace every `FILL IN` in `docs/releases/X.Y.Z.md` and
   `docs/releases/X.Y.Z.whats-new.md` (the patterns of the files `prepare` writes). Mark administrators-only
   slides and lines in the what's-new file `<!-- admin -->`, spelt exactly: the slides leave them out, and a
   misspelt marker is refused. Check each configuration
   key against the environment's actual configuration, not from memory. Render the slides with
   `pnpm items release deck release-X.Y.Z` and look at them. Run `pnpm run ci`, and link the run if it went
   remote.
5. **A person merges**, with a merge commit, never squashed or rebased. You don't merge it.
6. **Finalize**: `pnpm items release finalize release-X.Y.Z`, plus any flag the project's release hooks
   take (its `docs/agents/project.md` says which). Every step it takes is skipped once done, so after a
   failure, fix the cause and run it again. Where the project sets `requireWhatsNew`, a release with no
   what's-new file is refused; pass `--no-whats-new` only when the user has said the release has nothing to
   show.
7. **Merge back.** `finalize` opens the merge request from the default branch into the line branch. A
   person merges that one too, with a merge commit.

## Traps

- **`finalize` closes the milestone even while items in it are still open.** It closes the items it
  delivered, then closes `release-X.Y.Z`'s milestone without checking for others carrying that label.
  Before finalizing, run `pnpm items list` and move any open item labelled for this release to the next
  release's label.
- **A failed push during `--apply` leaves the job half done.** The merge request is opened and the items
  relabelled only after a push succeeds. A failed push keeps the local branch and its commit. Fix the
  cause, push `release/X.Y.Z` yourself,
  then open the merge request (`pnpm items mr`) and relabel the delivered items to `release-X.Y.Z` by hand.
- **Don't edit or stash a tracked file to get a clean tree.** `--apply` refuses uncommitted changes to
  tracked files, while untracked files don't block it. If a local file has to stay hidden, list it in
  `.git/info/exclude`, which is never committed, rather than changing `.gitignore` for the release.
  Stashing `.gitignore` is how a release picks up files nobody meant to commit.
- **A branch named `release-X.Y.Z` collides with its own tag.** Line branches end in `.x`.
- **A `beforeFinalize` refusal means nothing happened.** Nothing is tagged, published or closed; fix what it
  names (often a credential in the board's file) and rerun `finalize`.
- **A failed `afterFinalize` hook means the release is done.** `finalize` says so and exits 1. The tag, the
  release, the items, the milestone and the merge back are all in place; fix the hook's cause and rerun
  `finalize`, which skips everything done and calls the hook again. Don't redo any step by hand.

## Keep the board current

`finalize` comments on and closes each delivered item. Afterwards, check that nothing labelled for this
release is still open, and that `pnpm items milestones` reports no milestone for a released version still
open.

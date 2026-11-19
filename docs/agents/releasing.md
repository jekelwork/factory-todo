# Cutting a release

The `cut-release` skill (`.claude/skills/cut-release/SKILL.md`) carries the order of work and the traps for an
agent. This document is the reference it points to.

A release is a tagged merge commit plus release notes written against the environment's real
configuration. The notes are the administrators' deploy checklist, so they are written from the code and
from the environment's actual configuration, never from memory.

The mechanics are two commands, `pnpm items release prepare` and `pnpm items release finalize`
(`scripts/board/release.mjs`, whose header explains each rule). They work on GitLab and GitHub alike. A
release is the head of the branch the work is built on (a version line branch, below), or an earlier commit
on it, taken whole to the default branch. Items it delivers get the new release's label; everything else
keeps the label it has.

## Steps

1. **Dry run.** `pnpm items release prepare release-X.Y.Z --from=release-X.Y.x --notes` (add `--at=<sha>`
   for an earlier point, and `--name="<Product> X.Y.Z"` for the title). It prints the items the commit
   delivers, and **refuses if any of them is still open**. It also prints what a person should look at:
   items only *mentioned* in a merge request (`--include=<iid,…>` if one was in fact delivered), closed
   items already labelled for this release that it did not find, merge requests and commits that name no
   item, the configuration keys and migrations since the default branch, and the draft notes. Nothing is
   written.
2. **Apply.** The same command with `--apply`, from a clean working tree. It cuts `release/X.Y.Z` at the
   commit, bumps every `package.json` that carries the project's version, writes the drafts
   `docs/releases/X.Y.Z.md` and `docs/releases/X.Y.Z.whats-new.md`, commits and pushes (the pre-push hook
   runs `pnpm check` on exactly that tree), opens the merge request to the default branch, and only then
   relabels the items. On GitLab it needs `GITLAB_MR_TOKEN`.
3. **Write the notes** on `release/X.Y.Z`: fill every `FILL IN` marker in both files (below). Look at the
   slides with `pnpm items release deck release-X.Y.Z`, which writes `whats-new-X.Y.Z.html` and nothing
   else. Run `pnpm run ci` there, and link the run if it went remote.
4. **A person merges** the merge request, **with a merge commit, never squashed or rebased**.
5. **Finalize.** `pnpm items release finalize release-X.Y.Z`. It tags the merge commit (annotated, pushed),
   publishes the notes file as the release, attaches the "what's new" slides to it as *What's new (slides)*
   and links them at the foot of the notes, comments on each item and closes it, closes the milestone, and
   opens the merge request from the default branch back into the source branch so the version bump and the
   notes reach it. It refuses while a `FILL IN` marker is left in either file, and every step is skipped
   when already done, so it can be run again after a failure. A release without a what's-new file gets no
   slides; where the project sets `requireWhatsNew`, `finalize` refuses it before tagging anything, unless
   `--no-whats-new` says that is the decision. A project's `beforeFinalize` hook (below) can refuse before
   the tag, and its `afterFinalize` hook runs last.
   - **GitLab**: the release carries the milestone, and is written with `GITLAB_MR_TOKEN` (Reporter cannot
     create one).
   - **GitHub**: a release cannot carry a milestone, so the notes link the milestone's page; the slides are
     a release asset. The App's `Contents` permission covers both.

## Branches

Where merging the default branch deploys, work does not land there. It lands on a **version line branch**,
`release-X.Y.x`, which feature branches start from and merge requests target (`pnpm items mr …
--target=release-X.Y.x`); each release is cut from it and taken whole to the default branch.

- **A line branch is named `release-X.Y.x`, never `release-X.Y.Z`.** A release's tag, label and milestone are
  all `release-X.Y.Z`; a branch with that name collides with its own tag, and every `git` command that takes
  the name has to be told which one is meant. Makers Market built 0.3.0 on a branch called `release-0.3.0` and
  retired it for that reason.
- **The release merge request is merged with a merge commit, never squashed.** A squash writes the whole
  branch onto the default branch as one new commit, so the next merge from the line branch conflicts with
  its own history, and every commit hash the docs cite stops existing on the default branch. `prepare`
  refuses on a project that cannot make a merge commit, and `finalize` warns when the commit it tags has
  one parent.
- `finalize` opens the merge request that brings the default branch back into the line branch. Merge it
  too, with a merge commit.

## Before merging, check

- [ ] The dry run's "mentioned, not included" and "not delivered in this range" lists were read, and
      anything delivered was added with `--include`.
- [ ] Any product copy that describes what the product carries still reads true.
- [ ] `pnpm run ci` is green on `release/X.Y.Z`.

## What the release notes contain

`prepare` writes what a script can know and marks the rest `FILL IN`:

- **Notices** *(a person writes them)*: anything an administrator must know before deploying, including
  anything that needs doing in the environment after deploy.
- **Deploying**: the configuration keys added, removed or changed since the default branch, and the new
  migrations, are generated. *A person* checks each key against the environment's actual configuration and
  marks it `[present]`, `[ADD]`, `[CHANGE]` or `[optional]`. Each configuration *file* among the watched
  paths is carried whole, folded, so an administrator copies a file instead of rebuilding one; these are
  committed files, so they hold placeholders only, and a real secret value never goes into the notes.
- **Delivered**: every included item, grouped by the kind of branch that delivered it (`feat/`, `fix/`,
  everything else), with its merge requests; a confidential item by number only. Merge requests and
  commits that name no item are listed under it. Titles are text from outside, so the draft escapes them:
  markdown punctuation is backslash-escaped (not `#` or `!`, so the tracker still links `#123` and `!45`),
  and `<` and `>` become `&lt;` and `&gt;`, which also makes a `<!--` in a title inert. A title is still not
  trusted to be good prose; rewrite the list into prose where it helps.

No item in a release is open, so there is no "open after deploy" list of items; environment steps belong
under Notices. Point out any environment security detail the notes reveal before publishing them.

**What the project configures**, in `package.json`, all optional:

```json
"factoryKit": {
  "release": {
    "configPaths": [".env.example", "deploy"],
    "migrations": "(^|/)(drizzle|migrations)/[^/]+\\.sql$",
    "requireWhatsNew": true,
    "hooks": "scripts/release-hooks.mjs"
  }
}
```

`configPaths` defaults to `.env.example`; `migrations` to a `.sql` file in a `migrations/` or `drizzle/`
directory. `requireWhatsNew` defaults to false. `hooks` defaults to none.

**Where each setting is read from.** `configPaths`, `migrations` and `requireWhatsNew` are read from
`package.json` at the release commit: the head `prepare` cuts from, and the merge commit `finalize` tags.
They describe that release, so a change to one goes through the release merge request a person reviews,
and a rerun of `finalize` from any checkout reads the same value. `hooks` is read from the checkout's own
`package.json`, because it names code the checkout runs, and a module is loaded from disk, not from a
commit. Only `prepare` and `finalize` read it; a checkout with no `package.json` has no hooks.

## Release hooks

What a release does that is one project's alone goes in a project-owned module that `hooks` names
(`docs/adr/0003-release-hooks-and-deck-markers.md`). It may export any of the following, each optionally
async, and nothing else, as named exports. An unknown export, a default export, a hook that is not a function, or a named module that is missing is
refused before anything is done, so a typo cannot switch a step off in silence. Without `hooks` the
release is exactly the kit's.

| Export | Called | Gets | Returns |
| --- | --- | --- | --- |
| `flags` | — | — | `['listing', …]`: extra `--listing=<value>` (or bare `--listing`) options for `prepare` and `finalize` |
| `notes(s, { showAt, flags })` | by `prepare`, dry run included, before anything is written | the survey `s` (`label`, `version`, `from`, `head`, `base`, `target`, `items`, `included`, `config`, `migrations`, …), `showAt(ref, file)` (a file's text at a commit, or null) and the flags' values | lines, put after *Notices* as one block; a `FILL IN` among them is enforced like any other |
| `checklist(s, { flags })` | by `prepare` | the survey and the flags | lines of plain text, each a box under *Before merging* in the release merge request, before the CI line |
| `beforeFinalize(c)` | by `finalize`, after the kit's own refusals (FILL IN, a misspelt marker, `requireWhatsNew`) and before the tag or any write | the same context as `afterFinalize`, except that `release` is null and `deck.url` is null, since neither exists yet | `{ ok: true }` to go on. Anything else, or a throw, refuses with its `message`: nothing is tagged, published or closed. The place for a check a later step needs, such as a credential |
| `afterFinalize(c)` | by `finalize`, after every other step | `label`, `version`, `sha` (the merge commit), `release` (`{ url }`), `deck` (`{ filename, html, url }`, or null with no what's-new file), `whatsNew` (the file's Markdown with administrators' content cut out by `withoutAdmin`, the form to publish, or null), `whatsNewRaw` (the file as committed, admin content and all, or null), `flags`, and `env(key)`, the board file's reader (`.env.gitlab` or `.env.github`) | `{ ok: true, message? }` to succeed. Anything else (`{ ok: false, message }`, nothing at all, any other shape), or a throw, is reported as a failure, naming a bad return: the release is done, `finalize` exits 1, and a rerun skips every done step and calls the hook again, so it must check what it already did |

A hook that throws in `prepare` stops the release before the branch is cut. `deck.html` and `whatsNew` are
the public forms, with administrators' content already left out; publish those, never `whatsNewRaw`. A file
whose admin content cannot be cut out cleanly is refused before the tag, when a `finalize` hook is set.
Credentials a hook needs live in the board's file, read through `env`, never in `.env`.

## What the "what's new" file contains

`docs/releases/X.Y.Z.whats-new.md` is for the people who use the product. It has features, additions and
fixes in plain words, and nothing about deployment, configuration, sign-in plumbing, tooling or
confidential work. `prepare` seeds it with each delivered item's title, leaves confidential items out, and
marks every line `FILL IN`. A person rewrites each line or deletes it, writes the cover's sentence, and
picks the highlights.

Its shape is the slides' shape. `#` is the cover's title, and the paragraphs under it are the cover's text.
Each `##` is one slide, and each `###` a column on that slide. Lists, paragraphs, bold, italics, code and
`https://` links are rendered (a plain `http:` link stays text); HTML comments are dropped, except three
markers, each a comment of its own:

- `<!-- admin -->` on a `##` line, or on a line of its own straight under it, makes the slide
  administrators-only; on a list item, that item. Administrators' content is left out of the slides
  attached to the release, which everybody who can open the release reads.
- `<!-- spotlight: name -->` on a `##` line, or on a line of its own in the slide, names the element the
  slide is about, comma-separated for several. The slides ignore it; it is for a product that shows this
  file in its own interface.
- `<!-- quiet -->` anywhere: such a product should not open this release by itself. The slides ignore it.

A comment that looks like a marker and is not one (`admin only`, `admins`, `spotlite: x`), or an admin
marker where it means nothing (on a paragraph or a `###`), is refused by `deck` and by `finalize`, before
the tag: a quietly dropped `admin` would publish administrators' text to everybody. The slides use
Knowit's colours and logo (`scripts/board/release-deck/`); a project shipping under another name replaces
both.

# Modernizing a legacy codebase

How a legacy system becomes a reviewed plan on the board: where the old code lives, which documents the
analysis produces, the review that gates it, and the seed file the board is filled from. The `modernize`
skill (`.claude/skills/modernize/SKILL.md`) carries the order of work; this file is what it refers to.
Reading the old code follows `docs/agents/surveying-a-codebase.md`, the same procedure `start-project`
uses. Where `start-project` already surveyed this code, extend its survey rather than repeat it: start from
its coverage table, and read what it left unread or what the analysis needs deeper than
`docs/agents/project.md` went.

The hazard is at the end, not the start. Seeding puts tens of items on a board people believe, and a
wrong one is undone only by closing it by hand. So nothing reaches the board until a person has approved
the analysis it comes from, and every item names the section it came from.

## 1. Where the legacy code lives

**Default: a subdirectory of the new repository**, `legacy/`, imported with its history
(`git subtree add --prefix=legacy <url> <branch>`) or as a plain copy when its history is not wanted.

| Placement | Gains | Costs |
|---|---|---|
| **Subdirectory** (default) | One clone, one `pnpm check`. Analysis documents and items cite the old code by path, and the docs guard checks those paths. One guard entry protects it. | The repository's history mixes the two systems; the old tree's size counts against every clone. |
| Separate read-only repository | Clean history on both sides. | Agents lose cross-reading: a citation is a URL nobody's tooling checks, and the survey runs in another checkout. |
| Git submodule | Pinned to a known commit. | Friction on every clone and branch switch, and the same broken citations unless it is checked out. |

**The legacy path is protected.** The skill adds it to `PROTECTED` in `.claude/hooks/guard.mjs`, marked
`// local:`, so an agent's edit there is refused with its own reason: old code changed while the new code
is built stops being the behaviour the analysis describes. When an item does need a change there (a
security fix in the running system), the developer lifts the rule for that change.

**The kit's linters leave it alone.** The old code keeps its own style and its own documents, and
`pnpm check` must pass without editing it. In the same commit as the guard entry, for a `legacy/` path:

- `biome.json`: add `"!legacy"` to `files.includes` (or the project's own linter's ignore, when it has one).
- `package.json`: set `factoryKit.protected` to `["legacy"]`. The docs guard then reads no Markdown under
  it, while a citation of a file there from the analysis still has to resolve.

## 2. The analysis documents

Under `docs/modernization/`, one file each. Every section that an item may come from carries a stable
anchor in its heading, `## Billing writes twice {#rk-2}`: a prefix per document and a number that is
never reused, so an item's trace survives a reworded heading.

| File | Prefix | What it holds |
|---|---|---|
| current-state.md | `cs` | What the system does, for whom; stack; size (files, lines per top-level package); test coverage, measured or marked unknown; known pain, each with where it shows. Ends with the survey's coverage table. |
| architecture.md | `ar` | The components, their data stores and the calls between them, as they are. |
| risks.md | `rk` | Irreversible failures (data that can be lost or corrupted, side effects that cannot be recalled), each with its file. These feed `docs/agents/project.md` §1. |
| an ADR in `docs/adr/` | — | The strategy: strangler, rewrite or lift-and-refactor, with the alternatives and why not. Lease the number first (`pnpm lease adr`), and write it on the template `docs/adr/0000-template.md`. |
| target.md | `tg` | The target architecture, and which of today's components each part replaces. |
| phasing.md | `ph` | The phases in order, each a release with its `release-X.Y.Z` name, what it delivers and what must be true before it starts. |

**Honesty rules**: the survey's (§2 of `docs/agents/surveying-a-codebase.md`: cited, *confirmed* or
*suspected*, unread areas listed as unread), with two additions. A claim about the old system cites
`path:line`, not only the path. Target and phasing are proposals and say so, each citing the
current-state or risk section it answers.

## 3. The review gate

**A merge request holding only the analysis**: the documents under `docs/modernization/` and the strategy
ADR, nothing else. No code, no guard change, no seed file. Reviewers see the whole text and its history,
and comment on lines.

**Approval of that merge request is the gate, and it accepts the ADR.** The agent writes the ADR with
`Status: accepted` and the merge request's date; an ADR on an unmerged branch has accepted nothing. A
strategy the reviewers reject is revised in the same merge request, not recorded and superseded. Nothing
is created on the board until it is merged.

## 4. The seed file

`docs/modernization/seed.md`, written after the gate, on its own branch. It is in the format of
`pnpm items create --batch` (#36): one entry per unit of work, each exactly a `pnpm items create` file
under a small header. Its description in `docs/agents/issue-tracker.md` is the authority on the format;
what follows adds the rules a modernization keeps.

```
Batch: modernize-billing

=== idempotent-charges
Labels: release-0.2.0

Make a repeated charge request a no-op
The legacy charge path writes a payment row per request (`legacy/src/billing/charge.js:88`)...

Source: docs/modernization/risks.md#rk-2

=== retire-nightly-cron
Labels: release-0.3.0
Needs: idempotent-charges

Retire the nightly reconciliation job
...

Source: docs/modernization/phasing.md#ph-3
```

- **`Batch:`** names the run. Batch create marks each item it opens with it, so a rerun skips what exists.
- **`=== <key>`** opens an entry; keys are lowercase letters, digits and hyphens, unique in the file.
- **`Labels:`** carries the phase as one `release-X.Y.Z` label (from phasing.md), so each item lands in
  its release's milestone. No `ai:` label: seeded items open as `new` and go through triage like any report.
- **`Needs: <key>`** orders creation and writes `Depends on #n` into the body. It is text, not a link, so
  a later phase does not hold an earlier one hostage.
- **`Relates: <key>`** makes a real link, which is a hold (`docs/agents/issue-tracker.md`, "Open a
  follow-up"). Use it only where two items are one change that must ship together.
- **Every entry ends with `Source: <file>#<anchor>`**, the section of the analysis it came from. The
  docs guard (`scripts/check-docs.mjs`, part of `pnpm check`) fails on an entry without one, on a file
  outside `docs/modernization/`, or on an anchor no heading carries. It finds the entries with
  `create --batch`'s own parser, so it also fails on anything the dry run would refuse.

## 5. Seeding

Once the seed file is committed and a person has seen the dry run:

```
pnpm items create --batch docs/modernization/seed.md          # dry run: order, titles, labels, links
pnpm items create --batch docs/modernization/seed.md --apply  # creates, after a person says go
```

The dry run is the default and reads the board; `--apply` writes. On a failure it stops and prints the
command that resumes it.

**Watch the first seeded run.** Seeded items are opened by the bot, and the state machine reads
authorship to tell a reporter's reply from our own comments (#39). Check with `pnpm items list` that the
new items read as `new` before triaging them.

# This project, for the agents

**This file belongs to the project, not to the kit.** The two board skills (`.claude/skills/`) are the
same in every repository that uses the Factory Kit. Everything they need to know about *this* codebase —
what can go irreversibly wrong, how a change is ordered, what conflicts by construction, how it is verified
— they read from here. Fill it in when the project starts, and keep it true: a skill following a stale
section here posts a confidently wrong plan under the project's name.

Each section says what it is for, then gives a worked example from Makers Market, the project the kit
was extracted from, fenced in HTML-comment example markers so the docs guard does not look for its files.
Replace the examples, markers and all. Leave a heading in place with "none yet" rather than deleting it,
so the skills can tell "nothing here" from "nobody looked".

## 1. The irreversible failures

The two or three outcomes that nobody can undo and nobody notices by looking. Triage escalates to the
stronger model whenever one is in reach, and a plan names them first under *Blast radius*.

**Losing stored todos.** An edit that overwrites or drops them (a PATCH that replaces a stored value, a
migration that has run) cannot be undone, and the SQLite file has no backup. The app has a single user and
holds nothing sensitive, so there is no disclosure failure.

## 2. Routes and models

How triage classifies an item and which model analyses it. The principle, for a route not in the table: a
route whose worst outcome is an edit somebody notices goes to **Sonnet**; a route whose worst outcome is a
confidently wrong answer that no reader can check goes to **Opus**. When unsure, Opus.

These five routes are generic and stay:

| Route | Model | What it means |
|---|---|---|
| `copy` | Sonnet | Wording, headings, labels, empty states. Propose the actual strings, not a description of them. |
| `ui` | Sonnet | A component, a layout, a design token, small-screen behaviour. |
| `api` | Sonnet | A route, a DTO, validation, an authorisation check. Opus if the response shape is public API. |
| `audit` | Sonnet | Enumerate something across the codebase and report the gaps as a table. |
| `capability` | Sonnet | Nothing is broken; something does not exist. The deliverable is a design. Opus if it changes a shared contract. |

Add the routes that carry this project's irreversible failures, each with the files that define it:

| Route | Model | What it means |
|---|---|---|
| `storage` | **Opus** | The SQLite schema and its migrations under `src/server/db/`. A migration that has run cannot be taken back. |

## 3. Read before concluding

Documents an analysis must read before it concludes on a given route, because they record traps that
produced bugs which passed their own tests.

`docs/DECISIONS.md` before `storage`.

## 4. Order of work

The order in which a change touches the codebase, so a plan's steps and an implementation's commits follow
it.

The shared contract first (`src/shared`: zod schemas and DTOs), then `src/server`, then `src/client`. A response type is never hand-written in the client.

## 5. Guards

Where the test that would have caught a defect goes, by kind, and the rules a test here must follow.

Server tests run against a real SQLite database, never a mocked one; unit tests sit beside the file. A count assertion states an **exact** number, never an upper bound.

## 6. What conflicts by construction

Files two branches cannot both change without one of them redoing its work. This sets how many branches
may be in flight at once.

Generated migrations (never two schema branches in flight), `pnpm-lock.yaml` (re-run the install, don't merge it) and `src/shared` (two branches changing one type break each other's typecheck without a textual conflict). Never two branches touching the schema or the same shared type.

## 7. Verification

The exact commands a change must pass, and where the visual evidence lands.

- **Always:** `pnpm check`.
- **Before a merge request:** `pnpm run ci`, in the developer's mode, with a remote run linked.
- **For anything visual:**

none yet: there is no end-to-end suite. Visual changes are checked by hand until one exists.

## 8. Deliberately not built

Specified work that is parked on purpose, so an analysis does not report it as a gap. Point at wherever the
project keeps that list.

`TASKS.md`, section "Specified, not built".

## 9. Branches

Where work branches from and where merge requests land, when that is not simply the default branch.

Work branches from `main` and merge requests land on `main`.

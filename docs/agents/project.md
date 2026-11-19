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

<!-- example -->
> *Makers Market example:* **silent data loss** (a PATCH that silently overwrites a stored value has happened here)
> and **showing a restricted listing to somebody who may not see it** (a visibility widening is invisible
> to the person it affects).
<!-- /example -->

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

<!-- example -->
> *Makers Market example:*
>
> | Route | Model | What it means |
> |---|---|---|
> | `schema` | **Opus** | `apps/api/src/db/schema.ts` and a Drizzle migration. A migration that has run cannot be taken back. |
> | `visibility` | **Opus** | Who can see what: `services/visibility.ts`, teams, Entra groups. A wrong answer discloses, silently. |
> | `artifacts` | **Opus** | Upload, allow-list, size cap, secret scan, blob store. "A secret shipped", "a file nobody can get back". |
> | `live` | Sonnet | The SSE live layer: presence, the ticker, counters. |
<!-- /example -->

## 3. Read before concluding

Documents an analysis must read before it concludes on a given route, because they record traps that
produced bugs which passed their own tests.

<!-- example -->
> *Makers Market example:* `docs/DECISIONS.md` before `schema`, `visibility` or `live` — it documents library traps
> in zod, Drizzle and PGlite, including a correlated subquery that silently returns zero.
<!-- /example -->

## 4. Order of work

The order in which a change touches the codebase, so a plan's steps and an implementation's commits follow
it.

<!-- example -->
> *Makers Market example:* the shared contract first (`packages/shared`: zod schemas and DTOs), then the API, then the
> UI. A response type is never hand-written in the web app.
<!-- /example -->

## 5. Guards

Where the test that would have caught a defect goes, by kind, and the rules a test here must follow.

<!-- example -->
> *Makers Market example:* API integration tests against in-memory PGlite (`apps/api/test/helpers.ts`), never a
> mocked database; unit tests beside the file; a new route goes into the e2e 390px list. A count assertion
> states an **exact** number, never an upper bound.
<!-- /example -->

## 6. What conflicts by construction

Files two branches cannot both change without one of them redoing its work. This sets how many branches
may be in flight at once.

<!-- example -->
> *Makers Market example:* generated Drizzle migrations (never two schema branches in flight), `pnpm-lock.yaml`
> (re-run the install, don't merge it), and `packages/shared` (two branches changing one type break each
> other's typecheck *without* a textual conflict). The working rule: at most two branches in flight, never
> two touching the schema, never two touching the same shared type.
<!-- /example -->

## 7. Verification

The exact commands a change must pass, and where the visual evidence lands.

- **Always:** `pnpm check`.
- **Before a merge request:** `pnpm run ci`, in the developer's mode, with a remote run linked.
- **For anything visual:** *(fill in: the e2e command, and the directory its screenshots are written to —
  the skills post that directory to the work item with `pnpm items screenshots`.)*

<!-- example -->
> *Makers Market example:* `pnpm test:e2e` with both dev servers up; screenshots in `apps/web/test-results/`, looked at
> before anything is declared done.
<!-- /example -->

## 8. Deliberately not built

Specified work that is parked on purpose, so an analysis does not report it as a gap. Point at wherever the
project keeps that list.

<!-- example -->
> *Makers Market example:* `TASKS.md`, section "Specified, not built".
<!-- /example -->

## 9. Branches

Where work branches from and where merge requests land, when that is not simply the default branch.

<!-- example -->
> *Makers Market example:* work is built on the version line branch `release-0.3.x` while `master` deploys to live;
> merge requests pass `--target=release-0.3.x`, and each release is cut from it with `pnpm items release`.
<!-- /example -->

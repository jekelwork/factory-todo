---
name: modernize
description: Take a legacy codebase to a reviewed modernization plan on the board — place and protect the old code, survey it, write the analysis documents and the strategy ADR, gate them behind an approved merge request, then write the seed file the board is filled from. Use when the user asks to modernize, migrate, rewrite or replace a legacy system, to analyse old code for a modernization, or to seed the board from such an analysis.
---

# Modernizing a legacy codebase

**This skill is the same in every Factory Kit repository.** It carries the order of work;
`docs/agents/modernizing.md` is its reference, cited below by section. Read it before phase 1.

The phases run in order, each ends at its "done when", and two of them **stop for a person**: phase 3
until the analysis merge request is approved and merged, phase 4 until the user has seen the dry run and
said go.

## Phases

0. **Before you start.** The kit is in the repository, and `start-project` has filled in AGENTS.md and
   `docs/agents/project.md`. On an existing codebase that skill already surveyed the code: start from what
   it wrote rather than reading the same files again. Done when `node scripts/setup/project.mjs --list`
   prints nothing, or the user has said to go ahead without it.
1. **Place the old code, and protect it.** Recommend the default from the reference's §1 (a `legacy/`
   subdirectory) and let the user choose. Add its path to `PROTECTED` in `.claude/hooks/guard.mjs` with
   `Edit`, marked `// local:`, and run `node .claude/hooks/guard.mjs --selftest`. After that the guard
   refuses your own edits there: that is the rule working. Exclude the path from the kit's linters as the
   reference's §1 gives it (`biome.json` and `factoryKit.protected`), never by editing the old code. Done
   when an `Edit` to a file under the path is refused, `pnpm check` passes, and this is committed on its own
   branch (`chore: protect the legacy code`).
2. **Survey, then write the analysis.** Read the old code as the reference's opening says, extending
   `start-project`'s survey where there is one. Write the documents of its §2 under `docs/modernization/`,
   with the anchors and honesty rules given there, and the strategy ADR (lease the number first,
   `pnpm lease adr`). The strategy is the agent's recommendation with its alternatives; who decides it is
   the next phase. Done when every document is written and `pnpm check` passes.
3. **Open the analysis merge request**, on a branch of its own, holding the analysis documents and the ADR
   and nothing else (`docs: modernization analysis`). Its description lists the open questions: every
   *suspected* claim that changes the strategy, and every area not read. **Stop.** Done when a person has
   approved it and it is merged; a requested change is made in the same merge request.
4. **Write the seed file**, on a new branch from the merged analysis: `docs/modernization/seed.md` in the
   reference's §4 format and rules, one entry per unit of work. Run `pnpm check` and commit it. Then run
   the dry run from §5 and show the user all of it. **Stop.** Done when the user says go.
5. **Seed**, as §5 says, including its check of the first seeded run. Report the numbers created, by
   phase. Done when every entry has an item and the board shows them in their milestones.

The seeded items go to `triage-work-items` like any report. Their plans cite the analysis section they came
from, and the analysis is not rewritten to fit a plan: a plan that finds the analysis wrong says so, and
the correction goes through a merge request of its own.

## What this skill will not do

- Edit the legacy code, or lift its guard entry, unasked.
- Write a seed file, or create an item, before the analysis merge request is approved and merged.
- Rewrite the analysis to fit a plan written after it.

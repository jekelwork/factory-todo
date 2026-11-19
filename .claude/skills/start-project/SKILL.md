---
name: start-project
description: Fill in the parts of a Factory Kit repository that describe the project rather than the kit (AGENTS.md title, rules and layout, docs/agents/project.md, SECURITY.md scope, the guard lists, ADR 0001's date, the check script). On a fresh repository it interviews the tech lead; where code already exists it reads the code first, writes cited proposals into the files for the lead to correct, and asks only what the code cannot tell. Use when the setup guide's "Your project" step hands over, or when the user asks to start, set up or describe their project in the kit.
---

# Starting a project from the kit

The board skills read AGENTS.md and `docs/agents/project.md` as true. While those files still carry the
kit's placeholders and the Makers Market examples, triage escalates the wrong routes and plans cite files
that do not exist, under the project's name. This skill replaces them with the project's own answers, which
only the tech lead can confirm. The setup guide's step 6 ticks green when
`node scripts/setup/project.mjs --list` prints nothing and `pnpm check` passes; that is this skill's finish
line too.

**Budget: about 15 minutes of the tech lead's time.** The whole setup has to fit in an hour. Ask one topic
at a time, propose an answer they can accept or correct rather than an open question, and use the
multiple-choice picker (AskUserQuestion) wherever the answer is a choice. On a codebase that already
exists, the proposals come from reading it (step 2), so the lead corrects rather than dictates.

## Steps

1. **See what is left.** Run `node scripts/setup/project.mjs --list`. Each line is `<file>: <part>`. Done
   when you have the list; an empty list means only step 6 remains.
2. **Is there code already?** Count it as `docs/agents/surveying-a-codebase.md` §1 says. At its threshold,
   tell the tech lead "this looks like an existing codebase; I will read it first and propose the answers"
   and go ahead unless they decline. Below it, or when they decline, skip to step 4. Done when you know
   which.
3. **Survey, then write proposals into the files** (existing code only). Read the code by
   `docs/agents/surveying-a-codebase.md`, its rules included. Then write what it found straight into the
   files with `Edit`, each proposed entry tagged with a `<!-- proposed -->` comment at its start (in
   `.claude/hooks/guard.mjs`, inside the `// local:` line comment), for the lead to review with `git diff`.
   Where each finding goes:
   - AGENTS.md: the **layout** block, the stack in the one-sentence description, and **candidate ground
     rules** for rule 10, their reasons left as questions;
   - `docs/agents/project.md`: **irreversible failures** (§1) with the route that carries each (§2),
     **order of work** (§4), **guards** (§5), what **conflicts by construction** (§6), **verification** (§7);
   - **generated paths** for `GENERATED` in `.claude/hooks/guard.mjs`, each with its command.

   **Not `package.json`'s `check` script.** JSON has no comment to carry the tag, and a tag inside the
   string would break the command, so a `check` written here would turn step 6 green without review. Draft
   it from the commands CI runs and keep the draft for topic 1; it is written in step 5, once the lead has
   answered. What the survey could not cite is not proposed: it becomes a question in step 4. Done when
   every proposal is in its file, tagged and cited, and `package.json` is unchanged.
4. **Interview, one topic per question**, in this order (later answers build on earlier ones). Where step 3
   wrote a proposal, the question is "is this right?", pointing at it; otherwise it is the open question.
   1. **Stack** and its lint, typecheck and test commands, with step 3's draft of `check` shown in full
      where there is one. The answer becomes `check` in `package.json`; keep
      the kit's own parts (`node .claude/hooks/guard.mjs --selftest`, `node scripts/setup/selftest.mjs`)
      in it, because they guard the tooling every session relies on.
   2. **The two or three irreversible failures**: outcomes nobody can undo and nobody notices by looking.
      They go to `docs/agents/project.md` §1, and each usually earns an Opus route in §2. Here and in
      topics 3, 5 and 6, what the survey's §5 lists is asked whatever the code showed.
   3. **Routes**, order of work, guards, what conflicts by construction, verification (the e2e command and
      its screenshot directory), deliberately-not-built, branches: `project.md` §2–§9. A section with no
      answer yet keeps its heading with "none yet", so the skills can tell "nothing here" from "nobody
      looked".
   4. **Generated paths and refused commands** for the two lists in `.claude/hooks/guard.mjs`, each
      addition marked `// local:` as the file explains. The scan cannot tell an empty list from a forgotten
      one, so always ask, proposals or not; "none" is a valid answer.
   5. **Security scope** of the application, for SECURITY.md's "Scope: the application": the areas where a
      mistake is invisible to the person it affects, each with its file, and what is out of scope and why.
   6. **The project's own ground rules**, each with the incident or reason behind it, for AGENTS.md
      rule 10. Then the title line, the one-sentence description and the layout block.

   Done when every line from step 1, every proposal from step 3 and the guard lists have an answer from the
   tech lead.
5. **Write each file with `Edit`.** Replace every `<!-- example -->` block, markers and all, and the
   Makers Market example quote under AGENTS.md rule 10. Remove each `<!-- proposed -->` tag the lead
   accepted, rewrite the entries they corrected, and delete the ones they rejected; `--list` reports any tag
   left behind. Set `Date:` in `docs/adr/0001-*`
   to today. Cite only paths that exist: `pnpm lint` runs the docs guard over them. Done when
   `node scripts/setup/project.mjs --list` prints nothing.
6. **Run `pnpm check`** (`mise exec -- pnpm run check`). Fix what it reports in what you wrote; if the
   project's own commands fail on its own code, show the tech lead and let them decide. Done when it is
   green.
7. **Commit** `chore: fill in the project parts`, after showing the tech lead the diff. Tell them to press
   "Check again" in the setup guide.

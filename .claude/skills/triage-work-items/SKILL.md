---
name: triage-work-items
description: Take open work items (GitLab work items or GitHub issues) through analysis and post a remediation plan as a comment on each. Use when the session-start board report names items needing attention, when the user asks to work the feedback board, or when they name specific work items to analyse. Also covers items where the reporter has replied to a posted plan.
---

# Working the work-item board

A report about the product arrives as a work item: a GitLab work item, or a GitHub issue. This skill takes an item from "somebody reported
something" to "a remediation plan the reporter can argue with", posted as a comment on the item so the
conversation happens where the report was made rather than in a session transcript nobody else can read.

The tool is `scripts/work-items.mjs` (`pnpm items …`, or `node scripts/work-items.mjs …` on a clone that
has not run `mise install` yet). Read subcommands are pre-approved; `comment` and `label` prompt, because
they write to a board other people read.

**This skill is the same in every Factory Kit repository.** What it needs to know about this codebase —
its irreversible failures, its routes, its order of work, its guards, its verification — is in
`docs/agents/project.md`, cited below by section. Read that file before the first item of a session.

## The loop

```
pnpm items list                    # the whole board with computed state
pnpm items list --new              # items with no plan and no ai: label
pnpm items list --answered         # the reporter replied to a plan — a human decision is due
pnpm items list --stale            # ai:analysing left behind by a crashed run
pnpm items list --parked           # placeholders, deliberately not queued — leave them alone
pnpm items show <iid>              # the item as JSON: description, analysis, every comment
```

1. **Decide the batch with the user.** Never start analysing on a session-start report alone — the
   report exists to inform, not to authorise. Confirm which items, then proceed. **Never analyse an item
   labelled `ai:parked`** unless the user names it explicitly: that label is somebody's decision that the
   item is filed but not to be worked on, and removing it is their call, not yours.
2. **Stamp `ai:analysing`** on each item you are about to dispatch (`pnpm items label <iid> analysing`).
   This is what stops two people, or two sessions, analysing the same item twice.
3. **Triage each item** — stage one, below.
4. **Dispatch the analysis** at the model the triage implies — stage two, below.
5. **Each agent writes its plan to a file, then posts it, then labels the item `plan-posted`.** In that
   order. See the rule below; it was learned the hard way.
6. **Report back to the user**: verdict per item, whether anything user-visible changes, and the note ids.

## Stage one — triage, on Sonnet

One agent per item. It reads `show <iid>`, `docs/agents/project.md` and whatever files the item names, and
returns strict JSON:

```json
{
  "route": "one of the routes in docs/agents/project.md §2",
  "touchesIrreversible": false,
  "irreversibleWhich": "",
  "likelyFiles": ["src/services/example.ts"],
  "recommendedModel": "sonnet | opus",
  "why": "one sentence"
}
```

**The rubric escalates when unsure.** A misclassification that sends a copy item to Opus costs money; one
that sends an item near one of the project's **irreversible failures** (`project.md` §1) to a model that
will not do the work costs a wrong plan posted under our name — and those failures are, by definition, the
ones the reporter cannot check by looking. Those are not comparable, so when the route is genuinely
ambiguous, say `opus`.

Do not route from the item's own category if it has one. It does not predict difficulty.

## Stage two — analysis, at the routed model

The route table is `project.md` §2. Its principle, if a route appears that is not in the table: a route
whose worst outcome is an edit somebody notices goes to **Sonnet**; a route whose worst outcome is a
confidently wrong answer that no reader can check goes to **Opus**.

Before concluding on a route that `project.md` §3 names, read the documents it lists there. They record
traps that each produced a bug which **passed its own tests**. A plan that proposes a count assertion with
an upper bound rather than an exact number is reproducing the commonest of them.

### The concurrency ceiling — the most important line in this file

**Four to six agents in flight, refilled as each completes. Opus items last, and at most two at a time.**

A sixteen-way parallel Opus dispatch exhausted the account session limit in about five minutes. All
sixteen agents died mid-analysis and every one of them lost its work. It then happened a second time. The
same sixteen items completed without trouble in waves of four to six.

### Write the file before posting

Each agent writes its plan to a file first, and only then posts it. A subagent's findings exist **only in
its own context** until they reach disk — that is why the first dispatch lost everything rather than
losing only the posting step. If the network is down (an internal GitLab behind a VPN is out of reach more
often than you expect, and GitHub rate-limits), the plan survives and the orchestrator posts it later.

## The plan itself

Eight sections, in this order. A reviewer should be able to read it in five minutes and act on it: aim
for 700–1400 words, longer only when the item genuinely carries several independent defects.

1. **What was reported** — one paragraph, including the reporter's own words where they are the clearest
   statement of the problem. Quote other languages verbatim; write your own prose in the project's
   language.
2. **What the code actually does** — the diagnosis, with `file:line` citations, separating **confirmed**
   from **suspected**. If a count, a permission or a stored value is in question, show it and the input
   that produced it.
3. **Verdict** — one of:
   - **defect** — the code is wrong;
   - **working as designed but misleading** — the behaviour is right and the presentation is not;
   - **missing capability** — nothing is broken, something does not exist yet. Check `project.md` §8
     first: work that is specified and deliberately not built is not a gap, and reporting it as one wastes
     everybody's time;
   - **premise to check with the reporter** — the expectation in the report may itself be the thing to
     question. This is not a cop-out; saying so plainly, with evidence, is sometimes the correct answer,
     and looking for *why* they expected it has found a real defect next door.
4. **Options** — two or three genuinely different ones, each with what changes, the size (S/M/L and the
   files), what it costs us and what it risks. Recommend one. Do not pad with an option you would not
   defend. Prefer deleting code to adding it, and prefer the platform to a new dependency.
5. **Recommended plan** — ordered, dispatchable steps naming files, in the project's order of work
   (`project.md` §4). Plus:
   - the **guard** that would have caught this and where it goes (`project.md` §5). A count assertion
     states an **exact expected number**. If no new guard is warranted, one sentence saying why.
   - the **documentation** the change owes: the outstanding-work list (what moved, and what is still open),
     a decisions-log entry for a call the next agent would otherwise re-derive, a new `docs/adr/` record for
     an architectural decision, and `AGENTS.md` if a ground rule, a command or the layout changes. A change
     whose reasoning exists only in a diff is a change nobody can defend later.
   - whether a **migration** or any other generated, irreversible artefact is involved, and how the
     project produces it.
6. **Blast radius.** If the change comes within reach of one of the **irreversible failures** in
   `project.md` §1, that is the **first sentence**, with direction and magnitude. Then: does a shared
   contract move, and therefore every consumer? Does stored or derived data need backfilling? And which
   other open items does this collide with (`pnpm items collisions`)?
7. **Decision points** — two to five questions, each a real fork where the answer changes the
   implementation. No rhetorical questions, no "shall I proceed?". **Number them explicitly as
   `**[REVIEW 1]**`, `**[REVIEW 2]**` …** — `advance-work-items` maps the reporter's reply onto these
   ids one by one and will not implement while any is uncovered, so an unnumbered point is a point that
   cannot be closed. One question per id: a point asking two things at once gets a reply that answers
   one of them and reads as `unclear` forever.
8. **Verification** — the exact commands the implementation must pass (`project.md` §7). Name the
   *specific* tests this change can break, not the whole suite — and for a visual change say which
   screenshot is the evidence. Those screenshots are attached to this item once the change is built
   (`pnpm items screenshots <iid> <dir>`), so name them by the file the reporter will see.

## Rules a plan must not break

- **Every behavioural claim is evidenced from the code**, cited `path/file.ts:123`. If you could not
  confirm something, say so and say what would confirm it. A plan that misdiagnoses is worse than one
  that says "unconfirmed, here is how to confirm it in ten minutes".
- **Read-only on the repository.** Analysis changes nothing. Reading the code and running a targeted unit
  test is encouraged. Do not run the end-to-end suite — it drives real servers and takes minutes — and do
  not start or stop dev servers somebody else may be using.
- **The ground rules in `AGENTS.md` hold**, and several of them are the whole point of a report. A
  reporter will sometimes ask for something a rule forbids — say so plainly and **propose the nearest thing
  that does not**. Do not quietly propose breaking it, and do not refuse without an alternative.
- **Do not pin a number that is allocated centrally** — the next `docs/adr/` number especially. Plans
  written in parallel collide. Say "next free number": the implementation leases it (`pnpm lease adr`).
- **Confidential material stays out of the comment.** Restricted content, a team's membership, and
  anything out of `.env` are not board material; the board is read by people who may not be in the
  audience for the thing being discussed.
- **Read the other open items before concluding**, and name overlaps under blast radius. That is what
  lets two tickets be identified as one architectural gap rather than two.
- **Never implement.** The output is a plan a human reviews, edits and later dispatches.

## After the plan is posted

The item sits at `ai:plan-posted` until the reporter answers its `[REVIEW]` points. When they do,
`list --answered` surfaces it — that is the whole reason the plan goes on the ticket instead of into a
document.

Everything from there is **`advance-work-items`**: it maps the reply onto the numbered points, revises
the plan when the answers move it, asks again for whatever is still open (two rounds, then it escalates
rather than nagging), and implements only once coverage is complete and the user has given the go. This
skill's job ends at the posted plan.

One thing that skill needs from this one: **numbered `[REVIEW n]` ids, one question each.** Everything
downstream keys on them.

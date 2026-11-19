---
name: advance-work-items
description: Advance a work item (GitLab or GitHub) that already carries a remediation plan — assess whether the reporter's reply covers every [REVIEW] point, revise the plan when their answers change it, ask again for what is still open, and implement once coverage is complete and the user gives the go. Use when the board reports an item as answered, ready or blocked, or when the user asks to take an item forward, close out review questions, or implement an agreed plan. Also covers a batch run: several items built one after another on one branch and merged as one merge request, with /simplify after each, /security-review on the combined diff, and a release-notes PDF attached to the MR.
---

# Advancing an item past its plan

`triage-work-items` gets an item to a posted plan carrying numbered `[REVIEW]` points. This skill takes it
from there: read the reply, work out what it actually settled, and either go another round or implement.

**This skill is the same in every Factory Kit repository.** What it needs to know about this codebase is in
`docs/agents/project.md`, cited below by section.

Two phases. **Phase 1 runs on your judgement; phase 2 needs the user's explicit go.**

## Phase 1 — coverage

```
pnpm items list --answered      # a reply arrived; coverage not assessed
pnpm items list --ready         # every point covered; awaiting a go
pnpm items list --blocked       # survived two rounds; needs a conversation
pnpm items list --parked        # filed as a placeholder; not queued, and sticky
pnpm items show <iid>           # the plan, the rounds already asked, and the reporter's own words
```

`show` labels every comment with a `kind`: `plan` (the plan in force — the **last** one, if it was
revised), `coverage` (a round already asked), `reply` (the reporter's words), `ours` (anything else we
posted). `rounds` counts the coverage rounds so far.

### 1. Map the reply onto the points

For **every** `[REVIEW]` point in the plan in force, decide one of four, and **quote the sentence you are
relying on**:

| Status | Meaning |
|---|---|
| `answered` | the reply settles this point unambiguously. Quote it. |
| `unclear` | the reply touches the point but does not settle it — two readings, a "maybe", an answer to a question next to this one. |
| `untouched` | the reply says nothing about it. |
| `refused` | the answer is clear but cannot be implemented as given. See below. |

Rules that keep this honest:

- **Coverage must be complete, not partial.** Every point gets a status. A plan is not ready while one
  point is `unclear`, `untouched` or `refused`, however small it looks.
- **Do not infer an answer from silence or from tone.** "Sounds good" against a plan with five points
  answers none of them. Neither does answering point 1 imply agreement with points 2–5.
- **Do not re-open a point an earlier round settled.** Statuses carry forward from the previous coverage
  comment on the ticket; only points that were open are reassessed. The reporter must never be asked the
  same question twice.
- **An answer may be numbered loosely or in prose, in Finnish or English.** Match on meaning, not on
  format — but if you cannot tell which point an answer belongs to, that is `unclear`, not a guess.

### 2. When an answer cannot be implemented as given — `refused`

Some answers collide with one of the ground rules in `AGENTS.md`, or with a trap recorded in the documents
`project.md` §3 names, or they are factually wrong about the code. Most ground rules exist because the
alternative already shipped a bug. Do not implement it, and do not quietly drop it either.

Say plainly in the round why it cannot be done as instructed, cite the rule or the `file:line` that
contradicts it, **propose the nearest thing that does achieve what they were after**, and leave the point
**open**. The reporter decides; being the messenger is the job. This is the one case where the reply is
clear and the point still is not closed.

The **ask-before** rule in `AGENTS.md` is a different kind of open: changing auth, deleting data, adding a
storage backend or changing the public API shape needs a human decision even when the reporter's answer is
perfectly clear.
Surface it to the user rather than treating the reply as authorisation.

### 3. Revise the plan when the answers moved it

An answer often changes the plan rather than merely approving it — a different option chosen, a
constraint the reporter did not know about, a scope they cut. When that happens, post a **revised plan**
alongside the round: same eight-section structure, opening `## Remediation plan (revised) —`, with a
short **What changed and why** block at the top naming the answers that moved it.

A revision may raise **new** `[REVIEW]` points. That is legitimate and does not count as failing to
close the old ones — but it does start those new points at round 1 of their own, and the round cap below
applies to the item as a whole. If a revision would raise more than two new points, the plan has changed
enough that it is a fresh planning round: say so, and hand it back to `triage-work-items`.

### 4. Post the round — always

One comment per round, opening `## Review coverage — round N`:

```
## Review coverage — round 1

*Assessed against the plan of 2026-09-08. Points marked OPEN below are what is still needed.*

| Point | Status | What I am relying on |
|---|---|---|
| [REVIEW 1] label on the restricted badge | answered | "call it Restricted, not Private" |
| [REVIEW 2] backfill the counter | unclear | "maybe later" — see below |
| [REVIEW 3] guard tolerance | untouched | — |

### Still open

- **[REVIEW 2]** — "maybe later" could mean backfill in this change or leave the counters as they are.
  Which?
- **[REVIEW 3]** — no answer yet: should the test assert the exact count, or a range?

### Answered, and now settled

- **[REVIEW 1]** — the badge reads "Restricted". Recorded; no need to revisit.
```

**Posting this round is mandatory, including the round that closes the loop.** It is not politeness — it
is what makes `ready` reachable. At the moment coverage completes, the reporter's answer is the newest
comment on the item, so without our closing round the item reads as an unassessed reply and `ready` is
invisible. `pnpm check:items` asserts both halves of that. The closing round says every point is covered,
restates the decisions, and names what will now be implemented.

### 5. Then label, and stop

| Outcome | Label | Next |
|---|---|---|
| every point `answered` | `pnpm items label <iid> ready` | Report to the user. **Stop.** |
| anything still open, round 1 or 2 | `pnpm items label <iid> plan-posted` | The ball is with the reporter. Stop. |
| still open after **round 2** | `pnpm items label <iid> blocked` | Report to the user. Stop. |

**The round cap is two.** One follow-up, one more attempt. A point still unclear after that is usually
unclear because the question was badly posed, and asking a third time on a ticket the reporter can read
is worse than saying so: name the point, say what the two readings are, and suggest the conversation.
Do not post a third round.

## Phase 2 — implementation, only on an explicit go

**`ready` is not permission.** The user gives the go, per item. Until then, report and stop.

**Before anything else, check what else touches this code:**

```
pnpm items collisions          # which code two OPEN items both cite, derived from the plans
```

**Refuse to start an item whose linked sibling is not also `ready`.** A link (GitLab's linked issues, or a
`Relates-to: #n` line in a GitHub issue's body) records a judgement — *these two are one defect, or share one hunk*. Implementing one half leaves the other
conflicting in the same function, and the person who picks it up then has to reconcile a merged fix
against a plan written before it. So: read the item's linked issues (`show <iid>` carries them via the
API, and they are on the ticket), and if a sibling is still `plan-posted`, `answered` or `blocked`, stop
and tell the user which sibling is holding it. They may override that — it is their call — but it must be
a decision, not an omission. A **parked** or **closed** sibling does not block: parked is somebody's
decision that the item is not to be worked on, and it must not hold its sibling hostage indefinitely.

`show <iid>` returns `siblings` (each with its own computed state) and `list` marks an actionable item
**HELD** when one of them is not ready, so the board says this before you start rather than the skill
refusing after you have branched.

`collisions` is the wider net and a weaker signal: it reports CITATION overlap, which is a proxy for edit
overlap. `SAME LINES` means do not branch both; `SAME AREA` means the same function, so sequence them;
same file with distant lines means parallel is fine but expect mechanical conflicts. A link beats it where
one exists, because a link is somebody's judgement and the report is arithmetic on line numbers.

Some files conflict *by construction* rather than by bad luck, and they cap how much parallelism is
affordable. `project.md` §6 lists them for this repository, with its working rule for how many branches may
be in flight. Follow it; where it is empty, the default is **at most two branches in flight**, and never two
that regenerate the same generated file (a migration journal, a lockfile).

When the user gives the go:

1. **Branch.** `git checkout -b fix/<short-name>` (or `feat/…`) off the branch `project.md` §9 names, or
   the default branch — never commit to it directly. `pnpm items label <iid> implementing`.
2. **Implement exactly the plan in force**, as amended by the answers, in the project's order of work
   (`project.md` §4). An answer that settled a point is a decision, not
   a suggestion. If implementation turns up something the plan did not anticipate and that changes what
   the reporter agreed to, **stop and go back to phase 1** with a revised plan — do not decide it
   yourself. Ask-before items (auth, deleting data, a storage backend, the public API shape) come back to
   the user even mid-implementation.
3. **The guard the plan promised goes in with the fix**, not after, where `project.md` §5 says it goes. A
   fix with no assertion is a fix that comes back — and Makers Market shipped two bugs past tests that asserted
   an upper bound instead of an exact count.
4. **Generated artefacts are generated, never hand-edited** — a migration, a lockfile, a client. Produce
   them the way the project does, once, and commit the output.
5. **Documentation is part of the change** — `TASKS.md` (what moved out of "next" or "open", carrying the
   work item's id and URL), `docs/DECISIONS.md` for a call the next agent would otherwise re-derive,
   a new `docs/adr/` record for an architectural decision, and `AGENTS.md` if a ground rule, a command or
   the layout changed. **Lease the record's number before writing the file** (`pnpm lease adr`, and the
   same for any other leased kind in `factoryKit.numbered`): the pre-push hook refuses an ADR whose number
   is not leased to the branch.
6. **Verify** with the commands in `project.md` §7 — `pnpm check` always. For anything visual, the
   end-to-end suite as well, and **look at the screenshots before declaring victory**: the screenshots are
   the review, and "the tests pass" is not the same claim. Start dev servers only if none is running, and
   stop only what you started.
7. **Put the screenshots on the item, for anything a user can see.** `pnpm items screenshots <iid>
   <screenshot dir>` uploads every PNG from the green e2e run and posts them in one comment, in a
   stable order, with an optional intro file as the first paragraph. Do this after step 6 and only after
   it passed: the images are evidence of the built UI, and posting them from a red or partial run tells
   the reviewer something that is not true. It is the whole point of the plan having lived on the ticket —
   the reporter described a look, and this is how they see the look they are getting without checking the
   branch out. A change with no visual surface skips this and says so in step 8.
8. **Report what actually changed.** If the plan said no stored data moves and nobody's visibility
   widens, prove it. If it said something changes, state what was actually observed and compare it with
   what the plan predicted — a fix that behaves differently from its own plan is a finding, not a detail.
9. **Commit in Conventional Commits** (`fix(api): …`), small and focused; the commit-msg hook enforces it
   and `lefthook` runs biome, the secret gate, `pnpm check` and `check:items` on the way past.
10. **Push the branch and open the MR** (`pnpm items mr`, a pull request on GitHub) against
   `.gitlab/merge_request_templates/Default.md` or `.github/pull_request_template.md` — what, why, how it
   was verified, screenshots for visual changes, and an honest note in the **AI assistance**
   section saying which parts were generated and what was reviewed by hand. On GitLab without
   `GITLAB_MR_TOKEN`, `mr` refuses, so hand the user the link the remote prints on push. They merge.
11. Leave the item at `implementing` until the MR is merged. Once it is: a comment naming the merge
   request, the commit and the merge commit, then `pnpm items close <iid>`, which closes the item and
   drops the `ai:` label in the same call. Before closing, make sure the item carries the `release-*`
   label of the release it shipped in; `close` moves it into the milestone of the same name. Anything deliberately cut becomes its own item first
   (`pnpm items create <file> <iid>`), so the close can name where the rest went.

## Batch runs: several items, one merge request

Sometimes the user wants a batch built without them at the keyboard. The rules above still hold item by
item; a batch only changes how the items are sequenced and verified. The first batch on Makers Market was eight items
in one merge request, and what it taught is written down here.

1. **Agree the batch first.** Triage every item that has no plan. Then bring every open `[REVIEW]` point
   back as **one** list, each point with its recommended answer, and get one go for the whole batch. Mark
   the answers that touch the ask-before rule, so a yes to them is a deliberate one. Post each item's coverage
   round and label it `ready` before any code is written.
2. **One branch** off the release branch, with the items built **one after another** in the agreed order.
   Each item gets its own commits, its own `implementing` comment and its own screenshots, as in phase 2.
   The batch is only one merge request, not one record.
3. **Migrations are generated in order and exactly once.** Put the schema items last, or at least one
   after another. A running dev server may apply a migration the moment it is written, so get the schema
   right first, generate once, and never regenerate it.
4. **When items run in parallel in the same working tree**, every agent stages its own files by explicit
   path, never with `git add -A`. A `pnpm check` that fails only in another agent's files is reported, not
   fixed.
5. **Run `/simplify` after each item**, on that item's commits alone, and apply its findings before the
   next item starts. Say in the commit message what was skipped and why.
6. **At the end:**
   - Run `/security-review` on the combined diff (`git diff <release branch>...HEAD`), and fix what it
     finds on the branch or raise an item for it.
   - Take the e2e verdict from `pnpm run ci` (local or remote, as the developer's `CI_MODE` picks) where it runs one against fresh data. A long-lived dev
     database drifts from the seed, and a failure there may be the data rather than the code.
   - Running one spec usually rewrites the screenshot directory. Point repeat runs at another directory with
     `--output=<dir>`, so the full run's screenshots survive.
7. **Screenshots and the PDF.** `pnpm items screenshots` uploads every PNG in the directory it is given,
   so copy each item's own screenshots into a directory of their own and post from there.
   - Build a PDF of the batch with one page per item: what changed, why, and its screenshots.
     `batch/release-notes-pdf.mjs` renders it from a small JSON file; its header documents the format and
     where it finds Playwright.
   - **A confidential item is `#N (confidential)` and nothing else** — in the PDF's JSON file (`{ "iid": N,
     "confidential": true }`), in the merge request's intro text and in the PDF's file name. No title, summary,
     points, migration or screenshots; its screenshots stay on the item and out of the PDF directory. A
     merge request is readable by more people than a confidential item is. Check the flag with
     `pnpm items show <iid>` before writing the file. `release-notes-pdf.mjs` looks every item up on the board
     itself, treats one it cannot read as confidential, and exits 1 when a confidential feature carries any
     of that.
   - Attach the PDF to the merge request as a note with `batch/mr-attach.mjs`.
8. **After the merge**, close every item as in phase 2 step 11, and update wherever the project keeps its
   build order. Then tell the other sessions working on the repository what moved: the next migration
   number and any shared type that changed, since those break a branch without a merge conflict. ADR
   numbers need no message: each one is leased (phase 2, step 5).

## What this skill will not do

- Start implementing because coverage reached 100%. That is the user's call.
- Start an item whose linked sibling is not also `ready`, without saying so and being told to proceed.
- Treat an acknowledgement as an answer.
- Implement an instruction that breaks a ground rule, even when the reporter repeats it. Refuse in the
  round, propose the alternative, and surface it to the user.
- Declare a visual change done on a green test run alone, without looking at the screenshot.
- Close out a visual change without putting the screenshots on the work item, where the reporter is.
- Post a third coverage round.
- Decide a `[REVIEW]` point on the reporter's behalf because the answer was nearly clear. Nearly clear is
  `unclear`.

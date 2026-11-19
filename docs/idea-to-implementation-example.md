# From idea to implementation with the Factory Kit

This is a hypothetical walkthrough for a new **Team Calendar** project. It shows who makes each decision, where the work is recorded, and how an idea becomes reviewed code. The Factory Kit supplies the workflow; the project supplies its application, tests, and product decisions.

## Set up the project once

Create a repository from the Factory Kit, install the toolchain with `mise install`, and run `pnpm install` to install dependencies and Git hooks. Fill in the project-owned parts of [AGENTS.md](../AGENTS.md) and [docs/agents/project.md](agents/project.md), including the code layout, risks, work order, and verification commands. Configure **one** work-item board, GitHub or GitLab, then verify that `pnpm items list` works. Make `pnpm check` run the new application's lint, typecheck, and tests. The [README](../README.md) has the full setup sequence.

## Who owns which decision?

| Decision or work | Owner | Record |
| --- | --- | --- |
| Identify a user problem, set its priority, and decide whether to pursue it | Product owner or another human | The product's planning process and a GitHub issue or GitLab work item |
| Describe the requested outcome | Reporter or product owner | Work-item description |
| Select an item for analysis | Person working with the coding agent | Session instruction; the agent then updates the work item |
| Investigate the code and propose options, implementation steps, risks, and tests | Coding agent | Plan posted as a work-item comment |
| Answer product questions in the plan | Reporter or product owner | Replies on the work item |
| Check that every answer is clear and revise the plan if needed | Coding agent | Review coverage and revised-plan comments on the work item |
| Authorize implementation | Person in the coding session | Explicit go-ahead after the item is ready |
| Implement and verify the agreed change | Coding agent | Branch, tests, commits, work-item updates, and pull or merge request |
| Review and merge | Human reviewer | Pull or merge request |

The reporter's answer does **not** by itself authorize changes to authentication, deletion of data, a new storage backend, or the public API shape. Those require a person in the coding session to approve them, as [AGENTS.md](../AGENTS.md) specifies.

## A concrete example: add a calendar week view

### 1. Record the request

A product owner opens issue **#12: Show events in a week view**. Its description might say:

> Team members can see their upcoming events across one week, move between weeks, and open an event from the calendar. The current application only shows an event list.

This is a desired outcome, not an implementation plan. The product owner decides its priority. An authorized agent can create a work item with `pnpm items create`, but the kit does not independently choose which ideas deserve tickets.

### 2. Select and analyze the item

A person asks the agent to analyze #12. Merely appearing in `pnpm items list` does not authorize work. The agent marks the item `ai:analysing`, inspects the relevant code and other open items, and posts a plan on #12 using the [`triage-work-items` procedure](../.claude/skills/triage-work-items/SKILL.md).

The plan states what the application currently does, whether the week view is a missing capability, the options and recommended approach, ordered code changes, risks, tests, and visual evidence. It also asks the decisions that change the implementation, for example:

- **[REVIEW 1]** Does the week start on Monday or Sunday?
- **[REVIEW 2]** Should all-day events appear in a separate row?
- **[REVIEW 3]** Which time zone determines the day shown for an event?

The agent writes the plan to a local draft before posting it, then posts it as a comment and labels #12 `ai:plan-posted`. The plan and discussion stay on the item so another person can inspect them without access to the agent's session.

### 3. Resolve the decisions

The reporter answers the `[REVIEW]` questions on #12. The agent assesses **each** answer, records what it relied on in a review-coverage comment, and revises the plan if an answer changes it. An ambiguous or unanswered point remains open. Once every point is settled, the agent labels the item `ai:ready` and stops. **Ready is not permission to implement.** The [`advance-work-items` procedure](../.claude/skills/advance-work-items/SKILL.md) defines this review loop.

### 4. Give the go-ahead and implement

A person in the coding session explicitly says to implement #12. The agent checks for overlapping work, creates a `feat/...` branch from the project's target branch, labels #12 `ai:implementing`, and comments with the branch and plan. It implements the agreed steps in the order defined by [docs/agents/project.md](agents/project.md), adding the tests promised in the plan. If implementation reveals a product decision that changes the agreed plan, it returns to review before proceeding.

The agent updates project documentation as needed. A reusable engineering decision goes in `docs/DECISIONS.md` or a new ADR; a change in known outstanding work is reflected in [TASKS.md](../TASKS.md).

### 5. Verify and request review

The agent runs `pnpm check` and, before opening the pull or merge request, `pnpm run ci` in the developer's configured mode. Because the week view is visual, it also runs the project's end-to-end suite, inspects its screenshots, and attaches the evidence to #12 and the review request. Git hooks check formatting, obvious secrets, commit messages, and the pre-push gates. The review request explains the change, verification, screenshots, and AI assistance. A human reviews and merges it.

### 6. Close the record and release

After the merge, the agent comments on #12 with the review request, commit, and merge commit, assigns the relevant `release-*` label, and runs `pnpm items close 12`. If only part of the request shipped, it records what shipped and creates a follow-up item for the rest before closing. Where the project uses version-line releases, the separate [release procedure](agents/releasing.md) prepares notes and a release request, waits for a human merge, then finalizes the tag, release, and milestone.

## Where are the tasks?

The **work-item board** holds the request, the agent's plan, the reporter's answers, the approval state, and the delivery record. The **ordered steps for #12** live in that item's plan comment. Factory Kit does not generate a separate task-list file for every feature or automatically split a broad idea into tickets.

The repository's [TASKS.md](../TASKS.md) has a different purpose: it lists work already known to the project, including work deliberately left unbuilt. For a large idea that needs a product specification or decomposition into several reviewable slices, the team does that planning before or alongside the board workflow, then opens an item for each agreed slice.

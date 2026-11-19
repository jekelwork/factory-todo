# Knowit Factory Kit

A way of building software with coding agents under human review, packaged as a template repository. Agents do the work. People make the calls.

## What it is

### The method, no product

- The instructions every agent reads, the gates on every commit and push, and a work-item board that agents triage and advance.
- Makers Market was built this way and went live in production after eleven days. The kit is that repository's way of working with Makers Market taken out.

### What you get

- `AGENTS.md`: one rule set for Claude Code, Codex, Cursor and Copilot.
- `pnpm items`: the board, on GitLab or GitHub.
- Git hooks, a guard for agents, and CI wherever each developer chooses.

## Every item runs one loop

### The agent

- Reads the report, analyses the code and posts a plan with numbered review points.
- Maps the answers onto the points, and asks again only for what is still open.
- Builds, verifies and opens the merge request.

### People

- The reporter answers the review points on the item.
- A developer in the session says go. Nothing is built before that.
- A reviewer merges. The lock on main does not let the bot do it.

## Every change passes the gates

### On the way

- At commit: Biome, a secret scan of the staged content, and Conventional Commits.
- At push: `pnpm check`, the board's state machine, the number leases and a secret scan of what is sent.
- Before a merge: `pnpm run ci`, locally, on GitHub runners, or split between them.

### Guard rails for agents

- A deny list and a guard refuse force pushes, killing by pattern, `npm install` and edits to generated files.
- Protected paths, such as a legacy system under study, refuse every edit.

## Three ways in

### Start a new project

- Clone the kit and run `pnpm kit:setup`. The guide checks each step itself.
- The `start-project` skill interviews the tech lead, and a first item goes through the whole loop.

### Bring it to existing work

- `pnpm kit:adopt` brings the kit into a live repository, on a branch, through a pull request.
- `start-project` reads the code first and proposes, and the backlog becomes the board.
- The `modernize` skill takes a legacy system to a reviewed analysis and a phased plan on the board.

## The board is the record

### State that cannot lie

- An item's state comes from its `ai:` label and who wrote the latest comment, computed every time.
- A decision taken in chat goes on the item, so the next person or agent finds it there.

### Releases

- Each release is a label, a milestone and a tag.
- The notes and the what's-new slides are written from the code and the environment's real configuration.

## Who decides what

### The agent

- Investigates, proposes options, and writes the plan and its tests.
- Implements and verifies the agreed change.

### People

- Decide what to pursue, answer the plan's questions, say go, and merge.
- Ask before: changing auth, deleting data, adding a storage backend, or changing the public API shape.

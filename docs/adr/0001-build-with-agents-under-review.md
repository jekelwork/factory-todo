# 0001. Build with coding agents, under human review, from the Factory Kit

Date: 2026-11-19 · Status: accepted

## Context
This repository was started from the Knowit Factory Kit. The kit carries a way of working rather than any
code: agents do most of the writing, and people decide what is built, review every plan before it is
implemented, and merge.

## Decision
- `AGENTS.md` is the canonical instruction set for every agent and every person; `CLAUDE.md` imports it.
- Reports and requests arrive as work items, on GitLab or GitHub (ADR 0002). `pnpm items` reads the board; the `triage-work-items`
  and `advance-work-items` skills drive it from report to posted plan to agreed implementation. Nothing is
  implemented without a person's explicit go.
- Every gate runs locally — git hooks and `pnpm ci:local` — so the method does not depend on a CI runner.
- Codebase-specific knowledge the skills need lives in `docs/agents/project.md`, owned by this project.

## Consequences
The board is the record of the work, so it must be kept current at every transition. A new kind of
irreversible failure in this codebase belongs in `docs/agents/project.md`, or triage will not escalate it.

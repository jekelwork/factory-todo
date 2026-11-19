# Domain docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

Layout: **single-context** by default — one `CONTEXT.md` at the repo root, one `docs/adr/`. A repository
holding several products with separate vocabularies would have one `CONTEXT.md` per context instead; say so
here if that is this one.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the glossary. It does not exist until a term actually needs
  resolving; `/domain-modeling` creates it then.
- **`docs/adr/`**: read the ADRs that touch the area you're about to work in. It is **append-only** — a
  superseded decision gets a new ADR saying so, it is not edited.
- **`docs/DECISIONS.md`**: the calls made while building, and the library traps that each produced a bug
  which passed its own tests.
- **`AGENTS.md`**: the ground rules. It outranks anything in this file.

If any of these don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them
upfront.

## Use the glossary's vocabulary

When your output names a domain concept (an issue title, a refactor proposal, a hypothesis, a test name),
use the term as the project uses it. Until `CONTEXT.md` exists, the names in the shared contracts (types,
schemas, DTOs) are the de facto glossary. Don't drift to synonyms.

If the concept you need isn't there yet, that's a signal: either you're inventing language the project
doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0001, but worth reopening because…_

Write a new ADR when the next agent would otherwise have to re-derive the decision. Lease its number
first, with `pnpm lease adr`; the pre-push hook refuses an ADR whose number is not leased to the branch.

# 0006. Adoption into an existing repository writes only on a branch, and only by adding

Date: 2026-11-10 · Status: accepted

## Context
The kit could start a project only from a clone of itself (README, "Start a project"). Most of Knowit's work
is on existing codebases, where the kit's files meet a `package.json`, hooks, a linter, a CI workflow and
instruction files that are already there. Work item #35 asked for an adoption path; its decisions were taken
there on 2026-11-10.

The worst case cannot be undone: a tool that overwrites or silently drops a project's own configuration
lands on that project's default branch, where nobody looks again.

## Decision
- **`pnpm kit:adopt <target>`, run from a kit clone** (`scripts/setup/adopt.mjs`). A dry run by default,
  printing three lists: copy, merge and conflict. `--apply` writes them on `chore/adopt-factory-kit-<version>`
  in one commit, `chore: adopt the Factory Kit <version>`, and never on the default branch or the remote. It
  refuses a dirty tree and an existing adoption branch. The commit skips the target's own hooks: they are
  not the kit's gates yet, and the pull request's CI runs them.
- **The kit-owned list is the README's.** Adoption reads "Kit-owned and project-owned", so a file added to
  that list is adopted without a change to the script. A kit-owned name that matches no file is an error.
- **Merges are additive only**: a free script name (a taken one goes in as `kit:<name>`; the project's
  `check`, `lint` and `prepare` are never changed), a devDependency, a `.claude/settings.json` hook or
  permission, a `.gitignore` line that hides nothing the project tracks, a `factoryKit` key. Everything else
  is a conflict with a proposed resolution, and a file the rules cannot merge gets the kit's version beside
  it as `<name>.proposed`.
- **The record is `factoryKit` in the root `package.json`**: `kit` (the version), `manifest` (a sha256 per
  kit-owned file adopted, for a future sync to tell an untouched file from an edited one), `lint: "kit"`
  when the project has its own linter or no JavaScript (Biome and check-docs then cover only the kit's
  files), and `package` for npm and yarn projects.
- **npm and yarn keep their manager.** Two lockfiles in one package root each rewrite `node_modules` in their
  own layout, so the kit's tooling goes in `tools/factory-kit/` with its own `package.json` and pnpm
  lockfile. The scripts that need nothing installed stay at the root. The guard refuses `npm install` only
  inside that package, and the CI setup action and `ci:local` install there.
- **The lockfile beside a new package is the kit's own.** That package's dependencies are exactly the kit's,
  so the kit's `pnpm-lock.yaml`, which pnpm generated, is the lockfile pnpm would generate for it. Generating
  one in the target instead needs the network. The selftest has pnpm confirm the fit offline
  (`--frozen-lockfile --lockfile-only --offline`). Where the kit joins a pnpm project's own `package.json`,
  `pnpm install --lockfile-only` produces the lockfile, and the report says when that did not happen.
- **A native build keeps its toolchain; `pnpm check` calls its gate.** Node and pnpm sit beside Maven,
  Gradle, .NET or Python, and the gate (`mvn -B verify` and the like) runs after the kit's. The CI step that
  installs the toolchain is a recipe in the report, not written into `ci.yml`, which is the project's.
- **Husky or pre-commit keeps the hooks, and hands over to lefthook.** Each of the manager's hooks runs
  `lefthook run <hook> --no-auto-install`, so `lefthook.yml` stays the one statement of the gates (globs,
  staged files, `stage_fixed`) and a gate added there later reaches the project with nothing else changed.

## Consequences
- A future `kit pull` starts from `factoryKit.kit` and the manifest, and inherits this boundary: it may add,
  and propose, but not overwrite.
- An adoption is reviewable as one diff. A wrong merge rule costs a pull request comment, not a project's
  configuration.
- The setup guide's "Your project" step now also requires the *(kit)* ground rules in `AGENTS.md`, since an
  adopted project keeps its own, and "Your first item" reads the remote's default branch and files the item
  as an edit to an existing `CODEOWNERS`.
- Step 2 ("Your repository") recognises an adopted repository by `factoryKit.kit` or the adoption commit,
  takes the kit's version from there, and is done once the adoption branch is merged into the default
  branch. It never asks for a push to the default branch.

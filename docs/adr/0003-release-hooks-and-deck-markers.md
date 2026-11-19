# 0003. Release hooks for what is a project's own, and the deck's audience markers in the kit

Date: 2026-10-12 · Status: accepted

## Context
The release tooling (`scripts/board/release.mjs`, `whats-new.mjs`) was ported from Makers Market without
the parts only Makers Market used. Makers Market now wants to cut its releases with the kit's tooling on
GitHub (its work item #257), and its own copy does more:

1. It publishes the slides to a listing in its own catalogue (`finalize --listing=<slug>`).
2. It writes a *Data warning* section into the notes, read from its source, and adds two lines to the
   release merge request's checklist.
3. It refuses to finalize a release with no what's-new file unless `--no-whats-new` is given, because its
   app shows that file to every user after a deploy.
4. Its deck parser reads three audience markers, `<!-- admin -->`, `<!-- spotlight: … -->` and
   `<!-- quiet -->`, leaves administrators' content out of the slides, and refuses a misspelt marker. The
   kit's parser dropped every comment and kept the line, so an admin-only line written for that app
   reached the slides attached to the release, which everybody can open.

Three ways were weighed: generalise each feature into kit settings (Makers Market's listings and source
files become settings no other project has); a plugin point for everything, the deck parser included (a
large surface, and every other kit project keeps a parser that shows admin text); or a hybrid.

## Decision
The hybrid.

- **Into the kit directly, because they are generic:** the three deck markers, with Makers Market's
  parser's output shape and refusals (`parseDeck(md, { admin })`, `withoutAdmin(md)`), and a
  `requireWhatsNew` setting with the `--no-whats-new` flag. `spotlight` and `quiet` change nothing in the
  slides; they are parsed so a project whose app reads the same file can hold its app's parser to the
  kit's with a test, as Makers Market does.
- **A release hook point for the rest.** `factoryKit.release.hooks` in `package.json` names a project-owned
  module. It may export `flags`, `notes`, `checklist`, `beforeFinalize` and `afterFinalize` as named
  exports, and nothing else; the contexts each receives are documented in `release.mjs`'s header and in
  `docs/agents/releasing.md`. The module is loaded from the checkout, an unknown or default export or a
  missing module is refused rather than ignored, and no setting means no change. A finalize hook succeeds
  only by returning `{ ok: true }`. `beforeFinalize` runs before the tag and can refuse the release while
  nothing has been written. `afterFinalize` runs after every other step, so its failure leaves the release
  done, says so and exits 1, and a rerun retries only what the hook finds undone. Both are handed the
  what's-new file with administrators' content cut out as `whatsNew`, and the committed file as
  `whatsNewRaw`.
- **Settings are read at the release commit, hooks from the checkout.** `requireWhatsNew` describes the
  release, like `configPaths`, so it is reviewed in the release merge request and a rerun reads the same
  value anywhere. The hooks module is code the checkout runs.
- **No hook for the configuration section.** Makers Market's merged ConfigMap was dropped instead
  (it no longer deploys to OpenShift); the kit's whole-file `configPaths` covers configuration.

## Consequences
- The five hook names and their contexts are a contract between the kit and every project that uses
  them. Adding a hook is a kit change with its own ADR; renaming or narrowing a context breaks projects
  without a merge conflict.
- `parseDeck`'s output now carries `quiet` and each slide's `spotlight`. Makers Market has a test that
  compares its app's parser with this one on every what's-new file it has, so a change to the parser's
  shape or refusals has to be made in both.
- A hook that publishes the what's-new Markdown somewhere uses `withoutAdmin`, so the admin rule lives in
  one place. A hook that publishes the rendered deck uses the `deck` it is handed, which has no admin
  content in it already.
- `beforeFinalize` keeps the up-front refusals Makers Market's own `--listing` made (no credentials, no
  what's-new file): it runs after the kit's own refusals and before the tag, so a project's check refuses
  while nothing is written yet. Added after review, at the user's request, on 2026-10-12.

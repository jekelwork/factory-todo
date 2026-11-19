# 0004. The GitLab-to-GitHub board migration is the kit's, configured from package.json

Date: 2026-10-13 · Status: accepted

## Context
Makers Market moved its board from GitLab to GitHub on 2026-10-12 with a script of its own, written beside
the kit's vendored adapters and offered to the kit once it had run for real. It had: 375 items kept their
numbers, and the run met several things the design had not foreseen (`docs/agents/migrating-a-board.md`,
"What the first real run taught"). The next project on the kit that moves its board should not rediscover
them. Makers Market's work item #394 asked for the move, and its decisions were taken there on 2026-10-13.

Three things made the script Makers Market's rather than the kit's. Its names were written into the code:
the protected target, the confidential policy and its label text, the GitLab URL the links pointed at, and
the link rewrite's file set. It had a GitHub client of its own, a copy of the adapter's token minting with
expiry, a 401 re-mint, a 5xx retry, pagination and a longer timeout added. And its lessons were in the code
without being named, so a reader could not tell which lines were there because something had gone wrong.

## Decision
- **One GitHub client.** `createInstallationClient` in `scripts/board/github.mjs` carries the token cache
  (renewed five minutes before expiry, minted again once after a 401), reads retried after a timeout or a 5xx
  when the caller asks (writes never), pagination and `retryAfterMs`. `createGithub` is built on it with no
  retries, so the adapter behaves as before; the migration asks for four retries and thirty seconds, and
  adds only its guard on writes.
- **The port is `scripts/board/migrate.mjs` and `scripts/board/links.mjs`**, with every flag the original
  had, and selftests of their own that `pnpm check:items` runs. Each lesson that can be tested offline has a
  case named `lesson:`; the rest are written down.
- **Project names are settings** in `package.json`, `factoryKit.migrate`, as `factoryKit.release` is for
  releases: `protectedRepository`, `confidential`, `gitlab`, `linkFiles`. An unknown key is refused.
- **Refusal is the default without them.** An unset `protectedRepository` protects nothing by name, but
  every write still has to name its target with `--repo`, and a target holding issues or pull requests the
  migration did not write takes `--cutover` as well. A board with confidential items and no `confidential`
  setting stops before planning a write.
- **Only the `copy` policy is built.** `placeholder` and `skip` are documented and refused by the settings,
  since neither has run, and a skipped number is spent for good. The confidential label's name stays the
  adapter's, because that name is what makes the tooling withhold those titles on GitHub.

## Consequences
- A project moving its board configures four keys and follows one document. Makers Market keeps nothing of
  its own: it sets `factoryKit.migrate` and runs the kit's scripts, `--verify` and `--mapping` included.
- The adapter now renews a token before it expires and retries once on a 401. Neither shows in a session
  that lasts minutes; a process outliving its token no longer fails on it.
- The ported script has not run against a live board since the port. Makers Market's run was the original,
  which made the same calls; its first `--verify` with the kit's copy, against its own board, is the check
  that closes this (`TASKS.md`).
- Building `placeholder` or `skip` is a settings change, a planning change and selftest cases, and nothing
  else has to move.

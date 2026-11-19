# 0005. Record numbers are leased as git refs on origin, pushed with the developer's own credentials

Date: 2026-11-10 · Status: accepted

## Context
Parallel branches, whether developers or agent sessions, pick the same next number for a sequentially
numbered record. Git merges two files numbered 0025 with different titles without a conflict, and `scripts/check-docs.mjs`
fails only once both are on one branch, so somebody renumbers afterwards and rewrites every citation of the
moved number. The Hub (knowit/k-market) has at least four renumbering commits. Until now the only
coordination was prose: a reserved-numbers list in `CONTRIBUTING.md`, and a batch telling the other sessions
the next ADR number after a merge. Work item #29 asked for numbers to be claimed centrally, before the file
is written. Its plan and its review round were agreed on 2026-11-10, and the maintainer approved a new store
on origin in that session (AGENTS.md ground rule 9).

The proposal took leases through the host's API: `POST git/refs` on GitHub, which returns 422 on an
existing ref, plus a release workflow, takeover of stale leases and configured line branches. On GitLab
that route needs the Developer token (`GITLAB_MR_TOKEN`) on a routine path, because the board token is
Reporter. GitLab's API also creates only branches and tags, so it has no way to create a `refs/leases/*`
ref. On GitHub it widens what the App's `assets` token is documented to write.

## Decision
- **A lease is a ref, `refs/leases/<kind>/<NNNN>`, on origin.** It points at a parentless commit with an
  empty tree, and the commit's message is JSON with the kind, number, branch, claimant and time.
  `git ls-remote origin 'refs/leases/*'` lists the leases with nothing installed, and no default refspec
  fetches them.
- **It is pushed with the developer's own git credentials**, the ones every branch push already uses. It
  goes through no board token, so it works the same way on both hosts. `pnpm lease <kind>` takes one above
  the highest number in the kind's directory on every remote branch and every live lease, and pushes it.
  The push is create-only: a parentless commit never fast-forwards another, and a push to a ref that does
  not exist sends "old value: none", which the server checks under its ref lock. A refused claim moves to
  the next number, but only if the ref now exists. Any other refusal stops the claim.
- **Kinds are configured** in `package.json`, `factoryKit.numbered`: a directory, a filename pattern, and
  `leased`. The kit ships the ADRs, leased. A kind whose number a generator picks (a Drizzle migration
  takes its index from its journal and cannot be handed one) is configured without `leased`. It is under
  `check-docs`'s duplicate guard only, which now covers every configured kind.
- **Leasing is enforced at push** for leased kinds. The lefthook pre-push hook runs
  `node scripts/lease.mjs check`, which refuses a numbered file that is on no other remote branch and is not
  leased to the branch being pushed. It checks each branch the push updates, as git's pre-push input names
  them, under the remote branch's name; a delete or a tag carries no record. HEAD's branch is checked only
  in a run by hand. "Other remote branch" means one origin has at push time, read with `ls-remote`, not a
  remote-tracking ref the host may since have deleted, and never a `ci/` snapshot branch, which
  `pnpm ci:remote` pushes with `--no-verify`. A file the lease holder's own branch also has counts as
  inherited, as happens when a batch branch merges an item branch. A record the kit itself ships, listed
  in `factoryKit.manifest` with a hash its file still matches, needs no lease: adoption copies the kit's
  ADRs in under the kit's numbers, which no lease on the project's origin holds. The check is not part of `pnpm check`: it reads origin,
  and `pnpm check` runs offline and in CI, where the branch is a snapshot or a merge ref.
- **Left out of the proposal:** stale-lease takeover (an abandoned lease leaves a gap, and gaps are
  legal), a release workflow (`pnpm lease --prune` deletes the leases whose number has reached the default
  branch, and each claim runs it first), and line-branch configuration (scanning every remote branch covers
  the line branches).

## Consequences
- Two sessions can no longer take one number, pushed or not, as long as each leases before it pushes. The
  selftest races two claimants for ten numbers against a local bare repository and asserts exactly
  0005–0014, each leased once.
- An ADR can't be pushed without a lease. Offline work still writes one. The push then fails and names
  `pnpm lease <kind>`, which usually gives the same number back. Gaps appear where a lease is abandoned.
- This is the first kit command that writes and deletes refs on origin from a developer's machine. A
  delete is refused unless its ref is under `refs/leases/`, and that prefix check is the whole of the
  safety.
- **Unconfirmed:** whether GitHub and GitLab accept a push to the custom `refs/leases/*` namespace at all
  (GitHub refuses `refs/pull/*`), and whether their ref update is atomic in the way git's own receive-pack
  is. This has been tested only against local bare repositories. If a host refuses the namespace, the claim
  stops at the first number with the host's message rather than walking upward. The live check on a scratch
  repository is listed in `TASKS.md`, "Rough edges".

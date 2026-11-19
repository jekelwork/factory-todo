# Security

How to report a vulnerability in this repository, and what happens after you do. The disclosure route below
works as shipped, on GitLab or GitHub. The scope comes in two parts: the kit's tooling, which every
repository started from the kit shares, and the application, which the project describes for itself.

`scripts/check-docs.mjs` fails `pnpm lint` if this file contains a placeholder word, because a reporter who
finds "to be decided" here has nowhere to go and tells nobody. Write what you know, and say plainly what does
not exist yet.

## Reporting a vulnerability

Report it **privately, on the board this repository uses** (the board `.env.gitlab` or `.env.github` names):

- **GitLab:** open a work item and tick **Confidential** when you create it. Only project members can see a
  confidential item, and the board tooling leaves it out of every listing, including the report agents
  read when a session starts (`isConfidential` in `scripts/board/core.mjs`).
- **GitHub:** use **Report a vulnerability** on the repository's Security tab (private vulnerability
  reporting). Do not open an issue: GitHub issues cannot be made confidential, so an issue is public to
  everyone who can see the repository, and the board tooling reads it into agent sessions.

If you cannot reach the board, or your report is about the board itself, contact the repository's maintainers
directly. The project page names them.

Include what you found, what an attacker gains from it, and the smallest way to reproduce it. A report that
names the file and line is worth more than a scanner's output. A proof of concept is welcome but never
required.

Until a fix is merged, keep the details out of board comments, commit messages and merge requests. All of
those are read more widely than the report itself.

## What to expect

- A person acknowledges the report, not a bot.
- An assessment of whether the issue can be reached in the deployment as configured, and what it affects.
- A fix on a branch, with a test that would have caught it, and the report kept current as the fix moves.
- Credit in the merge request, unless you would rather not have it.

## Scope: the kit's tooling

These parts come with the kit and run on developers' machines and in CI. They are in scope in every kit
repository:

- **Board credentials.** The tokens in `.env.gitlab` or `.env.github`, and the GitHub App key, can write to
  the board. They are kept out of `.env` deliberately, so that no application process inherits them
  (`AGENTS.md`, ground rule 3). Any way for one of them to reach a log, a comment, a commit or an
  application process is in scope.
- **Confidential items.** A confidential report printed by `pnpm items list`, the `SessionStart` hook or
  an attachment ends up in transcripts nobody audits. The filter fails closed: an item whose flag cannot be
  read is treated as confidential.
- **The secret gate.** `scripts/check-secrets.mjs` reads every staged blob at commit, and every object a
  push or a `pnpm ci:remote` snapshot sends that the remote does not already have. A common credential format it misses, or a way past it that an honest commit
  could trigger by accident, is worth reporting.
- **Remote CI snapshots.** `pnpm ci:remote` pushes uncommitted work to a `ci/` branch that everyone with
  access to the repository can see. That visibility is by design and is documented in the README. A
  snapshot that carries `.env`, `.env.gitlab`, `.env.github` or `.mise.local.toml` is a bug.
- **Board migration.** `scripts/board/migrate.mjs` reads GitLab text that anybody who can comment wrote,
  and turns upload links in it into files on the operator's machine, requests made with the GitLab token,
  and GitHub release assets. Text that steers any of those outside the upload it names is in scope.

## Scope: the application

<!-- example -->
> *Makers Market example:* in scope is everything running in the deployed container (the API, the SPA,
> the deployment manifests) and each external service the application calls. The most interesting area is
> listed first: the single query predicate that decides what a viewer may see, then signed links,
> notifications and uploaded files, each with the file that implements it. Out of scope: the development
> stub authentication mode (refused at startup in production), attacks that need an administrator to
> attack their own deployment, denial of service by volume, and scanner findings that cannot be reached
> in this configuration.
<!-- /example -->

Replace the example with this application's own scope. List the areas where a mistake is invisible to the
person it affects, and cite the file that implements each one. State what is out of scope, and why.

## What is already known

Keep the residual risks the project has accepted in `docs/THREAT-MODEL.md`, each with the control that
bounds it and the file that implements it, once the project has one. The placeholder check covers that
file as well. A report about a known risk is still useful: if the bound is wrong, the maintainers want to
know.

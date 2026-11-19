# The work-item board on GitHub — design

Date: 2026-09-30. Status: implemented on `feat/github-board` (ADR 0002); the live smoke run is pending a
GitHub App.

## Intent

The Factory Kit came out of Makers Market, which runs on GitLab, and its board tooling (`pnpm items`, the two
board skills, the `SessionStart` hooks, the merge-request flow) speaks only GitLab. The kit itself is hosted
on GitHub Enterprise Cloud (`github.com/knowit/factory-kit`), and Knowit projects live on both hosts. The
kit must therefore run the same board workflow on either.

**Success:** every `pnpm items` subcommand works against a GitHub repository with the same state machine,
the same output and the same skill procedure; GitLab behaviour is unchanged; `pnpm check` and
`pnpm check:items` stay green and cover the GitHub path offline.

## Decisions taken

| # | Decision | Why |
|---|---|---|
| D1 | Support **both** providers from one `pnpm items`. | A kit serving one host forks for the other. |
| D2 | Target **GitHub Enterprise Cloud** (`api.github.com`); a `GITHUB_API_URL` override exists, GHE Server is not otherwise supported or tested. | Where the kit and its projects live. |
| D3 | Authenticate as a **GitHub App**. | The state machine tells our comments from the reporter's by author. A GitLab project token is a built-in bot; on GitHub only an App (`<slug>[bot]`) gives an identity that is never a person. A developer's own token would make the developer's reply read as our follow-up. |
| D4 | **One App, down-scoped installation tokens** per command. | Keeps GitLab's Reporter/Developer split — the constantly-used credential cannot open a pull request — without a second App. |
| D5 | Screenshots and attachments go to an **orphan `board-assets` branch** via the Contents API. | GitHub has no upload API for issue or PR comments. Blob URLs with `?raw=true` render inline for anyone with repo access, private repos included. |
| D6 | Item links are a **`Relates-to: #n` line in the issue body**. | GitHub has no symmetric "relates to" link. Dependencies are directional; sub-issues are the umbrella shape the kit says must not hold. |
| D7 | GitHub issues are **never confidential**; vulnerability reports go to GitHub private vulnerability reporting, off the board. GitLab keeps its fail-closed filter. | GitHub issues have no confidential flag. |
| D8 | **Core + adapters** code split (below). | The alternatives were two transports inside every command, or a GitHub adapter faking GitLab JSON. |
| D9 | Provider chosen by which of `.env.gitlab` / `.env.github` exists; both present is an error naming both; `BOARD_PROVIDER` env var overrides. | No new config file for existing projects; ambiguity refuses rather than guesses. |
| D10 | CLI unchanged. `<iid>` means the issue number on GitHub; `mr` stays and gains the alias `pr`. | Skills and muscle memory keep working. |

Out of scope: GitHub Actions CI, GHE Server beyond the URL override, migrating an existing GitLab board.

## Architecture

```
scripts/work-items.mjs      CLI: argument parsing, commands, output. Talks to an adapter, never to fetch.
scripts/board/core.mjs      Pure: classify, labelsAfterClose, aiLabelsOn, milestoneChanges, releaseSummary,
                            citations, relation, blockingSiblings, pickShots, relates-to parse/add/strip,
                            analysisBlock, fieldFrom, isConfidential. Everything the selftest pins.
scripts/board/config.mjs    parseEnv, provider selection, BoardError (failure vocabulary).
scripts/board/gitlab.mjs    Today's GitLab transport, moved, plus normalizers.
scripts/board/github.mjs    App auth, transport, normalizers, board-assets uploads.
```

Node builtins only, like the rest of `scripts/`: the hook runs before `pnpm install`.

### Normalized shapes

Adapters return these and nothing else; core never sees provider JSON.

```
Item    { iid, title, url, labels[], description, state: 'open'|'closed', confidential,
          createdAt, updatedAt, commentCount, milestone: { title } | null }
Comment { id, authorId, author, body, createdAt }        // system notes already dropped
Milestone { id, title, state: 'open'|'closed', due: 'YYYY-MM-DD' | null }
```

`classify` and friends are rewritten against these field names; their logic does not change.

### Adapter interface

```
name                                  'gitlab' | 'github'
whoami()                              bot user id, or null (markers then carry the state machine)
listOpen() / listAll()                Item[], every page
get(iid)                              Item
comments(iid)                         Comment[], oldest first
comment(iid, body)                    { id }
setLabels(iid, labels)                Item
ensureLabel(name, colour, desc)
create({ title, description, labels }) Item
close(iid, labels)                    Item — state and labels in one write
links(iid)                            [{ iid }] linked items, both directions
link(iid, other) / unlink(iid, other)
milestones(state)                     Milestone[]
createMilestone(title)                Milestone
setMilestone(iid, title)              adapter maps title to GitLab id or GitHub number
upload(file, { iid })                 markdown that embeds the file
maxUploadBytes                        10 MB on both
defaultBranch()
openMr({ source, target, title, description })  { iid, url }
commentMr(iid, body)
```

`.claude/skills/advance-work-items/batch/mr-attach.mjs` becomes a thin wrapper over `upload` +
`commentMr`, so it works on both providers.

## GitHub adapter

### Configuration — `.env.github`

Git-ignored, documented in a new `.env.github.example` with the same "why not `.env`" reasoning as
`.env.gitlab.example`.

```
GITHUB_REPOSITORY=knowit/factory-kit
GITHUB_APP_ID=
GITHUB_APP_PRIVATE_KEY_PATH=      # PEM outside the repo recommended; *.pem is git-ignored regardless
GITHUB_APP_INSTALLATION_ID=       # optional; looked up via GET /repos/{repo}/installation when blank
GITHUB_API_URL=                   # optional; default https://api.github.com
GITHUB_TIMEOUT_MS=                # optional; default 8000
```

A real environment variable wins over the file, as on GitLab. No fallback to `.env`.

### Tokens

Per process and per scope, never written to disk. A JWT (RS256 via `node:crypto`, `iat` = now − 60 s,
`exp` = now + 9 min, `iss` = App id) is exchanged at `POST /app/installations/{id}/access_tokens` with
`repositories: [<repo name>]` and the scope's permissions:

| Scope | Permissions | Used by |
|---|---|---|
| board | `issues:write`, `metadata:read` | every command not listed below |
| assets | `contents:write` | `screenshots`, the upload step of `mr-attach` |
| mr | `pull_requests:write`, `contents:read` | `mr` / `pr`, and the PR comment of `mr-attach` |

The App is installed with the union of these. **The private key is the real secret**: it can mint any
permission the App holds, so it is treated as the GitLab tokens are — outside `.env`, git-ignored, refused by
the secret gate. Merging stays human through a branch ruleset on the default branch that requires a pull
request and does not list the App as a bypass actor; the same ruleset stops `contents:write` from touching
product branches.

### Identity

`GET /app` with the JWT gives the App's slug; the bot user is `<slug>[bot]`, and its numeric id comes from
`GET /users/<slug>[bot]`. That id is `whoami()`. If either call fails, `whoami()` returns null and the
`## Remediation plan` / `## Review coverage` markers carry the state machine, exactly as on GitLab today.

### Transport and failures

Headers: `Authorization: Bearer <token>`, `Accept: application/vnd.github+json`,
`X-GitHub-Api-Version: 2022-11-28`. Pagination follows `Link: <…>; rel="next"`; `per_page=100`.

Failure vocabulary, extended by one code:

| Response | Code | Transient |
|---|---|---|
| 401 | `unauthenticated` | no |
| 403 or 429 with `x-ratelimit-remaining: 0` or `retry-after` | `rate-limited` (new) | yes |
| other 403 | `forbidden` | no |
| 404 | `not-found`, message adds "or the App cannot see this repository" | no |
| other non-2xx | `http_error`, with GitHub's `message` | no |
| timeout / fetch failure / unconfigured | `timeout` / `network` | yes |

Exit codes and hook silence are unchanged: unconfigured, network, rate-limited, 401 and 403 exit 3, and
`--hook` / `--brief` print nothing.

### Command mapping

| Command | GitHub call | Note |
|---|---|---|
| `list`, `collisions` | `GET /repos/{repo}/issues?state=open` | **Drop every entry carrying `pull_request`** — GitHub's issues endpoint returns PRs too, and each would read as a `new` item. `commentCount` is `comments`. |
| `show` | `GET /issues/{n}`, `GET /issues/{n}/comments` | `siblings` from `Relates-to` lines. |
| `comment` | `POST /issues/{n}/comments` | |
| `label` | `PUT /issues/{n}/labels { labels }` | `ensureLabel`: colour without `#`; description cut to GitHub's 100-character limit. |
| `create` | `POST /issues { title, body, labels }` | A relates-to iid appends `Relates-to: #n` as the last body line. |
| `unlink` | `PATCH /issues/{n} { body }` on whichever side carries the line | Error when neither does, as today. |
| `close` | `PATCH /issues/{n} { state: 'closed', state_reason: 'completed', labels }` | One write; the already-closed path is kept. |
| `milestones`, `releases` | `GET`/`POST /milestones`, `PATCH /issues/{n} { milestone }` | GitHub `open` is GitLab `active`; `due_on` is cut to a date. |
| `screenshots`, `mr-attach` | Contents API `PUT /contents/{path}` on branch `board-assets` | Path `items/<iid>/<UTC stamp>/<file>`. First use creates the orphan branch through the Git Data API (blob → tree → parentless commit → ref) with a README saying what the branch is. Embed: `![name](https://github.com/{repo}/blob/board-assets/{path}?raw=true)`. |
| `mr` / `pr` | `POST /pulls { head, base, title, body }` | No per-PR "delete source branch"; docs say to enable the repository's *Automatically delete head branches*. |

### Links

`Relates-to: #n` lines, one per link, matched by `^Relates-to: #(\d+)\s*$` on a line of its own. `links(iid)`
is the union of the numbers in the item's own body and the open issues whose body names `#iid`; the open
listing is already fetched, and a closed sibling never blocks, so the open set suffices for the reverse
direction. Named items are then fetched with `get()` to learn their state. GitHub renders the `#n`
cross-reference in both timelines, so people see the link too. Editing the line out by hand removes the hold,
which is the documented way to do it without the tool.

## GitLab adapter

Today's transport moved verbatim into `gitlab.mjs`, wrapped in the interface above, plus normalizers
(`web_url` → `url`, `opened` → `open`, `user_notes_count` → `commentCount`, milestone `active` → `open`,
`note.author.id` → `authorId`, system notes dropped). **Behaviour stays identical**: same endpoints, same
writes, same output. Links keep using `/issues/{iid}/links`.

## Traps recorded in code comments and `docs/DECISIONS.md`

- A pull request saying `Closes #13` closes the issue only when merged into the **default** branch; a PR into a
  release branch does not. `close` is owed either way, as the skill already says.
- GitHub's issues endpoint returns pull requests (above).
- Label names containing `:` must be URL-encoded in `/labels/{name}` paths.
- A human editing a bot comment does not change its author; authorship stays a reliable signal.
- GitHub releases cannot carry a milestone: `docs/agents/releasing.md` has the release notes link the
  milestone's URL instead, and names `POST /repos/{repo}/releases`.

## Testing

All offline, in `pnpm check:items`, with exact expected values (ground rule 6):

- Every existing selftest case, fed normalized `Comment`s, with the same expected states.
- Normalizers: a GitHub issue becomes the expected `Item`; a listing mixing issues and PRs yields exactly
  the issue numbers; a GitLab issue becomes the expected `Item`. **Contract case:** equivalent GitLab and
  GitHub fixtures normalize deep-equal.
- `Relates-to`: add, parse, strip, exact results; sibling resolution in both directions across a fixture of
  open bodies.
- `Link` header parsing (next present, absent, last page) and a paging loop over a 101-item fixture, so the
  fixture crosses a page boundary.
- JWT: a throwaway RSA key generated in the test; signature verifies, claims are exactly as specified.
- Error classification, including `rate-limited` and the plain 403.
- Provider selection: none, GitLab, GitHub, both (error), override.
- `board-assets` path and embed markdown; a label description fits 100 characters.

Not automated: a live smoke run against a scratch GitHub repository, written as a checklist in
`docs/agents/issue-tracker.md`, run once after the App exists.

## Documentation and configuration changes

- `docs/agents/issue-tracker.md`: provider-neutral conventions, per-provider setup; for GitHub, creating the
  App (permissions: Issues RW, Pull requests RW, Contents RW, Metadata R), installing it on the repository,
  the default-branch ruleset with the App off the bypass list, auto-delete head branches, the smoke checklist.
- `README.md`: drop "A GitHub board" from *Not in this version*; update both ownership lists.
- `AGENTS.md`, `CLAUDE.md`, both skills, `docs/agents/releasing.md`: provider-neutral wording ("work item",
  "merge request — a pull request on GitHub"), GitHub specifics only where they differ.
- `.claude/settings.json`: status messages without "GitLab".
- `docs/adr/0002-board-provider-adapters.md`: D1–D10 in ADR form.
- `docs/DECISIONS.md`: the traps above.
- `.gitignore`: `.env.github`, `*.pem`; keep `.env.github.example`.
- `scripts/check-secrets.mjs`: `ghp_`, `gho_`, `ghs_`, `github_pat_`, and PEM private-key headers;
  `.env.github.example` exempt like its GitLab sibling.
- `.env.github.example` (new), `.github/pull_request_template.md` (new, mirrors the GitLab template).

## Rollout

One branch, `feat/github-board`, commits in this order so each is green on its own:

1. Extract `core.mjs`, `config.mjs`, `gitlab.mjs`; commands go through the adapter. GitLab output unchanged,
   selftest green.
2. Add `github.mjs` and its selftest cases.
3. Docs, config, secret gate, templates, ADR.

Wiring this repository's own `.env.github` is the user's step once the App exists.

# First-Setup Guide Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A browser stepper, opened by `pnpm kit:setup` in a fresh clone, that takes a tech lead from clone
to a running factory (board, CI, hooks, project settings, one demo item merged) in under an hour.

**Architecture:** A Node-builtins-only local HTTP server in `scripts/setup/` serves a static page and a
small JSON API. Every step is a pure check function over an injected shell runner and file reader, so the
whole catalogue is tested offline like the board selftest. The page holds no state: it asks the server to
re-run all checks on load and after every action. The board is read through the existing `pnpm items`
commands, extended with one read-only command for pull-request state.

**Tech Stack:** Node 22 built-ins (`node:http`, `node:child_process`, `node:fs`), plain HTML/CSS/JS with
inline SVG, the existing `scripts/work-items.mjs` and board adapters, `gh`/`glab` for branch protection.

**Spec:** `docs/superpowers/specs/2026-10-28-first-setup-guide-design.md` (work item #16)

## Global Constraints

- Setup end to end takes **under an hour**; every step's copy and every wait is judged against it.
- `scripts/` is Node built-ins only and runs before `pnpm install` succeeds; no new dependency.
- The server writes nothing without a click, runs only commands from a fixed list, and never runs
  `rm -rf .git` or any history rewrite; those are shown as commands to copy.
- Progress is never stored by the page or server; every check re-runs on load.
- The GitHub App's permissions stay Issues, Pull requests, Contents (read/write) and Metadata (read).
  Branch protection is read with the tech lead's own `gh` (GitHub) or `glab` (GitLab) login.
- The App's private key and token values never reach the browser; the page sees only "set / not set".
- The demo item runs on the real board, is kept as the worked example, and the hour includes its CI run
  in the chosen `CI_MODE`.
- Copy is plain language for a non-specialist ("grandmother guide"); every failure says what it means and
  what to click.
- Comments and doc prose follow the repository's style: the reason for a line, incidents kept.
- Every selftest case asserts the whole answer (AGENTS.md ground rule 6).

## Review Focus

1. **Another web page in the same browser calling the setup server** (CSRF, DNS rebinding): every API
   request without the session key, or with a `Host` other than `127.0.0.1:<port>`/`localhost:<port>`, or
   a cross-origin `Origin`, is refused with 403 — Task 7.
2. **The board unreachable (VPN down, exit 3) versus misconfigured**: the board step says "can't reach
   GitHub/GitLab right now" and stays retryable, never "your App is wrong" — Task 3.
3. **Coming back the next day, or re-opening after finishing**: all checks recompute, and the demo step
   finds the existing demo item by its `kit-demo` label (or, once merged, by CODEOWNERS' marker line)
   rather than filing a second one — Task 6.
4. **`gh`/`glab` missing or logged out**: the protection step says "install / log in to check this", with
   status `blocked`, not `fail` "your branch is unprotected" — Task 4.
5. **Both `.env.github` and `.env.gitlab` present**: the board step names the conflict and the fix (keep
   one, or set `BOARD_PROVIDER`), not the raw `BoardError` — Task 3.

---

## File Structure

```
scripts/setup/
  checks.mjs        Check result type, the runner/reader context, and the step-1/2 checks.
  board-checks.mjs  Steps 3 and 5: board reachability with plain-words errors; CI_MODE read/write.
  protection.mjs    Step 4: ruleset / protected-branch checks through gh or glab.
  project.mjs       Step 6: placeholder and example-marker scan; `pnpm check` result.
  demo.mjs          Step 7: demo item filing and stage detection.
  steps.mjs         The ordered catalogue: id, title, check, actions. One source the server and page read.
  server.mjs        HTTP server, session key, origin guard, action dispatch. Entry point.
  selftest.mjs      Offline tests for all of the above, wired into `pnpm check`.
  page/
    index.html      Stepper shell: progress rail + step panel.
    app.js          Fetches /api/state, renders, posts actions.
    style.css       Calm, readable, light/dark.
    copy.mjs        Per-step plain-language text, served as JSON so the selftest can lint it.
    img/            SVG diagrams (board flow, the loop with human gates) and GitHub/GitLab screenshots.
.claude/skills/start-project/SKILL.md   Step 6: Claude interviews the tech lead and writes the files.
scripts/work-items.mjs                  + `mr-status <branch> [--json]`.
scripts/board/github.mjs, gitlab.mjs    + `getMr(iid)` returning `mergedBy`, `mergedByBot`.
package.json                            + `kit:setup`; `check` runs the setup selftest.
README.md, docs/agents/issue-tracker.md, AGENTS.md   Start a project → the guide; shared-App path.
```

---

### Task 1: Check engine and the first two steps

**Files:**
- Create: `scripts/setup/checks.mjs`, `scripts/setup/selftest.mjs`
- Modify: `package.json` (`"check": "pnpm run lint && node .claude/hooks/guard.mjs --selftest && node scripts/setup/selftest.mjs"`)

**Interfaces:**
- Produces:
  - `type Result = { status: 'pass'|'fail'|'blocked'|'todo', summary: string, detail?: string, fix?: { text: string, commands?: string[], link?: string } }`
  - `makeContext({ root, sh, read }) -> Ctx` where `sh(cmd: string, args: string[]) -> Promise<{ code: number, stdout: string, stderr: string }>` and `read(rel: string) -> string|null`. `realContext(root)` builds one on `execFile` and `fs`.
  - `checkToolchain(ctx) -> Promise<Result>`, `checkHistory(ctx) -> Promise<Result>`
  - `fakeContext({ files, commands }) -> Ctx` exported from `selftest.mjs` for later tasks: `commands` maps `"git rev-list --count HEAD"`-style keys to `{ code, stdout, stderr }`; an unlisted command returns `{ code: 127, stdout: '', stderr: 'not found' }`.

- [ ] **Step 1: Write the failing tests** in `selftest.mjs`, using the `check(name, got, want)` helper shape from `scripts/ci-selftest.mjs` and the direct-run guard from `scripts/board/selftest.mjs`:
  - `toolchain: node 22 and pnpm 10.34.5 pass` → `{ status: 'pass', summary: 'node 22 and pnpm 10.34.5 are installed' }`, versions read from `mise.toml` in the fake files.
  - `toolchain: pnpm 9 fails with the mise fix` → `status: 'fail'`, `fix.commands: ['mise install']`.
  - `history: kit commits still present` (fake `git log --format=%s` contains `Merge pull request #14 from knowit/fix/action-sha-pins`) → `fail`, `fix.commands: ['rm -rf .git && git init -b main', 'mise exec -- pnpm install']`, and the summary says the page will not run them.
  - `history: no remote` → `todo`, `fix.link` to creating a repository on the chosen host.
  - `history: hooks not installed` (no `.git/hooks/pre-commit`) → `fail`, `fix.commands: ['mise exec -- pnpm install']`.
  - `history: first commit not pushed` (`git rev-parse @{u}` code 128) → `todo`, `fix.commands: ['git push -u origin main']`.
  - `history: template repo "Initial commit" then kit-version commit, pushed` → `pass`.
  - `history: all done` → `pass` with summary naming the kit version from the `chore: start from the Factory Kit <version>` subject.

- [ ] **Step 2: Run** `node scripts/setup/selftest.mjs`. Expected: fails with an import error from `checks.mjs`.

- [ ] **Step 3: Implement `checks.mjs`.** Kit commits are recognised by a subject in the kit's own history that a project never writes: any `Merge pull request #… from knowit/` subject while no `chore: start from the Factory Kit` commit exists. The kit version comes from `package.json`'s `version`.

- [ ] **Step 4: Run** `node scripts/setup/selftest.mjs` and `mise exec -- pnpm check`. Expected: all ✓, exit 0.

- [ ] **Step 5: Commit** `feat(setup): check engine with toolchain and history steps (#16)`.

### Task 2: Step catalogue and copy

**Files:**
- Create: `scripts/setup/steps.mjs`, `scripts/setup/page/copy.mjs`
- Test: `scripts/setup/selftest.mjs`

**Interfaces:**
- Consumes: `Result`, `Ctx`, the check functions from Tasks 1, 3–6 (added to `STEPS` as each lands).
- Produces:
  - `STEPS: Array<{ id: 'toolchain'|'history'|'board'|'protection'|'ci'|'project'|'demo'|'done', title: string, check: (ctx) => Promise<Result>, actions: Array<{ id: string, label: string, run: (ctx, input) => Promise<Result> }> }>`
  - `runAll(ctx) -> Promise<Array<{ id, title, result: Result }>>`; checks run in order, and a step after a `fail` still runs (no gating in the engine; the page decides).
  - `COPY: Record<StepId, { why: string, picture: string, body: string[] }>` (plain words; `picture` is a path under `page/img/`).

- [ ] **Step 1: Failing tests:**
  - `catalogue: ids in the spec's order` → `['toolchain','history','board','protection','ci','project','demo','done']`.
  - `catalogue: every step has copy and an existing picture` → for each id, `COPY[id].why` is non-empty and `fs.existsSync('scripts/setup/page/' + COPY[id].picture)`.
  - `copy: no jargon left unexplained` → no `COPY` string contains `ruleset`, `installation`, `CI_MODE` or `[REVIEW]` unless the same string's step `body` also contains the sentence defining it (keep the list of terms with their definitions in `copy.mjs`).
- [ ] **Step 2: Run, expect FAIL.**
  - `done: passes only when every other step passes` → with one step `blocked`, `done` is `todo` and its `detail` names that step's id.
- [ ] **Step 3: Implement.** `done`'s check is computed from the other results (a skip is page-only, so a skipped step keeps `done` at `todo`; the summary screen says which). Steps not yet built return `{ status: 'todo', summary: 'not built yet' }`, so the catalogue test passes from this task on. Write the copy for all eight steps now: why the step exists in one sentence, then what to do. Placeholder SVGs are fine here; Task 8 draws them.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(setup): step catalogue and plain-language copy (#16)`.

### Task 3: Board and CI-mode steps

**Files:**
- Create: `scripts/setup/board-checks.mjs`
- Modify: `scripts/setup/steps.mjs`
- Test: `scripts/setup/selftest.mjs`

**Interfaces:**
- Consumes: `Ctx`, `Result`.
- Produces: `checkBoard(ctx) -> Promise<Result>`, `explainBoardError(stderr: string, code: number) -> Result`, `checkCiMode(ctx) -> Promise<Result>`, `setCiMode(ctx, mode: 'local'|'remote'|'split') -> Promise<Result>`, `envStatus(ctx) -> { provider: 'github'|'gitlab'|null, vars: Record<string, boolean> }`.

- [ ] **Step 1: Failing tests** (`checkBoard` runs `node scripts/work-items.mjs list --json`):
  - `board: answers` (code 0, `[]`) → `pass`, summary `the board answers`.
  - `board: 404 on /installation` (stderr is the line this session hit: `work-items: not-found — GitHub GET /repos/knowit/factory-kit/installation answered 404: Not Found (or the App cannot see this repository)`) → `fail`, summary `The App exists, but it is not installed on this repository`, `fix.link` to the App's installation settings.
  - `board: unreachable` (code 3, stderr containing `network`) and fake files hold a filled `.env.github` → `blocked`, summary `Can't reach GitHub right now`, no "configured wrongly" wording. (Review Focus 2.)
  - `board: not configured` (neither env file) → `todo` with the two paths (shared org App / new App) in `fix.text`.
  - `board: both env files` → `fail`, `fix.text` names keeping one or setting `BOARD_PROVIDER`. (Review Focus 5.)
  - `board: GitLab without GITLAB_MR_TOKEN` → `fail`: the demo's merge request needs it.
  - `envStatus: never returns a value` → for a `.env.github` with `GITHUB_APP_ID=123`, `vars` is exactly `{ GITHUB_REPOSITORY: false, GITHUB_APP_ID: true, GITHUB_APP_PRIVATE_KEY_PATH: false, GITHUB_APP_INSTALLATION_ID: false }`.
  - `ci: none set` → `todo`; `ci: split in .mise.local.toml` → `pass` with summary naming split.
  - `ci: GitLab offers local only without a mirror` → `checkCiMode`'s result lists the allowed modes, exactly `['local']`.
  - `setCiMode: writes [env] CI_MODE and keeps other lines` → given `.mise.local.toml` with `[tools]\nfoo = "1"\n`, the written file is exactly `[tools]\nfoo = "1"\n\n[env]\nCI_MODE = "remote"\n`, and the result's `detail` says a new shell picks it up (mise exports env at shell start).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Match errors on the `work-items: <code> —` prefix, which `BoardError` already prints, not on the free text. `ctx.write(rel, text)` joins `Ctx` here (the fake records writes; add it to `fakeContext`).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(setup): board and CI-mode steps with plain-words errors (#16)`.

### Task 4: Branch-protection step

**Files:**
- Create: `scripts/setup/protection.mjs`
- Modify: `scripts/setup/steps.mjs`
- Test: `scripts/setup/selftest.mjs`

**Interfaces:**
- Produces: `checkProtection(ctx) -> Promise<Result>`. GitHub: `gh api repos/<repo>/rules/branches/<default>`, `gh api repos/<repo>` (`delete_branch_on_merge`), `gh api repos/<repo>/private-vulnerability-reporting` (`enabled`), and the App must not appear in any ruleset's `bypass_actors` (`gh api repos/<repo>/rulesets/<id>`). GitLab: `glab api projects/:id/protected_branches/<default>`.

- [ ] **Step 1: Failing tests:**
  - `protection: gh missing` (code 127) → `blocked`, summary `Install the GitHub CLI (gh) so the guide can check this`, never `fail`. (Review Focus 4.)
  - `protection: gh logged out` (code 4, stderr `gh auth login`) → `blocked`, `fix.commands: ['gh auth login']`.
  - `protection: pull request rule, no App bypass, auto-delete on, reporting on` → `pass`.
  - `protection: App listed as bypass actor` → `fail`, summary says the App could merge on its own.
  - `protection: auto-delete off` → `fail`, `fix.link` to the repository's General settings.
  - `protection: three things missing` → `fail` whose `detail` lists exactly those three, in a fixed order.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** The App's id for the bypass check comes from `.env.github`'s `GITHUB_APP_ID`.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(setup): branch-protection step through the tech lead's gh login (#16)`.

### Task 5: Project-settings step and the interview skill

**Files:**
- Create: `scripts/setup/project.mjs`, `.claude/skills/start-project/SKILL.md`
- Modify: `scripts/setup/steps.mjs`
- Test: `scripts/setup/selftest.mjs`

**Interfaces:**
- Produces: `checkProject(ctx) -> Promise<Result>`, `PLACEHOLDERS: Array<{ file: string, pattern: RegExp, what: string }>`, `HANDOVER_PROMPT: string` (the exact text the page shows to paste into Claude Code).

- [ ] **Step 1: Failing tests:**
  - `project: fresh kit` → `todo`, `detail` lists exactly: `AGENTS.md: title line`, `AGENTS.md: one-sentence description`, `AGENTS.md: project ground rules`, `AGENTS.md: layout`, `docs/agents/project.md: example blocks`, `SECURITY.md: example scope`, `docs/adr/0001: date`, `package.json: check runs only the kit's lint`.
  - `project: only ADR date left` → `todo`, `detail` exactly `['docs/adr/0001: date']`.
  - `project: all filled, pnpm check fails` → `fail` with the last 20 lines of the check output in `detail`.
  - `project: all filled, pnpm check passes` → `pass`.
  - `project: guard lists are optional` → a project with no generated paths in `.claude/hooks/guard.mjs` still passes (a project may have none); the skill asks instead.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `project.mjs`.** Patterns: `<Project name>`, `<One sentence:`, the *(project)* rule 10 placeholder text, `<add the project's own directories>`, `<!-- example -->` in `docs/agents/project.md` and `SECURITY.md`, `Date: YYYY-MM-DD` in `docs/adr/0001-*`, and `package.json`'s `check` equal to the kit's own.
- [ ] **Step 4: Write `start-project/SKILL.md`.** Follow `mattpocock-skills:writing-for-agents` and the shape of `.claude/skills/triage-work-items/SKILL.md`. Procedure: run `node scripts/setup/project.mjs --list` for what is left; interview one topic at a time (stack and its lint/typecheck/test commands, the two or three irreversible failures for project.md §1, routes, generated paths, security scope, the project's own ground rules with their reasons); write each file with `Edit`; run `pnpm check`; commit `chore: fill in the project parts`. Budget: aim for 15 minutes of the tech lead's time; ask with the picker where answers are a choice.
- [ ] **Step 5: Run selftest, expect PASS. Commit** `feat(setup): project-settings step and start-project skill (#16)`.

### Task 6: Board tooling for pull-request state, and the demo step

**Files:**
- Modify: `scripts/board/github.mjs` (`githubMr`, new adapter method `getMr`), `scripts/board/gitlab.mjs` (`gitlabMr`, `getMr`), `scripts/work-items.mjs` (`mr-status` subcommand and usage line), `scripts/board/selftest.mjs`
- Create: `scripts/setup/demo.mjs`
- Modify: `scripts/setup/steps.mjs`, `docs/agents/issue-tracker.md` (the new subcommand), `.claude/settings.json` (pre-approve `pnpm items mr-status`, it only reads)
- Test: `scripts/board/selftest.mjs`, `scripts/setup/selftest.mjs`

**Interfaces:**
- Produces:
  - Adapter `getMr(iid: number) -> Promise<Mr & { mergedBy: string|null, mergedByBot: boolean }>`. `pulls?state=…` lists omit `merged_by`, so this is one `GET pulls/<n>` (GitLab: `merge_requests/<iid>`, `merged_by`). `mergedByBot` compares the merger's id with `whoami()`.
  - CLI `pnpm items mr-status <branch> --json` → `{ branch, mr: null | { iid, url, state: 'open'|'merged'|'closed', mergedBy, mergedByBot } }` for the newest request from that branch.
  - `DEMO_LABEL = 'kit-demo'`, `DEMO_BRANCH = (iid) => 'kit-demo/' + iid`, `DEMO_ITEM: string` (title + body file content), `fileDemo(ctx) -> Promise<Result>` (action), `checkDemo(ctx) -> Promise<Result>`, `demoStages(show, mrStatus) -> Array<{ id: 'filed'|'planned'|'answered-board'|'answered-picker'|'go'|'pr'|'merged'|'closed', done: boolean }>`.

- [ ] **Step 1: Failing board selftests** through the existing fake fetch:
  - `github getMr: merged by a person` → `{ …, state: 'merged', mergedBy: 'octo', mergedByBot: false }`.
  - `github getMr: merged by the App` → `mergedByBot: true`.
  - `gitlab getMr: merged_by present` → the same two cases.
  - `mr-status: no request from the branch` → `{ branch: 'kit-demo/7', mr: null }`.
- [ ] **Step 2: Run** `mise exec -- pnpm check:items`. Expect FAIL. **Implement** the adapter method and subcommand. **Run**, expect PASS. **Commit** `feat(items): mr-status reports who merged a request (#16)`.
- [ ] **Step 3: Failing setup selftests** for `demoStages`, each asserting the full eight-entry array:
  - item just filed (label `kit-demo`, no comments) → only `filed` done.
  - plan posted (a `kind: 'plan'` comment) → `filed`, `planned`.
  - one reporter reply plus one bot comment carrying the picker answers and label `ai:answered` → adds `answered-board` and `answered-picker`.
  - picker answers posted but label still `ai:plan-posted` → `answered-picker` **not** done, and `checkDemo`'s `detail` explains the bot-authored trap in the words of AGENTS.md's "One trap worth knowing".
  - `ai:implementing` → adds `go`; open request → adds `pr`; merged by a person → adds `merged`; `closed: true` → all done.
  - merged by the App → `merged` not done, `fail` summary says the ruleset let the App merge.
- [ ] **Step 4: Failing tests for finding the demo again** (Review Focus 3):
  - `demo: open item with kit-demo label exists` → `fileDemo` returns that item, files nothing (fake records zero `create` calls).
  - `demo: CODEOWNERS on main carries "# Factory Kit worked example: #12"` → `checkDemo` is `pass` and reads stages from `show 12`.
- [ ] **Step 5: Implement `demo.mjs`.** The demo item asks for a `CODEOWNERS` file whose first line is the marker `# Factory Kit worked example: #<iid>`, with two decisions for the plan's `[REVIEW]` points: who owns `*`, and whether `docs/` gets a separate owner. The body says to answer one point on the board and one through the picker, and to work on `DEMO_BRANCH(iid)`. `fileDemo` writes the body to a temp file and runs `pnpm items create <file> "" kit-demo`. The page shows the prompt to paste into Claude Code at each human stage.
- [ ] **Step 6: Run, expect PASS. Commit** `feat(setup): demo item step on the real board (#16)`.

### Task 7: The server

**Files:**
- Create: `scripts/setup/server.mjs`
- Modify: `package.json` (`"kit:setup": "node scripts/setup/server.mjs"`)
- Test: `scripts/setup/selftest.mjs`

**Interfaces:**
- Consumes: `STEPS`, `runAll`, `COPY`, `realContext`.
- Produces: `createServer({ ctx, key }) -> http.Server`; routes `GET /?key=` (page), `GET /page/*` (static, only under `page/`), `GET /api/state` → `{ steps: [{ id, title, result, copy }] }`, `POST /api/action` body `{ step, action, input }` → `{ result, steps }`. Entry: listen on `127.0.0.1:0`, print the full URL, open it with `open`/`xdg-open`/`start`.

- [ ] **Step 1: Failing tests** against `createServer` on port 0 with a fake ctx:
  - `server: no key` → `/api/state` is 403.
  - `server: wrong Host header` (`evil.example:1234`) with the right key → 403. (Review Focus 1, DNS rebinding.)
  - `server: cross-origin POST` (`Origin: https://evil.example`) → 403, and the fake records zero commands.
  - `server: unknown action` → 400, zero commands.
  - `server: path traversal` (`/page/../../.env.github`) → 404.
  - `server: state never carries a secret` → with fake `.env.github` holding `GITHUB_APP_PRIVATE_KEY_PATH=/keys/app.pem`, the `/api/state` body contains neither `/keys/app.pem` nor any `.env.github` value.
  - `server: state` → 200 with exactly eight steps in catalogue order.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** Key: 32 random bytes hex, accepted from the query once, then from an `HttpOnly; SameSite=Strict` cookie. Port 0 so a busy port never blocks the start.
- [ ] **Step 4: Run, expect PASS.** Then `mise exec -- pnpm kit:setup` by hand: the browser opens, eight steps show, Ctrl-C stops it.
- [ ] **Step 5: Commit** `feat(setup): local server with key and origin guard (#16)`.

### Task 8: The page

**Files:**
- Create: `scripts/setup/page/index.html`, `app.js`, `style.css`, `img/*.svg`, `img/github/*.png`, `img/gitlab/*.png`
- Test: e2e by hand (below), screenshots attached to #16

**Interfaces:**
- Consumes: `/api/state`, `/api/action`, `COPY`.

- [ ] **Step 1: Build the stepper** as in the chosen mockup (A): a left rail with each step's status (✓, ✗, ⏳ blocked, ○ todo), and a main panel with the step's `why`, its picture, its `body`, the check result in plain words, the fix (commands with a copy button, links), and the buttons "Check again", the step's actions, "Skip this for now". A red step disables "Next" until it passes or is skipped. A skipped step stays visibly skipped in the rail.
- [ ] **Step 2: Draw the SVGs:** `board-flow.svg` (you → App → issues), `loop.svg` (report → plan with `[REVIEW]` → **you answer** → **you say go** → build → **you merge**, the human gates highlighted), `ci-modes.svg`. Inline in the page so they theme with light/dark.
- [ ] **Step 3: Take the screenshots** of every GitHub and GitLab screen steps 2–4 send the tech lead to (create repository, create App or install shared App, generate key, ruleset, auto-delete, vulnerability reporting; GitLab tokens and protected branch). Name them by step, e.g. `img/github/3-install-app.png`. Add a `README.md` in `img/` saying when they were taken, so a stale screenshot is visible as stale.
- [ ] **Step 4: Demo step panel:** the eight demo stages as a vertical track; at `answered`, `go` and `merged`, a note "this is where you were in the loop". Poll `/api/state` every 10 seconds only while the demo step is open.
- [ ] **Step 5: Check at 390px width and in dark mode** with the browser's device toolbar; no horizontal scroll.
- [ ] **Step 6: Commit** `feat(setup): stepper page, diagrams and screenshots (#16)`.

### Task 9: Docs

**Files:**
- Modify: `README.md` ("Start a project" becomes: clone, `mise install && pnpm install`, `pnpm kit:setup`, with today's numbered list kept as the reference the guide follows; add `scripts/setup/*` and `.claude/skills/start-project` to the kit-owned list), `docs/agents/issue-tracker.md` (GitHub: a "Reuse a shared organisation App" path beside "Create a GitHub App", and the ready-to-send request for an org admin), `AGENTS.md` (Commands table: `pnpm kit:setup`; Layout: `scripts/setup/`)

- [ ] **Step 1: Edit the three files.** Keep each rule in one place: the guide's steps live in `copy.mjs`; README points at the guide and does not repeat its text.
- [ ] **Step 2: Run** `node scripts/check-docs.mjs`. Expected: every cited path resolves.
- [ ] **Step 3: Commit** `docs: point Start a project at the setup guide (#16)`.

### Task 10: The timed walk

- [ ] **Step 1:** In a scratch repository on GitHub (`knowit/factory-kit-setup-trial` or similar, created for this), clone the branch's kit, run `pnpm kit:setup`, and walk every step with a stopwatch, the demo included, using the shared App. Record each step's minutes.
- [ ] **Step 2:** Under 60 minutes in total: post the timings and the page's screenshots on #16 (`pnpm items screenshots 16 <dir>`). Over 60: post the timings, name the slowest step, and fix it before going on.
- [ ] **Step 3:** Repeat steps 3–4 on GitLab if a GitLab test project is available; otherwise say on #16 that the GitLab path is untested.
- [ ] **Step 4:** `mise exec -- pnpm check`, then `pnpm run ci`, then open the pull request with `pnpm items pr`, linking #16.

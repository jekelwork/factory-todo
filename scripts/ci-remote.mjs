#!/usr/bin/env node
// Runs `.github/workflows/ci.yml` on GitHub-hosted runners against the working tree as it is now: committed
// or not, without touching the branch, the index or the files. `pnpm ci:remote`, or `pnpm run ci` in remote
// or split mode (scripts/ci.mjs).
//
//   1. Snapshot: a commit of HEAD plus every change and every untracked file `.gitignore` allows, made
//      through a temporary index. `git stash create` would miss untracked files, and a new file is the usual
//      reason a remote run differs from a local one. `.env` and `.mise.local.toml` are ignored, so they never
//      travel.
//   2. Secret scan of every object the push sends that the remote does not already have
//      (scripts/check-secrets.mjs --objects): every unpushed commit's blobs, not only the final tree's, because
//      a secret committed and then removed still travels with the history (#34).
//   3. Push it as `ci/<login>/<short-sha>`, with `--no-verify`: the pre-push hook would run the whole of
//      `pnpm check` here, which is what this exists to avoid, and the remote run does all of it. No dots in
//      the name, so a deploy workflow filtering on `*.*.x` cannot match it.
//   4. Wait for the run, one line per job as it finishes; then the failing logs only, the run URL, and the
//      `test-results` artifact, if the workflow uploads one, downloaded into CI_RESULTS_DIR.
//   5. Delete the branch. `.github/workflows/ci-prune.yml` catches one an interrupted run left behind.
//
// A remote run is visible to everybody with access to the repository, uncommitted edits included.
//
//   CI_REMOTE       the git remote to push to: `github` if there is one, else `origin`. An `~/.ssh/config`
//                   host alias is fine (`git@github-work:org/repo.git`), the usual way to keep an
//                   SSO-authorised work key apart from a personal one; `preflight()` asks `gh` whether the
//                   repository exists on GitHub before anything is pushed.
//   CI_RESULTS_DIR  where the `test-results` artifact lands (default `test-results`).
//
// `pnpm ci:fetch` (scripts/ci-fetch.mjs) brings back a pull request's own run with the same waiting, logs and
// download, which is why those are exported.
//
// Exit codes: 0 green, 1 red, 3 could not start (no `gh`, not signed in, no GitHub remote or it cannot be
// reached), which `pnpm run ci` reads as "fall back to local".
//
// Upstreamed from Makers Market (#334, #337), where it shipped as scripts/ci-remote.mjs.
// Node builtins only, like everything else in scripts/.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REMOTE =
  process.env.CI_REMOTE ??
  (spawnSync('git', ['remote', 'get-url', 'github'], { cwd: repo }).status === 0 ? 'github' : 'origin');
const RESULTS_DIR = process.env.CI_RESULTS_DIR ?? 'test-results';
const RESULTS_ARTIFACT = 'test-results';
const WORKFLOW = 'ci.yml';
export const WORKFLOW_NAME = 'CI'; // its `name:`
const POLL_MS = 15_000;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
  return {
    ok: !result.error && result.status === 0,
    out: (result.stdout ?? '').trim(),
    err: (result.stderr ?? '').trim(),
  };
}
const git = (args, options) => run('git', args, options);
function must(result, what) {
  if (!result.ok) throw new Error(`${what}: ${result.err || 'failed'}`);
  return result.out;
}

/**
 * `owner/name` from the remote's URL, so `gh` never has to guess between the GitLab and GitHub remotes.
 * The SSH host may be an `~/.ssh/config` alias (`git@github-work:org/repo.git`), the usual way to keep an
 * SSO-authorised key for the organisation apart from a personal one. `gh` still talks to github.com, and
 * `preflight()` proves the repository is there.
 */
export function slugOf(url) {
  return url.match(
    /^(?:git@[^:/]+:|ssh:\/\/git@[^/]+\/|https:\/\/github\.com\/)([^/]+\/[^/]+?)(?:\.git)?\/?$/,
  )?.[1];
}
const repoSlug = () => slugOf(git(['remote', 'get-url', REMOTE]).out);

/** Why a remote run cannot start, or undefined when it can. */
export function preflight() {
  if (!run('gh', ['--version']).ok) return '`gh` is not installed';
  if (!run('gh', ['auth', 'status']).ok) return '`gh` is not signed in (`gh auth login`)';
  if (!repoSlug()) return `no \`${REMOTE}\` remote pointing at a GitHub repository`;
  // An alias hides the host, so make sure the slug is a repository on GitHub before anything is pushed to
  // the remote: a GitLab `origin` would otherwise be sent a ci/ branch.
  if (!run('gh', ['repo', 'view', repoSlug(), '--json', 'name']).ok) {
    return `\`${REMOTE}\` (${repoSlug()}) is not a GitHub repository this \`gh\` account can see`;
  }
  if (!git(['ls-remote', '--exit-code', REMOTE, 'HEAD'], { timeout: 15_000 }).ok)
    return `\`${REMOTE}\` cannot be reached`;
  return undefined;
}

/** HEAD, or a commit of HEAD plus the working tree when it has changes. Touches nothing the developer sees. */
export function snapshot() {
  const head = must(git(['rev-parse', 'HEAD']), 'rev-parse HEAD');
  const dir = mkdtempSync(join(tmpdir(), 'hub-ci-index-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') };
    must(git(['read-tree', 'HEAD'], { env }), 'read-tree');
    must(git(['add', '-A'], { env }), 'add -A');
    const tree = must(git(['write-tree'], { env }), 'write-tree');
    if (tree === must(git(['rev-parse', 'HEAD^{tree}']), 'rev-parse HEAD^{tree}'))
      return { sha: head, dirty: false };
    const branch = git(['branch', '--show-current']).out || 'detached HEAD';
    const sha = must(
      git(['commit-tree', tree, '-p', head, '-m', `ci snapshot of ${branch} with uncommitted changes`]),
      'commit-tree',
    );
    return { sha, dirty: true };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Scans every object a push of the snapshot sends that the remote lacks. True when clean. */
export function scan(sha) {
  return run(process.execPath, ['scripts/check-secrets.mjs', '--objects', sha, '--remote', REMOTE], {
    stdio: 'inherit',
  }).ok;
}

export function branchFor(sha) {
  const login = run('gh', ['api', 'user', '--jq', '.login']).out || 'unknown';
  return `ci/${login}/${sha.slice(0, 10)}`;
}

export function push(sha, branch) {
  must(git(['push', '--no-verify', '--quiet', REMOTE, `${sha}:refs/heads/${branch}`]), `push ${branch}`);
}

export function deleteBranch(branch) {
  git(['push', '--no-verify', '--quiet', REMOTE, '--delete', branch]);
}

/** `gh` against the remote's repository. Also scripts/ci-fetch.mjs's. */
export const gh = (args) => run('gh', [...args, '--repo', repoSlug()]);

/** The run the push started. A push takes a few seconds to become a run. */
export async function findRun(branch, sha) {
  for (let i = 0; i < 40; i++) {
    const out = gh(['run', 'list', '--branch', branch, '--json', 'databaseId,headSha,url,workflowName']).out;
    // By name rather than `--workflow ci.yml`, which resolves the file through the workflows API and has
    // nothing to resolve before the workflow's first run anywhere. (Unconfirmed: it worked once a run existed.)
    const hit = out
      ? JSON.parse(out).find((r) => r.headSha === sha && r.workflowName === WORKFLOW_NAME)
      : undefined;
    if (hit) return { id: String(hit.databaseId), url: hit.url };
    await sleep(3000);
  }
  throw new Error(`no ${WORKFLOW} run appeared for ${branch}`);
}

export function cancel(id) {
  gh(['run', 'cancel', id]);
}

const seconds = (job) =>
  job.startedAt && job.completedAt
    ? Math.round((Date.parse(job.completedAt) - Date.parse(job.startedAt)) / 1000)
    : 0;
const mark = (conclusion) =>
  conclusion === 'success' ? '\x1b[32m✔\x1b[0m' : conclusion === 'skipped' ? '-' : '\x1b[31m✖\x1b[0m';

/** Polls until the run completes, printing each job once, when it finishes. Resolves to its conclusion. */
export async function watch(id) {
  const printed = new Set();
  for (;;) {
    const out = gh(['run', 'view', id, '--json', 'status,conclusion,jobs']).out;
    if (out) {
      const view = JSON.parse(out);
      for (const job of view.jobs) {
        if (job.status !== 'completed' || printed.has(job.name)) continue;
        printed.add(job.name);
        console.log(`  ${mark(job.conclusion)} ${job.name} (${seconds(job)} s)`);
      }
      if (view.status === 'completed') return view.conclusion;
    }
    await sleep(POLL_MS);
  }
}

/** The failing jobs' logs, the tail of each, so a red run says why without a browser. */
export function failedLogs(id) {
  const log = gh(['run', 'view', id, '--log-failed']).out;
  if (log)
    console.log(
      `\n\x1b[1m▸ failing output (last 200 lines)\x1b[0m\n${log.split('\n').slice(-200).join('\n')}`,
    );
}

/**
 * The workflow's `test-results` artifact (screenshots, traces), into CI_RESULTS_DIR, where a local run would
 * leave them. When that folder cannot be cleared (a local run is writing to it), into `<dir>-<run>` instead.
 */
export function downloadResults(id) {
  let target = resolve(repo, RESULTS_DIR);
  try {
    rmSync(target, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    target = `${target}-${id}`;
  }
  const result = gh(['run', 'download', id, '--name', RESULTS_ARTIFACT, '--dir', target]);
  const where = target.startsWith(repo) ? target.slice(repo.length + 1) : target;
  if (result.ok) console.log(`  Results: ${where} (from run ${id})`);
}

/** Push, wait and report. `beforeWait` runs once the run exists: split mode's local steps go there. */
export async function remote({ beforeWait } = {}) {
  const why = preflight();
  if (why) {
    console.error(`\x1b[33m! ci:remote cannot start: ${why}.\x1b[0m`);
    return 3;
  }
  const snap = snapshot();
  console.log(
    `\x1b[1m▸ snapshot ${snap.sha.slice(0, 10)}\x1b[0m ${snap.dirty ? '(HEAD plus uncommitted changes)' : '(HEAD, clean tree)'}`,
  );
  if (!scan(snap.sha)) {
    console.error(
      '\x1b[31m✖ The snapshot carries something that looks like a secret; nothing was pushed.\x1b[0m',
    );
    return 1;
  }
  const branch = branchFor(snap.sha);
  push(snap.sha, branch);
  let id;
  const interrupt = () => {
    if (id) cancel(id);
    deleteBranch(branch);
    process.exit(130);
  };
  process.on('SIGINT', interrupt);
  try {
    const found = await findRun(branch, snap.sha);
    id = found.id;
    console.log(`\x1b[1m▸ ${branch}\x1b[0m ${found.url}`);
    if (beforeWait && !(await beforeWait({ sha: snap.sha }))) {
      cancel(id);
      console.log('  Remote run cancelled: a local step failed first.');
      return 1;
    }
    const conclusion = await watch(id);
    if (conclusion !== 'success') failedLogs(id);
    downloadResults(id);
    console.log(
      conclusion === 'success'
        ? `\n\x1b[32m\x1b[1m✔ Remote CI passed.\x1b[0m ${found.url}`
        : `\n\x1b[31m\x1b[1m✖ Remote CI ${conclusion}.\x1b[0m ${found.url}`,
    );
    return conclusion === 'success' ? 0 : 1;
  } finally {
    process.off('SIGINT', interrupt);
    deleteBranch(branch);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.includes('--help')) {
    console.log(`Usage: pnpm ci:remote

Runs .github/workflows/ci.yml on GitHub runners against the working tree, committed or not, and reports
back here. Needs \`gh\` signed in with an account that can see the repository, and a GitHub remote
(README, "Where CI runs").

  CI_REMOTE       The git remote to push to (default: github if present, else origin).
  CI_RESULTS_DIR  Where the test-results artifact lands (default test-results).`);
    process.exit(0);
  }
  try {
    process.exit(await remote());
  } catch (err) {
    console.error(`\x1b[31m✖ ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

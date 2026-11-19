#!/usr/bin/env node
// `pnpm ci:fetch <pull request | run>`: a pull request's CI run on GitHub, brought back here.
//
// Once a pull request is open, its own `.github/workflows/ci.yml` run is the one its required `ci` check
// reads, and it tests the merge with the target rather than the branch alone. Nothing local has its
// screenshots or its failing logs, though. This finds the run, waits for it if it is still going (one line
// per job, as `pnpm ci:remote` prints them), shows the failing logs when it is red, and downloads its
// `test-results` artifact into CI_RESULTS_DIR, where `pnpm ci:remote` leaves one — so
// `pnpm items screenshots <iid> <dir>` can post them. The waiting, the logs and the download are
// scripts/ci-remote.mjs's own.
//
//   pnpm ci:fetch 412                                         # pull request #412: its CI run at its head
//   pnpm ci:fetch https://github.com/o/r/pull/412             # the same
//   pnpm ci:fetch https://github.com/o/r/actions/runs/123456  # one run, by its URL
//   pnpm ci:fetch --run=123456                                # or by its id
//
// "At its head" means the newest `pull_request` run of the CI workflow on the pull request's head commit: a
// run on an earlier push is a different answer, and a `ci/` snapshot or a push run is not the pull
// request's check.
//
// Reads only: nothing is pushed, re-run or commented. `gh` signs in, and the remote is chosen, as for
// `pnpm ci:remote` (CI_REMOTE, CI_RESULTS_DIR).
//
// Exit codes: 0 the run passed, 1 it did not or none was found, 2 usage, 3 `gh` or the remote cannot be
// used. Node builtins only, like everything else in scripts/.
import { pathToFileURL } from 'node:url';
import { downloadResults, failedLogs, gh, preflight, WORKFLOW_NAME, watch } from './ci-remote.mjs';

/**
 * What the arguments name: `{ pr }`, `{ run }`, or `{ error }`. A bare number is a pull request, because
 * that is what a person has in hand; a run is named by its URL or `--run=`. Pure.
 */
export function parseTarget(args) {
  const words = args.filter((a) => !a.startsWith('--'));
  const run = args.find((a) => a.startsWith('--run='))?.slice('--run='.length);
  if (run !== undefined) {
    if (words.length || !/^\d+$/.test(run)) return { error: '--run= takes one run id, and nothing else' };
    return { run };
  }
  if (words.length !== 1) return { error: 'name one pull request or run' };
  const [word] = words;
  const pr =
    /^#?(\d+)$/.exec(word) ?? /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)(?:[/?#].*)?$/.exec(word);
  if (pr) return { pr: pr[1] };
  const runUrl = /^https:\/\/github\.com\/[^/]+\/[^/]+\/actions\/runs\/(\d+)(?:[/?#].*)?$/.exec(word);
  if (runUrl) return { run: runUrl[1] };
  return { error: `not a pull request or a run: ${word}` };
}

/**
 * The pull request's CI run at its head: the newest `pull_request` run of the CI workflow on that commit.
 * `runs` is `gh run list --json databaseId,headSha,event,workflowName,createdAt,url`. Pure.
 */
export function pickRun(runs, headSha, workflowName = WORKFLOW_NAME) {
  const hits = runs
    .filter((r) => r.workflowName === workflowName && r.event === 'pull_request' && r.headSha === headSha)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return hits[0] ? { id: String(hits[0].databaseId), url: hits[0].url } : undefined;
}

function json(args, what) {
  const result = gh(args);
  if (!result.ok || !result.out) throw new Error(`${what}: ${result.err || 'no answer'}`);
  return JSON.parse(result.out);
}

/** The run a target names, or throws saying why there is none. */
function resolveRun(target) {
  if (target.run) {
    const view = json(['run', 'view', target.run, '--json', 'databaseId,url'], `run ${target.run}`);
    return { id: String(view.databaseId), url: view.url };
  }
  const pr = json(
    ['pr', 'view', target.pr, '--json', 'headRefName,headRefOid,url'],
    `pull request #${target.pr}`,
  );
  const runs = json(
    [
      'run',
      'list',
      '--branch',
      pr.headRefName,
      '--event',
      'pull_request',
      '--limit',
      '50',
      '--json',
      'databaseId,headSha,event,workflowName,createdAt,url',
    ],
    `the runs on ${pr.headRefName}`,
  );
  const hit = pickRun(runs, pr.headRefOid);
  if (!hit)
    throw new Error(
      `pull request #${target.pr} has no ${WORKFLOW_NAME} run at its head ${pr.headRefOid.slice(0, 10)} yet (${pr.url})`,
    );
  return hit;
}

export async function fetchRun(args) {
  const target = parseTarget(args);
  if (target.error) {
    console.error(
      `usage: pnpm ci:fetch <pull request number or URL> | <run URL> | --run=<id> — ${target.error}`,
    );
    return 2;
  }
  const why = preflight();
  if (why) {
    console.error(`\x1b[33m! ci:fetch cannot start: ${why}.\x1b[0m`);
    return 3;
  }
  const found = resolveRun(target);
  console.log(`\x1b[1m▸ run ${found.id}\x1b[0m ${found.url}`);
  const conclusion = await watch(found.id);
  if (conclusion !== 'success') failedLogs(found.id);
  downloadResults(found.id);
  console.log(
    conclusion === 'success'
      ? `\n\x1b[32m\x1b[1m✔ CI passed.\x1b[0m ${found.url}`
      : `\n\x1b[31m\x1b[1m✖ CI ${conclusion}.\x1b[0m ${found.url}`,
  );
  return conclusion === 'success' ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(`Usage: pnpm ci:fetch <pull request number or URL> | <run URL> | --run=<id>

Waits for a pull request's CI run at its head (or one run) to finish, prints its jobs and any failing logs,
and downloads its test-results artifact into CI_RESULTS_DIR. Reads only. Needs \`gh\` signed in and a GitHub
remote, as for pnpm ci:remote (README, "Where CI runs").

  CI_REMOTE       The git remote whose repository is read (default: github if present, else origin).
  CI_RESULTS_DIR  Where the test-results artifact lands (default test-results).`);
    process.exit(0);
  }
  try {
    process.exit(await fetchRun(args));
  } catch (err) {
    console.error(`\x1b[31m✖ ${err.message}\x1b[0m`);
    process.exit(1);
  }
}

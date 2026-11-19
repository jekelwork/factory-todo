// `pnpm check:ci` (run by `pnpm check`): what `pnpm ci:local` runs for a command line, and what `pnpm ci:fetch`
// takes an argument to name and which run is a pull request's. Offline, no `gh`, no container engine. Every
// case asserts the whole answer (AGENTS.md, "Assert the whole answer").
// Its own command, not part of the board's selftest (#13; README, "Kit-owned and project-owned").

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseTarget, pickRun } from './ci-fetch.mjs';
import { containerEnv, parseArgs, plan } from './ci-local.mjs';

export async function ciSelftest() {
  let failed = 0;
  const check = (name, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) console.log(`✓ ${name}`);
    else {
      failed++;
      console.error(`✗ ${name}:\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
    }
  };

  // ---- ci:local: the command line ---------------------------------------------------------------------------
  check('ci:local: no arguments is the whole pipeline', parseArgs([]), {
    help: false,
    skipContainer: false,
    only: undefined,
    image: undefined,
    platform: undefined,
    e2eArgs: [],
  });
  check(
    'ci:local: own flags before --, the e2e arguments after it, even ones that look like its own',
    parseArgs(['--only=test:e2e:container', '--image=app:ci', '--', '--shard=2/6', '--no-container']),
    {
      help: false,
      skipContainer: false,
      only: ['test:e2e:container'],
      image: 'app:ci',
      platform: undefined,
      e2eArgs: ['--shard=2/6', '--no-container'],
    },
  );
  check(
    'ci:local: an empty --image= is no image',
    parseArgs(['--image=', '--platform=linux/amd64']).image,
    undefined,
  );

  // ---- ci:local: the plan -----------------------------------------------------------------------------------
  const all = {
    lint: 'x',
    typecheck: 'x',
    coverage: 'x',
    build: 'x',
    'audit:prod': 'x',
    'check:items': 'x',
    'container:build': 'x',
    'test:e2e:container': 'x',
  };
  const names = (p) => p.run.map((s) => [s.script, s.args]);
  const base = { e2eArgs: [], arch: 'x64' };

  check(
    'ci:local: with lint, typecheck and coverage, check is not run; every container step is',
    names(plan(all, base)),
    [
      [null, []],
      ['lint', []],
      ['typecheck', []],
      ['check:items', []],
      ['coverage', []],
      ['build', []],
      ['audit:prod', []],
      ['container:build', []],
      ['test:e2e:container', []],
    ],
  );
  const prebuilt = plan(all, {
    ...base,
    only: ['container:build', 'test:e2e:container'],
    image: 'app:ci',
    e2eArgs: ['--shard=2/6'],
  });
  check(
    'ci:local: --image skips the build, says so, and the e2e step alone gets the arguments',
    [names(prebuilt), prebuilt.skipped, prebuilt.notes],
    [[['test:e2e:container', ['--shard=2/6']]], ['Container image build (--image=app:ci)'], []],
  );
  const lintOnly = plan(all, { ...base, only: ['lint'], platform: 'linux/amd64', e2eArgs: ['--shard=1/2'] });
  check(
    'ci:local: --platform and -- with neither of their steps running are named, not dropped silently',
    [names(lintOnly), lintOnly.notes],
    [
      [['lint', []]],
      [
        '-- --shard=1/2 is for test:e2e:container, which is not running.',
        '--platform=linux/amd64 is for container:build, which is not running.',
      ],
    ],
  );
  const arm = plan(all, { ...base, only: ['container:build'], arch: 'arm64' });
  check(
    'ci:local: an arm64 build without --platform warns that it is not the image that ships',
    arm.notes.map((n) => n.split(':')[0]),
    ['Building for this host, arm64, where most clusters take amd64'],
  );
  check(
    'ci:local: … and one with --platform does not',
    plan(all, { ...base, only: ['container:build'], arch: 'arm64', platform: 'linux/amd64' }).notes,
    [],
  );
  const bare = plan({ check: 'x' }, { ...base, skipContainer: true });
  check(
    'ci:local: a bare project runs check and says what it skipped, the container steps by flag',
    [names(bare), bare.skipped],
    [
      [
        [null, []],
        ['check', []],
      ],
      [
        'The work-item board state machine (no "check:items" script)',
        'Coverage floors (no "coverage" script)',
        'Production build (no "build" script)',
        'Production dependency audit (no "audit:prod" script)',
        'Container image build (--no-container)',
        'End-to-end suite against the image (--no-container)',
      ],
    ],
  );
  check(
    'ci:local: an unknown --only name stops the run, naming it',
    plan(all, { ...base, only: ['lint', 'e2e'] }).unknown,
    ['e2e'],
  );

  check(
    'ci:local: the container steps get CI_IMAGE, CI_PLATFORM and the detected engine',
    containerEnv({ image: 'app:ci', platform: 'linux/amd64' }, {}, 'podman'),
    { CI_IMAGE: 'app:ci', CI_PLATFORM: 'linux/amd64', CONTAINER_ENGINE: 'podman' },
  );
  check(
    'ci:local: … a CONTAINER_ENGINE already set wins, and nothing unset is invented',
    containerEnv({}, { CONTAINER_ENGINE: 'docker' }, 'podman'),
    { CONTAINER_ENGINE: 'docker' },
  );
  check('ci:local: … and with no engine found, none is set', containerEnv({}, {}, ''), {});

  // ---- ci:fetch: what an argument names ---------------------------------------------------------------------
  const targets = [
    ['a bare number is a pull request', ['412'], { pr: '412' }],
    ['so is #412', ['#412'], { pr: '412' }],
    ["a pull request's URL", ['https://github.com/o/r/pull/412'], { pr: '412' }],
    ['… with a tab of it', ['https://github.com/o/r/pull/412/checks'], { pr: '412' }],
    ["a run's URL is that run", ['https://github.com/o/r/actions/runs/38297496449'], { run: '38297496449' }],
    [
      "… and a job's URL its run",
      ['https://github.com/o/r/actions/runs/38297496449/job/1'],
      { run: '38297496449' },
    ],
    ['--run= names a run', ['--run=38297496449'], { run: '38297496449' }],
    [
      '--run= with a word beside it is refused',
      ['--run=1', '412'],
      { error: '--run= takes one run id, and nothing else' },
    ],
    ['--run= takes digits only', ['--run=abc'], { error: '--run= takes one run id, and nothing else' }],
    ['nothing is refused', [], { error: 'name one pull request or run' }],
    ['two are refused', ['1', '2'], { error: 'name one pull request or run' }],
    ['a branch name is refused', ['feat/230'], { error: 'not a pull request or a run: feat/230' }],
    [
      'another host is refused',
      ['https://gitlab.example/o/r/pull/4'],
      { error: 'not a pull request or a run: https://gitlab.example/o/r/pull/4' },
    ],
  ];
  for (const [name, args, want] of targets) check(`ci:fetch: ${name}`, parseTarget(args), want);

  // ---- ci:fetch: which run is the pull request's ------------------------------------------------------------
  const run = (id, over) => ({
    databaseId: id,
    headSha: 'aaa',
    event: 'pull_request',
    workflowName: 'CI',
    createdAt: '2026-10-12T10:00:00Z',
    url: `https://github.com/o/r/actions/runs/${id}`,
    ...over,
  });
  const runs = [
    run(1),
    run(2, { createdAt: '2026-10-12T11:00:00Z' }), // a re-run at the same head: the newest wins
    run(3, { createdAt: '2026-10-12T12:00:00Z', headSha: 'old' }), // an earlier head of the branch
    run(4, { createdAt: '2026-10-12T13:00:00Z', event: 'push' }), // a ci/ snapshot or a push
    run(5, { createdAt: '2026-10-12T14:00:00Z', workflowName: 'Deploy' }), // another workflow
  ];
  check('ci:fetch: the newest CI pull_request run at the head', pickRun(runs, 'aaa'), {
    id: '2',
    url: 'https://github.com/o/r/actions/runs/2',
  });
  check('ci:fetch: no run at the head is none', pickRun(runs, 'bbb'), undefined);

  // ---- the contract: importing these scripts runs nothing ---------------------------------------------------
  // Each has exactly one entry-point guard. Without it, the import at the top of this file would run the whole
  // pipeline, and the pipeline runs `pnpm check`, which runs this file again (#13).
  for (const file of ['ci-local.mjs', 'ci-fetch.mjs']) {
    const source = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
    const guards = source.match(/^if \(import\.meta\.url === pathToFileURL\(/gm) ?? [];
    check(`${file} runs only when it is the entry point`, guards.length, 1);
  }

  return failed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const failed = await ciSelftest();
  console.log(failed ? `\nCI SELFTEST FAILED — ${failed} case(s)` : '\nCI SELFTEST OK');
  process.exitCode = failed ? 1 : 0;
}

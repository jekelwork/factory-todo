#!/usr/bin/env node
// Runs, on this machine, what the CI pipeline would run on a runner — for the stretch of a project's life
// when no runner is attached, which on Makers Market was most of it. Without a runner every gate the CI file
// declares is inert, and a merge request shows no pipeline status because no pipeline runs. Until one is
// attached, this script IS the pipeline: run it before opening a merge request.
//
// It is not a replacement for CI, and two gaps are worth knowing before trusting a green run:
//
//   1. **Nobody else can see it.** A merge request still shows no status, and nothing stops a push from a
//      machine that skipped this. It is coverage, not enforcement.
//   2. **It runs on this host.** A container image built here is built for this architecture; on Apple
//      Silicon that is arm64, while most clusters take amd64. A green run proves the build is correct, not
//      that the artifact which would actually ship builds.
//
// HOW TO EXTEND IT. `STEPS` below is the pipeline, in order. Each step names a package.json script, and a
// step whose script does not exist yet is skipped with a line saying so — so a fresh project gets the gates
// it has, and a new gate is one line here plus the script it runs. Keep the order cheap-first: a lint
// failure should not wait behind a container build. Steps that need a container engine go after the
// `--no-container` marker.
//
// THE TESTS RUN ONCE. A project with `lint`, `typecheck` and `coverage` scripts gets those three in place of
// `check`, and its `coverage` script is the test run: `check` would run every test once without
// instrumentation and `coverage` would run them all again with it. On Makers Market that second run was
// 162 s of a 12-minute ci:local on a 12-core laptop, and 945 s on a 2-vCPU CI runner (Makers Market #335).
// This assumes `coverage` runs the whole suite, which a vitest `--coverage` over the same config does. If
// yours runs a subset, drop one of the three scripts' names here or keep `check` and accept the second run.
// `pnpm check`, the pre-push gate, is untouched and keeps its plain run.
//
// SOME OF THE STEPS. `--only=lint,typecheck` runs just those package.json scripts, and not the install: a CI
// job, or `pnpm run ci` in split mode (scripts/ci.mjs), has installed already and wants one gate from here
// rather than a copy of its command line.
//
// IMAGES AND PLATFORMS. The container steps are package.json scripts too, so the kit never names an image,
// an engine or a port: the project's scripts do. ci-local hands them three variables, which a script reads
// with a default of its own (`podman build ${CI_PLATFORM:+--platform $CI_PLATFORM} -t ${CI_IMAGE:-app:ci} .`):
//
//   CI_IMAGE          set by `--image=<tag>`, which also skips `container:build`: test an image somebody else
//                     built, such as a CI job that loaded one from another job's artifact.
//   CI_PLATFORM       set by `--platform=<p>`, e.g. linux/amd64, to build for the platform that ships (gap 2
//                     above). Emulated on another architecture, and several times slower: one run before a
//                     deploy, not one per merge.
//   CONTAINER_ENGINE  passed through when set; otherwise podman if present, else docker, else left unset.
//
// END-TO-END ARGUMENTS. Everything after `--` goes, unchanged, to the end of the `test:e2e:container` step's
// command: `pnpm ci:local --only=test:e2e:container --image=app:ci -- --shard=2/6` is one shard of a
// Playwright suite against a prebuilt image, which is how a workflow splits a slow suite across jobs.
//
// Node builtins only, like everything else in scripts/.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD = 'container:build';
const E2E = 'test:e2e:container';

/** The command line, split at `--`: this script's own flags before it, the e2e step's arguments after. Pure. */
export function parseArgs(argv) {
  const dashes = argv.indexOf('--');
  const own = dashes === -1 ? argv : argv.slice(0, dashes);
  const value = (name) =>
    own
      .find((a) => a.startsWith(`--${name}=`))
      ?.slice(name.length + 3)
      .trim() || undefined;
  return {
    help: own.includes('--help'),
    skipContainer: own.includes('--no-container'),
    only: value('only')?.split(',').filter(Boolean),
    image: value('image'),
    platform: value('platform'),
    e2eArgs: dashes === -1 ? [] : argv.slice(dashes + 1),
  };
}

/** [title, package.json script, needs a container engine?], in order. Pure. */
export function stepsFor(scripts) {
  // See "THE TESTS RUN ONCE" above.
  const testsUnderCoverage = Boolean(scripts.lint && scripts.typecheck && scripts.coverage);
  return [
    ['Install from the lockfile', null, false],
    ...(testsUnderCoverage
      ? [
          ['Lint', 'lint', false],
          ['Typecheck', 'typecheck', false],
        ]
      : [['Lint, typecheck and tests', 'check', false]]),
    ['The work-item board state machine', 'check:items', false],
    [testsUnderCoverage ? 'Tests, with the coverage floors' : 'Coverage floors', 'coverage', false],
    ['Production build', 'build', false],
    ['Production dependency audit', 'audit:prod', false],
    ['Container image build', BUILD, true],
    ['End-to-end suite against the image', E2E, true],
  ];
}

/**
 * What a run does: the steps to run, each with the arguments it gets, what is skipped and why, and notes
 * worth a line before it starts. `unknown` lists `--only` names that are not steps; the run stops on them.
 * `options` is `parseArgs`'s answer plus `arch` (process.arch). Pure.
 */
export function plan(scripts, options) {
  const steps = stepsFor(scripts);
  // Every step either shape of the pipeline can hold, so `--only=lint` means the same whichever shape this is.
  const known = [
    ['Lint, typecheck and tests', 'check', false],
    ['Lint', 'lint', false],
    ['Typecheck', 'typecheck', false],
    ...steps.filter(([, script]) => script && !['check', 'lint', 'typecheck'].includes(script)),
  ];
  const { only, skipContainer, image, platform, e2eArgs = [] } = options;
  const unknown = only?.filter((name) => !known.some(([, script]) => script === name)) ?? [];
  const run = [];
  const skipped = [];
  const notes = [];
  if (unknown.length > 0) return { run, skipped, notes, unknown, known: known.map(([, s]) => s) };
  for (const [title, script, container] of only ? known.filter(([, s]) => only.includes(s)) : steps) {
    if (container && skipContainer) {
      skipped.push(`${title} (--no-container)`);
      continue;
    }
    if (script === BUILD && image) {
      skipped.push(`${title} (--image=${image})`);
      continue;
    }
    if (script && !scripts[script]) {
      skipped.push(`${title} (no "${script}" script)`);
      continue;
    }
    run.push({ title, script, container, args: script === E2E ? e2eArgs : [] });
  }
  const runs = (script) => run.some((step) => step.script === script);
  if (e2eArgs.length > 0 && !runs(E2E))
    notes.push(`-- ${e2eArgs.join(' ')} is for ${E2E}, which is not running.`);
  if (platform && !runs(BUILD)) notes.push(`--platform=${platform} is for ${BUILD}, which is not running.`);
  if (runs(BUILD) && !platform && options.arch === 'arm64') {
    notes.push(
      'Building for this host, arm64, where most clusters take amd64: this proves the build, not the image that\n' +
        '  would ship. --platform=linux/amd64 builds that one (emulated, slow).',
    );
  }
  return { run, skipped, notes, unknown, known: known.map(([, s]) => s) };
}

/** The variables the container steps get (see "IMAGES AND PLATFORMS" above). `engine` is the detected one. Pure. */
export function containerEnv({ image, platform }, env, engine) {
  return {
    ...(image ? { CI_IMAGE: image } : {}),
    ...(platform ? { CI_PLATFORM: platform } : {}),
    ...(env.CONTAINER_ENGINE || engine ? { CONTAINER_ENGINE: env.CONTAINER_ENGINE || engine } : {}),
  };
}

const found = (command) => spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;

function main() {
  const options = { ...parseArgs(process.argv.slice(2)), arch: process.arch };
  const pkg = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  const scripts = pkg.scripts ?? {};
  // A project on npm or yarn keeps the kit's tooling in a package of its own, with its own lockfile
  // (`factoryKit.package`, scripts/setup/adopt.mjs); the project's own install is its own step.
  const install = [
    'install',
    '--frozen-lockfile',
    ...(pkg.factoryKit?.package ? ['--dir', pkg.factoryKit.package] : []),
  ];

  if (options.help) {
    console.log(`Usage: pnpm ci:local [--no-container] [--only=<a,b,…>] [--image=<tag>] [--platform=<p>] [-- <e2e args>]

  --no-container   Skip the steps that need podman or docker.
  --only=<a,b,…>   Run only these package.json scripts from the list below, without the install.
  --image=<tag>    Skip ${BUILD} and hand the container steps CI_IMAGE=<tag>: test a prebuilt image.
  --platform=<p>   Hand ${BUILD} CI_PLATFORM=<p>, e.g. linux/amd64 (emulated elsewhere, slow).
  -- <args>        Appended to ${E2E}, e.g. -- --shard=2/6.

  CONTAINER_ENGINE is passed to the container steps: as set, else podman if present, else docker.

Steps, in order (a missing package.json script is skipped):
${stepsFor(scripts)
  .map(
    ([title, script, c]) =>
      `  ${(script ?? `pnpm ${install.join(' ')}`).padEnd(22)} ${title}${c ? ' (container)' : ''}`,
  )
  .join('\n')}`);
    return 0;
  }

  const { run, skipped, notes, unknown, known } = plan(scripts, options);
  if (unknown.length > 0) {
    console.error(`Not a ci:local step: ${unknown.join(', ')}. Known: ${known.join(', ')}.`);
    return 2;
  }
  for (const note of notes) console.log(`\x1b[33m! ${note}\x1b[0m`);

  let engine;
  for (const { title, script, container, args } of run) {
    let env = process.env;
    if (container) {
      engine ??= process.env.CONTAINER_ENGINE || ['podman', 'docker'].find(found) || '';
      env = { ...process.env, ...containerEnv(options, process.env, engine) };
    }
    const command = script ? ['run', script, ...args] : install;
    console.log(`\n\x1b[1m▸ ${title}\x1b[0m`);
    const result = spawnSync('pnpm', command, { cwd: repo, stdio: 'inherit', env });
    if (result.error || result.status !== 0) {
      console.error(`\n\x1b[31m✖ ${title} failed${result.error ? `: ${result.error.message}` : ''}\x1b[0m`);
      return 1;
    }
  }

  console.log('\n\x1b[32m✓ every step that exists passed\x1b[0m');
  // Said out loud, because a green run that silently skipped half the pipeline is the misleading kind.
  for (const s of skipped) console.log(`  skipped: ${s}`);
  return 0;
}

// Imported by its selftest (scripts/ci-selftest.mjs), run by `pnpm ci:local` and scripts/ci.mjs.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(main());

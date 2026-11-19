#!/usr/bin/env node
// `pnpm run ci`: runs the gates where the developer chose. (`pnpm run ci`, not `pnpm ci`: pnpm keeps `ci` as
// a command of its own and fails with ERR_PNPM_CI_NOT_IMPLEMENTED.)
//
//   CI_MODE=local    pnpm ci:local on this machine. The default, so a fresh clone behaves as before.
//   CI_MODE=remote   pnpm ci:remote: every job on GitHub runners (scripts/ci-remote.mjs).
//   CI_MODE=split    the remote run, plus the fast steps here at the same time, against the same snapshot.
//                    A local failure cancels the remote run, so lint and type errors come back in seconds.
//
// The setting is personal: `.mise.local.toml` (git-ignored) in the repository root, `[env] CI_MODE = "split"`,
// or `CI_MODE=remote pnpm run ci` for one run. Never `.env`, which is the application's configuration.
// `remote` and `split` fall back to `local`, with a warning, when GitHub cannot be used.
//
// Upstreamed from Makers Market (#334), where the variable is HUB_CI.
// Node builtins only, like everything else in scripts/.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remote, repo } from './ci-remote.mjs';

// Which ci:local steps split mode runs here; a project without one of these scripts skips it. On Makers
// Market these four took about 16 s locally and the same on a runner, and they fail most often, so they are
// the fail-fast half. The tests, coverage and anything with a container stay remote. The remote run repeats
// these too, because a push trigger takes no inputs; that is a minute of runner time, not of anybody's
// waiting. Measure your own before moving a step across.
export const SPLIT_LOCAL = ['lint', 'typecheck', 'build', 'audit:prod'];

const MODES = ['local', 'remote', 'split'];

function source() {
  if (process.env.CI_MODE === undefined) return 'default';
  try {
    const local = readFileSync(join(repo, '.mise.local.toml'), 'utf8');
    if (new RegExp(`^\\s*CI_MODE\\s*=\\s*["']${process.env.CI_MODE}["']`, 'm').test(local)) {
      return 'CI_MODE from .mise.local.toml';
    }
  } catch {
    // no .mise.local.toml
  }
  return 'CI_MODE from the environment';
}

const pnpm = spawnSync('pnpm', ['--version']).status === 0 ? ['pnpm'] : ['mise', 'exec', '--', 'pnpm'];
const passthrough = process.argv.slice(2);

function local(cwd = repo, extra = []) {
  const result = spawnSync('node', ['scripts/ci-local.mjs', ...extra, ...passthrough], {
    cwd,
    stdio: 'inherit',
  });
  return result.status ?? 1;
}

/** The fast steps, in a throwaway worktree of the snapshot, so later edits cannot change what is tested. */
function splitLocal({ sha }) {
  const dir = mkdtempSync(join(tmpdir(), 'hub-ci-split-'));
  try {
    if (
      spawnSync('git', ['worktree', 'add', '--detach', '--quiet', dir, sha], { cwd: repo, stdio: 'inherit' })
        .status !== 0
    ) {
      console.error('  Could not make a worktree of the snapshot; leaving the checks to the remote run.');
      return true;
    }
    console.log(`\x1b[1m▸ local: ${SPLIT_LOCAL.join(', ')} (worktree of ${sha.slice(0, 10)})\x1b[0m`);
    const install = spawnSync(
      pnpm[0],
      [...pnpm.slice(1), 'install', '--frozen-lockfile', '--prefer-offline', '--silent'],
      {
        cwd: dir,
        stdio: 'inherit',
      },
    );
    if (install.status !== 0) return false;
    return (
      spawnSync('node', ['scripts/ci-local.mjs', `--only=${SPLIT_LOCAL.join(',')}`], {
        cwd: dir,
        stdio: 'inherit',
      }).status === 0
    );
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: repo, stdio: 'ignore' });
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

let mode = process.env.CI_MODE ?? 'local';
if (!MODES.includes(mode)) {
  console.error(`CI_MODE=${mode} is not a mode. Use one of: ${MODES.join(', ')}.`);
  process.exit(2);
}
console.log(`\x1b[1mmode ${mode}\x1b[0m (${source()})`);
if (mode !== 'local' && passthrough.length > 0) {
  console.log(`\x1b[33m! ${passthrough.join(' ')} applies to ci:local only; running locally.\x1b[0m`);
  mode = 'local';
}

let code;
if (mode === 'local') {
  code = local();
} else {
  code = await remote(mode === 'split' ? { beforeWait: splitLocal } : {});
  if (code === 3) {
    console.log('\x1b[33m! Falling back to mode local.\x1b[0m');
    code = local();
  }
}
process.exit(code);

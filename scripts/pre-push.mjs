#!/usr/bin/env node
// The pre-push gates, all of them (#41). lefthook.yml runs this through one script entry,
// `.lefthook/pre-push/gates.sh`, and has no pre-push `commands:`: lefthook 2.1 skips a pre-push command
// whenever HEAD's tree matches its push target, whatever the push carries, so a push of another branch from
// an up-to-date checkout ran no gate at all. lefthook does not skip a script (docs/DECISIONS.md, "Number
// leases").
//
//   node scripts/pre-push.mjs            the gates, on git's pre-push input (stdin), or on HEAD without it
//   node scripts/pre-push.mjs selftest   real pushes in scratch repositories, the gates replaced by stubs
//
// What runs, per push:
//
// - **The lease check, always**, on exactly the refs being pushed: `lease.mjs check` refuses a new record of
//   a leased kind (an ADR) whose number is not leased on origin to the branch. It is here and not in
//   `pnpm check` because it reads origin, and `pnpm check` runs offline and in CI, where the branch is a
//   snapshot or a merge ref.
// - **The secret scan, on every pushed branch and tag**: `check-secrets.mjs --objects` reads every blob the
//   push sends that the remote lacks, so a secret committed and then removed is still caught (#34). It
//   reads git's objects, not the working tree, so it covers a branch that is not checked out as well.
// - **`pnpm check` and the board's state machine, when HEAD is a branch being pushed.** The whole of
//   `pnpm check`, not only what the pre-commit hook covers: that one sees staged files, which a
//   `--no-verify` or a rebase walks straight past. The board's selftest guards what cannot be tested against
//   the live board: the token can only post as the bot, so "a human replied" is unreachable there. Both run
//   on the working tree, so modified tracked files are included, and the hook says so.
// - **A refusal, when a pushed branch's commit is not HEAD.** The gates check the working tree, which is not
//   that commit, so passing it would pass it on the strength of another tree. Check it out and push from
//   there. A delete carries nothing to check, and a tag names a commit the release tooling tags once it is
//   on a branch: both get the lease check only.
// - **Nothing, when git pushes nothing** (`Everything up-to-date`): it still runs the hook, with no input.
//
// Under the pre-commit framework (`pnpm kit:adopt` hands its pre-push stage to `lefthook run pre-push`),
// pre-commit reads git's input itself and passes none on. It runs its hooks once, for the first pushed ref
// carrying commits the remote lacks, and names that ref in `PRE_COMMIT_LOCAL_BRANCH`,
// `PRE_COMMIT_REMOTE_BRANCH` and `PRE_COMMIT_TO_REF`, from which the input line is rebuilt.
//
// Node builtins and `git` only — scripts/ runs before `pnpm install`.
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const HERE = dirname(SCRIPT);
const ZERO = '0'.repeat(40);

/**
 * The input line pre-commit read and did not pass on, rebuilt from the environment it sets: '' when it set
 * none. Only the local ref, its sha and the remote ref are read downstream; the remote's sha is not among
 * what pre-commit exposes, so it is written as zeros.
 */
function fromPreCommit(env, revParse) {
  const local = env.PRE_COMMIT_LOCAL_BRANCH;
  const remote = env.PRE_COMMIT_REMOTE_BRANCH;
  if (!local || !remote) return '';
  // A push whose whole history is new (a root commit) carries no from-ref, and so no to-ref either.
  return `${local} ${env.PRE_COMMIT_TO_REF || revParse(local)} ${remote} ${ZERO}\n`;
}

/**
 * Which gates a push needs, from git's pre-push input (`<local ref> <sha> <remote ref> <remote sha>` per
 * line) and HEAD's sha: `check` when HEAD is a branch being pushed or there is no input (a run by hand), and
 * the branch updates whose commit is not HEAD, which are refused.
 */
function gatesFor(input, head) {
  const lines = input
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return { check: true, elsewhere: [], sent: [] };
  let check = false;
  const elsewhere = [];
  const sent = [];
  for (const line of lines) {
    const [local, sha, remote] = line.split(/\s+/);
    if (/^0+$/.test(sha)) continue;
    if (!sent.includes(sha)) sent.push(sha);
    if (!remote?.startsWith('refs/heads/')) continue;
    if (sha === head) check = true;
    else elsewhere.push({ branch: remote.slice('refs/heads/'.length), local, sha });
  }
  return { check, elsewhere, sent };
}

/** The refusal of a branch update whose commit is not the one checked out. */
function refusal({ branch, local, sha }) {
  const name = local.startsWith('refs/heads/') ? local.slice('refs/heads/'.length) : sha.slice(0, 12);
  return `✗ pre-push: ${branch} is not the checked-out commit, and pnpm check checks the checked-out tree. Check it out and push from there: git checkout ${name}, then git push.`;
}

const DIRTY =
  'pre-push: tracked files have uncommitted changes; pnpm check runs on the working tree with them included.';

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr ?? '').trim()}`);
  return r.stdout.trim();
}

/** Runs one gate with the hook's output; says whether it passed. */
function gate(cwd, cmd, args, input) {
  const r = spawnSync(cmd, args, {
    cwd,
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'],
  });
  if (r.error) console.error(`✗ pre-push: ${cmd} ${args.join(' ')}: ${r.error.message}`);
  return r.status === 0;
}

function runGates() {
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']);
  const stdin = process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
  const input = stdin.trim() || fromPreCommit(process.env, (ref) => git(root, ['rev-parse', ref]));
  // git names the remote in the hook's arguments, which gates.sh passes on. With them and no input, git is
  // pushing nothing (`Everything up-to-date`), and there is nothing to check; without them, a run by hand.
  if (process.argv.length > 2 && !input) return true;
  const { check, elsewhere, sent } = gatesFor(input, git(root, ['rev-parse', 'HEAD']));

  const leased = gate(root, process.execPath, [join(HERE, 'lease.mjs'), 'check'], input);
  // git passes the remote's name first; pre-commit names it in its environment.
  const remote = process.argv[2] ?? process.env.PRE_COMMIT_REMOTE_NAME;
  const clean =
    sent.length === 0 ||
    gate(root, process.execPath, [
      join(HERE, 'check-secrets.mjs'),
      '--objects',
      ...sent,
      ...(remote ? ['--remote', remote] : []),
    ]);
  if (elsewhere.length) {
    for (const e of elsewhere) console.error(refusal(e));
    return false;
  }
  if (!check) return leased && clean;
  if (git(root, ['status', '--porcelain', '--untracked-files=no'])) console.log(DIRTY);
  // Both run, whatever the first says, so one push shows every failure.
  const checked = [
    gate(root, 'pnpm', ['run', 'check']),
    gate(root, process.execPath, [join(HERE, 'work-items.mjs'), 'selftest']),
  ];
  return leased && clean && checked.every(Boolean);
}

// ---- selftest -------------------------------------------------------------------------------------------

const KIT = resolve(HERE, '..');
const GATES = join(KIT, '.lefthook/pre-push/gates.sh');

/** The `pre-push:` block of lefthook.yml: from its key to the next top-level key. */
const prePushBlock = (text) => /^pre-push:\s*\n((?:[ \t#].*\n|\s*\n)*)/m.exec(text)?.[1] ?? null;

async function runSelftest() {
  const cases = [];
  const ok = (name, cond) => cases.push([name, Boolean(cond)]);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Pure parts.
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  ok(
    'gatesFor: HEAD pushed checks, a tag and a delete add nothing, another branch is refused',
    same(
      gatesFor(
        `refs/heads/x ${A} refs/heads/x ${ZERO}\nrefs/tags/v1 ${B} refs/tags/v1 ${ZERO}\n(delete) ${ZERO} refs/heads/old ${B}\nrefs/heads/y ${B} refs/heads/y ${ZERO}\n`,
        A,
      ),
      { check: true, elsewhere: [{ branch: 'y', local: 'refs/heads/y', sha: B }], sent: [A, B] },
    ),
  );
  ok('gatesFor: no input checks HEAD', same(gatesFor('\n', A), { check: true, elsewhere: [], sent: [] }));
  ok(
    'gatesFor: a tag and a delete alone check nothing, and the tag is scanned',
    same(gatesFor(`refs/tags/v1 ${A} refs/tags/v1 ${ZERO}\n(delete) ${ZERO} refs/heads/old ${A}\n`, A), {
      check: false,
      elsewhere: [],
      sent: [A],
    }),
  );
  ok(
    'refusal: names the branch and the way out, by sha when the local ref is not a branch',
    refusal({ branch: 'y', local: B, sha: B }) ===
      '✗ pre-push: y is not the checked-out commit, and pnpm check checks the checked-out tree. Check it out and push from there: git checkout bbbbbbbbbbbb, then git push.',
  );
  const rev = (ref) => (ref === 'refs/heads/o' ? B : null);
  ok(
    'fromPreCommit: the to-ref when there is one, the local ref resolved when not, nothing outside pre-commit',
    same(
      [
        fromPreCommit(
          { PRE_COMMIT_LOCAL_BRANCH: 'HEAD', PRE_COMMIT_REMOTE_BRANCH: 'refs/heads/x', PRE_COMMIT_TO_REF: A },
          rev,
        ),
        fromPreCommit(
          { PRE_COMMIT_LOCAL_BRANCH: 'refs/heads/o', PRE_COMMIT_REMOTE_BRANCH: 'refs/heads/o' },
          rev,
        ),
        fromPreCommit({}, rev),
      ],
      [`HEAD ${A} refs/heads/x ${ZERO}\n`, `refs/heads/o ${B} refs/heads/o ${ZERO}\n`, ''],
    ),
  );

  // lefthook skips a pre-push command, never a script: a command added back is a gate that can vanish.
  const block = prePushBlock(readFileSync(join(KIT, 'lefthook.yml'), 'utf8'));
  ok(
    "lefthook.yml's pre-push is the one gates.sh script, with no commands",
    block !== null && !/^\s+commands:/m.test(block) && /^\s+"?gates\.sh"?:/m.test(block),
  );
  // lefthook makes a script executable before it runs it: committed without the bit, every push leaves a
  // modified file behind, and pre-commit refuses the push for it.
  ok('gates.sh is executable', process.platform === 'win32' || (statSync(GATES).mode & 0o111) !== 0);

  // The kit's package: the root's on pnpm, `factoryKit.package` beside an npm or yarn root.
  const pkg = JSON.parse(readFileSync(join(KIT, 'package.json'), 'utf8'));
  const lefthook = join(KIT, pkg.factoryKit?.package ?? '', 'node_modules/.bin/lefthook');
  const there = existsSync(lefthook);
  ok(`lefthook is installed at ${lefthook}`, there);
  if (there) await pushes(ok, same, lefthook);

  const failed = cases.filter(([, cond]) => !cond);
  for (const [name] of failed) console.error(`✗ selftest: ${name}`);
  if (failed.length === 0) console.log(`✓ pre-push selftest: ${cases.length} case(s)`);
  return failed.length === 0;
}

/**
 * Real pushes to a local bare remote through the real lefthook.yml, gates.sh and this script: under
 * lefthook's own hook, under a Husky-style `core.hooksPath` handover and, when it is installed, under
 * pre-commit. The gates are stubs that append to one log, so they cannot recurse into the `pnpm check`
 * running this, and each case asserts the whole log.
 */
async function pushes(ok, same, lefthook) {
  // A dynamic import: in the scratch clone, lease.mjs is a stub.
  const { sandboxEnv } = await import('./lease.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'pre-push-selftest-'));
  try {
    const log = join(dir, 'gates.log');
    const stubs = join(dir, 'bin');
    mkdirSync(stubs);
    const stub = (name, body) => writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    stub('mise', '[ "$1" = exec ] && shift\n[ "$1" = -- ] && shift\nexec "$@"');
    stub('pnpm', `if [ "$1" = exec ]; then shift; exec "$@"; fi\necho "pnpm $*" >> '${log}'`);
    // No inherited GIT_* (sandboxEnv), and no LEFTHOOK=0 or PRE_COMMIT_* from a hook this runs under.
    const base = Object.fromEntries(
      Object.entries(sandboxEnv(dir, 'dev')).filter(([k]) => !/^(LEFTHOOK|PRE_COMMIT)/.test(k)),
    );
    const env = {
      ...base,
      PATH: [stubs, dirname(lefthook), dirname(process.execPath), base.PATH].join(':'),
      PRE_COMMIT_HOME: join(dir, 'pre-commit-home'),
    };
    const sh = (cwd, cmd, args) => {
      const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
      return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
    };
    const g = (cwd, ...args) => {
      const r = sh(cwd, 'git', args);
      if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.out}`);
      return r.out.trim();
    };

    const bare = join(dir, 'origin.git');
    const work = join(dir, 'work');
    g(dir, 'init', '--quiet', '--bare', '--initial-branch=main', bare);
    g(dir, 'init', '--quiet', '--initial-branch=main', work);
    g(work, 'remote', 'add', 'origin', bare);
    const put = (rel, text, mode = 0o644) => {
      mkdirSync(dirname(join(work, rel)), { recursive: true });
      writeFileSync(join(work, rel), text);
      chmodSync(join(work, rel), mode);
    };
    put('lefthook.yml', readFileSync(join(KIT, 'lefthook.yml'), 'utf8'));
    put('.lefthook/pre-push/gates.sh', readFileSync(GATES, 'utf8'), 0o755);
    put('scripts/pre-push.mjs', readFileSync(SCRIPT, 'utf8'));
    const logger = (name) =>
      `import { appendFileSync, readFileSync } from 'node:fs';\nconst input = process.stdin.isTTY ? '' : readFileSync(0, 'utf8').trim();\nappendFileSync(${JSON.stringify(log)}, ['${name}', ...process.argv.slice(2), ...(input ? [input.split('\\n').join(' | ')] : [])].join(' ') + '\\n');\n`;
    put('scripts/lease.mjs', logger('lease'));
    put('scripts/work-items.mjs', logger('items'));
    put('scripts/check-secrets.mjs', logger('secrets'));
    put('a', 'a\n');
    // Every commit skips the hooks: lefthook.yml's pre-commit and commit-msg are not under test.
    const commit = (msg, ...args) => {
      g(work, 'add', '--all');
      g(work, 'commit', '--quiet', '--no-verify', ...args, '-m', msg);
      return g(work, 'rev-parse', 'HEAD');
    };
    const main = commit('init');
    g(work, 'push', '--quiet', '--no-verify', 'origin', 'main');
    g(work, 'branch', '--quiet', '--set-upstream-to=origin/main', 'main');
    ok('lefthook install in the scratch clone', sh(work, lefthook, ['install']).code === 0);

    const onRemote = (branch) => g(work, 'ls-remote', bare, `refs/heads/${branch}`).split('\t')[0];
    /** A push with the log emptied first: its exit code, its output and the log's lines. */
    const push = (...args) => {
      writeFileSync(log, '');
      const r = sh(work, 'git', ['push', 'origin', ...args]);
      return { ...r, log: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
    };
    const lease = (local, sha, remote, was = ZERO) => `lease check ${local} ${sha} ${remote} ${was}`;
    const branch = (b) => `refs/heads/${b}`;
    const secrets = (sha) => `secrets --objects ${sha} --remote origin`;
    const every = (b, sha, was) => [
      lease(branch(b), sha, branch(b), was),
      secrets(sha),
      'pnpm run check',
      'items selftest',
    ];
    /** A push of HEAD's branch `b`: every gate ran, exactly once, on its commit, and the push landed. */
    const fromHead = (name, b, was = ZERO, extra = () => true) => {
      const sha = g(work, 'rev-parse', 'HEAD');
      const r = push(b);
      ok(name, r.code === 0 && same(r.log, every(b, sha, was)) && onRemote(b) === sha && extra(r));
      return sha;
    };
    /** A push of `b` from another checkout: the lease check on it, the refusal, and nothing landed. */
    const elsewhere = (name, b, was = ZERO) => {
      const sha = g(work, 'rev-parse', b);
      const r = push(b);
      ok(
        name,
        r.code !== 0 &&
          same(r.log, [lease(branch(b), sha, branch(b), was), secrets(sha)]) &&
          r.out.includes(refusal({ branch: b, local: branch(b), sha })) &&
          onRemote(b) === '',
      );
    };
    const side = (b, file) => {
      g(work, 'checkout', '--quiet', '-b', b);
      put(file, `${file}\n`);
      return commit(file);
    };

    side('feat/x', 'b');
    let was = fromHead('HEAD with a new commit runs every gate on it', 'feat/x');
    commit('empty', '--allow-empty');
    was = fromHead('HEAD ahead by an empty commit runs every gate on it', 'feat/x', was);
    put('c', 'c\n');
    commit('c');
    put('a', 'changed\n');
    was = fromHead(
      'HEAD with modified tracked files runs every gate, and says the changes were included',
      'feat/x',
      was,
      (r) => r.out.includes(DIRTY),
    );
    g(work, 'checkout', '--quiet', '--', 'a');

    // The report (#41): another branch pushed from an up-to-date main.
    g(work, 'checkout', '--quiet', 'main');
    side('feat/y', 'd');
    g(work, 'checkout', '--quiet', 'main');
    elsewhere('another branch pushed from an up-to-date main: the lease check, then the refusal', 'feat/y');
    let r = push(':feat/x');
    ok(
      'a delete runs the lease check only',
      r.code === 0 &&
        same(r.log, [lease('(delete)', ZERO, branch('feat/x'), was)]) &&
        onRemote('feat/x') === '',
    );
    r = push('main');
    ok('a push with nothing to push runs no gate', r.code === 0 && same(r.log, []));
    g(work, 'tag', 'v1');
    r = push('v1');
    ok(
      'a tag runs the lease check and the secret scan only',
      r.code === 0 && same(r.log, [lease('refs/tags/v1', main, 'refs/tags/v1'), secrets(main)]),
    );

    // The handovers are what `pnpm kit:adopt` writes (hookGates), for a pnpm root, into a target that has
    // only the manager's own starting point.
    const { hookGates } = await import('./setup/adopt.mjs');
    const handover = (manager, starter) => {
      const target = join(dir, manager);
      mkdirSync(join(target, '.husky'), { recursive: true });
      writeFileSync(join(target, '.pre-commit-config.yaml'), starter);
      const writes = new Map();
      const record = (f, data) => Boolean(writes.set(f, data));
      const out = { executable: new Set(), merge: [], conflict: [], write: record, add: record };
      hookGates(target, manager, { hooks: ['pre-push'], lefthook: 'pnpm exec lefthook' }, out);
      return [...writes.values()][0];
    };

    // Husky: core.hooksPath, then `lefthook run`. The hooks directory is outside the clone, so every
    // checkout has it.
    const husky = join(dir, 'husky');
    mkdirSync(husky);
    writeFileSync(join(husky, 'pre-push'), handover('Husky', ''), { mode: 0o755 });
    g(work, 'config', 'core.hooksPath', husky);
    side('feat/husky', 'e');
    fromHead('under Husky, HEAD with a new commit runs every gate on it', 'feat/husky');
    g(work, 'checkout', '--quiet', 'main');
    elsewhere('under Husky, another branch pushed: the lease check, then the refusal', 'feat/y');
    g(work, 'config', '--unset', 'core.hooksPath');

    // pre-commit, when it is here to try it with.
    if (sh(work, 'pre-commit', ['--version']).code !== 0) {
      console.log('  pre-push selftest: pre-commit is not installed, so its route was not run');
      return;
    }
    g(work, 'checkout', '--quiet', 'feat/husky');
    put('.pre-commit-config.yaml', handover('pre-commit', 'repos:\n  - repo: local\n    hooks: []\n'));
    g(work, 'checkout', '--quiet', '-b', 'feat/pc');
    commit('pre-commit');
    ok('pre-commit install', sh(work, 'pre-commit', ['install', '--overwrite']).code === 0);
    fromHead('under pre-commit, HEAD with a new commit runs every gate on it', 'feat/pc');
    side('feat/pc2', 'g');
    g(work, 'checkout', '--quiet', 'feat/pc');
    elsewhere('under pre-commit, another branch pushed: the lease check on it, then the refusal', 'feat/pc2');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- main -----------------------------------------------------------------------------------------------

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    if (process.argv[2] === 'selftest') process.exit((await runSelftest()) ? 0 : 1);
    process.exit(runGates() ? 0 : 1);
  } catch (e) {
    console.error(`✗ pre-push: ${e.message}`);
    process.exit(1);
  }
}

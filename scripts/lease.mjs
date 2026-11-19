#!/usr/bin/env node
// Number leases: claim the next number of a sequentially numbered record (an ADR) on `origin` before the
// file is written, so two branches cannot both take it (#29, docs/adr/0005-number-leases-as-git-refs.md).
//
//   pnpm lease <kind>     lease the next free number for the current branch, and print it
//   pnpm lease --list     every live lease: kind, number, branch, claimant, since when
//   pnpm lease --prune    delete the leases whose number is now on the remote's default branch
//   node scripts/lease.mjs check      the pre-push check (lefthook.yml)
//   node scripts/lease.mjs selftest   offline, against local bare repositories
//
// A lease is a parentless commit with an empty tree, pushed to `refs/leases/<kind>/<NNNN>` with the
// developer's own git credentials. Its message is JSON: kind, number, branch, claimant and time. The push
// is create-only: a commit with no parent is never a fast-forward of another, so a push to a ref that
// already exists is rejected, and a push to one that does not sends "old value: none", which the server
// checks under its ref lock. Whichever of two racing claims arrives second is refused and moves on to the
// next number. `refs/leases/*` is outside every default refspec, so clones stay clean.
//
// The next free number is one above the highest file in the kind's directory on every remote branch and
// the highest live lease. Kinds are configured in package.json, `factoryKit.numbered`; only a kind with
// `"leased": true` can be leased and is checked at push. A kind without it (a Drizzle migration, whose
// number the generator picks) is under check-docs's duplicate guard only.
//
// Every push and delete here passes `--no-verify`: the pre-push hook runs the whole of `pnpm check`, which a
// ref carrying no tree has no use for. A delete is refused unless its ref is under `refs/leases/`.
//
// Node builtins and `git` only — scripts/ runs before `pnpm install`.
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_KINDS, numberedKinds, readKinds } from './check-docs.mjs';

const REMOTE = 'origin';
const PREFIX = 'refs/leases/';
// Every leased kind is four digits wide, as the ADRs and Drizzle's migrations are.
const WIDTH = 4;
const MAX_ATTEMPTS = 50;

/** The record's number, or null when the file name is not one of the kind's. */
function numberOf(kind, name) {
  const m = kind.pattern.exec(name);
  return m ? Number(m[1]) : null;
}

const pad = (n) => String(n).padStart(WIDTH, '0');
const leaseRef = (kind, n) => `${PREFIX}${kind}/${pad(n)}`;

/** One above everything taken. Gaps below the maximum are never filled: a gap is legal, a reuse is not. */
const nextFree = (numbers) => Math.max(-1, ...numbers) + 1;

/**
 * `git ls-remote --symref <remote> HEAD 'refs/heads/*' 'refs/leases/*'` → the default branch, the branches
 * (name → sha) and the leases.
 */
function parseRemote(text) {
  const leases = new Map();
  const branches = new Map();
  for (const line of text.split('\n')) {
    const m = /^([0-9a-f]{40,64})\t(refs\/leases\/([a-z][a-z0-9-]*)\/(\d+))$/.exec(line.trim());
    if (m) leases.set(`${m[3]}/${Number(m[4])}`, { sha: m[1], ref: m[2], kind: m[3], number: Number(m[4]) });
    const b = /^([0-9a-f]{40,64})\trefs\/heads\/(\S+)$/.exec(line.trim());
    if (b) branches.set(b[2], b[1]);
  }
  const main = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(text);
  return { main: main ? main[1] : null, branches, leases };
}

/**
 * git's pre-push input, one `<local ref> <local sha> <remote ref> <remote sha>` line per ref pushed, → the
 * branch updates to check, as `{ branch, sha }`: the remote branch's name and the commit it will hold.
 * Deletes and refs outside `refs/heads/` (tags) carry no new record and are left out. null when there is no
 * input at all, which is a run by hand.
 */
function parsePushes(text) {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;
  const updates = [];
  for (const line of lines) {
    const [, sha, remoteRef] = line.split(/\s+/);
    if (!/^[0-9a-f]{40,64}$/.test(sha ?? '') || /^0+$/.test(sha)) continue;
    if (!remoteRef?.startsWith('refs/heads/')) continue;
    updates.push({ branch: remoteRef.slice('refs/heads/'.length), sha });
  }
  return updates;
}

/**
 * `pnpm ci:remote`'s snapshot branches (scripts/ci-remote.mjs). They are pushed with `--no-verify`, so a
 * record on one has not been through the check and does not count as landed.
 */
const SNAPSHOT = /^ci\//;

/** The refspec that deletes a lease. The prefix check is the whole of the safety on a remote delete. */
function deleteRefspec(ref) {
  if (!ref.startsWith(PREFIX) || ref.includes('..') || /\s/.test(ref)) {
    throw new Error(`refusing to delete ${ref}: only refs under ${PREFIX} are deleted`);
  }
  return `:${ref}`;
}

/**
 * The pre-push rule (#29, review round 1): a numbered file of a leased kind that is not already on another
 * remote branch must be leased to the branch being pushed. `landed` holds the paths found on the remote's
 * default branch and on every branch the remote has other than this one and the `ci/` snapshots;
 * `heldBy(branch, path)` says whether the
 * lease holder's local branch has the same file, which is how a branch merged from the holder inherits it.
 */
function findProblems({ branch, files, landed, leases, heldBy }) {
  const problems = [];
  for (const { kind, path, number } of files) {
    if (landed.has(path)) continue;
    const lease = leases.get(`${kind}/${number}`);
    const fix = `run \`pnpm lease ${kind}\``;
    if (!lease) {
      problems.push(
        `${path}: ${kind} ${pad(number)} is not leased to ${branch} — ${fix} and, if it gives another number, rename the file to it`,
      );
    } else if (lease.branch !== branch && !heldBy(lease.branch, path)) {
      problems.push(
        `${path}: ${kind} ${pad(number)} is leased to ${lease.branch} (${lease.claimant}) — ${fix} and rename the file to the number it gives`,
      );
    }
  }
  return problems;
}

// ---- git ------------------------------------------------------------------------------------------------

function git(cwd, args, { input, env } = {}) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}

function must(cwd, args, opts) {
  const r = git(cwd, args, opts);
  if (!r.ok) throw new Error(`git ${args.join(' ')} failed: ${r.err || r.out}`);
  return r.out;
}

/** The repository being worked in: its root, its kinds and its current branch. */
function context(cwd) {
  const root = must(cwd, ['rev-parse', '--show-toplevel']);
  const head = git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return { root, kinds: readKinds(root), branch: head.ok ? head.out : null };
}

function fetchBranches(root) {
  must(root, ['fetch', '--quiet', '--no-tags', REMOTE, `+refs/heads/*:refs/remotes/${REMOTE}/*`]);
}

/**
 * The remote's default branch, its branches and its live leases, in one round trip. The branches come from
 * the remote itself, not from the remote-tracking refs, which keep a branch the host has since deleted.
 */
function remoteState(root) {
  return parseRemote(must(root, ['ls-remote', '--symref', REMOTE, 'HEAD', 'refs/heads/*', `${PREFIX}*`]));
}

/**
 * The records the kit itself ships, as adoption copies them in (scripts/setup/adopt.mjs): a path that
 * `factoryKit.manifest` in package.json at `commit` lists, while the file there still has the manifest's
 * hash. It carries the kit's own number, which no lease on the project's origin holds.
 */
function kitRecords(root, commit) {
  let manifest = {};
  try {
    manifest =
      JSON.parse(must(root, ['cat-file', 'blob', `${commit}:package.json`])).factoryKit?.manifest ?? {};
  } catch {}
  return (path) => {
    if (typeof manifest[path] !== 'string') return false;
    const blob = spawnSync('git', ['cat-file', 'blob', `${commit}:${path}`], {
      cwd: root,
      maxBuffer: 64 * 1024 * 1024,
    });
    return (
      blob.status === 0 &&
      manifest[path] === `sha256:${createHash('sha256').update(blob.stdout).digest('hex')}`
    );
  };
}

/**
 * The kind's numbered files in each of `treeishes`, as one list per treeish of `{ kind, path, number }`.
 * Most branches share one directory tree, so the trees are resolved in a single `cat-file` call and each
 * distinct one is listed once.
 */
function filesIn(root, treeishes, kindName, kind) {
  const ids = must(root, ['cat-file', '--batch-check=%(objectname) %(objecttype)'], {
    input: `${treeishes.map((t) => `${t}:${kind.dir}`).join('\n')}\n`,
  }).split('\n');
  const listed = new Map();
  return ids.map((line) => {
    const [id, type] = line.split(' ');
    if (type !== 'tree') return [];
    if (!listed.has(id)) {
      const names = must(root, ['ls-tree', '--name-only', id]).split('\n');
      listed.set(
        id,
        names
          .map((name) => ({ kind: kindName, path: `${kind.dir}/${name}`, number: numberOf(kind, name) }))
          .filter((f) => f.number !== null),
      );
    }
    return listed.get(id);
  });
}

/** Read the claim each lease commit carries (fetching the commits first) into the lease objects. */
function readClaims(root, leases) {
  if (leases.length === 0) return;
  must(root, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', REMOTE, ...leases.map((l) => l.ref)]);
  const subjects = must(root, ['show', '--no-patch', '--format=%H %s', ...leases.map((l) => l.sha)]);
  const bySha = new Map(subjects.split('\n').map((line) => [line.slice(0, line.indexOf(' ')), line]));
  for (const lease of leases) {
    let claim = {};
    try {
      claim = JSON.parse(bySha.get(lease.sha).slice(lease.sha.length + 1));
    } catch {}
    lease.branch = claim.branch ?? '?';
    lease.claimant = claim.claimant ?? '?';
    lease.at = claim.at ?? '?';
  }
}

// ---- commands -------------------------------------------------------------------------------------------

/** Lease the next free number of `kindName` for the current branch. Returns the number. */
function claim(cwd, kindName, log = console.log) {
  const { root, kinds, branch } = context(cwd);
  const kind = kinds[kindName];
  if (!kind) throw new Error(`no numbered kind "${kindName}" (configured: ${Object.keys(kinds).join(', ')})`);
  if (!kind.leased) {
    throw new Error(
      `${kindName} is not a leased kind: its number is the generator's, and check-docs guards duplicates`,
    );
  }
  if (!branch) throw new Error('HEAD is detached: check out the branch the record will be written on');

  let state = remoteState(root);
  fetchBranches(root);
  try {
    for (const ref of prune(root, kinds, state)) log(`pruned ${ref}`);
  } catch (e) {
    log(`(prune skipped: ${e.message})`);
  }
  const onBranches = filesIn(root, [...state.branches.values()], kindName, kind).flatMap((files) =>
    files.map((f) => f.number),
  );
  const identity = must(root, ['var', 'GIT_AUTHOR_IDENT']).replace(/\s+\d+\s+[+-]\d{4}$/, '');
  const tree = must(root, ['mktree'], { input: '' });

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const leased = [...state.leases.values()].filter((l) => l.kind === kindName).map((l) => l.number);
    const n = nextFree([...onBranches, ...leased]);
    const ref = leaseRef(kindName, n);
    const message = JSON.stringify({
      kind: kindName,
      number: pad(n),
      branch,
      claimant: identity,
      at: new Date().toISOString(),
    });
    const commit = must(root, ['commit-tree', '--no-gpg-sign', tree, '-m', message]);
    const pushed = git(root, ['push', '--porcelain', '--no-verify', '--quiet', REMOTE, `${commit}:${ref}`]);
    if (pushed.ok) {
      log(`leased ${kindName} ${pad(n)} for ${branch} (${ref})`);
      return n;
    }
    // Refused. Only a ref that now exists means somebody else won; anything else (the host refusing the
    // namespace, a hook, credentials) would make every next number fail the same way.
    state = remoteState(root);
    if (!state.leases.has(`${kindName}/${n}`)) {
      throw new Error(
        `the push of ${ref} was refused and the ref does not exist: ${pushed.err || pushed.out}`,
      );
    }
    log(`${kindName} ${pad(n)} was taken meanwhile; trying the next number`);
  }
  throw new Error(`no free ${kindName} number after ${MAX_ATTEMPTS} attempts`);
}

/**
 * Delete the leases whose number is on the remote's default branch, as last fetched. Returns the refs
 * deleted.
 */
function prune(root, kinds, { main, leases }) {
  if (!main) throw new Error(`${REMOTE} has no default branch yet`);
  const landed = new Set();
  for (const [name, kind] of Object.entries(kinds)) {
    for (const f of filesIn(root, [`refs/remotes/${REMOTE}/${main}`], name, kind)[0]) {
      landed.add(`${name}/${f.number}`);
    }
  }
  const doomed = [...leases.values()].filter((l) => landed.has(`${l.kind}/${l.number}`)).map((l) => l.ref);
  if (doomed.length === 0) return [];
  must(root, ['push', '--porcelain', '--no-verify', '--quiet', REMOTE, ...doomed.map(deleteRefspec)]);
  return doomed;
}

/**
 * The pre-push check of every branch `pushed` (git's pre-push input) updates, or of HEAD's branch when there
 * is no input, as in a run by hand. Returns the problems found; an empty list passes.
 */
function check(cwd, { pushed = '', log = console.log } = {}) {
  const { root, kinds, branch } = context(cwd);
  const leasedKinds = Object.entries(kinds).filter(([, k]) => k.leased);
  if (leasedKinds.length === 0) return [];
  let updates = parsePushes(pushed);
  if (updates === null) {
    if (!branch) {
      log('lease check: HEAD is detached, nothing to check');
      return [];
    }
    updates = [{ branch, sha: must(root, ['rev-parse', 'HEAD']) }];
  }
  if (updates.length === 0) return [];
  if (!git(root, ['remote', 'get-url', REMOTE]).ok) {
    log(`lease check: no remote "${REMOTE}", nothing to check against`);
    return [];
  }
  const filesAt = (treeishes) =>
    leasedKinds.flatMap(([name, kind]) => filesIn(root, treeishes, name, kind).flat());
  const pushes = updates.map((u) => ({ ...u, files: filesAt([u.sha]) }));
  // Offline fast path: a record already on the default branch as last fetched stays there, so a push whose
  // records all are needs no round trip. That is nearly every push.
  const knownMain = git(root, ['symbolic-ref', '--quiet', `refs/remotes/${REMOTE}/HEAD`]);
  if (knownMain.ok) {
    const onMain = new Set(filesAt([knownMain.out]).map((f) => f.path));
    if (pushes.every((p) => p.files.every((f) => onMain.has(f.path)))) return [];
  }

  const { main, branches, leases } = remoteState(root);
  if (branches.size === 0) {
    log(`lease check: ${REMOTE} has no branches yet, nothing to collide with`);
    return [];
  }
  fetchBranches(root);
  const heldBy = (holder, path) => git(root, ['cat-file', '-e', `refs/heads/${holder}:${path}`]).ok;
  const problems = [];
  for (const p of pushes) {
    // Landed: on the default branch, or on another branch the remote has now, which went through this
    // check when it was pushed. A snapshot branch did not.
    const others = [...branches]
      .filter(([name]) => name === main || (name !== p.branch && !SNAPSHOT.test(name)))
      .map(([, sha]) => sha);
    const landed = new Set(filesAt(others).map((f) => f.path));
    const isKit = kitRecords(root, p.sha);
    const pending = p.files.filter((f) => !landed.has(f.path) && !isKit(f.path));
    if (pending.length === 0) continue;
    readClaims(
      root,
      pending.map((f) => leases.get(`${f.kind}/${f.number}`)).filter((l) => l && l.branch === undefined),
    );
    problems.push(...findProblems({ branch: p.branch, files: pending, landed, leases, heldBy }));
  }
  return problems;
}

function printList(cwd) {
  const { root } = context(cwd);
  const leases = [...remoteState(root).leases.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.number - b.number,
  );
  if (leases.length === 0) {
    console.log(`no live leases on ${REMOTE}`);
    return;
  }
  readClaims(root, leases);
  for (const l of leases) console.log(`${l.kind}\t${pad(l.number)}\t${l.branch}\t${l.claimant}\t${l.at}`);
}

// ---- selftest -------------------------------------------------------------------------------------------

const SCRIPT = fileURLToPath(import.meta.url);

/**
 * git with no user or system configuration and no inherited `GIT_*` variables. Under a git hook (this
 * selftest runs inside `pnpm check`, which the pre-push hook runs) git exports `GIT_DIR`, and a `git init`
 * that inherits it re-initialises the developer's own repository; scripts/board/migrate.mjs's `gitEnv`
 * records the time it did.
 */
export function sandboxEnv(dir, who) {
  const empty = join(dir, 'gitconfig');
  if (!existsSync(empty)) writeFileSync(empty, '');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
  return {
    ...env,
    GIT_CONFIG_GLOBAL: empty,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: who,
    GIT_AUTHOR_EMAIL: `${who}@example.invalid`,
    GIT_COMMITTER_NAME: who,
    GIT_COMMITTER_EMAIL: `${who}@example.invalid`,
  };
}

/** Run this script with `input` as its stdin, which is closed after it either way, as git's is. */
function run(cwd, env, args, input = '') {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [SCRIPT, ...args], { cwd, env }, (e, out, err) =>
      resolve({ code: e ? e.code : 0, out, err }),
    );
    child.stdin.end(input);
  });
}

async function runSelftest() {
  const cases = [];
  const ok = (name, cond) => cases.push([name, Boolean(cond)]);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  // Pure parts.
  const kinds = numberedKinds({
    factoryKit: {
      numbered: { adr: DEFAULT_KINDS.adr, migration: { dir: 'apps/api/drizzle/', pattern: '^(\\d{4})_' } },
    },
  });
  ok('a kind is leased only when it says so', kinds.adr.leased && !kinds.migration.leased);
  ok('a trailing slash is dropped from dir', kinds.migration.dir === 'apps/api/drizzle');
  let refused = '';
  try {
    numberedKinds({ factoryKit: { numbered: { adr: { dir: 'd', pattern: 'p', width: 3 } } } });
  } catch (e) {
    refused = e.message;
  }
  ok('an unknown key is refused', refused === 'factoryKit.numbered.adr: unknown key width');
  ok('no configuration means the ADRs', same(Object.keys(numberedKinds({})), ['adr']));
  ok('nextFree is one above the maximum', nextFree([0, 1, 4, 2]) === 5);
  ok('nextFree does not fill a gap', nextFree([0, 7]) === 8);
  ok('nextFree of nothing is 0', nextFree([]) === 0);
  ok('a lease ref is padded', leaseRef('adr', 7) === 'refs/leases/adr/0007');
  ok('a lease delete is a delete', deleteRefspec('refs/leases/adr/0007') === ':refs/leases/adr/0007');
  for (const bad of ['refs/heads/main', 'refs/tags/v1', 'refs/leases/../heads/main', 'leases/adr/0007']) {
    let threw = false;
    try {
      deleteRefspec(bad);
    } catch {
      threw = true;
    }
    ok(`a delete of ${bad} is refused`, threw);
  }
  const sha = 'a'.repeat(40);
  const parsed = parseRemote(
    `ref: refs/heads/trunk\tHEAD\n${sha}\tHEAD\n${sha}\trefs/heads/trunk\n${sha}\trefs/heads/ci/x/1\n${sha}\trefs/leases/adr/0005\n${sha}\trefs/leases/x/12\n`,
  );
  ok(
    'ls-remote output parses to exactly its default branch, branches and leases',
    parsed.main === 'trunk' &&
      same([...parsed.branches.keys()], ['trunk', 'ci/x/1']) &&
      same([...parsed.leases.keys()], ['adr/5', 'x/12']),
  );

  const files = [
    { kind: 'adr', path: 'docs/adr/0003-landed.md', number: 3 },
    { kind: 'adr', path: 'docs/adr/0007-mine.md', number: 7 },
    { kind: 'adr', path: 'docs/adr/0008-unleased.md', number: 8 },
    { kind: 'adr', path: 'docs/adr/0009-theirs.md', number: 9 },
    { kind: 'adr', path: 'docs/adr/0010-inherited.md', number: 10 },
  ];
  const leases = new Map([
    ['adr/7', { branch: 'feat/a', claimant: 'A' }],
    ['adr/9', { branch: 'feat/b', claimant: 'B <b@x>' }],
    ['adr/10', { branch: 'feat/c', claimant: 'C' }],
  ]);
  const problems = findProblems({
    branch: 'feat/a',
    files,
    landed: new Set(['docs/adr/0003-landed.md']),
    leases,
    heldBy: (b, p) => b === 'feat/c' && p === 'docs/adr/0010-inherited.md',
  });
  ok(
    'the check refuses exactly the unleased and the foreign file',
    same(problems, [
      'docs/adr/0008-unleased.md: adr 0008 is not leased to feat/a — run `pnpm lease adr` and, if it gives another number, rename the file to it',
      'docs/adr/0009-theirs.md: adr 0009 is leased to feat/b (B <b@x>) — run `pnpm lease adr` and rename the file to the number it gives',
    ]),
  );

  // Against local bare repositories: the race, the host refusing the namespace, the check, the prune.
  const dir = mkdtempSync(join(tmpdir(), 'lease-selftest-'));
  try {
    const env = sandboxEnv(dir, 'seed');
    const g = (cwd, args) => must(cwd, args, { env });
    const bare = join(dir, 'origin.git');
    const leasesOnBare = () => parseRemote(g(dir, ['ls-remote', bare, `${PREFIX}*`])).leases;
    g(dir, ['init', '--quiet', '--bare', '--initial-branch=main', bare]);
    const seed = join(dir, 'seed');
    g(dir, ['clone', '--quiet', bare, seed]);
    const write = (repo, path) => {
      mkdirSync(join(repo, path, '..'), { recursive: true });
      writeFileSync(join(repo, path), `# ${path}\n`);
      g(repo, ['add', path]);
      g(repo, ['commit', '--quiet', '-m', `add ${path}`]);
    };
    g(seed, ['checkout', '--quiet', '-b', 'main']);
    for (const n of ['0000', '0001', '0002', '0003']) write(seed, `docs/adr/${n}-seed.md`);
    g(seed, ['push', '--quiet', 'origin', 'main']);
    g(seed, ['checkout', '--quiet', '-b', 'feat/elsewhere']);
    write(seed, 'docs/adr/0004-on-another-branch.md');
    g(seed, ['push', '--quiet', 'origin', 'feat/elsewhere']);

    const clone = (who) => {
      const path = join(dir, who);
      g(dir, ['clone', '--quiet', bare, path]);
      g(path, ['checkout', '--quiet', '-b', `feat/${who}`]);
      return { path, env: sandboxEnv(dir, who) };
    };
    const a = clone('a');
    const b = clone('b');
    const lane = async (c) => {
      const got = [];
      for (let i = 0; i < 5; i += 1) {
        const r = await run(c.path, c.env, ['adr']);
        const m = /leased adr (\d{4}) /.exec(r.out);
        got.push(r.code === 0 && m ? m[1] : `failed: ${r.err}`);
      }
      return got;
    };
    const [gotA, gotB] = await Promise.all([lane(a), lane(b)]);
    const expected = Array.from({ length: 10 }, (_, i) => pad(i + 5));
    ok('two racing claimants get exactly 0005–0014, each once', same([...gotA, ...gotB].sort(), expected));
    const live = leasesOnBare();
    ok(
      'the remote holds exactly those 10 leases',
      same([...live.values()].map((l) => pad(l.number)).sort(), expected),
    );
    const holder = (n) =>
      JSON.parse(g(bare, ['log', '-1', '--format=%s', live.get(`adr/${Number(n)}`).sha])).branch;
    ok(
      'each lease names the branch that claimed it',
      gotA.every((n) => holder(n) === 'feat/a') && gotB.every((n) => holder(n) === 'feat/b'),
    );

    // The pre-push check, end to end, with the exact message.
    let r = await run(a.path, a.env, ['check']);
    ok('a branch with no new record passes the check', r.code === 0 && r.err === '');
    write(a.path, `docs/adr/${gotA[0]}-leased.md`);
    r = await run(a.path, a.env, ['check']);
    ok('a file leased to this branch passes the check', r.code === 0);
    write(a.path, 'docs/adr/0099-unleased.md');
    r = await run(a.path, a.env, ['check']);
    ok(
      'an unleased new ADR fails with exactly the lease message',
      r.code === 1 &&
        r.err ===
          '✗ docs/adr/0099-unleased.md: adr 0099 is not leased to feat/a — run `pnpm lease adr` and, if it gives another number, rename the file to it\n',
    );

    // Prune: a number that has reached the default branch frees its lease, and only that one.
    g(seed, ['checkout', '--quiet', 'main']);
    write(seed, `docs/adr/${gotB[0]}-landed.md`);
    g(seed, ['push', '--quiet', 'origin', 'main']);
    r = await run(a.path, a.env, ['--prune']);
    ok(
      'prune deletes exactly the lease whose number landed',
      r.code === 0 &&
        same(
          [...leasesOnBare().values()].map((l) => pad(l.number)).sort(),
          expected.filter((n) => n !== gotB[0]),
        ),
    );

    const notLeased = (path, br) =>
      `✗ ${path}: adr ${path.slice(9, 13)} is not leased to ${br} — run \`pnpm lease adr\` and, if it gives another number, rename the file to it\n`;
    const UNLEASED = 'docs/adr/0099-unleased.md';

    // The refs being pushed are checked, not HEAD's branch. feat/a carries the unleased 0099.
    const ZERO = '0'.repeat(40);
    const tip = g(a.path, ['rev-parse', 'HEAD']);
    g(a.path, ['fetch', '--quiet', 'origin']);
    g(a.path, ['branch', 'feat/other', tip]);
    g(a.path, ['checkout', '--quiet', '-b', 'feat/clean', 'origin/main']);
    r = await run(a.path, a.env, ['check'], `refs/heads/feat/other ${tip} refs/heads/feat/other ${ZERO}\n`);
    ok(
      'a push of another branch than HEAD checks that branch, under its name',
      r.code === 1 && r.err === notLeased(UNLEASED, 'feat/other'),
    );
    r = await run(a.path, a.env, ['check'], `HEAD ${tip} refs/heads/feat/renamed ${ZERO}\n`);
    ok(
      'HEAD pushed to another name is checked under the remote name',
      r.code === 1 && r.err === notLeased(UNLEASED, 'feat/renamed'),
    );
    g(a.path, ['checkout', '--quiet', 'feat/a']);
    r = await run(
      a.path,
      a.env,
      ['check'],
      `(delete) ${ZERO} refs/heads/old ${tip}\nrefs/tags/v1 ${tip} refs/tags/v1 ${ZERO}\n`,
    );
    ok('a delete and a tag push pass from a HEAD carrying an unleased record', r.code === 0 && r.err === '');

    // Landed means on a branch the remote has now and that went through the check: not a ci/ snapshot,
    // which ci-remote pushes with --no-verify, and not a remote-tracking ref the host has since deleted.
    const snapshot = `refs/heads/ci/a/${tip.slice(0, 12)}`;
    g(a.path, ['push', '--quiet', '--no-verify', 'origin', `feat/a:${snapshot}`]);
    r = await run(a.path, a.env, ['check']);
    ok(
      'a record only on a ci/ snapshot branch is still refused',
      r.code === 1 && r.err === notLeased(UNLEASED, 'feat/a'),
    );
    g(bare, ['update-ref', '-d', snapshot]);
    g(a.path, ['push', '--quiet', '--no-verify', 'origin', 'feat/a:refs/heads/feat/gone']);
    g(a.path, ['fetch', '--quiet', 'origin']);
    g(bare, ['update-ref', '-d', 'refs/heads/feat/gone']);
    r = await run(a.path, a.env, ['check']);
    ok(
      'a record only on a stale remote-tracking ref is still refused',
      git(a.path, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/feat/gone'], { env }).ok &&
        r.code === 1 &&
        r.err === notLeased(UNLEASED, 'feat/a'),
    );

    // The kit's own records, as adoption copies them in and lists them in factoryKit.manifest, carry the
    // kit's numbers and need no lease while their hash matches.
    g(a.path, ['checkout', '--quiet', '-b', 'chore/adopt', 'origin/main']);
    const hash = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;
    const KIT = 'docs/adr/0042-kit-record.md';
    const EDITED = 'docs/adr/0043-edited-kit-record.md';
    writeFileSync(join(a.path, KIT), '# kit\n');
    writeFileSync(join(a.path, EDITED), '# edited\n');
    writeFileSync(
      join(a.path, 'package.json'),
      `${JSON.stringify({ factoryKit: { manifest: { [KIT]: hash('# kit\n'), [EDITED]: hash('# kit\n') } } })}\n`,
    );
    g(a.path, ['add', KIT, EDITED, 'package.json']);
    g(a.path, ['commit', '--quiet', '-m', 'adopt the kit']);
    r = await run(a.path, a.env, ['check']);
    ok(
      'a kit record matching its manifest hash passes, and an edited one does not',
      r.code === 1 && r.err === notLeased(EDITED, 'chore/adopt'),
    );

    // A host that refuses the namespace must stop the claim, not walk up through every number.
    const hook = join(bare, 'hooks', 'pre-receive');
    writeFileSync(hook, '#!/bin/sh\necho "refs/leases is not allowed here" >&2\nexit 1\n', { mode: 0o755 });
    r = await run(b.path, b.env, ['adr']);
    ok(
      'a refused namespace stops the claim at the first number',
      r.code === 1 &&
        /the push of refs\/leases\/adr\/0015 was refused and the ref does not exist/.test(r.err),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const failed = cases.filter(([, cond]) => !cond);
  for (const [name] of failed) console.error(`✗ selftest: ${name}`);
  if (failed.length === 0) console.log(`✓ lease selftest: ${cases.length} case(s)`);
  return failed.length === 0;
}

// ---- main -----------------------------------------------------------------------------------------------

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [arg] = process.argv.slice(2);
  try {
    if (arg === 'selftest') {
      process.exit((await runSelftest()) ? 0 : 1);
    } else if (arg === 'check') {
      // git hands the hook the refs being pushed on stdin, and lefthook passes it on (`use_stdin`). A
      // terminal is a run by hand, which checks HEAD's branch.
      const problems = check(process.cwd(), { pushed: process.stdin.isTTY ? '' : readFileSync(0, 'utf8') });
      for (const p of problems) console.error(`✗ ${p}`);
      process.exit(problems.length ? 1 : 0);
    } else if (arg === '--list') {
      printList(process.cwd());
    } else if (arg === '--prune') {
      const { root, kinds } = context(process.cwd());
      fetchBranches(root);
      const deleted = prune(root, kinds, remoteState(root));
      console.log(deleted.length ? deleted.map((r) => `pruned ${r}`).join('\n') : 'nothing to prune');
    } else if (arg && !arg.startsWith('-')) {
      claim(process.cwd(), arg);
    } else {
      console.error(
        'usage: pnpm lease <kind> | --list | --prune   (node scripts/lease.mjs check | selftest)',
      );
      process.exit(2);
    }
  } catch (e) {
    console.error(`✗ lease: ${e.message}`);
    process.exit(1);
  }
}

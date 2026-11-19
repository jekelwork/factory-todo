#!/usr/bin/env node
// The secret gate. Node builtins and `git` only, so it works before `pnpm install`.
//
//   node scripts/check-secrets.mjs --staged                       the index: what the next commit records
//   node scripts/check-secrets.mjs --objects <rev>… [--remote r]  every blob a push of <rev> sends to r
//   node scripts/check-secrets.mjs <file>…                        files on disk
//   node scripts/check-secrets.mjs --selftest                     offline, in scratch repositories
//
// It reads what leaves, not the disk (#34). The pre-commit hook scans the staged blobs: a file staged
// and then deleted on disk is still committed. The pre-push hook and `pnpm ci:remote` scan every new object
// in the commits being pushed: a secret committed and then deleted in a later commit, or only in the working
// tree, still travels with the history. "New" is measured against the tips the remote advertises
// (`git ls-remote`), the same set `git push` negotiates against.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const PATTERNS = [
  [/-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/, 'private key'],
  [/AKIA[0-9A-Z]{16}/, 'AWS access key id'],
  [/ghp_[A-Za-z0-9]{36}/, 'GitHub personal token'],
  [/gho_[A-Za-z0-9]{36}/, 'GitHub OAuth token'],
  [/ghs_[A-Za-z0-9]{36}/, 'GitHub App installation token'],
  [/glpat-[A-Za-z0-9_-]{20,}/, 'GitLab personal or project token'],
  [/github_pat_[A-Za-z0-9_]{60,}/, 'GitHub fine-grained token'],
  [/xox[baprs]-[0-9A-Za-z-]{10,}/, 'Slack token'],
  [/https:\/\/hooks\.slack\.com\/(services|workflows|triggers)\/[A-Za-z0-9/_-]{20,}/, 'Slack webhook URL'],
  [/sk-ant-[A-Za-z0-9_-]{20,}/, 'Anthropic API key'],
  [/sk-[A-Za-z0-9]{32,}/, 'OpenAI-style API key'],
  [/eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, 'JWT'],
  [/(client_secret|CLIENT_SECRET)\s*[=:]\s*['"]?[A-Za-z0-9~._-]{20,}/, 'client secret assignment'],
  [/AccountKey=[A-Za-z0-9+/=]{60,}/, 'Azure storage account key'],
];

// A database URL with a password in it. The repository may document one, so what it is allowed to hold is a
// placeholder: `CHANGE_ME`, a value that says it is `not-a-secret`, or a reference to where the real one
// comes from (`$VAR`, `<password>`, `process.env…`). A local development database's throwaway password is
// none of those, and carries the `secret-scan:ignore` marker on its line.
//
// A project with credentials of its own adds them here the same way — a pattern, a label, and a validator
// that lets placeholders through — and, if the product scans uploads, keeps this list in step with that
// scanner. A token format with a checksum is worth verifying, not just matching by shape: documentation that
// shows a made-up token-shaped string is then not refused, and a real one is.
const isPlaceholder = (value) =>
  /^change_me$/i.test(value) || value.includes('not-a-secret') || /^(\$|<|process\.env\b)/.test(value);
PATTERNS.push([
  /postgres(?:ql)?:\/\/[^:@\s/]{1,256}:([^@\s/]{1,256})@/,
  'database URL with password',
  ([, password]) => !isPlaceholder(password),
]);

// Files that document the format and must hold token-shaped strings.
const EXEMPT = /(^|\/)(\.env\.example|\.env\.gitlab\.example|\.env\.github\.example|check-secrets\.mjs)$/;

/**
 * Every finding in one file's bytes, `[{ line, label }]`: none for an exempt path or a binary file. Every
 * size: a secret in a large file is as leaked as one in a small file. Pure.
 */
export function findings(path, buf) {
  if (EXEMPT.test(path) || buf.includes(0)) return [];
  const text = buf.toString('utf8');
  const found = [];
  for (const [re, label, valid] of PATTERNS) {
    // Every match, not the first: a fixture marked `secret-scan:ignore` early in a file must not hide a
    // real key further down it.
    for (const m of text.matchAll(new RegExp(re.source, 'g'))) {
      if (valid && !valid(m)) continue;
      const before = text.slice(0, m.index);
      const lineText = text.slice(before.lastIndexOf('\n') + 1).split('\n')[0] ?? '';
      // Deliberate fixtures (tests, docs) opt out per line with this marker.
      if (lineText.includes('secret-scan:ignore')) continue;
      found.push({ line: before.split('\n').length, label });
    }
  }
  return found;
}

function git({ cwd = process.cwd(), env = process.env }, args, input) {
  const r = spawnSync('git', args, { cwd, env, input, maxBuffer: 1 << 30 });
  return { ok: r.status === 0, out: r.stdout ?? Buffer.alloc(0), err: String(r.stderr ?? '').trim() };
}
const lines = (buf) => buf.toString('utf8').split('\n').filter(Boolean);

/** The contents of `oids`, by oid, through one `git cat-file --batch`. */
function readBlobs(where, oids) {
  const blobs = new Map();
  if (oids.length === 0) return blobs;
  const r = git(where, ['cat-file', '--batch'], `${oids.join('\n')}\n`);
  if (!r.ok) throw new Error(`git cat-file --batch: ${r.err}`);
  // `<oid> <type> <size>\n<content>\n`, once per object.
  let at = 0;
  while (at < r.out.length) {
    const eol = r.out.indexOf(10, at);
    const [oid, , size] = r.out.subarray(at, eol).toString().split(' ');
    blobs.set(oid, r.out.subarray(eol + 1, eol + 1 + Number(size)));
    at = eol + 1 + Number(size) + 1;
  }
  return blobs;
}

/** `[{ path, oid, line, label }]` over `{ path, oid }` blobs. */
function scanBlobs(where, entries) {
  const blobs = readBlobs(where, [...new Set(entries.map((e) => e.oid))]);
  return entries.flatMap(({ path, oid }) => findings(path, blobs.get(oid)).map((f) => ({ path, oid, ...f })));
}

/** What the next commit records: every added, copied, modified or renamed path in the index. */
export function scanStaged(where = {}) {
  const staged = git(where, ['diff', '--cached', '--raw', '-z', '--no-abbrev', '--diff-filter=ACMR']);
  if (!staged.ok) throw new Error(`git diff --cached: ${staged.err}`);
  // `:<old mode> <new mode> <old oid> <new oid> <status>\0<path>\0` (a copy or rename adds its source path
  // first); a gitlink (mode 160000) is a commit, not content.
  const fields = staged.out.toString('utf8').split('\0');
  const entries = [];
  for (let i = 0; i < fields.length - 1; ) {
    const [, mode, , oid, status] = fields[i].split(' ');
    i += /^[CR]/.test(status) ? 2 : 1;
    if (mode !== '160000') entries.push({ path: fields[i], oid });
    i++;
  }
  return scanBlobs(where, entries);
}

/**
 * What the remote already has: the branch and tag tips it advertises that exist here. Without a remote's
 * name (a hook handed none), its stand-in is every remote-tracking ref. An unreachable remote is an error:
 * the push could not go through either.
 */
export function remoteTips(where, remote) {
  let tips;
  if (remote) {
    const advertised = git(where, ['ls-remote', remote, 'refs/heads/*', 'refs/tags/*']);
    if (!advertised.ok) throw new Error(`git ls-remote ${remote}: ${advertised.err}`);
    tips = lines(advertised.out).map((l) => l.split('\t')[0]);
  } else tips = lines(git(where, ['for-each-ref', '--format=%(objectname)', 'refs/remotes']).out);
  if (tips.length === 0) return [];
  const present = git(where, ['cat-file', '--batch-check'], `${[...new Set(tips)].join('\n')}\n`);
  return lines(present.out)
    .filter((l) => !l.endsWith(' missing'))
    .map((l) => l.split(' ')[0]);
}

/** Every blob that a push of `revs` sends and the remote lacks, under the path git reached it by. */
export function scanObjects(revs, { remote, ...where } = {}) {
  const tips = remoteTips(where, remote);
  const listed = git(
    where,
    ['rev-list', '--objects', '--filter=object:type=blob', '--stdin'],
    `${[...revs, ...tips.map((t) => `^${t}`)].join('\n')}\n`,
  );
  if (!listed.ok) throw new Error(`git rev-list --objects: ${listed.err}`);
  // `<oid>` for a commit, `<oid> <path>` for a blob.
  const entries = lines(listed.out)
    .filter((l) => l.includes(' '))
    .map((l) => ({ oid: l.slice(0, l.indexOf(' ')), path: l.slice(l.indexOf(' ') + 1) }));
  return scanBlobs(where, entries);
}

/** Files on disk, as named; anything that is not a regular file is skipped. */
export function scanFiles(files) {
  return files
    .filter((f) => {
      try {
        return statSync(f).isFile();
      } catch {
        return false;
      }
    })
    .flatMap((path) => findings(path, readFileSync(path)).map((f) => ({ path, ...f })));
}

const REFUSE_COMMIT = 'Refusing to commit. Move the value to .env (git-ignored) or a Secret manifest.';
const refusePush = (oid) =>
  `Refusing to push: the commits being pushed carry it, even where a later commit or the working tree removed it.
Rewrite the commit that added it (git log --all --find-object=${oid} names it), and rotate the key: an earlier
push may already have sent it.`;

function main(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { staged: { type: 'boolean' }, objects: { type: 'boolean' }, remote: { type: 'string' } },
  });
  const found = values.staged
    ? scanStaged()
    : values.objects
      ? scanObjects(positionals, { remote: values.remote })
      : scanFiles(positionals);
  for (const f of found) {
    console.error(
      `✖ ${f.path}${f.oid ? ` (blob ${f.oid.slice(0, 10)})` : ''}:${f.line}: looks like a ${f.label}`,
    );
  }
  if (found.length) console.error(`\n${values.objects ? refusePush(found[0].oid) : REFUSE_COMMIT}`);
  return found.length ? 1 : 0;
}

// ---- selftest -------------------------------------------------------------------------------------------

/**
 * Scratch repositories with a local bare remote, the cases from #34. Tokens are built at run time, so no
 * literal sits in this file, and each case asserts the exact list of paths found.
 */
async function selftest() {
  const { sandboxEnv } = await import('./lease.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'check-secrets-selftest-'));
  let failed = 0;
  const check = (name, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) console.log(`✓ secrets: ${name}`);
    else {
      failed++;
      console.error(`✗ secrets: ${name}:\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
    }
  };
  const env = sandboxEnv(dir, 'dev');
  const token = (c) => `gh${'p'}_${c.repeat(36)}`;
  try {
    const bare = join(dir, 'origin.git');
    const work = join(dir, 'work');
    const sh = (cwd, args, input) => {
      const r = spawnSync('git', args, { cwd, env, input, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
      return r.stdout.trim();
    };
    sh(dir, ['init', '--quiet', '--bare', '--initial-branch=main', bare]);
    sh(dir, ['init', '--quiet', '--initial-branch=main', work]);
    sh(work, ['remote', 'add', 'origin', bare]);
    const put = (rel, text) => writeFileSync(join(work, rel), text);
    const commit = (msg) => {
      sh(work, ['add', '--all']);
      sh(work, ['commit', '--quiet', '--no-verify', '--allow-empty', '-m', msg]);
      return sh(work, ['rev-parse', 'HEAD']);
    };
    const fresh = (b) => sh(work, ['checkout', '--quiet', '-B', b, 'main']);
    // The cases scan from the clone, with no GIT_* inherited from a hook this may run under.
    const paths = (found) => found.map((f) => f.path);
    const outgoing = () => paths(scanObjects(['HEAD'], { remote: 'origin', cwd: work, env }));

    put('a', 'a\n');
    commit('init');
    sh(work, ['push', '--quiet', '--no-verify', 'origin', 'main']);

    fresh('deleted');
    put('leak.txt', `${token('A')}\n`);
    commit('leak');
    sh(work, ['rm', '--quiet', 'leak.txt']);
    commit('remove it');
    check('committed, then deleted in a later commit', outgoing(), ['leak.txt']);

    fresh('redacted');
    put('leak.txt', `${token('B')}\n`);
    commit('leak');
    put('leak.txt', 'redacted\n');
    commit('redact it');
    check('committed, then redacted in a later commit', outgoing(), ['leak.txt']);

    // ci:remote's own snapshot() and scan(), from a copy of the script in the clone, run as a child process
    // so its module-level remote and repository are the clone's.
    const scripts = join(work, 'scripts');
    sh(work, ['checkout', '--quiet', 'main']);
    mkdirSync(scripts);
    const here = fileURLToPath(new URL('.', import.meta.url));
    for (const f of ['ci-remote.mjs', 'check-secrets.mjs'])
      writeFileSync(join(scripts, f), readFileSync(join(here, f)));
    commit('the scripts');
    sh(work, ['push', '--quiet', '--no-verify', 'origin', 'main']);
    const remoteScan = () => {
      const r = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          "const m = await import('./scripts/ci-remote.mjs'); console.log(m.scan(m.snapshot().sha));",
        ],
        { cwd: work, env: { ...env, CI_REMOTE: 'origin' }, encoding: 'utf8' },
      );
      return r.stdout.trim();
    };
    fresh('worktree');
    put('leak.txt', `${token('C')}\n`);
    commit('leak');
    rmSync(join(work, 'leak.txt'));
    check('ci:remote: committed, then deleted in the working tree', remoteScan(), 'false');
    sh(work, ['checkout', '--quiet', '--', 'leak.txt']);
    fresh('clean');
    put('ok.txt', 'nothing here\n');
    commit('clean');
    check('ci:remote: a clean history', remoteScan(), 'true');

    fresh('seen');
    put('old.txt', `${token('D')}\n`);
    commit('old leak');
    sh(work, ['push', '--quiet', '--no-verify', 'origin', 'seen']);
    put('new.txt', 'clean\n');
    commit('new');
    check('a secret already on the remote is not scanned again', outgoing(), []);

    fresh('exempt');
    put('fixture.txt', `${token('E')} // secret-scan:ignore\n`);
    writeFileSync(join(work, 'blob.bin'), Buffer.concat([Buffer.from(token('F')), Buffer.from([0])]));
    put('.env.example', `TOKEN=${token('G')}\n`);
    commit('exempt');
    check('the marker, a binary and .env.example', outgoing(), []);

    fresh('two');
    put('one.txt', `${token('H')}\n`);
    commit('one');
    put('two.txt', `${token('I')}\n`);
    commit('two');
    check('two secrets in two commits', outgoing(), ['one.txt', 'two.txt']);

    fresh('staged');
    put('b.txt', `${token('J')}\n`);
    sh(work, ['add', 'b.txt']);
    rmSync(join(work, 'b.txt'));
    check('--staged: staged, then deleted on disk', paths(scanStaged({ cwd: work, env })), ['b.txt']);
    sh(work, ['reset', '--quiet']);
    rmSync(join(work, 'b.txt'), { force: true });

    fresh('renamed');
    put('r.txt', `${token('L')}\n`);
    commit('r');
    sh(work, ['mv', 'r.txt', 's.txt']);
    check('--staged: a rename is read under its new name', paths(scanStaged({ cwd: work, env })), ['s.txt']);
    commit('renamed');

    put('disk.txt', `x\n${token('K')}\n`);
    check(
      'files on disk, with the line',
      scanFiles([join(work, 'disk.txt'), join(work, 'nope')]).map((f) => [f.line, f.label]),
      [[2, 'GitHub personal token']],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(failed ? `\nSECRETS SELFTEST FAILED — ${failed} case(s)` : '\nSECRETS SELFTEST OK');
  return failed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    process.exitCode =
      process.argv[2] === '--selftest' ? ((await selftest()) ? 1 : 0) : main(process.argv.slice(2));
  } catch (e) {
    console.error(`✖ check-secrets: ${e.message}`);
    process.exitCode = 1;
  }
}

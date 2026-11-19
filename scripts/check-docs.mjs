#!/usr/bin/env node
// Guard: a document may not cite a file that does not exist, two numbered records (ADRs, and any other kind
// configured in `factoryKit.numbered`) may not share a number, SECURITY.md may not ship a placeholder, and a
// modernization's seed entry may not lose its trace.
//
// Written on Makers Market after an audit found six documents making claims the code contradicts. Most of
// that drift is prose and no script can see it — but three kinds are mechanical, and those are the ones
// that come back:
//
// 1. **A citation or a link that resolves to nothing.** Files move; the sentence pointing at them does
//    not. A reader who follows a dead path concludes the document is stale and stops trusting the parts
//    that are still true.
// 2. **Two ADRs with the same number.** This is the one that produces a wrong `master` with everything
//    green: two branches each create `0025-<their-own-title>.md`, git merges them without a conflict
//    because the filenames differ, and nothing anywhere notices. It happened while that audit was
//    being written — two merge requests both took 0025 — which is why the check exists. It covers every
//    kind `factoryKit.numbered` configures (scripts/lease.mjs), the ADRs when nothing is configured. A
//    leased kind is also checked at push; this guard is the backstop for both, and the only guard for a
//    kind whose number a generator picks, such as a Drizzle migration.
// 3. **A placeholder in a document people act on.** `SECURITY.md` publishes a disclosure route; "TBD"
//    there means a reporter finds nothing actionable and tells nobody.
//
// Deliberately out of scope: whether a cited **line number** still points at the thing it described.
// Line numbers move with every edit above them, so enforcing them would fail on unrelated changes and
// be disabled within a week — a guard nobody trusts is worse than no guard. The file has to exist; what
// it says at :143 is the reviewer's job.
//
// Two directories are skipped, for the same reason in opposite directions. `docs/archive/` holds history:
// a build diary is allowed to cite a file deleted a fortnight later, because it
// described what was true then. `docs/superpowers/` holds design documents, which name files that do not
// exist *yet* — a spec proposing `docs/RUNBOOK.md` is doing its job, not rotting.
//
// A citation is also accepted when it matches the **tail** of a real path: prose writes `routes/media.ts`
// as shorthand inside a passage that has already said which package it is about, and demanding the full path everywhere would rewrite hundreds of sentences to satisfy a script.
//
// Node builtins only — scripts/ runs before `pnpm install`.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseBatch } from './board/core.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  'coverage',
  'test-results',
  'playwright-report',
  '.work-items',
  'archive',
  'superpowers',
  // Git-ignored scratch the SDD workflow writes (briefs, reports, ledgers); its briefs cite files a later task creates.
  '.superpowers',
  // Worktrees Claude Code creates hold a whole second checkout; their docs are checked where they came from.
  'worktrees',
]);

/** Every Markdown file in the repository, minus the directories above. */
function markdownFiles(dir = repo, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      markdownFiles(join(dir, entry.name), out);
    } else if (entry.name.endsWith('.md')) {
      out.push(join(dir, entry.name));
    }
  }
  return out;
}

/**
 * Fenced blocks are examples, not claims: an import path inside one names a package, not a file here. So is
 * a region between `<!-- example -->` and `<!-- /example -->` — the kit's own documents quote another
 * project's paths as worked examples, and a project replacing them with its own removes the markers.
 */
export function stripFences(text) {
  return text.replace(/^```[\s\S]*?^```/gm, '').replace(/<!-- example -->[\s\S]*?<!-- \/example -->/g, '');
}

/** Where a modernization's seed file lives; checked by `checkSeed` below when it exists. */
export const SEED = 'docs/modernization/seed.md';

/**
 * Paths a document names on purpose although no such file exists here. Each one is a sentence that would
 * otherwise have to be reworded to satisfy a script, which is the wrong way round — so they are listed,
 * with the reason, and the list is short enough to read. A new entry is a decision, not a silencer: if
 * you are adding one because a file moved, fix the sentence instead.
 */
export const KNOWN_ABSENT = new Map([
  ['docs/adr/NNNN-title.md', 'the template pattern for a new ADR, not a file'],
  ['docs/releases/X.Y.Z.md', 'the pattern of the notes file `pnpm items release prepare` writes, not a file'],
  [
    'docs/releases/X.Y.Z.whats-new.md',
    'the pattern of the "what\'s new" file `release prepare` writes, not a file',
  ],
  [SEED, 'the seed file a modernization writes (docs/agents/modernizing.md), not a file'],
  ['whats-new-X.Y.Z.html', 'the pattern of the slides `pnpm items release deck` writes, not a file'],
  ['path/file.ts:123', 'an example citation format in a skill document'],
  ['path/file.ts', 'the same example, with its line number stripped'],
  ['CONTEXT.md', 'named as not yet written — docs/agents/domain.md says so in the same sentence'],
  ['docs/agents/triage-labels.md', 'named as deliberately absent, in a sentence explaining why'],
  ['docs/THREAT-MODEL.md', 'named in SECURITY.md as the file a project writes once it has one'],
  ['docs/factory-kit-adoption.md', 'the report `pnpm kit:adopt` writes in the adopted repository, not here'],
]);

const PATHISH = /^[\w./@-]+\.(?:ts|tsx|js|mjs|cjs|md|sql|css|json|ya?ml|html)(?::\d+(?:-\d+)?)?$/;

/**
 * The paths a document claims exist: relative Markdown links, and inline-code citations like
 * `apps/api/src/app.ts:150`. A citation without a slash (`README.md`, `package.json`) is taken as
 * repo-root-relative, which is how this repo writes them.
 */
export function citedPaths(text) {
  const body = stripFences(text);
  const found = [];
  for (const m of body.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    found.push({ raw: target, path: target.split('#')[0] });
  }
  for (const m of body.matchAll(/`([^`\n]+)`/g)) {
    const token = m[1].trim();
    if (!PATHISH.test(token)) continue;
    found.push({ raw: token, path: token.split(':')[0] });
  }
  return found.filter((f) => f.path.length > 0);
}

/** Every file in the repository, for the suffix match below. Built once. */
let allFiles = null;
function repoFiles(dir = repo, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      repoFiles(join(dir, entry.name), out);
    } else {
      out.push(relative(repo, join(dir, entry.name)));
    }
  }
  return out;
}

/**
 * Resolved against the document's own directory, then the repository root, then as the tail of a real
 * path — `routes/media.ts` is how this repo cites a file in a passage that has already said where it is.
 */
export function resolvesWith(files, fromDir, p) {
  if (p.startsWith('/')) return files.includes(p.slice(1));
  const direct = [resolve(fromDir, p), resolve(repo, p)];
  if (direct.some((c) => existsSync(c))) return true;
  return files.some((f) => f === p || f.endsWith(`/${p}`));
}

function resolves(fromFile, p) {
  allFiles ??= repoFiles();
  return resolvesWith(allFiles, dirname(fromFile), p);
}

/**
 * The project-owned documents the board skills read as true, and into which `start-project` writes its cited
 * proposals (docs/agents/surveying-a-codebase.md). Their citations are checked even under `lint: "kit"`: a
 * made-up path in project.md's irreversible failures is believed by every agent that reads it.
 */
export const PROJECT_DOCS = ['AGENTS.md', 'docs/agents/project.md', 'SECURITY.md'];

/**
 * The Markdown files this repository checks. A project that adopted the kit with its own linter, or that is
 * not JavaScript, sets `factoryKit.lint` to `"kit"` (`scripts/setup/adopt.mjs`): its own documentation's drift
 * is then its own business, and only the kit's documents, the ones `factoryKit.manifest` lists, are checked,
 * with `PROJECT_DOCS`. Otherwise the first `pnpm lint` after adopting fails on whatever the project's docs
 * already cited wrongly.
 *
 * Neither scope reads the documents under a `factoryKit.protected` directory: the legacy system during a
 * modernization (docs/agents/modernizing.md §1), whose README may cite what it likes and which the guard
 * forbids editing to please this check. Its files still count as real, so a citation *of* them resolves.
 */
export function scopedMarkdown(files, pkg) {
  const rel = (f) => relative(repo, f).split('\\').join('/');
  const dirs = protectedDirs(pkg);
  const open = files.filter((f) => !dirs.some((d) => rel(f).startsWith(`${d}/`)));
  if (pkg?.factoryKit?.lint !== 'kit') return open;
  const kit = new Set([...Object.keys(pkg.factoryKit.manifest ?? {}), ...PROJECT_DOCS]);
  return open.filter((f) => kit.has(rel(f)));
}

/** `factoryKit.protected`: directories relative to the root, validated; none when it is not set. */
export function protectedDirs(pkg) {
  const raw = pkg?.factoryKit?.protected ?? [];
  if (!Array.isArray(raw)) throw new Error('factoryKit.protected: a list of directories');
  return raw.map((d) => {
    const dir = typeof d === 'string' ? d.replace(/\/+$/, '') : '';
    if (!dir || dir.startsWith('/') || dir.split('/').includes('..')) {
      throw new Error(`factoryKit.protected: "${d}" is not a directory inside the repository`);
    }
    return dir;
  });
}

function readPackage() {
  try {
    return JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function checkCitations() {
  const failures = [];
  let checked = 0;
  let skipped = 0;
  for (const file of scopedMarkdown(markdownFiles(), readPackage())) {
    const text = readFileSync(file, 'utf8');
    for (const cite of citedPaths(text)) {
      if (KNOWN_ABSENT.has(cite.path) || KNOWN_ABSENT.has(cite.raw)) {
        skipped += 1;
        continue;
      }
      checked += 1;
      if (!resolves(file, cite.path)) {
        failures.push(`${relative(repo, file)} → ${cite.raw}`);
      }
    }
  }
  return { failures, checked, skipped };
}

/** What a repository without `factoryKit.numbered` gets: the ADRs, leased (scripts/lease.mjs). */
export const DEFAULT_KINDS = { adr: { dir: 'docs/adr', pattern: '^(\\d{4})-', leased: true } };

/**
 * The numbered kinds `factoryKit.numbered` configures, validated: a directory, a filename pattern whose
 * first group is the number, and whether the kind is leased. An unknown key is refused, as in `migrate`.
 * scripts/lease.mjs reads the same configuration from here.
 */
export function numberedKinds(pkg) {
  const raw = pkg?.factoryKit?.numbered ?? DEFAULT_KINDS;
  const kinds = {};
  for (const [kind, spec] of Object.entries(raw)) {
    if (!/^[a-z][a-z0-9-]*$/.test(kind)) throw new Error(`factoryKit.numbered: "${kind}" is not a kind name`);
    const unknown = Object.keys(spec ?? {}).filter((k) => !['dir', 'pattern', 'leased'].includes(k));
    if (unknown.length) throw new Error(`factoryKit.numbered.${kind}: unknown key ${unknown.join(', ')}`);
    if (typeof spec.dir !== 'string' || typeof spec.pattern !== 'string') {
      throw new Error(`factoryKit.numbered.${kind}: needs "dir" and "pattern" strings`);
    }
    kinds[kind] = {
      dir: spec.dir.replace(/\/+$/, ''),
      pattern: new RegExp(spec.pattern),
      leased: spec.leased === true,
    };
  }
  return kinds;
}

export function readKinds(root) {
  const file = join(root, 'package.json');
  return numberedKinds(existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {});
}

/** Two records numbered the same is the failure git will not show you. */
export function duplicateNumbers(filenames, pattern) {
  const byNumber = new Map();
  for (const name of filenames) {
    const m = pattern.exec(name);
    if (!m) continue;
    const list = byNumber.get(m[1]) ?? [];
    list.push(name);
    byNumber.set(m[1], list);
  }
  return [...byNumber.entries()].filter(([, files]) => files.length > 1);
}

/** Where the analysis a seed entry traces to lives; a `Source:` anywhere else never went through its review. */
export const ANALYSIS_DIR = 'docs/modernization/';

/**
 * A modernization's seed file (docs/agents/modernizing.md §4): every entry ends with `Source: <file>#<anchor>`,
 * the file is an analysis document under `ANALYSIS_DIR`, and it has a heading carrying `{#<anchor>}` outside
 * any fence or example. Entries are found by `create --batch`'s own parser, so the count and the entries are
 * the ones the board would get, and what that parser refuses is reported too. Why: docs/DECISIONS.md,
 * "The modernization playbook".
 */
export function checkSeed(text, readDoc) {
  const { entries, errors } = parseBatch(text);
  const anchors = new Map();
  const anchorsOf = (file) => {
    if (!anchors.has(file)) {
      const body = stripFences(readDoc(file) ?? '');
      anchors.set(file, new Set([...body.matchAll(/^#{1,6} .*\{#([\w-]+)\}\s*$/gm)].map((m) => m[1])));
    }
    return anchors.get(file);
  };
  const failures = [...errors];
  for (const { key, body } of entries) {
    const source = /^Source: (\S+)#([\w-]+)\s*$/m.exec(body);
    if (!source) failures.push(`${key}: no Source: line`);
    else if (!source[1].startsWith(ANALYSIS_DIR) || source[1].split('/').includes('..')) {
      failures.push(`${key}: ${source[1]} is not an analysis document under ${ANALYSIS_DIR}`);
    } else if (!anchorsOf(source[1]).has(source[2])) {
      failures.push(`${key}: ${source[1]}#${source[2]} is not a heading`);
    }
  }
  return { entries: entries.length, failures };
}

const PLACEHOLDERS = /\b(TBD|TODO|FIXME|XXX)\b/;

function checkPlaceholders() {
  const failures = [];
  for (const name of ['SECURITY.md', 'docs/THREAT-MODEL.md']) {
    const file = join(repo, name);
    if (!existsSync(file)) continue;
    const hit = PLACEHOLDERS.exec(stripFences(readFileSync(file, 'utf8')));
    if (hit) failures.push(`${name} contains "${hit[1]}" — a document people act on says what it knows`);
  }
  return failures;
}

function runSelftest() {
  const cases = [];
  const ok = (name, cond) => cases.push([name, cond]);

  ok(
    'a fenced block is not a claim',
    stripFences('```\nimport x from "nowhere/at/all.ts"\n```\n').trim() === '',
  );
  ok(
    'a link is cited',
    citedPaths('see [the plan](docs/DEPLOY.md)').some((c) => c.path === 'docs/DEPLOY.md'),
  );
  ok(
    'an example region is not a claim',
    citedPaths('<!-- example -->\n`apps/x/y.ts`\n<!-- /example -->\n`z.md`')
      .map((c) => c.path)
      .join() === 'z.md',
  );
  ok('an http link is not', citedPaths('[x](https://example.com/a.md)').length === 0);
  ok(
    'a line number is stripped',
    citedPaths('`apps/api/src/app.ts:150`').some((c) => c.path === 'apps/api/src/app.ts'),
  );
  ok('prose in backticks is not a path', citedPaths('`pnpm check`').length === 0);
  ok(
    'a known-absent path has a reason',
    [...KNOWN_ABSENT.values()].every((r) => r.length > 10),
  );
  ok(
    'a shorthand citation resolves by tail',
    resolvesWith(['apps/api/src/routes/media.ts'], repo, 'routes/media.ts'),
  );
  ok('a made-up path does not', !resolvesWith(['apps/api/src/routes/media.ts'], repo, 'routes/nope.ts'));
  const adr = numberedKinds({}).adr.pattern;
  ok(
    'two 0025s are a duplicate',
    duplicateNumbers(['0025-a.md', '0025-b.md', '0026-c.md'], adr).length === 1,
  );
  ok('distinct numbers are not', duplicateNumbers(['0024-a.md', '0025-b.md'], adr).length === 0);
  const migration = /^(\d{4})_/;
  ok(
    'a configured migration kind finds exactly its one duplicate',
    JSON.stringify(duplicateNumbers(['0007_a.sql', '0007_b.sql', '0008_c.sql', 'meta'], migration)) ===
      JSON.stringify([['0007', ['0007_a.sql', '0007_b.sql']]]),
  );
  {
    // rk-2 exists only inside a fence, as a worked example: it is not a section an item can come from.
    const docs = {
      'docs/modernization/risks.md':
        '# Risks\n\n## Billing writes twice {#rk-1}\n\n```\n## Example {#rk-2}\n```\n',
    };
    const seed = [
      'Batch: modernize-x',
      '',
      '=== traced',
      'Labels: release-0.2.0',
      '',
      'Make billing idempotent',
      'Source: docs/modernization/risks.md#rk-1',
      '=== untraced',
      '',
      'Port the reports',
      '=== renamed',
      '',
      'Retire the cron job',
      'Source: docs/modernization/risks.md#rk-9',
      '=== fenced',
      '',
      'Copy the example',
      'Source: docs/modernization/risks.md#rk-2',
      '',
    ].join('\n');
    const got = checkSeed(seed, (f) => docs[f]);
    ok(
      'a seed file: every entry counted, only a real heading resolves',
      JSON.stringify(got) ===
        JSON.stringify({
          entries: 4,
          failures: [
            'untraced: no Source: line',
            'renamed: docs/modernization/risks.md#rk-9 is not a heading',
            'fenced: docs/modernization/risks.md#rk-2 is not a heading',
          ],
        }),
    );
    // A body line opening with '=== ' is text to `create --batch`, not a second entry.
    const notes =
      'Batch: b\n\n=== a\n\nTitle A\n=== Notes ===\nsomething\nSource: docs/modernization/risks.md#rk-1\n';
    ok(
      "a seed file's entries are the batch parser's",
      JSON.stringify(checkSeed(notes, (f) => docs[f])) === JSON.stringify({ entries: 1, failures: [] }),
    );
    const outside = [
      'Batch: b',
      '=== project',
      '',
      'Cite the project doc',
      'Source: docs/agents/project.md#rk-1',
      '=== climbs',
      '',
      'Climb out',
      'Source: docs/modernization/../agents/project.md#rk-1',
      '',
    ].join('\n');
    const anyDoc = () => '## Anything {#rk-1}\n';
    ok(
      'a seed Source: outside the analysis is refused, though its anchor exists',
      JSON.stringify(checkSeed(outside, anyDoc)) ===
        JSON.stringify({
          entries: 2,
          failures: [
            'project: docs/agents/project.md is not an analysis document under docs/modernization/',
            'climbs: docs/modernization/../agents/project.md is not an analysis document under docs/modernization/',
          ],
        }),
    );
    ok(
      'a seed file create --batch refuses is reported with its reason',
      JSON.stringify(
        checkSeed('=== Bad_Key\n\nT\nSource: docs/modernization/risks.md#rk-1\n', (f) => docs[f]),
      ) ===
        JSON.stringify({
          entries: 1,
          failures: [
            'line 1: key "Bad_Key" is not [a-z0-9-]+',
            'no "Batch: <id>" line before the first entry',
          ],
        }),
    );
  }
  {
    const files = [join(repo, 'README.md'), join(repo, 'docs/agents/domain.md')];
    const manifest = { 'docs/agents/domain.md': 'sha256:0' };
    const owned = PROJECT_DOCS.map((f) => join(repo, f));
    const all = [...files, ...owned, join(repo, 'docs/agents/other.md')];
    ok(
      "an adopted project with its own linter checks the kit's documents and the ones the skills write into",
      JSON.stringify(scopedMarkdown(all, { factoryKit: { lint: 'kit', manifest } })) ===
        JSON.stringify([files[1], ...owned]),
    );
    ok(
      'without factoryKit.lint, every document',
      JSON.stringify(scopedMarkdown(all, { factoryKit: { manifest } })) === JSON.stringify(all),
    );
    // legacy-tools/ shares the prefix but is not under legacy/.
    const legacy = ['legacy/README.md', 'legacy/docs/setup.md', 'legacy-tools/x.md', 'docs/agents/domain.md'];
    const abs = legacy.map((f) => join(repo, f));
    ok(
      "a factoryKit.protected directory's documents are not read, in either scope",
      JSON.stringify([
        scopedMarkdown(abs, { factoryKit: { protected: ['legacy/'] } }),
        scopedMarkdown(abs, { factoryKit: { protected: ['legacy'], lint: 'kit', manifest } }),
      ]) === JSON.stringify([[abs[2], abs[3]], [abs[3]]]),
    );
    const refused = ['..', '/legacy', 'a/../b', '', 3].filter((d) => {
      try {
        protectedDirs({ factoryKit: { protected: [d] } });
        return false;
      } catch {
        return true;
      }
    });
    ok('a protected entry outside the repository is refused', refused.length === 5);
  }

  const failed = cases.filter(([, cond]) => !cond);
  for (const [name] of failed) console.error(`✗ selftest: ${name}`);
  if (failed.length === 0) console.log(`✓ check-docs selftest: ${cases.length} case(s)`);
  return failed.length === 0;
}

function checkRepository() {
  const { failures: citationFailures, checked, skipped } = checkCitations();
  const duplicates = [];
  let recordCount = 0;
  for (const [kind, { dir, pattern }] of Object.entries(readKinds(repo))) {
    const path = join(repo, dir);
    if (!existsSync(path)) continue;
    const names = readdirSync(path).filter((f) => pattern.test(f));
    recordCount += names.length;
    for (const [number, files] of duplicateNumbers(names, pattern)) duplicates.push({ kind, number, files });
  }
  const placeholders = checkPlaceholders();
  const seedFile = join(repo, SEED);
  const seed = existsSync(seedFile)
    ? checkSeed(readFileSync(seedFile, 'utf8'), (f) => {
        const p = join(repo, f);
        return existsSync(p) ? readFileSync(p, 'utf8') : null;
      })
    : null;
  const seedFailures = (seed?.failures ?? []).map((f) => `${SEED}: ${f}`);

  for (const f of citationFailures) console.error(`✗ cited path does not exist: ${f}`);
  for (const { kind, number, files } of duplicates) {
    console.error(
      `✗ two ${kind} records are numbered ${number}: ${files.join(', ')} — renumber one before merging`,
    );
  }
  for (const f of placeholders) console.error(`✗ ${f}`);
  for (const f of seedFailures) console.error(`✗ ${f} — the item would not trace back to its analysis`);

  const total = citationFailures.length + duplicates.length + placeholders.length + seedFailures.length;
  if (total > 0) {
    console.error(`\n${total} documentation problem(s) found.`);
    return false;
  }
  console.log(
    `✓ ${checked} cited path(s) resolve (${skipped} known-absent, see KNOWN_ABSENT), ` +
      `${recordCount} numbered record(s) uniquely numbered` +
      (seed ? `, ${seed.entries} seed entr${seed.entries === 1 ? 'y' : 'ies'} traced` : ''),
  );
  return true;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // Selftest first, always, the way check-destructive-migrations.mjs does: the parser is the part that
  // can rot silently.
  const wantSelftestOnly = process.argv.includes('selftest');
  const selftestOk = runSelftest();
  if (!selftestOk || wantSelftestOnly) process.exit(selftestOk ? 0 : 1);
  process.exit(checkRepository() ? 0 : 1);
}

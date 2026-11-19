#!/usr/bin/env node
// Rewrite the tree's links to GitLab work items into links to their GitHub issues, once a board has moved
// (docs/agents/migrating-a-board.md, "The links in the tree"). DEVELOPER TOOLING, Node builtins only. Run
// once, on the day of the move, with the mapping `scripts/board/migrate.mjs --mapping` prints, and commit
// the result as a commit of its own.
//
//   node scripts/board/links.mjs <mapping.json> --dry-run   # say what would change, write nothing
//   node scripts/board/links.mjs <mapping.json>             # rewrite the files in place
//   node scripts/board/links.mjs --check [--gitlab=<url>]   # exit 1 while any link to a work item remains
//
// `--check` belongs in the project's `lint` after the move, so a link into the archive's work items cannot
// come back in a later change. It reads the GitLab URL from `factoryKit.migrate.gitlab` in package.json,
// or `--gitlab=`; with neither it refuses (exit 2), since a check with nothing to look for passes always.
//
// The files are the tracked ones `factoryKit.migrate.linkFiles` names as git pathspecs, or every tracked
// file when it names none; a binary (a file with a NUL byte) is never touched.
//
// Only the URL changes. `<gitlab>/-/work_items/N` and `<gitlab>/-/issues/N` become
// `https://github.com/<repository>/issues/M`, where M is N unless the mapping moved it. A `#note_…`
// fragment is dropped: it names a GitLab comment, and the GitHub copy of that comment has another anchor.
// Link text, a bare `#N` (inert in a repository's Markdown), `!N` and links to merge requests are left as
// they are: a merge request has no copy on GitHub.
//
// A link to a number the mapping lists in `unmapped`, or past its `highest`, has no copy to point at, so it
// is left alone and reported, and the run exits 1. A second run finds nothing to do.
//
// Exit codes: 0 done (or nothing left, for --check), 1 a link was left or remains, 2 usage.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './config.mjs';
import { gitEnv, readMigrateSettings } from './migrate.mjs';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Work-item and issue links into `gitlab`, with the number and any `#note_…` fragment captured. */
export function workItemPattern(gitlab) {
  return new RegExp(
    `${escapeRe(gitlab.replace(/\/+$/, ''))}/-/(?:work_items|issues)/(\\d+)(#note_\\d+)?`,
    'g',
  );
}

/**
 * The mapping file, checked. Throws on anything but the shape `migrate.mjs --mapping` prints, since a
 * wrong file would send every link to the wrong number.
 */
export function readMapping(json) {
  const m = typeof json === 'string' ? JSON.parse(json) : json;
  const fail = (why) => {
    throw new Error(`not a migrate.mjs --mapping file: ${why}`);
  };
  if (!/^[\w.-]+\/[\w.-]+$/.test(m?.repository ?? '')) fail('no repository');
  if (!/^https?:\/\/\S+$/.test(m?.gitlab ?? '')) fail('no gitlab URL');
  if (!Number.isInteger(m.highest) || m.highest < 1) fail('no highest number');
  if (!m.mapping || typeof m.mapping !== 'object') fail('no mapping');
  if (!Array.isArray(m.unmapped)) fail('no unmapped list');
  const moved = new Map();
  for (const [k, v] of Object.entries(m.mapping)) {
    if (!/^\d+$/.test(k) || !Number.isInteger(v) || v < 1) fail(`a bad entry ${k} → ${v}`);
    moved.set(Number(k), v);
  }
  return {
    repository: m.repository,
    gitlab: m.gitlab.replace(/\/+$/, ''),
    highest: m.highest,
    moved,
    unmapped: new Set(m.unmapped),
  };
}

/**
 * One text, rewritten. Pure. Returns the new text and what happened to each link: `changes` as
 * `[iid, number]` pairs in order of appearance, `left` the GitLab numbers with no copy, and `dropped`, how
 * many `#note_…` fragments went.
 */
export function rewriteLinks(text, map) {
  const changes = [];
  const left = [];
  let dropped = 0;
  const out = text.replace(workItemPattern(map.gitlab), (whole, n, note) => {
    const iid = Number(n);
    const number = map.moved.get(iid) ?? iid;
    if (!map.moved.has(iid) && (map.unmapped.has(iid) || iid > map.highest)) {
      left.push(iid);
      return whole;
    }
    if (note) dropped++;
    changes.push([iid, number]);
    return `https://github.com/${map.repository}/issues/${number}`;
  });
  return { text: out, changes, left, dropped };
}

/**
 * The tracked files `pathspecs` name (every tracked file for none), by git, with every inherited `GIT_*`
 * variable dropped: under a git hook, `GIT_DIR` would point git at the hook's repository (migrate.gitEnv).
 */
export function trackedFiles(root, pathspecs = []) {
  return execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], {
    cwd: root,
    env: gitEnv(),
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
}

/** Text only: a file with a NUL byte in it is binary, and a binary is never rewritten. */
function readText(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch {
    return null; // tracked but deleted in the working tree
  }
  return buf.includes(0) ? null : buf.toString('utf8');
}

/**
 * The tracked files under `root` that `files` names, rewritten (or, with `dryRun`, only read). Returns a
 * per-file report: `[{ file, changes, left, dropped }]` for each file with a link in it, sorted by path.
 */
export function rewriteTree(root, map, { dryRun = false, files = [] } = {}) {
  const report = [];
  for (const file of trackedFiles(root, files).sort()) {
    const full = path.join(root, file);
    const text = readText(full);
    if (text == null || !text.includes(map.gitlab)) continue;
    const r = rewriteLinks(text, map);
    if (!r.changes.length && !r.left.length) continue;
    if (!dryRun && r.text !== text) fs.writeFileSync(full, r.text);
    report.push({ file, changes: r.changes, left: r.left, dropped: r.dropped });
  }
  return report;
}

/** The files that still hold a link to a work item in `gitlab`, with how many. For `--check`. */
export function remaining(root, gitlab, { files = [] } = {}) {
  const out = [];
  for (const file of trackedFiles(root, files).sort()) {
    const text = readText(path.join(root, file));
    if (text == null) continue;
    const n = [...text.matchAll(workItemPattern(gitlab))].length;
    if (n) out.push([file, n]);
  }
  return out;
}

/** The summary a run prints. */
export function summarise(report, { dryRun }) {
  const links = report.reduce((s, r) => s + r.changes.length, 0);
  const moved = report.flatMap((r) => r.changes.filter(([a, b]) => a !== b));
  const left = report.flatMap((r) => r.left.map((iid) => [r.file, iid]));
  const dropped = report.reduce((s, r) => s + r.dropped, 0);
  const files = report.filter((r) => r.changes.length).length;
  const lines = [
    `${dryRun ? 'would rewrite' : 'rewrote'} ${links} link(s) in ${files} file(s); ${moved.length} to a different number, ${dropped} #note fragment(s) dropped`,
  ];
  const byPair = new Map();
  for (const [a, b] of moved) byPair.set(`${a}→${b}`, (byPair.get(`${a}→${b}`) ?? 0) + 1);
  if (byPair.size)
    lines.push(
      `moved: ${[...byPair].map(([pair, n]) => `#${pair.replace('→', ' → #')}${n > 1 ? ` (×${n})` : ''}`).join(', ')}`,
    );
  for (const [file, iid] of left) lines.push(`LEFT  ${file}: GitLab #${iid} has no copy on GitHub`);
  for (const r of report) if (r.changes.length) lines.push(`  ${r.changes.length}\t${r.file}`);
  return lines;
}

export function main(argv, { root = ROOT, log = console.log, error = console.error } = {}) {
  const settings = readMigrateSettings(root);
  const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')));
  const gitlabFlag = argv.find((a) => a.startsWith('--gitlab='))?.slice('--gitlab='.length);
  const files = argv.filter((a) => !a.startsWith('--'));
  for (const f of flags)
    if (!['--dry-run', '--check'].includes(f)) {
      error(`✖ unknown flag ${f}`);
      return 2;
    }
  if (flags.has('--check')) {
    const gitlab = gitlabFlag ?? settings.gitlab;
    if (!gitlab) {
      error(
        '✖ --check has no GitLab URL to look for: set factoryKit.migrate.gitlab in package.json, or pass --gitlab=<url>',
      );
      return 2;
    }
    const left = remaining(root, gitlab, { files: settings.linkFiles });
    for (const [file, n] of left) error(`✖ ${file}: ${n} link(s) to a GitLab work item`);
    if (left.length) {
      error(
        'Run scripts/board/links.mjs with the migration mapping (docs/agents/migrating-a-board.md, "The links in the tree").',
      );
      return 1;
    }
    log('✓ no link to a GitLab work item is left in the tracked files');
    return 0;
  }
  if (files.length !== 1) {
    error('usage: node scripts/board/links.mjs <mapping.json> [--dry-run] | --check [--gitlab=<url>]');
    return 2;
  }
  const map = readMapping(fs.readFileSync(files[0], 'utf8'));
  // The rewrite follows the mapping's URL and the check follows the setting's: they have to be one URL, or
  // the check would pass over every link this rewrite left.
  if (settings.gitlab && settings.gitlab.toLowerCase() !== map.gitlab.toLowerCase()) {
    error(`✖ the mapping is for ${map.gitlab}, and factoryKit.migrate.gitlab is ${settings.gitlab}`);
    return 2;
  }
  const dryRun = flags.has('--dry-run');
  const report = rewriteTree(root, map, { dryRun, files: settings.linkFiles });
  for (const line of summarise(report, { dryRun })) log(line);
  return report.some((r) => r.left.length) ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(`links: ${e?.message ?? e}`);
    process.exit(1);
  }
}

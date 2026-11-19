// Copy a GitLab work-item board to a GitHub repository, keeping every item's number
// (docs/agents/migrating-a-board.md, docs/adr/0004-board-migration-in-the-kit.md). DEVELOPER TOOLING, Node
// builtins only. Run once per project, when its board moves; every run before the real one is a rehearsal
// against a scratch repository.
//
//   node scripts/board/migrate.mjs --repo=<owner/name> --dry-run   # print the writes it would make, make none
//   node scripts/board/migrate.mjs --repo=<owner/name>             # make them, paced
//   node scripts/board/migrate.mjs --verify             # classify both sides, report every difference
//   node scripts/board/migrate.mjs --repo=<owner/name> --remap     # rewrite GitLab links for the collision
//                                                       # range to the GitHub numbers those items got
//   node scripts/board/migrate.mjs --mapping            # read only: print, as JSON, every GitLab number whose
//                                                       # GitHub number differs, for scripts/board/links.mjs
//   options: --through=<iid>      only GitLab items up to this number
//            --append-collisions  also create the items whose numbers the target already uses, at the end
//            --repo=<owner/name>  the target, instead of GITHUB_REPOSITORY in .env.github. A run that
//                                 writes always names it; a protected target is read only when named
//            --cutover            the confirmation for writing to a protected target, or to one that
//                                 already holds issues or pull requests the migration did not write
//            --gitlab-root=<dir>  where .env.gitlab is, when it is not in this checkout
//            --max-per-hour=<n>   REST pacing, default 450, at most 500 (GitHub's secondary limit); ≤1/s
//            --work-dir=<dir>     the scratch clone of board-assets and the downloaded uploads
//
// What a project configures, in `package.json` under `factoryKit.migrate` (`migrateSettings`, below):
//   protectedRepository  the real target (or a list): read only when --repo names it, written only with
//                        --cutover as well. Unset protects nothing by name, and every write still needs
//                        --repo, and --cutover on a target holding anything the migration did not write
//   confidential         { policy, color, description, notice }: what happens to GitLab's confidential
//                        items. Only "copy" is built. Without it, a board with confidential items stops
//   gitlab               the GitLab project's URL, which scripts/board/links.mjs rewrites and --check scans
//   linkFiles            git pathspecs for the link rewrite (default: every tracked file)
//
// Uploads are pushed to `board-assets` with git before any REST write, in batches, because a push is not
// a content-creation request and the REST upload would cost one of the 500 an hour per file.
//
// GitLab is only ever read. Idempotency lives on GitHub: every migrated issue and comment ends with a
// `board:migrated` marker naming its GitLab origin (scripts/board/core.mjs), and a rerun reads them back,
// so there is no state file to lose.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BoardError, envReader, fetchWithin, ROOT } from './config.mjs';
import { classify, LABEL_COLOURS, migratedFrom, migratedLine } from './core.mjs';
import {
  ASSETS_BRANCH,
  ASSETS_README,
  assetPath,
  CONFIDENTIAL_LABEL,
  createInstallationClient,
  githubConfig,
} from './github.mjs';
import { gitlabConfig } from './gitlab.mjs';

/** GitHub refuses an issue or comment body longer than this. */
const MAX_BODY = 65536;
const ZWSP = '​';

// ---------------------------------------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------------------------------------

/**
 * What a confidential item looks like when `policy` is `copy` and the project says nothing more. The label's
 * name is the adapter's (`CONFIDENTIAL_LABEL`) and is not a setting: it is what makes the tooling withhold
 * those titles on GitHub (core.isConfidential), so a label by any other name would print them.
 */
export const CONFIDENTIAL_DEFAULTS = {
  color: '#8B0000',
  description: 'Confidential on GitLab, copied in full by the board migration.',
  notice:
    '**This item was confidential on GitLab.** It is copied in full, so everybody who can read this\n' +
    'repository can read it.',
};

const MIGRATE_KEYS = ['protectedRepository', 'confidential', 'gitlab', 'linkFiles'];
const CONFIDENTIAL_KEYS = ['policy', 'color', 'description', 'notice'];
const REPOSITORY = /^[\w.-]+\/[\w.-]+$/;

/**
 * A project's migration settings from its package.json (`factoryKit.migrate`), checked. A key by any other
 * name, or a value of the wrong shape, is refused rather than ignored: a misspelt `protectedRepository`
 * would otherwise leave the real target unprotected in silence.
 */
export function migrateSettings(pkg) {
  const own = pkg?.factoryKit?.migrate ?? {};
  const fail = (why) => {
    throw new BoardError(`package.json factoryKit.migrate: ${why}`, 'misconfigured');
  };
  if (typeof own !== 'object' || own === null || Array.isArray(own)) fail('is not an object');
  const unknown = Object.keys(own).filter((k) => !MIGRATE_KEYS.includes(k));
  if (unknown.length)
    fail(`unknown setting ${unknown.join(', ')}; the settings are ${MIGRATE_KEYS.join(', ')}`);

  const named = own.protectedRepository;
  const protect = named == null ? [] : Array.isArray(named) ? named : [named];
  for (const r of protect)
    if (typeof r !== 'string' || !REPOSITORY.test(r.trim()))
      fail(`protectedRepository is an owner/name, or a list of them; got ${JSON.stringify(r)}`);

  let confidential = null;
  if (own.confidential != null) {
    const c = own.confidential;
    if (typeof c !== 'object' || Array.isArray(c)) fail('confidential is an object, { "policy": "copy" }');
    const bad = Object.keys(c).filter((k) => !CONFIDENTIAL_KEYS.includes(k));
    if (bad.length)
      fail(`unknown confidential setting ${bad.join(', ')}; they are ${CONFIDENTIAL_KEYS.join(', ')}`);
    if (c.policy === 'placeholder' || c.policy === 'skip')
      fail(
        `confidential.policy "${c.policy}" is not built; only "copy" is (docs/agents/migrating-a-board.md, "Confidential items")`,
      );
    if (c.policy !== 'copy')
      fail(`confidential.policy is "copy", the one policy built; got ${JSON.stringify(c.policy)}`);
    if (c.color != null && !/^#?[0-9a-fA-F]{6}$/.test(String(c.color)))
      fail(`confidential.color is a hex colour such as "#8B0000"; got ${JSON.stringify(c.color)}`);
    for (const k of ['description', 'notice'])
      if (c[k] != null && (typeof c[k] !== 'string' || !c[k].trim()))
        fail(`confidential.${k} is a non-empty string`);
    confidential = {
      policy: 'copy',
      color: `#${String(c.color ?? CONFIDENTIAL_DEFAULTS.color).replace(/^#/, '')}`,
      description: c.description ?? CONFIDENTIAL_DEFAULTS.description,
      notice: c.notice ?? CONFIDENTIAL_DEFAULTS.notice,
    };
  }

  if (own.gitlab != null && (typeof own.gitlab !== 'string' || !/^https?:\/\/[^\s/]+\/\S+$/.test(own.gitlab)))
    fail(
      `gitlab is the GitLab project's URL, such as "https://gitlab.example/group/project"; got ${JSON.stringify(own.gitlab)}`,
    );

  if (
    own.linkFiles != null &&
    (!Array.isArray(own.linkFiles) || !own.linkFiles.every((f) => typeof f === 'string' && f.trim()))
  )
    fail('linkFiles is a list of git pathspecs, such as ["docs", "*.md"]');

  return {
    protect: protect.map((r) => r.trim().toLowerCase()),
    confidential,
    gitlab: own.gitlab ? own.gitlab.replace(/\/+$/, '') : null,
    linkFiles: own.linkFiles ?? [],
  };
}

/** The settings from `root`'s package.json. No package.json is no settings; one that does not parse is an error. */
export function readMigrateSettings(root = ROOT) {
  const file = path.join(root, 'package.json');
  if (!fs.existsSync(file)) return migrateSettings({});
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new BoardError(`package.json does not parse (${e.message})`, 'misconfigured');
  }
  return migrateSettings(pkg);
}

// ---------------------------------------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------------------------------------

/**
 * Whether this run may read, and write, `repository`. Refusal is the default:
 *
 * - a **protected** repository (`protect`, from `factoryKit.migrate.protectedRepository`) is read only when
 *   `--repo` names it, and written only with `--cutover` as well, so neither an `.env.github` left pointing
 *   there nor a stray `GITHUB_REPOSITORY` in a shell can reach it;
 * - **any** run that writes names its target with `--repo`, protected or not, so an unset setting does not
 *   make the target whatever `.env.github` says;
 * - a target that already holds issues or pull requests the migration did not write (`foreign`, known once
 *   it is read) takes writes only with `--cutover`: its numbers are somebody else's.
 *
 * Returns the refusal, or null.
 */
export function targetGuard({ repository, repoFlag, cutover, writes, protect = [], foreign = 0 }) {
  if (!repository) return 'no target repository: set GITHUB_REPOSITORY in .env.github, or pass --repo=';
  const norm = (s) => (s || '').trim().toLowerCase();
  const named = norm(repoFlag) === norm(repository);
  const isProtected = protect.includes(norm(repository));
  if (isProtected && !named)
    return `${repository} is protected (factoryKit.migrate.protectedRepository): name it with --repo=${repository} to read it`;
  if (!writes) return null;
  if (!named) return `a run that writes names its target: --repo=${repository}, or --dry-run to only look`;
  if (isProtected && !cutover)
    return `${repository} is protected: it takes writes only with --cutover as well`;
  if (foreign > 0 && !cutover)
    return `${repository} already holds ${foreign} issue(s) or pull request(s) the migration did not write: writing there takes --cutover as well`;
  return null;
}

// ---------------------------------------------------------------------------------------------------------
// Text: references, mentions, images
// ---------------------------------------------------------------------------------------------------------

/** Split Markdown into code (fenced blocks, inline spans) and prose, so rewrites never touch code. */
function segments(text) {
  const out = [];
  const re = /(^|\n)(```|~~~)[^\n]*\n[\s\S]*?(\n\2[^\n]*(?=\n|$)|$)|`[^`\n]+`/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const start = m.index + (m[1] ? m[1].length : 0);
    if (start > last) out.push({ code: false, text: text.slice(last, start) });
    out.push({ code: true, text: text.slice(start, m.index + m[0].length) });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ code: false, text: text.slice(last) });
  return out;
}

/** An upload's secret segment: 32 hex digits, nothing else. */
const SECRET_RE = /^[0-9a-f]{32}$/;

/** `/uploads/<secret>/<file>` in any of the forms GitLab writes, relative or absolute. */
const uploadRe = (projectUrl) =>
  new RegExp(
    String.raw`(?:${escapeRe(projectUrl)}|https?://[^\s)/]+/-/project/\d+)?/(?:-/project/\d+/)?uploads/([0-9a-f]{32})/([^\s)"'\]]+)`,
    'g',
  );
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether an upload link's file segment names one file (#32). Board text is untrusted: anybody who can
 * comment writes it, and the name becomes a path in the download cache, on `board-assets`, and in a
 * token-authorised GitLab request. So the raw segment holds no `/`, `?` or `#`, and the decoded name is not
 * `.` or `..` and holds no `/`, `\`, NUL or other control character. A link that fails stays a link to
 * GitLab, and the plan lists it.
 */
export function uploadFile(file) {
  if (/[/?#]/.test(file)) return false;
  const name = safeDecode(file);
  return name !== '.' && name !== '..' && !/[/\\]/.test(name) && !/\p{Cc}/u.test(name);
}

/** Every upload link a text names, outside code, each once: `{ secret, file }`. */
function uploadLinksIn(text, projectUrl) {
  const seen = new Map();
  for (const seg of segments(text || '')) {
    if (seg.code) continue;
    for (const m of seg.text.matchAll(uploadRe(projectUrl)))
      seen.set(`${m[1]}/${m[2]}`, { secret: m[1], file: m[2] });
  }
  return [...seen.values()];
}

/** The uploads a text names, each once: `{ secret, file }`. A link `uploadFile` refuses is not one. */
export function uploadsIn(text, projectUrl) {
  return uploadLinksIn(text, projectUrl).filter((u) => uploadFile(u.file));
}

/** The asset key an upload is filed under on `board-assets`, inside the item's folder. */
export const assetName = (u) => `${u.secret.slice(0, 8)}-${safeDecode(u.file)}`;
function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * GitLab text as it reads on GitHub.
 *
 * - `#N` for a number the target already uses for something else (the collision range) becomes a link to
 *   the GitLab item, or with `remap`, `#M` for the GitHub number that item was given. Every other `#N` is
 *   the same item on both sides and stays.
 * - `!N` (a GitLab merge request) becomes a link to it.
 * - `@name` is defused with a zero-width space, so it pings nobody on GitHub who happens to share it.
 * - an upload becomes its copy on `board-assets`, when `asset(u)` knows one; otherwise it links to GitLab.
 *
 * Code is left exactly as written.
 */
export function rewrite(text, ctx, asset = () => null) {
  const gl = ctx.gitlabUrl;
  const one = new RegExp(
    `${uploadRe(gl).source}|(?<![\\w&/#!@.\\-])([#!])(\\d+)\\b|(?<![\\w.+\\-/\`])@([A-Za-z0-9][\\w.\\-]*)`,
    'g',
  );
  return segments(text || '')
    .map((seg) =>
      seg.code
        ? seg.text
        : seg.text.replace(one, (all, secret, file, sigil, num, name) => {
            if (secret)
              return uploadFile(file) ? (asset({ secret, file }) ?? `${gl}/uploads/${secret}/${file}`) : all;
            if (sigil === '!') return `[!${num}](${gl}/-/merge_requests/${num})`;
            if (sigil === '#') return issueRef(Number(num), ctx);
            if (name) return `@${ZWSP}${name}`;
            return all;
          }),
    )
    .join('');
}

function issueRef(n, ctx) {
  if (!ctx.collisions.has(n)) return `#${n}`;
  if (ctx.remap && ctx.mapping.has(n)) return `#${ctx.mapping.get(n)}`;
  return `[#${n}](${ctx.gitlabUrl}/-/issues/${n})`;
}

const day = (iso) => (iso || '').slice(0, 10);
const defuse = (name) => `@${ZWSP}${name}`;
function cap(body, url) {
  if (body.length <= MAX_BODY) return body;
  const marker = body.slice(body.lastIndexOf('\n<!-- board:migrated'));
  const note = `\n\n*Cut short: GitHub holds ${MAX_BODY} characters. The whole text is on [GitLab](${url}).*`;
  return body.slice(0, MAX_BODY - marker.length - note.length - 1) + note + marker;
}

/**
 * The GitHub issue body for a GitLab item. `asset(u)` resolves an upload to its copy. `history`, when
 * given, is the item's folded GitLab comments, placed after the description.
 */
export function issueBody(item, ctx, asset, history = '') {
  const head = [
    `> Migrated from GitLab [#${item.iid}](${item.url}) · filed by ${defuse(item.author)} on ${day(item.createdAt)}`,
  ];
  if (item.confidential) {
    const notice = ctx.confidentialNotice ?? CONFIDENTIAL_DEFAULTS.notice;
    head.push('>', ...notice.split('\n').map((l) => `> ${l}`));
  }
  const links = [];
  for (const n of [...item.links].sort((a, b) => a - b)) {
    if (!ctx.collisions.has(n)) links.push(`Relates-to: #${n}`);
    else if (ctx.remap && ctx.mapping.has(n)) links.push(`Relates-to: #${ctx.mapping.get(n)}`);
    else links.push(`Linked on GitLab: [#${n}](${ctx.gitlabUrl}/-/issues/${n})`);
  }
  const text = rewrite(item.description, ctx, asset).trim();
  const marker = migratedLine({
    from: 'gitlab',
    note: item.id,
    url: item.url,
    author: item.author,
    at: item.createdAt,
    kind: item.authorId === ctx.gitlabBotId ? 'ours' : 'reply',
  });
  const body = [head.join('\n'), text, history, links.join('\n'), marker].filter(Boolean).join('\n\n');
  return history ? body : cap(body, item.url);
}

/**
 * A GitLab comment as a GitHub one. The attribution goes at the top of a reply, and at the bottom of
 * anything that opens with a plan or coverage heading, because plan detection is a prefix match.
 */
export function commentBody(item, note, ctx, asset) {
  const kind = note.authorId === ctx.gitlabBotId ? 'ours' : 'reply';
  const url = `${item.url}#note_${note.id}`;
  const by = `<sub>Originally by ${defuse(note.author)} on GitLab, ${day(note.createdAt)} — [link](${url})</sub>`;
  const text = rewrite(note.body, ctx, asset).trim();
  const marker = migratedLine({
    from: 'gitlab',
    note: note.id,
    url,
    author: note.author,
    at: note.createdAt,
    kind,
  });
  const opensWithHeading = /^## (Remediation plan|Review coverage)/.test(note.body.trimStart());
  const parts = kind === 'reply' && !opensWithHeading ? [by, text, marker] : [text, by, marker];
  return cap(parts.filter(Boolean).join('\n\n'), url);
}

// ---------------------------------------------------------------------------------------------------------
// Folding: as few GitHub comments as the board's state allows
// ---------------------------------------------------------------------------------------------------------

/**
 * A folded comment, or an issue body carrying folded history, stays under this: GitHub's limit is 65,536
 * characters, and the margin is for the marker and the headers.
 */
export const FOLD_LIMIT = 60000;
const PLAN_PREFIX = '## Remediation plan';
const CLAIMS_A_PLAN = ['ai:plan-posted', 'ai:answered', 'ai:ready', 'ai:blocked'];

/**
 * How many of an item's comments fold into history; the rest stay one GitHub comment each.
 *
 * The state machine reads the plan in force and what came after it (core.classify), so on an open item
 * those stay separate, each with its own marker, and everything before the last plan folds. A closed item
 * folds whole. An open item with no plan folds whole too, unless a label claims a plan, because then the
 * newest comment decides between `plan-posted` and `answered` and has to stay a comment of its own.
 */
export function foldPoint(it) {
  if (it.state === 'closed') return it.comments.length;
  let last = -1;
  it.comments.forEach((n, i) => {
    if (n.body.trimStart().startsWith(PLAN_PREFIX)) last = i;
  });
  if (last >= 0) return last;
  return CLAIMS_A_PLAN.some((l) => it.labels.includes(l))
    ? Math.max(0, it.comments.length - 1)
    : it.comments.length;
}

/** Folded comments as entries, each with a header naming who, when, where and which kind; a note too big for one GitHub comment becomes several parts. */
function historyEntries(it, notes, ctx, asset) {
  const room = FOLD_LIMIT - 2000;
  const out = [];
  for (const note of notes) {
    const kind = note.authorId === ctx.gitlabBotId ? 'ours' : 'reply';
    const url = `${it.url}#note_${note.id}`;
    const head = (part) =>
      `---\n\n**${defuse(note.author)}** · ${note.createdAt} · ${kind} · [GitLab note](${url})${part}`;
    const text = rewrite(note.body, ctx, asset).trim();
    if (text.length <= room) {
      out.push({ key: String(note.id), at: note.createdAt, text: `${head('')}\n\n${text}` });
      continue;
    }
    const chunks = [];
    for (let i = 0; i < text.length; i += room) chunks.push(text.slice(i, i + room));
    for (const [i, c] of chunks.entries())
      out.push({
        key: `${note.id}.${i + 1}/${chunks.length}`,
        at: note.createdAt,
        text: `${head(` · part ${i + 1} of ${chunks.length}`)}\n\n${c}`,
      });
  }
  return out;
}

/**
 * What an item looks like on GitHub: its body, and its migrated comments in order. With `fold`, the
 * history before the fold point goes into the body when it all fits under FOLD_LIMIT, and otherwise into
 * as few comments as hold it, packed in order; the comments from the fold point on follow, one each.
 */
export function desired(it, ctx, asset, { fold = true } = {}) {
  if (!fold)
    return {
      body: issueBody(it, ctx, asset),
      comments: it.comments.map((n) => commentBody(it, n, ctx, asset)),
    };
  const at = foldPoint(it);
  const kept = it.comments.slice(at).map((n) => commentBody(it, n, ctx, asset));
  const entries = historyEntries(it, it.comments.slice(0, at), ctx, asset);
  if (!entries.length) return { body: issueBody(it, ctx, asset), comments: kept };
  const history = `## GitLab history\n\n<sub>${at} comment(s) from GitLab, folded into this body.</sub>\n\n${entries.map((e) => e.text).join('\n\n')}`;
  const inBody = issueBody(it, ctx, asset, history);
  if (inBody.length <= FOLD_LIMIT) return { body: inBody, comments: kept };
  const blobs = [];
  let cur = [];
  let size = 0;
  for (const e of entries) {
    if (cur.length && size + e.text.length + 2 > FOLD_LIMIT - 2000) {
      blobs.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(e);
    size += e.text.length + 2;
  }
  if (cur.length) blobs.push(cur);
  const bodies = blobs.map((b, i) =>
    [
      `<sub>GitLab history, part ${i + 1}: comments made on GitLab, folded together.</sub>`,
      b.map((e) => e.text).join('\n\n'),
      migratedLine({
        from: 'gitlab',
        note: b.map((e) => e.key).join(','),
        url: it.url,
        author: 'board-migrate',
        at: b[0].at,
        kind: 'ours',
      }),
    ].join('\n\n'),
  );
  return { body: issueBody(it, ctx, asset), comments: [...bodies, ...kept] };
}

export function placeholderBody(iid, ctx) {
  const url = `${ctx.gitlabUrl}/-/issues/${iid}`;
  return [
    `GitLab #${iid} was deleted, or never existed. This closed placeholder keeps the numbers that follow it`,
    'the same on both sides.',
    '',
    migratedLine({ from: 'gitlab', url, author: 'board-migrate', kind: 'ours' }),
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------------------
// Planning — pure
// ---------------------------------------------------------------------------------------------------------

/** The GitLab iid a migrated GitHub body names, from its marker's URL. */
export function migratedIid(body, gitlabUrl) {
  // On an issue body the marker need not stay last: `create`/`link` append a Relates-to line after it.
  const line = (body || '')
    .split(/\r?\n/)
    .filter((l) => l.startsWith('<!-- board:migrated '))
    .pop();
  const m = line ? migratedFrom(line) : null;
  if (m?.from !== 'gitlab' || !m.url) return null;
  const hit = new RegExp(`^${escapeRe(gitlabUrl)}/-/(?:issues|work_items)/(\\d+)$`).exec(m.url);
  return hit ? Number(hit[1]) : null;
}

/**
 * What the target already holds: GitLab iid → GitHub issue, and the collision range — every number up to
 * the target's highest that does not hold its own GitLab item. That is anything else's issue or pull
 * request, a number whose issue was deleted or never made (it never comes back, and GitHub can burn one
 * on a 5xx: docs/agents/migrating-a-board.md), and a number holding a collision-range item appended at the
 * end. A marker counts only on something the App wrote, or when the App is unknown.
 */
export function mappingOf(source, target) {
  const trusted = (authorId) => target.botId == null || authorId === target.botId;
  const byIid = new Map();
  const held = new Set();
  const duplicates = [];
  for (const issue of target.issues.values()) {
    const iid = !issue.isPr && trusted(issue.authorId) ? migratedIid(issue.body, source.url) : null;
    if (iid == null) continue;
    if (byIid.has(iid)) duplicates.push({ iid, numbers: [byIid.get(iid).number, issue.number] });
    else {
      byIid.set(iid, issue);
      // Only a number holding its own GitLab item is the same on both sides. One holding another item
      // (a collision-range item appended at the end) is as spent as one holding anything else.
      if (issue.number === iid) held.add(issue.number);
    }
  }
  const highest = Math.max(target.maxNumber ?? 0, ...target.issues.keys());
  const collisions = new Set();
  for (let n = 1; n <= highest; n++) if (!held.has(n)) collisions.add(n);
  return { byIid, collisions, duplicates };
}

/**
 * The target's issues and pull requests that are not copies the migration wrote: somebody else's numbers.
 * A target with any takes writes only with `--cutover` (targetGuard).
 */
export function foreignNumbers(source, target) {
  const own = new Set([...mappingOf(source, target).byIid.values()].map((i) => i.number));
  return [...target.issues.keys()].filter((n) => !own.has(n)).sort((a, b) => a - b);
}

/**
 * What `--mapping` prints, and what `scripts/board/links.mjs` reads: the GitLab iids whose copy has a
 * different GitHub number, and the numbers no link may be sent to. Those are the collision range's numbers
 * that hold no copy of their own GitLab item: somebody else's issue or pull request, a deleted number, or
 * an appended copy of another item. A GitLab link to one of them has no copy to point at yet, or points at
 * the wrong thing if sent to the same number. `highest` is the target's highest number: a GitLab number past
 * it has no copy either. Pure.
 */
export function mappingReport(source, target, repository) {
  const { byIid, collisions } = mappingOf(source, target);
  const mapping = {};
  for (const [iid, issue] of [...byIid].sort((a, b) => a[0] - b[0]))
    if (issue.number !== iid) mapping[iid] = issue.number;
  return {
    repository,
    gitlab: source.url,
    highest: Math.max(target.maxNumber ?? 0, ...target.issues.keys()),
    mapping,
    unmapped: [...collisions].filter((n) => !byIid.has(n)).sort((a, b) => a - b),
  };
}

const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/**
 * Every write that makes `target` match `source`, in the order they have to happen. Pure: both sides come
 * in as snapshots (readGitlab, readGithub), and nothing here touches the network.
 *
 * Returns `{ writes, uploads, stop, mapping, confidential, skipped }`: `writes` are REST calls, `uploads`
 * the files `stageAssets` pushes to `board-assets` with git before them. `stop` is set when the numbers would shift —
 * the next GitLab item to create is not the target's next number — and then `writes` is empty: a run never
 * creates under a shifted number, and nothing is half-done because of it.
 */
export function planSync(source, target, opts = {}) {
  const {
    through = Number.POSITIVE_INFINITY,
    appendCollisions = false,
    remap = false,
    fold = true,
    confidential: policy = null,
  } = opts;
  const { byIid, collisions, duplicates } = mappingOf(source, target);
  if (duplicates.length) {
    const d = duplicates[0];
    return {
      writes: [],
      uploads: [],
      stop: `GitLab #${d.iid} is on GitHub twice (#${d.numbers.join(', #')})`,
      mapping: byIid,
    };
  }
  const mapping = new Map([...byIid].map(([iid, issue]) => [iid, issue.number]));
  // Confidential items are copied only by a decision written down: without one, nothing is planned.
  const secret = [];
  for (let n = 1; n <= Math.min(source.maxIid, through); n++)
    if (source.items.get(n)?.confidential) secret.push(n);
  if (secret.length && policy?.policy !== 'copy') {
    return {
      writes: [],
      uploads: [],
      stop:
        `GitLab holds ${secret.length} confidential item(s) (#${secret.join(', #')}), and package.json says nothing ` +
        'about them: set factoryKit.migrate.confidential.policy. Only "copy" is built, which copies each in ' +
        'full, readable by everybody who can read the target (docs/agents/migrating-a-board.md). Nothing was written.',
      mapping: byIid,
    };
  }
  const ctx = {
    gitlabUrl: source.url,
    gitlabBotId: source.botId,
    collisions,
    mapping,
    remap,
    confidentialNotice: policy?.notice ?? CONFIDENTIAL_DEFAULTS.notice,
  };
  const writes = [];
  const uploads = [];
  const refusedReleases = [];
  const confidential = [];
  const skipped = [];

  // Labels and milestones first: an issue is created with both.
  const wantLabels = new Map();
  const wantMilestones = new Map();
  const iids = [];
  for (let n = 1; n <= Math.min(source.maxIid, through); n++) iids.push(n);
  for (const n of iids) {
    const it = source.items.get(n);
    if (!it) continue;
    for (const l of it.labels) wantLabels.set(l, source.labels.get(l) ?? null);
    if (it.confidential) wantLabels.set(CONFIDENTIAL_LABEL, null);
    if (it.milestone) wantMilestones.set(it.milestone, source.milestones.get(it.milestone) ?? null);
  }
  // A release names its milestone in its notes, so the milestone has to be there too.
  for (const r of source.releases ?? [])
    for (const m of r.milestones) wantMilestones.set(m, source.milestones.get(m) ?? null);
  for (const [name, gl] of [...wantLabels].sort(([a], [b]) => a.localeCompare(b))) {
    if (target.labels.has(name)) continue;
    const known =
      LABEL_COLOURS[name] ??
      (name === CONFIDENTIAL_LABEL
        ? [policy?.color ?? CONFIDENTIAL_DEFAULTS.color, policy?.description]
        : null);
    writes.push({
      op: 'ensure-label',
      name,
      color: (known?.[0] ?? gl?.color ?? '#666666').replace(/^#/, ''),
      description: known?.[1] ?? gl?.description ?? '',
    });
  }
  for (const [title, gl] of [...wantMilestones].sort(([a], [b]) => a.localeCompare(b))) {
    if (target.milestones.has(title)) continue;
    writes.push({ op: 'create-milestone', title, due: gl?.due ?? null, state: gl?.state ?? 'open' });
  }

  // Items, in number order, so creation keeps GitLab's numbering.
  let next = target.maxNumber + 1;
  const later = [];
  const doItem = (n, appended) => {
    const it = source.items.get(n);
    const existing = byIid.get(n);
    if (!existing && !appended && collisions.has(n)) {
      // A deleted number in the collision range needs no placeholder: nothing after it depends on it.
      if (it) {
        skipped.push(n);
        later.push(n);
      }
      return null;
    }
    // Numbers only: what a run prints about a confidential item never carries its title.
    if (it?.confidential) confidential.push({ iid: n });
    if (!existing) {
      if (!appended && n !== next) {
        return `GitLab #${n} would be created as GitHub #${next}: the numbers have shifted. Nothing was written.`;
      }
      const number = next++;
      mapping.set(n, number);
      if (!it) {
        writes.push({
          op: 'create-issue',
          iid: n,
          expect: number,
          placeholder: true,
          title: `GitLab #${n} (deleted)`,
          labels: [],
          milestone: null,
        });
        writes.push({ op: 'set-state', iid: n, state: 'closed', reason: 'not_planned' });
        return null;
      }
      uploads.push(...uploadsFor(it, target, source.url));
      writes.push({
        op: 'create-issue',
        iid: n,
        expect: number,
        title: it.title,
        source: { iid: n },
        labels: labelsFor(it),
        milestone: it.milestone,
      });
      const want = desired(it, ctx, assetResolver(it, assetIndex(target), target.repository, source.url), {
        fold,
      });
      for (const index of want.comments.keys()) writes.push({ op: 'comment', iid: n, index });
      if (it.state === 'closed') writes.push({ op: 'set-state', iid: n, state: 'closed' });
      return null;
    }
    // Already there: bring it up to date.
    if (!it) {
      if (existing.state !== 'closed') writes.push({ op: 'set-state', iid: n, state: 'closed' });
      return null;
    }
    uploads.push(...uploadsFor(it, target, source.url));
    const asset = assetResolver(it, assetIndex(target), target.repository, source.url);
    // A normal run accepts either form of the collision-range references; --remap accepts only its own.
    const want = desired(it, ctx, asset, { fold });
    const forms = remap ? [want] : [want, desired(it, { ...ctx, remap: true }, asset, { fold })];
    const own = [];
    const edit = {};
    if (existing.title !== it.title) edit.title = it.title;
    // Migrated comments are compared by position: the n-th migrated comment is the n-th one wanted.
    const have = existing.comments.filter((c) => isMigratedComment(c, target.botId));
    // An item that is one whole form is left alone. Forms are not mixed: the two can fold into different
    // numbers of comments (a GitLab link is longer than `#M`), so a run comparing each comment against
    // either would undo --remap a comment at a time.
    if (!forms.some((f) => matchesShape(f, existing.body, have))) {
      // Bring it up to date in the form it is already in, so a new comment does not undo --remap.
      const ref =
        forms.find((f) => f.body === existing.body) ??
        forms.find((f) => f.comments.some((c, i) => have[i]?.body === c)) ??
        want;
      if (ref.body !== existing.body) edit.body = true;
      for (let index = 0; index < Math.max(have.length, ref.comments.length); index++) {
        const c = have[index];
        if (!c) own.push({ op: 'comment', iid: n, index, ...(ref !== want ? { remap: true } : {}) });
        else if (index >= ref.comments.length) own.push({ op: 'delete-comment', iid: n, commentId: c.id });
        else if (ref.comments[index] !== c.body)
          own.push({
            op: 'edit-comment',
            iid: n,
            index,
            commentId: c.id,
            ...(ref !== want ? { remap: true } : {}),
          });
      }
      if (edit.body && ref !== want) edit.remap = true;
    }
    if (edit.title || edit.body) own.unshift({ op: 'edit-issue', iid: n, ...edit, source: { iid: n } });
    writes.push(...own);
    if (!sameSet(existing.labels, labelsFor(it)))
      writes.push({ op: 'set-labels', iid: n, labels: labelsFor(it) });
    if ((existing.milestone ?? null) !== (it.milestone ?? null))
      writes.push({ op: 'set-milestone', iid: n, milestone: it.milestone ?? null });
    if (existing.state !== it.state) writes.push({ op: 'set-state', iid: n, state: it.state });
    return null;
  };
  for (const n of iids) {
    const stop = doItem(n, false);
    if (stop) return { writes: [], uploads: [], stop, mapping, confidential, skipped };
  }
  if (appendCollisions) for (const n of later) doItem(n, true);
  // Releases last: their notes link milestones and items made above.
  const rel = planReleases(source, target, ctx);
  writes.push(...rel.writes);
  uploads.push(...rel.uploads);
  refusedReleases.push(...rel.refused);
  return {
    writes,
    uploads,
    stop: null,
    mapping,
    confidential,
    skipped,
    ctx,
    fold,
    refusedReleases,
    refusedUploads: refusedUploads(source),
  };
}

function labelsFor(it) {
  return [...new Set([...it.labels, ...(it.confidential ? [CONFIDENTIAL_LABEL] : [])])].sort();
}

function assetIndex(target) {
  const idx = new Map();
  for (const p of target.assets) {
    const m = /^items\/(\d+)\/[^/]+\/(.+)$/.exec(p);
    if (m && !idx.has(`${m[1]}/${m[2]}`)) idx.set(`${m[1]}/${m[2]}`, p);
  }
  return idx;
}

/** The stamp format the adapter's `upload` uses for a folder: `20261012T100000Z`. */
const stampOf = (iso) =>
  new Date(iso)
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');

/**
 * An item's uploads, each once, with the path it has (or will have) on `board-assets`:
 * `items/<iid>/<stamp>/<secret8>-<file>`, the adapter's own layout (`assetPath`), with the stamp taken
 * from the text that first shows the upload, so the path is the same on every run. One already on the
 * branch under another stamp (copied by the adapter's `upload` before staging existed) keeps that path.
 */
function itemAssets(it, idx, gitlabUrl) {
  const out = new Map();
  const texts = [[it.description, it.createdAt], ...it.comments.map((c) => [c.body, c.createdAt])];
  for (const [text, at] of texts) {
    for (const u of uploadsIn(text, gitlabUrl)) {
      const name = assetName(u);
      if (out.has(name)) continue;
      const have = idx.get(`${it.iid}/${name}`);
      out.set(name, {
        ...u,
        name,
        path: have ?? assetPath({ iid: it.iid }, stampOf(at), name),
        present: Boolean(have),
      });
    }
  }
  return out;
}

/** An upload's URL on `board-assets`, whether it is there yet or is about to be pushed. */
function assetResolver(it, idx, repository, gitlabUrl) {
  const known = itemAssets(it, idx, gitlabUrl);
  return (u) => {
    const p =
      known.get(assetName(u))?.path ?? assetPath({ iid: it.iid }, stampOf(it.createdAt), assetName(u));
    return assetUrl(repository, p);
  };
}

/** A path on `board-assets` as the blob URL that shows it inline. */
const assetUrl = (repository, p) =>
  `https://github.com/${repository}/blob/${ASSETS_BRANCH}/${p.split('/').map(encodeURIComponent).join('/')}?raw=true`;

/** The uploads an item needs that `board-assets` does not have yet. */
function uploadsFor(it, target, gitlabUrl) {
  return [...itemAssets(it, assetIndex(target), gitlabUrl).values()]
    .filter((a) => !a.present)
    .map(({ secret, file, name, path: where }) => ({ iid: it.iid, secret, file, name, path: where }));
}

/** Whether an item's body and migrated comments are exactly one wanted shape. */
function matchesShape(shape, body, comments) {
  return (
    shape.body === body &&
    shape.comments.length === comments.length &&
    shape.comments.every((c, i) => c === comments[i].body)
  );
}

/** A comment the migration wrote: a GitLab marker on the App's own comment (or with the App unknown). */
function isMigratedComment(c, botId) {
  return migratedFrom(c.body)?.from === 'gitlab' && (botId == null || c.authorId === botId);
}

// ---------------------------------------------------------------------------------------------------------
// Releases
// ---------------------------------------------------------------------------------------------------------

/** The marker a migrated release's notes end with. Its own shape: a release is neither an item nor a comment. */
export function releaseMarker(rel) {
  const enc = (v) => String(v ?? '').replace(/[\s%>]|--/g, (c) => encodeURIComponent(c).replace(/-/g, '%2D'));
  return `<!-- board:migrated from=gitlab release=${enc(rel.tag)} url=${enc(rel.url)} at=${enc(rel.releasedAt)} -->`;
}

/** Copies on `board-assets` of the uploads a release's notes show: `releases/<tag>/<stamp>/<secret8>-<file>`. */
function releaseAssets(rel, assets, gitlabUrl) {
  const idx = new Map();
  for (const p of assets) {
    const m = /^releases\/([^/]+)\/[^/]+\/(.+)$/.exec(p);
    if (m && !idx.has(`${m[1]}/${m[2]}`)) idx.set(`${m[1]}/${m[2]}`, p);
  }
  const out = new Map();
  for (const u of uploadsIn(rel.description, gitlabUrl)) {
    const name = assetName(u);
    if (out.has(name)) continue;
    const have = idx.get(`${rel.tag}/${name}`);
    out.set(name, {
      ...u,
      name,
      path: have ?? `releases/${rel.tag}/${stampOf(rel.releasedAt)}/${name}`,
      present: Boolean(have),
    });
  }
  return out;
}

/**
 * A GitLab release link that points at one of the project's uploads becomes a GitHub release asset; any
 * other link is listed in the notes.
 */
export function releaseLinks(rel, gitlabUrl) {
  const files = [];
  const external = [];
  const refused = [];
  for (const l of rel.links) {
    const m = new RegExp(uploadRe(gitlabUrl).source).exec(l.url);
    if (m && uploadFile(m[2]))
      files.push({ label: l.name, secret: m[1], file: m[2], name: safeDecode(m[2]) });
    else {
      // A refused upload stays a link in the notes, and the plan lists it.
      if (m) refused.push(m[2]);
      external.push(l);
    }
  }
  return { files, external, refused };
}

/**
 * A GitLab release's notes as they read on GitHub: the description rewritten as an issue's is, then the
 * milestone line `release finalize` writes (scripts/board/release.mjs), the GitLab date (GitHub cannot set
 * one), the links that are not files, and the marker.
 */
export function releaseBody(rel, ctx, { repository, milestoneNumber, assets = new Set() }) {
  const known = releaseAssets(rel, assets, ctx.gitlabUrl);
  const asset = (u) => {
    const p = known.get(assetName(u))?.path;
    return p ? assetUrl(repository, p) : null;
  };
  const title = rel.milestones[0];
  const { external } = releaseLinks(rel, ctx.gitlabUrl);
  return [
    rewrite(rel.description, ctx, asset).trim(),
    title && milestoneNumber
      ? `**Milestone:** [${title}](https://github.com/${repository}/milestone/${milestoneNumber})`
      : '',
    `Released on GitLab on ${day(rel.releasedAt)}.`,
    external.length
      ? `Links from GitLab:\n\n${external.map((l) => `- [${l.name}](${l.url})`).join('\n')}`
      : '',
    releaseMarker(rel),
  ]
    .filter(Boolean)
    .join('\n\n');
}

const refusedIn = (text, url) =>
  uploadLinksIn(text, url)
    .filter((u) => !uploadFile(u.file))
    .map((u) => u.file);

/**
 * Every upload link in the source that `uploadFile` refuses, as `{ where, file }`: `#<iid>` or
 * `release <tag>`. Each stays a link to GitLab, so the dry run lists them for somebody to look at before
 * the GitLab project is archived (#32).
 */
export function refusedUploads(source) {
  const out = [];
  const add = (where, files) => {
    for (const file of new Set(files)) out.push({ where, file });
  };
  for (const it of [...source.items.values()].sort((a, b) => a.iid - b.iid)) {
    const texts = [it.description, ...it.comments.map((c) => c.body)];
    add(
      `#${it.iid}`,
      texts.flatMap((t) => refusedIn(t, source.url)),
    );
  }
  for (const r of source.releases ?? [])
    add(`release ${r.tag}`, [
      ...refusedIn(r.description, source.url),
      ...releaseLinks(r, source.url).refused,
    ]);
  return out;
}

/**
 * The writes that give every GitLab release a GitHub release, oldest first. Only for a tag the target
 * already has: GitHub creates a missing tag at the default branch's head, which would be the wrong commit,
 * so such a release is refused and listed, never created, and `target_commitish` is never sent. The newest
 * by date is the latest; every other one is made with `make_latest: false`.
 */
export function planReleases(source, target, ctx) {
  const writes = [];
  const uploads = [];
  const refused = [];
  const all = source.releases ?? [];
  const ok = all.filter((r) => target.tags?.has(r.tag));
  for (const r of all) if (!target.tags?.has(r.tag)) refused.push(r.tag);
  const newest = ok.at(-1)?.tag ?? null;
  for (const r of ok) {
    const opts = {
      repository: target.repository,
      milestoneNumber: target.milestones.get(r.milestones[0]) ?? null,
      assets: target.assets,
    };
    for (const a of releaseAssets(r, target.assets, ctx.gitlabUrl).values())
      if (!a.present)
        uploads.push({ iid: `release ${r.tag}`, secret: a.secret, file: a.file, name: a.name, path: a.path });
    // With the uploads above pushed first, this is what the notes will say.
    const pushed = new Set([...target.assets, ...uploads.map((u) => u.path)]);
    const forms = (ctx.remap ? [true] : [false, true]).map((remap) =>
      releaseBody(r, { ...ctx, remap }, { ...opts, assets: pushed }),
    );
    const latest = r.tag === newest;
    const have = (target.releases ?? []).find((x) => x.tag === r.tag);
    if (!have) writes.push({ op: 'create-release', tag: r.tag, latest });
    else if (have.name !== r.name || have.draft || have.prerelease || !forms.includes(have.body))
      writes.push({ op: 'edit-release', tag: r.tag, id: have.id, latest });
    for (const f of releaseLinks(r, ctx.gitlabUrl).files)
      if (!have?.assets.some((a) => a.name === f.name))
        writes.push({ op: 'release-asset', tag: r.tag, ...f });
  }
  // Which release is latest is GitHub's to say; it is set once more only when it says another.
  const made = writes.some((w) => w.op === 'create-release' && w.latest);
  const have = (target.releases ?? []).find((x) => x.tag === newest);
  if (newest && !made && target.latest !== newest && have)
    writes.push({ op: 'set-latest', tag: newest, id: have.id });
  return { writes, uploads, refused };
}

/** The releases that differ from what is wanted, and the ones refused for a missing tag. */
export function verifyReleases(source, target) {
  const { byIid, collisions } = mappingOf(source, target);
  const mapping = new Map([...byIid].map(([iid, issue]) => [iid, issue.number]));
  const ctx = { gitlabUrl: source.url, gitlabBotId: source.botId, collisions, mapping };
  const plan = planReleases(source, target, { ...ctx, remap: false });
  const mismatches = plan.writes.map((w) => ({ tag: w.tag, why: w.op }));
  if (plan.uploads.length)
    mismatches.push({ tag: '(notes)', why: `${plan.uploads.length} upload(s) missing` });
  return { checked: (source.releases ?? []).length - plan.refused.length, mismatches, refused: plan.refused };
}

/** Counts by write type, for the dry run and the evidence. A placeholder is counted apart from an issue. */
export function tally(writes) {
  const out = {};
  for (const w of writes) {
    const k = w.op === 'create-issue' && w.placeholder ? 'create-placeholder' : w.op;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** GitHub's secondary limit on creating content is about 500 an hour; the pacing stays under it. */
export const MAX_PER_HOUR = 500;

/**
 * How long `writes` take at one a second and `perHour` in any rolling hour: the first `perHour` go out a
 * second apart, then each further batch waits for the hour to roll. In seconds.
 */
export function expectedSeconds(writes, perHour) {
  if (writes <= 0) return 0;
  const full = Math.floor((writes - 1) / perHour);
  return full * 3600 + ((writes - 1) % perHour) + 1;
}

const hms = (sec) =>
  `${Math.floor(sec / 3600)} h ${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')} min`;

/**
 * Every item whose state differs between the two sides, or that is missing, misnumbered, or not a faithful
 * copy. Both sides are classified by the same `classify`, the GitLab side by the GitLab bot's id and the
 * GitHub side by the App's.
 */
export function verify(
  source,
  target,
  { through = Number.POSITIVE_INFINITY, fold = true, confidential = null } = {},
) {
  const { byIid, collisions } = mappingOf(source, target);
  const mapping = new Map([...byIid].map(([iid, issue]) => [iid, issue.number]));
  const ctx = {
    gitlabUrl: source.url,
    gitlabBotId: source.botId,
    collisions,
    mapping,
    confidentialNotice: confidential?.notice ?? CONFIDENTIAL_DEFAULTS.notice,
  };
  const mismatches = [];
  const pending = [];
  let checked = 0;
  const norm = (s) => (s === 'stale' ? 'analysing' : s);
  for (let n = 1; n <= Math.min(source.maxIid, through); n++) {
    const it = source.items.get(n);
    const gh = byIid.get(n);
    if (!gh) {
      // An item whose number the target already uses waits for --append-collisions; that is not a mismatch.
      if (collisions.has(n)) {
        if (it) pending.push(n);
      } else mismatches.push({ iid: n, why: 'not on GitHub' });
      continue;
    }
    checked++;
    if (!collisions.has(n) && gh.number !== n) mismatches.push({ iid: n, why: `numbered #${gh.number}` });
    if (!it) {
      if (gh.state !== 'closed') mismatches.push({ iid: n, why: 'placeholder is open' });
      continue;
    }
    const asset = assetResolver(it, assetIndex(target), target.repository, source.url);
    const forms = [false, true].map((remap) => desired(it, { ...ctx, remap }, asset, { fold }));
    const migrated = gh.comments.filter((c) => isMigratedComment(c, target.botId));
    const diffs = [];
    // The board state, on an open item: what `list` and `show` compute there, from every comment.
    if (it.state === 'open') {
      const glState = classify(
        { labels: it.labels, updatedAt: it.updatedAt },
        it.comments,
        source.botId,
      ).state;
      const ghState = classify(
        { labels: gh.labels, updatedAt: it.updatedAt },
        gh.comments,
        target.botId,
      ).state;
      if (norm(glState) !== norm(ghState)) diffs.push(`state ${glState} on GitLab, ${ghState} on GitHub`);
    }
    if (gh.title !== it.title) diffs.push('title');
    if (gh.state !== it.state) diffs.push(`${it.state} on GitLab, ${gh.state} on GitHub`);
    if (!sameSet(gh.labels, labelsFor(it))) diffs.push('labels');
    if ((gh.milestone ?? null) !== (it.milestone ?? null)) diffs.push('milestone');
    // Every GitLab comment's content: the body and the migrated comments are exactly what is wanted.
    if (!forms.some((f) => matchesShape(f, gh.body, migrated))) {
      const near = forms.find((f) => f.comments.length === migrated.length) ?? forms[0];
      if (near.body !== gh.body) diffs.push('body');
      if (near.comments.length !== migrated.length)
        diffs.push(`${near.comments.length} migrated comment(s) wanted, ${migrated.length} there`);
      else if (near.comments.some((c, i) => c !== migrated[i].body)) diffs.push('comment text');
    }
    if (diffs.length) mismatches.push({ iid: n, number: gh.number, why: diffs.join(', ') });
  }
  return { checked, mismatches, pending };
}

// ---------------------------------------------------------------------------------------------------------
// Reading — GitLab (GET only) and GitHub
// ---------------------------------------------------------------------------------------------------------

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

/** A GitLab reader that can only GET. Nothing in this script writes to GitLab. */
export function gitlabReader(env, root, fetchImpl = fetch) {
  const cfg = gitlabConfig(env, root);
  // A read is safe to repeat, so a dropped connection, a slow answer or a 5xx is tried again, four times, before the
  // run gives up: a full read is about 800 requests, and one timeout among them should not end it.
  const get = async (urlPath, opts = {}) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await getOnce(urlPath, opts);
      } catch (e) {
        const again = e instanceof BoardError && (e.transient || e.status >= 500);
        if (!again || attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
      }
    }
  };
  const getOnce = async (urlPath, { raw = false } = {}) => {
    if (!cfg.baseUrl || !cfg.token || !cfg.projectId)
      throw new BoardError('GitLab is not configured (.env.gitlab, or --gitlab-root=)', 'misconfigured');
    const url =
      urlPath.startsWith('/projects') || urlPath === '/user' ? `${cfg.baseUrl}/api/v4${urlPath}` : urlPath;
    const res = await fetchWithin(
      fetchImpl,
      url,
      { method: 'GET', headers: { 'PRIVATE-TOKEN': cfg.token } },
      { timeoutMs: cfg.timeoutMs, name: 'GitLab' },
    );
    if (!res.ok) {
      const code =
        res.status === 404
          ? 'not-found'
          : res.status === 401
            ? 'unauthenticated'
            : res.status === 403
              ? 'forbidden'
              : 'http_error';
      throw new BoardError(
        `GitLab GET ${urlPath.replace(cfg.baseUrl, '')} answered ${res.status}`,
        code,
        res.status,
      );
    }
    return raw ? Buffer.from(await res.arrayBuffer()) : res.json();
  };
  const project = `/projects/${encodeURIComponent(cfg.projectId)}`;
  const all = async (urlPath) => {
    const out = [];
    for (let page = 1; ; page++) {
      const batch = await get(
        `${project}${urlPath}${urlPath.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
      );
      out.push(...batch);
      if (batch.length < 100) return out;
    }
  };
  return { cfg, get, all, project };
}

/** The GitLab board as a snapshot planSync reads. */
export async function readGitlab(gl, { through = Number.POSITIVE_INFINITY } = {}) {
  const proj = await gl.get(gl.project);
  const me = await gl.get('/user');
  const raw = await gl.all('/issues?state=all&order_by=created_at&sort=asc');
  const labels = new Map(
    (await gl.all('/labels')).map((l) => [l.name, { color: l.color, description: l.description ?? '' }]),
  );
  const milestones = new Map(
    (await gl.all('/milestones?state=all')).map((m) => [
      m.title,
      { due: m.due_date ?? null, state: m.state === 'closed' ? 'closed' : 'open' },
    ]),
  );
  const byIid = new Map(raw.map((i) => [i.iid, i]));
  const maxIid = Math.max(0, ...byIid.keys());
  // A number the listing skipped is asked for directly: a deleted item answers 404 and gets a placeholder,
  // anything else the listing left out is copied like the rest.
  for (let n = 1; n <= Math.min(maxIid, through); n++) {
    if (byIid.has(n)) continue;
    try {
      byIid.set(n, await gl.get(`${gl.project}/issues/${n}`));
    } catch (e) {
      if (!(e instanceof BoardError && e.code === 'not-found')) throw e;
    }
  }
  const wanted = [...byIid.values()].filter((i) => i.iid <= through);
  const items = new Map();
  await pool(wanted, 3, async (i) => {
    const notes = (await gl.all(`/issues/${i.iid}/notes?sort=asc&order_by=created_at`)).filter(
      (n) => !n.system,
    );
    let links = [];
    try {
      links = (await gl.get(`${gl.project}/issues/${i.iid}/links`))
        .filter((l) => l.project_id === proj.id)
        .map((l) => l.iid);
    } catch {
      /* linked issues unavailable */
    }
    items.set(i.iid, {
      iid: i.iid,
      id: i.id,
      title: i.title,
      description: i.description ?? '',
      state: i.state === 'closed' ? 'closed' : 'open',
      confidential: i.confidential !== false,
      labels: [...(i.labels ?? [])].sort(),
      milestone: i.milestone?.title ?? null,
      author: i.author?.username ?? '',
      authorId: i.author?.id ?? null,
      createdAt: i.created_at,
      updatedAt: i.updated_at,
      url: i.web_url.replace(/\/-\/work_items\//, '/-/issues/'),
      links,
      comments: notes
        .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id)
        .map((n) => ({
          id: n.id,
          authorId: n.author?.id ?? null,
          author: n.author?.username ?? '',
          body: n.body ?? '',
          createdAt: n.created_at,
        })),
    });
  });
  const releases = (await gl.all('/releases'))
    .map((r) => ({
      tag: r.tag_name,
      name: r.name ?? r.tag_name,
      description: r.description ?? '',
      releasedAt: r.released_at ?? r.created_at,
      url: r._links?.self ?? `${proj.web_url}/-/releases/${encodeURIComponent(r.tag_name)}`,
      links: (r.assets?.links ?? []).map((l) => ({ name: l.name, url: l.direct_asset_url ?? l.url })),
      milestones: (r.milestones ?? []).map((m) => m.title),
    }))
    .sort((a, b) => a.releasedAt.localeCompare(b.releasedAt));
  return {
    url: proj.web_url,
    path: proj.path_with_namespace,
    botId: me.id,
    labels,
    milestones,
    items,
    maxIid,
    releases,
  };
}

/**
 * The migration's GitHub client: the shared installation client (`createInstallationClient` in
 * scripts/board/github.mjs), with what a run of hours needs from it, and a guard on every write.
 *
 * - **Retries** on reads and token mints, four of them, after a timeout or a 5xx: a full read is hundreds of
 *   requests, and one bad answer among them should not end it. Writes are never repeated; a run that meets
 *   a failure reads both boards again and plans again instead (`main`).
 * - **Thirty seconds** to answer rather than the adapter's eight: a 60,000-character body takes a while on
 *   a bad day.
 * - **The guard.** `write`, `gitRemote` and `uploadAsset` refuse a protected repository (`protect`) unless
 *   the run was allowed to write there (`allowProtected`, which `--cutover` sets).
 */
export function migrationClient(
  env,
  root,
  { fetch: fetchImpl, now, sleep, allowProtected = false, protect = [] } = {},
) {
  const client = createInstallationClient(env, root, {
    fetch: fetchImpl,
    now,
    sleep,
    timeoutMs: Math.max(githubConfig(env, root).timeoutMs, 30_000),
    retries: 4,
  });
  const { cfg, repo } = client;
  const refuse = (what) => {
    if (protect.includes(cfg.repository.trim().toLowerCase()) && !allowProtected)
      throw new BoardError(
        `refused: a ${what} to ${cfg.repository}, a protected repository, without --cutover`,
        'forbidden',
      );
  };
  const get = (p, scope = 'board') => client.api(p, { scope });
  const all = (p, scope = 'board') => client.all(p, scope);
  async function write(p, method, body, scope = 'board') {
    refuse('write');
    return client.api(p, { method, body, scope });
  }
  /**
   * What `git push` needs: the repository's HTTPS address (no credentials in it) and an installation token
   * with Contents write, for GIT_ASKPASS to hand over. Refused on a protected repository like a write.
   */
  async function gitRemote() {
    refuse('push');
    const web =
      cfg.apiUrl === 'https://api.github.com' ? 'https://github.com' : cfg.apiUrl.replace(/\/api\/v3$/, '');
    return { url: `${web}/${cfg.repository}.git`, token: await client.token('assets') };
  }
  /** A release asset: raw bytes to the release's upload URL, with Contents write. Refused like a write. */
  async function uploadAsset(uploadUrl, { name, label, bytes, type = 'application/octet-stream' }) {
    refuse('write');
    const u = `${uploadUrl.replace(/\{.*\}$/, '')}?name=${encodeURIComponent(name)}${label ? `&label=${encodeURIComponent(label)}` : ''}`;
    return client.api(u, { method: 'POST', raw: { bytes, type }, scope: 'assets' });
  }
  return { cfg, repo, get, all, write, botId: client.botId, gitRemote, uploadAsset };
}

// ---------------------------------------------------------------------------------------------------------
// Assets — pushed with git, in batches
// ---------------------------------------------------------------------------------------------------------

const ASSET_BATCH_ITEMS = 50;

/**
 * The environment for a git of our own: the caller's, less every `GIT_*` variable. A git hook exports
 * `GIT_DIR` (and `GIT_INDEX_FILE`, `GIT_WORK_TREE`) to everything it starts, and git honours `GIT_DIR` over
 * `-C` and over `init`'s directory: under `pre-push`, a selftest's `git init --bare <tmp>` once
 * re-initialised the developer's own repository as bare instead.
 */
export function gitEnv(base = process.env) {
  return Object.fromEntries(Object.entries(base).filter(([k]) => !k.startsWith('GIT_')));
}

/**
 * git in a scratch bare clone, with the token kept out of argv, the remote URL and the logs: GIT_ASKPASS
 * names a two-line script that reads it from the environment, every credential helper is switched off so
 * nothing stores it, and any error text has it scrubbed before it is thrown.
 */
export function gitIn(dir, token) {
  const askpass = path.join(path.dirname(dir), 'askpass.sh');
  if (token && !fs.existsSync(askpass)) {
    fs.writeFileSync(
      askpass,
      '#!/bin/sh\ncase "$1" in\n  *sername*) echo x-access-token ;;\n  *) printf \'%s\\n\' "$BOARD_MIGRATE_GIT_TOKEN" ;;\nesac\n',
      { mode: 0o700 },
    );
  }
  const env = {
    ...gitEnv(),
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'board-migrate',
    GIT_AUTHOR_EMAIL: 'board-migrate@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'board-migrate',
    GIT_COMMITTER_EMAIL: 'board-migrate@users.noreply.github.com',
    ...(token ? { GIT_ASKPASS: askpass, BOARD_MIGRATE_GIT_TOKEN: token } : {}),
  };
  const scrub = (t) => (token ? String(t).split(token).join('***') : String(t));
  // stdin is closed: a file goes to git by its path, never through a pipe (one hung there for good).
  return (args, { extraEnv } = {}) => {
    try {
      return execFileSync('git', ['-c', 'credential.helper=', '-C', dir, ...args], {
        env: { ...env, ...extraEnv },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 256 * 1024 * 1024,
      })
        .toString()
        .trim();
    } catch (e) {
      throw new BoardError(`git ${args[0]} failed: ${scrub(e.stderr || e.message).trim()}`, 'http_error');
    }
  };
}

/**
 * Push `uploads` to `board-assets` with git: download each from GitLab (kept in `workDir`, so an
 * interrupted run downloads it once), write it as a blob, and commit in batches of `batchItems` items or
 * `batchBytes` bytes, pushing after each. Commits are built with plumbing on a partial clone that never
 * downloads the files already on the branch. A file already at its path is not pushed again.
 *
 * A push the server refuses for any reason but a moved branch stops the run: there is no fallback to the
 * REST upload, whose 500-an-hour limit is what this replaces.
 */
export async function stageAssets(
  uploads,
  { workDir, remote, fetchBytes, batchItems = 50, batchBytes = 50e6, log = () => {} },
) {
  const result = { files: 0, commits: 0, pushes: 0, bytes: 0 };
  if (!uploads.length) return result;
  fs.mkdirSync(workDir, { recursive: true });
  const dir = path.join(workDir, 'board-assets.git');
  const git = gitIn(dir, remote.token);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir);
    git(['init', '--bare', '-q']);
    git(['remote', 'add', 'origin', remote.url]);
    git(['config', 'remote.origin.promisor', 'true']);
    git(['config', 'remote.origin.partialclonefilter', 'blob:none']);
    // Without these, git counts the files it chose not to download as missing and refuses to push.
    git(['config', 'core.repositoryformatversion', '1']);
    git(['config', 'extensions.partialClone', 'origin']);
  }
  const ref = `refs/heads/${ASSETS_BRANCH}`;
  const fetchHead = () => {
    const out = git(['ls-remote', 'origin', ref]);
    if (!out) return null;
    git(['fetch', '-q', '--filter=blob:none', 'origin', `+${ref}:${ref}`]);
    return git(['rev-parse', ref]);
  };
  let head = fetchHead();
  const present = new Set(
    head ? git(['ls-tree', '-r', '--name-only', head]).split('\n').filter(Boolean) : [],
  );
  const todo = uploads.filter((u) => !present.has(u.path));
  const downloads = path.join(workDir, 'downloads');
  /** The upload's file in the download cache, fetched from GitLab the first time. */
  const fileOf = async (u) => {
    const cached = path.join(downloads, u.secret, u.name);
    // uploadFile() already refused such a name; this holds even for a caller that did not ask it (#32).
    if (
      path.dirname(path.resolve(cached)) !== path.resolve(downloads, u.secret) ||
      !/^[0-9a-f]{32}$/.test(u.secret)
    )
      throw new BoardError(
        `refusing upload ${u.secret}/${u.name}: it names a path outside the cache`,
        'unsafe-path',
      );
    if (fs.existsSync(cached)) return cached;
    const bytes = await fetchBytes(u);
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    // `u.iid` is a release's `release <tag>` too, and a tag may hold a `/`.
    const part = `${cached}.${String(u.iid).replace(/[^\w.-]+/g, '_')}.part`;
    fs.writeFileSync(part, bytes);
    fs.renameSync(part, cached);
    return cached;
  };
  const index = path.join(workDir, 'index');
  const readme = () => {
    const file = path.join(workDir, 'README.md');
    fs.writeFileSync(file, ASSETS_README);
    return file;
  };
  const commit = (parent, entries, message) => {
    fs.rmSync(index, { force: true });
    const extraEnv = { GIT_INDEX_FILE: index };
    git(parent ? ['read-tree', parent] : ['read-tree', '--empty'], { extraEnv });
    for (const [sha, where] of entries)
      git(['update-index', '--add', '--cacheinfo', `100644,${sha},${where}`], { extraEnv });
    const tree = git(['write-tree'], { extraEnv });
    return git(['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message]);
  };
  const push = (entries, message) => {
    for (let attempt = 0; ; attempt++) {
      const next = commit(head, entries, message);
      try {
        git(['push', '-q', 'origin', `${next}:${ref}`]);
        head = next;
        git(['update-ref', ref, next]);
        result.commits++;
        result.pushes++;
        return;
      } catch (e) {
        // Somebody else moved the branch (a `screenshots` run): build the batch again on top of theirs.
        if (!/non-fast-forward|fetch first|rejected/.test(e.message) || attempt >= 3) {
          throw new BoardError(
            `pushing to ${ASSETS_BRANCH} was refused; nothing is uploaded another way. ${e.message}`,
            'forbidden',
          );
        }
        head = fetchHead();
      }
    }
  };
  // Download everything first, three at a time, into the cache; the commits below read it back.
  let fetched = 0;
  await pool(todo, 3, async (u) => {
    await fileOf(u);
    if (++fetched % 200 === 0) log(`  downloaded ${fetched}/${todo.length} upload(s)`);
  });
  if (!head)
    push([[git(['hash-object', '-w', '--', readme()]), 'README.md']], 'chore: start the board-assets branch');
  let batch = [];
  let items = new Set();
  let size = 0;
  const flush = () => {
    if (!batch.length) return;
    push(batch, `chore: board migration assets for ${[...items].map((i) => `#${i}`).join(' ')}`);
    log(`  pushed ${batch.length} file(s) for ${items.size} item(s)`);
    batch = [];
    items = new Set();
    size = 0;
  };
  for (const u of todo) {
    if (!items.has(u.iid) && (items.size >= batchItems || size >= batchBytes)) flush();
    const file = await fileOf(u);
    const bytes = fs.statSync(file).size;
    batch.push([git(['hash-object', '-w', '--', file]), u.path]);
    items.add(u.iid);
    size += bytes;
    result.files++;
    result.bytes += bytes;
  }
  flush();
  return result;
}

/**
 * GitHub's newest pull request, or null. Pull requests take numbers from the same sequence as issues, and the
 * board token cannot see them, so this is read with the mr token. A refusal stops the run: without it the
 * next number GitHub hands out is not known.
 */
export async function newestPullRequest(gh) {
  try {
    const [pr] = await gh.get(`${gh.repo}/pulls?state=all&sort=created&direction=desc&per_page=1`, 'mr');
    return pr ?? null;
  } catch (e) {
    throw new BoardError(
      `reading GitHub's newest pull request failed (${e.message}). Pull requests share the issues' numbers, so the next number is not known without it. Stopped.`,
      e instanceof BoardError ? e.code : 'http_error',
      e instanceof BoardError ? e.status : undefined,
    );
  }
}

/** The GitHub side as a snapshot planSync reads. Three listings and the newest pull request, whatever the board's size. */
export async function readGithub(gh) {
  const issues = new Map();
  for (const i of await gh.all(`${gh.repo}/issues?state=all&per_page=100`)) {
    issues.set(i.number, {
      number: i.number,
      isPr: Boolean(i.pull_request),
      authorId: i.user?.id ?? null,
      title: i.title,
      body: i.body ?? '',
      state: i.state === 'closed' ? 'closed' : 'open',
      labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)).sort(),
      milestone: i.milestone?.title ?? null,
      comments: [],
    });
  }
  for (const c of await gh.all(`${gh.repo}/issues/comments?sort=created&direction=asc&per_page=100`)) {
    const n = Number(/\/issues\/(\d+)$/.exec(c.issue_url)?.[1]);
    issues.get(n)?.comments.push({ id: c.id, authorId: c.user?.id ?? null, body: c.body ?? '' });
  }
  const milestones = new Map(
    (await gh.all(`${gh.repo}/milestones?state=all&per_page=100`)).map((m) => [m.title, m.number]),
  );
  const labels = new Set((await gh.all(`${gh.repo}/labels?per_page=100`)).map((l) => l.name));
  let assets = [];
  try {
    const tree = await gh.get(`${gh.repo}/git/trees/${ASSETS_BRANCH}?recursive=1`, 'assets');
    assets = tree.tree.filter((t) => t.type === 'blob').map((t) => t.path);
  } catch (e) {
    if (!(e instanceof BoardError && (e.code === 'not-found' || e.status === 409))) throw e;
  }
  // The listing can trail a create by minutes when GitHub is degraded, and it then also left out an issue
  // that existed for good (#73 on the live run). So every hole below the listing's highest, and every
  // number past it until one answers 404, is asked for by number. Otherwise a create that answered 5xx but
  // happened would be made again, and a missing issue would read as somebody else's number.
  //
  // Pull requests share the numbering, and the board token (issues, metadata) cannot see them: the listing
  // leaves them out and `issues/<n>` answers 403 for one. So a 403 there is asked
  // again as a pull request with the mr token. A pull request is a number taken by something not migrated;
  // a 404 there too is a deleted number, as before; a refusal stops the run, because the number is then
  // unaccounted for.
  const byNumber = async (n) => {
    try {
      return await gh.get(`${gh.repo}/issues/${n}`);
    } catch (e) {
      if (e instanceof BoardError && e.code === 'not-found') return null;
      if (!(e instanceof BoardError && e.code === 'forbidden')) throw e;
      try {
        return { ...(await gh.get(`${gh.repo}/pulls/${n}`, 'mr')), pull_request: {} };
      } catch (pe) {
        if (pe instanceof BoardError && pe.code === 'not-found') return null;
        throw new BoardError(
          `GitHub #${n} is refused to the board token (${e.message}), and reading it as a pull request failed too (${pe.message}). Its number cannot be accounted for. Stopped.`,
          pe instanceof BoardError ? pe.code : 'http_error',
          pe instanceof BoardError ? pe.status : undefined,
        );
      }
    }
  };
  const addOne = async (i) => {
    const comments = i.pull_request
      ? []
      : await gh.all(`${gh.repo}/issues/${i.number}/comments?per_page=100`);
    issues.set(i.number, {
      number: i.number,
      isPr: Boolean(i.pull_request),
      authorId: i.user?.id ?? null,
      title: i.title,
      body: i.body ?? '',
      state: i.state === 'closed' ? 'closed' : 'open',
      labels: (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)).sort(),
      milestone: i.milestone?.title ?? null,
      comments: comments.map((c) => ({ id: c.id, authorId: c.user?.id ?? null, body: c.body ?? '' })),
    });
  };
  // The newest pull request counts towards the highest number: one above a deleted number would
  // otherwise go unseen, the scan below stopping at that number's 404, and every create would shift.
  const newestPr = await newestPullRequest(gh);
  if (newestPr && !issues.has(newestPr.number)) await addOne({ ...newestPr, pull_request: {} });
  const listed = Math.max(0, ...issues.keys());
  for (let n = 1; n < listed; n++) {
    if (issues.has(n)) continue;
    const i = await byNumber(n);
    if (i) await addOne(i);
  }
  for (let n = listed + 1; ; n++) {
    const i = await byNumber(n);
    if (!i) break;
    await addOne(i);
  }
  const maxNumber = Math.max(0, ...issues.keys());
  // Releases need Contents read, which is the assets scope's; tags are read as refs.
  const releases = (await gh.all(`${gh.repo}/releases?per_page=100`, 'assets')).map((r) => ({
    id: r.id,
    tag: r.tag_name,
    name: r.name ?? '',
    body: r.body ?? '',
    draft: Boolean(r.draft),
    prerelease: Boolean(r.prerelease),
    uploadUrl: r.upload_url,
    assets: (r.assets ?? []).map((a) => ({ id: a.id, name: a.name, label: a.label ?? '' })),
  }));
  let latest = null;
  try {
    latest = (await gh.get(`${gh.repo}/releases/latest`, 'assets')).tag_name;
  } catch (e) {
    if (!(e instanceof BoardError && e.code === 'not-found')) throw e;
  }
  let tags = [];
  try {
    tags = (await gh.all(`${gh.repo}/git/matching-refs/tags/?per_page=100`, 'assets')).map((r) =>
      r.ref.replace(/^refs\/tags\//, ''),
    );
  } catch (e) {
    if (!(e instanceof BoardError && (e.code === 'not-found' || e.status === 409))) throw e;
  }
  return {
    repository: gh.cfg.repository,
    botId: await gh.botId(),
    issues,
    milestones,
    labels,
    assets: new Set(assets),
    maxNumber,
    releases,
    latest,
    tags: new Set(tags),
  };
}

// ---------------------------------------------------------------------------------------------------------
// Applying — paced
// ---------------------------------------------------------------------------------------------------------

/**
 * At most one write a second and `perHour` in any rolling hour: under GitHub's secondary limits for
 * creating content (80 a minute, 500 an hour). A `rate-limited` answer waits for what GitHub asked for.
 */
export function pacer({
  perHour = 450,
  minGapMs = 1000,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  const stamps = [];
  let last = 0;
  return async function paced(fn) {
    for (let attempt = 0; ; attempt++) {
      const t = now();
      while (stamps.length && t - stamps[0] >= 3600e3) stamps.shift();
      let wait = Math.max(0, last + minGapMs - t);
      if (stamps.length >= perHour) wait = Math.max(wait, stamps[0] + 3600e3 - t);
      if (wait) await sleep(wait);
      last = now();
      stamps.push(last);
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof BoardError && e.code === 'rate-limited') || attempt >= 5) throw e;
        await sleep(Math.max(1000, e.retryAfterMs ?? 60_000));
      }
    }
  };
}

/**
 * Make the planned REST writes, after `stageAssets` has pushed the uploads. Bodies are rendered here from
 * the source, so a write always carries what is wanted now. Stops at the first mismatch in numbering.
 */
export async function applyPlan(
  plan,
  source,
  target,
  gh,
  { paced, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), gl = null },
) {
  let lastMade = 0;
  const ctx = plan.ctx;
  const milestoneNo = new Map(target.milestones);
  // The assets were pushed before any of these writes, so they are all on the branch now.
  const pushedPaths = new Set([...target.assets, ...(plan.uploads ?? []).map((u) => u.path)]);
  const idx = assetIndex({ assets: pushedPaths });
  idx.paths = pushedPaths;
  const releaseAt = new Map();
  const resolver = (iid) => assetResolver(source.items.get(iid), idx, target.repository, ctx.gitlabUrl);
  // A write carries `remap: true` when the item is kept in its remapped form by a normal run.
  const shape = (iid, remap) =>
    desired(source.items.get(iid), remap ? { ...ctx, remap: true } : ctx, resolver(iid), {
      fold: plan.fold !== false,
    });
  const bodyOf = (s, remap) => shape(s.iid, remap).body;
  const commentOf = (w) => {
    const text = shape(w.iid, w.remap).comments[w.index];
    if (text == null)
      throw new BoardError(
        `GitLab #${w.iid}: comment ${w.index} is no longer wanted. Stopped.`,
        'misconfigured',
      );
    return text;
  };

  const numberOf = (iid) => ctx.mapping.get(iid);
  let done = 0;
  for (const w of plan.writes) {
    switch (w.op) {
      case 'ensure-label':
        await paced(() =>
          gh.write(`${gh.repo}/labels`, 'POST', {
            name: w.name,
            color: w.color,
            description: w.description.slice(0, 100),
          }),
        );
        break;
      case 'create-milestone': {
        const m = await paced(() =>
          gh.write(`${gh.repo}/milestones`, 'POST', {
            title: w.title,
            state: w.state,
            ...(w.due ? { due_on: `${w.due}T12:00:00Z` } : {}),
          }),
        );
        milestoneNo.set(w.title, m.number);
        break;
      }
      case 'create-issue': {
        // Before: the newest issue or pull request must be the one just before this one. GitHub's listing
        // can trail a create by a few seconds, so the last number this run made counts too, and a listing
        // that is still behind is asked again before the run gives up. One that is AHEAD stops it at once.
        let highest = 0;
        for (let attempt = 0; attempt < 4; attempt++) {
          const [newest] = await gh.get(`${gh.repo}/issues?state=all&sort=created&direction=desc&per_page=1`);
          // The board token's listing leaves pull requests out, so the newest one is read on its own.
          const newestPr = await newestPullRequest(gh);
          highest = Math.max(newest?.number ?? 0, newestPr?.number ?? 0, lastMade);
          if (highest >= w.expect - 1) break;
          await sleep(2000);
        }
        if (highest !== w.expect - 1)
          throw new BoardError(
            `before GitLab #${w.iid}: GitHub's highest number is #${highest}, want #${w.expect - 1}. Stopped.`,
            'misconfigured',
          );
        const body = w.placeholder ? placeholderBody(w.iid, ctx) : bodyOf(w.source);
        const made = await paced(() =>
          gh.write(`${gh.repo}/issues`, 'POST', {
            title: w.title,
            body,
            labels: w.labels,
            ...(w.milestone ? { milestone: milestoneNo.get(w.milestone) } : {}),
          }),
        );
        lastMade = made.number;
        if (made.number !== w.expect)
          throw new BoardError(
            `GitLab #${w.iid} came back as GitHub #${made.number}, want #${w.expect}. Stopped.`,
            'misconfigured',
          );
        break;
      }
      case 'edit-issue':
        await paced(() =>
          gh.write(`${gh.repo}/issues/${numberOf(w.iid)}`, 'PATCH', {
            ...(w.title ? { title: w.title } : {}),
            ...(w.body ? { body: bodyOf(w.source, w.remap) } : {}),
          }),
        );
        break;
      case 'set-labels':
        await paced(() => gh.write(`${gh.repo}/issues/${numberOf(w.iid)}`, 'PATCH', { labels: w.labels }));
        break;
      case 'set-milestone':
        await paced(() =>
          gh.write(`${gh.repo}/issues/${numberOf(w.iid)}`, 'PATCH', {
            milestone: w.milestone ? milestoneNo.get(w.milestone) : null,
          }),
        );
        break;
      case 'comment':
        await paced(() =>
          gh.write(`${gh.repo}/issues/${numberOf(w.iid)}/comments`, 'POST', { body: commentOf(w) }),
        );
        break;
      case 'delete-comment':
        await paced(() => gh.write(`${gh.repo}/issues/comments/${w.commentId}`, 'DELETE'));
        break;
      case 'edit-comment':
        await paced(() =>
          gh.write(`${gh.repo}/issues/comments/${w.commentId}`, 'PATCH', { body: commentOf(w) }),
        );
        break;
      case 'set-state':
        await paced(() =>
          gh.write(`${gh.repo}/issues/${numberOf(w.iid)}`, 'PATCH', {
            state: w.state,
            ...(w.state === 'closed' ? { state_reason: w.reason ?? 'completed' } : {}),
          }),
        );
        break;
      case 'create-release':
      case 'edit-release': {
        const r = source.releases.find((x) => x.tag === w.tag);
        const body = releaseBody(r, ctx, {
          repository: target.repository,
          milestoneNumber: milestoneNo.get(r.milestones[0]) ?? null,
          assets: idx.paths,
        });
        // Never a target_commitish: the tag exists (planReleases), and GitHub would otherwise make one.
        const fields = {
          name: r.name,
          body,
          draft: false,
          prerelease: false,
          make_latest: w.latest ? 'true' : 'false',
        };
        const made = await paced(() =>
          w.op === 'create-release'
            ? gh.write(`${gh.repo}/releases`, 'POST', { tag_name: r.tag, ...fields }, 'assets')
            : gh.write(`${gh.repo}/releases/${w.id}`, 'PATCH', fields, 'assets'),
        );
        releaseAt.set(r.tag, made);
        break;
      }
      case 'release-asset': {
        const release =
          releaseAt.get(w.tag) ??
          (await gh.get(`${gh.repo}/releases/tags/${encodeURIComponent(w.tag)}`, 'assets'));
        const bytes = await fetchUpload(gl, source, w);
        await paced(() => gh.uploadAsset(release.upload_url, { name: w.name, label: w.label, bytes }));
        break;
      }
      case 'set-latest':
        await paced(() =>
          gh.write(`${gh.repo}/releases/${w.id}`, 'PATCH', { make_latest: 'true' }, 'assets'),
        );
        break;
      default:
        throw new Error(`unknown write ${w.op}`);
    }
    done++;
    if (done % 25 === 0) log(`  … ${done}/${plan.writes.length} writes`);
  }
  return done;
}

/**
 * The upload's bytes from GitLab. One GitLab no longer has is replaced by a short note saying so, so the
 * copy still exists and a rerun does not try it again forever.
 */
export async function fetchUpload(gl, source, w) {
  const missing = (e) => e instanceof BoardError && e.code === 'not-found';
  // One path segment, encoded once: the name in board text never adds a segment to an authorised request.
  if (!SECRET_RE.test(w.secret) || !uploadFile(w.file))
    throw new BoardError(`refusing upload ${w.secret}/${w.file}: not a single file name`, 'unsafe-path');
  const file = encodeURIComponent(safeDecode(w.file));
  try {
    return await gl.get(`${gl.project}/uploads/${w.secret}/${file}`, { raw: true });
  } catch (e) {
    if (!missing(e)) throw e;
  }
  try {
    return await gl.get(`${source.url}/uploads/${w.secret}/${file}`, { raw: true });
  } catch (e) {
    if (!missing(e)) throw e;
    return Buffer.from(`This upload (${w.file}) was no longer on GitLab when the board was migrated.\n`);
  }
}

// ---------------------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------------------

function printTotals(what, writes, perHour) {
  const t = tally(writes);
  const closes = writes.filter((w) => w.op === 'set-state' && w.state === 'closed').length;
  console.log(`\n${writes.length} REST writes ${what}:`);
  console.log(`  issues created        ${t['create-issue'] ?? 0}`);
  console.log(`  placeholders created  ${t['create-placeholder'] ?? 0}`);
  console.log(`  closes                ${closes}`);
  console.log(`  comments              ${t.comment ?? 0}`);
  const reopens = (t['set-state'] ?? 0) - closes;
  const rest = Object.entries(t).filter(
    ([k]) => !['create-issue', 'create-placeholder', 'comment', 'set-state'].includes(k),
  );
  for (const [k, v] of [...rest, ...(reopens ? [['reopens', reopens]] : [])])
    console.log(`  ${k.padEnd(21)} ${v}`);
  console.log(
    `  expected duration at 1 write/s and ${perHour}/h: ${hms(expectedSeconds(writes.length, perHour))}`,
  );
}

function printPlan(plan, source, target, perHour, unfolded) {
  console.log(
    `target ${target.repository}: highest number #${target.maxNumber}, ${target.issues.size} issues and pull requests`,
  );
  const { collisions } = mappingOf(source, target);
  console.log(
    `collision range (numbers taken by something not migrated): ${
      [...collisions]
        .sort((a, b) => a - b)
        .map((n) => `#${n}`)
        .join(' ') || 'none'
    }`,
  );
  if (plan.stop) {
    console.log(`\n✖ ${plan.stop}`);
    return;
  }
  const creates = plan.writes.filter((w) => w.op === 'create-issue');
  if (creates.length) {
    const first = creates[0];
    const last = creates[creates.length - 1];
    console.log(`creates GitLab #${first.iid}…#${last.iid} as GitHub #${first.expect}…#${last.expect}`);
    const moved = creates.filter((w) => w.iid !== w.expect);
    for (const w of moved) console.log(`  GitLab #${w.iid} → GitHub #${w.expect} (collision range)`);
    const holes = creates.filter((w) => w.placeholder);
    if (holes.length) console.log(`placeholders for GitLab #${holes.map((w) => w.iid).join(', #')}`);
  }
  if (plan.skipped.length)
    console.log(`skipped (collision range, --append-collisions to create): #${plan.skipped.join(' #')}`);
  if (plan.confidential.length) {
    console.log(
      `\nCONFIDENTIAL on GitLab, copied in full and labelled \`confidential\` (${plan.confidential.length}):`,
    );
    for (const c of plan.confidential) console.log(`  #${c.iid}`);
  }
  const rels = plan.writes.filter((w) => w.op.includes('release') || w.op === 'set-latest').length;
  console.log(
    `\nreleases: ${(source.releases ?? []).length} on GitLab; ${rels} release write(s) below` +
      (plan.refusedReleases?.length
        ? `; REFUSED, the tag is not on ${target.repository}: ${plan.refusedReleases.join(' ')}`
        : '; every tag is on the target'),
  );
  if (plan.refusedUploads?.length) {
    console.log(
      `\nREFUSED upload links, left pointing at GitLab (not a single file name; look before archiving GitLab):`,
    );
    for (const r of plan.refusedUploads) console.log(`  ${r.where}  ${JSON.stringify(r.file)}`);
  }
  printTotals('with comments folded', plan.writes, perHour);
  if (unfolded) printTotals('without folding, for comparison', unfolded.writes, perHour);
  const pushes = Math.ceil(new Set(plan.uploads.map((u) => u.iid)).size / ASSET_BATCH_ITEMS);
  console.log(
    `\nassets: ${plan.uploads.length} file(s) for ${new Set(plan.uploads.map((u) => u.iid)).size} item(s), pushed with git ` +
      `in about ${pushes} push(es) of up to ${ASSET_BATCH_ITEMS} items or 50 MB (more if the files are large), not REST`,
  );
}

async function main(argv) {
  const flags = new Set(argv.filter((a) => !a.includes('=')));
  const value = (k) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const known = ['--dry-run', '--verify', '--mapping', '--remap', '--append-collisions', '--cutover'];
  for (const f of flags) if (!known.includes(f)) throw new BoardError(`unknown flag ${f}`, 'misconfigured');
  for (const a of argv.filter((x) => x.includes('='))) {
    if (
      !['--through', '--repo', '--gitlab-root', '--max-per-hour', '--work-dir'].some((k) =>
        a.startsWith(`${k}=`),
      )
    )
      throw new BoardError(`unknown option ${a}`, 'misconfigured');
  }
  const env = { ...process.env, ...(value('repo') ? { GITHUB_REPOSITORY: value('repo') } : {}) };
  const repository = envReader('.env.github', env, ROOT)('GITHUB_REPOSITORY').trim();
  const readOnly = flags.has('--dry-run') || flags.has('--verify') || flags.has('--mapping');
  const settings = readMigrateSettings(ROOT);
  const guard = (foreign) =>
    targetGuard({
      repository,
      repoFlag: value('repo'),
      cutover: flags.has('--cutover'),
      writes: !readOnly,
      protect: settings.protect,
      foreign,
    });
  const refused = guard(0);
  if (refused) {
    console.error(`✖ ${refused}`);
    return 1;
  }
  const perHour = value('max-per-hour') ? Number(value('max-per-hour')) : 450;
  if (!Number.isInteger(perHour) || perHour < 1 || perHour > MAX_PER_HOUR) {
    console.error(
      `✖ --max-per-hour must be a whole number from 1 to ${MAX_PER_HOUR} (GitHub's secondary limit)`,
    );
    return 1;
  }
  const through = value('through') ? Number(value('through')) : Number.POSITIVE_INFINITY;
  const started = Date.now();
  const gl = gitlabReader(process.env, path.resolve(value('gitlab-root') ?? ROOT));
  const gh = migrationClient(env, ROOT, {
    allowProtected: flags.has('--cutover'),
    protect: settings.protect,
  });
  // The links the tree carries are the ones `links.mjs --check` looks for, so the setting has to be this
  // project's URL; a stale one would let every link through the check.
  const sameProject = (url) => {
    if (settings.gitlab && settings.gitlab.toLowerCase() !== url.replace(/\/+$/, '').toLowerCase())
      throw new BoardError(
        `factoryKit.migrate.gitlab is ${settings.gitlab}, and GitLab says this project is ${url}: correct the setting`,
        'misconfigured',
      );
  };
  if (flags.has('--mapping')) {
    // stdout is the JSON alone, so it can be redirected into a file. GitLab is asked only for its URL.
    const [project, target] = await Promise.all([gl.get(gl.project), readGithub(gh)]);
    sameProject(project.web_url);
    console.log(JSON.stringify(mappingReport({ url: project.web_url }, target, repository), null, 2));
    return 0;
  }
  console.log(`reading GitLab ${gl.cfg.projectId} and GitHub ${repository} …`);
  const [source, target] = await Promise.all([readGitlab(gl, { through }), readGithub(gh)]);
  sameProject(source.url);
  console.log(
    `GitLab: ${source.items.size} items read (highest #${source.maxIid}), ${[...source.items.values()].reduce((s, i) => s + i.comments.length, 0)} comments — ${Math.round((Date.now() - started) / 1000)} s`,
  );

  if (flags.has('--verify')) {
    const { checked, mismatches, pending } = verify(source, target, {
      through,
      confidential: settings.confidential,
    });
    if (pending.length)
      console.log(`collision range, not yet created (--append-collisions): #${pending.join(' #')}`);
    for (const m of mismatches)
      console.log(`  #${m.iid}${m.number ? ` (GitHub #${m.number})` : ''}: ${m.why}`);
    console.log(`verify: ${checked} items checked, ${mismatches.length} mismatches`);
    const rv = verifyReleases(source, target);
    for (const m of rv.mismatches) console.log(`  release ${m.tag}: ${m.why}`);
    if (rv.refused.length)
      console.log(`releases refused, the tag is not on ${repository}: ${rv.refused.join(' ')}`);
    console.log(`verify: ${rv.checked} releases checked, ${rv.mismatches.length} mismatches`);
    return mismatches.length || rv.mismatches.length ? 1 : 0;
  }
  const planOpts = {
    through,
    appendCollisions: flags.has('--append-collisions'),
    remap: flags.has('--remap'),
    confidential: settings.confidential,
  };
  const plan = planSync(source, target, planOpts);
  const unfolded = flags.has('--dry-run') ? planSync(source, target, { ...planOpts, fold: false }) : null;
  printPlan(plan, source, target, perHour, unfolded);
  if (plan.stop) return 1;
  if (flags.has('--dry-run') || (!plan.writes.length && !plan.uploads.length)) return 0;
  // Now that the target is read: somebody else's issues and pull requests on it take --cutover too.
  const foreign = foreignNumbers(source, target);
  const late = guard(foreign.length);
  if (late) {
    console.error(`\n✖ ${late} (#${foreign.join(', #')}). Nothing was written.`);
    return 1;
  }

  const t0 = Date.now();
  const log = (s) => console.log(`${s} (${Math.round((Date.now() - t0) / 1000)} s)`);
  const workDir = path.resolve(
    value('work-dir') ?? path.join(os.tmpdir(), `board-migrate-${repository.replace('/', '-')}`),
  );
  const paced = pacer({ perHour });
  let current = { plan, source, target };
  let total = 0;
  // A failure on the way (GitHub or GitLab out of reach, a 5xx, a write that timed out) is met by reading
  // both boards again and planning again: what happened is on GitHub, so nothing is written twice.
  for (let round = 0; ; round++) {
    try {
      // Assets first, with git, so every body written after links to a file that is already there.
      const staged = await stageAssets(current.plan.uploads, {
        workDir,
        remote: await gh.gitRemote(),
        fetchBytes: (u) => fetchUpload(gl, current.source, u),
        batchItems: ASSET_BATCH_ITEMS,
        log,
      });
      console.log(
        `assets: ${staged.files} file(s), ${Math.round(staged.bytes / 1e6)} MB, in ${staged.pushes} push(es) — ${Math.round((Date.now() - t0) / 1000)} s`,
      );
      total += await applyPlan(current.plan, current.source, current.target, gh, { paced, log, gl });
      break;
    } catch (e) {
      const transient = e instanceof BoardError && (e.transient || e.status >= 500);
      if (!transient || round >= 3) throw e;
      console.log(`interrupted: ${e.message}. Reading both boards again in 60 s (round ${round + 2} of 4).`);
      await new Promise((r) => setTimeout(r, 60_000));
      const [s2, t2] = await Promise.all([readGitlab(gl, { through }), readGithub(gh)]);
      const p2 = planSync(s2, t2, planOpts);
      if (p2.stop) throw new BoardError(p2.stop, 'misconfigured');
      console.log(`replanned: ${p2.writes.length} REST writes, ${p2.uploads.length} upload(s) left`);
      current = { plan: p2, source: s2, target: t2 };
    }
  }
  console.log(`done: ${total} writes in ${Math.round((Date.now() - t0) / 1000)} s`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(await main(process.argv.slice(2)));
  } catch (e) {
    console.error(`migrate: ${e instanceof BoardError ? `${e.code} — ` : ''}${e?.message ?? e}`);
    process.exit(1);
  }
}

// `pnpm items release` — cut a release from the head of a branch, through a merge request to the default
// branch, then tag it and publish the notes. DEVELOPER TOOLING, like the rest of scripts/. Ported from the
// Makers Market, where it replaced a page of manual steps, and written against the board adapter, so it
// runs on GitLab and GitHub alike. `docs/agents/releasing.md` is the procedure around it.
//
// A release here is a point in time on a branch where work is built (a version line branch, `release-1.2.x`),
// taken whole to the branch that deploys (the default branch). Two commands, with a person's merge between:
//
//   prepare <release-X.Y.Z> --from=<branch> [--at=<sha>] [--include=…] [--exclude=…] [--name=…] [--notes] [--apply]
//     Works out which work items that commit delivers, and refuses if any of them is still open. Without
//     `--apply` it only prints — that dry run is the review, and `--notes` adds the draft notes to it. With
//     it: cuts `release/X.Y.Z` at the commit, commits the version bump and drafts of `docs/releases/X.Y.Z.md`
//     and `X.Y.Z.whats-new.md`, pushes, opens the merge request to the default branch, and only then
//     relabels the items `release-X.Y.Z`. Items it does not include keep the label they have.
//
//   finalize <release-X.Y.Z> [--no-whats-new]
//     After a person has merged: tags the merge commit, publishes the notes file as the release with the
//     "what's new" slides attached (whats-new.mjs), comments on and closes each item, closes the milestone,
//     and opens a merge request bringing the default branch back into the source branch. Safe to run again:
//     every step checks whether it is already done. With `requireWhatsNew` set, a release with no
//     what's-new file is refused unless `--no-whats-new` says that is the decision.
//
//   deck <release-X.Y.Z> [--out=<file.html>]
//     Renders this checkout's `docs/releases/X.Y.Z.whats-new.md` into the slides, for a look before the
//     merge. Writes a file and nothing else; FILL IN markers are reported, not refused.
//
// HOW AN ITEM IS FOUND. The commits between the default branch and the chosen commit name their merge
// requests (GitLab's `See merge request group/project!167`; GitHub's `Merge pull request #12 from …`, or a
// squash commit's `… (#12)`). A merge request delivers an item when its branch carries the number
// (`feat/243-…`), when a line of its description starts with it (a batch's table row, `| #240 |`, or a list
// item), or when the description says `Closes`/`Fixes`/`Delivers #N`. Any other mention is context —
// "rebased after #217", "update #184 afterwards" — and is printed for review rather than counted. The
// tracker's own "closes" link cannot be used: it answers only for merge requests that target the default
// branch, and every one of these targets the line branch. `--include`/`--exclude` override the detection,
// and what they did is written into the merge request, so the choice stays visible.
//
// WHY NOT SQUASH. The release merge request must be merged with a merge commit. A squash writes the whole
// branch onto the default branch as one new commit, so the next merge from the source branch conflicts
// with its own history and every commit hash cited in the docs stops existing on the default branch.
// `prepare` refuses on a project that cannot make a merge commit, and the merge request says so in bold.
//
// WHAT A PROJECT CONFIGURES, in `package.json` under `factoryKit.release` (all optional). Every setting
// but `hooks` is read at the release commit (the head `prepare` cuts from, the merge commit `finalize`
// tags): it describes that release, a person reviews it in the release merge request, and a rerun of
// `finalize` from any checkout reads the same value. `hooks` is read from the checkout, because it names
// code this checkout runs, and a module is loaded from disk, not from a commit.
//   configPaths  files and directories whose configuration keys the notes list (default: `.env.example`);
//                a file among them is also carried whole in the notes, folded
//   migrations   a regular expression for a new migration file's path (default: a `.sql` file in a
//                `migrations/` or `drizzle/` directory)
//   requireWhatsNew  true: `finalize` refuses a release with no what's-new file unless `--no-whats-new` is
//                given (default: false, and such a release gets no slides)
//   hooks        a project-owned module that adds to a release what is the project's alone (below)
//
// RELEASE HOOKS (docs/adr/0003-release-hooks-and-deck-markers.md). `hooks` names a module in this
// checkout, relative to the repository root. It is read from the checkout's package.json, not the release
// commit's, because it names code this checkout runs. It may export any of these, and nothing else:
//   flags          ['name', …]: extra `--name=value` (or bare `--name`) options; their values reach the
//                  other hooks as `flags`, a bare one as `true`
//   notes(s, { showAt, flags })  lines added to the notes after Notices; `s` is the survey (`version`,
//                  `label`, `from`, `head`, `base`, `target`, `items`, `included`, …), `showAt(ref, file)`
//                  a file's text at a commit or null. A FILL IN in them is enforced like any other
//   checklist(s, { flags })  extra "Before merging" lines in the release merge request, as plain text
//   beforeFinalize({ label, version, sha, release, deck, whatsNew, whatsNewRaw, flags, env })  runs
//                  after the kit's own refusals and before the tag or any write. `release` is null and `deck.url` is
//                  null, since neither exists yet. Anything but `{ ok: true }`, or a throw, refuses:
//                  nothing is tagged, published or closed
//   afterFinalize({ label, version, sha, release, deck, whatsNew, whatsNewRaw, flags, env })  runs after
//                  every other step. `deck` is `{ filename, html, url }` or null; `whatsNew` is the
//                  file's Markdown with administrators' content cut out (`withoutAdmin`), the form to
//                  publish, and `whatsNewRaw` the file as committed, admin content and all; both null
//                  with no file. `env(key)` is the board file's reader. It returns `{ ok, message }` or
//                  throws; anything but `{ ok: true }` is a failure, which leaves the release done, says
//                  so, exits 1, and a rerun retries only what the hook itself finds undone
// Any hook may be async. No `hooks` setting, no change: the release runs exactly as without one.
//
// The merge is a person's. Where merging the default branch deploys, merging the release deploys.
//
// Node builtins only.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BoardError } from './config.mjs';
import {
  DECK_LINK_NAME,
  deckFileName,
  draftWhatsNew,
  FILL_IN,
  parseDeck,
  renderDeck,
  whatsNewPath,
  withoutAdmin,
} from './whats-new.mjs';

// ---------------------------------------------------------------------------------------------------------
// Pure parts — asserted offline by `pnpm check:items`
// ---------------------------------------------------------------------------------------------------------

const RELEASE_TAG = /^release-(\d+\.\d+\.\d+)$/;

/** `release-1.2.3` → `1.2.3`; anything else → null. The label, the tag and the milestone share the name. */
export function versionOf(label) {
  return RELEASE_TAG.exec(label ?? '')?.[1] ?? null;
}

/** `feat/243-rotating-taglines` → 243. A branch with no leading number (`feat/batch-0.3.0-a`) → null. */
export function branchItem(branch) {
  const m = /^[\w.-]+\/(\d+)-/.exec(branch ?? '');
  return m ? Number(m[1]) : null;
}

const DELIVERY_VERB =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|deliver(?:s|ed)?|implement(?:s|ed)?)\s*:?\s+((?:#\d+(?:\s*(?:,|and|&)\s*)?)+)/gi;
const LEADING_REF = /^\s*(?:[-*+]\s+|\d+[.)]\s+|\|\s*)?(?:\*\*)?#(\d+)\b/;
const ANY_REF = /(?<![\w&!#])#(\d+)\b/g;
const HEADING = /^\s*(#{1,6})\s+(.*)$/;
const CAPTION = /^\s*\*\*([^*]+)\*\*:?\s*$/;
/** Sections a leading `#N` counts in. Before the first heading counts too. */
const DELIVERED_SECTION = /what|deliver|include|item|change|summary|scope|content/i;
/** Sections and captions where nothing counts: `**Follow-ups filed:**`, `**Risks worth a look:**`, … */
const ASIDE = /follow|raised|filed|later|risk|need|not (?:in|part)|out of scope|open|next|known/i;

/**
 * What a merge request's description says it delivered (`strong`), and what it merely mentions.
 *
 * Section-aware, because the same shape means opposite things in different places: `- #248: snippets`
 * under `## What` is a delivery, and the identical line under `**Follow-ups filed:**` is the opposite.
 * On Makers Market one merge request listed six follow-ups that way, and a line-by-line rule counted all six as
 * delivered. So a leading `#N` counts only before the first heading or under a heading like
 * What/Delivered/Items, and a `Closes #N` counts anywhere except under an aside. Fenced code is ignored: an
 * example is not a claim.
 */
export function deliveredRefs(description) {
  const text = (description ?? '').replace(/^```[\s\S]*?^```/gm, '');
  const strong = new Set();
  const mentioned = new Set();
  let delivered = true;
  let aside = false;
  let sectionLevel = 0;
  for (const line of text.split('\n')) {
    const h = HEADING.exec(line);
    const heading = h?.[2];
    if (heading != null) {
      // A deeper heading is a part of the section above it (`## What` then `### #250 part 1: …`), so it
      // keeps that section's standing; a heading at the same level or above starts a new section.
      const level = h[1].length;
      if (!sectionLevel || level <= sectionLevel) {
        sectionLevel = level;
        aside = ASIDE.test(heading);
        delivered = !aside && DELIVERED_SECTION.test(heading);
      } else if (ASIDE.test(heading)) {
        aside = true;
      }
      const named = /^#(\d+)\b/.exec(heading);
      if (named && delivered && !aside) strong.add(Number(named[1]));
    } else {
      const caption = CAPTION.exec(line)?.[1];
      if (caption != null && ASIDE.test(caption)) aside = true;
    }
    const lead = LEADING_REF.exec(line);
    if (lead && delivered && !aside) strong.add(Number(lead[1]));
    if (!aside) {
      for (const m of line.matchAll(DELIVERY_VERB)) {
        for (const n of m[1].matchAll(/#(\d+)/g)) strong.add(Number(n[1]));
      }
    }
    for (const m of line.matchAll(ANY_REF)) mentioned.add(Number(m[1]));
  }
  for (const n of strong) mentioned.delete(n);
  return { strong, mentioned };
}

/**
 * Which items a release includes, and everything a person should look at before agreeing.
 *
 * `mergeRequests`: Mrs (`{ iid, title, sourceBranch, description }`). `items`: iid → Item. Returns
 * `included` (each with the merge requests that delivered it), `open` (included and still open — the
 * refusal), `unknown` (named but not an item here), `mentioned` (context only, not included), `leftBehind`
 * (closed, labelled `releaseLabel`, and not delivered in this range) and `noItem` (merge requests that name
 * no item at all).
 */
export function selectItems({ mergeRequests, items, releaseLabel = null, include = [], exclude = [] }) {
  const byItem = new Map();
  const mentionedBy = new Map();
  const noItem = [];
  const add = (map, iid, mr) => map.set(iid, [...(map.get(iid) ?? []), mr]);
  for (const mr of mergeRequests) {
    const { strong, mentioned } = deliveredRefs(mr.description);
    const fromBranch = branchItem(mr.sourceBranch);
    if (fromBranch != null) {
      strong.add(fromBranch);
      mentioned.delete(fromBranch);
    }
    if (!strong.size) noItem.push(mr.iid);
    for (const iid of strong) add(byItem, iid, mr.iid);
    for (const iid of mentioned) add(mentionedBy, iid, mr.iid);
  }
  for (const iid of include) if (!byItem.has(iid)) byItem.set(iid, []);
  for (const iid of exclude) byItem.delete(iid);

  const included = [];
  const open = [];
  const unknown = [];
  for (const [iid, mrs] of [...byItem].sort((a, b) => a[0] - b[0])) {
    const item = items.get(iid);
    if (!item) {
      unknown.push(iid);
      continue;
    }
    included.push({ iid, mrs });
    if (item.state !== 'closed') open.push(iid);
  }
  const mentioned = [...mentionedBy]
    .filter(([iid]) => !byItem.has(iid) && items.has(iid))
    .sort((a, b) => a[0] - b[0])
    .map(([iid, mrs]) => ({ iid, mrs }));
  const leftBehind = releaseLabel
    ? [...items.values()]
        .filter((i) => i.state === 'closed' && (i.labels ?? []).includes(releaseLabel) && !byItem.has(i.iid))
        .map((i) => i.iid)
        .sort((a, b) => a - b)
    : [];
  return { included, open, unknown, mentioned, leftBehind, noItem };
}

/**
 * Configuration keys a unified diff adds, removes or changes: `NAME=` in an env file, `NAME:` in a YAML
 * map. A commented-out `# NAME=` counts, since that is how an env example documents an optional key.
 */
export function configKeys(diff) {
  const plus = new Set();
  const minus = new Set();
  for (const line of (diff ?? '').split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    const m = /^([+-])\s*#?\s*([A-Z][A-Z0-9_]{2,})\s*[=:]/.exec(line);
    if (!m) continue;
    (m[1] === '+' ? plus : minus).add(m[2]);
  }
  const rows = [];
  for (const k of new Set([...plus, ...minus])) {
    rows.push({ key: k, change: plus.has(k) && minus.has(k) ? 'CHANGE' : plus.has(k) ? 'ADD' : 'REMOVE' });
  }
  return rows.sort((a, b) => a.key.localeCompare(b.key));
}

/** The first `"version": "…"` in a package.json, replaced textually so the file's formatting survives. */
export function bumpVersion(text, to) {
  return text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${to}$2`);
}

/** A project's release settings from its package.json (`factoryKit.release`), with the defaults filled in. */
export function releaseSettings(pkg) {
  const own = pkg?.factoryKit?.release ?? {};
  return {
    configPaths: own.configPaths ?? ['.env.example'],
    migrations: new RegExp(own.migrations ?? String.raw`(^|/)(drizzle|migrations)/[^/]+\.sql$`),
    requireWhatsNew: own.requireWhatsNew === true,
    hooks: typeof own.hooks === 'string' && own.hooks ? own.hooks : null,
  };
}

const HOOK_NAMES = ['flags', 'notes', 'checklist', 'beforeFinalize', 'afterFinalize'];

/**
 * The project's release hooks, from the module `hooks` names (relative to `root`), checked against the
 * interface: an export by any other name, a hook that is not a function, or `flags` that is not a list of
 * names is refused, because a typo there would otherwise switch a project's release step off in silence.
 * No setting gives null. A named module that cannot be loaded throws: it is never treated as absent.
 */
export async function loadReleaseHooks(root, settings) {
  if (!settings?.hooks) return null;
  const file = path.resolve(root, settings.hooks);
  if (!fs.existsSync(file)) {
    throw new Error(`package.json names ${settings.hooks} as the release hooks, and there is no such file`);
  }
  const mod = await import(pathToFileURL(file).href);
  // A default export is refused too: it would be loaded and never called, and look like a working hook.
  const unknown = Object.keys(mod).filter((k) => !HOOK_NAMES.includes(k));
  if (unknown.length) {
    throw new Error(
      `${settings.hooks} exports ${unknown.join(', ')}; release hooks are ${HOOK_NAMES.join(', ')}`,
    );
  }
  const flags = mod.flags ?? [];
  if (!Array.isArray(flags) || !flags.every((f) => typeof f === 'string' && /^[a-z][\w-]*$/.test(f))) {
    throw new Error(`${settings.hooks}: flags is a list of option names, such as ['listing']`);
  }
  for (const k of HOOK_NAMES.slice(1)) {
    if (mod[k] != null && typeof mod[k] !== 'function')
      throw new Error(`${settings.hooks}: ${k} is not a function`);
  }
  return {
    file: settings.hooks,
    flags,
    notes: mod.notes ?? null,
    checklist: mod.checklist ?? null,
    beforeFinalize: mod.beforeFinalize ?? null,
    afterFinalize: mod.afterFinalize ?? null,
  };
}

/**
 * The hooks for a `release` subcommand, from this checkout's package.json. Only `prepare` and `finalize`
 * call hooks, so nothing is read for any other; a checkout with no package.json has no hooks. A
 * package.json that is there and does not parse is an error, not "no hooks".
 */
export async function checkoutHooks(root, sub) {
  if (sub !== 'prepare' && sub !== 'finalize') return null;
  const file = path.join(root, 'package.json');
  if (!fs.existsSync(file)) return null;
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`package.json does not parse (${e.message})`);
  }
  return loadReleaseHooks(root, releaseSettings(pkg));
}

/** The hook flags' values from the command line: `--name=value`, or `true` for a bare `--name`. */
export function hookFlags(names, argv) {
  const out = {};
  for (const name of names ?? []) {
    for (const a of argv) {
      if (a === `--${name}`) out[name] = true;
      else if (a.startsWith(`--${name}=`)) out[name] = a.slice(name.length + 3);
    }
  }
  return out;
}

/**
 * What a finalize hook returned, read strictly: only `{ ok: true }` is success. `{ ok: false }` is a failure
 * with its message; anything else (nothing at all, `{ success: true }`, a string) is a failure that names
 * what came back, so a hook that forgot to return cannot pass for one that succeeded.
 */
export function hookVerdict(got) {
  const message = typeof got?.message === 'string' && got.message ? got.message : null;
  if (got?.ok === true) return { ok: true, message };
  if (got?.ok === false) return { ok: false, message: message ?? 'no reason given' };
  let shown;
  try {
    shown = JSON.stringify(got) ?? String(got);
  } catch {
    shown = String(got);
  }
  if (shown.length > 120) shown = `${shown.slice(0, 119)}…`;
  return { ok: false, message: `it returned ${shown}, not { ok: true } or { ok: false, message }` };
}

/** A hook's notes as a block of their own: its trailing blank lines dropped, one added. */
const hookBlock = (lines) => {
  const out = [...(lines ?? [])];
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.length ? [...out, ''] : [];
};

/** A hook's lines: an array of strings, or nothing. Anything else is the hook's mistake, said by name. */
function hookLines(name, got) {
  if (got == null) return [];
  if (!Array.isArray(got) || !got.every((l) => typeof l === 'string')) {
    throw new Error(`the release hook ${name} returned something other than a list of lines`);
  }
  return got;
}

/** `text` in a fence no backtick run inside it can close. */
function fenced(text, lang) {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  return [`${fence}${lang}`, text.trimEnd(), fence];
}

/**
 * The configuration files the notes carry whole, read at the release commit, so an administrator copies a
 * file rather than rebuilding one from a list of keys. Each is folded so the notes stay readable. These are
 * committed files, so they hold placeholders only; a real value never belongs in them or in the notes.
 */
function configFileSections(files) {
  const lines = [];
  for (const [file, text] of Object.entries(files)) {
    if (text == null) continue;
    const lang = /\.ya?ml$/.test(file) ? 'yaml' : /\.json$/.test(file) ? 'json' : 'shell';
    lines.push(
      '<details>',
      `<summary><code>${file}</code></summary>`,
      '',
      ...fenced(text, lang),
      '',
      '</details>',
      '',
    );
  }
  if (!lines.length) return lines;
  return [
    '### Configuration files',
    '',
    'Taken whole from the release commit, with the defaults the code ships.',
    '',
    ...lines,
  ];
}

const META = /<!-- release-meta (\{.*?\}) -->\n?/;

export function readMeta(notes) {
  const m = META.exec(notes ?? '');
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** What `finalize` publishes: the notes without the machine block, trimmed. */
export function publishable(notes) {
  return (notes ?? '').replace(META, '').trim();
}

const GROUPS = [
  ['feat', 'Features'],
  ['fix', 'Fixes'],
];
const GROUP_ORDER = [...GROUPS.map(([, g]) => g), 'Other changes'];

/** The included items by the kind of branch that delivered the first of their merge requests. */
function byGroup(r) {
  const kindOf = (mrIids) => {
    const mr = r.mergeRequests.find((m) => m.iid === mrIids[0]);
    const prefix = /^(\w+)[/(:]/.exec(mr?.sourceBranch ?? '')?.[1];
    return GROUPS.find(([k]) => k === prefix)?.[1] ?? 'Other changes';
  };
  const groups = new Map();
  for (const i of r.included) {
    const g = kindOf(i.mrs);
    groups.set(g, [...(groups.get(g) ?? []), i]);
  }
  return groups;
}

const TITLE_MAX = 200;
const oneLine = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
const cap = (s) => (s.length > TITLE_MAX ? `${s.slice(0, TITLE_MAX - 1)}…` : s);

/**
 * Text from outside, as it goes into the release notes: item titles, merge request titles. Markdown
 * punctuation is backslash-escaped, so a title cannot become a link or emphasis, and `<` and `>` become
 * entities, which makes `<!--` (and the FILL IN marker `finalize` refuses on) inert while the text still
 * reads. `#` and `!` are left alone: neither means anything mid-line, and escaping them would stop the
 * tracker linking `#123` and `!45`. Newlines collapse; length is capped.
 */
export function mdText(s) {
  return cap(oneLine(s))
    .replace(/[\\`*_[\]()|~]/g, '\\$&')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** The same for a commit subject, which sits in a code span: no backtick may close it, and no `<!--` may reach the file. */
export function codeText(s) {
  return cap(oneLine(s).replace(/[<>`]/g, ''));
}

/**
 * The same for the what's-new draft, whose renderer has no backslash escapes: what could open a link, a
 * code span or emphasis is dropped instead.
 */
export function plainText(s) {
  return cap(oneLine(s).replace(/[<>[\]`*]/g, ''));
}

/** The titles `mdText` had to neutralise a comment opener in, for `prepare` to name. */
export function hostileTitles(items) {
  return [...items.values()].filter((i) => /<!--/.test(i?.title ?? '')).map((i) => i.iid);
}

/**
 * The draft notes. Everything a script can know is filled in; what only a person knows is a marked gap
 * that `finalize` refuses to publish. The machine block at the top carries what `finalize` needs later —
 * the source branch and the items — so it does not have to re-derive them from a branch that has moved on.
 */
export function renderNotes(r) {
  const meta = { label: r.label, from: r.from, head: r.head, items: r.included.map((i) => i.iid) };
  const title = (iid) => {
    const item = r.items.get(iid);
    return r.isConfidential(item) ? '(confidential)' : mdText(item.title);
  };
  const groups = byGroup(r);
  const mrText = (mrs) => (mrs.length ? ` (${mrs.map(r.mrRef).join(', ')})` : ' (included by hand)');

  const lines = [
    `<!-- release-meta ${JSON.stringify(meta)} -->`,
    `# ${r.name}`,
    '',
    `*Draft by \`pnpm items release prepare\` on ${r.date}, from \`${r.from}\` at \`${r.head.slice(0, 7)}\`. ` +
      'Edit it on the release branch. `finalize` publishes this file as the release notes, and refuses while ' +
      'a FILL IN marker is left.*',
    '',
    '## Notices',
    '',
    `${FILL_IN}: anything an administrator must know before deploying or after it, or "None." -->`,
    '',
    ...hookBlock(r.hookNotes),
    '## Deploying',
    '',
  ];
  if (r.config.length) {
    lines.push(
      `Configuration keys changed since \`${r.base.slice(0, 7)}\`:`,
      '',
      '| Key | Change |',
      '|---|---|',
    );
    for (const c of r.config) lines.push(`| \`${c.key}\` | [${c.change}] |`);
    lines.push(
      '',
      `${FILL_IN}: check every key against the environment's actual configuration and mark it ` +
        '[present], [ADD], [CHANGE] or [optional]; never paste a secret value. -->',
    );
  } else {
    lines.push('No configuration key changed.');
  }
  if (r.migrations.length) {
    lines.push('', `Database migrations: ${r.migrations.map((m) => `\`${m}\``).join(', ')}.`);
  }
  lines.push('', ...configFileSections(r.configFiles ?? {}));
  lines.push('## Delivered', '');
  for (const g of GROUP_ORDER) {
    const rows = groups.get(g);
    if (!rows) continue;
    lines.push(`### ${g}`, '');
    for (const i of rows) lines.push(`- **#${i.iid}** ${title(i.iid)}${mrText(i.mrs)}`);
    lines.push('');
  }
  if (r.noItem.length) {
    lines.push('### Merge requests with no work item', '');
    for (const iid of r.noItem) {
      const mr = r.mergeRequests.find((m) => m.iid === iid);
      lines.push(`- ${r.mrRef(iid)} ${mdText(mr?.title)}`.trimEnd());
    }
    lines.push('');
  }
  if (r.outside.length) {
    lines.push('### Commits outside any merge request', '');
    for (const c of r.outside) lines.push(`- \`${codeText(c)}\``);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * The draft of the "what's new" file: the delivered items' titles, seeded for a person to rewrite. A
 * confidential item is left out altogether, not listed by number: a user has no number to look up, and the
 * file is published to people who cannot open the item. Fixes are fixes; features and everything else go
 * under What's new, where a person deletes what a user would not notice.
 */
export function renderWhatsNewDraft(r) {
  const groups = byGroup(r);
  const titles = (gs) =>
    gs
      .flatMap((g) => groups.get(g) ?? [])
      .map((i) => r.items.get(i.iid))
      .filter((item) => item && !r.isConfidential(item))
      .map((item) => plainText(item.title));
  return draftWhatsNew({
    version: r.version,
    features: titles(['Features', 'Other changes']),
    fixes: titles(['Fixes']),
  });
}

/**
 * The release merge request's description. `checklist` is the project hook's extra "Before merging" lines,
 * as plain text; each becomes a box of its own, after the kit's own and before CI.
 */
export function releaseDescription(r) {
  const { label, notesPath, whatsNewFile, include = [], exclude = [], checklist } = r;
  const hand = [
    include.length ? `Included by hand: ${include.map((i) => `#${i}`).join(', ')}.` : '',
    exclude.length ? `Excluded by hand: ${exclude.map((i) => `#${i}`).join(', ')}.` : '',
  ].filter(Boolean);
  return [
    `Release **${r.version}**: \`${r.from}\` at \`${r.head.slice(0, 7)}\`, plus the version bump and the release notes.`,
    '',
    `**Merge this with a merge commit — do not squash or rebase.** Either puts the branch on \`${r.target}\` under ` +
      `new commit hashes, and the next merge from \`${r.from}\` then conflicts with its own history.`,
    '',
    `Delivered: ${r.included.map((i) => `#${i.iid}`).join(', ')}.`,
    ...hand,
    '',
    '## Before merging',
    `- [ ] \`${notesPath}\` is edited on this branch: every FILL IN marker is gone, the Deploying section is checked against the environment's actual configuration.`,
    `- [ ] \`${whatsNewFile}\` is rewritten for the people who use the product: every FILL IN marker is gone, and nothing in it is about deployment, configuration or confidential work. \`pnpm items release deck ${label}\` previews the slides.`,
    ...(checklist ?? []).map((l) => `- [ ] ${l}`),
    '- [ ] `pnpm ci:local` is green on this branch.',
    `- [ ] Merging may deploy: \`${r.target}\` is what the environment builds from.`,
    '',
    '## After merging',
    `\`pnpm items release finalize ${label}\` tags the merge commit, publishes the notes as the release, ` +
      `closes the items and the milestone, and opens a merge request back into \`${r.from}\`.`,
  ].join('\n');
}

/**
 * The commits of a range as `{ sha, subject, body }`, from `git log --format=%H%x1f%s%x1f%b%x1e`. Split on
 * the separators git was asked for, so a body with blank lines or a `---` stays one commit.
 */
export function parseLog(text) {
  return (text ?? '')
    .split('\x1e')
    .map((c) => c.replace(/^\n/, ''))
    .filter((c) => c.includes('\x1f'))
    .map((c) => {
      const [sha, subject, body] = c.split('\x1f');
      return { sha, subject, body: (body ?? '').trim() };
    });
}

// ---------------------------------------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------------------------------------

function git(root, args, { inherit = false } = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  })?.trim();
}

function gitOk(root, args) {
  try {
    git(root, args);
    return true;
  } catch {
    return false;
  }
}

const showAt = (root, ref, file) =>
  gitOk(root, ['cat-file', '-e', `${ref}:${file}`]) ? git(root, ['show', `${ref}:${file}`]) : null;

// ---------------------------------------------------------------------------------------------------------
// prepare
// ---------------------------------------------------------------------------------------------------------

const list = (flag) =>
  (flag ?? '')
    .split(',')
    .map((s) => Number(s.trim().replace(/^#/, '')))
    .filter((n) => Number.isInteger(n) && n > 0);

async function survey({ b, ROOT }, label, opts) {
  const version = versionOf(label);
  if (!version) throw new Error(`"${label}" is not a release label — release-X.Y.Z`);
  if (!opts.from) throw new Error('--from=<branch> names the branch the release is cut from');

  git(ROOT, ['fetch', '--quiet', '--tags', 'origin']);
  const fromRef = `origin/${opts.from}`;
  if (!gitOk(ROOT, ['rev-parse', '--verify', '--quiet', fromRef])) throw new Error(`no branch ${fromRef}`);
  const head = git(ROOT, ['rev-parse', opts.at ?? fromRef]);
  if (opts.at && !gitOk(ROOT, ['merge-base', '--is-ancestor', head, fromRef])) {
    throw new Error(`${opts.at} is not on ${opts.from}`);
  }

  const project = await b.project();
  const target = project.defaultBranch;
  const targetRef = `origin/${target}`;
  const base = git(ROOT, ['merge-base', head, targetRef]);
  if (base === head)
    throw new Error(`${targetRef} already contains ${head.slice(0, 7)} — nothing to release`);

  const commits = parseLog(git(ROOT, ['log', '--format=%H%x1f%s%x1f%b%x1e', `${base}..${head}`]));
  // A `#n` in a squash commit's subject may be an issue's; `getMr` answers null for one, and it is dropped.
  const mergeRequests = (await Promise.all((await b.mrRefs(commits)).map((iid) => b.getMr(iid)))).filter(
    Boolean,
  );
  const items = new Map((await b.listAll()).map((i) => [i.iid, i]));
  const sel = selectItems({
    mergeRequests,
    items,
    // The release being cut, not the branch: a version line (`release-0.3.x`) is no release's name, and
    // keying this on the branch switched the check off for every release cut from one.
    releaseLabel: label,
    include: list(opts.include),
    exclude: list(opts.exclude),
  });
  // A first-parent commit that is no merge reached the line branch directly — unless it is a GitHub squash
  // merge, whose subject names the request it came from.
  const found = new Set(mergeRequests.map((m) => m.iid));
  const outside = parseLog(
    git(ROOT, ['log', '--first-parent', '--no-merges', '--format=%H%x1f%s%x1f%b%x1e', `${base}..${head}`]),
  )
    .filter((c) => !squashOf(c.subject, found))
    .map((c) => `${c.sha.slice(0, 7)} ${c.subject}`);

  const settings = releaseSettings(JSON.parse(showAt(ROOT, head, 'package.json') ?? '{}'));
  const configDiff = git(ROOT, ['diff', base, head, '--', ...settings.configPaths]);
  const migrations = git(ROOT, ['diff', '--name-only', '--diff-filter=A', base, head])
    .split('\n')
    .filter((f) => settings.migrations.test(f))
    .map((f) => path.basename(f));
  const isFile = (f) =>
    gitOk(ROOT, ['cat-file', '-e', `${head}:${f}`]) &&
    git(ROOT, ['cat-file', '-t', `${head}:${f}`]) === 'blob';
  const configFiles = Object.fromEntries(
    settings.configPaths.filter(isFile).map((f) => [f, showAt(ROOT, head, f)]),
  );
  const tagTaken = gitOk(ROOT, ['rev-parse', '--verify', '--quiet', `refs/tags/${label}`]);
  const branchTaken = gitOk(ROOT, ['rev-parse', '--verify', '--quiet', `origin/release/${version}`]);

  return {
    label,
    version,
    from: opts.from,
    head,
    base,
    target,
    project,
    mergeRequests,
    items,
    outside,
    config: configKeys(configDiff),
    configFiles,
    migrations,
    tagTaken,
    branchTaken,
    ...sel,
  };
}

/** A GitHub squash commit's subject ends with the request's number: `fix: thing (#12)`. */
const squashOf = (subject, found) => {
  const m = /\(#(\d+)\)\s*$/.exec(subject ?? '');
  return Boolean(m && found.has(Number(m[1])));
};

function printSurvey(s, { b, ROOT, isConfidential }) {
  const title = (iid) => {
    const item = s.items.get(iid);
    return isConfidential(item) ? '(confidential)' : item.title.slice(0, 80);
  };
  const mrs = (l) => (l.length ? l.map(b.mrRef).join(' ') : 'by hand');
  const commits = Number(git(ROOT, ['rev-list', '--count', `${s.base}..${s.head}`]));
  console.log(
    `${s.label}: ${s.from} at ${s.head.slice(0, 7)}, ${commits} commit(s) and ${s.mergeRequests.length} ` +
      `merge request(s) not yet on ${s.target}`,
  );
  console.log(`\nIncluded (${s.included.length}):`);
  for (const i of s.included) {
    const state = s.items.get(i.iid).state === 'closed' ? '' : '  ← STILL OPEN';
    console.log(`  #${i.iid} ${title(i.iid)}  [${mrs(i.mrs)}]${state}`);
  }
  if (s.mentioned.length) {
    console.log('\nMentioned in a merge request but not included (add with --include=<iid,…> if delivered):');
    for (const m of s.mentioned) console.log(`  #${m.iid} ${title(m.iid)}  [${mrs(m.mrs)}]`);
  }
  if (s.leftBehind.length) {
    console.log(`\nClosed and labelled ${s.label}, but not delivered in this range (they keep their label):`);
    for (const iid of s.leftBehind) console.log(`  #${iid} ${title(iid)}`);
  }
  if (s.unknown.length)
    console.log(`\nNamed but not an item here: ${s.unknown.map((i) => `#${i}`).join(' ')}`);
  if (s.noItem.length) {
    console.log('\nMerge requests that name no work item:');
    for (const iid of s.noItem)
      console.log(`  ${b.mrRef(iid)} ${s.mergeRequests.find((m) => m.iid === iid).title}`);
  }
  if (s.outside.length) {
    console.log('\nCommits outside any merge request:');
    for (const c of s.outside) console.log(`  ${c}`);
  }
  console.log(
    `\nConfiguration keys changed: ${s.config.map((c) => `${c.key} [${c.change}]`).join(', ') || 'none'}`,
  );
  console.log(`Migrations: ${s.migrations.join(', ') || 'none'}`);
}

async function prepare(ctx, label, opts) {
  const { b, ROOT, isConfidential } = ctx;
  const s = await survey(ctx, label, opts);
  printSurvey(s, ctx);

  for (const iid of hostileTitles(s.items)) {
    console.error(
      `! #${iid}'s title contains a comment opener; the notes drop its < and >, so it stays inert.`,
    );
  }

  const refusals = [];
  if (s.open.length) {
    refusals.push(
      `${s.open.map((i) => `#${i}`).join(', ')} ${s.open.length > 1 ? 'are' : 'is'} still open. A release ` +
        'includes delivered items only. Close it if it is done; or cut the release before its merge ' +
        '(--at=<an earlier commit>); or, if it was delivered only in part, --exclude it — its merged part ' +
        'then ships without being listed, so say so under Notices.',
    );
  }
  if (s.tagTaken) refusals.push(`the tag ${label} already exists`);
  if (s.branchTaken) refusals.push(`origin/release/${s.version} already exists — finish or delete it first`);
  if (s.project.squashAlways) {
    refusals.push(
      'this project cannot merge with a merge commit (it always squashes); a release needs one ' +
        '(docs/agents/releasing.md)',
    );
  }
  if (!s.included.length) refusals.push('no work item is delivered in this range');
  if (refusals.length) {
    for (const r of refusals) console.error(`\n✖ ${r}`);
    return 1;
  }
  if (s.project.mergeMethod && s.project.mergeMethod !== 'merge') {
    console.log(
      `\n! This project merges by "${s.project.mergeMethod}", which rewrites the branch's commits. Use a merge commit.`,
    );
  }
  // The project's own additions, asked once, before anything is written: a hook that throws stops the
  // release here, with nothing cut.
  const { hooks, flags = {} } = ctx;
  const hookNotes = hooks?.notes
    ? hookLines('notes', await hooks.notes(s, { showAt: (ref, file) => showAt(ROOT, ref, file), flags }))
    : [];
  const hookChecklist = hooks?.checklist ? hookLines('checklist', await hooks.checklist(s, { flags })) : [];
  const name = opts.name ?? `Release ${s.version}`;
  const notesPath = `docs/releases/${s.version}.md`;
  const draft = () =>
    renderNotes({
      ...s,
      name,
      date: new Date().toISOString().slice(0, 10),
      isConfidential,
      mrRef: b.mrRef,
      hookNotes,
    });
  const whatsNew = () => renderWhatsNewDraft({ ...s, isConfidential });
  const whatsNewFile = whatsNewPath(s.version);
  if (!opts.apply) {
    if (opts.notes) {
      console.log(`\n----- ${notesPath} (draft) -----\n${draft()}`);
      console.log(`\n----- ${whatsNewFile} (draft) -----\n${whatsNew()}`);
    }
    console.log(
      `\nDry run — nothing was written. --apply cuts release/${s.version}, commits the version bump, ` +
        `${notesPath} and ${whatsNewFile}, pushes, opens the merge request to ${s.target}, ` +
        `and relabels the ${s.included.length} item(s) ${label}.`,
    );
    return 0;
  }

  const unavailable = b.mrUnavailable();
  if (unavailable) {
    console.error(`\n✖ ${unavailable}`);
    return 1;
  }
  if (git(ROOT, ['status', '--porcelain', '--untracked-files=no'])) {
    console.error('\n✖ the working tree has uncommitted changes; commit or stash them first.');
    return 1;
  }

  const original = git(ROOT, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (original === 'HEAD') {
    console.error('\n✖ HEAD is detached; switch to a branch first, so there is somewhere to come back to.');
    return 1;
  }
  const branch = `release/${s.version}`;
  let mr;
  let committed = false;
  try {
    git(ROOT, ['switch', '--quiet', '-c', branch, s.head]);
    // Only the package.json files that carry the project's version: the root's, read at the release
    // commit. A vendored or fixture package.json with a version of its own is left alone.
    const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    const bumped = git(ROOT, ['ls-files', 'package.json', '*/package.json'])
      .split('\n')
      .filter((f) => {
        if (!f || f.includes('node_modules')) return false;
        return /"version"\s*:\s*"([^"]*)"/.exec(fs.readFileSync(path.join(ROOT, f), 'utf8'))?.[1] === current;
      });
    for (const f of bumped) {
      const file = path.join(ROOT, f);
      fs.writeFileSync(file, bumpVersion(fs.readFileSync(file, 'utf8'), s.version));
    }
    fs.mkdirSync(path.join(ROOT, 'docs/releases'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, notesPath), draft());
    fs.writeFileSync(path.join(ROOT, whatsNewFile), whatsNew());
    git(ROOT, ['add', '--', ...bumped, notesPath, whatsNewFile]);
    // Hooks run: the secret gate reads the notes, and the pre-push hook runs `pnpm check` on exactly the
    // tree that will reach the default branch.
    git(ROOT, ['commit', '--quiet', '-m', `chore(release): ${s.version}`], { inherit: true });
    committed = true;
    git(ROOT, ['push', '--set-upstream', 'origin', branch], { inherit: true });

    const description = releaseDescription({
      ...s,
      label,
      notesPath,
      whatsNewFile,
      include: list(opts.include),
      exclude: list(opts.exclude),
      checklist: hookChecklist,
    });
    const open = () =>
      b.openMr({
        source: branch,
        target: s.target,
        title: `chore(release): ${s.version}`,
        description,
        forRelease: true,
      });
    try {
      mr = await open();
    } catch (e) {
      // The push above runs the pre-push hook synchronously for minutes, and while it does the event loop
      // cannot see the server close the idle keep-alive connection from the survey. The POST then goes out
      // on that dead socket and fails as `network`, twice in a row on Makers Market. fetch never retries a POST,
      // so this does, on a fresh connection, after checking the first one did not open it after all.
      if (!(e instanceof BoardError && e.code === 'network')) throw e;
      mr = (await b.findMrs({ source: branch, target: s.target, state: 'open' }))[0] ?? (await open());
    }
  } catch (e) {
    // Put the working tree back the way it was found, so the switch below cannot carry a half-made
    // release onto the person's own branch. Before the commit, that is: undo the edits and drop the local
    // branch. After it, the branch holds a good commit that only failed to push (or to open the merge
    // request), so it is kept and named.
    if (!committed) {
      gitOk(ROOT, ['reset', '--quiet', '--hard']);
      fs.rmSync(path.join(ROOT, notesPath), { force: true });
      fs.rmSync(path.join(ROOT, whatsNewFile), { force: true });
      gitOk(ROOT, ['switch', '--quiet', original]);
      gitOk(ROOT, ['branch', '-D', branch]);
      console.error(
        `\n✖ nothing was committed; the local ${branch} is removed and ${original} is as it was.`,
      );
    } else {
      gitOk(ROOT, ['switch', '--quiet', original]);
      console.error(
        `\n✖ ${branch} holds the release commit, but the push or the merge request failed (below). If ` +
          `origin/${branch} exists, open the merge request by hand; otherwise push it, or delete the branch ` +
          `(\`git branch -D ${branch}\`, and \`git push origin --delete ${branch}\` if it was pushed) and run ` +
          'this again. No item was relabelled.',
      );
    }
    throw e;
  }
  git(ROOT, ['switch', '--quiet', original]);

  // Last, so a red pre-push or a refused merge request leaves the board as it was.
  for (const i of s.included) await ctx.relabel(i.iid, label);
  console.log(`\nopened ${b.mrRef(mr.iid)}  ${branch} -> ${s.target}`);
  console.log(mr.url);
  console.log(
    `\nNext: edit ${notesPath} and ${whatsNewFile} on ${branch}, a person merges ${b.mrRef(mr.iid)} with a ` +
      `merge commit, then pnpm items release finalize ${label}`,
  );
  return 0;
}

// ---------------------------------------------------------------------------------------------------------
// finalize
// ---------------------------------------------------------------------------------------------------------

async function finalize(ctx, label, opts = {}) {
  const { b, ROOT } = ctx;
  const version = versionOf(label);
  if (!version) throw new Error(`"${label}" is not a release label — release-X.Y.Z`);
  const unavailable = b.mrUnavailable();
  if (unavailable) {
    console.error(`✖ ${unavailable}`);
    return 1;
  }
  const branch = `release/${version}`;
  const project = await b.project();
  const target = project.defaultBranch;
  const mr = (await b.findMrs({ source: branch, target }))[0];
  if (!mr) {
    console.error(
      `✖ no merge request from ${branch} to ${target} — run \`release prepare ${label} --apply\` first`,
    );
    return 1;
  }
  if (mr.state !== 'merged') {
    console.error(`✖ ${b.mrRef(mr.iid)} is ${mr.state}. A person merges it first; this runs after.`);
    return 1;
  }
  const sha = mr.mergeSha;
  if (!sha) {
    console.error(`✖ ${b.mrRef(mr.iid)} reports no merge commit; there is nothing to tag`);
    return 1;
  }
  git(ROOT, ['fetch', '--quiet', '--tags', 'origin']);
  if (!gitOk(ROOT, ['merge-base', '--is-ancestor', sha, `origin/${target}`])) {
    console.error(`✖ ${sha.slice(0, 7)} is not on origin/${target}`);
    return 1;
  }
  const notesPath = `docs/releases/${version}.md`;
  const notes = showAt(ROOT, sha, notesPath);
  if (notes == null) {
    console.error(`✖ ${notesPath} is not in the merge commit`);
    return 1;
  }
  if (notes.includes(FILL_IN)) {
    console.error(
      `✖ ${notesPath} still has a FILL IN marker. Fix it on ${target} in a merge request, then run this again.`,
    );
    return 1;
  }
  const meta = readMeta(notes);
  if (!meta?.from || !Array.isArray(meta.items)) {
    console.error(`✖ ${notesPath} has lost its release-meta line; it names the source branch and the items`);
    return 1;
  }
  // Whether the request was merged, squashed or rebased is in the commit itself: only a merge has two parents.
  if (git(ROOT, ['rev-list', '--parents', '-n', '1', sha]).split(' ').length < 3) {
    console.error(
      `! ${sha.slice(0, 7)} is not a merge commit (${b.mrRef(mr.iid)} was squashed, rebased or fast-forwarded). ` +
        `Tagging it anyway; expect the merge back into ${meta.from} to conflict.`,
    );
  }
  const whatsNewFile = whatsNewPath(version);
  const whatsNew = showAt(ROOT, sha, whatsNewFile);
  if (whatsNew?.includes(FILL_IN)) {
    console.error(
      `✖ ${whatsNewFile} still has a FILL IN marker. Fix it on ${target} in a merge request, then run this again.`,
    );
    return 1;
  }
  // A misspelt marker is refused before the tag, not halfway through the release. A hook is handed the
  // public form of the file, cut here too, so a file that cannot be cut cleanly is refused just as early.
  const hookCalled = Boolean(ctx.hooks?.beforeFinalize || ctx.hooks?.afterFinalize);
  let whatsNewPublic = null;
  if (whatsNew) {
    try {
      parseDeck(whatsNew);
      if (hookCalled) whatsNewPublic = withoutAdmin(whatsNew);
    } catch (e) {
      console.error(
        `✖ ${whatsNewFile}: ${e.message}. Fix it on ${target} in a merge request, then run this again.`,
      );
      return 1;
    }
  }
  // With `requireWhatsNew`, a release without the file is a decision, said with --no-whats-new, never an
  // omission: a project that shows the file to its users would otherwise show them nothing. Read at the
  // merge commit, as every setting but `hooks` is (header, "WHAT A PROJECT CONFIGURES").
  const settings = releaseSettings(JSON.parse(showAt(ROOT, sha, 'package.json') ?? '{}'));
  if (!whatsNew && settings.requireWhatsNew && !opts.noWhatsNew) {
    console.error(
      `✖ ${whatsNewFile} is not in the merge commit, and this project requires one (requireWhatsNew). Add it ` +
        `on ${target} in a merge request, or run this again with --no-whats-new if the release has nothing to show.`,
    );
    return 1;
  }

  // The project's own checks, last before anything is written: a hook that needs a credential or the
  // slides says so here, rather than failing after the release is done.
  const before = ctx.hooks?.beforeFinalize;
  if (before) {
    const filename = deckFileName(version);
    let verdict;
    try {
      verdict = await before({
        label,
        version,
        sha,
        release: null,
        deck: whatsNew
          ? {
              filename,
              html: renderDeck({
                markdown: whatsNew,
                version,
                date: git(ROOT, ['log', '-1', '--format=%cs', sha]),
              }),
              url: null,
            }
          : null,
        whatsNew: whatsNewPublic,
        whatsNewRaw: whatsNew ?? null,
        flags: ctx.flags ?? {},
        env: ctx.env ?? (() => ''),
      });
    } catch (e) {
      verdict = { ok: false, message: e?.message ?? String(e) };
    }
    verdict = hookVerdict(verdict);
    if (!verdict.ok) {
      console.error(
        `✖ the project's beforeFinalize hook (${ctx.hooks.file}) refused: ` +
          `${verdict.message}. Nothing was tagged, published or closed.`,
      );
      return 1;
    }
    if (verdict.message) console.log(verdict.message);
  }

  // 1. The tag.
  if (gitOk(ROOT, ['rev-parse', '--verify', '--quiet', `refs/tags/${label}`])) {
    const at = git(ROOT, ['rev-parse', `${label}^{commit}`]);
    if (at !== sha) {
      console.error(
        `✖ ${label} already exists at ${at.slice(0, 7)}, not at the merge commit ${sha.slice(0, 7)}`,
      );
      return 1;
    }
    console.log(`tag ${label} already at ${sha.slice(0, 7)}`);
  } else {
    git(ROOT, ['tag', '-a', label, '-m', `Release ${version}`, sha]);
    git(ROOT, ['push', 'origin', `refs/tags/${label}`], { inherit: true });
    console.log(`tagged ${sha.slice(0, 7)} as ${label}`);
  }

  // 2. The release, from the notes file. A GitHub release cannot carry a milestone, so the notes link it.
  const milestone = (await b.milestones('all')).find((m) => m.title === label);
  const body = publishable(notes);
  const name = /^# (.+)$/m.exec(body)?.[1] ?? version;
  const milestoneLine =
    milestone?.url && !b.releaseCarriesMilestone ? `\n\n**Milestone:** [${label}](${milestone.url})` : '';
  const save = (deck) =>
    b.saveRelease({
      tag: label,
      name,
      description: `${body}${milestoneLine}${deck ? `\n\n---\n\n**${DECK_LINK_NAME}:** [${deck.filename}](${deck.url})` : ''}`,
      milestone: milestone ? label : null,
    });
  let release = await save(null);
  console.log(`release ${label}: ${release.url}`);

  // 3. The slides, attached to the release and then linked from its notes.
  let deck = null;
  if (whatsNew) {
    const filename = deckFileName(version);
    const html = renderDeck({
      markdown: whatsNew,
      version,
      date: git(ROOT, ['log', '-1', '--format=%cs', sha]),
    });
    const att = await b.attachToRelease(label, {
      name: DECK_LINK_NAME,
      filename,
      bytes: Buffer.from(html),
      type: 'text/html',
    });
    release = await save({ filename, url: att.url });
    deck = { filename, html, url: att.url };
    console.log(`${att.replaced ? 'replaced' : 'attached'} ${filename}`);
  } else {
    console.log(`no ${whatsNewFile} in the merge commit; the release gets no slides`);
  }

  // 4. The items: a record on each, then closed with its ai: label dropped.
  const marker = `Shipped in **${label}**`;
  for (const iid of meta.items) {
    if (!(await b.comments(iid)).some((n) => n.body.includes(marker))) {
      await b.comment(
        iid,
        `${marker}: merge request ${b.mrRef(mr.iid)}, merge commit \`${sha.slice(0, 7)}\`, tag \`${label}\`. ${release.url}`,
      );
    }
    await ctx.close(iid);
  }

  // 5. The milestone.
  const closed = await b.closeMilestone(label);
  if (closed === 'closed') console.log(`closed milestone ${label}`);

  // 6. The default branch back into the source, so the version bump and the notes are there too.
  if (gitOk(ROOT, ['merge-base', '--is-ancestor', sha, `origin/${meta.from}`])) {
    console.log(`${meta.from} already contains the release`);
  } else {
    const back =
      (await b.findMrs({ source: target, target: meta.from, state: 'open' }))[0] ??
      (await b.openMr({
        source: target,
        target: meta.from,
        title: `chore(release): bring ${version} back into ${meta.from}`,
        description:
          `${label} is tagged on \`${target}\`. This brings its version bump and release notes back into ` +
          `\`${meta.from}\`, so the two branches do not drift apart. Merge with a merge commit.`,
        forRelease: true,
      }));
    console.log(`merge request back into ${meta.from}: ${b.mrRef(back.iid)} ${back.url}`);
  }

  // 7. The project's own last step, last, so its failure leaves everything above done and a rerun of
  // `finalize` skips all of that and retries only what the hook finds undone.
  const after = ctx.hooks?.afterFinalize;
  if (!after) return 0;
  let outcome;
  try {
    outcome = await after({
      label,
      version,
      sha,
      release: { url: release.url },
      deck,
      whatsNew: whatsNewPublic,
      whatsNewRaw: whatsNew ?? null,
      flags: ctx.flags ?? {},
      env: ctx.env ?? (() => ''),
    });
  } catch (e) {
    outcome = { ok: false, message: e?.message ?? String(e) };
  }
  outcome = hookVerdict(outcome);
  if (!outcome.ok) {
    console.error(
      `✖ ${label} is released, but the project's afterFinalize hook (${ctx.hooks.file}) failed: ` +
        `${outcome.message}. Everything else is done; run finalize again to retry it.`,
    );
    return 1;
  }
  if (outcome.message) console.log(outcome.message);
  return 0;
}

// ---------------------------------------------------------------------------------------------------------
// deck
// ---------------------------------------------------------------------------------------------------------

/** The slides from this checkout's file, for a look before the merge. Writes the file and nothing else. */
function deck({ ROOT }, label, opts) {
  const version = versionOf(label);
  if (!version) throw new Error(`"${label}" is not a release label — release-X.Y.Z`);
  const file = whatsNewPath(version);
  const source = path.join(ROOT, file);
  if (!fs.existsSync(source)) {
    console.error(`✖ no ${file} in this checkout; \`release prepare --apply\` drafts it`);
    return 1;
  }
  const markdown = fs.readFileSync(source, 'utf8');
  const out = path.resolve(process.env.INIT_CWD ?? process.cwd(), opts.out ?? deckFileName(version));
  fs.writeFileSync(out, renderDeck({ markdown, version, date: new Date().toISOString().slice(0, 10) }));
  console.log(`wrote ${out}`);
  const gaps = markdown.split(FILL_IN).length - 1;
  if (gaps) console.log(`! ${gaps} FILL IN marker(s) left in ${file}; finalize refuses until they are gone`);
  return 0;
}

/**
 * `ctx`: `{ b, ROOT, isConfidential, relabel(iid, label), close(iid) }` — the board adapter, and the CLI's own
 * label and close commands, so a release writes to the board exactly as a person's command would.
 */
export async function cmdRelease(ctx, sub, label, opts) {
  try {
    if (sub === 'prepare') return await prepare(ctx, label, opts);
    if (sub === 'finalize') return await finalize(ctx, label, opts);
    if (sub === 'deck') return deck(ctx, label, opts);
  } catch (e) {
    if (e instanceof BoardError) throw e;
    console.error(`✖ ${e.message}`);
    return 1;
  }
  return null;
}

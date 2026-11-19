// The board's rules, with no I/O: the state machine, the label rules, release milestones, citations and
// links. Everything here works on the normalized shapes the adapters return, never on provider JSON, and
// everything here is pinned by `pnpm check:items`.
//
//   Item      { iid, title, url, labels[], description, state: 'open'|'closed', confidential,
//               createdAt, updatedAt, commentCount, milestone: { title } | null }
//   Comment   { id, authorId, author, body, createdAt }        // system notes already dropped
//   Milestone { id, title, state: 'open'|'closed', due: 'YYYY-MM-DD' | null, url }
//   Mr        { iid, title, sourceBranch, targetBranch, description, state: 'open'|'merged'|'closed',
//               mergeSha, url }                                // a merge request, or a GitHub pull request
//               + { mergedBy, mergedByBot } from `getMr` only: a listing does not say who merged

// ---------------------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------------------

// The `ai:` labels are the state machine. Neither GitLab Community Edition nor GitHub enforces scoped-label
// exclusivity, so exclusivity is this script's job, done by writing the full label set. See AGENTS.md for
// the vocabulary and .claude/skills/ for the procedure around it.
export const AI_LABELS = {
  analysing: 'ai:analysing',
  'plan-posted': 'ai:plan-posted',
  answered: 'ai:answered',
  ready: 'ai:ready',
  blocked: 'ai:blocked',
  parked: 'ai:parked',
  implementing: 'ai:implementing',
};
export const AI_LABEL_SET = new Set(Object.values(AI_LABELS));

export const LABEL_COLOURS = {
  'ai:analysing': [
    '#C95100',
    'An agent is analysing this item right now. Older than a few hours means a crashed run.',
  ],
  'ai:plan-posted': [
    '#1F75CB',
    "A remediation plan is on this item, awaiting the reporter's answers to its [REVIEW] points.",
  ],
  'ai:answered': [
    '#108548',
    'The reporter has replied since the plan was posted, and the reply has not been assessed for coverage yet. Written for people to read on the board; the tool always recomputes this from the comments so a stale label cannot lie.',
  ],
  'ai:ready': ['#217645', 'Every [REVIEW] point is answered. Awaiting a go to implement.'],
  'ai:blocked': [
    '#DD2B0E',
    'A [REVIEW] point could not be closed on the ticket after two rounds. Needs a conversation, not another comment.',
  ],
  'ai:parked': [
    '#666666',
    'Filed deliberately as a placeholder. NOT queued for analysis — remove this label to queue it.',
  ],
  'ai:implementing': ['#6E49CB', 'An implementation branch is open for this item.'],
};

// A plan we posted always opens with this, and a revision carries the same prefix. This answers "does a
// plan exist?" — a different question from "is the newest comment ours?", which `whoami()` answers by
// author. The label is the primary state signal and this is the fallback, so a hand-deleted label cannot
// cause a second plan to be posted onto an item that already carries one.
export const PLAN_MARKER = '## Remediation plan';
// One coverage comment per round: the per-point table, what is still open, and any revision to the plan.
export const COVERAGE_MARKER = '## Review coverage';

// ---------------------------------------------------------------------------------------------------------
// Migrated comments
// ---------------------------------------------------------------------------------------------------------

/**
 * A comment copied from another tracker carries where it came from on its LAST line:
 *
 *   <!-- board:migrated from=gitlab note=<id> url=<url> author=<username> at=<ISO time> kind=ours|reply -->
 *
 * The state machine decides by author, and a migration posts every comment as one author — the App, on
 * GitHub — so without this every migrated reporter reply would read as ours and no item would ever show
 * as `answered`. `kind=ours` means the original author was the board's own bot.
 *
 * Last line, not first: plan detection is `startsWith(PLAN_MARKER)`, so a marker at the top would hide
 * every migrated plan from it.
 */
const MIGRATED_LINE = /<!--\s*board:migrated\s+([^>]*?)\s*-->\s*$/;
const MIGRATED_KEYS = ['from', 'note', 'url', 'author', 'at', 'kind'];

/** The marker's fields, or null when the body's last line is not one. Unknown keys are dropped. */
export function migratedFrom(body) {
  const m = MIGRATED_LINE.exec(body || '');
  if (!m) return null;
  const out = {};
  for (const pair of m[1].split(/\s+/)) {
    const eq = pair.indexOf('=');
    if (eq < 1) continue;
    const key = pair.slice(0, eq);
    if (!MIGRATED_KEYS.includes(key)) continue;
    try {
      out[key] = decodeURIComponent(pair.slice(eq + 1));
    } catch {
      return null; // a malformed escape is not a marker this board wrote
    }
  }
  if (out.kind !== 'ours' && out.kind !== 'reply') return null;
  return out;
}

/** The marker line for `fields`; a value is percent-encoded only where it would break the line. */
export function migratedLine(fields) {
  const enc = (v) => String(v ?? '').replace(/[\s%>]|--/g, (c) => encodeURIComponent(c).replace(/-/g, '%2D'));
  const pairs = MIGRATED_KEYS.filter((k) => fields[k] != null && fields[k] !== '').map(
    (k) => `${k}=${enc(fields[k])}`,
  );
  return `<!-- board:migrated ${pairs.join(' ')} -->`;
}

/**
 * The marker, but only when it can be believed: on a comment written by this board's own identity, or
 * when that identity is unknown (the marker then carries the state, as the plan prefixes do). Anybody else
 * can paste the line into a reply, and it must not make their reply read as ours.
 */
function trustedMigration(n, meId) {
  if (meId != null && n.authorId !== meId) return null;
  return migratedFrom(n.body);
}

/**
 * What a comment is to the state machine: our `plan`, our coverage round, otherwise `ours` or a `reply`.
 * `show` prints this, and `classify` reads "not a reply" as "the last word was ours".
 */
export function commentKind(n, meId) {
  const body = n.body.trimStart();
  if (body.startsWith(PLAN_MARKER)) return 'plan';
  if (body.startsWith(COVERAGE_MARKER)) return 'coverage';
  const origin = trustedMigration(n, meId);
  if (origin) return origin.kind;
  return meId != null && n.authorId === meId ? 'ours' : 'reply';
}

// An `ai:analysing` older than this is a crashed run rather than work in progress. Two runs died mid-flight
// on 2026-09-08 (the session limit, twice), and the whole point of the label is that such a death is visible
// instead of looking like new work.
const STALE_AFTER_MS = 3 * 60 * 60 * 1000;

function labelState(labels) {
  for (const [state, label] of Object.entries(AI_LABELS)) if (labels.includes(label)) return state;
  return null;
}

/**
 * What state an item is in, and why.
 *
 * `answered` is the interesting one and it is COMPUTED rather than trusted: a plan is on the item and the
 * newest comment is not ours, which means the reporter has replied and a human decision is due. That is the
 * signal the whole dialogue idea rests on, so it is derived from the comments every time rather than read
 * from a label somebody may not have refreshed.
 */
export function classify(item, comments, meId) {
  const labelled = labelState(item.labels);
  const isOurs = (n) => commentKind(n, meId) !== 'reply';

  const plans = comments.filter((n) => n.body.trimStart().startsWith(PLAN_MARKER));
  const rounds = comments.filter((n) => n.body.trimStart().startsWith(COVERAGE_MARKER)).length;
  const hasPlan = plans.length > 0 || ['plan-posted', 'answered', 'ready', 'blocked'].includes(labelled);
  const newest = comments.length ? comments[comments.length - 1] : null;
  // The ball is with the reporter whenever the last word was ours — a posted plan, or a coverage round
  // handing back the points that are still open.
  const replied = hasPlan && newest && !isOurs(newest);

  const at = (n) => n.createdAt.slice(0, 10);
  if (labelled === 'implementing')
    return { rounds, state: 'implementing', why: 'an implementation branch is open' };
  // `parked` is STICKY, and outranks everything below including a fresh reply. It records a human decision
  // that this is not to be worked on yet, and the way to reverse that decision is to take the label off —
  // so nothing an agent or a commenter does may quietly unpark it. Kept out of `--brief` for the same
  // reason: a placeholder that nags every session is a placeholder nobody parks again.
  if (labelled === 'parked')
    return { rounds, state: 'parked', why: 'parked deliberately — remove the label to queue it' };
  if (labelled === 'analysing') {
    const age = Date.now() - Date.parse(item.updatedAt);
    return age > STALE_AFTER_MS
      ? {
          rounds,
          state: 'stale',
          why: `marked analysing but untouched for ${Math.round(age / 3600e3)} h — a crashed run`,
        }
      : { rounds, state: 'analysing', why: 'an agent is working on it now' };
  }
  // `blocked` outranks a fresh reply on purpose: two rounds failed to close a point on the ticket, so a
  // third comment is not the remedy and a new reply must not quietly restart the loop.
  if (labelled === 'blocked')
    return { rounds, state: 'blocked', why: `still open after ${rounds} round(s) — needs a conversation` };
  if (labelled === 'ready' && !replied)
    return { rounds, state: 'ready', why: 'every [REVIEW] point answered — awaiting a go to implement' };
  if (replied) {
    const origin = trustedMigration(newest, meId);
    return {
      rounds,
      state: 'answered',
      why: `${origin?.author || newest.author || 'somebody'} replied on ${origin?.at ? origin.at.slice(0, 10) : at(newest)}${rounds ? ` — round ${rounds + 1}` : ''}, coverage not assessed`,
    };
  }
  if (hasPlan) {
    return {
      rounds,
      state: 'plan-posted',
      why: rounds
        ? `round ${rounds} asked for what is still open; awaiting a reply`
        : 'plan is on the item, awaiting a reply',
    };
  }
  return { rounds, state: 'new', why: 'no plan and no ai: label' };
}

/**
 * The `## Analysis` block — the administrator's own reading, which is distinct from the reported text and
 * often the most useful sentence on the item.
 *
 * A line scan rather than a regex, because the block is frequently EMPTY. In the project this came from, a
 * feedback form appended the heading whether or not anybody typed under it, so the heading was immediately
 * followed by the `---` rule opening a provenance table. A lazy `[\s\S]*?` reaching for `\n---` cannot match
 * a `---` sitting at the very start of the group, so it ran to the end of the description and reported the
 * whole provenance table as what the administrator had written. Stopping at a line is exact.
 *
 * Both this and `fieldFrom()` degrade to "" on a hand-filed item that has no such structure, which is the
 * normal case here until something files items automatically.
 */
export function analysisBlock(description) {
  const lines = (description || '').split(/\r?\n/);
  const start = lines.findIndex((l) => /^##[ \t]*Analysis[ \t]*$/.test(l));
  if (start < 0) return '';
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trimEnd() === '---' || line.startsWith('## ')) break;
    body.push(line);
  }
  return body.join('\n').trim();
}

/**
 * The value cell of the first `| Name | value |` row. A row followed by a `|---|` separator is a table's
 * HEADER, not a field: a seeded body's `| Category | Count |` table read as category "Count" (#39).
 *
 * Only a GFM delimiter row counts as that separator: it has a pipe, and every cell is `:?-+:?`. A `---`
 * rule or a bare `-` under the last field row ends the table, and the row above it is still a field.
 */
function isTableSeparator(line) {
  if (!line.includes('|')) return false;
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|');
  return cells.every((c) => /^\s*:?-+:?\s*$/.test(c));
}

export function fieldFrom(description, name) {
  const row = new RegExp(`\\|\\s*${name}\\s*\\|\\s*([^|]+?)\\s*\\|`);
  const lines = (description || '').split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    const m = row.exec(line);
    if (m && !isTableSeparator(lines[i + 1] ?? '')) return m[1].replace(/`/g, '').trim();
  }
  return '';
}

/**
 * A confidential item never reaches a listing, and that is a security control rather than a preference.
 *
 * `SECURITY.md` tells a reporter to open a **confidential** work item. GitLab shows those to project
 * members only — but this token is a project member, and `list --hook` runs on `SessionStart`, so without
 * this filter the title of a vulnerability report would be printed into the board report of every agent
 * session opened on this repository, and from there into transcripts nobody audits. The disclosure route
 * would leak by existing.
 *
 * The filter is on the listing, not on the API call: `/issues?confidential=false` would ask the server to
 * decide, and a server that ever answers wrong fails open. Deciding here fails closed — an item whose
 * flag we cannot read is treated as confidential.
 *
 * GitHub issues have no such flag. Its adapter reads a `confidential` label as one, so a board moved from
 * GitLab keeps its confidential items' titles out of listings, release notes and the session-start report;
 * the label hides nothing from a reader of the repository. A new vulnerability report on GitHub goes to
 * private vulnerability reporting, off the board (docs/adr/0002-board-provider-adapters.md).
 *
 * `show <iid>` still reaches one, because reading a report you were told about is the point; it requires
 * `--confidential` so that it cannot happen by accident, and prints a banner rather than JSON on its own.
 */
export function isConfidential(item) {
  return item?.confidential !== false;
}

/**
 * An item's title as output may show it: `(confidential)` for a confidential item unless the caller was told
 * it may (`show --confidential`). Every place that prints ANOTHER item's
 * title goes through this (#31): the adapters stay unredacted, because they also feed writes, and a redacted
 * title written back would overwrite the real one.
 */
export function shownTitle(item, { allow = false } = {}) {
  return isConfidential(item) && !allow ? '(confidential)' : item.title;
}

/** A confidential sibling's `why`: the state is what the hold needs, and the reason may name a replier. */
export const WITHHELD_WHY = 'withheld: a confidential item';

/**
 * `collisions` without a confidential item's code locations (#31). A plan's citations on a vulnerability
 * report say where the hole is, so the file and lines leave the report; the fact that the item overlaps
 * another stays, because that is what keeps two branches from colliding. `secret` is the set of confidential
 * iids. Returns the rows without them, and one `{ a, b, rel }` per pair that touched one, at its strongest
 * relation: `same`, then `near`, then `file`. Pure.
 */
export function redactCollisions(rows, secret) {
  const rank = { same: 0, near: 1, file: 2 };
  const pairs = new Map();
  const kept = [];
  for (const r of rows) {
    for (const h of r.iids.filter((i) => secret.has(i))) {
      for (const o of r.iids) {
        if (o === h) continue;
        const [a, b] = [h, o].sort((x, y) => x - y);
        const rel = r.hunks.find((x) => x.a === a && x.b === b)?.rel ?? 'file';
        const prev = pairs.get(`${a}|${b}`);
        if (!prev || rank[rel] < rank[prev.rel]) pairs.set(`${a}|${b}`, { a, b, rel });
      }
    }
    const iids = r.iids.filter((i) => !secret.has(i));
    const hunks = r.hunks.filter((x) => !secret.has(x.a) && !secret.has(x.b));
    if (iids.length >= 2) kept.push({ file: r.file, iids, hunks });
  }
  return { rows: kept, withheld: [...pairs.values()].sort((x, y) => x.a - y.a || x.b - y.b) };
}

/** A sibling that is not ready blocks implementation — closed and parked ones do not. */
export function blockingSiblings(sibs) {
  return (sibs || []).filter((s) => !s.closed && !['ready', 'implementing', 'parked'].includes(s.state));
}

/**
 * Which files in a screenshot directory are worth attaching, in a stable order.
 *
 * The ordering is the part that matters to a reviewer, who reads the attachments top to bottom and should
 * get the same sequence every run rather than whatever order the filesystem happened to hand back.
 */
export function pickShots(names) {
  return names.filter((n) => !n.startsWith('.') && /\.png$/i.test(n)).sort((a, b) => a.localeCompare(b));
}

/** The attachment ceiling on both providers. Refusing here names the file; the API's 413 does not. */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/**
 * What `mr-status <branch> --json` prints: the newest request from the branch, read by `getMr` so it says
 * who merged it, or null when the branch has none. Read by the setup guide's demo step, which must not
 * parse prose; `mergedByBot` is how it tells a person's merge from the App's.
 */
export function mrStatus(branch, mr) {
  return {
    branch,
    mr: mr
      ? { iid: mr.iid, url: mr.url, state: mr.state, mergedBy: mr.mergedBy, mergedByBot: mr.mergedByBot }
      : null,
  };
}

/**
 * What an item's labels should read once it is closed.
 *
 * Separate from the close command for the reason every other function here is separate: the rule is the
 * thing worth pinning, and it cannot be pinned through a network call. Everything that is not ours
 * survives — `feedback`, and whatever a human put there — and every `ai:` label goes.
 *
 * **Why closing drops them rather than leaving them.** The `ai:` labels are a state machine over *open*
 * work: `analysing` says a run is in flight, `plan-posted` says the ball is with the reporter,
 * `implementing` says a branch exists. None of those is true of a closed item, and `list` only ever
 * shows open ones — so the label is invisible while it is wrong, and wrong the moment somebody reopens
 * the item to say the fix missed something. AGENTS.md's rule is that a stale item is worse than one
 * nobody opened; this is that rule applied to the last transition, which is otherwise the easiest one
 * to leave half-done, because nobody is looking at the board afterwards.
 */
export function labelsAfterClose(labels) {
  return (labels || []).filter((l) => !AI_LABEL_SET.has(l)).sort();
}

/**
 * The `ai:` labels an item is carrying — what a close would take off it.
 *
 * Separate from {@link labelsAfterClose}, because the two answer different questions and the close path
 * needs both: what to keep, and whether there is anything to do at all. An already-closed item with no
 * `ai:` label needs no write; one with a label still does, and that is the common case, since a merge
 * request saying `Closes #13` closes the item before this command ever runs.
 */
export function aiLabelsOn(labels) {
  return (labels || []).filter((l) => AI_LABEL_SET.has(l)).sort();
}

// ---------------------------------------------------------------------------------------------------------
// Release milestones
// ---------------------------------------------------------------------------------------------------------

/**
 * A `release-*` label names the release an item belongs to, and the milestone of the same title is the
 * same fact in the form the tracker can chart. The label is the source of truth, because it is what people
 * set when they file and triage; the milestone follows it. Two release labels on one item are a
 * contradiction this script will not resolve by picking one, so it reports them instead.
 */
export const RELEASE_LABEL = /^release-/;

/** The release an item's labels name: `{ release }` for one, `{ release: null }` for none, `{ conflict }` for two or more. */
export function releaseOf(labels) {
  const found = (labels || []).filter((l) => RELEASE_LABEL.test(l)).sort();
  if (found.length > 1) return { release: null, conflict: found };
  return { release: found[0] ?? null };
}

/**
 * What `milestones` would change, worked out without the network so the rule is asserted offline.
 *
 * `items` are Items; `milestones` maps a title to its id. An item whose release label has no milestone yet
 * is reported under `missing`, which the caller creates first. An item carrying a `release-*` milestone and
 * no release label is left alone and reported: the label may have been removed on purpose, and clearing a
 * milestone somebody set by hand is not this script's call.
 */
export function milestoneChanges(items, milestones) {
  const moves = [];
  const conflicts = [];
  const unlabelled = [];
  const missing = new Set();
  for (const item of items || []) {
    const { release, conflict } = releaseOf(item.labels);
    const current = item.milestone?.title ?? null;
    if (conflict) {
      conflicts.push({ iid: item.iid, labels: conflict });
      continue;
    }
    if (!release) {
      if (current && RELEASE_LABEL.test(current)) unlabelled.push({ iid: item.iid, milestone: current });
      continue;
    }
    if (current === release) continue;
    if (!milestones.has(release)) missing.add(release);
    moves.push({ iid: item.iid, from: current, to: release });
  }
  return { moves, conflicts, unlabelled, missing: [...missing].sort() };
}

/**
 * One row per open release milestone: its due date and how many items in it are open and closed.
 *
 * Only milestones named like a release label count, sorted by title, and an item counts under the
 * milestone the tracker has it in, which after a sweep is the one its label names.
 */
export function releaseSummary(milestones, items) {
  return (milestones || [])
    .filter((m) => RELEASE_LABEL.test(m.title) && m.state !== 'closed')
    .map((m) => {
      const inIt = (items || []).filter((i) => i.milestone?.title === m.title);
      return {
        title: m.title,
        due: m.due ?? null,
        open: inIt.filter((i) => i.state === 'open').length,
        closed: inIt.filter((i) => i.state === 'closed').length,
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title, 'en', { numeric: true }));
}

export function formatRelease(r) {
  return `${r.title}${r.due ? ` (due ${r.due})` : ''}: ${r.open} open, ${r.closed} closed`;
}

// ---------------------------------------------------------------------------------------------------------
// Links written into the item body (GitHub)
// ---------------------------------------------------------------------------------------------------------

/**
 * GitHub has no symmetric "relates to" link: its dependencies are directional, and sub-issues are the
 * umbrella shape the kit says must not hold. So a link is a line of its own in the issue body,
 * `Relates-to: #n`, which GitHub also renders as a cross-reference in both timelines. Editing the line out
 * by hand removes the hold, which is the documented way to do it without the tool.
 */
const RELATES_TO = /^Relates-to: #(\d+)\s*$/;

/** The item numbers a body links to, in the order written, each once. */
export function relatesTo(body) {
  const out = [];
  for (const line of (body || '').split(/\r?\n/)) {
    const m = RELATES_TO.exec(line);
    if (m && !out.includes(Number(m[1]))) out.push(Number(m[1]));
  }
  return out;
}

/** The body with a `Relates-to: #n` line as its last line; unchanged when the line is already there. */
export function addRelatesTo(body, n) {
  if (relatesTo(body).includes(Number(n))) return body || '';
  const text = (body || '').replace(/\s+$/, '');
  return `${text}${text ? '\n\n' : ''}Relates-to: #${n}`;
}

/** The body without its `Relates-to: #n` line(s); every other line, and its trailing text, kept. */
export function stripRelatesTo(body, n) {
  const kept = (body || '').split(/\r?\n/).filter((line) => Number(RELATES_TO.exec(line)?.[1]) !== Number(n));
  return kept.join('\n').replace(/\s+$/, '');
}

// ---------------------------------------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------------------------------------

/**
 * Every `file:line` a plan cites.
 *
 * Plans are required to cite their evidence as `path/file.ts:123`, which means the board already knows which
 * code each open item touches — and a DERIVED collision report cannot go stale the way a hand-written "these
 * three overlap" note does. Same argument the inert-control audit makes for enumerating rather than listing.
 */
export function citations(body, resolve = (f) => f) {
  const out = [];
  // A BARE filename counts. In the project this came from, requiring a directory prefix made the tool miss
  // the ONE pair of items both plans explicitly said must be done together, because prose naturally writes
  // `engine.ts:829` rather than the full path — so that item appeared to cite the file not at all.
  // Under-reporting is the dangerous direction here: a missed collision is two developers in one hunk, a
  // noisy one is a glance.
  //
  // KEEP THIS EXTENSION LIST IN STEP WITH THE PROJECT'S LANGUAGES. An extension missing from it makes every
  // citation of such a file invisible to `collisions`, silently and in the dangerous direction.
  const EXT = 'ts|tsx|mts|mjs|js|jsx|py|go|rs|java|kt|cs|rb|php|sql|sh|html|css|scss|md|yml|yaml|toml';
  const re = new RegExp(
    String.raw`\b((?:[\w.-]+\/)*[\w.-]+\.(?:${EXT}))(?::(\d+)(?:\s*[-–]\s*(\d+))?)?`,
    'g',
  );
  for (const m of body.matchAll(re)) {
    const file = resolve(m[1]);
    if (!file) continue; // an unresolvable or ambiguous bare name is not a citation
    const from = m[2] ? Number(m[2]) : null;
    const to = m[3] ? Number(m[3]) : from;
    out.push({ file, from, to });
  }
  return out;
}

// A citation spanning more than this many lines is describing a FILE, not a hunk. One audit cited
// `defaults.ts:2-116` — the whole scenario-key block — which overlapped every other citation in that file
// and made it collide with everything. A wide range still counts towards "these items share a file"; it
// just cannot claim a shared hunk.
const HUNK_MAX_LINES = 40;

// Two citations this close are in the same function even when they do not intersect, and two branches
// editing one function conflict whether or not they touch the same line. The case that forced this: two
// plans said, independently, "fix these together in engine.ts:820-872" — and their cited lines (826-829,
// 904 against 857-858, 900) never overlap, so a strict intersection test reported nothing at all about the
// one pair the plans were loudest about.
const NEAR_LINES = 60;

/**
 * How two cited ranges relate: `same` lines, `near` (same neighbourhood), or null.
 *
 * A file in common is weak, a neighbourhood in common is worth sequencing, and the same lines are not
 * negotiable. Line distance is still only a PROXY for conflict — which is why an explicit link on the
 * items remains the stronger signal where somebody has judged it.
 */
export function relation(a, b) {
  if (a.from == null || b.from == null) return null;
  if (a.to - a.from > HUNK_MAX_LINES || b.to - b.from > HUNK_MAX_LINES) return null;
  if (a.from <= b.to && b.from <= a.to) return 'same';
  const gap = a.from > b.to ? a.from - b.to : b.from - a.to;
  return gap <= NEAR_LINES ? 'near' : null;
}

// ---------------------------------------------------------------------------------------------------------
// Batch create (`create --batch`)
// ---------------------------------------------------------------------------------------------------------

/**
 * One file seeds many items: a modernization plan, an audit's findings, an adoption checklist. The format
 * is Markdown, so a body stays plain Markdown and each entry is exactly a `create` file:
 *
 *   Batch: modernize-2026          <- names the batch; other lines before the first entry are notes
 *
 *   === inventory                  <- an entry, by a local key
 *   Labels: release-1.0.0, feedback
 *   Needs: #12                     <- created after these; written as "Depends on #n" text, NOT a link
 *   Relates: audit                 <- a real link, and so a hold (advance-work-items)
 *
 *   Inventory the services         <- the title, as in `create`; the rest is the body
 *
 * `Needs:` is text on purpose: a link is a hold, and a seeded board whose later phases are linked to its
 * earlier ones would block itself (#36, REVIEW 3). Re-running is safe because every created body carries a
 * hidden marker naming its batch and key, and the board itself is read back for it: there is no local
 * state to lose, or to go wrong when a second person runs the file.
 */
// The id and key classes are written once; the marker and the ref patterns are built from them.
const ID = '[A-Za-z0-9._-]+';
const KEY = '[a-z0-9-]+';
const BATCH_ID = new RegExp(`^${ID}$`);
const BATCH_KEY = new RegExp(`^${KEY}$`);
const BATCH_ENTRY = /^=== (\S+)\s*$/;
const BATCH_HEADER = /^(Labels|Needs|Relates):\s*(.*)$/;
const BATCH_MARKER = new RegExp(`^<!-- factory-kit-batch: (${ID})/(${KEY}) -->$`);
const BATCH_REF = new RegExp(`^(?:#\\d+|${KEY})$`);

/** The hidden line a batch-created body carries, which is how a re-run knows the entry exists. */
export function batchMarker(batch, key) {
  return `<!-- factory-kit-batch: ${batch}/${key} -->`;
}

/** The colour and description `create --batch` gives a `release-*` label it has to create. */
export const RELEASE_LABEL_COLOUR = [
  '#0E7490', // not an `ai:` colour, so a release label never reads as a state
  'The release this item belongs to; its milestone follows it.',
];

/**
 * A batch file as `{ batch, entries, errors }`. Each entry is `{ key, line, labels, needs, relates, title,
 * body }`, where a ref in `needs` and `relates` is a key or `#n`. Every problem is collected, with its line,
 * so one dry run shows them all; nothing is written while `errors` is not empty.
 */
export function parseBatch(text) {
  const errors = [];
  const entries = [];
  let batch = null;
  let cur = null;
  (text || '').split(/\r?\n/).forEach((line, i) => {
    const n = i + 1;
    const head = BATCH_ENTRY.exec(line);
    if (head) {
      if (!BATCH_KEY.test(head[1])) errors.push(`line ${n}: key "${head[1]}" is not [a-z0-9-]+`);
      cur = { key: head[1], line: n, labels: [], needs: [], relates: [], text: [], seen: new Set() };
      entries.push(cur);
      return;
    }
    if (!cur) {
      const m = /^Batch:\s*(.*)$/.exec(line);
      if (!m) return;
      const id = m[1].trim();
      if (batch !== null) errors.push(`line ${n}: a second Batch: line`);
      else if (!BATCH_ID.test(id)) errors.push(`line ${n}: batch id "${id}" is not [A-Za-z0-9._-]+`);
      else batch = id;
      return;
    }
    // Header lines, and blank lines, until the first line of the entry's own text, which is its title.
    const h = !cur.text.length && BATCH_HEADER.exec(line);
    if (h) {
      if (cur.seen.has(h[1])) {
        errors.push(`line ${n}: a second ${h[1]}: line in ${cur.key}`);
        return;
      }
      cur.seen.add(h[1]);
      if (h[1] === 'Labels') {
        cur.labels = h[2]
          .split(',')
          .map((l) => l.trim())
          .filter(Boolean);
        return;
      }
      const refs = h[2].split(/[\s,]+/).filter(Boolean);
      for (const r of refs) if (!BATCH_REF.test(r)) errors.push(`line ${n}: "${r}" is neither a key nor #n`);
      cur[h[1].toLowerCase()] = [...new Set(refs)];
      return;
    }
    if (!cur.text.length && !line.trim()) return;
    cur.text.push(line);
  });

  if (batch === null) errors.push('no "Batch: <id>" line before the first entry');
  if (!entries.length) errors.push('no entries: each one starts with a line "=== <key>"');
  const keys = new Set();
  const out = entries.map(({ key, line, labels, needs, relates, text: body }) => {
    if (keys.has(key)) errors.push(`line ${line}: key "${key}" is used twice`);
    keys.add(key);
    const title = (body[0] ?? '').replace(/^#+\s*/, '').trim();
    if (!title) errors.push(`line ${line}: ${key} has no title`);
    const { conflict } = releaseOf(labels);
    if (conflict) errors.push(`line ${line}: ${key} has two release labels, ${conflict.join(' and ')}`);
    return { key, line, labels, needs, relates, title, body: body.slice(1).join('\n').trim() };
  });
  return { batch, entries: out, errors };
}

/**
 * The order a parsed batch is created in, against the board's full listing (open AND closed: a closed item
 * was still created). Returns `{ steps, errors }`; each step is the entry plus `iid`, the item that already
 * carries its marker or null, and `links`, the `Relates:` edges that become writable at this step.
 *
 * The order follows `Needs:`, stable by file order, so a `Depends on #n` line can carry a real number. An
 * edge is written once, at whichever of its two ends comes later, so no item is ever linked to a number
 * that does not exist yet.
 */
export function planBatch({ batch, entries }, items) {
  const errors = [];
  const byKey = new Map(entries.map((e) => [e.key, e]));
  const known = new Set((items || []).map((i) => i.iid));

  const found = new Map();
  for (const item of items || []) {
    for (const line of (item.description || '').split(/\r?\n/)) {
      const m = BATCH_MARKER.exec(line.trim());
      if (!m || m[1] !== batch) continue;
      if (!found.has(m[2])) found.set(m[2], new Set());
      found.get(m[2]).add(item.iid);
    }
  }
  // Two items claiming one key is somebody's copy-paste or a race; which one counts is a person's call.
  for (const [key, iids] of found) {
    if (iids.size > 1 && byKey.has(key))
      errors.push(`${key} is already on the board twice, as ${[...iids].map((n) => `#${n}`).join(' and ')}`);
  }

  for (const e of entries) {
    for (const [field, refs] of [
      ['Needs', e.needs],
      ['Relates', e.relates],
    ]) {
      for (const r of refs) {
        const isIid = r.startsWith('#');
        if (r === e.key) errors.push(`${e.key}: ${field} names itself`);
        else if (isIid ? !known.has(Number(r.slice(1))) : !byKey.has(r))
          errors.push(
            `${e.key}: ${field} names ${r}, which is ${isIid ? 'not on the board' : 'no entry in this file'}`,
          );
      }
    }
  }
  if (errors.length) return { steps: [], errors };

  // Stable topological order: each round places the first entry, in file order, whose needs are placed.
  const placed = [];
  const at = new Map();
  const waiting = [...entries];
  const unplaced = (r) => !r.startsWith('#') && !at.has(r);
  while (waiting.length) {
    const i = waiting.findIndex((e) => !e.needs.some(unplaced));
    if (i === -1) {
      // Every waiting entry needs another waiting one, so following the first such need must loop.
      const path = [];
      let e = waiting[0];
      while (!path.includes(e.key)) {
        path.push(e.key);
        e = byKey.get(e.needs.find(unplaced));
      }
      const cycle = [...path.slice(path.indexOf(e.key)), e.key];
      return { steps: [], errors: [`Needs: goes round in a circle: ${cycle.join(' -> ')}`] };
    }
    const [e] = waiting.splice(i, 1);
    at.set(e.key, placed.length);
    placed.push(e);
  }

  const steps = placed.map((e, p) => {
    const ends = [...e.relates, ...entries.filter((o) => o.relates.includes(e.key)).map((o) => o.key)];
    const links = [...new Set(ends)].filter((r) => r.startsWith('#') || at.get(r) < p);
    return { ...e, iid: found.has(e.key) ? [...found.get(e.key)][0] : null, links };
  });
  return { steps, errors };
}

/**
 * A batch entry's description: its body, a `Depends on` line for what it needs, the marker, and on GitHub
 * the `Relates-to` lines, which are how a link is written there (`addRelatesTo`), so one POST carries all.
 */
export function batchBody(step, batch, { depends = [], relates = [] } = {}) {
  const parts = [step.body];
  if (depends.length) parts.push(`Depends on ${depends.map((n) => `#${n}`).join(', ')}`);
  parts.push(batchMarker(batch, step.key));
  let text = parts.filter(Boolean).join('\n\n');
  for (const n of relates) text = addRelatesTo(text, n);
  return text;
}

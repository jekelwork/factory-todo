// Read and annotate the work-item board for this project, on GitLab or GitHub. DEVELOPER TOOLING, not
// product code.
//
// Part of the Factory Kit. First written for a pricing calculator, after a session had no idea sixteen work
// items were sitting open and the one run that did analyse them was driven by a throwaway script in a
// temporary directory. Hardened on Makers Market over a few hundred items, and extracted from there.
// The comments keep the incidents that shaped it, because each one is the reason for a line of code.
//
// DEVELOPER TOOLING, deliberately: a board reader with a read/write credential has no business shipping, and
// nothing in `scripts/` belongs in a deployable image. If your product ever needs to write to the tracker
// itself, give it a credential of its own with its own scope; never reuse this one.
//
// This file is the CLI: arguments, commands and output. It talks to a board adapter (scripts/board/gitlab.mjs
// or github.mjs, chosen by which of .env.gitlab and .env.github exists) and never to fetch; the rules live
// in scripts/board/core.mjs, and docs/adr/0002-board-provider-adapters.md says why the split is there.
//
// The `selftest` subcommand runs in `lefthook.yml`'s pre-push hook, because it is offline and instant.
// Everything else is deliberately NOT wired into `pnpm check` or CI: CI holds no board credential, and a
// pipeline that is able to comment on issues is a pipeline that will eventually comment on the wrong one.
//
// Usage:
//   node scripts/work-items.mjs list [--new|--answered|--ready|--blocked|--parked|--stale] [--brief|--json]
//   node scripts/work-items.mjs show <iid> [--confidential]
//   node scripts/work-items.mjs collisions [--json] [--confidential]   # which code two open items both touch
//   node scripts/work-items.mjs comment <iid> <file>
//   node scripts/work-items.mjs screenshots <iid> <dir> [intro-file]   # attach e2e PNGs to the item
//   node scripts/work-items.mjs label <iid> <analysing|plan-posted|answered|ready|blocked|parked|implementing|none>
//   node scripts/work-items.mjs label <iid> release-<x.y.z>   # put an item in a release; the milestone follows
//   node scripts/work-items.mjs create <file> [relates-to-iid] [labels]   # open a linked follow-up item
//   node scripts/work-items.mjs create --batch <file> [--apply]   # many items from one file; dry run by default
//   node scripts/work-items.mjs unlink <iid> <other-iid>   # remove a link, and the sibling hold it carries
//   node scripts/work-items.mjs close <iid>   # close it, and drop the ai: label with it
//   node scripts/work-items.mjs milestones [--dry-run]   # put every item in the milestone its release-* label names
//   node scripts/work-items.mjs releases [<milestone>]   # the open release milestones, or what one holds
//   node scripts/work-items.mjs mr|pr <branch> <file> [title] [--target=<branch>]   # open a merge/pull request
//   node scripts/work-items.mjs mr-status <branch> [--json]   # read-only: the branch's newest request, who merged it
//   node scripts/work-items.mjs release prepare|finalize|deck <release-x.y.z> …   # see scripts/board/release.mjs
//   node scripts/work-items.mjs selftest            # the rules, offline (pnpm check:items)
//
// `<iid>` is the issue number on either provider. Exit codes carry meaning:
//   0  fine
//   1  usage or logic failure
//   3  the board unreachable or unconfigured — the session-start hook swallows this, because a harness that
//      breaks a session when the VPN is down is worse than no harness.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { cmdBatch } from './board/batch.mjs';
import { BoardError, detectProvider, envReader, openBoard, ROOT } from './board/config.mjs';
import {
  AI_LABEL_SET,
  AI_LABELS,
  aiLabelsOn,
  analysisBlock,
  blockingSiblings,
  citations,
  classify,
  commentKind,
  fieldFrom,
  formatRelease,
  isConfidential,
  LABEL_COLOURS,
  labelsAfterClose,
  milestoneChanges,
  mrStatus,
  PLAN_MARKER,
  pickShots,
  RELEASE_LABEL,
  redactCollisions,
  relation,
  releaseOf,
  releaseSummary,
  shownTitle,
} from './board/core.mjs';
import { checkoutHooks, cmdRelease, hookFlags } from './board/release.mjs';
import { siblings } from './board/siblings.mjs';

/**
 * Every open item with its state. Comments are fetched only for items that HAVE comments — the count comes
 * back on the issue payload, so a board of nothing but new work costs one request per page.
 */
async function board(b) {
  const all = await b.listOpen();
  const items = all.filter((i) => !isConfidential(i));
  const withheld = all.length - items.length;
  const meId = await b.whoami();
  const out = [];
  for (const item of items.sort((x, y) => x.iid - y.iid)) {
    const comments = item.commentCount > 0 ? await b.comments(item.iid) : [];
    out.push({
      iid: item.iid,
      title: item.title,
      url: item.url,
      labels: item.labels,
      notes: comments.length,
      category: fieldFrom(item.description, 'Category'),
      reporter: fieldFrom(item.description, 'Reported by'),
      screen: fieldFrom(item.description, 'Screen'),
      created: item.createdAt.slice(0, 10),
      ...classify(item, comments, meId),
    });
  }
  // Sibling state is only consulted for the items somebody is about to act on. Resolving it for the whole
  // board would cost two requests per link on every session start, to answer a question nobody has asked
  // about an item that is still awaiting its reporter.
  for (const row of out) {
    if (row.state !== 'ready' && row.state !== 'answered') continue;
    const sibs = await siblings(b, row.iid, meId);
    row.siblings = sibs;
    row.blockedBy = blockingSiblings(sibs).map((s) => ({ iid: s.iid, state: s.state }));
  }
  // Said on stderr, never on stdout: `--json` and `--hook` are parsed, and an empty board that does not
  // explain itself is how a filter gets mistaken for an outage.
  if (withheld > 0) {
    console.error(
      `note: ${withheld} confidential item(s) withheld from this listing — see SECURITY.md. ` +
        'Read one with `pnpm items show <iid> --confidential`.',
    );
  }

  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------------------

async function cmdList(b, flags) {
  let rows = await board(b);
  const wanted = ['new', 'answered', 'ready', 'blocked', 'parked', 'stale'].filter((f) =>
    flags.has(`--${f}`),
  );
  if (wanted.length) rows = rows.filter((r) => wanted.includes(r.state));

  if (flags.has('--json')) {
    console.log(JSON.stringify(rows, null, 1));
    return 0;
  }

  if (flags.has('--hook')) {
    // The SessionStart channel. A hook's plain stdout is added to the MODEL's context and is not shown to
    // the person at the terminal — so a hook that printed only text fired correctly and looked broken,
    // which is exactly how this was misdiagnosed once. The JSON envelope carries both: `systemMessage` is
    // what the user sees, `additionalContext` is what the session knows.
    const ACT = ['new', 'answered', 'ready', 'blocked', 'stale'];
    const act = rows.filter((r) => ACT.includes(r.state));
    if (!act.length) return 0; // silence when the board is quiet
    const lines = act.map((r) => `#${r.iid} ${r.state} — ${r.title.slice(0, 72)}`);
    const summary = `${b.label} work-item board: ${act.length} item(s) need attention.\n${lines.join('\n')}`;
    console.log(
      JSON.stringify({
        systemMessage: `${summary}\n\`pnpm items list\` for the whole board.`,
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext:
            `${summary}\n\nThe triage-work-items skill analyses a \`new\` item; ` +
            `advance-work-items handles \`answered\`, \`ready\` and \`blocked\`. Nothing is dispatched ` +
            `without the user's go, and a \`parked\` item is not to be worked on unless they name it.`,
        },
      }),
    );
    return 0;
  }

  if (flags.has('--brief')) {
    // What the SessionStart hook prints. Silence when there is nothing to act on: a harness that says
    // something every single session gets ignored, and then says nothing when it matters.
    const ACT = ['new', 'answered', 'ready', 'blocked', 'stale'];
    const act = rows.filter((r) => ACT.includes(r.state));
    if (!act.length) return 0;
    console.log(`${b.label} work-item board (${b.where}) — ${act.length} item(s) need attention:`);
    for (const r of act) {
      const held = r.blockedBy?.length
        ? `  [held by ${r.blockedBy.map((s) => `#${s.iid} ${s.state}`).join(', ')}]`
        : '';
      console.log(`  #${r.iid} ${r.state.padEnd(11)} ${r.title.slice(0, 60)}${held}`);
    }
    // Name the skill per state, so the report says what to do rather than only what is true. `new` is the
    // only one that starts from scratch; the rest are an item already under way.
    const kinds = new Set(act.map((r) => r.state));
    if (kinds.has('new')) console.log(`  → new: the triage-work-items skill (analyse, then post a plan).`);
    if (kinds.has('answered') || kinds.has('stale'))
      console.log(
        `  → answered/stale: the advance-work-items skill (assess coverage of the [REVIEW] points).`,
      );
    if (kinds.has('ready'))
      console.log(
        `  → ready: every [REVIEW] point is answered. Say go and advance-work-items implements it.`,
      );
    if (kinds.has('blocked'))
      console.log(
        `  → blocked: a [REVIEW] point survived two rounds on the ticket. It needs a conversation, not another comment.`,
      );
    console.log(`  \`pnpm items list\` for the whole board. Nothing is dispatched without your go.`);
    return 0;
  }

  for (const r of rows) {
    console.log(
      `#${String(r.iid).padEnd(3)} ${r.state.padEnd(12)} ${String(r.notes).padStart(2)} note(s)  ${String(r.rounds)} round(s)  ${r.category.padEnd(8)} ${r.title.slice(0, 52)}`,
    );
    console.log(`     ${r.why} · ${r.url}`);
    if (r.blockedBy?.length) {
      console.log(
        `     HELD: linked sibling(s) not ready — ${r.blockedBy.map((s) => `#${s.iid} is ${s.state}`).join(', ')}`,
      );
    }
  }
  if (!rows.length) console.log('nothing matching.');
  return 0;
}

async function cmdShow(b, iid, { allowConfidential = false } = {}) {
  const item = await b.get(iid);
  if (isConfidential(item) && !allowConfidential) {
    // Not a refusal to help — a refusal to print a vulnerability report into a transcript by accident.
    console.error(
      `#${iid} is confidential. It is not printed by default, because this output ends up in session ` +
        'transcripts and pasted into comments. Re-run with --confidential if you mean to read it, and ' +
        'keep what you find out of board comments, commit messages and merge requests (SECURITY.md).',
    );
    process.exit(2);
  }
  const comments = await b.comments(iid);
  const meId = await b.whoami();
  const kindOf = (n) => commentKind(n, meId);
  console.log(
    JSON.stringify(
      {
        iid: item.iid,
        title: item.title,
        url: item.url,
        labels: item.labels,
        created: item.createdAt,
        category: fieldFrom(item.description, 'Category'),
        reporter: fieldFrom(item.description, 'Reported by'),
        screen: fieldFrom(item.description, 'Screen'),
        build: fieldFrom(item.description, 'Build'),
        description: item.description,
        reporterAnalysis: analysisBlock(item.description),
        ...classify(item, comments, meId),
        /**
         * Whether the tracker considers the issue shut, which `state` above does NOT answer.
         *
         * `classify` returns its own `state` — the `ai:` workflow position, `new` through `implementing` —
         * and it is spread after this object's other fields, so a `state: item.state` here was silently
         * overwritten and open/closed was never printed at all. A reader then sees `new` on a closed item
         * and concludes it is open, which happened: a posted plan claimed two shipped items were "still
         * open and unlabelled" because of this line.
         *
         * Two names rather than one, because they are two different questions: `state` is where the item
         * sits in the analysis workflow, `closed` is whether anybody can still work on it.
         */
        closed: item.state === 'closed',
        siblings: await siblings(b, iid, meId, { allowConfidential }),
        // `kind` is what the coverage pass reads: which comment is the plan in force, which are the rounds
        // already asked, and which are the reporter's own words to be mapped onto the [REVIEW] points.
        comments: comments.map((n) => ({
          author: n.author,
          at: n.createdAt,
          kind: kindOf(n),
          body: n.body,
        })),
      },
      null,
      1,
    ),
  );
  return 0;
}

async function cmdComment(b, iid, file) {
  const body = fs.readFileSync(file, 'utf8');
  if (!body.trim()) {
    console.error(`${file} is empty — refusing to post a blank comment`);
    return 1;
  }
  const note = await b.comment(iid, body);
  console.log(`posted note ${note.id} on #${iid} (${body.length} chars)`);
  return 0;
}

/**
 * Open a follow-up item and link it to the one it was split out of.
 *
 * Written for the shape that keeps recurring: a plan is agreed, part of it is deliberately cut, and the
 * cut part has to become something somebody else can read. Until now that meant opening a browser, which
 * meant it was done from memory afterwards or not at all — and an item whose dropped half exists only in
 * a session transcript is exactly the stale board AGENTS.md warns about.
 *
 * Two writes, deliberately in this order: create first, then link. A created item with no link is a
 * recoverable mistake somebody can see on the board; a link to an item that failed to be created is not a
 * thing.
 *
 * Labels are passed through verbatim so the caller decides the state the new item opens in. Nothing here
 * defaults to an `ai:` label: the state machine computes `new` from their absence, and an item born
 * already claiming to be analysed would lie on the first board report anybody read.
 */
async function cmdCreate(b, file, relatesTo, labels) {
  const text = fs.readFileSync(file, 'utf8');
  if (!text.trim()) {
    console.error(`${file} is empty — refusing to open a blank work item`);
    return 1;
  }
  // First line is the title, the rest is the description. One file, so the two cannot drift apart
  // between an editor and a shell argument, and the title is reviewable in the same diff as the body.
  const nl = text.indexOf('\n');
  const title = (nl === -1 ? text : text.slice(0, nl)).replace(/^#+\s*/, '').trim();
  const description = nl === -1 ? '' : text.slice(nl + 1).trim();
  if (!title) {
    console.error(`${file} has no title on its first line`);
    return 1;
  }
  const created = await b.create({
    title,
    description,
    labels: (labels || '')
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean),
  });
  console.log(`opened #${created.iid}  ${title}`);
  console.log(created.url);
  await syncMilestone(b, created);
  if (relatesTo) {
    try {
      await b.link(created.iid, relatesTo);
      console.log(`linked #${created.iid} <-> #${relatesTo}`);
    } catch (e) {
      // The item exists and is the thing that mattered; say the link failed rather than losing it in a
      // stack trace, and let the caller add it by hand.
      console.error(`created, but linking to #${relatesTo} failed: ${e.message}`);
      return 1;
    }
  }
  return 0;
}

/**
 * Remove the link between two items, which `create` adds and nothing else could take away.
 *
 * Needed because a link is also a hold: `advance-work-items` refuses to start an item while a linked
 * sibling is not ready. That is right for two halves of one defect, and wrong for an umbrella and the
 * items under it, or for a later stage split off an item that is still open — there the link blocks the
 * item that has to go first. On Makers Market, seven such links once held five ready items behind an umbrella
 * and two follow-ups. The text of each item still names the others; only the hold goes.
 */
async function cmdUnlink(b, iid, other) {
  if (!(await b.unlink(iid, other))) {
    console.error(`#${iid} is not linked to #${other} — nothing to remove`);
    return 1;
  }
  console.log(`unlinked #${iid} <-> #${other}`);
  return 0;
}

/**
 * Open a merge request (a pull request on GitHub) for a branch that is already pushed.
 *
 * Deliberately does not push: the branch is expected to be on the remote already, by whatever credential
 * normally pushes (usually the developer's own git credentials, not the board's). This does one thing —
 * turn a pushed branch into a reviewable merge request with a written description.
 *
 * The title defaults to the branch head's commit subject, because that is the convention this project
 * already follows and a title typed twice is a title that drifts. Pass one to override it.
 *
 * The target defaults to the project's default branch. `--target=<branch>` overrides it, because work built
 * on a version line branch (`release-1.2.x`, while the default branch deploys to live) needs its merge
 * requests to land there, and a default that silently points at `main` is the wrong way to fail.
 */
async function cmdMr(b, branch, file, title, targetBranch) {
  const unavailable = b.mrUnavailable();
  if (unavailable) {
    console.error(unavailable);
    return 1;
  }
  const description = fs.readFileSync(file, 'utf8');
  if (!description.trim()) {
    console.error(`${file} is empty — refusing to open a merge request with a blank description`);
    return 1;
  }
  const subject =
    title ??
    (() => {
      for (const ref of [branch, `origin/${branch}`]) {
        try {
          return execFileSync('git', ['log', '-1', '--format=%s', ref], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
          }).trim();
        } catch {
          /* try the next ref */
        }
      }
      return '';
    })();
  if (!subject) {
    console.error(
      `cannot read a commit subject for "${branch}" — is it pushed, and does it exist locally or as ` +
        'origin/<branch>? Pass a title explicitly to skip this.',
    );
    return 1;
  }
  const target = targetBranch ?? (await b.defaultBranch());
  let mr;
  try {
    mr = await b.openMr({ source: branch, target, title: subject, description });
  } catch (e) {
    if (e instanceof BoardError && e.code === 'forbidden') {
      console.error(b.mrForbidden);
      return 1;
    }
    throw e;
  }
  console.log(`opened ${b.mrRef(mr.iid)}  ${branch} -> ${target}`);
  console.log(mr.url);
  return 0;
}

/**
 * The newest merge request (pull request on GitHub) from a branch, and who merged it. Reads only.
 *
 * Written for the setup guide, which watches its demo item go round the loop and has to tell a person's
 * merge from the App's: a merge by the bot means the branch rules let it ship on its own, which is the one
 * thing the guide exists to show cannot happen. `findMrs` lists, and a listing does not say who merged, so
 * the newest is read again through `getMr`. `--json` is for that page; the plain form is for a person.
 */
async function cmdMrStatus(b, branch, flags) {
  const newest = (await b.findMrs({ source: branch }))[0];
  const out = mrStatus(branch, newest ? await b.getMr(newest.iid) : null);
  if (flags.has('--json')) {
    console.log(JSON.stringify(out, null, 1));
    return 0;
  }
  const { mr } = out;
  if (!mr) console.log(`no merge request from ${branch}`);
  else {
    const by =
      mr.state === 'merged' ? ` by ${mr.mergedBy ?? 'unknown'}${mr.mergedByBot ? ' (the bot)' : ''}` : '';
    console.log(`${b.mrRef(mr.iid)} ${mr.state}${by}  ${branch}`);
    console.log(mr.url);
  }
  return 0;
}

/**
 * Attach the e2e screenshots to a work item so a reviewer can see the change rather than read about it.
 *
 * On this project the screenshots ARE the review (`CLAUDE.md`), and until now they only existed in the
 * session that produced them: the reporter got a plan, then a commit, and no way to tell what the thing
 * would look like if merged short of checking the branch out. A run that has not produced a green
 * `pnpm test:e2e` has no business calling this — the images are evidence of the built UI, not of a wish.
 */
async function cmdScreenshots(b, iid, dir, introFile) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`${dir} is not a directory — run \`pnpm test:e2e\` first`);
    return 1;
  }
  const shots = pickShots(fs.readdirSync(dir));
  if (!shots.length) {
    console.error(`no .png files in ${dir} — nothing to attach`);
    return 1;
  }
  const intro = introFile ? fs.readFileSync(introFile, 'utf8').trim() : '';

  const parts = ['## How it looks', ''];
  if (intro) parts.push(intro, '');
  parts.push(
    `*${shots.length} screenshot(s) from \`pnpm test:e2e\`, taken from the implementation branch. ` +
      'This is what merging the change puts in front of a user.*',
    '',
  );
  // Checked before anything is uploaded, so a run that would fail on its last file leaves nothing behind.
  for (const name of shots) {
    const bytes = fs.statSync(path.join(dir, name)).size;
    if (bytes > b.maxUploadBytes) {
      console.error(
        `${name} is ${(bytes / 1024 / 1024).toFixed(1)} MB — over ${b.label}'s ${b.maxUploadBytes / 1024 / 1024} MB attachment cap`,
      );
      return 1;
    }
  }
  for (const name of shots) {
    const file = path.join(dir, name);
    const bytes = fs.readFileSync(file);
    const markdown = await b.upload({ name, bytes, type: 'image/png' }, { iid });
    console.log(`uploaded ${name} (${(bytes.length / 1024).toFixed(0)} kB)`);
    parts.push(`### ${name.replace(/\.png$/i, '')}`, '', markdown, '');
  }

  const body = parts.join('\n');
  const note = await b.comment(iid, body);
  console.log(`posted note ${note.id} on #${iid} with ${shots.length} screenshot(s)`);
  return 0;
}

async function cmdLabel(b, iid, state) {
  // A `release-*` label names the release an item belongs to, and the milestone follows it. It is the one
  // label outside the `ai:` set this command writes, so an item can be put in a release without the web UI.
  // It replaces any other `release-*` label, because two on one item is the state `milestones` refuses.
  if (RELEASE_LABEL.test(state)) {
    const item = await b.get(iid);
    const want = [...item.labels.filter((l) => !RELEASE_LABEL.test(l)), state].sort();
    const out = await b.setLabels(iid, want);
    console.log(`#${iid} ${JSON.stringify(item.labels)} -> ${JSON.stringify(out.labels)}`);
    await syncMilestone(b, out);
    return 0;
  }
  if (state !== 'none' && !AI_LABELS[state]) {
    console.error(`unknown state "${state}" — one of ${Object.keys(AI_LABELS).join(', ')}, or none`);
    return 1;
  }
  const target = state === 'none' ? null : AI_LABELS[state];

  if (target) {
    const [color, description] = LABEL_COLOURS[target];
    if (await b.ensureLabel(target, color, description)) console.log(`created label ${target}`);
  }

  const item = await b.get(iid);
  // Preserve everything that is not ours (`feedback`, and whatever a human added), replace the ai: one.
  const keep = item.labels.filter((l) => !AI_LABEL_SET.has(l));
  const want = [...keep, ...(target ? [target] : [])].sort();
  const out = await b.setLabels(iid, want);
  console.log(`#${iid} ${JSON.stringify(item.labels)} -> ${JSON.stringify(out.labels)}`);
  await syncMilestone(b, out);
  return 0;
}

/**
 * Close an item, and take its `ai:` label with it.
 *
 * Added after a session closed an item by hand with a one-off script, because this file had every other
 * transition and not the last one — so the command that finishes a piece of work was the one thing a
 * person had to open a browser for, or improvise a second credential path for. Both are how a board
 * goes stale.
 *
 * **One write does both**, state and labels together, so there is no window in which the item is closed
 * and still claims to be under way.
 *
 * **It warns rather than refuses when nothing has been written on the item.** AGENTS.md asks for a
 * comment naming the merge request, the commit and the merge commit before an item is closed, and that
 * record is the whole reason the board is believed — but an item filed by mistake, or a duplicate, is a
 * legitimate close with nothing to say, and a command that refuses those would be worked around within
 * the week. So it says what it found and closes anyway; the nudge is on stderr, where a human reads it
 * and a script does not trip over it.
 */
async function cmdClose(b, iid) {
  const item = await b.get(iid);
  if (item.state === 'closed') {
    /**
     * Already closed is the COMMON path, not the exception, which is why it may not simply return.
     *
     * A merge request whose description says `Closes #13` makes the tracker close the item on merge. By
     * the time anybody runs this command the issue is shut and the `ai:` label is still on it — so the
     * early return skipped the one thing left to do, and four delivered items in one session kept an
     * `ai:implementing` label until somebody removed it by hand. That is exactly the stale board this
     * command exists to prevent, arrived at from the other direction.
     */
    await syncMilestone(b, item);
    const stale = aiLabelsOn(item.labels);
    if (!stale.length) {
      console.log(`#${iid} is already closed, with no ai: label — "${shownTitle(item)}"`);
      return 0;
    }
    await b.setLabels(iid, labelsAfterClose(item.labels));
    console.log(`#${iid} was already closed — "${shownTitle(item)}"`);
    console.log(`dropped ${stale.join(', ')}`);
    console.log(item.url);
    return 0;
  }

  // Ours or the reporter's, but not the tracker's own "changed the title" entries: a system note is not a
  // record of what shipped, and counting it would make the nudge below silently useless.
  if (!(await b.comments(iid)).length) {
    console.error(
      `#${iid} has no comments — closing it leaves no record of what shipped. AGENTS.md asks for the ` +
        'merge request, the commit and the merge commit on the item before this point.',
    );
  }

  const out = await b.close(iid, labelsAfterClose(item.labels));
  await syncMilestone(b, item);
  const dropped = aiLabelsOn(item.labels);
  console.log(`#${out.iid} ${out.state} — ${shownTitle(item)}`);
  if (dropped.length) console.log(`dropped ${dropped.join(', ')}`);
  console.log(out.url);
  return 0;
}

// ---------------------------------------------------------------------------------------------------------
// Release milestones
// ---------------------------------------------------------------------------------------------------------

/** Title → id for every milestone, open or closed, creating any the caller asks for. */
async function ensureMilestones(b, titles, { dryRun = false } = {}) {
  const byTitle = new Map((await b.milestones('all')).map((m) => [m.title, m.id]));
  for (const title of titles) {
    if (byTitle.has(title)) continue;
    if (dryRun) {
      console.log(`would create milestone ${title}`);
      continue;
    }
    const created = await b.createMilestone(title);
    byTitle.set(title, created.id);
    console.log(`created milestone ${title}`);
  }
  return byTitle;
}

/**
 * Put every item, open or closed, in the milestone its `release-*` label names.
 *
 * Idempotent: an item already in the right milestone is not written. Only iids are printed, never
 * titles, so a confidential item's title does not reach a terminal log through this command.
 *
 * `--hook` is the SessionStart channel, and the reason the rule holds for everybody who clones the repo
 * rather than for whoever remembers to run it: a release label is as often set by hand in the web UI as
 * through `label`, `create` or `close` here, and those three only keep their own item in step. In that
 * mode it says nothing unless it moved something, and an unreachable board is silent like `list --hook`.
 */
async function cmdMilestones(b, flags) {
  const dryRun = flags.has('--dry-run');
  if (flags.has('--hook')) {
    // Captured rather than printed: a hook's plain stdout reaches the model and not the person, so the
    // sweep's lines and the release summary go out together in the same JSON envelope `list --hook` uses.
    const log = console.log;
    const errors = console.error;
    const lines = [];
    console.log = (line) => lines.push(line);
    console.error = (line) => lines.push(line);
    let code;
    try {
      code = await cmdMilestones(b, new Set(dryRun ? ['--dry-run'] : []));
    } finally {
      console.log = log;
      console.error = errors;
    }
    const moved = lines.slice(0, -1); // the last line is the tally, which says nothing when nothing moved
    const rows = releaseSummary(await b.milestones('open'), await b.listAll());
    if (!rows.length && !moved.length) return code;
    const parts = [];
    if (rows.length) {
      parts.push(`Release milestones: ${rows.map(formatRelease).join(' · ')}`);
      parts.push('`pnpm items releases <milestone>` lists what is in one.');
    }
    if (moved.length) parts.push(`Milestones brought in step with release-* labels:\n${moved.join('\n')}`);
    const message = parts.join('\n');
    log(
      JSON.stringify({
        systemMessage: message,
        hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: message },
      }),
    );
    return code;
  }
  const items = await b.listAll();
  const releases = [...new Set(items.map((i) => releaseOf(i.labels).release).filter(Boolean))].sort();
  const byTitle = await ensureMilestones(b, releases, { dryRun });
  const { moves, conflicts, unlabelled } = milestoneChanges(items, byTitle);

  for (const m of moves) {
    const line = `#${m.iid} ${m.from ?? '(none)'} -> ${m.to}`;
    if (dryRun) {
      console.log(`would move ${line}`);
      continue;
    }
    await b.setMilestone(m.iid, byTitle.get(m.to));
    console.log(line);
  }
  for (const c of conflicts)
    console.error(`#${c.iid} carries ${c.labels.join(' and ')} — left alone, pick one`);
  for (const u of unlabelled) {
    console.error(`#${u.iid} is in ${u.milestone} with no release label — left alone`);
  }
  const counts = releases.map((r) => `${r} ${items.filter((i) => releaseOf(i.labels).release === r).length}`);
  console.log(`${dryRun ? 'would move' : 'moved'} ${moves.length}; labelled: ${counts.join(', ') || 'none'}`);
  return conflicts.length ? 1 : 0;
}

/**
 * Read-only: the open release milestones, or what one of them holds.
 *
 * Bare, it prints one line per release. Named, it lists the milestone's items, open ones first, each with
 * its board state for an open item. A confidential item is listed by iid only, as `list` withholds it.
 */
async function cmdReleases(b, name) {
  const items = await b.listAll();
  if (!name) {
    const rows = releaseSummary(await b.milestones('open'), items);
    if (!rows.length) {
      console.log('no open release milestones');
      return 0;
    }
    for (const r of rows) console.log(formatRelease(r));
    console.log('\n`pnpm items releases <milestone>` lists what is in one.');
    return 0;
  }
  const inIt = items
    .filter((i) => i.milestone?.title === name)
    .sort((x, y) => (x.state === y.state ? x.iid - y.iid : x.state === 'open' ? -1 : 1));
  if (!inIt.length) {
    console.error(`nothing is in milestone ${name}`);
    return 1;
  }
  for (const i of inIt) {
    const title = shownTitle(i).slice(0, 80);
    const ai = aiLabelsOn(i.labels)[0]?.replace(/^ai:/, '');
    console.log(`#${i.iid} ${i.state === 'open' ? (ai ?? 'open') : 'closed'} — ${title}`);
  }
  const open = inIt.filter((i) => i.state === 'open').length;
  console.log(`\n${name}: ${open} open, ${inIt.length - open} closed`);
  return 0;
}

/** The same rule for one item, for `close`: the last write an item gets should leave it consistent. */
async function syncMilestone(b, item) {
  const { release } = releaseOf(item.labels);
  if (!release || item.milestone?.title === release) return;
  const byTitle = await ensureMilestones(b, [release]);
  await b.setMilestone(item.iid, byTitle.get(release));
  console.log(`milestone ${release}`);
}

// ---------------------------------------------------------------------------------------------------------

/**
 * Bare filenames resolved against the tracked tree, by basename, and only when UNAMBIGUOUS.
 *
 * A basename that occurs in two directories (two `index.ts`, a `config.ts` per package) cannot be resolved
 * by guessing: doing so invents a collision between two files that have nothing to do with each other. An
 * ambiguous name is dropped rather than resolved.
 */
function fileResolver() {
  let tracked = [];
  try {
    tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    /* not a git checkout: full paths still resolve below */
  }
  const byBase = new Map();
  for (const p of tracked) {
    const base = p.slice(p.lastIndexOf('/') + 1);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(p);
  }
  const known = new Set(tracked);
  return (name) => {
    if (known.has(name)) return name;
    if (name.includes('/')) return null; // a path that is not tracked is prose, not code
    const hits = byBase.get(name);
    return hits && hits.length === 1 ? hits[0] : null; // ambiguous basename: drop it
  };
}

/**
 * Which code two open items both touch — the question somebody about to start a second branch has, and the
 * one that decides whether two items may be taken in parallel. Two branches editing one hunk conflict; two
 * branches editing one FILE merely need care, so the two are reported separately.
 */
async function cmdCollisions(b, flags) {
  const items = await b.listOpen();
  const resolve = fileResolver();
  const byFile = new Map();
  const secret = new Set();
  for (const item of items.sort((x, y) => x.iid - y.iid)) {
    if (!item.commentCount) continue;
    const plans = (await b.comments(item.iid)).filter((n) => n.body.trimStart().startsWith(PLAN_MARKER));
    if (!plans.length) continue;
    if (isConfidential(item)) secret.add(item.iid);
    // The LAST plan is the one in force — a revision supersedes the plan it replaces.
    for (const c of citations(plans[plans.length - 1].body, resolve)) {
      if (!byFile.has(c.file)) byFile.set(c.file, []);
      byFile.get(c.file).push({ iid: item.iid, ...c });
    }
  }

  const rows = [];
  for (const [file, cites] of byFile) {
    const iids = [...new Set(cites.map((c) => c.iid))].sort((x, y) => x - y);
    if (iids.length < 2) continue;
    // One line per PAIR of items, not per pair of citations. Two plans that each cite a hunk three times
    // produced nine near-identical rows, which buries the signal it exists to surface.
    const pairs = new Map();
    for (let i = 0; i < cites.length; i++) {
      for (let j = i + 1; j < cites.length; j++) {
        const [a, c] = [cites[i], cites[j]].sort((x, y) => x.iid - y.iid);
        if (a.iid === c.iid) continue;
        const rel = relation(a, c);
        if (!rel) continue;
        const key = `${a.iid}|${c.iid}`;
        // Keep the TIGHTEST piece of evidence, never the union. Merging spans across every citation pair
        // ballooned `#9 x #10` into "37-373" and labelled it SAME LINES, which was simply false: those are
        // two distant citations, not one shared hunk. Strongest relation first, then narrowest span.
        const lo = Math.min(a.from, c.from),
          hi = Math.max(a.to, c.to);
        const cand = { a: a.iid, b: c.iid, lo, hi, rel, width: hi - lo };
        const prev = pairs.get(key);
        const better =
          !prev || (prev.rel !== 'same' && rel === 'same') || (prev.rel === rel && cand.width < prev.width);
        if (better) pairs.set(key, cand);
      }
    }
    rows.push({ file, iids, hunks: [...pairs.values()] });
  }
  rows.sort((x, y) => y.hunks.length - x.hunks.length || y.iids.length - x.iids.length);
  // A confidential item's plan says where its hole is: its overlaps stay, its files and lines go (#31).
  const { rows: kept, withheld } = redactCollisions(rows, flags.has('--confidential') ? new Set() : secret);

  if (flags.has('--json')) {
    // Still one array: a withheld overlap is an entry with no file.
    const entries = [...kept, ...withheld.map((w) => ({ withheld: true, iids: [w.a, w.b], rel: w.rel }))];
    console.log(JSON.stringify(entries, null, 1));
    return 0;
  }
  if (!kept.length && !withheld.length) {
    console.log('no file is cited by two open items — nothing contested.');
    return 0;
  }

  const REL = { same: 'SAME LINES', near: 'SAME AREA ', file: 'same file ' };
  console.log('Code two or more OPEN items both cite, derived from the plan in force on each.\n');
  if (withheld.length) {
    console.log(
      'Overlaps with a confidential item, its files and lines withheld (--confidential shows them):',
    );
    const tag = (i) => `#${i}${secret.has(i) ? ' (confidential)' : ''}`;
    for (const w of withheld) console.log(`  ${REL[w.rel]}  ${tag(w.a)} x ${tag(w.b)}`);
    console.log('');
  }
  for (const r of kept) {
    console.log(r.file);
    console.log(`  cited by ${r.iids.map((i) => `#${i}`).join(', ')}`);
    for (const h of r.hunks.sort((x, y) => (x.rel === y.rel ? 0 : x.rel === 'same' ? -1 : 1))) {
      console.log(
        `  ${REL[h.rel]}  #${h.a} x #${h.b}  ${h.lo}${h.hi !== h.lo ? `-${h.hi}` : ''}` +
          (h.rel === 'same' ? '  — do not branch both' : '  — same function, sequence them'),
      );
    }
    if (!r.hunks.length)
      console.log('  same file, lines far apart — parallel possible, expect mechanical conflicts');
    console.log('');
  }
  console.log(
    'This reports CITATION overlap, which is a proxy for edit overlap and not the same thing: a plan\n' +
      'may cite a line it only reasons about (the version stamp shows up this way). An item with no plan yet\n' +
      "cannot appear here at all, and a revised plan replaces its predecessor's citations.",
  );
  return 0;
}

const USAGE = `usage:
  node scripts/work-items.mjs list [--new|--answered|--ready|--blocked|--parked|--stale] [--brief|--json]
  node scripts/work-items.mjs show <iid> [--confidential]   # confidential items are withheld by default
  node scripts/work-items.mjs collisions [--json] [--confidential]
  node scripts/work-items.mjs comment <iid> <file>
  node scripts/work-items.mjs screenshots <iid> <dir> [intro-file]
  node scripts/work-items.mjs label <iid> <analysing|plan-posted|answered|ready|blocked|parked|implementing|none>
  node scripts/work-items.mjs label <iid> release-<x.y.z>   # put an item in a release; the milestone follows
  node scripts/work-items.mjs create <file> [relates-to-iid] [labels]   # first line of <file> is the title
  node scripts/work-items.mjs create --batch <file> [--apply]   # many items from one file; dry run by default
  node scripts/work-items.mjs unlink <iid> <other-iid>   # remove a link, and with it the sibling hold
  node scripts/work-items.mjs close <iid>   # close it, and drop the ai: label with it
  node scripts/work-items.mjs milestones [--dry-run]   # milestone follows the release-* label, on every item
  node scripts/work-items.mjs releases [<milestone>]   # read-only: open release milestones, or one's contents
  node scripts/work-items.mjs mr|pr <branch> <file> [title] [--target=<branch>]   # open a merge/pull request
  node scripts/work-items.mjs mr-status <branch> [--json]   # read-only: the newest request from <branch>
  node scripts/work-items.mjs release prepare <release-x.y.z> --from=<branch> [--at=<sha>] [--include=<iid,…>] [--exclude=<iid,…>] [--name=<title>] [--notes] [--apply]
  node scripts/work-items.mjs release finalize <release-x.y.z> [--no-whats-new]   # after a person merged the release merge request
  node scripts/work-items.mjs release deck <release-x.y.z> [--out=<file.html>]   # preview the "what's new" slides`;

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const args = argv.filter((a) => !a.startsWith('--'));
  const cmd = args[0];

  const usage = () => {
    console.error(USAGE);
    return 1;
  };
  // Pure and offline: no credential, no network, and no board opened — a checkout with both provider
  // files must still be able to run it.
  if (cmd === 'selftest') return (await import('./board/selftest.mjs')).selftest();
  const b = await openBoard();
  switch (cmd) {
    case 'list':
      return cmdList(b, flags);
    case 'collisions':
      return cmdCollisions(b, flags);
    case 'show':
      return args[1] ? cmdShow(b, args[1], { allowConfidential: flags.has('--confidential') }) : usage();
    case 'comment':
      return args[1] && args[2] ? cmdComment(b, args[1], args[2]) : usage();
    case 'screenshots':
      return args[1] && args[2] ? cmdScreenshots(b, args[1], args[2], args[3]) : usage();
    case 'label':
      return args[1] && args[2] ? cmdLabel(b, args[1], args[2]) : usage();
    case 'create':
      if (flags.has('--batch'))
        return args[1] ? cmdBatch(b, args[1], { apply: flags.has('--apply') }) : usage();
      return args[1] ? cmdCreate(b, args[1], args[2], args[3]) : usage();
    case 'unlink':
      return args[1] && args[2] ? cmdUnlink(b, args[1], args[2]) : usage();
    case 'close':
      return args[1] ? cmdClose(b, args[1]) : usage();
    case 'milestones':
      return cmdMilestones(b, flags);
    case 'releases':
      return cmdReleases(b, args[1]);
    case 'release': {
      const value = (name) => [...flags].find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3);
      if (!args[2]) return usage();
      const opts = {
        from: value('from'),
        at: value('at'),
        include: value('include'),
        exclude: value('exclude'),
        name: value('name'),
        notes: flags.has('--notes'),
        apply: flags.has('--apply'),
        noWhatsNew: flags.has('--no-whats-new'),
        out: value('out'),
      };
      // The project's release hooks (scripts/board/release.mjs, "RELEASE HOOKS"), named in this checkout's
      // package.json. A named module that cannot be loaded is refused here, before anything is done.
      let hooks = null;
      try {
        hooks = await checkoutHooks(ROOT, args[1]);
      } catch (e) {
        console.error(`✖ release hooks: ${e.message}`);
        return 1;
      }
      const { provider } = detectProvider();
      const ctx = {
        b,
        ROOT,
        isConfidential,
        relabel: (iid, label) => cmdLabel(b, iid, label),
        close: (iid) => cmdClose(b, iid),
        hooks,
        flags: hookFlags(hooks?.flags, argv),
        env: envReader(provider === 'github' ? '.env.github' : '.env.gitlab'),
      };
      return (await cmdRelease(ctx, args[1], args[2], opts)) ?? usage();
    }
    case 'mr':
    case 'pr': {
      const target = [...flags].find((f) => f.startsWith('--target='))?.slice('--target='.length);
      if (target === '') return usage();
      return args[1] && args[2] ? cmdMr(b, args[1], args[2], args[3], target) : usage();
    }
    case 'mr-status':
      return args[1] ? cmdMrStatus(b, args[1], flags) : usage();
    default:
      return usage();
  }
}

try {
  process.exit(await main());
} catch (e) {
  if (e instanceof BoardError) {
    // `--brief` is the hook's channel: stay silent so a session opened on a train starts clean.
    // BOTH unattended channels stay silent. In the project this came from, only `--brief` was tested and the
    // SessionStart hook had since moved to `--hook` — so a fresh clone, which has no `.env` because it is
    // gitignored, greeted its developer with `work-items: network — GitLab is not configured` on every
    // session start. Found by actually cloning the repository rather than by reasoning about it: on a machine
    // that HAS the .env file, even `env -i` cannot reproduce it, because the file is read from the repo root
    // and not from the environment.
    const quiet = process.argv.includes('--brief') || process.argv.includes('--hook');
    if (!quiet) console.error(`work-items: ${e.code} — ${e.message}`);
    process.exit(e.transient || e.code === 'unauthenticated' || e.code === 'forbidden' ? 3 : 1);
  }
  console.error(`work-items: ${String(e?.message || e)}`);
  process.exit(1);
}

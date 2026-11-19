// `pnpm check:items`: the board's rules, asserted offline. No credential, no network — the adapters are
// driven through a fake fetch, so the GitLab and GitHub paths are pinned on every push.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeFeatures } from '../../.claude/skills/advance-work-items/batch/sanitize-features.mjs';
import { parseEnv, selectProvider } from './config.mjs';
import {
  addRelatesTo,
  aiLabelsOn,
  blockingSiblings,
  citations,
  classify,
  commentKind,
  fieldFrom,
  isConfidential,
  LABEL_COLOURS,
  labelsAfterClose,
  migratedFrom,
  migratedLine,
  milestoneChanges,
  mrStatus,
  PLAN_MARKER,
  pickShots,
  redactCollisions,
  relatesTo,
  relation,
  releaseSummary,
  shownTitle,
  stripRelatesTo,
  WITHHELD_WHY,
} from './core.mjs';
import {
  appJwt,
  assetMarkdown,
  assetPath,
  createGithub,
  createInstallationClient,
  githubComment,
  githubErrorCode,
  githubErrorDetail,
  githubItem,
  githubMilestone,
  githubMr,
  githubMrRefs,
  labelDescription,
  nextLink,
  onlyIssues,
} from './github.mjs';
import {
  createGitlab,
  gitlabComment,
  gitlabItem,
  gitlabMilestone,
  gitlabMr,
  gitlabMrRefs,
  linkIdFor,
} from './gitlab.mjs';
import {
  branchItem,
  bumpVersion,
  checkoutHooks,
  cmdRelease,
  configKeys,
  deliveredRefs,
  hookFlags,
  hookVerdict,
  hostileTitles,
  loadReleaseHooks,
  mdText,
  parseLog,
  publishable,
  readMeta,
  releaseDescription,
  releaseSettings,
  renderNotes,
  renderWhatsNewDraft,
  selectItems,
  versionOf,
} from './release.mjs';
import { siblings } from './siblings.mjs';
import { FILL_IN, inline, parseDeck, renderDeck, withoutAdmin } from './whats-new.mjs';

/** A fetch that answers from a table of routes and records every request it was asked for. */
export function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url: String(url), body: init.body, headers: init.headers ?? {} });
    for (const [match, answer] of routes) {
      if (!match(method, String(url))) continue;
      const out = typeof answer === 'function' ? answer(String(url), init) : answer;
      const { status = 200, json = null, headers = {} } = out;
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: { get: (k) => headers[k.toLowerCase()] ?? null },
        json: async () => json,
        text: async () => JSON.stringify(json),
      };
    }
    return {
      ok: false,
      status: 404,
      headers: { get: () => null },
      json: async () => ({}),
      text: async () => '',
    };
  };
  return { impl, calls };
}

/**
 * The state machine, asserted offline.
 *
 * This exists because the case that matters most cannot be tested against the live board: the token can
 * only post AS the bot, so "a human replied" is unreachable from here, and the one bug this design has to
 * avoid is precisely our own follow-up being mistaken for that reply. Synthetic notes reach it.
 */
export async function selftest() {
  const ME = 7,
    HUMAN = 99;
  const note = (authorId, body, at = '2026-09-09T10:00:00Z') => ({
    id: 1,
    authorId,
    author: authorId === ME ? 'bot' : 'reporter',
    body,
    createdAt: at,
  });
  const plan = note(ME, '## Remediation plan — something\n\n1. **[REVIEW 1]** a');
  const coverage = note(ME, '## Review coverage — round 1\n\n[REVIEW 2] still open');
  const reply = note(HUMAN, '1. use the list rate\n2. yes bundle it');
  const item = (labels, updated = new Date().toISOString()) => ({ labels, updatedAt: updated });
  const old = new Date(Date.now() - 5 * 3600e3).toISOString();

  const cases = [
    ['a fresh item is new', item(['feedback']), [], 'new'],
    ['a plan with no reply awaits the reporter', item(['feedback', 'ai:plan-posted']), [plan], 'plan-posted'],
    ['a label with no comment still counts', item(['feedback', 'ai:implementing']), [], 'implementing'],
    ['a plan whose label was deleted is not new', item(['feedback']), [plan], 'plan-posted'],
    [
      'a human reply after a plan is answered',
      item(['feedback', 'ai:plan-posted']),
      [plan, reply],
      'answered',
    ],
    // The bug this guards: our own coverage round is the newest comment, so the ball is with the reporter.
    [
      'our coverage round is not a reply',
      item(['feedback', 'ai:plan-posted']),
      [plan, reply, coverage],
      'plan-posted',
    ],
    [
      'a reply to a coverage round is answered again',
      item(['feedback', 'ai:plan-posted']),
      [plan, reply, coverage, reply],
      'answered',
    ],
    // `ready` is reachable only because the CLOSING coverage comment is mandatory. Stamping the label is
    // not enough: at that moment the reporter's answer is the newest comment, so without our comment after
    // it the item reads as an unassessed reply and `ready` would be permanently invisible. Posting the
    // round that says "all points covered" is what makes the state exist — and it is what the reporter
    // needs to see anyway.
    [
      'ready needs our closing round after the answer',
      item(['feedback', 'ai:ready']),
      [plan, reply, coverage],
      'ready',
    ],
    [
      'a ready label with an unanswered reply re-assesses',
      item(['feedback', 'ai:ready']),
      [plan, reply],
      'answered',
    ],
    [
      'a reply after ready reopens assessment',
      item(['feedback', 'ai:ready']),
      [plan, coverage, reply],
      'answered',
    ],
    ['blocked outranks a fresh reply', item(['feedback', 'ai:blocked']), [plan, coverage, reply], 'blocked'],
    // Parked is a human's decision that this is not to be worked on yet, so it must be STICKY: neither a
    // plan already on the item nor a later comment may quietly requeue it. Taking the label off is the
    // only way back, which is what makes it safe to park something and forget it.
    ['parked with nothing on it stays parked', item(['feedback', 'ai:parked']), [], 'parked'],
    ['parked outranks a fresh reply', item(['feedback', 'ai:parked']), [plan, reply], 'parked'],
    ['unparking restores the real state', item(['feedback']), [plan, reply], 'answered'],
    ['analysing goes stale', item(['feedback', 'ai:analysing'], old), [], 'stale'],
    ['analysing is not stale while fresh', item(['feedback', 'ai:analysing']), [], 'analysing'],
  ];

  let failed = 0;
  /** Deep equality by JSON, exact: a partial match is not a pass (AGENTS.md ground rule 6). */
  const check = (name, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) console.log(`✓ ${name}`);
    else {
      failed++;
      console.error(`✗ ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  };
  for (const [name, it, notes, want] of cases) {
    const got = classify(it, notes, ME).state;
    if (got === want) console.log(`✓ ${name}`);
    else {
      failed++;
      console.error(`✗ ${name}: got "${got}", want "${want}"`);
    }
  }
  // Round counting is what bounds the loop at two, so it is asserted rather than assumed.
  const rounds = classify(item(['feedback']), [plan, reply, coverage, reply, coverage], ME).rounds;
  if (rounds === 2) console.log('✓ rounds counts our coverage comments');
  else {
    failed++;
    console.error(`✗ rounds: got ${rounds}, want 2`);
  }
  // With no identity (a failed /user lookup) the markers must still carry it.
  const degraded = classify(item(['feedback', 'ai:plan-posted']), [plan, reply, coverage], null).state;
  if (degraded === 'plan-posted') console.log('✓ marker fallback holds when the identity lookup fails');
  else {
    failed++;
    console.error(`✗ marker fallback: got "${degraded}", want "plan-posted"`);
  }

  // ---- migrated comments ---------------------------------------------------------------------------------
  // A migration posts every comment as the App, so the marker on its last line is what tells the reporter's
  // copied reply from the bot's copied plan. Trusted only on the App's own comments (or with no identity).
  const mark = (kind, author = 'reporter') =>
    migratedLine({
      from: 'gitlab',
      note: 101,
      url: 'https://git.example/g/p/-/work_items/5#note_101',
      author,
      at: '2026-10-05T08:00:00Z',
      kind,
    });
  const mPlan = note(ME, `## Remediation plan — x\n\n1. **[REVIEW 1]** a\n\n${mark('ours', 'hub-bot')}`);
  const mReply = note(ME, `_Originally by @\u200breporter on GitLab_\n\nyes\n\n${mark('reply')}`);
  const mOurs = note(ME, `a follow-up from the bot\n\n${mark('ours', 'hub-bot')}`);
  const pasted = note(HUMAN, `I agree\n\n${mark('ours', 'hub-bot')}`);
  check(
    'the marker line round-trips, and a value with a space or "--" cannot end the comment early',
    [
      migratedFrom(mark('reply')),
      migratedFrom(migratedLine({ from: 'gitlab', note: 1, author: 'a b', url: 'x--y>', kind: 'ours' })),
      migratedFrom('text\n<!-- board:migrated from=gitlab kind=maybe -->'),
      migratedFrom(`${mark('reply')}\nand then more text`),
    ],
    [
      {
        from: 'gitlab',
        note: '101',
        url: 'https://git.example/g/p/-/work_items/5#note_101',
        author: 'reporter',
        at: '2026-10-05T08:00:00Z',
        kind: 'reply',
      },
      { from: 'gitlab', note: '1', url: 'x--y>', author: 'a b', kind: 'ours' },
      null,
      null,
    ],
  );
  check(
    'migrated: a reply after a plan is answered, naming the GitLab author and date',
    [classify(item(['feedback']), [mPlan, mReply], ME)],
    [{ rounds: 0, state: 'answered', why: 'reporter replied on 2026-10-05, coverage not assessed' }],
  );
  check(
    'migrated: a bot note after a plan is plan-posted, and a migrated plan is still a plan',
    [
      classify(item(['feedback']), [mPlan, mReply, mOurs], ME).state,
      classify(item(['feedback']), [mPlan], ME).state,
      commentKind(mPlan, ME),
    ],
    ['plan-posted', 'plan-posted', 'plan'],
  );
  check(
    "migrated: the marker in somebody else's comment is ignored, and with no identity it is honoured",
    [
      classify(item(['feedback']), [mPlan, pasted], ME).state,
      commentKind(pasted, ME),
      classify(item(['feedback']), [mPlan, mReply], null).state,
      classify(item(['feedback']), [mPlan, mReply, mOurs], null).state,
      commentKind(mReply, null),
    ],
    ['answered', 'reply', 'answered', 'plan-posted', 'reply'],
  );
  check(
    'show and classify share one rule for comments without a marker',
    [plan, coverage, reply, note(ME, 'plain')].map((n) => commentKind(n, ME)),
    ['plan', 'coverage', 'reply', 'ours'],
  );

  // ---- the screenshot attachment order ------------------------------------------------------------------
  // A reviewer reads the attachments top to bottom, so the sequence has to be the same every run rather
  // than whatever `readdirSync` returns on the machine that happened to build it.
  const shots = pickShots(['home.png', '.DS_Store', 'notes.txt', 'browse.png', 'home-dark.png']);
  const wantShots = ['browse.png', 'home-dark.png', 'home.png'];
  if (shots.join(',') === wantShots.join(',')) console.log('✓ screenshots are picked and ordered stably');
  else {
    failed++;
    console.error(`✗ pickShots: got [${shots}], want [${wantShots}]`);
  }

  // ---- citation extraction and the collision relation ---------------------------------------------------
  const R = (name) => (name === 'help.ts' ? null : name); // stand-in for the ambiguous-basename drop
  const cit = (body) => citations(body, (f) => R(f) && f);
  const cases2 = [
    [
      'a full path with a line',
      'see src/core/engine.ts:373 for it',
      [{ file: 'src/core/engine.ts', from: 373, to: 373 }],
    ],
    ['a bare filename counts', 'engine.ts:829 is the line', [{ file: 'engine.ts', from: 829, to: 829 }]],
    ['a range', 'main.ts:890-930 draws it', [{ file: 'main.ts', from: 890, to: 930 }]],
    ['no line number', 'see defaults.ts for the keys', [{ file: 'defaults.ts', from: null, to: null }]],
    [
      'an ambiguous basename is dropped',
      'src/ui/help.ts and help.ts:12',
      [{ file: 'src/ui/help.ts', from: null, to: null }],
    ],
  ];
  for (const [name, body, want] of cases2) {
    const got = cit(body);
    if (JSON.stringify(got) === JSON.stringify(want)) console.log(`✓ ${name}`);
    else {
      failed++;
      console.error(`✗ ${name}: got ${JSON.stringify(got)}`);
    }
  }

  // ---- which siblings block an implementation ------------------------------------------------------------
  const sib = (iid, state, closed = false) => ({ iid, state, closed });
  const blockCases = [
    ['a sibling awaiting its reporter blocks', [sib(18, 'plan-posted')], [18]],
    ['a sibling with an unassessed reply blocks', [sib(18, 'answered')], [18]],
    ['a blocked sibling blocks', [sib(18, 'blocked')], [18]],
    ['a ready sibling does not', [sib(18, 'ready')], []],
    ['a sibling already being implemented does not', [sib(18, 'implementing')], []],
    // Parked is somebody's decision that the item is not to be worked on; it must not hold its sibling
    // hostage for ever. Closed likewise — the work is done.
    ['a parked sibling does not block', [sib(23, 'parked')], []],
    ['a closed sibling does not block', [sib(20, 'plan-posted', true)], []],
    ['no links at all', null, []],
    [
      'several siblings report every blocker',
      [sib(18, 'ready'), sib(19, 'plan-posted'), sib(7, 'answered')],
      [18 - 18 + 19, 7],
    ],
  ];
  for (const [name, sibs, want] of blockCases) {
    const got = blockingSiblings(sibs).map((x) => x.iid);
    if (JSON.stringify(got) === JSON.stringify(want)) console.log(`✓ ${name}`);
    else {
      failed++;
      console.error(`✗ ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  }

  // ---- which link an unlink removes ----------------------------------------------------------------------
  const linkCases = [
    [
      'finds the link to the named item',
      [
        { iid: 184, issue_link_id: 7 },
        { iid: 222, issue_link_id: 9 },
      ],
      '222',
      9,
    ],
    ['an item that is not linked has no link', [{ iid: 184, issue_link_id: 7 }], '222', null],
    ['an item with no links has no link', [], '184', null],
  ];
  for (const [name, links, other, want] of linkCases) {
    const got = linkIdFor(links, other);
    if (got === want) console.log(`✓ ${name}`);
    else {
      failed++;
      console.error(`✗ ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  }

  // ---- what a close leaves behind ------------------------------------------------------------------------
  const closeCases = [
    ['the ai: label goes', ['ai:implementing'], []],
    ['a human label stays', ['feedback', 'ai:plan-posted'], ['feedback']],
    // Exact membership, not "is shorter than it was": a filter that dropped the wrong label passes any
    // assertion about the count.
    ['everything that is not ours survives, sorted', ['ux', 'ai:ready', 'feedback'], ['feedback', 'ux']],
    ['nothing to drop is not an error', ['feedback'], ['feedback']],
    ['no labels at all', [], []],
    ['a missing label list reads as none', undefined, []],
    // `ai:parked` is somebody's decision that the item is not to be worked on. Closing it ends that
    // decision along with the item, so it goes like the rest; reopening starts from no claim at all.
    ['parked is not special', ['ai:parked'], []],
  ];
  for (const [name, labels, want] of closeCases) {
    const got = labelsAfterClose(labels);
    if (JSON.stringify(got) === JSON.stringify(want)) console.log(`✓ ${name}`);
    else {
      failed++;
      console.error(`✗ ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  }

  // ---- and whether an ALREADY-CLOSED item still needs a write ----------------------------------------------
  //
  // The path this pins used to return early and do nothing, so an item GitLab had closed from a merge
  // request kept its `ai:` label for ever — four of them in one session. The predicate is what decides
  // between "nothing to do" and "still owes a label drop".
  const staleCases = [
    ['an implementing label is still owed a drop', ['ai:implementing'], ['ai:implementing']],
    ['a human label alone owes nothing', ['feedback'], []],
    ['both: only ours is owed', ['feedback', 'ai:ready'], ['ai:ready']],
    ['no labels owes nothing', [], []],
    ['a missing label list owes nothing', undefined, []],
    ['two of ours, sorted', ['ai:ready', 'ai:analysing'], ['ai:analysing', 'ai:ready']],
  ];
  for (const [name, labels, want] of staleCases) {
    const got = aiLabelsOn(labels);
    if (JSON.stringify(got) === JSON.stringify(want)) console.log(`✓ ${name}`);
    else {
      failed++;
      console.error(`✗ ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  }

  // ---- and which milestone a release label puts an item in ---------------------------------------------
  //
  // Exact membership of every list, not a count: a rule that moved the wrong item passes "moved one".
  const ms = new Map([['release-0.2.0', 1]]);
  const it = (iid, labels, milestone) => ({
    iid,
    labels,
    milestone: milestone ? { title: milestone } : null,
  });
  const milestoneCases = [
    [
      'a labelled item joins its milestone',
      [it(1, ['release-0.2.0'])],
      { moves: [{ iid: 1, from: null, to: 'release-0.2.0' }], conflicts: [], unlabelled: [], missing: [] },
    ],
    [
      'one already there is not written',
      [it(2, ['release-0.2.0', 'feedback'], 'release-0.2.0')],
      { moves: [], conflicts: [], unlabelled: [], missing: [] },
    ],
    [
      'a wrong milestone is moved',
      [it(3, ['release-0.2.0'], 'release-0.3.0')],
      {
        moves: [{ iid: 3, from: 'release-0.3.0', to: 'release-0.2.0' }],
        conflicts: [],
        unlabelled: [],
        missing: [],
      },
    ],
    [
      'a release with no milestone yet is named',
      [it(4, ['release-0.3.0'])],
      {
        moves: [{ iid: 4, from: null, to: 'release-0.3.0' }],
        conflicts: [],
        unlabelled: [],
        missing: ['release-0.3.0'],
      },
    ],
    [
      'two release labels are reported, not guessed',
      [it(5, ['release-0.3.0', 'release-0.2.0'])],
      {
        moves: [],
        conflicts: [{ iid: 5, labels: ['release-0.2.0', 'release-0.3.0'] }],
        unlabelled: [],
        missing: [],
      },
    ],
    [
      'a release milestone with no label is reported, not cleared',
      [it(6, ['feedback'], 'release-0.2.0')],
      { moves: [], conflicts: [], unlabelled: [{ iid: 6, milestone: 'release-0.2.0' }], missing: [] },
    ],
    [
      'an unrelated milestone is none of our business',
      [it(7, [], 'Q4 planning')],
      { moves: [], conflicts: [], unlabelled: [], missing: [] },
    ],
    [
      'a missing label list reads as none',
      [{ iid: 8, milestone: null }],
      { moves: [], conflicts: [], unlabelled: [], missing: [] },
    ],
  ];
  for (const [name, items, want] of milestoneCases) {
    const got = milestoneChanges(items, ms);
    if (JSON.stringify(got) === JSON.stringify(want)) console.log(`✓ ${name}`);
    else {
      failed++;
      console.error(`✗ ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  }

  // ---- and what the release summary counts --------------------------------------------------------------
  const mst = (title, state = 'open', due = null) => ({ title, state, due });
  const issue = (state, milestone) => ({ state, milestone: milestone ? { title: milestone } : null });
  const summaryCases = [
    [
      'open and closed are counted apart, and releases sort by version',
      [mst('release-0.10.0'), mst('release-0.2.0', 'open', '2026-09-27')],
      [
        issue('open', 'release-0.2.0'),
        issue('closed', 'release-0.2.0'),
        issue('closed', 'release-0.2.0'),
        issue('open', 'release-0.10.0'),
        issue('open', null),
      ],
      [
        { title: 'release-0.2.0', due: '2026-09-27', open: 1, closed: 2 },
        { title: 'release-0.10.0', due: null, open: 1, closed: 0 },
      ],
    ],
    [
      'a milestone not named like a release is left out',
      [mst('Q4 planning')],
      [issue('open', 'Q4 planning')],
      [],
    ],
    ['a closed release milestone is left out', [mst('release-0.1.0', 'closed')], [], []],
    [
      'an empty release still shows',
      [mst('release-0.3.0')],
      [],
      [{ title: 'release-0.3.0', due: null, open: 0, closed: 0 }],
    ],
  ];
  for (const [name, milestones, items, want] of summaryCases) {
    const got = releaseSummary(milestones, items);
    if (JSON.stringify(got) === JSON.stringify(want)) console.log(`✓ ${name}`);
    else {
      failed++;
      console.error(`✗ ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  }

  // ---- and whether a confidential item can reach a listing ---------------------------------------------
  //
  // SECURITY.md tells a reporter to open a confidential item, so this predicate is the difference between
  // a disclosure route and a disclosure. It fails closed on purpose: an item whose flag we cannot read is
  // treated as confidential, because an over-filtered board is a visible problem and a leaked title is not.
  const confidentialCases = [
    ['an ordinary item is listed', { confidential: false }, false],
    ['a confidential item is not', { confidential: true }, true],
    ['a missing flag is treated as confidential', {}, true],
    ['so is a malformed item', undefined, true],
  ];
  check(
    'shownTitle: confidential, public, a missing flag, and allowed',
    [
      shownTitle({ title: 's', confidential: true }),
      shownTitle({ title: 'p', confidential: false }),
      shownTitle({ title: 's' }),
      shownTitle({ title: 's', confidential: true }, { allow: true }),
    ],
    ['(confidential)', 'p', '(confidential)', 's'],
  );
  // collisions: a confidential item's overlaps stay, its files and lines go (#31).
  {
    const rows = [
      {
        file: 'a.mjs',
        iids: [1, 2, 3],
        hunks: [
          { a: 1, b: 2, lo: 5, hi: 9, rel: 'same', width: 4 },
          { a: 2, b: 3, lo: 40, hi: 44, rel: 'near', width: 4 },
        ],
      },
      { file: 'b.mjs', iids: [2, 4], hunks: [] },
      { file: 'c.mjs', iids: [1, 4], hunks: [{ a: 1, b: 4, lo: 1, hi: 2, rel: 'near', width: 1 }] },
    ];
    check(
      'redactCollisions: confidential #2 leaves the rows, its overlaps stay at their strongest',
      redactCollisions(rows, new Set([2])),
      {
        rows: [
          { file: 'a.mjs', iids: [1, 3], hunks: [] },
          { file: 'c.mjs', iids: [1, 4], hunks: [{ a: 1, b: 4, lo: 1, hi: 2, rel: 'near', width: 1 }] },
        ],
        withheld: [
          { a: 1, b: 2, rel: 'same' },
          { a: 2, b: 3, rel: 'near' },
          { a: 2, b: 4, rel: 'file' },
        ],
      },
    );
    check('redactCollisions: nothing confidential changes nothing', redactCollisions(rows, new Set()), {
      rows,
      withheld: [],
    });
  }
  for (const [name, item, want] of confidentialCases) {
    const got = isConfidential(item);
    if (got === want) console.log(`✓ ${name}`);
    else {
      failed++;
      console.error(`✗ ${name}: got ${got}, want ${want}`);
    }
  }

  const rel = (a, b) => relation({ from: a[0], to: a[1] }, { from: b[0], to: b[1] });
  const relCases = [
    ['overlapping ranges are the same lines', [890, 930], [900, 903], 'same'],
    ['identical single lines are the same', [373, 373], [373, 373], 'same'],
    ['adjacent-but-not-touching is near', [826, 829], [860, 870], 'near'],
    ['far apart is neither', [37, 37], [900, 900], null],
    // A whole-file citation (an audit cited defaults.ts:2-116) would otherwise collide with everything in it.
    ['a whole-file range claims no hunk', [2, 116], [50, 51], null],
    ['a citation with no line relates to nothing', [null, null], [373, 373], null],
  ];
  for (const [name, a, b, want] of relCases) {
    const got = rel(a, b);
    if (got === want) console.log(`✓ ${name}`);
    else {
      failed++;
      console.error(`✗ ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  }

  // The batch PDF's confidentiality rule, asserted offline on its pure half. A merge request is readable by
  // more people than a confidential item is, so the PDF attached to it carries `#N (confidential)` and nothing
  // else, and an item whose flag could not be read counts as confidential.
  const flagsOf = new Map([
    [1, false],
    [2, true],
  ]);
  const sanitizeCases = [
    [
      'a confidential or unreadable item renders as its number only',
      sanitizeFeatures(
        [
          { iid: 1, title: 'public', summary: 's', points: ['p'], url: 'u', screenshots: ['a.png'] },
          { iid: 2, title: 'secret', confidential: true },
          { iid: 3, title: 'unreadable flag' },
        ],
        (iid) => flagsOf.get(iid),
      ),
      {
        features: [
          { iid: 1, title: 'public', summary: 's', points: ['p'], url: 'u', screenshots: ['a.png'] },
          { iid: 2, title: '(confidential)', confidential: true },
          { iid: 3, title: '(confidential)', confidential: true },
        ],
        errors: [],
      },
    ],
    [
      'a confidential feature that carries details is refused, field by field',
      sanitizeFeatures(
        [
          { iid: 2, title: 'secret', summary: 'leak', points: ['p'], migration: '0050' },
          { iid: 1, title: 'public', confidential: true, screenshots: ['a.png'], novisual: '' },
        ],
        (iid) => flagsOf.get(iid),
      ).errors,
      [
        '#2 is confidential but carries summary, points, migration',
        '#1 is confidential but carries screenshots',
      ],
    ],
  ];
  for (const [name, got, want] of sanitizeCases) {
    if (JSON.stringify(got) === JSON.stringify(want)) console.log(`✓ ${name}`);
    else {
      failed++;
      console.error(`✗ ${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
  }

  // ---- which provider a checkout reads ------------------------------------------------------------------
  //
  // Both present is refused rather than guessed: the wrong guess posts a plan on an unrelated item that
  // happens to share the number.
  check('no provider configured', selectProvider({ gitlab: false, github: false }), { provider: null });
  check('a GitLab checkout', selectProvider({ gitlab: true, github: false }), { provider: 'gitlab' });
  check('a GitHub checkout', selectProvider({ gitlab: false, github: true }), { provider: 'github' });
  check('both is refused, naming both', selectProvider({ gitlab: true, github: true }), {
    error:
      'both .env.gitlab and .env.github are configured — remove the one this repository does not use, ' +
      'or set BOARD_PROVIDER=gitlab|github',
  });
  check('the override settles both', selectProvider({ gitlab: true, github: true, override: 'github' }), {
    provider: 'github',
  });
  check('an unknown override is refused', selectProvider({ gitlab: true, override: 'jira' }), {
    error: 'BOARD_PROVIDER is "jira" — it must be gitlab or github',
  });

  check(
    'a value that is only a comment is blank, and a trailing comment is dropped',
    parseEnv('A=   # optional\nB=x # note\nC="# kept"\nD=a#b'),
    { A: '', B: 'x', C: '# kept', D: 'a#b' },
  );

  // ---- what the GitLab adapter hands the rules -----------------------------------------------------------
  const glIssue = {
    iid: 13,
    title: 'Search misses compounds',
    web_url: 'https://gitlab.example.com/g/p/-/issues/13',
    labels: ['feedback', 'ai:plan-posted'],
    description: 'Body',
    state: 'opened',
    confidential: false,
    created_at: '2026-09-01T08:00:00Z',
    updated_at: '2026-09-02T09:00:00Z',
    user_notes_count: 2,
    milestone: { id: 4, title: 'release-0.2.0' },
  };
  const ITEM_13 = {
    iid: 13,
    title: 'Search misses compounds',
    url: 'https://gitlab.example.com/g/p/-/issues/13',
    labels: ['feedback', 'ai:plan-posted'],
    description: 'Body',
    state: 'open',
    confidential: false,
    createdAt: '2026-09-01T08:00:00Z',
    updatedAt: '2026-09-02T09:00:00Z',
    commentCount: 2,
    milestone: { title: 'release-0.2.0' },
  };
  check('a GitLab issue becomes an Item', gitlabItem(glIssue), ITEM_13);
  check(
    'a GitLab issue with no confidential flag is confidential',
    isConfidential(gitlabItem({ ...glIssue, confidential: undefined })),
    true,
  );
  check(
    'a GitLab note becomes a Comment',
    gitlabComment({
      id: 5,
      author: { id: 7, username: 'bot' },
      body: '## Remediation plan',
      created_at: '2026-09-03T10:00:00Z',
      system: false,
    }),
    { id: 5, authorId: 7, author: 'bot', body: '## Remediation plan', createdAt: '2026-09-03T10:00:00Z' },
  );
  check(
    'a GitLab milestone becomes a Milestone',
    [
      gitlabMilestone({
        id: 4,
        title: 'release-0.2.0',
        state: 'active',
        due_date: '2026-09-27',
        web_url: 'https://gl/m/4',
      }),
      gitlabMilestone({ id: 5, title: 'release-0.1.0', state: 'closed', due_date: null }),
    ],
    [
      { id: 4, title: 'release-0.2.0', state: 'open', due: '2026-09-27', url: 'https://gl/m/4' },
      { id: 5, title: 'release-0.1.0', state: 'closed', due: null, url: null },
    ],
  );

  // The GitLab adapter through a fake fetch: the endpoints are the ones the board used before the
  // adapters existed, and a listing crosses a page boundary (101 items), so a loop that stopped after the
  // first page cannot pass.
  const glEnv = { GITLAB_URL: 'gitlab.example.com', GITLAB_TOKEN: 'reporter', GITLAB_PROJECT_ID: 'g/p' };
  const many = Array.from({ length: 101 }, (_, i) => ({ ...glIssue, iid: i + 1 }));
  const gl = fakeFetch([
    [
      (m, u) => m === 'GET' && u.includes('/issues?state=opened'),
      (u) => ({
        json: /[?&]page=1$/.test(u) ? many.slice(0, 100) : many.slice(100),
      }),
    ],
    [
      (m, u) => m === 'PUT' && u.includes('/issues/13?'),
      { json: { ...glIssue, state: 'closed', labels: ['feedback'] } },
    ],
  ]);
  const glBoard = createGitlab(glEnv, '/nonexistent', { fetch: gl.impl });
  const glOpen = await glBoard.listOpen();
  check(
    'GitLab: every page of open items is read',
    glOpen.map((i) => i.iid),
    many.map((i) => i.iid),
  );
  const glClosed = await glBoard.close(13, ['feedback']);
  check(
    'GitLab: requests made, in order, with the token',
    gl.calls.map((c) => [c.method, c.url, c.headers['PRIVATE-TOKEN']]),
    [
      [
        'GET',
        'https://gitlab.example.com/api/v4/projects/g%2Fp/issues?state=opened&order_by=created_at&sort=asc&per_page=100&page=1',
        'reporter',
      ],
      [
        'GET',
        'https://gitlab.example.com/api/v4/projects/g%2Fp/issues?state=opened&order_by=created_at&sort=asc&per_page=100&page=2',
        'reporter',
      ],
      [
        'PUT',
        'https://gitlab.example.com/api/v4/projects/g%2Fp/issues/13?state_event=close&labels=feedback',
        'reporter',
      ],
    ],
  );
  check('GitLab: close returns the closed Item', [glClosed.state, glClosed.labels], ['closed', ['feedback']]);

  // ensureLabel reads every page of labels: the one it wants is the 101st, on page 2 (#33, #36). A 409 on
  // the create means the label exists after all, which is not a failure.
  const LBL = 'https://gitlab.example.com/api/v4/projects/g%2Fp/labels';
  const manyLabels = [
    ...Array.from({ length: 100 }, (_, i) => ({ name: `area-${i}` })),
    { name: 'release-1.0.0' },
  ];
  const glLabels = fakeFetch([
    [
      (m, u) => m === 'GET' && u.startsWith(`${LBL}?`),
      (u) => ({ json: /[?&]page=1$/.test(u) ? manyLabels.slice(0, 100) : manyLabels.slice(100) }),
    ],
    [
      (m, u) => m === 'POST' && u === LBL,
      (_u, init) => ({ status: JSON.parse(init.body).name === 'ai:ready' ? 409 : 201, json: {} }),
    ],
  ]);
  const gll = createGitlab(glEnv, '/nonexistent', { fetch: glLabels.impl });
  check(
    'GitLab: ensureLabel finds a label on the second page, a 409 is "exists", a new one is created',
    [
      await gll.ensureLabel('release-1.0.0', '#0E7490', 'r'),
      await gll.ensureLabel('ai:ready', '#000000', 'a'),
      await gll.ensureLabel('release-2.0.0', '#0E7490', 'r'),
    ],
    [false, false, true],
  );
  check(
    'GitLab: ensureLabel requests, in order',
    glLabels.calls.map((c) => [c.method, c.url.replace(LBL, '')]),
    [
      ['GET', '?per_page=100&page=1'],
      ['GET', '?per_page=100&page=2'],
      ['GET', '?per_page=100&page=1'],
      ['GET', '?per_page=100&page=2'],
      ['POST', ''],
      ['GET', '?per_page=100&page=1'],
      ['GET', '?per_page=100&page=2'],
      ['POST', ''],
    ],
  );
  const glDenied = fakeFetch([
    [(m, u) => m === 'GET' && u.startsWith(`${LBL}?`), { json: [] }],
    [(m, u) => m === 'POST' && u === LBL, { status: 403, json: {} }],
  ]);
  check(
    'GitLab: ensureLabel still throws on a refusal other than 409',
    await createGitlab(glEnv, '/nonexistent', { fetch: glDenied.impl })
      .ensureLabel('release-1.0.0', '#0E7490', 'r')
      .then(
        () => 'resolved',
        (e) => [e.code, e.status],
      ),
    ['forbidden', 403],
  );

  // links: a 404 or 403 means this instance has no linked issues (null); any other failure is thrown,
  // because "no links" from a failed read made a batch resume re-POST links that existed (#36).
  const glLinks = fakeFetch([
    [(_m, u) => u.endsWith('/issues/1/links'), { status: 404, json: {} }],
    [(_m, u) => u.endsWith('/issues/2/links'), { status: 403, json: {} }],
    [(_m, u) => u.endsWith('/issues/3/links'), { status: 503, json: {} }],
    [(_m, u) => u.endsWith('/issues/4/links'), { json: [{ iid: 9 }] }],
  ]);
  const gli = createGitlab(glEnv, '/nonexistent', { fetch: glLinks.impl });
  check(
    'GitLab: links is null only when the endpoint is missing or refused, and throws on anything else',
    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        gli.links(n).then(
          (v) => v,
          (e) => [e.code, e.status],
        ),
      ),
    ),
    [null, null, ['http_error', 503], [{ iid: 9 }]],
  );

  // A GitLab release goes through the Developer token and carries its milestone; a second attachment of
  // the same name moves the existing link rather than adding one.
  const GL = 'https://gitlab.example.com/api/v4/projects/g%2Fp';
  const glRel = fakeFetch([
    [(m, u) => m === 'GET' && u.endsWith('/releases/release-1.2.0'), { status: 404, json: {} }],
    [(m, u) => m === 'POST' && u.endsWith('/releases'), { status: 201, json: {} }],
    [
      (m, u) => m === 'POST' && u.endsWith('/uploads'),
      { status: 201, json: { full_path: '/g/p/uploads/abc/whats-new-1.2.0.html' } },
    ],
    [
      (m, u) => m === 'GET' && u.endsWith('/assets/links'),
      { json: [{ id: 6, name: "What's new (slides)" }] },
    ],
    [(m, u) => m === 'PUT' && u.endsWith('/assets/links/6'), { json: {} }],
  ]);
  const glr = createGitlab({ ...glEnv, GITLAB_MR_TOKEN: 'developer' }, '/nonexistent', { fetch: glRel.impl });
  await glr.saveRelease({
    tag: 'release-1.2.0',
    name: 'Release 1.2.0',
    description: 'Notes',
    milestone: 'release-1.2.0',
  });
  const glAtt = await glr.attachToRelease('release-1.2.0', {
    name: "What's new (slides)",
    filename: 'whats-new-1.2.0.html',
    bytes: Buffer.from('<html>'),
    type: 'text/html',
  });
  check(
    'GitLab: a release is created with the Developer token and its milestone, and the slides link is moved',
    [
      glAtt,
      JSON.parse(glRel.calls.find((c) => c.method === 'POST' && c.url.endsWith('/releases')).body),
      glRel.calls.map((c) => [c.method, c.url.replace(GL, ''), c.headers['PRIVATE-TOKEN']]),
    ],
    [
      { url: 'https://gitlab.example.com/g/p/uploads/abc/whats-new-1.2.0.html', replaced: true },
      {
        tag_name: 'release-1.2.0',
        name: 'Release 1.2.0',
        description: 'Notes',
        milestones: ['release-1.2.0'],
      },
      [
        ['GET', '/releases/release-1.2.0', 'developer'],
        ['POST', '/releases', 'developer'],
        ['GET', '/releases/release-1.2.0', 'developer'],
        ['POST', '/uploads', 'reporter'],
        ['GET', '/releases/release-1.2.0/assets/links', 'developer'],
        ['PUT', '/releases/release-1.2.0/assets/links/6', 'developer'],
      ],
    ],
  );

  // Who merged a GitLab merge request. Each project access token is its own bot user, so a merge counts
  // as the bot's when either of ours made it: the Reporter board token or the Developer GITLAB_MR_TOKEN,
  // which is the one that could actually merge. `merge_user` is GitLab's current field; `merged_by` is the
  // deprecated one older instances still send.
  const glMerged = (iid, user) => ({
    iid,
    title: `feat: ${iid}`,
    source_branch: `kit-demo/${iid}`,
    target_branch: 'main',
    description: '',
    state: 'merged',
    merge_commit_sha: `m${iid}`,
    web_url: `https://gitlab.example.com/g/p/-/merge_requests/${iid}`,
    ...user,
  });
  const glMerges = fakeFetch([
    [
      (m, u) => m === 'GET' && u.endsWith('/api/v4/user'),
      (_u, init) => ({ json: { id: init.headers['PRIVATE-TOKEN'] === 'developer' ? 52 : 51 } }),
    ],
    [
      (m, u) => m === 'GET' && u.endsWith('/merge_requests/8'),
      { json: glMerged(8, { merged_by: { id: 5, username: 'octo' } }) },
    ],
    [
      (m, u) => m === 'GET' && u.endsWith('/merge_requests/9'),
      { json: glMerged(9, { merge_user: { id: 52, username: 'project_1_bot' } }) },
    ],
  ]);
  const glm = createGitlab({ ...glEnv, GITLAB_MR_TOKEN: 'developer' }, '/nonexistent', {
    fetch: glMerges.impl,
  });
  const glWant = (iid) => ({
    iid,
    title: `feat: ${iid}`,
    sourceBranch: `kit-demo/${iid}`,
    targetBranch: 'main',
    description: '',
    state: 'merged',
    mergeSha: `m${iid}`,
    url: `https://gitlab.example.com/g/p/-/merge_requests/${iid}`,
  });
  check('gitlab getMr: merged_by present, a person', await glm.getMr(8), {
    ...glWant(8),
    mergedBy: 'octo',
    mergedByBot: false,
  });
  check('gitlab getMr: merged by the Developer token, which is ours', await glm.getMr(9), {
    ...glWant(9),
    mergedBy: 'project_1_bot',
    mergedByBot: true,
  });
  check(
    "GitLab: both tokens' users are looked up once across two getMr calls",
    glMerges.calls.map((c) => [c.method, c.url.replace(GL, ''), c.headers['PRIVATE-TOKEN']]),
    [
      ['GET', '/merge_requests/8', 'reporter'],
      ['GET', 'https://gitlab.example.com/api/v4/user', 'reporter'],
      ['GET', 'https://gitlab.example.com/api/v4/user', 'developer'],
      ['GET', '/merge_requests/9', 'reporter'],
    ],
  );

  // ---- links written into the body (the GitHub shape) -----------------------------------------------------
  check(
    'Relates-to lines are parsed, each once, in order, and only on a line of their own',
    relatesTo('Fix it.\n\nRelates-to: #12\nsee Relates-to: #99 inline\nRelates-to: #4  \nRelates-to: #12'),
    [12, 4],
  );
  check(
    'adding a link appends it as the last line',
    addRelatesTo('Body text.\n', 12),
    'Body text.\n\nRelates-to: #12',
  );
  check('adding a link to an empty body', addRelatesTo('', 12), 'Relates-to: #12');
  check(
    'adding one already there changes nothing',
    addRelatesTo('Body\n\nRelates-to: #12', 12),
    'Body\n\nRelates-to: #12',
  );
  check(
    'stripping removes only that link',
    stripRelatesTo('Body\n\nRelates-to: #12\nRelates-to: #4', 12),
    'Body\n\nRelates-to: #4',
  );
  check(
    'stripping the last link leaves no trailing blank lines',
    stripRelatesTo('Body\n\nRelates-to: #12', '12'),
    'Body',
  );

  // ---- the GitHub adapter ---------------------------------------------------------------------------------
  //
  // The App's JWT, signed with a key made here and thrown away: the claims are exactly what GitHub is sent,
  // and the signature verifies against the key's public half.
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const jwt = appJwt('12345', pem, 1_700_000_000);
  const [jh, jc, js] = jwt.split('.');
  const unb64 = (x) => JSON.parse(Buffer.from(x, 'base64url').toString('utf8'));
  check('the JWT header is RS256', unb64(jh), { alg: 'RS256', typ: 'JWT' });
  check('the JWT claims are backdated 60 s and live 9 min', unb64(jc), {
    iat: 1_699_999_940,
    exp: 1_700_000_540,
    iss: '12345',
  });
  check(
    'the JWT signature verifies',
    crypto.verify('RSA-SHA256', Buffer.from(`${jh}.${jc}`), publicKey, Buffer.from(js, 'base64url')),
    true,
  );

  check(
    'Link: the next page is found among the others',
    nextLink(
      '<https://api.github.com/x?page=1>; rel="prev", <https://api.github.com/x?page=3>; rel="next", <https://api.github.com/x?page=9>; rel="last"',
    ),
    'https://api.github.com/x?page=3',
  );
  check(
    'Link: the last page has no next',
    nextLink('<https://api.github.com/x?page=1>; rel="first", <https://api.github.com/x?page=1>; rel="prev"'),
    null,
  );
  check('Link: no header is one page', nextLink(null), null);

  check(
    'a GitHub failure says its message and every entry of errors',
    [
      githubErrorDetail({
        message: 'Validation Failed',
        errors: [
          { resource: 'PullRequest', code: 'custom', message: 'not all refs are readable' },
          { resource: 'PullRequest', field: 'head', code: 'invalid' },
          'plain',
        ],
      }),
      githubErrorDetail({ message: 'Not Found' }),
      githubErrorDetail(null),
    ],
    [
      'Validation Failed; not all refs are readable; {"resource":"PullRequest","field":"head","code":"invalid"}; plain',
      'Not Found',
      '',
    ],
  );

  const hdr = (h) => (k) => h[k] ?? null;
  check(
    'GitHub failures map onto the vocabulary',
    [
      githubErrorCode(401, hdr({})),
      githubErrorCode(403, hdr({ 'x-ratelimit-remaining': '0' })),
      githubErrorCode(403, hdr({ 'retry-after': '60' })),
      githubErrorCode(429, hdr({})),
      githubErrorCode(403, hdr({ 'x-ratelimit-remaining': '4999' })),
      githubErrorCode(404, hdr({})),
      githubErrorCode(422, hdr({})),
    ],
    [
      'unauthenticated',
      'rate-limited',
      'rate-limited',
      'rate-limited',
      'forbidden',
      'not-found',
      'http_error',
    ],
  );

  // Contract: the same issue on either provider is the same Item, so the rules cannot tell them apart.
  const ghIssue = {
    number: 13,
    title: 'Search misses compounds',
    html_url: 'https://gitlab.example.com/g/p/-/issues/13',
    labels: [{ name: 'feedback' }, { name: 'ai:plan-posted' }],
    body: 'Body',
    state: 'open',
    created_at: '2026-09-01T08:00:00Z',
    updated_at: '2026-09-02T09:00:00Z',
    comments: 2,
    milestone: { number: 3, title: 'release-0.2.0' },
  };
  check(
    'contract: a GitHub issue and its GitLab twin are one Item',
    githubItem(ghIssue),
    gitlabItem(glIssue),
  );
  check(
    'a listing that mixes issues and pull requests keeps exactly the issues',
    onlyIssues([{ number: 1 }, { number: 2, pull_request: {} }, { number: 3 }]).map((i) => i.number),
    [1, 3],
  );
  check(
    'a GitHub comment becomes a Comment',
    githubComment({
      id: 9,
      user: { id: 41, login: 'board[bot]' },
      body: 'hi',
      created_at: '2026-09-03T10:00:00Z',
    }),
    { id: 9, authorId: 41, author: 'board[bot]', body: 'hi', createdAt: '2026-09-03T10:00:00Z' },
  );
  check(
    'a GitHub milestone becomes a Milestone, keyed by its number and its due date cut to a day',
    githubMilestone({
      id: 999,
      number: 3,
      title: 'release-0.2.0',
      state: 'open',
      due_on: '2026-09-27T07:00:00Z',
      html_url: 'https://github.com/k/r/milestone/3',
    }),
    {
      id: 3,
      title: 'release-0.2.0',
      state: 'open',
      due: '2026-09-27',
      url: 'https://github.com/k/r/milestone/3',
    },
  );
  check(
    'every ai: label description fits GitHub, and only the long one is cut',
    Object.values(LABEL_COLOURS).map(([, d]) => [
      labelDescription(d).length <= 100,
      labelDescription(d) === d,
    ]),
    Object.values(LABEL_COLOURS).map(([, d]) => [true, d.length <= 100]),
  );
  check(
    'a cut description ends in an ellipsis at 100',
    labelDescription('x'.repeat(150)),
    `${'x'.repeat(99)}…`,
  );
  check(
    'attachments go to one folder per item or pull request, per run',
    [
      assetPath({ iid: 13 }, '20261005T101500Z', 'home.png'),
      assetPath({ mr: 5 }, '20261005T101500Z', 'notes.pdf'),
    ],
    ['items/13/20261005T101500Z/home.png', 'pulls/5/20261005T101500Z/notes.pdf'],
  );
  check(
    'an image is shown inline, anything else linked',
    [
      assetMarkdown('home.png', 'https://github.com/k/r/blob/board-assets/a/home.png'),
      assetMarkdown('notes.pdf', 'https://github.com/k/r/blob/board-assets/a/notes.pdf'),
    ],
    [
      '![home.png](https://github.com/k/r/blob/board-assets/a/home.png?raw=true)',
      '[notes.pdf](https://github.com/k/r/blob/board-assets/a/notes.pdf?raw=true)',
    ],
  );

  // The adapter itself, through a fake GitHub. The key file is the one made above, written to a temporary
  // directory and removed at the end; nothing is read from this checkout's own configuration.
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-selftest-'));
  try {
    fs.writeFileSync(path.join(keyDir, 'app.pem'), pem);
    const ghEnv = {
      GITHUB_REPOSITORY: 'knowit/factory-kit',
      GITHUB_APP_ID: '12345',
      GITHUB_APP_PRIVATE_KEY_PATH: 'app.pem',
    };
    const API = 'https://api.github.com/repos/knowit/factory-kit';
    const issueN = (n, extra = {}) => ({
      ...ghIssue,
      number: n,
      labels: [],
      body: '',
      milestone: null,
      ...extra,
    });
    const pageOne = Array.from({ length: 100 }, (_, i) => issueN(i + 1));
    const tokenFor = (init) => {
      const p = JSON.parse(init.body).permissions;
      return p.pull_requests ? 'tok-mr' : p.contents ? 'tok-assets' : 'tok-board';
    };
    const route = (method, suffix) => (m, u) => m === method && u.endsWith(suffix);
    const routes = [
      [route('GET', '/repos/knowit/factory-kit/installation'), { json: { id: 77 } }],
      [
        route('POST', '/app/installations/77/access_tokens'),
        (_u, init) => ({ json: { token: tokenFor(init) } }),
      ],
      [
        route('GET', '/issues?state=open&sort=created&direction=asc&per_page=100'),
        { json: pageOne, headers: { link: `<${API}/issues?state=open&per_page=100&page=2>; rel="next"` } },
      ],
      [
        route('GET', '/issues?state=open&per_page=100&page=2'),
        { json: [issueN(101), issueN(102, { pull_request: {} })] },
      ],
      [
        route('PATCH', '/issues/13'),
        (_u, init) => ({ json: issueN(13, { state: 'closed', labels: JSON.parse(init.body).labels }) }),
      ],
      [
        route('POST', '/pulls'),
        { json: { number: 5, html_url: 'https://github.com/knowit/factory-kit/pull/5' } },
      ],
    ];
    const gh = fakeFetch(routes);
    const ghBoard = createGithub(ghEnv, keyDir, { fetch: gh.impl });
    const ghOpen = await ghBoard.listOpen();
    check(
      'GitHub: every page is read, and the pull request on page two is dropped',
      ghOpen.map((i) => i.iid),
      Array.from({ length: 101 }, (_, i) => i + 1),
    );
    await ghBoard.close(13, ['feedback']);
    await ghBoard.openMr({ source: 'feat/x', target: 'main', title: 'feat: x', description: 'What and why' });
    const shape = (c) => [
      c.method,
      c.url.replace('https://api.github.com', ''),
      c.headers.Authorization?.startsWith('Bearer eyJ') ? 'JWT' : c.headers.Authorization,
      c.body ? JSON.parse(c.body) : null,
    ];
    check(
      'GitHub: the installation is looked up, a token minted per scope, and each request carries its own',
      gh.calls.map(shape),
      [
        ['GET', '/repos/knowit/factory-kit/installation', 'JWT', null],
        [
          'POST',
          '/app/installations/77/access_tokens',
          'JWT',
          { repositories: ['factory-kit'], permissions: { issues: 'write', metadata: 'read' } },
        ],
        [
          'GET',
          '/repos/knowit/factory-kit/issues?state=open&sort=created&direction=asc&per_page=100',
          'Bearer tok-board',
          null,
        ],
        ['GET', '/repos/knowit/factory-kit/issues?state=open&per_page=100&page=2', 'Bearer tok-board', null],
        [
          'PATCH',
          '/repos/knowit/factory-kit/issues/13',
          'Bearer tok-board',
          { state: 'closed', state_reason: 'completed', labels: ['feedback'] },
        ],
        [
          'POST',
          '/app/installations/77/access_tokens',
          'JWT',
          { repositories: ['factory-kit'], permissions: { pull_requests: 'write', contents: 'read' } },
        ],
        [
          'POST',
          '/repos/knowit/factory-kit/pulls',
          'Bearer tok-mr',
          { head: 'feat/x', base: 'main', title: 'feat: x', body: 'What and why' },
        ],
      ],
    );
    check(
      'GitHub: every request names the API version',
      gh.calls.every(
        (c) =>
          c.headers['X-GitHub-Api-Version'] === '2022-11-28' &&
          c.headers.Accept === 'application/vnd.github+json',
      ),
      true,
    );

    // Links in both directions: #13 names #4, and the open #20 names #13. #30 names nobody.
    const linked = fakeFetch([
      [route('POST', '/access_tokens'), { json: { token: 'tok-board' } }],
      [route('GET', '/issues/13'), { json: issueN(13, { body: 'Body\n\nRelates-to: #4' }) }],
      [route('GET', '/issues/20'), { json: issueN(20, { body: 'Split from it.\n\nRelates-to: #13' }) }],
      [
        route('GET', '/issues?state=open&sort=created&direction=asc&per_page=100'),
        {
          json: [
            issueN(13, { body: 'Body\n\nRelates-to: #4' }),
            issueN(20, { body: 'Split from it.\n\nRelates-to: #13' }),
            issueN(30, { body: 'Relates-to: #7' }),
          ],
        },
      ],
      [
        route('PATCH', '/issues/20'),
        (_u, init) => ({ json: issueN(20, { body: JSON.parse(init.body).body }) }),
      ],
    ]);
    const lb = createGithub({ ...ghEnv, GITHUB_APP_INSTALLATION_ID: '77' }, keyDir, { fetch: linked.impl });
    check('GitHub: links are read from both sides', await lb.links(13), [{ iid: 4 }, { iid: 20 }]);
    check(
      'GitHub: unlinking a pair takes the line off the side that carries it',
      await lb.unlink(13, 20),
      true,
    );
    check(
      'GitHub: ... and writes only that side, with only that line gone',
      linked.calls
        .filter((c) => c.method === 'PATCH')
        .map((c) => [c.url.replace(API, ''), JSON.parse(c.body)]),
      [['/issues/20', { body: 'Split from it.' }]],
    );

    // A board moved from GitLab carries its confidential items as issues labelled `confidential`. The
    // adapter reads the label as GitLab's flag, so `list` withholds them, `releases` and the release notes
    // name them by number only, and the session-start report never prints their titles.
    const secret = { title: 'secret thing', labels: [{ name: 'confidential' }] };
    const confidential = fakeFetch([
      [route('POST', '/access_tokens'), { json: { token: 'tok-board' } }],
      [
        route('GET', '/issues?state=open&sort=created&direction=asc&per_page=100'),
        {
          json: [
            issueN(1),
            issueN(2, secret),
            issueN(3, { labels: ['Confidential'] }),
            issueN(4, { labels: [{ name: 'confidential-ish' }] }),
            issueN(5, { ...secret, pull_request: {} }),
          ],
        },
      ],
      [
        route('GET', '/issues?state=all&per_page=100'),
        { json: [issueN(1, { state: 'closed' }), issueN(2, { ...secret, state: 'closed' })] },
      ],
    ]);
    const cb = createGithub({ ...ghEnv, GITHUB_APP_INSTALLATION_ID: '77' }, keyDir, {
      fetch: confidential.impl,
    });
    const confOpen = await cb.listOpen();
    check(
      'GitHub: a `confidential` label in any case is the confidential flag, and list withholds it',
      [
        confOpen.map((i) => [i.iid, i.confidential]),
        confOpen.filter((i) => !isConfidential(i)).map((i) => i.iid),
      ],
      [
        [
          [1, false],
          [2, true],
          [3, true],
          [4, false],
        ],
        [1, 4],
      ],
    );
    const confAll = new Map((await cb.listAll()).map((i) => [i.iid, i]));
    const confNotes = renderNotes({
      label: 'release-0.3.0',
      name: 'Release 0.3.0',
      from: 'release-0.3.x',
      head: 'abcdef1234',
      base: '1234567abc',
      date: '2026-10-01',
      items: confAll,
      included: [
        { iid: 1, mrs: [] },
        { iid: 2, mrs: [] },
      ],
      mergeRequests: [],
      noItem: [],
      outside: [],
      config: [],
      configFiles: {},
      migrations: [],
      isConfidential,
      mrRef: (n) => `#${n}`,
    });
    check(
      'GitHub: releases and the release notes name a labelled item by number only',
      [
        [...confAll.values()].map((i) => (isConfidential(i) ? '(confidential)' : i.title)),
        confNotes.includes('- **#2** (confidential) (included by hand)'),
        confNotes.includes('secret thing'),
      ],
      [['Search misses compounds', '(confidential)'], true, false],
    );

    // A confidential sibling's title and `why` stay out of `show` and `list --json` (#31), through each
    // adapter: GitLab's flag (a missing one counts), GitHub's label, in either direction of a Relates-to.
    const SIB_WITHHELD = (iid, state) => ({
      iid,
      title: '(confidential)',
      state,
      why: WITHHELD_WHY,
      closed: false,
    });
    const PUBLIC_12 = {
      iid: 12,
      title: 'Public sibling',
      state: 'new',
      why: 'no plan and no ai: label',
      closed: false,
    };
    const note = (id, who, body) => ({
      id,
      system: false,
      author: { id: who === 'someone' ? 2 : 1, username: who },
      body,
      created_at: '2026-10-01T10:00:00Z',
    });
    const glSib = (iid, extra) => ({ ...glIssue, iid, labels: [], user_notes_count: 0, ...extra });
    const glSecretless = glSib(13, { title: 'Secret B' });
    delete glSecretless.confidential;
    const glIssues = {
      10: glSib(10, { title: 'The public one' }),
      11: glSib(11, {
        title: 'Secret A',
        confidential: true,
        labels: ['ai:plan-posted'],
        user_notes_count: 2,
      }),
      12: glSib(12, { title: 'Public sibling', confidential: false }),
      13: glSecretless,
    };
    const glSibs = fakeFetch([
      [route('GET', '/issues/10/links'), { json: [{ iid: 13 }, { iid: 11 }, { iid: 12 }] }],
      [
        (m, u) => m === 'GET' && u.includes('/issues/11/notes'),
        { json: [note(1, 'board', `${PLAN_MARKER}\n[REVIEW 1] a?`), note(2, 'someone', 'yes')] },
      ],
      [(m, u) => m === 'GET' && /\/issues\/\d+$/.test(u), (u) => ({ json: glIssues[u.match(/(\d+)$/)[1]] })],
    ]);
    const glb = createGitlab(glEnv, '/nonexistent', { fetch: glSibs.impl });
    const glHidden = await siblings(glb, 10, 1);
    const glShown = await siblings(glb, 10, 1, { allowConfidential: true });
    check(
      'GitLab: a confidential sibling is (confidential) with a fixed why, a public one is whole',
      glHidden,
      [SIB_WITHHELD(11, 'answered'), PUBLIC_12, SIB_WITHHELD(13, 'new')],
    );
    check(
      'GitLab: no secret title and no replier reach the sibling list',
      ['Secret', 'someone'].map((w) => JSON.stringify(glHidden).split(w).length - 1),
      [0, 0],
    );
    check(
      'GitLab: show --confidential unlocks the siblings too',
      [glShown.map((x) => x.title), glShown[0].why.startsWith('someone replied on 2026-10-01')],
      [['Secret A', 'Public sibling', 'Secret B'], true],
    );

    const ghSibIssues = {
      10: issueN(10, { title: 'The public one', comments: 0, body: addRelatesTo(addRelatesTo('', 11), 12) }),
      11: issueN(11, { title: 'Secret A', comments: 0, labels: [{ name: 'confidential' }] }),
      12: issueN(12, { title: 'Public sibling', comments: 0 }),
      14: issueN(14, {
        title: 'Secret C',
        comments: 0,
        labels: [{ name: 'Confidential' }],
        body: addRelatesTo('', 10),
      }),
    };
    const ghSibs = fakeFetch([
      [route('POST', '/access_tokens'), { json: { token: 'tok-board' } }],
      [
        route('GET', '/issues?state=open&sort=created&direction=asc&per_page=100'),
        { json: Object.values(ghSibIssues) },
      ],
      [
        (m, u) => m === 'GET' && /\/issues\/\d+$/.test(u),
        (u) => ({ json: ghSibIssues[u.match(/(\d+)$/)[1]] }),
      ],
    ]);
    const ghb = createGithub({ ...ghEnv, GITHUB_APP_INSTALLATION_ID: '77' }, keyDir, { fetch: ghSibs.impl });
    const ghHidden = await siblings(ghb, 10, 1);
    check(
      'GitHub: a labelled sibling, linked from either side, is (confidential)',
      [ghHidden, JSON.stringify(ghHidden).split('Secret').length - 1],
      [[SIB_WITHHELD(11, 'new'), PUBLIC_12, SIB_WITHHELD(14, 'new')], 0],
    );
    check(
      'GitHub: show --confidential unlocks them',
      (await siblings(ghb, 10, 1, { allowConfidential: true })).map((x) => x.title),
      ['Secret A', 'Public sibling', 'Secret C'],
    );

    // A missing label is created with GitHub's colour format and a description it accepts; a missing
    // assets branch is started as an orphan before the first file is written to it.
    const fresh = fakeFetch([
      [route('POST', '/access_tokens'), (_u, init) => ({ json: { token: tokenFor(init) } })],
      [route('POST', '/labels'), { status: 201, json: {} }],
      [route('POST', '/git/blobs'), { status: 201, json: { sha: 'b1' } }],
      [route('POST', '/git/trees'), { status: 201, json: { sha: 't1' } }],
      [route('POST', '/git/commits'), { status: 201, json: { sha: 'c1' } }],
      [route('POST', '/git/refs'), { status: 201, json: {} }],
      [
        (m, u) => m === 'PUT' && u.includes('/contents/'),
        {
          status: 201,
          json: {
            content: {
              html_url:
                'https://github.com/knowit/factory-kit/blob/board-assets/items/13/20261005T101500Z/home%20page.png',
            },
          },
        },
      ],
    ]);
    const fb = createGithub({ ...ghEnv, GITHUB_APP_INSTALLATION_ID: '77' }, keyDir, {
      fetch: fresh.impl,
      now: () => Date.parse('2026-10-05T10:15:00.123Z'),
    });
    check(
      'GitHub: a label that is missing is created',
      await fb.ensureLabel('ai:answered', ...LABEL_COLOURS['ai:answered']),
      true,
    );
    const md = await fb.upload(
      { name: 'home page.png', bytes: Buffer.from('png'), type: 'image/png' },
      { iid: 13 },
    );
    check(
      'GitHub: label and upload requests, in order',
      fresh.calls
        .filter((c) => !c.url.endsWith('/access_tokens'))
        .map((c) => [c.method, c.url.replace(API, ''), c.headers.Authorization]),
      [
        ['GET', '/labels/ai%3Aanswered', 'Bearer tok-board'],
        ['POST', '/labels', 'Bearer tok-board'],
        ['GET', '/git/ref/heads/board-assets', 'Bearer tok-assets'],
        ['POST', '/git/blobs', 'Bearer tok-assets'],
        ['POST', '/git/trees', 'Bearer tok-assets'],
        ['POST', '/git/commits', 'Bearer tok-assets'],
        ['POST', '/git/refs', 'Bearer tok-assets'],
        ['PUT', '/contents/items/13/20261005T101500Z/home%20page.png', 'Bearer tok-assets'],
      ],
    );
    const body = (suffix) => JSON.parse(fresh.calls.find((c) => c.url.endsWith(suffix)).body);
    check('GitHub: the label is sent without "#" and cut to 100 characters', body('/labels'), {
      name: 'ai:answered',
      color: '108548',
      description: labelDescription(LABEL_COLOURS['ai:answered'][1]),
    });
    check(
      'GitHub: the assets branch starts with no parent',
      [body('/git/commits').parents, body('/git/refs')],
      [[], { ref: 'refs/heads/board-assets', sha: 'c1' }],
    );
    check(
      'GitHub: the file goes to the assets branch, base64, and is shown inline',
      [body('home%20page.png').branch, body('home%20page.png').content, md],
      [
        'board-assets',
        Buffer.from('png').toString('base64'),
        '![home page.png](https://github.com/knowit/factory-kit/blob/board-assets/items/13/20261005T101500Z/home%20page.png?raw=true)',
      ],
    );

    // Who merged a pull request. The setup guide's demo turns on it: a merge by the App means the ruleset
    // let the bot ship on its own. A listing (`pulls?state=…`) does not carry `merged_by`, so `getMr` is
    // one GET of the request itself, and the bot's id is looked up once however many requests are read.
    const pull = (n, mergedBy) => ({
      number: n,
      title: `feat: ${n}`,
      head: { ref: `kit-demo/${n}` },
      base: { ref: 'main' },
      body: '',
      state: 'closed',
      merged_at: '2026-10-28T10:00:00Z',
      merge_commit_sha: `m${n}`,
      html_url: `https://github.com/knowit/factory-kit/pull/${n}`,
      merged_by: mergedBy,
    });
    const merges = fakeFetch([
      [route('POST', '/access_tokens'), (_u, init) => ({ json: { token: tokenFor(init) } })],
      [(m, u) => m === 'GET' && u.endsWith('/app'), { json: { slug: 'board' } }],
      [route('GET', '/users/board%5Bbot%5D'), { json: { id: 41, login: 'board[bot]' } }],
      [route('GET', '/pulls/8'), { json: pull(8, { id: 5, login: 'octo' }) }],
      [route('GET', '/pulls/9'), { json: pull(9, { id: 41, login: 'board[bot]' }) }],
      [route('GET', '/pulls?state=all&head=knowit%3Akit-demo%2F7&per_page=100'), { json: [] }],
    ]);
    const mb = createGithub({ ...ghEnv, GITHUB_APP_INSTALLATION_ID: '77' }, keyDir, { fetch: merges.impl });
    const merged = (n) => ({
      iid: n,
      title: `feat: ${n}`,
      sourceBranch: `kit-demo/${n}`,
      targetBranch: 'main',
      description: '',
      state: 'merged',
      mergeSha: `m${n}`,
      url: `https://github.com/knowit/factory-kit/pull/${n}`,
    });
    check('github getMr: merged by a person', await mb.getMr(8), {
      ...merged(8),
      mergedBy: 'octo',
      mergedByBot: false,
    });
    check('github getMr: merged by the App', await mb.getMr(9), {
      ...merged(9),
      mergedBy: 'board[bot]',
      mergedByBot: true,
    });
    check(
      'mr-status: no request from the branch',
      mrStatus('kit-demo/7', (await mb.findMrs({ source: 'kit-demo/7' }))[0] ?? null),
      { branch: 'kit-demo/7', mr: null },
    );
    check('mr-status: the request, and who merged it', mrStatus('kit-demo/9', await mb.getMr(9)), {
      branch: 'kit-demo/9',
      mr: {
        iid: 9,
        url: 'https://github.com/knowit/factory-kit/pull/9',
        state: 'merged',
        mergedBy: 'board[bot]',
        mergedByBot: true,
      },
    });
    check(
      "GitHub: the bot's id is looked up once across three getMr calls",
      merges.calls
        .filter((c) => !c.url.endsWith('/access_tokens'))
        .map((c) => [c.method, c.url.replace('https://api.github.com', '')]),
      [
        ['GET', '/repos/knowit/factory-kit/pulls/8'],
        ['GET', '/app'],
        ['GET', '/users/board%5Bbot%5D'],
        ['GET', '/repos/knowit/factory-kit/pulls/9'],
        ['GET', '/repos/knowit/factory-kit/pulls?state=all&head=knowit%3Akit-demo%2F7&per_page=100'],
        ['GET', '/repos/knowit/factory-kit/pulls/9'],
      ],
    );

    // A release: created for the tag, its slides uploaded to GitHub's upload host after the old copy is
    // removed, and its milestone closed by number.
    const UP = 'https://uploads.github.com/repos/knowit/factory-kit/releases/8/assets';
    let created = false;
    const rel = fakeFetch([
      [route('POST', '/access_tokens'), (_u, init) => ({ json: { token: tokenFor(init) } })],
      [
        route('GET', '/releases/tags/release-1.2.0'),
        () =>
          created
            ? {
                json: {
                  id: 8,
                  html_url: 'https://github.com/knowit/factory-kit/releases/tag/release-1.2.0',
                  upload_url: `${UP}{?name,label}`,
                  assets: [{ id: 55, name: 'whats-new-1.2.0.html' }],
                },
              }
            : { status: 404, json: { message: 'Not Found' } },
      ],
      [
        route('POST', '/repos/knowit/factory-kit/releases'),
        () => {
          created = true;
          return {
            status: 201,
            json: { html_url: 'https://github.com/knowit/factory-kit/releases/tag/release-1.2.0' },
          };
        },
      ],
      [route('DELETE', '/releases/assets/55'), { status: 204 }],
      [
        (m, u) => m === 'POST' && u.startsWith(UP),
        { status: 201, json: { browser_download_url: 'https://github.com/dl/whats-new-1.2.0.html' } },
      ],
      [
        route('GET', '/milestones?state=all&per_page=100'),
        { json: [{ number: 3, title: 'release-1.2.0', state: 'open' }] },
      ],
      [route('PATCH', '/milestones/3'), { json: {} }],
    ]);
    const rb = createGithub({ ...ghEnv, GITHUB_APP_INSTALLATION_ID: '77' }, keyDir, { fetch: rel.impl });
    const saved = await rb.saveRelease({
      tag: 'release-1.2.0',
      name: 'Release 1.2.0',
      description: 'Notes',
      milestone: 'release-1.2.0',
    });
    const att = await rb.attachToRelease('release-1.2.0', {
      name: "What's new (slides)",
      filename: 'whats-new-1.2.0.html',
      bytes: Buffer.from('<html>'),
      type: 'text/html',
    });
    const closedMs = await rb.closeMilestone('release-1.2.0');
    check(
      'GitHub: a release is created, its slides replaced and labelled, its milestone closed',
      [
        saved.url,
        att,
        closedMs,
        rel.calls
          .filter((c) => !c.url.endsWith('/access_tokens'))
          .map((c) => [c.method, c.url.replace(API, '').replace(UP, 'UPLOAD'), c.headers.Authorization]),
      ],
      [
        'https://github.com/knowit/factory-kit/releases/tag/release-1.2.0',
        { url: 'https://github.com/dl/whats-new-1.2.0.html', replaced: true },
        'closed',
        [
          ['GET', '/releases/tags/release-1.2.0', 'Bearer tok-assets'],
          ['POST', '/releases', 'Bearer tok-assets'],
          ['GET', '/releases/tags/release-1.2.0', 'Bearer tok-assets'],
          ['DELETE', '/releases/assets/55', 'Bearer tok-assets'],
          ['POST', "UPLOAD?name=whats-new-1.2.0.html&label=What's%20new%20(slides)", 'Bearer tok-assets'],
          ['GET', '/milestones?state=all&per_page=100', 'Bearer tok-board'],
          ['PATCH', '/milestones/3', 'Bearer tok-board'],
        ],
      ],
    );
    const upload = rel.calls.find((c) => c.url.startsWith(UP));
    check(
      'GitHub: the release body has no milestone field, and the asset goes up raw with its own type',
      [
        JSON.parse(rel.calls.find((c) => c.method === 'POST' && c.url.endsWith('/releases')).body),
        upload.headers['Content-Type'],
        String(upload.body),
      ],
      [{ tag_name: 'release-1.2.0', name: 'Release 1.2.0', body: 'Notes' }, 'text/html', '<html>'],
    );

    // The shared installation client (createInstallationClient), which the adapter and the board migration
    // both use. A token lives an hour and a migration outlasts it: it is minted once, again before it runs
    // out, and again after a 401, which GitHub answers before doing anything.
    let clock = Date.parse('2026-10-12T10:00:00Z');
    let failNext = null;
    const mintAt = [];
    const timed = fakeFetch([
      [
        route('POST', '/access_tokens'),
        () => {
          mintAt.push(new Date(clock).toISOString().slice(11, 16));
          return {
            json: { token: `tok-${mintAt.length}`, expires_at: new Date(clock + 3600e3).toISOString() },
          };
        },
      ],
      [
        () => failNext !== null,
        () => {
          const status = failNext.shift();
          if (!failNext.length) failNext = null;
          return { status, json: { message: status === 401 ? 'Bad credentials' : 'Server Error' } };
        },
      ],
      [route('GET', '/labels'), { json: [{ name: 'a' }] }],
      [route('POST', '/labels'), { status: 201, json: { name: 'b' } }],
    ]);
    const slept = [];
    const client = (retries) =>
      createInstallationClient({ ...ghEnv, GITHUB_APP_INSTALLATION_ID: '77' }, keyDir, {
        fetch: timed.impl,
        now: () => clock,
        sleep: async (ms) => slept.push(ms),
        retries,
      });
    const c0 = client(4);
    const authOf = () => timed.calls.at(-1).headers.Authorization;
    await c0.api(`/repos/knowit/factory-kit/labels`);
    await c0.api(`/repos/knowit/factory-kit/labels`);
    const first = authOf();
    clock += 54 * 60_000; // six minutes left: still the same token
    await c0.api(`/repos/knowit/factory-kit/labels`);
    const stillFirst = authOf();
    clock += 2 * 60_000; // four left: inside the five-minute margin, so a new one
    await c0.api(`/repos/knowit/factory-kit/labels`);
    const renewed = authOf();
    failNext = [401];
    await c0.api(`/repos/knowit/factory-kit/labels`);
    check(
      'GitHub client: a token is minted once, again five minutes before it expires, and again after a 401',
      [mintAt, first, stillFirst, renewed, authOf()],
      [['10:00', '10:56', '10:56'], 'Bearer tok-1', 'Bearer tok-1', 'Bearer tok-2', 'Bearer tok-3'],
    );

    // A read is repeated after a 5xx, with a growing wait; a write never is, since one that answered 5xx
    // may have happened (GitHub burnt an issue number on a 502 that created nothing). The adapter's client
    // repeats nothing.
    const outcome = async (c, method) => {
      try {
        await c.api('/repos/knowit/factory-kit/labels', method === 'GET' ? {} : { method, body: {} });
        return 'ok';
      } catch (e) {
        return e.code;
      }
    };
    timed.calls.length = 0;
    slept.length = 0;
    failNext = [502, 503];
    const read = await outcome(c0, 'GET');
    const readCalls = timed.calls.length;
    const readSlept = [...slept];
    failNext = [502];
    const write = await outcome(c0, 'POST');
    failNext = [502];
    const adapterRead = await outcome(client(0), 'GET');
    failNext = [500, 500, 500, 500, 500];
    const exhausted = await outcome(c0, 'GET');
    check(
      'GitHub client: a read is retried after a 5xx, a write is not, and the adapter retries nothing',
      [read, readCalls, readSlept, write, adapterRead, exhausted, slept.slice(2)],
      ['ok', 3, [3000, 6000], 'http_error', 'http_error', 'http_error', [3000, 6000, 9000, 12000]],
    );

    // An unconfigured GitHub is a quiet `network` failure, like an unconfigured GitLab.
    let unconfigured = null;
    try {
      await createGithub({}, keyDir, { fetch: gh.impl }).get(1);
    } catch (e) {
      unconfigured = [e.code, e.transient];
    }
    check('GitHub: unconfigured is transient, so the hook stays silent', unconfigured, ['network', true]);

    // Items the bot opened itself, through both adapters (#39).
    await botOpenedSelftest(check, { glEnv, ghEnv, keyDir, glIssue, ghIssue });
  } finally {
    fs.rmSync(keyDir, { recursive: true, force: true });
  }

  // ---- release: which items a release delivers, and what its notes say ------------------------------------
  const refs = (d) => {
    const r = deliveredRefs(d);
    return { strong: [...r.strong].sort((a, b) => a - b), mentioned: [...r.mentioned].sort((a, b) => a - b) };
  };
  check('a release label names its version', versionOf('release-0.3.1'), '0.3.1');
  check(
    'anything else does not',
    [versionOf('0.3.1'), versionOf('release-0.3'), versionOf('release-0.3.x'), versionOf(undefined)],
    [null, null, null, null],
  );
  check(
    'GitLab merge requests are read from commit messages, this project only',
    gitlabMrRefs(
      [
        { subject: "Merge branch 'a' into 'b'", body: 'x\n\nSee merge request g/p!167' },
        { subject: 'Merge', body: 'See merge request other/p!9' },
        { subject: 'Merge', body: 'See merge request g/p!12' },
      ],
      'g/p',
    ),
    [12, 167],
  );
  check(
    'GitHub pull requests are read from merge and squash subjects, never from a squash body',
    githubMrRefs([
      { subject: 'Merge pull request #12 from knowit/feat/12-x', body: 'feat: x' },
      { subject: 'fix: the thing (#31)', body: '* part one (#29)\n* part two (#30)' },
      { subject: 'docs: see #40 for why', body: '' },
    ]),
    [12, 31],
  );
  check(
    'a git log with separators parses into commits, a body with blank lines kept whole',
    parseLog('a1\x1ffeat: one\x1fbody line\n\nmore\x1e\nb2\x1ffix: two\x1f\x1e\n'),
    [
      { sha: 'a1', subject: 'feat: one', body: 'body line\n\nmore' },
      { sha: 'b2', subject: 'fix: two', body: '' },
    ],
  );
  check(
    'a merged GitLab request reports its merge commit, else its squash, else its head',
    [
      gitlabMr({ iid: 1, state: 'merged', merge_commit_sha: 'm', squash_commit_sha: 's', sha: 'h' }).mergeSha,
      gitlabMr({ iid: 1, state: 'merged', merge_commit_sha: null, squash_commit_sha: 's', sha: 'h' })
        .mergeSha,
      gitlabMr({ iid: 1, state: 'merged', merge_commit_sha: null, squash_commit_sha: null, sha: 'h' })
        .mergeSha,
      gitlabMr({ iid: 1, state: 'opened', merge_commit_sha: null, sha: 'h' }).mergeSha,
    ],
    ['m', 's', 'h', null],
  );
  check(
    'contract: a merged GitLab request and a merged GitHub pull request are one Mr',
    githubMr({
      number: 7,
      title: 'feat: x',
      head: { ref: 'feat/7-x' },
      base: { ref: 'main' },
      body: null,
      state: 'closed',
      merged_at: '2026-10-05T10:00:00Z',
      merge_commit_sha: 'abc',
      html_url: 'u',
    }),
    gitlabMr({
      iid: 7,
      title: 'feat: x',
      source_branch: 'feat/7-x',
      target_branch: 'main',
      description: null,
      state: 'merged',
      merge_commit_sha: 'abc',
      web_url: 'u',
    }),
  );
  check(
    'a closed, unmerged pull request is closed, not merged',
    githubMr({ number: 8, head: {}, base: {}, state: 'closed', merged_at: null, merge_commit_sha: 'x' })
      .state,
    'closed',
  );
  check('a numbered branch names its item', branchItem('feat/243-rotating-taglines'), 243);
  check(
    'a batch branch names none',
    [branchItem('feat/batch-0.3.0-a'), branchItem('docs/batch-runs')],
    [null, null],
  );
  // The shapes of Makers Market's merge requests, which is what the rule was written against.
  check(
    'a batch table row delivers, "also delivers" delivers, a follow-up mention does not',
    refs(
      '| #240 | the panel | — |\n| #180 | uploads. Also delivers #162 | — |\nRaised #241 and #242 as follow-ups.',
    ),
    { strong: [162, 180, 240], mentioned: [241, 242] },
  );
  check(
    'a line that starts with the item delivers it; "after #217" is context',
    refs(
      'The headline types itself. #243.\n#243. The decisions are on the item.\nRebased after #217 and #234.',
    ),
    { strong: [243], mentioned: [217, 234] },
  );
  check(
    'a list under What delivers; the same list under a follow-ups caption does not',
    refs(
      '## What\n- **#193: search.**\n## How was it verified?\n**Follow-ups filed:**\n- #248: snippets\n- Fixes nothing',
    ),
    { strong: [193], mentioned: [248] },
  );
  check(
    'a leading reference under Why is context; Fixes under What delivers',
    refs('## What\n- **Fixes #252.** The test.\n## Why\n- **#171–#178:** the hardening'),
    { strong: [252], mentioned: [171, 178] },
  );
  check(
    'nothing counts under a needs-a-person caption, not even a verb',
    refs('| #177 | zip |\n**Needs a person, before or after merge:**\n- #177 check. Closes #9'),
    { strong: [177], mentioned: [9] },
  );
  check(
    'a sub-heading under What that starts with an item delivers it',
    refs(
      '## What\n### #250 part 1: signatures\n- **Parts 2–4 stay open on #250.**\n### #202: spec studio\n## Known and left\n### #263 later\n- #263 roster',
    ),
    { strong: [202, 250], mentioned: [263] },
  );
  check(
    'a top-level heading that is not a delivery section does not deliver',
    refs('## Why\n### #9: because'),
    { strong: [], mentioned: [9] },
  );
  check('an instruction to update the umbrella is context', refs('- after the merge, update #184.'), {
    strong: [],
    mentioned: [184],
  });
  check('Closes, Fixes and lists of numbers deliver', refs('Closes #5, #6 and #7. Fixes: #8'), {
    strong: [5, 6, 7, 8],
    mentioned: [],
  });
  check('a merge request or a code block is no item', refs('See !12 and &3.\n```\n#99\n```'), {
    strong: [],
    mentioned: [],
  });

  const relItem = (iid, state, labels = ['release-0.3.0'], title = `item ${iid}`) => ({
    iid,
    state,
    labels,
    title,
  });
  const relItems = new Map(
    [
      relItem(1, 'closed'),
      relItem(2, 'closed'),
      relItem(3, 'open'),
      relItem(4, 'closed'),
      relItem(5, 'closed', []),
    ].map((i) => [i.iid, i]),
  );
  const relMrs = [
    { iid: 10, title: 'feat: one', sourceBranch: 'feat/1-one', description: 'See #4 for context.' },
    { iid: 11, title: 'feat: batch', sourceBranch: 'feat/batch-a', description: '| #2 | x |\n| #3 | y |' },
    { iid: 12, title: 'docs: notes', sourceBranch: 'docs/notes', description: 'Notes.' },
    { iid: 13, title: 'fix: gone', sourceBranch: 'fix/404-gone', description: '' },
  ];
  const sel = selectItems({ mergeRequests: relMrs, items: relItems, releaseLabel: 'release-0.3.0' });
  check('included are the delivered items, each with its merge requests', sel.included, [
    { iid: 1, mrs: [10] },
    { iid: 2, mrs: [11] },
    { iid: 3, mrs: [11] },
  ]);
  check('an included open item is the refusal', sel.open, [3]);
  check('a number that is no item is reported, not included', sel.unknown, [404]);
  check('a mention is shown for review, not included', sel.mentioned, [{ iid: 4, mrs: [10] }]);
  check('a closed item of the release outside the range is reported', sel.leftBehind, [4]);
  check('a merge request naming no item is reported', sel.noItem, [12]);
  const hand = selectItems({
    mergeRequests: relMrs,
    items: relItems,
    releaseLabel: null,
    include: [4],
    exclude: [3],
  });
  check(
    '--include and --exclude override the detection',
    [hand.included.map((i) => i.iid), hand.open],
    [[1, 2, 4], []],
  );
  check('with no release label nothing is left behind', hand.leftBehind, []);

  check(
    'configuration keys: added, removed, changed, commented-out counts',
    configKeys(
      '--- a/.env.example\n+++ b/.env.example\n+NEW_KEY=a|b\n-OLD_KEY=1\n-PORT=8080\n+PORT=8081\n+# OPTIONAL_KEY=\n+  YAML_KEY: "x"\n context LINE=1',
    ),
    [
      { key: 'NEW_KEY', change: 'ADD' },
      { key: 'OLD_KEY', change: 'REMOVE' },
      { key: 'OPTIONAL_KEY', change: 'ADD' },
      { key: 'PORT', change: 'CHANGE' },
      { key: 'YAML_KEY', change: 'ADD' },
    ],
  );
  check(
    'the version bump touches the first version only and keeps the formatting',
    bumpVersion(
      '{\n  "name": "x",\n  "version": "0.2.0",\n  "dependencies": { "y": { "version": "1" } }\n}\n',
      '0.3.0',
    ),
    '{\n  "name": "x",\n  "version": "0.3.0",\n  "dependencies": { "y": { "version": "1" } }\n}\n',
  );
  const defaults = releaseSettings({});
  const own = releaseSettings({
    factoryKit: { release: { configPaths: ['deploy', '.env.example'], migrations: '^db/\\d+\\.sql$' } },
  });
  check(
    "a project's release settings, defaulted and its own",
    [
      defaults.configPaths,
      ['apps/api/drizzle/0050_x.sql', 'migrations/1.sql', 'docs/x.sql'].map((f) =>
        defaults.migrations.test(f),
      ),
      own.configPaths,
      ['db/0001.sql', 'migrations/1.sql'].map((f) => own.migrations.test(f)),
    ],
    [['.env.example'], [true, true, false], ['deploy', '.env.example'], [true, false]],
  );

  const bang = (n) => `!${n}`;
  const notes = renderNotes({
    label: 'release-0.3.0',
    name: 'Release 0.3.0',
    from: 'release-0.3.x',
    head: 'abcdef1234',
    base: '1234567abc',
    date: '2026-10-01',
    items: new Map([
      ...relItems,
      [9, { iid: 9, state: 'closed', title: 'secret thing', confidential: true }],
    ]),
    included: [
      { iid: 1, mrs: [10] },
      { iid: 9, mrs: [] },
    ],
    mergeRequests: relMrs,
    noItem: [12],
    outside: ['acadca4 docs: a direct commit'],
    config: [{ key: 'NEW_KEY', change: 'ADD' }],
    configFiles: { '.env.example': 'NEW_KEY=\n' },
    migrations: ['0050_x.sql'],
    isConfidential: (i) => i?.confidential === true,
    mrRef: bang,
  });
  check('the notes carry the machine block finalize reads', readMeta(notes), {
    label: 'release-0.3.0',
    from: 'release-0.3.x',
    head: 'abcdef1234',
    items: [1, 9],
  });
  check(
    'the notes have every section, a confidential item by number only, and the gaps marked',
    [
      /^# Release 0\.3\.0$/m.test(notes),
      notes.includes('## Notices'),
      notes.includes('| `NEW_KEY` | [ADD] |'),
      notes.includes('`0050_x.sql`'),
      notes.includes('<summary><code>.env.example</code></summary>'),
      notes.includes('- **#1** item 1 (!10)'),
      notes.includes('- **#9** (confidential) (included by hand)'),
      notes.includes('secret thing'),
      notes.includes('- !12 docs: notes'),
      notes.includes('`acadca4 docs: a direct commit`'),
      notes.split(FILL_IN).length - 1,
    ],
    [true, true, true, true, true, true, true, false, true, true, 2],
  );
  check('what is published has no machine block', publishable(notes).startsWith('# Release 0.3.0'), true);
  check(
    'a pull request is named the GitHub way in the notes',
    renderNotes({
      label: 'release-0.3.0',
      name: 'R',
      from: 'f',
      head: 'abcdef1',
      base: '1234567',
      date: 'd',
      items: relItems,
      included: [{ iid: 1, mrs: [10] }],
      mergeRequests: relMrs,
      noItem: [],
      outside: [],
      config: [],
      migrations: [],
      isConfidential: () => false,
      mrRef: (n) => `#${n}`,
    }).includes('- **#1** item 1 (#10)'),
    true,
  );

  // Titles come from outside: none may turn into markdown, hide the page or trip finalize's refusal.
  const hostileNotes = renderNotes({
    label: 'release-0.3.0',
    name: 'Release 0.3.0',
    from: 'release-0.3.x',
    head: 'abcdef1234',
    base: '1234567abc',
    date: '2026-10-01',
    items: new Map([
      [21, { iid: 21, state: 'closed', title: '[Upgrade instructions](https://evil.example) now' }],
      [22, { iid: 22, state: 'closed', title: 'tail <!-- hides the rest' }],
      [23, { iid: 23, state: 'closed', title: '<!-- FILL IN x -->' }],
      [24, { iid: 24, state: 'closed', title: '*bold* and _it_ `code`' }],
    ]),
    included: [21, 22, 23, 24].map((iid) => ({ iid, mrs: [] })),
    mergeRequests: [{ iid: 30, title: 'see [x](https://e) <!--' }],
    noItem: [30],
    outside: ['abc1234 fix: a `tick` and <!-- FILL IN'],
    config: [],
    migrations: [],
    isConfidential: () => false,
    mrRef: bang,
  });
  check(
    'a hostile title is escaped in every list of the notes',
    hostileNotes.split('\n').filter((l) => /^- /.test(l)),
    [
      '- **#21** \\[Upgrade instructions\\]\\(https://evil.example\\) now (included by hand)',
      '- **#22** tail &lt;!-- hides the rest (included by hand)',
      '- **#23** &lt;!-- FILL IN x --&gt; (included by hand)',
      '- **#24** \\*bold\\* and \\_it\\_ \\`code\\` (included by hand)',
      '- !30 see \\[x\\]\\(https://e\\) &lt;!--',
      '- `abc1234 fix: a tick and !-- FILL IN`',
    ],
  );
  check(
    'hostile titles add no comment opener: the meta line and the one Notices marker are all there is',
    [hostileNotes.split('<!--').length - 1, hostileNotes.split(FILL_IN).length - 1],
    [2, 1],
  );
  check(
    'a title with a comment opener is named for the warning',
    hostileTitles(
      new Map([
        [1, { iid: 1, title: 'fine' }],
        [2, { iid: 2, title: 'x <!--' }],
      ]),
    ),
    [2],
  );
  check(
    'mdText leaves item and merge request references for the tracker to link',
    mdText('Follow-up to #263 and !191: use <x-dialog>'),
    'Follow-up to #263 and !191: use &lt;x-dialog&gt;',
  );
  check(
    'mdText collapses lines and caps the length',
    [mdText('a\n  b'), mdText('x'.repeat(300)).length],
    ['a b', 200],
  );
  check(
    "the what's-new draft drops what could open a link, and keeps a confidential item out",
    renderWhatsNewDraft({
      version: '0.3.0',
      items: new Map([
        [1, { iid: 1, title: 'See [this](https://e) **now** <!--' }],
        [2, { iid: 2, title: 'secret', confidential: true }],
      ]),
      included: [
        { iid: 1, mrs: [] },
        { iid: 2, mrs: [] },
      ],
      mergeRequests: [],
      isConfidential: (i) => i?.confidential === true,
    })
      .split('\n')
      .filter((l) => l.startsWith('- ')),
    [`- See this(https://e) now !-- ${FILL_IN}: rewrite for the people who use it, or delete the line -->`],
  );

  // ---- the what's-new deck ----------------------------------------------------------------------------------
  check(
    'the deck reads title, intro, slides and columns, and drops comments and emptied items',
    parseDeck(
      "# What's new\n\nA short release.\n<!-- a note -->\n\n## Search\n\n- finds more\n  across lines\n- <!-- deleted -->\n\n## Two\n\n### Left\n\nText\n\n## Empty\n\n- <!-- gone -->\n",
    ),
    {
      title: "What's new",
      quiet: false,
      intro: [{ p: 'A short release.' }],
      slides: [
        { heading: 'Search', spotlight: [], blocks: [{ ul: ['finds more across lines'] }] },
        { heading: 'Two', spotlight: [], blocks: [{ h3: 'Left' }, { p: 'Text' }] },
      ],
    },
  );

  // The three audience markers (docs/adr/0003-release-hooks-and-deck-markers.md). The expected
  // structures are what Makers Market's own parser (its scripts/whats-new.mjs, which its app's parser is
  // held to) returns for this same fixture, so the kit and that project read one file the same way.
  const marked = [
    "# What's new in 1.2.0",
    '',
    'A short release. <!-- quiet -->',
    '',
    '## Search <!-- spotlight: search, filters -->',
    '',
    '- finds more',
    '- the reindex job ADMINLINE <!-- admin -->',
    '',
    '## Settings',
    '<!-- admin -->',
    '',
    '- ADMINSLIDE a new key',
    '',
    '## Uploads',
    '',
    '<!-- spotlight: upload -->',
    'Drop a file.',
    '',
  ].join('\n');
  const search = (ul) => ({ heading: 'Search', spotlight: ['search', 'filters'], blocks: [{ ul }] });
  const uploads = { heading: 'Uploads', spotlight: ['upload'], blocks: [{ p: 'Drop a file.' }] };
  check(
    'markers: everybody gets no admin slide or line; spotlight and quiet read as Makers Market reads them',
    parseDeck(marked),
    {
      title: "What's new in 1.2.0",
      quiet: true,
      intro: [{ p: 'A short release.' }],
      slides: [search(['finds more']), uploads],
    },
  );
  check(
    'markers: administrators get the admin slide and line, in place',
    parseDeck(marked, { admin: true }),
    {
      title: "What's new in 1.2.0",
      quiet: true,
      intro: [{ p: 'A short release.' }],
      slides: [
        search(['finds more', 'the reindex job ADMINLINE']),
        { heading: 'Settings', spotlight: [], blocks: [{ ul: ['ADMINSLIDE a new key'] }] },
        uploads,
      ],
    },
  );
  const markedHtml = renderDeck({ markdown: marked, version: '1.2.0', date: '2026-10-05' });
  check(
    'the slides on the release carry no admin text and no marker',
    [
      markedHtml.includes('ADMIN'),
      markedHtml.includes('Settings'),
      markedHtml.includes('spotlight'),
      (markedHtml.match(/<section class="slide/g) ?? []).length,
    ],
    [false, false, false, 4],
  );
  check(
    'withoutAdmin cuts the admin slide and line from the Markdown and changes nothing else',
    withoutAdmin(marked),
    "# What's new in 1.2.0\n\nA short release. <!-- quiet -->\n\n## Search <!-- spotlight: search, filters -->\n\n- finds more\n\n## Uploads\n\n<!-- spotlight: upload -->\nDrop a file.\n",
  );
  const cut = (md) => {
    try {
      return withoutAdmin(md);
    } catch (e) {
      return `refused: ${e.message}`;
    }
  };
  check(
    "withoutAdmin follows parseDeck's rule exactly: a marker in a fence counts, and nothing admin survives",
    [
      cut('# T\n\n## S\n\n```\n- secret <!-- admin -->\n```\n\n- public'),
      cut('# T\n\n## S\n\n```\n\n- secret <!-- admin -->\n\n```\n\n- public\n'),
      cut('# T\n\n```\n## Secret <!-- admin -->\n```\n\n- x\n'),
      cut('# T\n\n## S\n\nSecret text <!-- admin -->\n'),
      cut('# T\n\n## S\n\n- a\n- secret <!-- admin -->\n- c\n'),
    ],
    [
      "refused: whats-new: the administrators' content could not be cut out without changing what everybody else sees; put a blank line between an admin list item and a paragraph next to it",
      '# T\n\n## S\n\n```\n\n\n```\n\n- public\n',
      '# T\n\n```',
      'refused: whats-new: an admin marker on "Secret text" means nothing there',
      '# T\n\n## S\n\n- a\n- c\n',
    ],
  );
  const refused = (f) => {
    try {
      f();
      return false;
    } catch {
      return true;
    }
  };
  const mistakes = [
    '# T\n\n## A\n\n- x <!-- admin only -->',
    '# T\n\n## A\n\n- x <!-- admins -->',
    '# T\n\n## A\n\n- x <!-- admin: true -->',
    '# T\n\n## A <!-- spotlite: search -->\n\n- x',
    '# T\n\n## A\n\npara <!-- admin -->',
    '# T\n\n## A\n\n### C <!-- admin -->\n- x',
    '# T\n\n## A\n\n- x <!-- a note -->',
  ];
  check(
    'a misspelt marker, or an admin marker where it means nothing, is refused; an ordinary comment is not',
    [
      mistakes.map((f) => refused(() => parseDeck(f))),
      mistakes.map((f) => refused(() => renderDeck({ markdown: f, version: '1.0.0', date: '2026-10-05' }))),
      mistakes.map((f) => refused(() => withoutAdmin(f))),
    ],
    [
      [true, true, true, true, true, true, false],
      [true, true, true, true, true, true, false],
      [true, true, true, true, true, true, false],
    ],
  );
  check(
    'inline Markdown is escaped, and only an https link survives',
    [inline('**a** <b> `<x>` [ok](https://e.example) [no](javascript:alert(1)) [no](http://e)')],
    [
      '<strong>a</strong> &lt;b&gt; <code>&lt;x&gt;</code> <a href="https://e.example">ok</a> [no](javascript:alert(1)) [no](http://e)',
    ],
  );
  const html = renderDeck({ markdown: '# T $&\n\n## S\n\n- one\n', version: '1.2.0', date: '2026-10-05' });
  check(
    'the deck is one file: its slots filled, a $& kept as text, and the date written out',
    [
      html.includes('{{'),
      html.includes('<h1>T $&amp;</h1>'),
      html.includes('1.2.0 · 5 October 2026'),
      (html.match(/<section class="slide/g) ?? []).length,
    ],
    [false, true, true, 3],
  );

  failed += await releaseHooksSelftest(check);

  // The GitLab-to-GitHub migration and its link rewrite (docs/agents/migrating-a-board.md), each in a file of
  // its own; they count their own failed cases.
  console.log('\n— the board migration, scripts/board/migrate-selftest.mjs —');
  failed += await (await import('./migrate-selftest.mjs')).migrateSelftest();
  console.log('\n— the link rewrite, scripts/board/links-selftest.mjs —');
  failed += await (await import('./links-selftest.mjs')).linksSelftest();
  console.log('\n— the batch create, scripts/board/batch-selftest.mjs —');
  failed += await (await import('./batch-selftest.mjs')).batchSelftest();

  console.log(
    failed ? `\nSELFTEST FAILED — ${failed} case(s)` : '\nSELFTEST OK — the state machine behaves.',
  );
  return failed ? 1 : 0;
}

/**
 * Items the bot opened itself (#39). On a seeded board the bot authors the item AND its plan, and a person
 * who never opened it answers the [REVIEW] points. The state machine never reads who opened an item, and
 * these cases pin that, through each adapter against a fake API that keeps the items, their comments and
 * their links: the item is made with `create`, the plan posted with `comment`, the identity read with
 * `whoami`, exactly as `pnpm items` does it.
 */
async function botOpenedSelftest(check, { glEnv, ghEnv, keyDir, glIssue, ghIssue }) {
  const PO = { id: 99, login: 'po' };
  const GL_BOT = { id: 7, login: 'project_1_bot' };
  const GH_BOT = { id: 41, login: 'board[bot]' };
  const PLAN = '## Remediation plan — seeded\n\n**[REVIEW 1]** which way?';
  const CLOSING = '## Review coverage — round 1\n\nEvery point answered.';
  // #36's batch marker and a `Relates-to` line, as a batch-created body carries them.
  const seeded =
    'Seeded from the inventory.\n\n<!-- factory-kit-batch: modernize-2026/auth -->\nRelates-to: #51';
  const fresh = new Date().toISOString(); // `analysing` goes stale on an old item
  const REPLIED = '2026-11-10T09:00:00Z';
  const iidIn = (u) => Number(u.match(/\/issues\/(\d+)/)[1]);
  const route = (method, re) => (m, u) => m === method && re.test(u);
  /** What `fn` returned, and what was written to stderr while it ran. */
  const stderrOf = async (fn) => {
    const lines = [];
    const real = console.error;
    console.error = (...a) => lines.push(a.join(' '));
    try {
      return [await fn(), lines];
    } finally {
      console.error = real;
    }
  };

  /**
   * The part both fakes share: issues numbered from 50, each with its comment thread. `author` turns
   * `{ id, login }` into the provider's author shape; `as` is the identity the token posts as.
   */
  const threads = (author, as) => {
    const issues = new Map();
    const thread = new Map();
    const add = (n, who, body, at = fresh) =>
      thread
        .get(n)
        .push({ id: thread.get(n).length + 1, system: false, ...author(who), body, created_at: at });
    return {
      issues,
      open: (raw) => {
        const n = 50 + issues.size;
        issues.set(n, raw(n));
        thread.set(n, []);
        return { status: 201, json: issues.get(n) };
      },
      list: (u) => ({ json: thread.get(iidIn(u)) }),
      post: (u, init) => {
        add(iidIn(u), as, JSON.parse(init.body).body);
        return { status: 201, json: { id: thread.get(iidIn(u)).length } };
      },
      reply: (n) => add(n, PO, '1. this way', REPLIED),
    };
  };

  // A fake GitLab whose token is `as`. `bot` is what `/user` says of it; null makes the lookup fail.
  const gitlabBoard = (as, bot) => {
    const t = threads((p) => ({ author: { id: p.id, username: p.login } }), as);
    const links = new Map();
    const user = bot == null ? { status: 500, json: {} } : { json: { id: as.id, username: as.login, bot } };
    const fake = fakeFetch([
      [route('GET', /\/api\/v4\/user$/), user],
      [
        route('POST', /\/issues$/),
        (_u, init) => {
          const { title, description } = JSON.parse(init.body);
          return t.open((iid) => {
            links.set(iid, []);
            return { ...glIssue, iid, title, description, labels: [], updated_at: fresh };
          });
        },
      ],
      [route('GET', /\/notes\?/), t.list],
      [route('POST', /\/notes$/), t.post],
      [
        route('POST', /\/links$/),
        (u, init) => {
          const [a, b] = [iidIn(u), Number(JSON.parse(init.body).target_issue_iid)];
          links.get(a).push({ iid: b });
          links.get(b).push({ iid: a }); // GitLab shows a link from both sides
          return { status: 201, json: {} };
        },
      ],
      [route('GET', /\/links$/), (u) => ({ json: links.get(iidIn(u)) })],
    ]);
    return { board: createGitlab(glEnv, '/nonexistent', { fetch: fake.impl }), reply: t.reply, bot: as };
  };

  // A fake GitHub App whose bot is GH_BOT; `appUp` false makes the `/app` lookup fail.
  const githubBoard = (appUp = true) => {
    const t = threads((p) => ({ user: p }), GH_BOT);
    const fake = fakeFetch([
      [route('POST', /\/access_tokens$/), { json: { token: 'tok-board' } }],
      [route('GET', /\/app$/), appUp ? { json: { slug: 'board' } } : { status: 500, json: {} }],
      [route('GET', /\/users\/board%5Bbot%5D$/), { json: GH_BOT }],
      [
        route('POST', /\/issues$/),
        (_u, init) => {
          const { title, body } = JSON.parse(init.body);
          return t.open((number) => ({ ...ghIssue, number, title, body, labels: [], updated_at: fresh }));
        },
      ],
      [route('GET', /\/issues\?state=open/), () => ({ json: [...t.issues.values()] })],
      [route('GET', /\/comments\?/), t.list],
      [route('POST', /\/comments$/), t.post],
      [route('GET', /\/issues\/\d+$/), (u) => ({ json: t.issues.get(iidIn(u)) })],
    ]);
    const board = createGithub({ ...ghEnv, GITHUB_APP_INSTALLATION_ID: '77' }, keyDir, { fetch: fake.impl });
    return { board, reply: t.reply, bot: GH_BOT };
  };

  const create = (board, description = seeded) => board.create({ title: 'Seeded: auth', description });
  const stateOf = async (board, it, labels, me) =>
    classify({ ...it, labels }, await board.comments(it.iid), me);

  // new → analysing → plan-posted → answered → ready, on an item the bot opened, for each provider.
  for (const [name, { board, reply, bot }] of [
    ['GitLab', gitlabBoard(GL_BOT, true)],
    ['GitHub', githubBoard()],
  ]) {
    const it = await create(board);
    const [me, warned] = await stderrOf(() => board.whoami());
    const state = async (labels) => (await stateOf(board, it, labels, me)).state;
    check(`${name}: the bot is the token's own user, and nothing is warned`, [me, warned], [bot.id, []]);
    check(`${name}: bot-opened, no comments → new`, await state([]), 'new');
    check(`${name}: bot-opened, ai:analysing → analysing`, await state(['ai:analysing']), 'analysing');
    await board.comment(it.iid, PLAN);
    check(
      `${name}: bot-opened, plus the bot's plan → plan-posted, awaiting a reply rather than "the reporter"`,
      await stateOf(board, it, ['ai:plan-posted'], me),
      { rounds: 0, state: 'plan-posted', why: 'plan is on the item, awaiting a reply' },
    );
    reply(it.iid);
    check(
      `${name}: bot-opened, plus a person's reply → answered`,
      await stateOf(board, it, ['ai:plan-posted'], me),
      { rounds: 0, state: 'answered', why: 'po replied on 2026-11-10, coverage not assessed' },
    );
    await board.comment(it.iid, CLOSING);
    check(`${name}: bot-opened, plus the closing round → ready`, await state(['ai:ready']), 'ready');

    const early = await create(board, 'Seeded.');
    reply(early.iid);
    check(
      `${name}: a person's comment before any plan leaves a bot-opened item new, and is a reply`,
      [
        (await stateOf(board, early, [], me)).state,
        (await board.comments(early.iid)).map((n) => commentKind(n, me)),
      ],
      ['new', ['reply']],
    );
  }

  // A personal GitLab token: the person is "us", so their own reply reads as our follow-up. Warned about
  // once, on stderr, and the run carries on.
  {
    const { board, reply } = gitlabBoard(PO, false);
    const it = await create(board);
    const [me, warned] = await stderrOf(() => board.whoami());
    await board.comment(it.iid, PLAN);
    reply(it.iid);
    check(
      'GitLab: a personal token is warned about once, and its owner never shows as having answered',
      [me, (await stateOf(board, it, ['ai:plan-posted'], me)).state, warned],
      [
        PO.id,
        'plan-posted',
        ['GITLAB_TOKEN belongs to po, a person: their own replies will read as ours (ADR 0002)'],
      ],
    );
  }

  // A failed identity lookup: only the plan and coverage markers count as ours, so any other bot note reads
  // as a reply. A known limit (docs/agents/issue-tracker.md), pinned so that a change to it is deliberate.
  for (const [name, { board }] of [
    ['GitLab', gitlabBoard(GL_BOT, null)],
    ['GitHub', githubBoard(false)],
  ]) {
    const it = await create(board);
    const me = await board.whoami();
    await board.comment(it.iid, PLAN);
    await board.comment(it.iid, '## Implementation started\n\nOn the branch `feat/auth`.');
    check(
      `${name}: with no identity, an ordinary bot note after the plan reads as a reply (known limit)`,
      [me, (await stateOf(board, it, ['ai:plan-posted'], me)).state],
      [null, 'answered'],
    );
  }

  // Links the bot made, and the sibling hold on them. GitLab links the pair through its API; on GitHub the
  // link is the `Relates-to: #51` line in the first item's batch-created body, read from both sides.
  for (const [name, { board }] of [
    ['GitLab', gitlabBoard(GL_BOT, true)],
    ['GitHub', githubBoard()],
  ]) {
    const opened = await create(board);
    const sibling = await create(board, 'Seeded: the other half.');
    if (board.name === 'gitlab') await board.link(opened.iid, sibling.iid);
    const me = await board.whoami();
    check(
      `${name}: a bot-made link is read from both sides`,
      [await board.links(opened.iid), await board.links(sibling.iid)],
      [[{ iid: sibling.iid }], [{ iid: opened.iid }]],
    );
    const held = async (labels) => {
      const { state } = await stateOf(board, sibling, labels, me);
      return blockingSiblings([{ iid: sibling.iid, state, closed: false }]).map((s) => s.iid);
    };
    await board.comment(sibling.iid, PLAN);
    check(`${name}: a plan-posted sibling holds a bot-opened item`, await held(['ai:plan-posted']), [
      sibling.iid,
    ]);
    await board.comment(sibling.iid, CLOSING);
    check(`${name}: a ready sibling does not`, await held(['ai:ready']), []);
  }

  // A seeded body's tables: a header row is not a field.
  check(
    'fieldFrom skips a table header row, and still reads a field row',
    [
      fieldFrom('| Category | Count |\n|---|---|\n| bug | 3 |', 'Category'),
      fieldFrom('| Screen | Status |\n| :--- | ---: |\n| home | done |', 'Screen'),
      fieldFrom('| Field | Value |\n|---|---|\n| Category | bug |', 'Category'),
      fieldFrom('| Kind | Count |\n| --- |\n| x | 1 |', 'Kind'),
    ],
    ['', '', 'bug', ''],
  );
  // A `---` rule or a bare `-` right under the last field row is not a delimiter row: the field still reads.
  check(
    'fieldFrom reads a field row that sits above a thematic break or a bare dash',
    [
      fieldFrom('| Field | Value |\n|---|---|\n| Category | bug |\n---\nmore', 'Category'),
      fieldFrom('| Field | Value |\n|---|---|\n| Build | 1.4.2 |\n-\nmore', 'Build'),
      fieldFrom('| Field | Value |\n|---|---|\n| Screen | checkout |\n - - -', 'Screen'),
      fieldFrom('| Field | Value |\n|---|---|\n| Screen | home |\n|', 'Screen'),
    ],
    ['bug', '1.4.2', 'checkout', 'home'],
  );
}

/**
 * The release hooks and `requireWhatsNew` (docs/adr/0003-release-hooks-and-deck-markers.md), driven through
 * `cmdRelease` against a real git repository with a bare origin, and a fake board. Returns 1 when the run
 * itself broke, which no `check` has counted.
 */
async function releaseHooksSelftest(check) {
  // `check` counts its own failures; this counts only a run that could not finish.
  let failed = 0;
  const ok = check;
  // A hook (pre-push) may export GIT_DIR and friends; the scratch repository must not inherit them.
  const saved = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('GIT_')));
  for (const k of Object.keys(saved)) delete process.env[k];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-selftest-'));
  const out = [];
  const realLog = console.log;
  const realError = console.error;
  const quiet = () => {
    out.length = 0;
    console.log = (...a) => out.push(a.join(' '));
    console.error = (...a) => out.push(a.join(' '));
  };
  const loud = () => {
    console.log = realLog;
    console.error = realError;
  };
  try {
    // ---- the settings, the loader and the flags ----------------------------------------------------------
    const plain = releaseSettings({});
    const set = releaseSettings({ factoryKit: { release: { requireWhatsNew: true, hooks: 'x/h.mjs' } } });
    ok(
      'release settings: no what-new requirement and no hooks by default; a project sets both',
      [plain.requireWhatsNew, plain.hooks, set.requireWhatsNew, set.hooks],
      [false, null, true, 'x/h.mjs'],
    );
    const write = (name, text) => {
      fs.mkdirSync(path.dirname(path.join(tmp, name)), { recursive: true });
      fs.writeFileSync(path.join(tmp, name), text);
    };
    const loadError = async (hooks) => {
      try {
        await loadReleaseHooks(tmp, { hooks });
        return null;
      } catch (e) {
        return e.message;
      }
    };
    write('typo.mjs', 'export const afterFinalise = () => {};\n');
    write('notfn.mjs', 'export const notes = ["x"];\n');
    write('badflags.mjs', "export const flags = ['Listing=x'];\n");
    write('default.mjs', 'export default { afterFinalize() {} };\n');
    ok(
      'release hooks: none named loads nothing; a named module that is missing, misspelt or malformed is refused',
      [
        await loadReleaseHooks(tmp, { hooks: null }),
        await loadError('nowhere.mjs'),
        await loadError('typo.mjs'),
        await loadError('notfn.mjs'),
        await loadError('badflags.mjs'),
        await loadError('default.mjs'),
      ],
      [
        null,
        'package.json names nowhere.mjs as the release hooks, and there is no such file',
        'typo.mjs exports afterFinalise; release hooks are flags, notes, checklist, beforeFinalize, afterFinalize',
        'notfn.mjs: notes is not a function',
        "badflags.mjs: flags is a list of option names, such as ['listing']",
        'default.mjs exports default; release hooks are flags, notes, checklist, beforeFinalize, afterFinalize',
      ],
    );
    const hooksAt = async (pkg, sub) => {
      const dir = fs.mkdtempSync(path.join(tmp, 'pkg-'));
      if (pkg != null) fs.writeFileSync(path.join(dir, 'package.json'), pkg);
      fs.writeFileSync(path.join(dir, 'h.mjs'), "export const flags = ['listing'];\n");
      try {
        const h = await checkoutHooks(dir, sub);
        return h ? h.flags : null;
      } catch (e) {
        return `refused: ${e.message}`;
      }
    };
    const named = JSON.stringify({ factoryKit: { release: { hooks: 'h.mjs' } } });
    ok(
      'checkout hooks: read for prepare and finalize only; no package.json is no hooks, a broken one refused',
      [
        await hooksAt(named, 'prepare'),
        await hooksAt(named, 'finalize'),
        await hooksAt(named, 'deck'),
        await hooksAt('{ not json', 'deck'),
        await hooksAt(null, 'finalize'),
        await hooksAt('{}', 'finalize'),
        (await hooksAt('{ not json', 'finalize')).startsWith('refused: package.json does not parse ('),
      ],
      [['listing'], ['listing'], null, null, null, null, true],
    );
    ok(
      "hook flags: only the hook's own names, a value or a bare true",
      hookFlags(['listing', 'dry'], ['finalize', '--listing=makers-market', '--dry', '--apply', '--other=1']),
      { listing: 'makers-market', dry: true },
    );

    ok(
      'a finalize hook succeeds only with { ok: true }; any other return is a failure that names it',
      [
        { ok: true },
        { ok: true, message: 'done' },
        { ok: false, message: 'no token' },
        { ok: false },
        undefined,
        { success: true },
        'ok',
      ].map(hookVerdict),
      [
        { ok: true, message: null },
        { ok: true, message: 'done' },
        { ok: false, message: 'no token' },
        { ok: false, message: 'no reason given' },
        { ok: false, message: 'it returned undefined, not { ok: true } or { ok: false, message }' },
        { ok: false, message: 'it returned {"success":true}, not { ok: true } or { ok: false, message }' },
        { ok: false, message: 'it returned "ok", not { ok: true } or { ok: false, message }' },
      ],
    );

    // ---- pure: no hook, no change ----------------------------------------------------------------------
    const survey = {
      label: 'release-1.0.0',
      version: '1.0.0',
      name: 'Release 1.0.0',
      from: 'release-1.0.x',
      head: 'abcdef1234',
      base: '1234567abc',
      target: 'main',
      date: '2026-10-12',
      items: new Map([[7, { iid: 7, state: 'closed', title: 'A thing' }]]),
      included: [{ iid: 7, mrs: [12] }],
      mergeRequests: [{ iid: 12, title: 'feat: thing', sourceBranch: 'feat/7-thing' }],
      noItem: [],
      outside: [],
      config: [],
      migrations: [],
      isConfidential: () => false,
      mrRef: (n) => `!${n}`,
    };
    const descr = (checklist) =>
      releaseDescription({
        ...survey,
        notesPath: 'docs/releases/1.0.0.md',
        whatsNewFile: 'docs/releases/1.0.0.whats-new.md',
        checklist,
      });
    ok(
      'no hook output leaves the notes and the merge request exactly as they were',
      [
        renderNotes({ ...survey, hookNotes: [] }) === renderNotes(survey),
        descr([]) === descr(undefined),
        renderNotes(survey).includes(
          '## Notices\n\n<!-- FILL IN: anything an administrator must know before deploying or after it, or "None." -->\n\n## Deploying',
        ),
      ],
      [true, true, true],
    );
    ok(
      "a hook's notes go after Notices as one block, and its checklist lines before CI",
      [
        renderNotes({ ...survey, hookNotes: ['## Data warning', '', 'Unchanged.', '', ''] }).includes(
          '"None." -->\n\n## Data warning\n\nUnchanged.\n\n## Deploying',
        ),
        descr(['The **Data warning** is settled.'])
          .split('\n')
          .filter((l) => l.startsWith('- [ ]'))
          .slice(2, 4),
      ],
      [true, ['- [ ] The **Data warning** is settled.', '- [ ] `pnpm ci:local` is green on this branch.']],
    );

    // ---- a real repository: prepare's hooks, finalize's refusal and its last step -----------------------
    const g = (cwd, ...args) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    g(tmp, 'init', '--quiet', '--bare', '-b', 'main', 'origin.git');
    g(tmp, 'clone', '--quiet', path.join(tmp, 'origin.git'), 'work');
    const W = path.join(tmp, 'work');
    fs.mkdirSync(path.join(tmp, 'nohooks'));
    for (const [k, v] of [
      ['user.name', 'Selftest'],
      ['user.email', 'selftest@example.invalid'],
      ['commit.gpgSign', 'false'],
      ['tag.gpgSign', 'false'],
      ['core.hooksPath', path.join(tmp, 'nohooks')],
    ])
      g(W, 'config', k, v);
    const put = (file, text) => {
      fs.mkdirSync(path.dirname(path.join(W, file)), { recursive: true });
      fs.writeFileSync(path.join(W, file), text);
      g(W, 'add', file);
    };
    put(
      'package.json',
      `${JSON.stringify({ name: 'p', version: '1.0.0', factoryKit: { release: { requireWhatsNew: true, hooks: 'release-hooks.mjs' } } }, null, 2)}\n`,
    );
    g(W, 'commit', '--quiet', '-m', 'chore: start');
    g(W, 'push', '--quiet', 'origin', 'main');
    g(W, 'switch', '--quiet', '-c', 'release-1.0.x');
    put('thing.txt', 'a thing\n');
    g(W, 'commit', '--quiet', '-m', 'feat: thing');
    g(W, 'push', '--quiet', 'origin', 'release-1.0.x');
    // The hook module is the checkout's, untracked here, and records every call it gets.
    const calls = [];
    globalThis.__releaseHookCalls = calls;
    fs.writeFileSync(
      path.join(W, 'release-hooks.mjs'),
      [
        "export const flags = ['listing'];",
        'const calls = globalThis.__releaseHookCalls;',
        'export function notes(s, { showAt, flags }) {',
        "  calls.push(['notes', s.label, s.version, s.from, s.included.map((i) => i.iid), JSON.parse(showAt(s.head, 'package.json')).version, showAt(s.head, 'missing.txt'), flags]);",
        "  return ['## Data warning', '', 'Unchanged since the last release.', ''];",
        '}',
        'export async function checklist(s, { flags }) {',
        "  calls.push(['checklist', s.label, flags]);",
        "  return ['The **Data warning** section is settled.'];",
        '}',
        'export async function beforeFinalize(c) {',
        "  calls.push(['beforeFinalize', Object.keys(c).sort(), c.label, c.version, c.sha.length, c.release, c.deck && { filename: c.deck.filename, url: c.deck.url, publicOnly: c.deck.html.includes('<section') && !c.deck.html.includes('ADMINONLY') }, c.whatsNew, c.flags, c.env('HUB_RELEASE_URL'), c.whatsNewRaw]);",
        "  if (c.flags.listing === 'nocreds') return { ok: false, message: 'HUB_RELEASE_TOKEN is not set' };",
        "  if (c.flags.listing === 'boom') throw new Error('the hook broke');",
        '  return { ok: true };',
        '}',
        'export async function afterFinalize(c) {',
        "  calls.push(['afterFinalize', Object.keys(c).sort(), c.label, c.version, c.sha.length, c.release.url, c.deck && { filename: c.deck.filename, url: c.deck.url, publicOnly: c.deck.html.includes('<section') && !c.deck.html.includes('ADMINONLY') }, c.whatsNew, c.flags, c.env('HUB_RELEASE_URL'), c.whatsNewRaw]);",
        "  if (c.flags.listing === 'down') throw new Error('the listing did not answer');",
        "  if (c.flags.listing === 'silent') return;",
        "  return { ok: true, message: 'published to ' + c.flags.listing };",
        '}',
        '',
      ].join('\n'),
    );
    const hooks = await loadReleaseHooks(
      W,
      releaseSettings({ factoryKit: { release: { hooks: 'release-hooks.mjs' } } }),
    );
    const fakeBoard = (mergeSha) => {
      const log = [];
      return {
        log,
        mrRef: (n) => `!${n}`,
        mrUnavailable: () => null,
        releaseCarriesMilestone: true,
        project: async () => ({ defaultBranch: 'main', squashAlways: false, mergeMethod: 'merge' }),
        mrRefs: async () => [12],
        getMr: async () => survey.mergeRequests[0] && { ...survey.mergeRequests[0], description: '' },
        listAll: async () => [{ iid: 7, state: 'closed', title: 'A thing', labels: [] }],
        findMrs: async ({ source }) =>
          source.startsWith('release/') ? [{ iid: 13, state: 'merged', mergeSha: mergeSha() }] : [],
        milestones: async () => [],
        saveRelease: async (r) => {
          log.push(['release', r.tag, r.description.includes("What's new (slides)")]);
          return { url: `https://example.invalid/releases/${r.tag}` };
        },
        attachToRelease: async (_tag, a) => {
          log.push(['attach', a.filename]);
          return { url: `https://example.invalid/${a.filename}`, replaced: false };
        },
        comments: async () => [],
        comment: async (iid) => log.push(['comment', iid]),
        closeMilestone: async () => 'none',
        openMr: async (m) => {
          log.push(['mr', m.source, m.target]);
          return { iid: 14, url: 'https://example.invalid/14' };
        },
      };
    };
    let mergeSha = '';
    const b = fakeBoard(() => mergeSha);
    const closed = [];
    const ctx = (flags, h = hooks) => ({
      b,
      ROOT: W,
      isConfidential: () => false,
      relabel: async () => {},
      close: async (iid) => closed.push(iid),
      hooks: h,
      flags,
      env: (k) => (k === 'HUB_RELEASE_URL' ? 'http://localhost:8080' : ''),
    });

    quiet();
    const prep = await cmdRelease(ctx({ listing: 'kit' }), 'prepare', 'release-1.0.0', {
      from: 'release-1.0.x',
      notes: true,
    });
    const prepOut = out.join('\n');
    loud();
    ok(
      'prepare: notes and checklist are each called once, with the survey, showAt and the flags',
      [prep, calls],
      [
        0,
        [
          ['notes', 'release-1.0.0', '1.0.0', 'release-1.0.x', [7], '1.0.0', null, { listing: 'kit' }],
          ['checklist', 'release-1.0.0', { listing: 'kit' }],
        ],
      ],
    );
    ok(
      "prepare: the hook's notes are in the draft, after Notices",
      prepOut.includes('"None." -->\n\n## Data warning\n\nUnchanged since the last release.\n\n## Deploying'),
      true,
    );
    calls.length = 0;
    quiet();
    await cmdRelease(ctx({}, null), 'prepare', 'release-1.0.0', { from: 'release-1.0.x', notes: true });
    const bare = out.join('\n');
    loud();
    ok(
      "prepare with no hooks: the draft is the kit's own, and no hook ran",
      [bare.includes('## Data warning'), bare.includes('"None." -->\n\n## Deploying'), calls.length],
      [false, true, 0],
    );

    // A release merged without a what's-new file, in a project that requires one.
    const release = (version, files) => {
      g(W, 'switch', '--quiet', '-c', `release/${version}`, 'release-1.0.x');
      const meta = { label: `release-${version}`, from: 'release-1.0.x', head: 'x', items: [7] };
      put(
        `docs/releases/${version}.md`,
        `<!-- release-meta ${JSON.stringify(meta)} -->\n# Release ${version}\n\nNone.\n`,
      );
      for (const [f, t] of Object.entries(files)) put(f, t);
      g(W, 'commit', '--quiet', '-m', `chore(release): ${version}`);
      g(W, 'switch', '--quiet', 'main');
      g(W, 'merge', '--quiet', '--no-ff', '-m', `Merge release/${version}`, `release/${version}`);
      g(W, 'push', '--quiet', 'origin', 'main');
      mergeSha = g(W, 'rev-parse', 'HEAD');
    };
    const tagged = (label) => {
      try {
        g(W, 'rev-parse', '--verify', '--quiet', `refs/tags/${label}`);
        return true;
      } catch {
        return false;
      }
    };
    release('1.0.0', {});
    calls.length = 0;
    quiet();
    const refused = await cmdRelease(ctx({ listing: 'kit' }), 'finalize', 'release-1.0.0', {});
    const refusal = out.join('\n');
    loud();
    ok(
      "finalize refuses a release with no what's-new file when the project requires one, before the tag",
      [refused, refusal.includes('--no-whats-new'), tagged('release-1.0.0'), b.log, calls],
      [1, true, false, [], []],
    );
    quiet();
    const decided = await cmdRelease(ctx({ listing: 'kit' }), 'finalize', 'release-1.0.0', {
      noWhatsNew: true,
    });
    const decidedOut = out.join('\n');
    loud();
    ok(
      '--no-whats-new: the release is cut with no slides, and before- and afterFinalize get the documented context',
      [decided, tagged('release-1.0.0'), b.log, closed, calls, decidedOut.includes('published to kit')],
      [
        0,
        true,
        [
          ['release', 'release-1.0.0', false],
          ['comment', 7],
          ['mr', 'main', 'release-1.0.x'],
        ],
        [7],
        [
          [
            'beforeFinalize',
            ['deck', 'env', 'flags', 'label', 'release', 'sha', 'version', 'whatsNew', 'whatsNewRaw'],
            'release-1.0.0',
            '1.0.0',
            40,
            null,
            null,
            null,
            { listing: 'kit' },
            'http://localhost:8080',
            null,
          ],
          [
            'afterFinalize',
            ['deck', 'env', 'flags', 'label', 'release', 'sha', 'version', 'whatsNew', 'whatsNewRaw'],
            'release-1.0.0',
            '1.0.0',
            40,
            'https://example.invalid/releases/release-1.0.0',
            null,
            null,
            { listing: 'kit' },
            'http://localhost:8080',
            null,
          ],
        ],
        true,
      ],
    );

    // A release with slides, whose last step fails.
    const whatsNew =
      '# New in 1.1.0\n\nBetter.\n\n## Search\n\n- finds more\n- reindex ADMINONLY <!-- admin -->\n';
    release('1.1.0', { 'docs/releases/1.1.0.whats-new.md': whatsNew });
    b.log.length = 0;
    closed.length = 0;
    calls.length = 0;
    quiet();
    const vetoed = await cmdRelease(ctx({ listing: 'nocreds' }), 'finalize', 'release-1.1.0', {});
    const vetoOut = out.join('\n');
    const vetoCalls = calls.map((c) => [c[0], c[5], c[6]]);
    const thrown = await cmdRelease(ctx({ listing: 'boom' }), 'finalize', 'release-1.1.0', {});
    const thrownOut = out.join('\n');
    loud();
    ok(
      'beforeFinalize refuses before the tag: nothing tagged, published or closed, and it is told why',
      [
        vetoed,
        tagged('release-1.1.0'),
        b.log,
        closed,
        vetoOut.includes(
          "✖ the project's beforeFinalize hook (release-hooks.mjs) refused: HUB_RELEASE_TOKEN is not set. Nothing was tagged, published or closed.",
        ),
        vetoCalls,
      ],
      [
        1,
        false,
        [],
        [],
        true,
        [['beforeFinalize', null, { filename: 'whats-new-1.1.0.html', url: null, publicOnly: true }]],
      ],
    );
    ok(
      'a beforeFinalize that throws is a refusal, with its message',
      [
        thrown,
        tagged('release-1.1.0'),
        b.log,
        closed,
        thrownOut.includes(
          "✖ the project's beforeFinalize hook (release-hooks.mjs) refused: the hook broke. Nothing was tagged, published or closed.",
        ),
        calls.map((c) => c[0]),
      ],
      [1, false, [], [], true, ['beforeFinalize', 'beforeFinalize']],
    );
    b.log.length = 0;
    closed.length = 0;
    calls.length = 0;
    quiet();
    const failedAfter = await cmdRelease(ctx({ listing: 'down' }), 'finalize', 'release-1.1.0', {});
    const failedOut = out.join('\n');
    loud();
    ok(
      'an afterFinalize failure is reported and exits 1, the release is complete, and the deck and whatsNew it gets have no admin line',
      [
        failedAfter,
        tagged('release-1.1.0'),
        b.log,
        closed,
        failedOut.includes(
          "✖ release-1.1.0 is released, but the project's afterFinalize hook (release-hooks.mjs) failed: the listing did not answer. Everything else is done; run finalize again to retry it.",
        ),
        calls.map((c) => [c[0], c[6], c[7], c[8], c[10]]),
        // beforeFinalize said ok, so the release went ahead.
      ],
      [
        1,
        true,
        [
          ['release', 'release-1.1.0', false],
          ['attach', 'whats-new-1.1.0.html'],
          ['release', 'release-1.1.0', true],
          ['comment', 7],
          ['mr', 'main', 'release-1.0.x'],
        ],
        [7],
        true,
        [
          [
            'beforeFinalize',
            { filename: 'whats-new-1.1.0.html', url: null, publicOnly: true },
            '# New in 1.1.0\n\nBetter.\n\n## Search\n\n- finds more',
            { listing: 'down' },
            whatsNew.trimEnd(),
          ],
          [
            'afterFinalize',
            {
              filename: 'whats-new-1.1.0.html',
              url: 'https://example.invalid/whats-new-1.1.0.html',
              publicOnly: true,
            },
            '# New in 1.1.0\n\nBetter.\n\n## Search\n\n- finds more',
            { listing: 'down' },
            whatsNew.trimEnd(),
          ],
        ],
      ],
    );

    // A misspelt marker stops finalize before the tag.
    release('1.2.0', { 'docs/releases/1.2.0.whats-new.md': '# T\n\n## A\n\n- x <!-- admins -->\n' });
    b.log.length = 0;
    quiet();
    const misspelt = await cmdRelease(ctx({}, null), 'finalize', 'release-1.2.0', {});
    loud();
    ok(
      'finalize refuses a misspelt deck marker before it tags anything',
      [misspelt, tagged('release-1.2.0'), b.log],
      [1, false, []],
    );

    // An afterFinalize that returns nothing has not said it succeeded.
    release('1.3.0', {});
    quiet();
    const silent = await cmdRelease(ctx({ listing: 'silent' }), 'finalize', 'release-1.3.0', {
      noWhatsNew: true,
    });
    const silentOut = out.join('\n');
    loud();
    ok(
      'an afterFinalize that returns nothing is a failure, named, with the release done',
      [
        silent,
        tagged('release-1.3.0'),
        silentOut.includes(
          'failed: it returned undefined, not { ok: true } or { ok: false, message }. Everything else is done',
        ),
      ],
      [1, true, true],
    );
  } catch (e) {
    loud();
    failed++;
    console.error(`✗ the release hook selftest could not run: ${e.stack ?? e}`);
  } finally {
    loud();
    delete globalThis.__releaseHookCalls;
    fs.rmSync(tmp, { recursive: true, force: true });
    Object.assign(process.env, saved);
  }
  return failed;
}

// Run directly (`node scripts/board/selftest.mjs`), the module used to define `selftest()`, print nothing
// and exit 0 — a green that checked nothing. `pnpm check:items` imports it instead, so this only fires
// for the direct form. `import.meta.main` would say the same, but needs a newer Node than the kit's 22.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await selftest();
}

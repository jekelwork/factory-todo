// Step 7's cases: the demo item's stages, and finding the item again rather than filing a second one.
// Discovered by selftest.mjs by its name; every case asserts the whole answer (AGENTS.md ground rule 6).

import {
  checkDemo,
  DEMO_BRANCH,
  DEMO_ITEM,
  DEMO_ITEM_EDIT,
  DEMO_LABEL,
  demoStages,
  fileDemo,
  PICKER_TRAP,
} from './demo.mjs';
import { fakeContext } from './fake.mjs';

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const json = (v) => ok(JSON.stringify(v));
const GH = { '.env.github': 'GITHUB_REPOSITORY=acme/shop\nGITHUB_APP_ID=123\n' };
const URL = 'https://github.com/acme/shop/issues/12';
const PR = 'https://github.com/acme/shop/pull/13';
const IDS = ['filed', 'planned', 'answered-board', 'answered-picker', 'go', 'pr', 'merged', 'closed'];
/** The full eight-entry answer, with exactly `done` ticked. */
const want = (...done) => IDS.map((id) => ({ id, done: done.includes(id) }));

const LIST = 'node scripts/work-items.mjs list --json';
const SHOW = 'node scripts/work-items.mjs show 12';
const STATUS = 'node scripts/work-items.mjs mr-status kit-demo/12 --json';
const MAIN = 'git show origin/main:CODEOWNERS';
const FETCH = 'git fetch origin';
const HEAD = 'git symbolic-ref --short refs/remotes/origin/HEAD';

const c = (kind, author, body) => ({ author, at: '2026-10-28T10:00:00Z', kind, body });
const PLAN = c('plan', 'board[bot]', '## Remediation plan — Add a CODEOWNERS file\n\n**[REVIEW 1]** …');
const REPLY = c('reply', 'lead', '1. Me, @lead, owns everything.');
const PICKED = c('ours', 'board[bot]', 'Answered in the session: 2. docs/ follows `*`.');
const show = ({ labels = [DEMO_LABEL], comments = [], closed = false } = {}) => ({
  iid: 12,
  title: 'Add a CODEOWNERS file',
  url: URL,
  labels,
  closed,
  comments,
});
const mr = (state, over = {}) => ({
  branch: 'kit-demo/12',
  mr: { iid: 13, url: PR, state, mergedBy: null, mergedByBot: false, ...over },
});
const none = { branch: 'kit-demo/12', mr: null };
const ANSWERED = [PLAN, REPLY, PICKED];

export default async function (check) {
  check('demo: the label and the branch', [DEMO_LABEL, DEMO_BRANCH(12)], ['kit-demo', 'kit-demo/12']);
  check(
    'demo: the item asks for the marker line, the branch, and two decisions',
    [
      DEMO_ITEM.split('\n')[0],
      DEMO_ITEM.includes('# Factory Kit worked example: #<this item’s number>'),
      DEMO_ITEM.includes('kit-demo/<this item’s number>'),
      (DEMO_ITEM.match(/^\d\. /gm) ?? []).length,
    ],
    ['Add a CODEOWNERS file', true, true, 2],
  );

  // ---- stages ---------------------------------------------------------------------------------------------
  check('stages: just filed', demoStages(show(), none), want('filed'));
  check(
    'stages: plan posted',
    demoStages(show({ labels: [DEMO_LABEL, 'ai:plan-posted'], comments: [PLAN] }), none),
    want('filed', 'planned'),
  );
  check(
    'stages: answered on the board and through the picker, label matching',
    demoStages(show({ labels: [DEMO_LABEL, 'ai:answered'], comments: ANSWERED }), none),
    want('filed', 'planned', 'answered-board', 'answered-picker'),
  );
  check(
    'stages: picker answers posted, label still plan-posted',
    demoStages(show({ labels: [DEMO_LABEL, 'ai:plan-posted'], comments: ANSWERED }), none),
    want('filed', 'planned', 'answered-board'),
  );
  check(
    'stages: implementing',
    demoStages(show({ labels: [DEMO_LABEL, 'ai:implementing'], comments: ANSWERED }), none),
    want('filed', 'planned', 'answered-board', 'answered-picker', 'go'),
  );
  check(
    'stages: open request',
    demoStages(show({ labels: [DEMO_LABEL, 'ai:implementing'], comments: ANSWERED }), mr('open')),
    want('filed', 'planned', 'answered-board', 'answered-picker', 'go', 'pr'),
  );
  check(
    'stages: merged by a person',
    demoStages(
      show({ labels: [DEMO_LABEL, 'ai:implementing'], comments: ANSWERED }),
      mr('merged', { mergedBy: 'lead' }),
    ),
    want('filed', 'planned', 'answered-board', 'answered-picker', 'go', 'pr', 'merged'),
  );
  // `close` drops the ai: label, so nothing after the plan may depend on it still being there.
  check(
    'stages: closed, every stage done',
    demoStages(
      show({ labels: [DEMO_LABEL], comments: ANSWERED, closed: true }),
      mr('merged', { mergedBy: 'lead' }),
    ),
    want(...IDS),
  );
  check(
    'stages: merged by the App',
    demoStages(
      show({ labels: [DEMO_LABEL, 'ai:implementing'], comments: ANSWERED }),
      mr('merged', { mergedBy: 'board[bot]', mergedByBot: true }),
    ),
    want('filed', 'planned', 'answered-board', 'answered-picker', 'go', 'pr'),
  );

  // ---- checkDemo -------------------------------------------------------------------------------------------
  const open = (labels) => json([{ iid: 12, url: URL, labels: [DEMO_LABEL, ...labels] }]);
  const ctxFor = (s, status, labels = []) =>
    fakeContext({
      files: GH,
      commands: { [LIST]: open(labels), [SHOW]: json(s), [STATUS]: json(status) },
    });

  check('demo: no board yet', await checkDemo(fakeContext()), {
    status: 'blocked',
    summary: 'Connect the board first, in step 3.',
    detail: 'Your first item goes on the board, so this step waits for it.',
  });
  check(
    'demo: nothing filed yet',
    await checkDemo(fakeContext({ files: GH, commands: { [LIST]: json([]) } })),
    {
      status: 'todo',
      summary: 'Your first item is not on the board yet.',
      detail:
        'If you already finished it on another day, bring your copy of main up to date (git pull) and check again: the guide finds a finished item by the first line of CODEOWNERS.',
      fix: { text: 'Click “Put the item on my board”. The guide files one small item, and only one.' },
    },
  );
  check(
    'demo: board unreachable while looking',
    await checkDemo(
      fakeContext({
        files: GH,
        commands: { [LIST]: { code: 3, stdout: '', stderr: 'work-items: network — fetch failed\n' } },
      }),
    ),
    {
      status: 'blocked',
      summary: 'Can’t reach GitHub right now',
      detail:
        'Nothing is wrong with your setup that the guide can see. Check your network or VPN, then check again.',
    },
  );
  const planned = show({ labels: [DEMO_LABEL, 'ai:plan-posted'], comments: [PLAN] });
  check('demo: plan posted, the next step is yours, on the board', await checkDemo(ctxFor(planned, none)), {
    status: 'todo',
    summary: 'The plan is posted. Next, you answer its two questions.',
    fix: {
      text: 'Open the item and answer one of the two questions as a comment, in your own words. You answer the other one in Claude Code afterwards.',
      link: URL,
    },
    item: { iid: 12, url: URL },
    stages: want('filed', 'planned'),
  });
  const trapped = show({ labels: [DEMO_LABEL, 'ai:plan-posted'], comments: ANSWERED });
  check('demo: picker answers posted, label still plan-posted', await checkDemo(ctxFor(trapped, none)), {
    status: 'todo',
    summary: 'Your answers are on the item, but the board still shows it waiting for you.',
    detail: PICKER_TRAP,
    fix: {
      text: 'Paste this into Claude Code:',
      copy: 'The answers to work item #12 are posted, but its label still says plan-posted. Set the label to match.',
    },
    item: { iid: 12, url: URL },
    stages: want('filed', 'planned', 'answered-board'),
  });
  check(
    'demo: the trap is told in the words of AGENTS.md',
    [
      PICKER_TRAP.includes('authored by the bot'),
      PICKER_TRAP.includes('both a comment and a label that matches'),
      PICKER_TRAP.includes('plan-posted'),
    ],
    [true, true, true],
  );
  const building = show({ labels: [DEMO_LABEL, 'ai:implementing'], comments: ANSWERED });
  check(
    'demo: merged by the App',
    await checkDemo(ctxFor(building, mr('merged', { mergedBy: 'board[bot]', mergedByBot: true }))),
    {
      status: 'fail',
      summary: 'The board’s App merged the pull request itself: the ruleset on main let it past the lock.',
      detail: 'Only a person may merge. Step 4 checks the lock; it is worth running again.',
      fix: {
        text: 'Remove the App from the ruleset’s bypass list, so that the next merge needs a person.',
        link: 'https://github.com/acme/shop/settings/rules',
      },
      item: { iid: 12, url: URL },
      stages: want('filed', 'planned', 'answered-board', 'answered-picker', 'go', 'pr'),
    },
  );
  check('demo: pull request open, the merge is yours', await checkDemo(ctxFor(building, mr('open'))), {
    status: 'todo',
    summary: 'The pull request is open. Next, you review it and merge it.',
    fix: {
      text: 'Open the pull request, read the change, and merge it yourself. The App cannot: that is the lock from step 4.',
      link: PR,
    },
    item: { iid: 12, url: URL },
    stages: want('filed', 'planned', 'answered-board', 'answered-picker', 'go', 'pr'),
  });

  // ---- finding the demo again (Review Focus 3) ------------------------------------------------------------
  const already = fakeContext({ files: GH, commands: { [LIST]: open(['ai:plan-posted']) } });
  check(
    'demo: open item with kit-demo label exists',
    [await fileDemo(already), already.calls, already.writes],
    [
      {
        status: 'pass',
        summary: 'Your first item is already on the board: #12.',
        item: { iid: 12, url: URL },
      },
      [LIST],
      {},
    ],
  );
  const CREATE = 'node scripts/work-items.mjs create .git/kit-demo-item.md  kit-demo';
  const fresh = fakeContext({
    files: GH,
    commands: {
      [LIST]: json([{ iid: 3, url: 'https://github.com/acme/shop/issues/3', labels: ['bug'] }]),
      [FETCH]: ok(),
      [CREATE]: ok(`opened #12  Add a CODEOWNERS file\n${URL}\n`),
    },
  });
  check(
    'demo: none yet, filed once with the kit-demo label',
    [await fileDemo(fresh), fresh.calls, fresh.writes],
    [
      { status: 'pass', summary: 'Your first item is on the board: #12.', item: { iid: 12, url: URL } },
      [LIST, FETCH, HEAD, MAIN, CREATE],
      { '.git/kit-demo-item.md': DEMO_ITEM },
    ],
  );
  const finishedCtx = () =>
    fakeContext({
      files: GH,
      commands: {
        [LIST]: json([]),
        [FETCH]: ok(),
        [MAIN]: ok('# Factory Kit worked example: #12\n* @lead\n'),
        [SHOW]: json(show({ comments: ANSWERED, closed: true })),
        [STATUS]: json(mr('merged', { mergedBy: 'lead' })),
      },
    });
  const finished = finishedCtx();
  check(
    'demo: CODEOWNERS on main carries "# Factory Kit worked example: #12"',
    [await checkDemo(finished), finished.calls],
    [
      {
        status: 'pass',
        summary: 'Your first item went all the way round: #12 is closed, and a person merged its change.',
        item: { iid: 12, url: URL },
        stages: want(...IDS),
      },
      [LIST, HEAD, MAIN, SHOW, STATUS],
    ],
  );
  const again = finishedCtx();
  check(
    'demo: a finished demo is not filed again',
    [await fileDemo(again), again.calls, again.writes],
    [
      {
        status: 'pass',
        summary: 'Your first item is already on the board: #12.',
        item: { iid: 12, url: null },
      },
      [LIST, FETCH, HEAD, MAIN],
      {},
    ],
  );

  // ---- an existing repository (pnpm kit:adopt): another default branch, and a CODEOWNERS of its own ----------
  {
    const MASTER = 'git show origin/master:CODEOWNERS';
    const adopted = fakeContext({
      files: GH,
      commands: {
        [LIST]: json([]),
        [FETCH]: ok(),
        [HEAD]: ok('origin/master\n'),
        [MASTER]: ok('* @acme/shop-team\n'),
        [CREATE]: ok(`opened #12  Mark CODEOWNERS as the worked example\n${URL}\n`),
      },
    });
    check(
      'demo: on master with its own CODEOWNERS, the item is filed as an edit to it',
      [await fileDemo(adopted), adopted.calls, adopted.writes],
      [
        { status: 'pass', summary: 'Your first item is on the board: #12.', item: { iid: 12, url: URL } },
        [LIST, FETCH, HEAD, MASTER, CREATE],
        { '.git/kit-demo-item.md': DEMO_ITEM_EDIT },
      ],
    );
    const done = fakeContext({
      files: GH,
      commands: {
        [LIST]: json([]),
        [HEAD]: ok('origin/master\n'),
        [MASTER]: ok('# Factory Kit worked example: #12\n* @acme/shop-team\n'),
        [SHOW]: json(show({ comments: ANSWERED, closed: true })),
        [STATUS]: json(mr('merged', { mergedBy: 'lead' })),
      },
    });
    check(
      'demo: a finished demo is found on master',
      (await checkDemo(done)).summary,
      'Your first item went all the way round: #12 is closed, and a person merged its change.',
    );
    check(
      'demo: the edit item keeps the marker line, the branch and two decisions',
      [
        DEMO_ITEM_EDIT.includes('# Factory Kit worked example: #<this item’s number>'),
        DEMO_ITEM_EDIT.includes('kit-demo/<this item’s number>'),
        (DEMO_ITEM_EDIT.match(/^\d\. /gm) ?? []).length,
      ],
      [true, true, 2],
    );
  }

  // ---- the review's findings ------------------------------------------------------------------------------
  // advance-work-items records the session's answers as a "## Review coverage — round N" comment, which the
  // board classifies as `coverage`, not `ours`; the picker stage has to count it.
  const COVERAGE = c(
    'coverage',
    'board[bot]',
    '## Review coverage — round 1\n\n[REVIEW 2] answered in session: docs/ follows `*`.',
  );
  check(
    'stages: a real coverage round counts as the picker answer',
    demoStages(show({ labels: [DEMO_LABEL, 'ai:ready'], comments: [PLAN, REPLY, COVERAGE] }), none),
    want('filed', 'planned', 'answered-board', 'answered-picker'),
  );
  {
    const building = fakeContext({
      files: GH,
      commands: {
        [LIST]: open(['ai:implementing']),
        [SHOW]: json(show({ labels: [DEMO_LABEL, 'ai:implementing'], comments: [PLAN, REPLY] })),
        [STATUS]: json(none),
      },
    });
    check(
      'demo: the next step follows the furthest stage reached, not the first one missed',
      (await checkDemo(building)).summary,
      'Claude is building the change.',
    );
  }
  {
    const twice = fakeContext({
      files: GH,
      commands: {
        [LIST]: json([]),
        [FETCH]: ok(),
        [CREATE]: ok(`opened #12  Add a CODEOWNERS file\n${URL}\n`),
      },
    });
    await Promise.all([fileDemo(twice), fileDemo(twice)]);
    check('demo: two clicks at once file one item', twice.calls.filter((k) => k === CREATE).length, 1);
  }
}

// Step 7 of the setup guide: one small item taken round the whole loop on the real board, and kept there
// afterwards as the project's worked example.
//
// Everything here is read through `pnpm items` (list, show, mr-status), never through the adapters, for the
// reason board-checks.mjs gives: the guide and the tooling must not disagree about the board. The one write
// is filing the item, on a click, and it looks first: a tech lead who comes back the next day, or opens the
// guide again after finishing, must find the item they already have rather than get a second one. An open
// item is found by its label; a finished one by the first line of CODEOWNERS on main, which the item asks for
// precisely so that it can be found once the label is gone with the closed item.

import { envStatus, explainBoardError } from './board-checks.mjs';

export const DEMO_LABEL = 'kit-demo';
/** The branch the item asks to be built on, so the guide can find its pull request. */
export const DEMO_BRANCH = (iid) => `${DEMO_LABEL}/${iid}`;
const MARKER = /^# Factory Kit worked example: #(\d+)\s*$/m;
const ITEM_FILE = '.git/kit-demo-item.md'; // inside .git: never committed, never shown by git status

/**
 * The item as `pnpm items create` reads it: the first line is the title, the rest the body. Posted on a
 * real board and kept there, so it is written for whoever reads it next, not for the guide. A repository
 * that already has a CODEOWNERS file, as an adopted one may (`pnpm kit:adopt`), gets the edit form: the
 * marker line goes on top of the project's own rules rather than into a new file.
 */
function demoItem(edit) {
  return `${edit ? 'Mark CODEOWNERS as the worked example' : 'Add a CODEOWNERS file'}

This is the project’s worked example: a small, real change taken once through every step of the loop, from this item to a merged change, so that the next person on the project can see how work moves here. The setup guide (\`pnpm kit:setup\`) put it on the board.

## What to change

${edit ? 'The repository already has a `CODEOWNERS` file at its top.' : 'Add a file called `CODEOWNERS` at the top of the repository.'} GitHub and GitLab read it to decide who is asked to review a change, by which files the change touches.${edit ? ' Keep every rule in it.' : ''}

- ${edit ? 'Add a first line that is' : 'Its first line is'} exactly \`# Factory Kit worked example: #<this item’s number>\`. The setup guide finds this item again by that line once the change is merged.
- Build it on the branch \`kit-demo/<this item’s number>\`. The setup guide watches the pull request (merge request, on GitLab) from that branch.
- Nothing else changes${edit ? ', unless one of the two decisions below changes a rule' : ''}.

## Two decisions

The plan asks these two [REVIEW] questions, and nothing else:

1. ${edit ? 'Does the rule for everything (`*`) still name the right owners' : 'Who owns everything (`*`)'}: one person, several people, or a team?
2. Does \`docs/\` get an owner of its own, or does it follow \`*\`?

Answer one by replying here on the board, and the other in Claude Code, where it offers a choice to pick from. Both ways end in the same place on the board, and seeing that is part of the example.

## Done when

- A person, not the board’s App, has merged the pull request from \`kit-demo/<this item’s number>\`.
- \`CODEOWNERS\` on the default branch starts with the line above.
- This item is closed.
`;
}
export const DEMO_ITEM = demoItem(false);
export const DEMO_ITEM_EDIT = demoItem(true);

/**
 * AGENTS.md, "One trap worth knowing", in the guide's words. Shown when an answer given in Claude Code is on
 * the item but the label still says the item is waiting, which is that trap happening.
 */
export const PICKER_TRAP =
  'An answer you give in Claude Code reaches the board as a comment posted by the tooling, so it is authored by ' +
  'the bot, not by you. The board tells your replies from its own notes by who wrote them, so it cannot see ' +
  'that comment as your answer. A decision taken in Claude Code therefore needs both a comment and a label that ' +
  'matches, or the item sits in plan-posted, waiting for an answer that has already been given.';

const STAGES = ['filed', 'planned', 'answered-board', 'answered-picker', 'go', 'pr', 'merged', 'closed'];
// Labels that say the item has moved past waiting for its answers.
const PAST_ANSWERS = ['ai:answered', 'ai:ready', 'ai:implementing'];

/** The comments after the plan, by kind; empty before there is one. */
function afterPlan(show) {
  const comments = show?.comments ?? [];
  const at = comments.findIndex((n) => n.kind === 'plan');
  return at === -1 ? [] : comments.slice(at + 1);
}

/**
 * Where the demo item is, from `pnpm items show <iid>` and `pnpm items mr-status <branch> --json`. Eight
 * stages, each ticked or not.
 *
 * A later stage implies the earlier ones that only a label shows: `pnpm items close` drops the `ai:` label,
 * so a closed item no longer says it was ever implementing. What the comments show (a plan, a reply) is
 * never implied, because the comments stay.
 */
/** A comment by the bot, after the plan, that carries answers given in the session. */
const botAnswer = (n) => n.kind === 'ours' || n.kind === 'coverage';

export function demoStages(show, status) {
  const labels = show?.labels ?? [];
  const mr = status?.mr ?? null;
  const later = afterPlan(show);
  const closed = Boolean(show?.closed);
  const go = labels.includes('ai:implementing') || Boolean(mr) || closed;
  const done = {
    filed: Boolean(show),
    planned: (show?.comments ?? []).some((n) => n.kind === 'plan'),
    // A reply is a comment by somebody other than the bot; the board's own state machine says which.
    'answered-board': later.some((n) => n.kind === 'reply'),
    // The picker's answer is posted by the bot, and counts only once the label has moved to match it.
    // advance-work-items records them in a `## Review coverage` round, which the board calls `coverage`.
    'answered-picker': later.some(botAnswer) && (go || PAST_ANSWERS.some((l) => labels.includes(l))),
    go,
    pr: Boolean(mr),
    merged: mr?.state === 'merged' && !mr.mergedByBot,
    closed,
  };
  return STAGES.map((id) => ({ id, done: done[id] }));
}

const items = (args) => ['scripts/work-items.mjs', ...args];

/** A command's JSON, or the Result its failure means. */
async function read(ctx, args, provider) {
  const r = await ctx.sh('node', items(args));
  if (r.code !== 0) return { error: explainBoardError(r.stderr, r.code, provider) };
  try {
    return { value: JSON.parse(r.stdout) };
  } catch {
    return { error: explainBoardError(r.stdout, r.code, provider) };
  }
}

/**
 * The demo item, if one exists: an open item with the label, else the item CODEOWNERS on main names. Main
 * as this computer last saw it: the guide does not fetch, so a demo finished on another machine shows once
 * main is pulled.
 */
async function findDemo(ctx, provider, { fetch = false } = {}) {
  const list = await read(ctx, ['list', '--json'], provider);
  if (list.error) return list;
  const open = list.value.find((i) => (i.labels ?? []).includes(DEMO_LABEL));
  if (open) return { item: { iid: open.iid, url: open.url ?? null } };
  // Before filing, main as it is now, not as this computer last saw it: a demo merged on GitHub and closed
  // before anybody pulled is neither open nor in the local main, and would be filed a second time.
  if (fetch) await ctx.sh('git', ['fetch', 'origin']);
  // The default branch is the remote's, not always main: an existing repository may well be on master.
  const head = await ctx.sh('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const ref = (head.code === 0 && head.stdout.trim()) || 'origin/main';
  const shown = await ctx.sh('git', ['show', `${ref}:CODEOWNERS`]);
  const owners = shown.code === 0 ? shown.stdout : null;
  const marked = MARKER.exec(owners ?? '') ?? MARKER.exec(ctx.read('CODEOWNERS') ?? '');
  return { item: marked ? { iid: Number(marked[1]), url: null } : null, hasOwners: owners !== null };
}

const NO_BOARD = {
  status: 'blocked',
  summary: 'Connect the board first, in step 3.',
  detail: 'Your first item goes on the board, so this step waits for it.',
};

let filing = null;

/**
 * Step 7's action: put the demo item on the board, unless it is already there. One at a time: looking takes
 * seconds, and a double click or a second tab during that would otherwise file two items on a real board.
 */
export function fileDemo(ctx) {
  filing ??= fileOnce(ctx).finally(() => {
    filing = null;
  });
  return filing;
}

async function fileOnce(ctx) {
  const { provider } = envStatus(ctx);
  if (!provider) return NO_BOARD;
  const found = await findDemo(ctx, provider, { fetch: true });
  if (found.error) return found.error;
  if (found.item) {
    return {
      status: 'pass',
      summary: `Your first item is already on the board: #${found.item.iid}.`,
      item: found.item,
    };
  }
  ctx.write(ITEM_FILE, found.hasOwners ? DEMO_ITEM_EDIT : DEMO_ITEM);
  // An empty relates-to: the demo is linked to nothing.
  const r = await ctx.sh('node', items(['create', ITEM_FILE, '', DEMO_LABEL]));
  if (r.code !== 0) return explainBoardError(r.stderr, r.code, provider);
  const iid = Number(r.stdout.match(/^opened #(\d+)/m)?.[1]);
  const url = r.stdout.match(/^https?:\/\/\S+$/m)?.[0] ?? null;
  return { status: 'pass', summary: `Your first item is on the board: #${iid}.`, item: { iid, url } };
}

/** Where to go to change the lock on main, from the pull request's own address. */
function lockSettings(url, provider) {
  if (!url) return null;
  return provider === 'gitlab'
    ? url.replace(/\/-\/merge_requests\/\d+.*$/, '/-/settings/repository')
    : url.replace(/\/pull\/\d+.*$/, '/settings/rules');
}

/** What is true at the first stage not done, and what the person does next. */
function nextStep(stage, { iid, url, mr, provider }) {
  const pr = provider === 'gitlab' ? 'merge request' : 'pull request';
  const paste = (prompt) => ({ text: 'Paste this into Claude Code:', copy: prompt });
  switch (stage) {
    case 'planned':
      return {
        summary: `#${iid} is on the board. Next, Claude writes a plan for it.`,
        fix: paste(`Triage work item #${iid}.`),
      };
    case 'answered-board':
      return {
        summary: 'The plan is posted. Next, you answer its two questions.',
        fix: {
          text: 'Open the item and answer one of the two questions as a comment, in your own words. You answer the other one in Claude Code afterwards.',
          link: url,
        },
      };
    case 'answered-picker':
      return {
        summary: 'You answered on the board. Next, answer the other question in Claude Code.',
        fix: paste(
          `Advance work item #${iid}. I answered one question on the board; ask me the other one here.`,
        ),
      };
    case 'go':
      return {
        summary: 'Both questions are answered. Next, you say go.',
        fix: paste(`Go: implement work item #${iid}.`),
      };
    case 'pr':
      return {
        summary: 'Claude is building the change.',
        detail: `It works on the branch ${DEMO_BRANCH(iid)}, runs the checks in the mode you chose in step 5, and opens a ${pr}. That takes a few minutes; this page notices when it is done.`,
      };
    case 'merged':
      return mr?.state === 'closed'
        ? {
            summary: `The ${pr} was closed without being merged.`,
            fix: {
              text: `Reopen it, or ask Claude to open a new one from ${DEMO_BRANCH(iid)}.`,
              link: mr.url,
            },
          }
        : {
            summary: `The ${pr} is open. Next, you review it and merge it.`,
            fix: {
              text: `Open the ${pr}, read the change, and merge it yourself. The App cannot: that is the lock from step 4.`,
              link: mr?.url ?? null,
            },
          };
    default:
      return {
        summary: 'The change is merged. Last, the item is closed.',
        fix: paste(`The ${pr} for work item #${iid} is merged. Close the item.`),
      };
  }
}

/** Step 7: the demo item, found again however long ago it was filed, and how far round the loop it is. */
export async function checkDemo(ctx) {
  const { provider } = envStatus(ctx);
  if (!provider) return NO_BOARD;
  const found = await findDemo(ctx, provider);
  if (found.error) return found.error;
  if (!found.item) {
    return {
      status: 'todo',
      summary: 'Your first item is not on the board yet.',
      detail:
        'If you already finished it on another day, bring your copy of main up to date (git pull) and check again: the guide finds a finished item by the first line of CODEOWNERS.',
      fix: { text: 'Click “Put the item on my board”. The guide files one small item, and only one.' },
    };
  }
  const { iid } = found.item;
  const show = await read(ctx, ['show', String(iid)], provider);
  if (show.error) return show.error;
  const status = await read(ctx, ['mr-status', DEMO_BRANCH(iid), '--json'], provider);
  if (status.error) return status.error;
  const stages = demoStages(show.value, status.value);
  const mr = status.value.mr;
  const item = { iid, url: show.value.url ?? found.item.url };
  const who = provider === 'gitlab' ? 'board’s token' : 'board’s App';

  if (mr?.state === 'merged' && mr.mergedByBot) {
    return {
      status: 'fail',
      summary: `The ${who} merged the ${provider === 'gitlab' ? 'merge request' : 'pull request'} itself: the ${provider === 'gitlab' ? 'protected branch' : 'ruleset'} on main let it past the lock.`,
      detail: 'Only a person may merge. Step 4 checks the lock; it is worth running again.',
      fix: {
        text:
          provider === 'gitlab'
            ? 'Set “Allowed to merge” on main so that the token’s role is not enough, so that the next merge needs a person.'
            : 'Remove the App from the ruleset’s bypass list, so that the next merge needs a person.',
        link: lockSettings(mr.url, provider),
      },
      item,
      stages,
    };
  }
  if (show.value.closed && stages.find((s) => s.id === 'merged').done) {
    const skipped = stages.filter((s) => !s.done).map((s) => s.id);
    return {
      status: 'pass',
      summary: `Your first item went all the way round: #${iid} is closed, and a person merged its change.`,
      ...(skipped.length ? { detail: `Skipped on the way: ${skipped.join(', ')}.` } : {}),
      item,
      stages,
    };
  }
  const answers = afterPlan(show.value);
  const trapped =
    !stages.find((s) => s.id === 'answered-picker').done &&
    answers.some(botAnswer) &&
    !stages.find((s) => s.id === 'go').done;
  if (trapped) {
    return {
      status: 'todo',
      summary: 'Your answers are on the item, but the board still shows it waiting for you.',
      detail: PICKER_TRAP,
      fix: {
        text: 'Paste this into Claude Code:',
        copy: `The answers to work item #${iid} are posted, but its label still says plan-posted. Set the label to match.`,
      },
      item,
      stages,
    };
  }
  // The stage after the furthest one reached. A question answered somewhere the page cannot see must not
  // hold the instructions back at that stage while the work goes on past it.
  const furthest = stages.findLastIndex((s) => s.done);
  const next = stages[furthest + 1].id;
  return { status: 'todo', ...nextStep(next, { iid, url: item.url, mr, provider }), item, stages };
}

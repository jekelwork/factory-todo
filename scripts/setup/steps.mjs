// The setup guide's steps, in the order a tech lead takes them. One list, read by the server and, through
// it, the page: a step's id, its title, the check that says where it stands, and the actions it offers.
//
// The engine does not gate. Every check runs on every load, because a step can come undone after a later
// one passed (a key moved, a hook removed), and the person should see that wherever they are. Whether a red
// step blocks "Next" is the page's call.

import { checkBoard, checkCiMode, setCiMode } from './board-checks.mjs';
import { checkHistory, checkToolchain } from './checks.mjs';
import { checkDemo, fileDemo } from './demo.mjs';
import { checkProject } from './project.mjs';
import { acceptProtectionRisk, applyProtection, checkProtection } from './protection.mjs';
import { createRemote, useRemote } from './remote.mjs';

export const STEPS = [
  { id: 'toolchain', title: 'Tools', check: checkToolchain, actions: [] },
  {
    id: 'history',
    title: 'Your repository',
    check: checkHistory,
    // Offered only while the folder has no home and gh is logged in; the page says what each will do first.
    actions: [
      {
        id: 'create',
        label: 'Create it on GitHub',
        when: (r) => Boolean(r.connect),
        run: (ctx, input) => createRemote(ctx, input),
      },
      {
        id: 'use',
        label: 'Connect it',
        when: (r) => Boolean(r.connect),
        run: (ctx, input) => useRemote(ctx, input),
      },
    ],
  },
  { id: 'board', title: 'The board', check: checkBoard, actions: [] },
  {
    id: 'protection',
    title: 'The lock on main',
    check: checkProtection,
    actions: [
      // Offered only while the check lists changes it can make; the page says what they are first.
      {
        id: 'apply',
        label: 'Make these changes with my GitHub login',
        when: (r) => Boolean(r.apply?.length),
        run: (ctx) => applyProtection(ctx),
      },
      {
        id: 'accept',
        label: 'Accept this risk',
        when: (r) => Boolean(r.accept?.length),
        run: (ctx, input) => acceptProtectionRisk(ctx, input),
      },
    ],
  },
  {
    id: 'ci',
    title: 'Where checks run',
    check: checkCiMode,
    actions: [{ id: 'set', label: 'Use this mode', run: (ctx, input) => setCiMode(ctx, input?.mode) }],
  },
  { id: 'project', title: 'Your project', check: checkProject, actions: [] },
  {
    id: 'demo',
    title: 'Your first item',
    check: checkDemo,
    actions: [{ id: 'file', label: 'Put the item on my board', run: (ctx) => fileDemo(ctx) }],
  },
  { id: 'done', title: 'Done', check: null, actions: [] },
];

/**
 * A check that throws is that step's problem, not the page's: without this, one surprise answer (a 403 body
 * where a list was expected) turned /api/state into a 500 and every step disappeared with it.
 */
export async function guarded(step, ctx) {
  try {
    return await step.check(ctx);
  } catch (e) {
    return {
      status: 'blocked',
      summary: 'The guide could not check this step.',
      detail: String(e?.message ?? e),
    };
  }
}

/**
 * Every step's result, in order. `done` is not a check of its own: it passes when every other step does,
 * and otherwise names the ones that do not, by the numbered title the rail shows. A step the person skipped
 * is skipped only on the page, so it still keeps `done` open here; a risk they accepted is recorded in the
 * repository, so it does not, and `done` lists it.
 */
export async function runAll(ctx, steps = STEPS) {
  const out = [];
  for (const s of steps) {
    if (s.id === 'done') continue;
    out.push({ id: s.id, title: s.title, result: await guarded(s, ctx) });
  }
  const open = out.filter((r) => r.result.status !== 'pass');
  const accepted = out.flatMap((r) => (r.result.accepted ?? []).map((a) => `${r.title}: ${a}`));
  const done = steps.find((s) => s.id === 'done');
  out.push({
    id: 'done',
    title: done.title,
    result: open.length
      ? {
          status: 'todo',
          summary:
            open.length === 1
              ? 'One step is not finished yet.'
              : `${open.length} steps are not finished yet.`,
          detail: open.map((r) => `${out.indexOf(r) + 1}. ${r.title}`).join(', '),
          open: open.map((r) => r.id),
        }
      : {
          status: 'pass',
          summary: 'The factory is running.',
          ...(accepted.length ? { accepted } : {}),
        },
  });
  return out;
}

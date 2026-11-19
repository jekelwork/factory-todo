// Step 6's cases: the placeholder scan and the `pnpm check` that closes it. Found by selftest.mjs by name.
//
// The fixtures copy the kit's placeholder lines verbatim rather than reading the real files: this selftest
// runs in every project's `pnpm check`, and a project that has filled its files in must still pass it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeContext } from './fake.mjs';
import { checkProject, HANDOVER_PROMPT, PROPOSED_IN } from './project.mjs';

const SKILL = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../.claude/skills/start-project/SKILL.md',
);

/** The files named in the start-project skill's step 3 list: the files it writes tagged proposals into. */
function proposalTargets(skill) {
  const step = /^3\. \*\*Survey[\s\S]*?(?=^4\. )/m.exec(skill)?.[0] ?? '';
  const bullets = step
    .split(/\n {3}- /)
    .slice(1)
    .map((b) => b.split(/\n\s*\n/)[0]);
  return bullets.flatMap((b) => [...b.matchAll(/[\w./-]+\.(?:md|mjs|json)\b/g)].map((m) => m[0]));
}

const ADR = 'docs/adr/0001-build-with-agents-under-review.md';
const CHECK = 'mise exec -- pnpm run check';

const KIT = {
  'AGENTS.md': [
    '# <Project name> — guide for humans and AI agents',
    '',
    '<One sentence: what this is, and the stack.> This file is the canonical instruction set for any coding',
    '## Ground rules',
    '1. **Run `pnpm check` before you say something is done.** *(kit)* It is the single gate.',
    "10. *(project)* Add this codebase's own rules here, each with the incident or the reason behind it — the",
    '> *Makers Market example of project rules:* components use only `--hub-*` design tokens, and `pnpm lint` fails on a',
    '## Layout',
    '```',
    "<add the project's own directories>",
    '```',
  ].join('\n'),
  'docs/agents/project.md':
    '## 1. The irreversible failures\n\n<!-- example -->\n> *Makers Market example:* x\n<!-- /example -->\n',
  'SECURITY.md':
    '## Scope: the application\n\n<!-- example -->\n> *Makers Market example:* y\n<!-- /example -->\n',
  [ADR]: '# 0001. Build with coding agents\n\nDate: YYYY-MM-DD · Status: accepted\n',
  'package.json': JSON.stringify(
    {
      scripts: {
        check: 'pnpm run lint && node .claude/hooks/guard.mjs --selftest && node scripts/setup/selftest.mjs',
      },
    },
    null,
    2,
  ),
  '.claude/hooks/guard.mjs':
    "export const GENERATED = [\n  { pattern: /^pnpm-lock\\.yaml$/, command: 'pnpm install' },\n];\n",
};

/** A project that has filled every part in, with one file overridden per case. */
const FILLED = {
  ...KIT,
  'AGENTS.md': [
    '# Orchard — guide for humans and AI agents',
    '',
    'A fruit-stall booking app on Hono and React. This file is the canonical instruction set for any coding',
    '## Ground rules',
    '1. **Run `pnpm check` before you say something is done.** *(kit)* It is the single gate.',
    '10. *(project)* Every price is stored in cents: a float total was off by a cent on 3% of orders.',
    '## Layout',
    '```',
    'apps/api/   the Hono API',
    '```',
  ].join('\n'),
  'docs/agents/project.md': '## 1. The irreversible failures\n\n**A booking charged twice.**\n',
  'SECURITY.md': '## Scope: the application\n\nThe API in `apps/api`.\n',
  [ADR]: '# 0001. Build with coding agents\n\nDate: 2026-10-28 · Status: accepted\n',
  'package.json': JSON.stringify({
    scripts: { check: 'pnpm run lint && pnpm typecheck && pnpm test && node scripts/setup/selftest.mjs' },
  }),
};

const TODO_FIX = {
  text:
    'Paste this into Claude Code, opened in this folder. Where there is code, Claude reads it first and ' +
    'writes proposals into the files for you to review with git diff. Then it asks you about the rest, ' +
    'one question at a time, and fills it in.',
  copy: HANDOVER_PROMPT,
  // The text to copy is itself a prompt for Claude Code: under Claude Code it is the recommended choice.
  forClaude: true,
};

export default async function (check) {
  // The prompt names the skill, so the right one loads, and says the code is read before anyone is asked.
  check(
    'project: the handover prompt',
    HANDOVER_PROMPT,
    'Use the start-project skill: read the code first if there is any, propose the parts the Factory Kit ' +
      'left for this project, then ask me what the code cannot tell, one question at a time.',
  );

  {
    const ctx = fakeContext({ files: KIT });
    check('project: fresh kit', await checkProject(ctx), {
      status: 'todo',
      summary: '8 parts still describe the kit, not your project.',
      detail: [
        'AGENTS.md: title line',
        'AGENTS.md: one-sentence description',
        'AGENTS.md: project ground rules',
        'AGENTS.md: layout',
        'docs/agents/project.md: example blocks',
        'SECURITY.md: example scope',
        'docs/adr/0001: date',
        "package.json: check runs only the kit's lint",
      ].join('\n'),
      fix: TODO_FIX,
    });
    // `pnpm check` takes minutes; it says nothing useful while the files still carry the kit's text.
    check('project: fresh kit runs nothing', ctx.calls, []);
  }

  // An adopted project keeps its own AGENTS.md: no placeholder in it, and none of the kit's rules either.
  check(
    "project: a kept AGENTS.md without the kit's rules is not described",
    await checkProject(
      fakeContext({
        files: { ...FILLED, 'AGENTS.md': '# Orchard\n\n## Ground rules\n1. Prices in cents.\n' },
      }),
    ),
    {
      status: 'todo',
      summary: '1 part still describes the kit, not your project.',
      detail: "AGENTS.md: the kit's ground rules",
      fix: TODO_FIX,
    },
  );

  check(
    'project: only ADR date left',
    await checkProject(fakeContext({ files: { ...FILLED, [ADR]: KIT[ADR] } })),
    {
      status: 'todo',
      summary: '1 part still describes the kit, not your project.',
      detail: 'docs/adr/0001: date',
      fix: TODO_FIX,
    },
  );

  check(
    'project: the Makers Market rules example alone still counts as unfilled',
    await checkProject(
      fakeContext({
        files: {
          ...FILLED,
          'AGENTS.md': `${FILLED['AGENTS.md']}\n> *Makers Market example of project rules:* components use only\n`,
        },
      }),
    ),
    {
      status: 'todo',
      summary: '1 part still describes the kit, not your project.',
      detail: 'AGENTS.md: project ground rules',
      fix: TODO_FIX,
    },
  );

  {
    const out = Array.from({ length: 25 }, (_, i) => `line ${i + 1}`);
    check(
      'project: all filled, pnpm check fails',
      await checkProject(
        fakeContext({
          files: FILLED,
          commands: {
            [CHECK]: {
              code: 1,
              stdout: `${out.slice(0, 20).join('\n')}\n`,
              stderr: `${out.slice(20).join('\n')}\n`,
            },
          },
        }),
      ),
      {
        status: 'fail',
        summary: 'Everything is filled in, but the project’s own checks do not pass yet.',
        detail: out.slice(5).join('\n'),
        fix: {
          text: 'Ask Claude Code to make them pass, or run them yourself to see the whole output:',
          commands: [CHECK],
        },
      },
    );
  }

  check(
    'project: all filled, pnpm check passes',
    await checkProject(
      fakeContext({ files: FILLED, commands: { [CHECK]: { code: 0, stdout: 'ok\n', stderr: '' } } }),
    ),
    { status: 'pass', summary: 'The kit knows your project, and its checks pass.' },
  );

  // On an existing codebase the skill writes its proposals into the files, tagged, for the lead to review
  // with `git diff`. Everything else filled in, a tag left behind still keeps the step open, in every file
  // the skill writes to, so an unreviewed proposal cannot pass as the lead's answer.
  {
    const ctx = fakeContext({
      files: {
        ...FILLED,
        'AGENTS.md': `${FILLED['AGENTS.md']}\n11. <!-- proposed --> No default exports (\`biome.json\`).\n`,
        'docs/agents/project.md':
          '## 1. The irreversible failures\n\n<!-- proposed --> found: `db/migrations/` (14 files)\n',
        'SECURITY.md': '## Scope: the application\n\n<!-- proposed --> The API in `apps/api`.\n',
        '.claude/hooks/guard.mjs': [
          'export const GENERATED = [',
          '  // local: <!-- proposed --> found: drizzle.config.ts',
          "  { pattern: /^drizzle\\//, command: 'pnpm db:generate' },",
          '];',
        ].join('\n'),
      },
    });
    check('project: unreviewed proposals keep the step open', await checkProject(ctx), {
      status: 'todo',
      // Drafts drawn from the project's code, not the kit's text: the summary says which they are.
      summary: 'Proposals in 4 files are not reviewed yet.',
      detail: [
        'AGENTS.md: proposals not yet reviewed',
        'docs/agents/project.md: proposals not yet reviewed',
        'SECURITY.md: proposals not yet reviewed',
        '.claude/hooks/guard.mjs: proposals not yet reviewed',
      ].join('\n'),
      fix: TODO_FIX,
    });
    check('project: unreviewed proposals run nothing', ctx.calls, []);
  }
  check(
    'project: one file of proposals left',
    await checkProject(
      fakeContext({
        files: { ...FILLED, 'SECURITY.md': '## Scope: the application\n\n<!-- proposed --> The API.\n' },
      }),
    ),
    {
      status: 'todo',
      summary: 'Proposals in 1 file are not reviewed yet.',
      detail: 'SECURITY.md: proposals not yet reviewed',
      fix: TODO_FIX,
    },
  );
  check(
    "project: the kit's text and proposals left, each counted as what it is",
    await checkProject(
      fakeContext({
        files: {
          ...FILLED,
          [ADR]: KIT[ADR],
          'SECURITY.md': KIT['SECURITY.md'],
          'docs/agents/project.md': '## 1. The irreversible failures\n\n<!-- proposed --> found: `db/`\n',
        },
      }),
    ),
    {
      status: 'todo',
      summary:
        '2 parts still describe the kit, not your project, and proposals in 1 file are not reviewed yet.',
      detail: [
        'SECURITY.md: example scope',
        'docs/adr/0001: date',
        'docs/agents/project.md: proposals not yet reviewed',
      ].join('\n'),
      fix: TODO_FIX,
    },
  );

  // A proposal written where the scan does not look passes as the lead's answer: `package.json`'s `check`
  // did, since JSON carries no tag. Every file the skill's step 3 writes into is one the scan reads.
  // A project that removed the skill has nothing to compare.
  if (fs.existsSync(SKILL)) {
    const targets = proposalTargets(fs.readFileSync(SKILL, 'utf8'));
    check('project: the skill proposes only into files the scan reads', targets, [
      'AGENTS.md',
      'docs/agents/project.md',
      '.claude/hooks/guard.mjs',
    ]);
    check(
      'project: no file the skill proposes into goes unscanned',
      targets.filter((f) => !PROPOSED_IN.includes(f)),
      [],
    );
  }

  // A project may have no generated files and no commands to refuse beyond the kit's: the guard's lists are
  // the interview's question to ask, not something the scan can tell is missing.
  check(
    'project: guard lists are optional',
    await checkProject(
      fakeContext({
        files: { ...FILLED, '.claude/hooks/guard.mjs': 'export const GENERATED = [];\n' },
        commands: { [CHECK]: { code: 0, stdout: '', stderr: '' } },
      }),
    ),
    { status: 'pass', summary: 'The kit knows your project, and its checks pass.' },
  );
}

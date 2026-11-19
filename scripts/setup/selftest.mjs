// `pnpm check`'s part for the setup guide: every step's check, asserted offline against a fake shell and a
// fake file tree. No network, no git, no board. Every case asserts the whole answer (AGENTS.md, "Assert the
// whole answer").

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBoard, checkCiMode, envStatus, explainBoardError, setCiMode } from './board-checks.mjs';
import { checkHistory, checkToolchain, KIT_ROOT } from './checks.mjs';
import { fakeContext } from './fake.mjs';
import { COPY, TERMS } from './page/copy.mjs';
import { acceptProtectionRisk, applyProtection, checkProtection } from './protection.mjs';
import { runAll, STEPS } from './steps.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const MISE = '[tools]\nnode = "22"\npnpm = "10.34.5"\n';
const PKG = JSON.stringify({ version: '0.1.0' });
const KIT_LOG = 'docs: add a page\nMerge pull request #14 from knowit/fix/action-sha-pins\nfeat: x\n';
const HOOKS = { '.git/hooks/pre-commit': '#!/bin/sh', '.git/hooks/commit-msg': '#!/bin/sh' };

/** The git answers of a repository that is done with step 2, with one key overridden per case. */
function gitDone(over = {}) {
  return {
    'git log --format=%s': ok('chore: start from the Factory Kit 0.1.0\nInitial commit\n'),
    'git remote': ok('origin\n'),
    'git rev-parse --abbrev-ref @{u}': ok('origin/main\n'),
    'git rev-list --count @{u}..HEAD': ok('0\n'),
    ...over,
  };
}

export async function setupSelftest() {
  let failed = 0;
  const check = (name, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) console.log(`✓ ${name}`);
    else {
      failed++;
      console.error(`✗ ${name}:\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
    }
  };

  // ---- step 1: toolchain ------------------------------------------------------------------------------------
  check(
    'toolchain: node 22 and pnpm 10.34.5 pass',
    await checkToolchain(
      fakeContext({
        files: { 'mise.toml': MISE },
        commands: { 'node --version': ok('v22.11.0\n'), 'pnpm --version': ok('10.34.5\n') },
      }),
    ),
    { status: 'pass', summary: 'node 22 and pnpm 10.34.5 are installed' },
  );
  check(
    'toolchain: pnpm 9 fails with the mise fix',
    await checkToolchain(
      fakeContext({
        files: { 'mise.toml': MISE },
        commands: { 'node --version': ok('v22.11.0\n'), 'pnpm --version': ok('9.15.0\n') },
      }),
    ),
    {
      status: 'fail',
      summary: 'pnpm 9.15.0 is installed, but this project uses pnpm 10.34.5',
      fix: {
        text: 'mise installs the versions this project pins. Run this in the repository, then check again.',
        commands: ['mise install'],
      },
    },
  );
  check(
    'toolchain: node missing fails with the mise fix',
    await checkToolchain(
      fakeContext({ files: { 'mise.toml': MISE }, commands: { 'pnpm --version': ok('10.34.5\n') } }),
    ),
    {
      status: 'fail',
      summary: 'node is not installed, and this project uses node 22',
      fix: {
        text: 'mise installs the versions this project pins. Run this in the repository, then check again.',
        commands: ['mise install'],
      },
    },
  );

  {
    // mise installed the right versions, but the shell never activated it: the PATH finds Homebrew's node.
    // "Run mise install" is then advice that changes nothing (walk on #18, snag 1).
    const inactive = (env, over = {}) =>
      checkToolchain(
        fakeContext({
          files: { 'mise.toml': MISE },
          env,
          commands: {
            'node --version': ok('v26.8.2\n'),
            'mise exec -- node --version': ok('v22.23.3\n'),
            'pnpm --version': ok('10.34.5\n'),
            ...over,
          },
        }),
      );
    const SHELL_FIX = (commands) => ({
      text: 'Run this once, open a new terminal in this folder, and start pnpm kit:setup again from it:',
      commands,
    });
    const DETAIL =
      'mise has installed the right versions, but this terminal does not use them yet. One line in your ' +
      'shell’s settings makes every new terminal use them.';
    check('toolchain: mise has node 22 but zsh does not use it', await inactive({ SHELL: '/bin/zsh' }), {
      status: 'fail',
      summary: 'This terminal is not using mise, so it runs node 26.8.2 instead of node 22',
      detail: DETAIL,
      fix: SHELL_FIX([`echo 'eval "$(mise activate zsh)"' >> ~/.zshrc`]),
    });
    check(
      'toolchain: bash gets the bash line',
      (await inactive({ SHELL: '/usr/local/bin/bash' })).fix,
      SHELL_FIX([`echo 'eval "$(mise activate bash)"' >> ~/.bashrc`]),
    );
    check(
      'toolchain: fish gets the fish line',
      (await inactive({ SHELL: '/opt/homebrew/bin/fish' })).fix,
      SHELL_FIX(["echo 'mise activate fish | source' >> ~/.config/fish/config.fish"]),
    );
    check(
      'toolchain: under Claude Code, the restart is of Claude Code',
      (await inactive({ SHELL: '/bin/zsh', CLAUDECODE: '1' })).fix,
      {
        text: 'Run this once. Then quit Claude Code, open a new terminal in this folder, start Claude Code again from it, and start the guide again:',
        commands: [`echo 'eval "$(mise activate zsh)"' >> ~/.zshrc`],
      },
    );
    check('toolchain: another shell gets the instructions page', (await inactive({})).fix, {
      text: 'Set your shell up to activate mise, open a new terminal in this folder, and start pnpm kit:setup again from it.',
      link: 'https://mise.jdx.dev/getting-started.html#activate-mise',
    });
    check(
      'toolchain: no node on the PATH at all, but mise has it',
      (await inactive({ SHELL: '/bin/zsh' }, { 'node --version': { code: 127, stdout: '', stderr: '' } }))
        .summary,
      'This terminal is not using mise, so it cannot find node 22',
    );
    check(
      'toolchain: mise has the wrong version too, so mise install is the fix',
      await inactive({ SHELL: '/bin/zsh' }, { 'mise exec -- node --version': ok('v20.1.0\n') }),
      {
        status: 'fail',
        summary: 'node 26.8.2 is installed, but this project uses node 22',
        fix: {
          text: 'mise installs the versions this project pins. Run this in the repository, then check again.',
          commands: ['mise install'],
        },
      },
    );
  }

  // ---- step 2: fresh history and first push ----------------------------------------------------------------
  const history = (commands, files = HOOKS) =>
    checkHistory(fakeContext({ files: { 'package.json': PKG, ...files }, commands }));

  // A history with no start commit: whose it is, told by its roots (checks.mjs, KIT_ROOT).
  const unstarted = (log, roots, count = '1\n', over = {}) =>
    gitDone({
      'git log --format=%s': ok(log),
      'git rev-parse --is-shallow-repository': ok('false\n'),
      'git rev-list --max-parents=0 HEAD': ok(roots),
      'git rev-list --count HEAD': ok(count),
      ...over,
    });
  check("history: the kit's own history", await history(unstarted(KIT_LOG, `${KIT_ROOT}\n`)), {
    status: 'fail',
    summary: "This folder still carries the kit's own history. The guide will not delete it for you.",
    detail:
      'A new project starts with a clean history. Deleting the .git folder cannot be undone, so run ' +
      'these yourself, in this folder, then check again.',
    fix: {
      text: 'Start a fresh history, then reinstall the git hooks:',
      commands: ['rm -rf .git && git init -b main', 'mise exec -- pnpm install'],
      // Deleting history is the person's own act: no "ask Claude Code" prompt for it.
      byHand: true,
    },
  });
  const NOT_THE_KIT = {
    status: 'fail',
    summary:
      "This history is not the kit's, and it has no start commit. The guide sets up new projects, " +
      'and does not change an existing one.',
    detail:
      'To start a new project, copy the kit into a folder of its own: "Copy the kit", under ' +
      '"Start a project" in the README, says how.',
    fix: {
      text:
        'If this is a new project and these commits are your own, make the start commit yourself, then ' +
        'check again: git add -A && git commit --allow-empty -m "chore: start from the Factory Kit 0.1.0"',
      byHand: true,
    },
  };
  const PROJECT_LOG = 'Merge pull request #1 from knowit/foo\nfeat: x\n';
  const existing = await history(unstarted(PROJECT_LOG, 'abc123\n', '2\n'));
  check('history: an existing project merged from knowit/ branches', existing, NOT_THE_KIT);
  check(
    'history: an existing project is never offered rm -rf, anywhere in the result',
    JSON.stringify(existing).includes('rm -rf'),
    false,
  );
  check(
    'history: a project that merged the kit in',
    await history(unstarted(PROJECT_LOG, `abc123\n${KIT_ROOT}\n`, '40\n')),
    NOT_THE_KIT,
  );
  check(
    'history: a shallow clone',
    // Its boundary is its only root and it counts one commit, as a template would: shallow wins first.
    await history(
      unstarted(KIT_LOG, '3714897\n', '1\n', { 'git rev-parse --is-shallow-repository': ok('true\n') }),
    ),
    {
      status: 'todo',
      summary: 'This is a shallow clone, so the guide cannot see where its history starts.',
      fix: { text: 'Fetch the rest of it, then check again:', commands: ['git fetch --unshallow'] },
    },
  );
  check('history: hooks not installed', await history(gitDone(), {}), {
    status: 'fail',
    summary: 'The git hooks are not installed, so nothing checks a commit before it is made.',
    fix: { text: 'Install them:', commands: ['mise exec -- pnpm install'] },
  });
  check('history: no remote', await history(gitDone({ 'git remote': ok('') })), {
    status: 'todo',
    summary: 'This repository has no home on GitHub or GitLab yet.',
    fix: {
      text:
        'Create an empty repository (no README, no licence) on GitHub or an empty project on GitLab, ' +
        'then connect it:',
      commands: ['git remote add origin <the URL it shows you>'],
      link: 'https://github.com/new',
      byHand: true,
    },
  });
  check(
    'history: no commits yet',
    await history(gitDone({ 'git log --format=%s': { code: 128, stdout: '', stderr: 'no commits' } })),
    {
      status: 'todo',
      summary: 'Nothing is committed yet.',
      fix: {
        text: 'Make the first commit. It names the kit version, so a later update knows where you started:',
        commands: ['git add -A', 'git commit -m "chore: start from the Factory Kit 0.1.0"'],
      },
    },
  );
  check(
    'history: template "Initial commit" without the kit-version commit, nothing changed since',
    await history(unstarted('Initial commit\n', 'abc123\n', '1\n', { 'git status --porcelain': ok('') })),
    {
      status: 'todo',
      summary: 'The commit that names the kit version is not made yet.',
      fix: {
        text: 'Make it. It names the kit version, so a later update knows where you started:',
        commands: ['git commit --allow-empty -m "chore: start from the Factory Kit 0.1.0"'],
      },
    },
  );
  check(
    'history: template "Initial commit", with changes not yet committed',
    await history(
      unstarted('Initial commit\n', 'abc123\n', '1\n', { 'git status --porcelain': ok(' M README.md\n') }),
    ),
    {
      status: 'todo',
      summary: 'The commit that names the kit version is not made yet.',
      fix: {
        text: 'Make it. It names the kit version, so a later update knows where you started:',
        commands: ['git add -A', 'git commit -m "chore: start from the Factory Kit 0.1.0"'],
      },
    },
  );
  check(
    'history: first commit not pushed',
    await history(
      gitDone({ 'git rev-parse --abbrev-ref @{u}': { code: 128, stdout: '', stderr: 'no upstream' } }),
    ),
    {
      status: 'todo',
      summary: 'The first commit is only on this computer.',
      fix: {
        text: 'Push it, so the next steps have a main branch to work with:',
        commands: ['git push -u origin main'],
      },
    },
  );
  check(
    'history: first commit not pushed, on a branch other than main, names that branch',
    (
      await history(
        gitDone({
          'git rev-parse --abbrev-ref @{u}': { code: 128, stdout: '', stderr: 'no upstream' },
          'git branch --show-current': ok('trunk\n'),
        }),
      )
    ).fix,
    {
      text: 'Push it, so the next steps have a main branch to work with:',
      commands: ['git push -u origin trunk'],
    },
  );
  check(
    'history: pushed once, then committed again',
    await history(gitDone({ 'git rev-list --count @{u}..HEAD': ok('2\n') })),
    {
      status: 'todo',
      summary: '2 commits are only on this computer.',
      fix: { text: 'Push them:', commands: ['git push'] },
    },
  );
  check('history: template "Initial commit" then kit-version commit, pushed', await history(gitDone()), {
    status: 'pass',
    summary: 'A fresh history, started from the Factory Kit 0.1.0, is pushed.',
  });
  check(
    'history: all done, with later work on top',
    await history(
      gitDone({
        'git log --format=%s': ok(
          'Merge pull request #3 from knowit/feat/x\nfeat: x\nchore: start from the Factory Kit 0.1.0\n',
        ),
      }),
    ),
    { status: 'pass', summary: 'A fresh history, started from the Factory Kit 0.1.0, is pushed.' },
  );
  check(
    'history: a worktree, whose hooks live in the main checkout, is found where git looks',
    await history(
      gitDone({ 'git rev-parse --path-format=relative --git-path hooks': ok('../../.git/hooks\n') }),
      { '../../.git/hooks/pre-commit': '#!/bin/sh', '../../.git/hooks/commit-msg': '#!/bin/sh' },
    ),
    { status: 'pass', summary: 'A fresh history, started from the Factory Kit 0.1.0, is pushed.' },
  );

  // An adopted repository (`pnpm kit:adopt`): its own history, its own version, the kit's in factoryKit.kit.
  const ADOPTED_PKG = JSON.stringify({ version: '3.4.0', factoryKit: { kit: '1.1.1' } });
  const ADOPT_LOG = 'chore: adopt the Factory Kit 1.1.1\nfeat: shop\nInitial commit\n';
  const BRANCH = 'chore/adopt-factory-kit-1.1.1';
  const adoptedGit = (over = {}) =>
    gitDone({
      'git log --format=%s': ok(ADOPT_LOG),
      'git symbolic-ref --short refs/remotes/origin/HEAD': ok('origin/main\n'),
      'git show origin/main:package.json': ok(ADOPTED_PKG),
      'git branch --show-current': ok('main\n'),
      ...over,
    });
  const notMerged = { 'git show origin/main:package.json': ok(JSON.stringify({ version: '3.4.0' })) };
  const adopted = (over, files = {}) =>
    history(adoptedGit(over), { ...HOOKS, 'package.json': ADOPTED_PKG, ...files });
  const ADOPTED_PASS = { status: 'pass', summary: 'The Factory Kit 1.1.1 is adopted, and merged into main.' };
  check('history: adopted, and the adoption merged into main', await adopted(), ADOPTED_PASS);
  check(
    'history: adopted by a squash merge, the subject renamed: the record in package.json still counts',
    await adopted({ 'git log --format=%s': ok('Bring in the kit (#12)\nfeat: shop\n') }),
    ADOPTED_PASS,
  );
  check(
    'history: adopted on a remote whose default branch is master',
    await adopted({
      'git symbolic-ref --short refs/remotes/origin/HEAD': ok('origin/master\n'),
      'git show origin/master:package.json': ok(ADOPTED_PKG),
    }),
    { status: 'pass', summary: 'The Factory Kit 1.1.1 is adopted, and merged into master.' },
  );
  check(
    'history: adopted, the branch only on this computer, the version from the commit',
    // No factoryKit in the checkout's package.json: the adoption commit names the version.
    await history(
      adoptedGit({
        ...notMerged,
        'git branch --show-current': ok(`${BRANCH}\n`),
        'git rev-parse --abbrev-ref @{u}': { code: 128, stdout: '', stderr: 'no upstream' },
      }),
      { ...HOOKS, 'package.json': JSON.stringify({ version: '3.4.0' }) },
    ),
    {
      status: 'todo',
      summary: `The adoption is on the branch ${BRANCH}, which is only on this computer.`,
      fix: { text: 'Push it, then open a pull request from it:', commands: [`git push -u origin ${BRANCH}`] },
    },
  );
  check(
    'history: adopted, the branch pushed with commits since',
    await adopted({
      ...notMerged,
      'git branch --show-current': ok(`${BRANCH}\n`),
      'git rev-list --count @{u}..HEAD': ok('1\n'),
    }),
    {
      status: 'todo',
      summary: `1 commit is on ${BRANCH} only on this computer.`,
      fix: { text: 'Push it:', commands: ['git push'] },
    },
  );
  check(
    'history: adopted, the branch pushed and not merged yet',
    await adopted({ ...notMerged, 'git branch --show-current': ok(`${BRANCH}\n`) }),
    {
      status: 'todo',
      summary: `The adoption is on the branch ${BRANCH}, and not merged into main yet.`,
      fix: {
        text: `Open a pull request from ${BRANCH} and merge it once it is reviewed. Then fetch, and check again:`,
        commands: ['git fetch origin'],
      },
    },
  );
  const onMain = await adopted(notMerged);
  check('history: adopted on the default branch itself is never pushed there', onMain, {
    status: 'todo',
    summary: 'The adoption is not on a branch of its own, and main on the remote does not have it yet.',
    detail:
      'The guide never pushes to main: the adoption reaches it through a pull request, like any change.',
    fix: {
      text:
        'Put it on a branch of its own and push that, then open a pull request from it: ' +
        `git switch -c ${BRANCH} && git push -u origin ${BRANCH}`,
      byHand: true,
    },
  });
  const huskyGit = { 'git rev-parse --path-format=relative --git-path hooks': ok('.husky/_\n') };
  check(
    "history: adopted under Husky, its hooks not set up, is sent to the project's own install",
    await adopted(huskyGit, { '.husky/pre-commit': 'npm test\n', 'package-lock.json': '{}' }),
    {
      status: 'fail',
      summary: 'The git hooks are not installed, so nothing checks a commit before it is made.',
      fix: {
        text: 'Husky runs this project’s hooks. The project’s own install sets them up:',
        commands: ['npm install'],
      },
    },
  );
  check(
    'history: adopted under Husky, its hooks set up in core.hooksPath',
    await adopted(huskyGit, {
      '.husky/pre-commit': 'npm test\n',
      '.husky/_/pre-commit': '#!/bin/sh',
      '.husky/_/commit-msg': '#!/bin/sh',
    }),
    ADOPTED_PASS,
  );
  check(
    'history: adopted under pre-commit, its hooks not installed',
    await history(adoptedGit(), { 'package.json': ADOPTED_PKG, '.pre-commit-config.yaml': 'repos:\n' }),
    {
      status: 'fail',
      summary: 'The git hooks are not installed, so nothing checks a commit before it is made.',
      fix: {
        text: 'pre-commit runs this project’s hooks. Install them with it:',
        commands: ['pre-commit install'],
      },
    },
  );
  check(
    "history: adopted on npm, lefthook's hooks not installed, installs the kit's own package",
    await history(adoptedGit(), {
      'package.json': JSON.stringify({
        version: '3.4.0',
        factoryKit: { kit: '1.1.1', package: 'tools/factory-kit' },
      }),
    }),
    {
      status: 'fail',
      summary: 'The git hooks are not installed, so nothing checks a commit before it is made.',
      fix: { text: 'Install them:', commands: ['mise exec -- pnpm --dir tools/factory-kit install'] },
    },
  );

  // ---- the catalogue and its words --------------------------------------------------------------------------
  check(
    "catalogue: ids in the spec's order",
    STEPS.map((s) => s.id),
    ['toolchain', 'history', 'board', 'protection', 'ci', 'project', 'demo', 'done'],
  );
  check(
    'catalogue: every step has copy and an existing picture',
    STEPS.filter((s) => !COPY[s.id]?.why || !fs.existsSync(path.join(HERE, 'page', COPY[s.id].picture))).map(
      (s) => s.id,
    ),
    [],
  );
  // A term the tech lead may not know is only used in a step that also says what it means, in the words
  // TERMS gives it. Otherwise the copy is a grandmother guide to someone who already knows.
  check(
    'copy: no jargon left unexplained',
    Object.entries(COPY).flatMap(([id, c]) => {
      const text = [c.why, ...c.body].join(' ');
      return Object.entries(TERMS)
        .filter(
          ([term, meaning]) => text.toLowerCase().includes(term.toLowerCase()) && !c.body.includes(meaning),
        )
        .map(([term]) => `${id}: ${term}`);
    }),
    [],
  );
  {
    // Every action the catalogue offers runs, rather than throwing: step 2's two once referred to functions
    // steps.mjs never imported, the selftest only ever called them directly, and the page got a bare 500.
    const ctx = fakeContext();
    const ran = [];
    for (const s of STEPS) {
      for (const a of s.actions) {
        try {
          const r = await a.run(ctx, {});
          ran.push([s.id, a.id, typeof r?.status]);
        } catch (e) {
          ran.push([s.id, a.id, String(e)]);
        }
      }
    }
    check('catalogue: every action runs and answers a result', ran, [
      ['history', 'create', 'string'],
      ['history', 'use', 'string'],
      ['protection', 'apply', 'string'],
      ['protection', 'accept', 'string'],
      ['ci', 'set', 'string'],
      ['demo', 'file', 'string'],
    ]);
  }
  {
    // One check that throws must not take the whole page with it.
    const steps = STEPS.map((s) =>
      s.id === 'done'
        ? s
        : {
            ...s,
            check: async () => {
              if (s.id === 'protection') throw new TypeError('rules.filter is not a function');
              return { status: 'pass', summary: 'ok' };
            },
          },
    );
    check(
      'runAll: a check that throws is blocked, and the others still answer',
      (await runAll(fakeContext(), steps)).map((r) => [r.id, r.result.status]),
      [
        ['toolchain', 'pass'],
        ['history', 'pass'],
        ['board', 'pass'],
        ['protection', 'blocked'],
        ['ci', 'pass'],
        ['project', 'pass'],
        ['demo', 'pass'],
        ['done', 'todo'],
      ],
    );
  }
  {
    // `done` is computed from the others, so one step that is not passing keeps it open and is named.
    const passing = { status: 'pass', summary: 'ok' };
    const steps = STEPS.map((s) =>
      s.id === 'done'
        ? s
        : { ...s, check: async () => (s.id === 'board' ? { status: 'blocked', summary: 'x' } : passing) },
    );
    const done = (await runAll(fakeContext(), steps)).find((r) => r.id === 'done').result;
    // Named by the title the rail shows, not by the id the person never sees (#18, snag 5).
    check('done: passes only when every other step passes', done, {
      status: 'todo',
      summary: 'One step is not finished yet.',
      detail: '3. The board',
      open: ['board'],
    });
    const risky = STEPS.map((s) =>
      s.id === 'done'
        ? s
        : {
            ...s,
            check: async () =>
              s.id === 'protection'
                ? { ...passing, accepted: ['Merged branches stay. Accepted because: x.'] }
                : passing,
          },
    );
    check(
      'done: passes with the accepted risks listed under their step',
      (await runAll(fakeContext(), risky)).find((r) => r.id === 'done').result,
      {
        status: 'pass',
        summary: 'The factory is running.',
        accepted: ['The lock on main: Merged branches stay. Accepted because: x.'],
      },
    );
    const all = STEPS.map((s) => (s.id === 'done' ? s : { ...s, check: async () => passing }));
    check(
      'done: every step passing',
      (await runAll(fakeContext(), all)).find((r) => r.id === 'done').result,
      { status: 'pass', summary: 'The factory is running.' },
    );
  }

  // ---- step 3: the board ------------------------------------------------------------------------------------
  const GH_ENV =
    'GITHUB_REPOSITORY=knowit/my-project\nGITHUB_APP_ID=123\nGITHUB_APP_PRIVATE_KEY_PATH=/keys/app.pem\n' +
    'GITHUB_APP_INSTALLATION_ID=     # blank: looked up from the repo\n';
  const GL_ENV =
    'GITLAB_URL=https://gitlab.example.com\nGITLAB_TOKEN=glpat-x\nGITLAB_PROJECT_ID=7\nGITLAB_MR_TOKEN=\n';
  const LIST = 'node scripts/work-items.mjs list --json';
  const fail = (code, stderr) => ({ code, stdout: '', stderr });
  const board = (files, answer) =>
    checkBoard(fakeContext({ files, commands: answer ? { [LIST]: answer } : {} }));

  check('board: answers', await board({ '.env.github': GH_ENV }, ok('[]')), {
    status: 'pass',
    summary: 'The board answers.',
  });
  check(
    'board: 404 on /installation',
    await board(
      { '.env.github': GH_ENV },
      fail(
        1,
        'work-items: not-found — GitHub GET /repos/knowit/factory-kit/installation answered 404: Not Found (or the App cannot see this repository)\n',
      ),
    ),
    {
      status: 'fail',
      summary: 'The App exists, but it is not installed on this repository',
      detail:
        'GitHub knows the App and accepted its key, but the App has not been given access to knowit/factory-kit.',
      fix: {
        text:
          'Open the App’s installation settings, choose Configure, and add this repository. Then check again. ' +
          'If the repository belongs to your own account rather than an organisation, open ' +
          'https://github.com/settings/installations instead.',
        link: 'https://github.com/organizations/knowit/settings/installations',
      },
    },
  );
  {
    // The installation page lives under the organisation for an organisation's repository, and under the
    // person's own settings for theirs: gh says which kind of account the owner is.
    const NOT_INSTALLED = fail(
      1,
      'work-items: not-found — GitHub GET /repos/ada/orchard/installation answered 404: Not Found\n',
    );
    const owned = (type) =>
      checkBoard(
        fakeContext({
          files: { '.env.github': GH_ENV },
          commands: { [LIST]: NOT_INSTALLED, 'gh api users/ada': ok(JSON.stringify({ type })) },
        }),
      );
    check(
      'board: not installed, on a personal account, links to the person’s own installations',
      (await owned('User')).fix,
      {
        text: 'Open the App’s installation settings, choose Configure, and add this repository. Then check again.',
        link: 'https://github.com/settings/installations',
      },
    );
    check(
      'board: not installed, on an organisation gh can see, links to the organisation’s',
      (await owned('Organization')).fix,
      {
        text: 'Open the App’s installation settings, choose Configure, and add this repository. Then check again.',
        link: 'https://github.com/organizations/ada/settings/installations',
      },
    );
  }
  check(
    'board: unreachable is not misconfigured',
    await board(
      { '.env.github': GH_ENV },
      fail(3, 'work-items: network — could not reach GitHub: fetch failed (getaddrinfo ENOTFOUND)\n'),
    ),
    {
      status: 'blocked',
      summary: 'Can’t reach GitHub right now',
      detail:
        'Nothing is wrong with your setup that the guide can see. Check your network or VPN, then check again.',
    },
  );
  check(
    'board: not configured',
    await checkBoard(
      fakeContext({
        commands: { 'git remote get-url origin': ok('git@github.com:knowit/my-project.git\n') },
      }),
    ),
    {
      status: 'todo',
      summary: 'No board is connected yet.',
      fix: {
        copy:
          'Please create a GitHub App owned by the organisation, with no webhook, repository permissions ' +
          'Issues, Pull requests and Contents (read and write) and Metadata (read), install it on ' +
          'knowit/my-project, and send me its App id and a private key.',
        text:
          'On GitHub, either install your organisation’s shared Factory Kit App on this repository, or have an ' +
          'organisation admin create a new App. On GitLab, create two project access tokens. Then copy ' +
          '.env.github.example to .env.github (or .env.gitlab.example to .env.gitlab) and fill it in.',
        link: 'docs/agents/issue-tracker.md',
      },
    },
  );
  check('board: both env files', await board({ '.env.github': GH_ENV, '.env.gitlab': GL_ENV }, null), {
    status: 'fail',
    summary: 'Both .env.github and .env.gitlab are here, so the kit cannot tell which board is yours.',
    fix: {
      text: 'Delete the one this project does not use, then check again.',
    },
  });
  check('board: GitLab without GITLAB_MR_TOKEN', await board({ '.env.gitlab': GL_ENV }, ok('[]')), {
    status: 'fail',
    summary: 'GITLAB_MR_TOKEN is empty, and your first item ends in a merge request that needs it.',
    fix: {
      text: 'Create a second project access token with the Developer role and the api scope, and put it in .env.gitlab as GITLAB_MR_TOKEN.',
      link: 'docs/agents/issue-tracker.md',
    },
  });
  check(
    'board: key refused',
    explainBoardError('work-items: unauthenticated — GitHub GET /app answered 401: bad JWT\n', 1, 'github'),
    {
      status: 'fail',
      summary: 'GitHub refused the App’s key.',
      detail:
        'GITHUB_APP_ID and the .pem file have to belong to the same App, and the key must not have been revoked.',
      fix: { text: 'Check both in .env.github, or generate a new private key on the App’s page.' },
    },
  );
  check(
    'board: a half-filled .env.github names what is empty, not the network',
    await board(
      {
        '.env.github': 'GITHUB_REPOSITORY=knowit/my-project\nGITHUB_APP_ID=\nGITHUB_APP_PRIVATE_KEY_PATH=\n',
      },
      null,
    ),
    {
      status: 'todo',
      summary: '.env.github is not filled in yet: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH.',
      fix: {
        text: 'Fill these in from the App’s page, then check again.',
        link: 'docs/agents/issue-tracker.md',
      },
    },
  );
  check(
    'board: a key path that is not there is not a refused key',
    explainBoardError(
      "work-items: unauthenticated — cannot read the GitHub App's private key at /keys/app.pem\n",
      1,
      'github',
    ),
    {
      status: 'fail',
      summary: 'The App’s key file is not where .env.github says.',
      detail:
        'GITHUB_APP_PRIVATE_KEY_PATH must point at the .pem file you downloaded: an absolute path, or one relative to this folder.',
      fix: { text: 'Move the file there, or correct the path in .env.github.' },
    },
  );
  check(
    'envStatus: never returns a value',
    envStatus(fakeContext({ files: { '.env.github': 'GITHUB_APP_ID=123\n' } })),
    {
      provider: 'github',
      conflict: false,
      vars: {
        GITHUB_REPOSITORY: false,
        GITHUB_APP_ID: true,
        GITHUB_APP_PRIVATE_KEY_PATH: false,
        GITHUB_APP_INSTALLATION_ID: false,
      },
    },
  );

  // ---- step 5: CI mode --------------------------------------------------------------------------------------
  check('ci: none set', await checkCiMode(fakeContext({ files: { '.env.github': GH_ENV } })), {
    status: 'todo',
    summary: 'Choose where the checks run.',
    options: ['local', 'remote', 'split'],
  });
  check(
    'ci: split in .mise.local.toml',
    await checkCiMode(
      fakeContext({ files: { '.env.github': GH_ENV, '.mise.local.toml': '[env]\nCI_MODE = "split"\n' } }),
    ),
    { status: 'pass', summary: 'Checks run in split mode.', options: ['local', 'remote', 'split'] },
  );
  check(
    'ci: GitLab offers local only without a mirror',
    (await checkCiMode(fakeContext({ files: { '.env.gitlab': GL_ENV } }))).options,
    ['local'],
  );
  {
    const ctx = fakeContext({ files: { '.env.github': GH_ENV, '.mise.local.toml': '[tools]\nfoo = "1"\n' } });
    const r = await setCiMode(ctx, 'remote');
    check(
      'setCiMode: writes [env] CI_MODE and keeps other lines',
      [ctx.writes, r],
      [
        { '.mise.local.toml': '[tools]\nfoo = "1"\n\n[env]\nCI_MODE = "remote"\n' },
        {
          status: 'pass',
          summary: 'Checks run in remote mode.',
          detail:
            'A terminal opened from now on picks this up. One that is already open keeps the old setting.',
          options: ['local', 'remote', 'split'],
        },
      ],
    );
  }
  {
    const ctx = fakeContext({
      files: { '.env.github': GH_ENV, '.mise.local.toml': '[env]\nCI_MODE = "local"\nX = "1"\n' },
    });
    await setCiMode(ctx, 'split');
    check('setCiMode: replaces an existing CI_MODE in place', ctx.writes, {
      '.mise.local.toml': '[env]\nCI_MODE = "split"\nX = "1"\n',
    });
  }
  {
    const ctx = fakeContext({ files: { '.env.gitlab': GL_ENV } });
    check(
      'setCiMode: refuses a mode this board cannot run',
      [await setCiMode(ctx, 'remote'), ctx.writes],
      [{ status: 'fail', summary: 'remote is not available here.', options: ['local'] }, {}],
    );
  }

  // ---- step 4: the lock on main -----------------------------------------------------------------------------
  const PVR_NOTE =
    'Private vulnerability reporting is for public repositories. SECURITY.md says where to send a report instead.';
  const RISKS_HEAD =
    '## Risks accepted at setup\n\nThe setup guide (`pnpm kit:setup`) records here each check that a person chose to live with, and why. Delete a line and the guide asks again.\n\n';
  // Spelled out rather than built from the module, so a change to what the ruleset says shows up here.
  const RULESET_JSON = `${JSON.stringify(
    {
      name: 'main needs a reviewed pull request',
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [
        { type: 'deletion' },
        { type: 'non_fast_forward' },
        {
          type: 'pull_request',
          parameters: {
            required_approving_review_count: 1,
            dismiss_stale_reviews_on_push: true,
            require_code_owner_review: false,
            require_last_push_approval: false,
            required_review_thread_resolution: false,
          },
        },
      ],
      // The repository's admins may merge a pull request without an approval, through a pull request only.
      bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' }],
    },
    null,
    2,
  )}\n`;
  const RULESET_FIX = {
    text:
      'Add a ruleset for main that requires a pull request, and leave the App off its bypass list. On the ' +
      'rulesets page choose New ruleset, then Import a ruleset, and give it this file:',
    copy: RULESET_JSON,
    download: { name: 'main-ruleset.json', text: RULESET_JSON },
    link: 'https://github.com/knowit/my-project/settings/rules',
  };
  {
    const R = 'repos/knowit/my-project';
    // What makes a pull-request rule the lock (#30): a person's approval, dismissed on a new push.
    const LOCK = { required_approving_review_count: 1, dismiss_stale_reviews_on_push: true };
    const META = (over = {}) =>
      JSON.stringify({ default_branch: 'main', delete_branch_on_merge: true, visibility: 'public', ...over });
    const ghDone = (over = {}) => ({
      [`gh api ${R}`]: ok(META()),
      [`gh api ${R}/rules/branches/main`]: ok(
        JSON.stringify([{ type: 'pull_request', ruleset_id: 9, parameters: LOCK }]),
      ),
      [`gh api ${R}/rulesets/9`]: ok(
        JSON.stringify({ bypass_actors: [{ actor_id: 5, actor_type: 'Team' }] }),
      ),
      [`gh api ${R}/private-vulnerability-reporting`]: ok(JSON.stringify({ enabled: true })),
      ...over,
    });
    const protection = (commands) =>
      checkProtection(fakeContext({ files: { '.env.github': GH_ENV }, commands }));
    const RULES = 'https://github.com/knowit/my-project/settings/rules';

    check('protection: gh missing', await protection({}), {
      status: 'blocked',
      summary: 'Install the GitHub CLI (gh) so the guide can check this',
      detail: 'The guide reads these settings with your own GitHub login, not the App’s.',
      fix: {
        text: 'Install it, then log in:',
        commands: ['brew install gh', 'gh auth login'],
        link: 'https://cli.github.com',
      },
    });
    check(
      'protection: gh logged out',
      await protection({
        [`gh api ${R}`]: fail(4, 'To get started with GitHub CLI, please run:  gh auth login\n'),
      }),
      {
        status: 'blocked',
        summary: 'Log in to the GitHub CLI so the guide can check this',
        detail: 'The guide reads these settings with your own GitHub login, not the App’s.',
        fix: { text: 'Log in, then check again:', commands: ['gh auth login'] },
      },
    );
    check(
      'protection: pull request rule, no App bypass, auto-delete on, reporting on',
      await protection(ghDone()),
      {
        status: 'pass',
        summary: 'main only changes through a pull request that a person merges.',
      },
    );
    check(
      'protection: App listed as bypass actor',
      await protection(
        ghDone({
          [`gh api ${R}/rulesets/9`]: ok(
            JSON.stringify({ bypass_actors: [{ actor_id: 123, actor_type: 'Integration' }] }),
          ),
        }),
      ),
      {
        status: 'fail',
        summary: 'The board’s App is allowed past the lock, so it could merge on its own.',
        detail: 'The board’s App is allowed past the lock, so it could merge on its own.',
        fix: { text: 'Remove the App from the ruleset’s bypass list.', link: RULES },
      },
    );
    check(
      'protection: auto-delete off',
      await protection(
        ghDone({
          [`gh api ${R}`]: ok(META({ delete_branch_on_merge: false })),
        }),
      ),
      {
        status: 'fail',
        summary: 'Merged branches are not deleted automatically.',
        detail: 'Merged branches are not deleted automatically.',
        fix: {
          text: 'Turn on “Automatically delete head branches” in the repository’s General settings.',
          link: 'https://github.com/knowit/my-project/settings',
        },
        accept: [{ id: 'auto-delete', text: 'Merged branches are not deleted automatically.' }],
        apply: ['Turn on deleting merged branches automatically.'],
        handoff: [`gh api -X PATCH ${R} -F delete_branch_on_merge=true`],
      },
    );
    check(
      'protection: three things missing',
      await protection(
        ghDone({
          [`gh api ${R}`]: ok(META({ delete_branch_on_merge: false })),
          [`gh api ${R}/rules/branches/main`]: ok('[]'),
          [`gh api ${R}/private-vulnerability-reporting`]: ok(JSON.stringify({ enabled: false })),
        }),
      ),
      {
        status: 'fail',
        summary: '3 things are missing.',
        detail:
          'main does not require a pull request.\nMerged branches are not deleted automatically.\n' +
          'Private vulnerability reporting is off.',
        fix: RULESET_FIX,
        accept: [
          { id: 'auto-delete', text: 'Merged branches are not deleted automatically.' },
          { id: 'reporting', text: 'Private vulnerability reporting is off.' },
        ],
        apply: [
          'Add a ruleset: main takes changes only through a pull request that a person merges; admins may merge without an approval.',
          'Turn on deleting merged branches automatically.',
          'Turn on private vulnerability reporting.',
        ],
        // What "Make these changes" would run, for the prompt that hands the step to Claude Code.
        handoff: [
          `gh api -X POST ${R}/rulesets --input - <<'EOF'\n${RULESET_JSON}EOF`,
          `gh api -X PATCH ${R} -F delete_branch_on_merge=true`,
          `gh api -X PUT ${R}/private-vulnerability-reporting`,
        ],
      },
    );
    check(
      'protection: classic branch protection with required reviews counts',
      await protection(
        ghDone({
          [`gh api ${R}/rules/branches/main`]: ok('[]'),
          [`gh api ${R}/branches/main/protection`]: ok(
            JSON.stringify({
              required_pull_request_reviews: {
                required_approving_review_count: 1,
                dismiss_stale_reviews: true,
              },
            }),
          ),
        }),
      ),
      { status: 'pass', summary: 'main only changes through a pull request that a person merges.' },
    );
    // The lock is an approval that a new push dismisses, from whichever rule sets it (#30).
    const APPROVALS_FIX = {
      text:
        'Add the kit’s ruleset beside the rules main has: rules add up, so its one approval, dismissed on a new ' +
        'push, then holds. On the rulesets page choose New ruleset, then Import a ruleset, and give it this file:',
      copy: RULESET_JSON,
      download: { name: 'main-ruleset.json', text: RULESET_JSON },
      link: RULES,
    };
    const NO_APPROVAL =
      'main lets a pull request merge with no approval, so the board’s App could merge its own.';
    const approvalsFail = (text) => ({
      status: 'fail',
      summary: text,
      detail: text,
      fix: APPROVALS_FIX,
      apply: [
        'Add a ruleset beside the existing rules: a pull request into main needs a person’s approval, dismissed on a new push; admins may merge without one.',
      ],
      handoff: [`gh api -X POST ${R}/rulesets --input - <<'EOF'\n${RULESET_JSON}EOF`],
    });
    // Classic branch protection only: no ruleset applies, and the protection answers with `reviews`.
    const classicWith = (reviews) => ({
      [`gh api ${R}/rules/branches/main`]: ok('[]'),
      [`gh api ${R}/branches/main/protection`]: ok(
        JSON.stringify({ required_pull_request_reviews: reviews }),
      ),
    });
    const rulesWith = (...parameters) =>
      ok(
        JSON.stringify(
          parameters.map((p) => ({ type: 'pull_request', ruleset_id: 9, ...(p ? { parameters: p } : {}) })),
        ),
      );
    check(
      'protection: a pull-request rule with 0 approvals fails, and the button adds the kit’s ruleset',
      await protection(
        ghDone({
          [`gh api ${R}/rules/branches/main`]: rulesWith({ ...LOCK, required_approving_review_count: 0 }),
        }),
      ),
      approvalsFail(NO_APPROVAL),
    );
    check(
      'protection: a rule without parameters counts as 0 approvals',
      await protection(ghDone({ [`gh api ${R}/rules/branches/main`]: rulesWith(null) })),
      approvalsFail(NO_APPROVAL),
    );
    check(
      'protection: rules layer, so a 0-approval rule beside the lock passes',
      await protection(
        ghDone({
          [`gh api ${R}/rules/branches/main`]: rulesWith({ required_approving_review_count: 0 }, LOCK),
        }),
      ),
      { status: 'pass', summary: 'main only changes through a pull request that a person merges.' },
    );
    check(
      'protection: an approval that survives a new push fails',
      await protection(
        ghDone({
          [`gh api ${R}/rules/branches/main`]: rulesWith({ ...LOCK, dismiss_stale_reviews_on_push: false }),
        }),
      ),
      approvalsFail(
        'main keeps an approval after new commits are pushed, so the board’s App could push after a person approves and merge.',
      ),
    );
    check(
      'protection: classic protection with 0 approvals fails',
      await protection(
        ghDone(classicWith({ required_approving_review_count: 0, dismiss_stale_reviews: true })),
      ),
      approvalsFail(NO_APPROVAL),
    );
    check(
      'protection: the App on classic protection’s bypass list fails as a bypass',
      await protection(
        ghDone(
          classicWith({
            required_approving_review_count: 1,
            dismiss_stale_reviews: true,
            bypass_pull_request_allowances: { apps: [{ id: 123, slug: 'board' }] },
          }),
        ),
      ),
      {
        status: 'fail',
        summary: 'The board’s App is allowed past the lock, so it could merge on its own.',
        detail: 'The board’s App is allowed past the lock, so it could merge on its own.',
        fix: {
          text: 'Remove the App from the branch protection rule’s “Allow specified actors to bypass required pull requests” list.',
          link: 'https://github.com/knowit/my-project/settings/branches',
        },
      },
    );
    check(
      'protection: Actions allowed to approve pull requests is a note, not a failure',
      await protection(
        ghDone({
          [`gh api ${R}/actions/permissions/workflow`]: ok(
            JSON.stringify({ default_workflow_permissions: 'read', can_approve_pull_request_reviews: true }),
          ),
        }),
      ),
      {
        status: 'pass',
        summary: 'main only changes through a pull request that a person merges.',
        notes: [
          'GitHub Actions may approve pull requests here (Settings, Actions, General). A workflow whose token can write pull requests could then approve one the App opened. The kit’s ci.yml reads only; keep any other workflow that way, or turn the setting off.',
        ],
      },
    );
    check(
      'protection: rulesets not available on this plan is blocked, not unprotected',
      await protection(
        ghDone({
          [`gh api ${R}/rules/branches/main`]: {
            code: 1,
            stdout: JSON.stringify({
              message: 'Upgrade to GitHub Pro or make this repository public to enable this feature.',
            }),
            stderr:
              'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)',
          },
        }),
      ),
      {
        status: 'blocked',
        summary: 'GitHub does not offer rulesets for this repository on its current plan.',
        detail: 'Upgrade to GitHub Pro or make this repository public to enable this feature.',
        fix: {
          text: 'Protect main with a classic branch protection rule that requires a pull request instead, or make the repository public, then check again.',
          link: 'https://github.com/knowit/my-project/settings/branches',
        },
      },
    );
    // Private vulnerability reporting exists only for public repositories: on an internal or private one
    // GitHub answers 404, and the page sent the tech lead to a billed Code Security screen (#18, snag 4).
    for (const visibility of ['internal', 'private']) {
      const ctx = fakeContext({
        files: { '.env.github': GH_ENV },
        commands: ghDone({ [`gh api ${R}`]: ok(META({ visibility })) }),
      });
      check(
        `protection: a ${visibility} repository is not asked for vulnerability reporting`,
        [await checkProtection(ctx), ctx.calls.includes(`gh api ${R}/private-vulnerability-reporting`)],
        [
          {
            status: 'pass',
            summary: 'main only changes through a pull request that a person merges.',
            notes: [PVR_NOTE],
          },
          false,
        ],
      );
    }
    {
      // An accepted problem is a note, not a failure; the bypass is never acceptable (#18, snag 5).
      const files = {
        '.env.github': GH_ENV,
        'docs/DECISIONS.md': `# Decisions\n\n${RISKS_HEAD}- \`setup:protection/auto-delete\` Merged branches are not deleted automatically. Accepted because: we prune by hand (weekly). (Ada Lovelace, 2026-10-28)\n`,
      };
      check(
        'protection: an accepted problem leaves the step passing, with a note',
        await checkProtection(
          fakeContext({
            files,
            commands: ghDone({ [`gh api ${R}`]: ok(META({ delete_branch_on_merge: false })) }),
          }),
        ),
        {
          status: 'pass',
          summary: 'main only changes through a pull request that a person merges.',
          accepted: [
            'Merged branches are not deleted automatically. Accepted because: we prune by hand (weekly).',
          ],
        },
      );
      check(
        'protection: the bypass is offered no accept, beside an accepted problem',
        await checkProtection(
          fakeContext({
            files,
            commands: ghDone({
              [`gh api ${R}`]: ok(META({ delete_branch_on_merge: false })),
              [`gh api ${R}/rulesets/9`]: ok(
                JSON.stringify({ bypass_actors: [{ actor_id: 123, actor_type: 'Integration' }] }),
              ),
            }),
          }),
        ),
        {
          status: 'fail',
          summary: 'The board’s App is allowed past the lock, so it could merge on its own.',
          detail: 'The board’s App is allowed past the lock, so it could merge on its own.',
          fix: { text: 'Remove the App from the ruleset’s bypass list.', link: RULES },
          accepted: [
            'Merged branches are not deleted automatically. Accepted because: we prune by hand (weekly).',
          ],
        },
      );
    }
    {
      const commands = {
        'git config user.name': ok('Ada Lovelace\n'),
      };
      const NOW = () => new Date('2026-10-28T12:00:00Z');
      const ctx = fakeContext({
        files: { '.env.github': GH_ENV, 'docs/DECISIONS.md': '# Decisions\n' },
        commands,
        now: NOW,
      });
      const first = await acceptProtectionRisk(ctx, {
        problem: 'auto-delete',
        reason: '  we prune\n by `hand`  ',
      });
      await acceptProtectionRisk(ctx, { problem: 'auto-delete', reason: 'again' });
      check(
        'accept: records the risk once in DECISIONS.md, with who and when',
        [first, ctx.read('docs/DECISIONS.md')],
        [
          { status: 'pass', summary: 'Recorded in docs/DECISIONS.md. Commit it, so the team sees it too.' },
          `# Decisions\n\n${RISKS_HEAD}- \`setup:protection/auto-delete\` Merged branches are not deleted automatically. Accepted because: we prune by hand. (Ada Lovelace, 2026-10-28)\n`,
        ],
      );
      const refused = fakeContext({ files: { 'docs/DECISIONS.md': '# Decisions\n' }, commands, now: NOW });
      check(
        'accept: the bypass, an unknown problem and an empty reason are refused, and nothing is written',
        [
          await acceptProtectionRisk(refused, { problem: 'bypass', reason: 'fine' }),
          await acceptProtectionRisk(refused, { problem: 'constructor', reason: 'fine' }),
          await acceptProtectionRisk(refused, { problem: 'reporting', reason: '   ' }),
          refused.writes,
        ],
        [
          {
            status: 'fail',
            summary: 'This one cannot be accepted: it is what keeps a person in charge of merging.',
          },
          {
            status: 'fail',
            summary: 'This one cannot be accepted: it is what keeps a person in charge of merging.',
          },
          { status: 'fail', summary: 'Say in a few words why this risk is fine for your project.' },
          {},
        ],
      );
    }
    {
      // One press sets up what is missing, with the tech lead's own gh login; the bypass stays by hand.
      const ctx = fakeContext({
        files: { '.env.github': GH_ENV },
        commands: ghDone({
          [`gh api ${R}`]: ok(META({ delete_branch_on_merge: false })),
          [`gh api ${R}/rules/branches/main`]: ok('[]'),
          [`gh api ${R}/private-vulnerability-reporting`]: ok(JSON.stringify({ enabled: false })),
          [`gh api -X POST ${R}/rulesets --input .git/kit-setup-ruleset.json`]: ok('{}'),
          [`gh api -X PATCH ${R} -F delete_branch_on_merge=true`]: ok('{}'),
          [`gh api -X PUT ${R}/private-vulnerability-reporting`]: ok(''),
        }),
      });
      check(
        'apply: writes the ruleset and runs exactly the three changes',
        [
          await applyProtection(ctx),
          ctx.writes['.git/kit-setup-ruleset.json'],
          ctx.calls.filter((c) => c.startsWith('gh api -X')),
        ],
        [
          { status: 'pass', summary: 'Done: 3 settings changed.' },
          RULESET_JSON,
          [
            `gh api -X POST ${R}/rulesets --input .git/kit-setup-ruleset.json`,
            `gh api -X PATCH ${R} -F delete_branch_on_merge=true`,
            `gh api -X PUT ${R}/private-vulnerability-reporting`,
          ],
        ],
      );
      const denied = fakeContext({
        files: { '.env.github': GH_ENV },
        commands: ghDone({
          [`gh api ${R}`]: ok(META({ delete_branch_on_merge: false })),
          [`gh api -X PATCH ${R} -F delete_branch_on_merge=true`]: fail(
            1,
            'gh: Must have admin rights to Repository. (HTTP 403)\n',
          ),
        }),
      });
      check('apply: a refused change says which, and what GitHub said', await applyProtection(denied), {
        status: 'fail',
        summary: 'GitHub refused 1 of 1 changes.',
        detail:
          'Turn on deleting merged branches automatically. gh: Must have admin rights to Repository. (HTTP 403)',
      });
    }
    {
      // GitHub leaves out what a login without admin rights may not see, so its absence is "cannot see",
      // never "off": a member who is not an admin was told three things were missing that were fine.
      const member = (over = {}) =>
        protection(
          ghDone({
            [`gh api ${R}`]: ok(
              JSON.stringify({ default_branch: 'main', visibility: 'public', permissions: { admin: false } }),
            ),
            [`gh api ${R}/rulesets/9`]: ok(JSON.stringify({ id: 9 })),
            [`gh api ${R}/private-vulnerability-reporting`]: fail(1, 'gh: Not Found (HTTP 404)\n'),
            ...over,
          }),
        );
      const UNSEEN =
        'Your GitHub login is not an admin of knowit/my-project, so it cannot see: whether merged branches ' +
        'are deleted automatically, the ruleset’s bypass list, private vulnerability reporting.';
      check(
        'protection: a login without admin rights is blocked on what it cannot see, not failed',
        await member(),
        {
          status: 'blocked',
          summary: 'The guide cannot see all of this step with your GitHub login.',
          detail: UNSEEN,
          fix: {
            text: 'Ask an admin of the repository to open this step, or to check these settings for you.',
            link: 'https://github.com/knowit/my-project/settings',
          },
        },
      );
      check(
        'protection: without admin rights, a problem it can see still fails, with what it cannot see noted',
        await member({ [`gh api ${R}/rules/branches/main`]: ok('[]') }),
        {
          status: 'fail',
          summary: 'main does not require a pull request.',
          detail: 'main does not require a pull request.',
          fix: RULESET_FIX,
          // No ruleset yet, so no bypass list to be unable to see.
          notes: [
            'Your GitHub login is not an admin of knowit/my-project, so it cannot see: whether merged ' +
              'branches are deleted automatically, private vulnerability reporting.',
          ],
          apply: [
            'Add a ruleset: main takes changes only through a pull request that a person merges; admins may merge without an approval.',
          ],
          handoff: [`gh api -X POST ${R}/rulesets --input - <<'EOF'\n${RULESET_JSON}EOF`],
        },
      );
    }
    const glProtect = (mergeLevel) =>
      checkProtection(
        fakeContext({
          files: { '.env.gitlab': GL_ENV },
          commands: {
            'glab api projects/7': ok(
              JSON.stringify({ default_branch: 'main', remove_source_branch_after_merge: true }),
            ),
            'glab api projects/7/protected_branches/main': ok(
              JSON.stringify({
                push_access_levels: [{ access_level: 0 }],
                merge_access_levels: [{ access_level: mergeLevel }],
              }),
            ),
          },
        }),
      );
    check('protection: GitLab, push to main is no one', await glProtect(40), {
      status: 'pass',
      summary: 'main only changes through a merge request that a person merges.',
    });
    check(
      'protection: GitLab, Developers allowed to merge fails: the merge-request token is a Developer',
      await glProtect(30),
      {
        status: 'fail',
        summary: 'Developers may merge into main, so the board’s merge-request token could merge its own.',
        detail: 'Developers may merge into main, so the board’s merge-request token could merge its own.',
        fix: { text: 'Protect main with “Allowed to merge: Maintainers”.' },
      },
    );
  }

  return failed;
}

// Run directly, this module would otherwise define `setupSelftest()`, print nothing and exit 0: a green that
// checked nothing. `import.meta.main` would say the same, but needs a newer Node than the kit's 22.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let failed = await setupSelftest();
  // Each step module past the first four keeps its cases in `<module>.selftest.mjs`, default-exporting
  // `async (check) => void`. Found by name, so adding one needs no edit here.
  for (const f of fs
    .readdirSync(HERE)
    .filter((n) => n.endsWith('.selftest.mjs'))
    .sort()) {
    let n = 0;
    const check = (name, got, want) => {
      if (JSON.stringify(got) === JSON.stringify(want)) console.log(`✓ ${name}`);
      else {
        n++;
        console.error(`✗ ${name}:\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
      }
    };
    await (await import(`./${f}`)).default(check);
    failed += n;
  }
  if (failed) console.error(`${failed} setup check(s) failed`);
  process.exitCode = failed ? 1 : 0;
}

// Step 2's home online, and the hand-off to Claude Code every fix offers (#18, second walk). Found by
// selftest.mjs by name.

import { checkHistory } from './checks.mjs';
import { fakeContext } from './fake.mjs';
import { claudePrompt, oneLine, repoCreateCommand } from './page/handoff.mjs';
import { createRemote, parseRepo, useRemote } from './remote.mjs';

const ok = (o = '') => ({ code: 0, stdout: typeof o === 'string' ? o : JSON.stringify(o), stderr: '' });
const fail = (code, stderr) => ({ code, stdout: '', stderr });
const HOOKS = { '.git/hooks/pre-commit': '#!/bin/sh', '.git/hooks/commit-msg': '#!/bin/sh' };
const PKG = JSON.stringify({ version: '0.1.0' });

export default async function (check) {
  // ---- the hand-off: one line, and a prompt for Claude Code ------------------------------------------------
  check(
    'handoff: commands joined into one line',
    oneLine(['git add -A', 'git commit -m "x"']),
    'git add -A && git commit -m "x"',
  );
  check('handoff: one command stays itself', oneLine(['git push']), 'git push');
  check(
    'handoff: the prompt names the step, what was found, and the commands, in order',
    claudePrompt({
      title: 'Your repository',
      result: {
        summary: 'Nothing is committed yet.',
        fix: { commands: ['git add -A', 'git commit -m "chore: start from the Factory Kit 0.1.0"'] },
      },
    }),
    [
      'The Factory Kit setup guide is open, at its step "Your repository". It says: Nothing is committed yet.',
      '',
      'Run these in this folder, in this order, and stop at the first one that fails:',
      '',
      'git add -A',
      'git commit -m "chore: start from the Factory Kit 0.1.0"',
      '',
      'Then tell me what happened. I will press "Check again" in the guide.',
    ].join('\n'),
  );
  check(
    'handoff: a step with no commands of its own hands over the ones it would run itself',
    claudePrompt({
      title: 'The lock on main',
      result: {
        summary: '2 things are missing.',
        fix: { text: 'Open the page' },
        handoff: ['gh api a', 'gh api b'],
      },
    }),
    [
      'The Factory Kit setup guide is open, at its step "The lock on main". It says: 2 things are missing.',
      '',
      'Run these in this folder, in this order, and stop at the first one that fails:',
      '',
      'gh api a',
      'gh api b',
      '',
      'Then tell me what happened. I will press "Check again" in the guide.',
    ].join('\n'),
  );
  check(
    'handoff: a fix whose text to copy is a prompt hands over that prompt as it is',
    claudePrompt({
      title: 'Your project',
      result: { summary: 's', fix: { copy: 'Use the start-project skill.', forClaude: true } },
    }),
    'Use the start-project skill.',
  );
  check(
    'handoff: no prompt for a fix that stays with the person, or one with no commands',
    [
      claudePrompt({
        title: 'x',
        result: { summary: 's', fix: { commands: ['rm -rf .git'], byHand: true } },
      }),
      claudePrompt({ title: 'x', result: { summary: 's', fix: { text: 'Open the page' } } }),
    ],
    [null, null],
  );
  check(
    'handoff: the create command',
    repoCreateCommand({ owner: 'knowit', name: 'orchard', visibility: 'internal' }),
    'gh repo create knowit/orchard --internal --source=. --remote=origin',
  );

  // ---- step 2 offers to connect a home when gh can --------------------------------------------------------
  const noRemote = (commands) =>
    checkHistory(
      fakeContext({
        files: { 'package.json': PKG, ...HOOKS },
        commands: {
          'git log --format=%s': ok('Initial commit\n'),
          // A template's single commit, so step 2 goes on past the history checks to the remote.
          'git rev-list --count HEAD': ok('1\n'),
          'git remote': ok(''),
          ...commands,
        },
      }),
    );
  check(
    'history: no remote, with gh logged in, offers the login and its organisations as owners',
    (
      await noRemote({
        'gh api user': ok({ login: 'ada' }),
        'gh api user/orgs': ok([{ login: 'knowit' }, { login: 'acme' }]),
      })
    ).connect,
    { owners: ['ada', 'knowit', 'acme'], name: 'repo' },
  );
  check(
    'history: no remote, no gh: nothing to offer beyond the steps',
    (await noRemote({})).connect,
    undefined,
  );

  // ---- parsing what the person pastes ----------------------------------------------------------------------
  check(
    'remote: owner/name, https and ssh URLs parse; anything else does not',
    [
      parseRepo('knowit/orchard'),
      parseRepo(' https://github.com/knowit/orchard.git '),
      parseRepo('https://github.com/knowit/orchard'),
      parseRepo('git@github.com:knowit/orchard.git'),
      parseRepo('https://gitlab.com/knowit/orchard'),
      parseRepo('knowit/orchard; rm -rf ~'),
      parseRepo(''),
    ],
    ['knowit/orchard', 'knowit/orchard', 'knowit/orchard', 'knowit/orchard', null, null, null],
  );

  // ---- create a new one -------------------------------------------------------------------------------------
  {
    const CREATE = 'gh repo create knowit/orchard --private --source=. --remote=origin';
    const ctx = fakeContext({
      commands: { 'git remote': ok(''), [CREATE]: ok('https://github.com/knowit/orchard\n') },
    });
    check(
      'remote: create runs exactly gh repo create, with the source and the remote',
      [await createRemote(ctx, { owner: 'knowit', name: 'orchard', visibility: 'private' }), ctx.calls],
      [
        { status: 'pass', summary: 'Created knowit/orchard and connected it as origin.' },
        ['git remote', CREATE],
      ],
    );
    const refused = fakeContext({ commands: { 'git remote': ok('') } });
    check(
      'remote: create refuses a bad owner, name or visibility, and runs nothing',
      [
        await createRemote(refused, { owner: 'knowit;rm', name: 'orchard', visibility: 'private' }),
        await createRemote(refused, { owner: 'knowit', name: '../x', visibility: 'private' }),
        await createRemote(refused, { owner: 'knowit', name: 'orchard', visibility: 'secret' }),
        refused.calls,
      ],
      [
        {
          status: 'fail',
          summary: 'Give an owner and a name made of letters, digits, dots, dashes and underscores.',
        },
        {
          status: 'fail',
          summary: 'Give an owner and a name made of letters, digits, dots, dashes and underscores.',
        },
        { status: 'fail', summary: 'Choose private, internal or public.' },
        [],
      ],
    );
    const connected = fakeContext({ commands: { 'git remote': ok('origin\n') } });
    check(
      'remote: create refuses when origin is already set',
      await createRemote(connected, { owner: 'knowit', name: 'orchard', visibility: 'private' }),
      { status: 'fail', summary: 'This folder is already connected (origin is set).' },
    );
    const gone = fakeContext({
      commands: { 'git remote': ok(''), [CREATE]: fail(1, 'GraphQL: Name already exists on this account\n') },
    });
    check(
      'remote: a refused create says what GitHub said',
      await createRemote(gone, { owner: 'knowit', name: 'orchard', visibility: 'private' }),
      {
        status: 'fail',
        summary: 'GitHub did not create it.',
        detail: 'GraphQL: Name already exists on this account',
      },
    );
  }

  // ---- use one already there --------------------------------------------------------------------------------
  {
    const R = 'repos/knowit/orchard';
    const META = ok({
      ssh_url: 'git@github.com:knowit/orchard.git',
      clone_url: 'https://github.com/knowit/orchard.git',
    });
    const use = (commands) =>
      fakeContext({ commands: { 'git remote': ok(''), [`gh api ${R}`]: META, ...commands } });

    const empty = use({
      [`gh api ${R}/commits`]: fail(1, 'gh: Git Repository is empty. (HTTP 409)\n'),
      'gh config get git_protocol': ok('ssh\n'),
      'git remote add origin git@github.com:knowit/orchard.git': ok(),
    });
    check(
      'remote: an empty repository is connected, over the protocol gh uses',
      [await useRemote(empty, { repo: 'knowit/orchard' }), empty.calls.at(-1)],
      [
        { status: 'pass', summary: 'Connected knowit/orchard as origin.' },
        'git remote add origin git@github.com:knowit/orchard.git',
      ],
    );
    const https = use({
      [`gh api ${R}/commits`]: fail(1, 'gh: Git Repository is empty. (HTTP 409)\n'),
      'gh config get git_protocol': ok('https\n'),
      'git remote add origin https://github.com/knowit/orchard.git': ok(),
    });
    check(
      'remote: https when gh uses https',
      (await useRemote(https, { repo: 'knowit/orchard' })).status,
      'pass',
    );
    // A pasted address says how the person reaches GitHub; gh's setting is only the fallback.
    const pasted = use({
      [`gh api ${R}/commits`]: fail(1, 'gh: Git Repository is empty. (HTTP 409)\n'),
      'gh config get git_protocol': ok('\n'),
      'git remote add origin git@github.com:knowit/orchard.git': ok(),
    });
    check(
      'remote: a pasted ssh address is connected over ssh, whatever gh says',
      [(await useRemote(pasted, { repo: 'git@github.com:knowit/orchard.git' })).status, pasted.calls.at(-1)],
      ['pass', 'git remote add origin git@github.com:knowit/orchard.git'],
    );

    const full = use({ [`gh api ${R}/commits`]: ok([{ sha: 'abc' }]) });
    check(
      'remote: a repository with commits is not connected, and says why',
      [
        await useRemote(full, { repo: 'knowit/orchard' }),
        full.calls.some((c) => c.startsWith('git remote add')),
      ],
      [
        {
          status: 'fail',
          summary: 'knowit/orchard already has commits, so the guide will not connect it.',
          detail:
            'Pushing this project onto it would mean a force push, or merging two unrelated histories, and the ' +
            'guide does neither. Create a new empty repository instead, or empty that one yourself first: ' +
            'only its owner should delete its history.',
        },
        false,
      ],
    );
    check(
      'remote: a repository gh cannot see',
      await useRemote(
        fakeContext({
          commands: { 'git remote': ok(''), [`gh api ${R}`]: fail(1, 'gh: Not Found (HTTP 404)\n') },
        }),
        {
          repo: 'knowit/orchard',
        },
      ),
      {
        status: 'fail',
        summary: 'GitHub has no knowit/orchard that your login can see.',
        detail: 'gh: Not Found (HTTP 404)',
      },
    );
    check(
      'remote: something that is not a repository runs nothing',
      await useRemote(fakeContext(), { repo: 'not a repo' }),
      { status: 'fail', summary: 'Paste the repository as owner/name, or its GitHub address.' },
    );
  }
}

// The setup guide's checks: the shape every step answers in, the context they run against, and steps 1 and 2.
// DEVELOPER TOOLING, Node built-ins only, like the rest of `scripts/`: the guide has to run before
// `pnpm install` has worked, because getting `pnpm install` to work is one of the things it guides.
//
// A check never changes anything. It reads files and runs read-only commands through the context, and says
// what it found in a `Result`:
//
//   { status: 'pass' | 'fail' | 'blocked' | 'todo', summary, detail?, fix?: { text, commands?, link? } }
//
// `todo` is a step not done yet, `fail` is a step done wrongly, and `blocked` is a step the guide cannot
// check right now (no network, a missing CLI) — never reported as `fail`, because "your setup is wrong" when
// the VPN is down sends the tech lead to fix something that is fine. The words are for a person who has never
// seen this kit: `summary` says what is true, `fix` says what to do about it.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { remoteOptions } from './remote.mjs';

/**
 * The only door a check has to the machine. `sh` runs a program with arguments (never a shell string) and
 * resolves, never rejects, with `{ code, stdout, stderr }`; a missing program answers code 127, like a shell.
 * `env` is the environment the guide was started with, and `now` the clock, so a selftest can fix both.
 */
export function makeContext({ root, sh, read, write, env = {}, now = () => new Date() }) {
  return { root, sh, read, write, env, now };
}

/** The context the server runs checks against: this repository, on this machine. */
export function realContext(root) {
  return makeContext({
    root,
    sh: (cmd, args = []) =>
      new Promise((resolve) => {
        execFile(
          cmd,
          args,
          { cwd: root, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
          (err, stdout, stderr) => {
            const code = err
              ? err.code === 'ENOENT'
                ? 127
                : typeof err.code === 'number'
                  ? err.code
                  : 1
              : 0;
            resolve({ code, stdout: String(stdout), stderr: String(stderr) });
          },
        );
      }),
    read: (rel) => {
      try {
        return fs.readFileSync(path.join(root, rel), 'utf8');
      } catch {
        return null;
      }
    },
    write: (rel, text) => fs.writeFileSync(path.join(root, rel), text),
    env: process.env,
  });
}

/** A `[tools]` pin from mise.toml: `node = "22"` → `'22'`. */
function pin(mise, tool) {
  return mise?.match(new RegExp(`^\\s*${tool}\\s*=\\s*["']([^"']+)["']`, 'm'))?.[1] ?? null;
}

const MISE_FIX = {
  text: 'mise installs the versions this project pins. Run this in the repository, then check again.',
  commands: ['mise install'],
};

// The line that makes a shell activate mise in every new terminal, per shell `mise activate` knows.
const ACTIVATE = {
  zsh: `echo 'eval "$(mise activate zsh)"' >> ~/.zshrc`,
  bash: `echo 'eval "$(mise activate bash)"' >> ~/.bashrc`,
  fish: "echo 'mise activate fish | source' >> ~/.config/fish/config.fish",
};

/**
 * mise has the pinned version, but the terminal the guide was started from never activated mise, so the
 * PATH finds another node first (Homebrew's, say). `mise install` answers "all tools are installed" and
 * changes nothing; what helps is the one line that activates mise in the person's shell.
 */
function shellFix(ctx, tool, have, want) {
  const shell = path.basename(ctx.env.SHELL ?? '');
  return {
    status: 'fail',
    summary: have
      ? `This terminal is not using mise, so it runs ${tool} ${have} instead of ${tool} ${want}`
      : `This terminal is not using mise, so it cannot find ${tool} ${want}`,
    detail:
      'mise has installed the right versions, but this terminal does not use them yet. One line in your ' +
      'shell’s settings makes every new terminal use them.',
    fix: ACTIVATE[shell]
      ? {
          // Under Claude Code, a `!` command inherits Claude Code's environment, not the shell's new settings.
          text:
            ctx.env.CLAUDECODE === '1'
              ? 'Run this once. Then quit Claude Code, open a new terminal in this folder, start Claude Code again from it, and start the guide again:'
              : 'Run this once, open a new terminal in this folder, and start pnpm kit:setup again from it:',
          commands: [ACTIVATE[shell]],
        }
      : {
          text: 'Set your shell up to activate mise, open a new terminal in this folder, and start pnpm kit:setup again from it.',
          link: 'https://mise.jdx.dev/getting-started.html#activate-mise',
        },
  };
}

/** Step 1: node and pnpm at the versions `mise.toml` pins. Node by major, pnpm exactly, as mise.toml says. */
export async function checkToolchain(ctx) {
  const mise = ctx.read('mise.toml');
  const want = { node: pin(mise, 'node'), pnpm: pin(mise, 'pnpm') };
  const version = (r) => (r.code === 0 ? r.stdout.trim().replace(/^v/, '') : null);
  const matches = (tool, v) =>
    tool === 'node' ? v.split('.')[0] === want.node.split('.')[0] : v === want.pnpm;
  for (const tool of ['node', 'pnpm']) {
    const have = version(await ctx.sh(tool, ['--version']));
    if (have && matches(tool, have)) continue;
    const viaMise = version(await ctx.sh('mise', ['exec', '--', tool, '--version']));
    if (viaMise && matches(tool, viaMise)) return shellFix(ctx, tool, have, want[tool]);
    return {
      status: 'fail',
      summary: have
        ? `${tool} ${have} is installed, but this project uses ${tool} ${want[tool]}`
        : `${tool} is not installed, and this project uses ${tool} ${want[tool]}`,
      fix: MISE_FIX,
    };
  }
  return { status: 'pass', summary: `node ${want.node} and pnpm ${want.pnpm} are installed` };
}

const KIT_COMMIT = /^chore: start from the Factory Kit (\S+)/m;
// `pnpm kit:adopt`'s commit. A squash merge keeps the subject and adds ` (#n)`, which `\S+` stops before.
const ADOPT_COMMIT = /^chore: adopt the Factory Kit (\S+)/m;
// The kit's root commit, which only the kit's own history has: a clone, a fork or a mirror keeps it. The
// kit's main is never rewritten, so releases do not move it; a re-extraction of the kit must update it.
// docs/DECISIONS.md, "How the setup guide recognises the kit's history".
export const KIT_ROOT = '6a7167d55b260589281ffc6bbc0d4b77fa32a2b1';

/**
 * Step 2: the kit's history replaced by the project's own, the hooks installed, the start commit made and
 * pushed. In that order, because each fix assumes the one before it is done.
 *
 * The guide never deletes `.git` itself. It is the one step here that cannot be undone, and it would be run
 * by a server living inside the folder it deletes; so the check says what to run and the person runs it.
 */
export async function checkHistory(ctx) {
  const pkg = JSON.parse(ctx.read('package.json') ?? '{}');
  // An adopted project's package.json is its own, so its `version` is the project's; the kit's is recorded
  // in `factoryKit.kit`. A fresh start's package.json is the kit's, and has no such key.
  const version = pkg.factoryKit?.kit ?? pkg.version ?? '<version>';
  const log = await ctx.sh('git', ['log', '--format=%s']);
  const subjects = log.code === 0 ? log.stdout : '';
  const started = KIT_COMMIT.exec(subjects);
  // Adopted: the adoption's record, or its commit where the record is not in this checkout's files.
  const adopted = started ? null : (pkg.factoryKit?.kit ?? ADOPT_COMMIT.exec(subjects)?.[1] ?? null);

  const subject = `chore: start from the Factory Kit ${version}`;
  const git = async (...args) => (await ctx.sh('git', args)).stdout.trim();

  // Only a history with no start commit is asked where it came from: a started project never is, and an
  // adopted one keeps its own history by design (docs/adr/0006-adoption-writes-only-on-a-branch.md).
  const unstarted = !started && !adopted && subjects.trim();
  if (unstarted) {
    if ((await git('rev-parse', '--is-shallow-repository')) === 'true') {
      // A shallow clone's only root is its boundary, so the root test below cannot tell it from a template.
      return {
        status: 'todo',
        summary: 'This is a shallow clone, so the guide cannot see where its history starts.',
        fix: { text: 'Fetch the rest of it, then check again:', commands: ['git fetch --unshallow'] },
      };
    }
    // The kit's root and no other: a project that merged the kit in has a root of its own as well.
    if ((await git('rev-list', '--max-parents=0', 'HEAD')) === KIT_ROOT) {
      return {
        status: 'fail',
        summary: "This folder still carries the kit's own history. The guide will not delete it for you.",
        detail:
          'A new project starts with a clean history. Deleting the .git folder cannot be undone, so run ' +
          'these yourself, in this folder, then check again.',
        fix: {
          text: 'Start a fresh history, then reinstall the git hooks:',
          commands: ['rm -rf .git && git init -b main', 'mise exec -- pnpm install'],
          byHand: true,
        },
      };
    }
    // More than one commit, no start commit, and not the kit's: somebody's existing project. A template
    // repository's single "Initial commit" goes on to the start commit below. A failed count is not 1.
    if ((await git('rev-list', '--count', 'HEAD')) !== '1') {
      return {
        status: 'fail',
        summary:
          "This history is not the kit's, and it has no start commit. The guide sets up new projects, " +
          'and does not change an existing one.',
        detail:
          'To start a new project, copy the kit into a folder of its own: "Copy the kit", under ' +
          '"Start a project" in the README, says how.',
        fix: {
          // Text, not commands: nothing to run with one press, since it is only right for a new project.
          text:
            'If this is a new project and these commits are your own, make the start commit yourself, then ' +
            `check again: git add -A && git commit --allow-empty -m "${subject}"`,
          byHand: true,
        },
      };
    }
  }
  // Where git looks for hooks: `.git/hooks`, unless Husky's `core.hooksPath` or a worktree says otherwise.
  const where = await ctx.sh('git', ['rev-parse', '--path-format=relative', '--git-path', 'hooks']);
  const hooks = (where.code === 0 && where.stdout.trim()) || '.git/hooks';
  if (!ctx.read(`${hooks}/pre-commit`) || !ctx.read(`${hooks}/commit-msg`)) {
    return {
      status: 'fail',
      summary: 'The git hooks are not installed, so nothing checks a commit before it is made.',
      fix: adopted
        ? adoptedHooksFix(ctx, pkg)
        : { text: 'Install them:', commands: ['mise exec -- pnpm install'] },
    };
  }
  if (!(await git('remote'))) {
    // With gh logged in, the page offers to create the repository, or connect an empty one, in one press.
    const connect = await remoteOptions(ctx);
    return {
      status: 'todo',
      summary: 'This repository has no home on GitHub or GitLab yet.',
      fix: {
        text:
          'Create an empty repository (no README, no licence) on GitHub or an empty project on GitLab, ' +
          'then connect it:',
        commands: ['git remote add origin <the URL it shows you>'],
        link: 'https://github.com/new',
        // A placeholder to fill in: nothing Claude Code could run as it stands.
        byHand: true,
      },
      ...(connect ? { connect } : {}),
    };
  }
  if (adopted) return adoptionMerged(ctx, adopted);
  if (unstarted) {
    // A template-repository clone arrives with an "Initial commit" and nothing to stage, and `git commit`
    // refuses an empty commit unless asked: the start commit then marks the version and carries nothing.
    const clean = !(await git('status', '--porcelain'));
    const commit = `git commit${clean ? ' --allow-empty' : ''} -m "${subject}"`;
    return {
      status: 'todo',
      summary: 'The commit that names the kit version is not made yet.',
      fix: {
        text: 'Make it. It names the kit version, so a later update knows where you started:',
        commands: clean ? [commit] : ['git add -A', commit],
      },
    };
  }
  if (!started) {
    return {
      status: 'todo',
      summary: 'Nothing is committed yet.',
      fix: {
        text: 'Make the first commit. It names the kit version, so a later update knows where you started:',
        commands: ['git add -A', `git commit -m "${subject}"`],
      },
    };
  }
  if ((await ctx.sh('git', ['rev-parse', '--abbrev-ref', '@{u}'])).code !== 0) {
    // The branch this folder is on, which is main unless the person chose otherwise.
    const branch = (await git('branch', '--show-current')) || 'main';
    return {
      status: 'todo',
      summary: 'The first commit is only on this computer.',
      fix: {
        text: 'Push it, so the next steps have a main branch to work with:',
        commands: [`git push -u origin ${branch}`],
      },
    };
  }
  const ahead = Number((await git('rev-list', '--count', '@{u}..HEAD')) || 0);
  if (ahead > 0) {
    return {
      status: 'todo',
      summary: `${ahead} commit${ahead === 1 ? ' is' : 's are'} only on this computer.`,
      fix: { text: ahead === 1 ? 'Push it:' : 'Push them:', commands: ['git push'] },
    };
  }
  return {
    status: 'pass',
    summary: `A fresh history, started from the Factory Kit ${started[1]}, is pushed.`,
  };
}

/**
 * The hooks of an adopted project, installed by the manager it already had. Under Husky or pre-commit,
 * lefthook is not installed (`pnpm kit:adopt` hands each of their hooks over to `lefthook run` instead), so
 * the kit's own install would not put them back.
 */
function adoptedHooksFix(ctx, pkg) {
  if (ctx.read('.pre-commit-config.yaml') !== null) {
    return {
      text: 'pre-commit runs this project’s hooks. Install them with it:',
      commands: ['pre-commit install'],
    };
  }
  if (ctx.read('.husky/pre-commit') !== null || ctx.read('.husky/commit-msg') !== null || pkg.husky) {
    // Husky installs itself from the project's own `prepare`, so the project's own install puts it back.
    const lock = [
      ['pnpm-lock.yaml', 'pnpm'],
      ['yarn.lock', 'yarn'],
      ['package-lock.json', 'npm'],
    ].find(([file]) => ctx.read(file) !== null)?.[1];
    const manager = pkg.packageManager?.split('@')[0] ?? lock;
    const install = { pnpm: 'mise exec -- pnpm install', yarn: 'yarn install', npm: 'npm install' }[manager];
    return install
      ? {
          text: 'Husky runs this project’s hooks. The project’s own install sets them up:',
          commands: [install],
        }
      : {
          text: 'Husky runs this project’s hooks. Run the project’s own install, which sets them up.',
          byHand: true,
        };
  }
  // lefthook, from the kit's package: the root's on pnpm, `factoryKit.package` beside an npm or yarn root.
  const dir = pkg.factoryKit?.package;
  return {
    text: 'Install them:',
    commands: [dir ? `mise exec -- pnpm --dir ${dir} install` : 'mise exec -- pnpm install'],
  };
}

/**
 * Step 2 on a repository that adopted the kit: done once the adoption is on the remote's default branch.
 * It gets there through a pull request, never a push: `pnpm kit:adopt` writes only on a branch of its own.
 * Merged means the default branch's package.json carries `factoryKit.kit`, which a squash merge keeps too.
 * The guide does not fetch, so a merge made on GitHub shows once this computer has fetched it.
 */
async function adoptionMerged(ctx, version) {
  const git = async (...args) => (await ctx.sh('git', args)).stdout.trim();
  const head = await ctx.sh('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
  const ref = (head.code === 0 && head.stdout.trim()) || 'origin/main';
  const main = ref.replace(/^origin\//, '');
  const shown = await ctx.sh('git', ['show', `${ref}:package.json`]);
  let merged = false;
  try {
    merged = shown.code === 0 && Boolean(JSON.parse(shown.stdout).factoryKit?.kit);
  } catch {
    // A default branch whose package.json does not parse has not taken the adoption.
  }
  if (merged) {
    return { status: 'pass', summary: `The Factory Kit ${version} is adopted, and merged into ${main}.` };
  }
  const branch = await git('branch', '--show-current');
  if (!branch || branch === main) {
    const adoption = `chore/adopt-factory-kit-${version}`;
    return {
      status: 'todo',
      summary: `The adoption is not on a branch of its own, and ${main} on the remote does not have it yet.`,
      detail: `The guide never pushes to ${main}: the adoption reaches it through a pull request, like any change.`,
      fix: {
        text:
          'Put it on a branch of its own and push that, then open a pull request from it: ' +
          `git switch -c ${adoption} && git push -u origin ${adoption}`,
        byHand: true,
      },
    };
  }
  if ((await ctx.sh('git', ['rev-parse', '--abbrev-ref', '@{u}'])).code !== 0) {
    return {
      status: 'todo',
      summary: `The adoption is on the branch ${branch}, which is only on this computer.`,
      fix: { text: 'Push it, then open a pull request from it:', commands: [`git push -u origin ${branch}`] },
    };
  }
  const ahead = Number((await git('rev-list', '--count', '@{u}..HEAD')) || 0);
  if (ahead > 0) {
    return {
      status: 'todo',
      summary: `${ahead} commit${ahead === 1 ? ' is' : 's are'} on ${branch} only on this computer.`,
      fix: { text: ahead === 1 ? 'Push it:' : 'Push them:', commands: ['git push'] },
    };
  }
  return {
    status: 'todo',
    summary: `The adoption is on the branch ${branch}, and not merged into ${main} yet.`,
    fix: {
      text: `Open a pull request from ${branch} and merge it once it is reviewed. Then fetch, and check again:`,
      commands: ['git fetch origin'],
    },
  };
}

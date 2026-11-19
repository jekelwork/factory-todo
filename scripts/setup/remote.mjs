// Step 2's home online: create an empty GitHub repository for this folder, or connect one the person
// already has, with their own `gh` login. Both create or change something outside this machine, so both run
// only when the person presses the button, after the page has said what it will do.
//
// An existing repository is connected only while it is empty. Putting this project's history onto one with
// commits takes a force push or a merge of two unrelated histories, and the guide does neither.

import path from 'node:path';
import { repoCreateCommand } from './page/handoff.mjs';

const json = (r) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
};

// GitHub's own rules for an owner and a repository name, narrowed: nothing here reaches a shell, but a
// name that is not one GitHub accepts should be refused before anything runs.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9._-]{1,100}$/;
const VISIBILITY = new Set(['private', 'internal', 'public']);

/** `owner/name`, from what a person pastes: `owner/name`, or a GitHub https or ssh address. */
export function parseRepo(text) {
  const t = String(text ?? '').trim();
  const m =
    /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(t) ??
    /^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?$/.exec(t) ??
    /^([^/\s:]+)\/([^/\s]+)$/.exec(t);
  if (!m) return null;
  const name = m[2].replace(/\.git$/, '');
  return OWNER.test(m[1]) && NAME.test(name) && name !== '.' && name !== '..' ? `${m[1]}/${name}` : null;
}

/** Who may own the new repository (the login, then its organisations) and a name to start from, or null. */
export async function remoteOptions(ctx) {
  const user = json(await ctx.sh('gh', ['api', 'user']));
  if (!user?.login) return null;
  const orgs = json(await ctx.sh('gh', ['api', 'user/orgs'])) ?? [];
  return { owners: [user.login, ...orgs.map((o) => o.login)], name: path.basename(ctx.root) };
}

const hasRemote = async (ctx) => Boolean((await ctx.sh('git', ['remote'])).stdout.trim());
const ALREADY = { status: 'fail', summary: 'This folder is already connected (origin is set).' };

/** Creates `owner/name`, empty, and connects it as origin. */
export async function createRemote(ctx, input) {
  const { owner, name, visibility } = input ?? {};
  if (!OWNER.test(String(owner)) || !NAME.test(String(name)) || name === '.' || name === '..') {
    return {
      status: 'fail',
      summary: 'Give an owner and a name made of letters, digits, dots, dashes and underscores.',
    };
  }
  if (!VISIBILITY.has(visibility)) return { status: 'fail', summary: 'Choose private, internal or public.' };
  if (await hasRemote(ctx)) return ALREADY;
  const [cmd, ...args] = repoCreateCommand({ owner, name, visibility }).split(' ');
  const r = await ctx.sh(cmd, args);
  if (r.code !== 0) return { status: 'fail', summary: 'GitHub did not create it.', detail: r.stderr.trim() };
  return { status: 'pass', summary: `Created ${owner}/${name} and connected it as origin.` };
}

/** Connects an existing repository as origin, if it is empty. */
export async function useRemote(ctx, input) {
  const repo = parseRepo(input?.repo);
  if (!repo) return { status: 'fail', summary: 'Paste the repository as owner/name, or its GitHub address.' };
  if (await hasRemote(ctx)) return ALREADY;
  const meta = await ctx.sh('gh', ['api', `repos/${repo}`]);
  if (meta.code !== 0) {
    return {
      status: 'fail',
      summary: `GitHub has no ${repo} that your login can see.`,
      detail: meta.stderr.trim(),
    };
  }
  // GitHub answers 409 "Git Repository is empty" for a repository with no commits at all.
  const commits = await ctx.sh('gh', ['api', `repos/${repo}/commits`]);
  if (commits.code !== 0 && !/empty|409/i.test(commits.stderr)) {
    return {
      status: 'fail',
      summary: `The guide could not read ${repo}’s history.`,
      detail: commits.stderr.trim(),
    };
  }
  if (commits.code === 0) {
    return {
      status: 'fail',
      summary: `${repo} already has commits, so the guide will not connect it.`,
      detail:
        'Pushing this project onto it would mean a force push, or merging two unrelated histories, and the ' +
        'guide does neither. Create a new empty repository instead, or empty that one yourself first: ' +
        'only its owner should delete its history.',
    };
  }
  const { ssh_url: ssh, clone_url: https } = json(meta) ?? {};
  // A pasted address says how this person reaches GitHub; otherwise follow gh's own setting.
  const pasted = String(input.repo).trim();
  const protocol = pasted.startsWith('git@')
    ? 'ssh'
    : pasted.startsWith('https://')
      ? 'https'
      : (await ctx.sh('gh', ['config', 'get', 'git_protocol'])).stdout.trim();
  const url = protocol === 'ssh' ? ssh : https;
  const r = await ctx.sh('git', ['remote', 'add', 'origin', url]);
  if (r.code !== 0)
    return { status: 'fail', summary: 'git did not add the remote.', detail: r.stderr.trim() };
  return { status: 'pass', summary: `Connected ${repo} as origin.` };
}

// Steps 3 and 5 of the setup guide: the board, and where CI runs. Both depend on which board this checkout
// uses, so they share `envStatus`.
//
// The board check runs `pnpm items list` and translates its failure line. It does not reimplement the
// adapters: the guide and the tooling must never disagree about whether the board works, and the only way to
// guarantee that is to ask the tooling. The translation reads the `work-items: <code> —` prefix that
// scripts/work-items.mjs prints for every BoardError, never the free text after it, which a provider can
// change.

const VARS = {
  github: ['GITHUB_REPOSITORY', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_APP_INSTALLATION_ID'],
  gitlab: ['GITLAB_URL', 'GITLAB_TOKEN', 'GITLAB_PROJECT_ID', 'GITLAB_MR_TOKEN'],
};
const NAME = { github: 'GitHub', gitlab: 'GitLab' };
const DOCS = 'docs/agents/issue-tracker.md';

/** `KEY=value` lines; an inline `# comment` after the value is not part of it, as in the example files. */
function parse(text) {
  const out = {};
  for (const line of (text ?? '').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/\s+#.*$/, '').trim();
  }
  return out;
}

/**
 * Which board this checkout uses and which of its settings are filled in. Only whether each is set: the
 * values go nowhere, because this answer is shown in the browser and one of them is the path to a key that
 * can write to the tracker.
 */
export function envStatus(ctx) {
  const files = { github: ctx.read('.env.github'), gitlab: ctx.read('.env.gitlab') };
  const conflict = files.github !== null && files.gitlab !== null;
  const provider = conflict
    ? null
    : files.github !== null
      ? 'github'
      : files.gitlab !== null
        ? 'gitlab'
        : null;
  const values = provider ? parse(files[provider]) : {};
  const vars = provider ? Object.fromEntries(VARS[provider].map((k) => [k, Boolean(values[k])])) : {};
  return { provider, conflict, vars };
}

/**
 * The board settings themselves, for the checks that need a repository name or an App id. Server-side
 * only: a check may use a value, and no `Result` may carry one.
 */
export function envValues(ctx) {
  const { provider } = envStatus(ctx);
  return { provider, values: provider ? parse(ctx.read(`.env.${provider}`)) : {} };
}

/** A `pnpm items` failure, in words a newcomer can act on. */
export function explainBoardError(stderr, _code, provider) {
  const name = NAME[provider] ?? 'the board';
  const line = stderr.split('\n').find((l) => l.startsWith('work-items:')) ?? stderr.trim();
  const kind = line.match(/^work-items: (\S+) —/)?.[1];

  // Exit 3 also covers a refused credential, so the kind decides, not the code.
  if (kind === 'timeout' || kind === 'network' || kind === 'rate-limited') {
    return {
      status: 'blocked',
      summary: `Can’t reach ${name} right now`,
      detail:
        'Nothing is wrong with your setup that the guide can see. Check your network or VPN, then check again.',
    };
  }
  if (kind === 'not-found') {
    const repo = line.match(/\/repos\/([^/\s]+)\/([^/\s]+)\/installation/);
    if (repo) {
      return {
        status: 'fail',
        summary: 'The App exists, but it is not installed on this repository',
        detail: `GitHub knows the App and accepted its key, but the App has not been given access to ${repo[1]}/${repo[2]}.`,
        fix: {
          text: 'Open the App’s installation settings, choose Configure, and add this repository. Then check again.',
          link: `https://github.com/organizations/${repo[1]}/settings/installations`,
        },
      };
    }
    return {
      status: 'fail',
      summary: `${name} cannot find this repository.`,
      detail: line,
      fix: {
        text:
          provider === 'gitlab'
            ? 'Check GITLAB_URL and GITLAB_PROJECT_ID in .env.gitlab.'
            : 'Check GITHUB_REPOSITORY in .env.github: it is owner/name, as in the repository’s address.',
      },
    };
  }
  if (kind === 'unauthenticated' && /cannot read the GitHub App's private key/.test(line)) {
    return {
      status: 'fail',
      summary: 'The App’s key file is not where .env.github says.',
      detail:
        'GITHUB_APP_PRIVATE_KEY_PATH must point at the .pem file you downloaded: an absolute path, or one relative to this folder.',
      fix: { text: 'Move the file there, or correct the path in .env.github.' },
    };
  }
  if (kind === 'unauthenticated') {
    return provider === 'gitlab'
      ? {
          status: 'fail',
          summary: 'GitLab refused the token.',
          detail: 'It may have expired, or been revoked.',
          fix: { text: 'Create a new project access token and put it in .env.gitlab as GITLAB_TOKEN.' },
        }
      : {
          status: 'fail',
          summary: 'GitHub refused the App’s key.',
          detail:
            'GITHUB_APP_ID and the .pem file have to belong to the same App, and the key must not have been revoked.',
          fix: { text: 'Check both in .env.github, or generate a new private key on the App’s page.' },
        };
  }
  if (kind === 'forbidden') {
    return {
      status: 'fail',
      summary: `${name} answered, but the board’s credential is missing a permission.`,
      detail: line,
      fix: {
        text:
          provider === 'gitlab'
            ? 'The token needs the Reporter role and the api scope.'
            : 'The App needs Issues, Pull requests and Contents (read and write) and Metadata (read). After changing them, accept the new permissions on the installation.',
        link: DOCS,
      },
    };
  }
  return {
    status: 'fail',
    summary: 'The board did not answer as expected.',
    detail: line,
    fix: { text: `The setup steps are in ${DOCS}.`, link: DOCS },
  };
}

/** Step 3: one board configured, completely, and answering. */
export async function checkBoard(ctx) {
  const env = envStatus(ctx);
  if (env.conflict) {
    return {
      status: 'fail',
      summary: 'Both .env.github and .env.gitlab are here, so the kit cannot tell which board is yours.',
      fix: {
        // Not "or set BOARD_PROVIDER": the guide's server reads its environment once, at start, so a
        // variable set in a shell afterwards never reaches it and the step stays red.
        text: 'Delete the one this project does not use, then check again.',
      },
    };
  }
  if (!env.provider) {
    // The repository's name, from the remote step 2 set up, so the request to an admin is ready to send.
    const url = (await ctx.sh('git', ['remote', 'get-url', 'origin'])).stdout.trim();
    const repo = url.match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/)?.[1] ?? '<owner>/<repository>';
    return {
      status: 'todo',
      summary: 'No board is connected yet.',
      fix: {
        copy:
          'Please create a GitHub App owned by the organisation, with no webhook, repository permissions ' +
          'Issues, Pull requests and Contents (read and write) and Metadata (read), install it on ' +
          `${repo}, and send me its App id and a private key.`,
        text:
          'On GitHub, either install your organisation’s shared Factory Kit App on this repository, or have an ' +
          'organisation admin create a new App. On GitLab, create two project access tokens. Then copy ' +
          '.env.github.example to .env.github (or .env.gitlab.example to .env.gitlab) and fill it in.',
        link: DOCS,
      },
    };
  }
  // Checked before the board is asked, because the tooling reports an unfinished file as `network`, which
  // would read as "can't reach GitHub" on the most common way into this step: a half-filled example file.
  const REQUIRED = {
    github: ['GITHUB_REPOSITORY', 'GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY_PATH'],
    gitlab: ['GITLAB_URL', 'GITLAB_TOKEN', 'GITLAB_PROJECT_ID'],
  };
  const empty = REQUIRED[env.provider].filter((k) => !env.vars[k]);
  if (empty.length) {
    return {
      status: 'todo',
      summary: `.env.${env.provider} is not filled in yet: ${empty.join(', ')}.`,
      fix: {
        text: `Fill these in from the ${env.provider === 'gitlab' ? 'project’s access tokens page' : 'App’s page'}, then check again.`,
        link: DOCS,
      },
    };
  }
  // Checked before the board is asked: `items list` works without it, and the gap only shows at the demo's
  // merge request, forty minutes later.
  if (env.provider === 'gitlab' && !env.vars.GITLAB_MR_TOKEN) {
    return {
      status: 'fail',
      summary: 'GITLAB_MR_TOKEN is empty, and your first item ends in a merge request that needs it.',
      fix: {
        text: 'Create a second project access token with the Developer role and the api scope, and put it in .env.gitlab as GITLAB_MR_TOKEN.',
        link: DOCS,
      },
    };
  }
  const r = await ctx.sh('node', ['scripts/work-items.mjs', 'list', '--json']);
  if (r.code === 0) return { status: 'pass', summary: 'The board answers.' };
  return installedWhere(ctx, explainBoardError(r.stderr, r.code, env.provider), r.stderr);
}

/**
 * "Not installed" links to the installation settings, which live under the organisation for an
 * organisation's repository and under the person's own settings for theirs. gh says which the owner is;
 * without it, the link stays the organisation's and the text names the other.
 */
async function installedWhere(ctx, result, stderr) {
  const owner = stderr.match(/\/repos\/([^/\s]+)\/[^/\s]+\/installation/)?.[1];
  if (!owner || !result.fix?.link?.includes('/settings/installations')) return result;
  let type = null;
  try {
    const r = await ctx.sh('gh', ['api', `users/${owner}`]);
    type = r.code === 0 ? JSON.parse(r.stdout).type : null;
  } catch {}
  if (type === 'User')
    return { ...result, fix: { ...result.fix, link: 'https://github.com/settings/installations' } };
  if (type === 'Organization') return result;
  return {
    ...result,
    fix: {
      ...result.fix,
      text:
        `${result.fix.text} If the repository belongs to your own account rather than an organisation, open ` +
        'https://github.com/settings/installations instead.',
    },
  };
}

/**
 * The CI modes this checkout can run. `remote` and `split` push to GitHub runners; a GitLab project has none
 * unless it mirrors to GitHub, which the guide cannot see, so it offers local only. A project with a mirror
 * sets the mode by hand (README, "Where CI runs").
 */
function modesFor(ctx) {
  return envStatus(ctx).provider === 'gitlab' ? ['local'] : ['local', 'remote', 'split'];
}

const CI_LINE = /^\s*CI_MODE\s*=\s*["']([^"']*)["']\s*$/m;

/** Step 5: a `CI_MODE` chosen in `.mise.local.toml`, the developer's own, git-ignored settings. */
export async function checkCiMode(ctx) {
  const options = modesFor(ctx);
  const mode = ctx.read('.mise.local.toml')?.match(CI_LINE)?.[1];
  if (!mode) return { status: 'todo', summary: 'Choose where the checks run.', options };
  if (!options.includes(mode)) {
    return { status: 'fail', summary: `CI_MODE is ${mode}, which this project cannot run.`, options };
  }
  return { status: 'pass', summary: `Checks run in ${mode} mode.`, options };
}

/**
 * Step 5's action. Edits `.mise.local.toml` in place: the line if it exists, else under `[env]`, else a new
 * `[env]` table at the end. Anything else in the file is the developer's and stays as it is.
 */
export async function setCiMode(ctx, mode) {
  const options = modesFor(ctx);
  if (!options.includes(mode)) return { status: 'fail', summary: `${mode} is not available here.`, options };
  const line = `CI_MODE = "${mode}"`;
  const text = ctx.read('.mise.local.toml') ?? '';
  let next;
  if (CI_LINE.test(text)) next = text.replace(CI_LINE, line);
  else if (/^\[env\]\s*$/m.test(text)) next = text.replace(/^\[env\]\s*$/m, `[env]\n${line}`);
  else next = `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}[env]\n${line}\n`;
  ctx.write('.mise.local.toml', next);
  return {
    status: 'pass',
    summary: `Checks run in ${mode} mode.`,
    // mise exports [env] when a shell starts, and a child inherits what its parent had (CLAUDE.md).
    detail: 'A terminal opened from now on picks this up. One that is already open keeps the old setting.',
    options,
  };
}

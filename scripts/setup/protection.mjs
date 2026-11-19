// Step 4 of the setup guide: the lock on the default branch. Agents propose; only a person merges. That holds
// only while the default branch takes changes through a reviewed request and the board's App cannot get
// past that rule, and nothing else in the kit can see whether it does.
//
// Read with the tech lead's own `gh` (or `glab`) login, never the App's. The App has Issues, Pull requests,
// Contents and Metadata, and none of those can read rulesets; giving it Administration to answer one setup
// question would widen the one credential every session holds. A CLI that is missing or logged out is
// `blocked`, not `fail`: the guide cannot see, which is not the same as "your branch is unprotected".

import { envValues } from './board-checks.mjs';
import { readAccepted, recordRisk } from './risks.mjs';

const json = (r) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
};

const WHY = 'The guide reads these settings with your own GitHub login, not the App’s.';

/** A CLI call that did not answer, as the step's result; `null` when it answered. */
function cliProblem(r, cli) {
  if (r.code === 0) return null;
  if (r.code === 127) {
    return cli === 'gh'
      ? {
          status: 'blocked',
          summary: 'Install the GitHub CLI (gh) so the guide can check this',
          detail: WHY,
          fix: {
            text: 'Install it, then log in:',
            commands: ['brew install gh', 'gh auth login'],
            link: 'https://cli.github.com',
          },
        }
      : {
          status: 'blocked',
          summary: 'Install the GitLab CLI (glab) so the guide can check this',
          detail: WHY.replace('GitHub', 'GitLab'),
          fix: {
            text: 'Install it, then log in:',
            commands: ['brew install glab', 'glab auth login'],
            link: 'https://gitlab.com/gitlab-org/cli',
          },
        };
  }
  // gh exits 4 when it needs a login; glab says so on stderr.
  if (r.code === 4 || /auth login/.test(r.stderr)) {
    return {
      status: 'blocked',
      summary: `Log in to the ${cli === 'gh' ? 'GitHub' : 'GitLab'} CLI so the guide can check this`,
      detail: cli === 'gh' ? WHY : WHY.replace('GitHub', 'GitLab'),
      fix: { text: 'Log in, then check again:', commands: [`${cli} auth login`] },
    };
  }
  return {
    status: 'blocked',
    summary: 'The guide could not read the repository’s settings.',
    detail: r.stderr.trim(),
  };
}

// Problems a person may decide to live with. The pull-request rule, its approval and the App's bypass are not
// among them: they are the lock itself, the one thing that keeps a person in charge of merging.
const ACCEPTABLE = {
  'auto-delete': 'Merged branches are not deleted automatically.',
  reporting: 'Private vulnerability reporting is off.',
};

const ACTIONS_APPROVE_NOTE =
  'GitHub Actions may approve pull requests here (Settings, Actions, General). A workflow whose token can write ' +
  'pull requests could then approve one the App opened. The kit’s ci.yml reads only; keep any other workflow that way, ' +
  'or turn the setting off.';

const PVR_NOTE =
  'Private vulnerability reporting is for public repositories. SECURITY.md says where to send a report instead.';

/**
 * The problems found, in a fixed order, as one result: the first open one's fix is the one offered. An
 * accepted problem is listed, with its reason, but no longer fails the step. `accept` names the open
 * problems the page may offer to accept, and `apply` the changes its one button would make.
 */
function verdict(ctx, problems, okSummary, { notes: given = [], apply = [], unseen = null } = {}) {
  const notes = unseen ? [...given, unseen.text] : given;
  const accepted = readAccepted(ctx);
  const open = problems.filter((p) => !accepted.has(`protection/${p.id}`));
  const done = problems
    .filter((p) => accepted.has(`protection/${p.id}`))
    .map((p) => `${p.text} Accepted because: ${accepted.get(`protection/${p.id}`)}.`);
  const accept = open.filter((p) => p.id in ACCEPTABLE).map((p) => ({ id: p.id, text: p.text }));
  const extra = {
    ...(notes.length ? { notes } : {}),
    ...(done.length ? { accepted: done } : {}),
  };
  // Nothing wrong that the login can see, but something it cannot: that is the guide unable to check.
  if (!open.length && unseen) {
    return {
      status: 'blocked',
      summary: 'The guide cannot see all of this step with your GitHub login.',
      detail: unseen.text,
      fix: {
        text: 'Ask an admin of the repository to open this step, or to check these settings for you.',
        link: unseen.link,
      },
      ...(done.length ? { accepted: done } : {}),
    };
  }
  if (!open.length) return { status: 'pass', summary: okSummary, ...extra };
  const pending = apply.filter((a) => open.some((p) => p.id === a.id));
  const changes = pending.map((a) => a.text);
  return {
    status: 'fail',
    summary: open.length === 1 ? open[0].text : `${open.length} things are missing.`,
    detail: open.map((p) => p.text).join('\n'),
    fix: open[0].fix,
    ...extra,
    ...(accept.length ? { accept } : {}),
    ...(changes.length ? { apply: changes, handoff: pending.map((a) => a.command) } : {}),
  };
}

/**
 * The ruleset the guide offers: the default branch takes changes only through a pull request that one person
 * approves, and cannot be deleted or force-pushed. One approval rather than none: the App opens the pull
 * requests, cannot approve its own, and so cannot merge one without a person. The repository's admins
 * (role 5) may bypass the approval, in a pull request only, so a tech lead working alone can still merge;
 * the App is never an admin, so the lock holds for it.
 */
export function rulesetFor(branch) {
  return `${JSON.stringify(
    {
      name: `${branch} needs a reviewed pull request`,
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
      bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' }],
    },
    null,
    2,
  )}\n`;
}

// Written under .git/, which git never commits, for `gh api --input` to read.
const RULESET_FILE = '.git/kit-setup-ruleset.json';

/** What GitHub says about the repository, and the problems in it, each with the change that fixes it. */
async function inspectGithub(ctx, repo, appId) {
  const R = `repos/${repo}`;
  const url = `https://github.com/${repo}`;
  const meta = await ctx.sh('gh', ['api', R]);
  const stop = cliProblem(meta, 'gh');
  if (stop) return { stop };
  const { default_branch: branch, delete_branch_on_merge: autoDelete, visibility } = json(meta) ?? {};
  // GitHub leaves out of its answers what this login may not see: absent is "cannot see", never "off".
  const unseen = [];
  if (typeof autoDelete !== 'boolean') unseen.push('whether merged branches are deleted automatically');

  const rulesAnswer = await ctx.sh('gh', ['api', `${R}/rules/branches/${branch}`]);
  const rules = json(rulesAnswer);
  if (rulesAnswer.code !== 0 || !Array.isArray(rules)) {
    // A private repository on GitHub Free has no rulesets: GitHub answers 403 with an upgrade message, and
    // that is "cannot check this way", not "main is unprotected".
    const message = rules?.message ?? rulesAnswer.stderr.trim();
    if (/upgrade|make this repository public/i.test(message)) {
      return {
        stop: {
          status: 'blocked',
          summary: 'GitHub does not offer rulesets for this repository on its current plan.',
          detail: message,
          fix: {
            text: `Protect ${branch} with a classic branch protection rule that requires a pull request instead, or make the repository public, then check again.`,
            link: `${url}/settings/branches`,
          },
        },
      };
    }
    return {
      stop: {
        status: 'blocked',
        summary: 'The guide could not read this repository’s rules.',
        detail: message,
      },
    };
  }
  const prRules = rules.filter((r) => r.type === 'pull_request');
  const bypassed = [];
  for (const id of [...new Set(prRules.map((r) => r.ruleset_id))]) {
    const set = json(await ctx.sh('gh', ['api', `${R}/rulesets/${id}`])) ?? {};
    if (!Array.isArray(set.bypass_actors)) {
      if (!unseen.includes('the ruleset’s bypass list')) unseen.push('the ruleset’s bypass list');
      continue;
    }
    if (
      (set.bypass_actors ?? []).some(
        (a) => a.actor_type === 'Integration' && String(a.actor_id) === String(appId),
      )
    ) {
      bypassed.push(id);
    }
  }
  // Classic branch protection predates rulesets and still does the same job; a repository may use either,
  // or both. Its own bypass list (`bypass_pull_request_allowances`) can name an App.
  const [classicAnswer, actions] = await Promise.all([
    ctx.sh('gh', ['api', `${R}/branches/${branch}/protection`]),
    ctx.sh('gh', ['api', `${R}/actions/permissions/workflow`]),
  ]);
  const reviews = json(classicAnswer)?.required_pull_request_reviews;
  if ((reviews?.bypass_pull_request_allowances?.apps ?? []).some((a) => String(a.id) === String(appId)))
    bypassed.push('classic');
  // The lock (#30): a person must approve, because an author cannot approve their own pull request, and a
  // push after the approval must dismiss it, or the App pushes new commits under a person's approval and
  // merges. Rules from rulesets and classic protection layer, so the highest count holds, and one rule that
  // dismisses stale approvals dismisses them. A rule that does not say counts as 0 and not dismissing.
  const counts = [
    ...prRules.map((r) => r.parameters?.required_approving_review_count ?? 0),
    ...(reviews ? [reviews.required_approving_review_count ?? 0] : []),
  ];
  const stale =
    prRules.some((r) => r.parameters?.dismiss_stale_reviews_on_push === true) ||
    reviews?.dismiss_stale_reviews === true;
  const approvals = Math.max(0, ...counts);
  // Not a failure: whether a workflow can approve depends on that workflow's own token.
  const actionsApprove = actions.code === 0 && json(actions)?.can_approve_pull_request_reviews === true;
  // Private vulnerability reporting exists only for public repositories: elsewhere GitHub answers 404, and
  // its settings page leads with Code Security, which is billed. Never sent there to pass a check.
  const isPublic = visibility === 'public';
  let reporting = true;
  if (isPublic) {
    const r = await ctx.sh('gh', ['api', `${R}/private-vulnerability-reporting`]);
    if (r.code === 0) reporting = json(r)?.enabled === true;
    else unseen.push('private vulnerability reporting');
  }

  const problems = [];
  const apply = [];
  const ruleset = rulesetFor(branch);
  /** The kit's ruleset, POSTed: it adds a rule beside any the repository has, and edits none of them. */
  const addRuleset = (id, text) => ({
    id,
    text,
    // The same change, as one command Claude Code can run: the ruleset goes to gh on its standard input.
    command: `gh api -X POST ${R}/rulesets --input - <<'EOF'\n${ruleset}EOF`,
    run: async () => {
      ctx.write(RULESET_FILE, ruleset);
      return ctx.sh('gh', ['api', '-X', 'POST', `${R}/rulesets`, '--input', RULESET_FILE]);
    },
  });
  /** The same ruleset, by hand: imported on the rulesets page. */
  const importFix = (text) => ({
    text: `${text} On the rulesets page choose New ruleset, then Import a ruleset, and give it this file:`,
    copy: ruleset,
    download: { name: `${branch}-ruleset.json`, text: ruleset },
    link: `${url}/settings/rules`,
  });
  if (!prRules.length && !reviews) {
    problems.push({
      id: 'pull-request',
      text: `${branch} does not require a pull request.`,
      fix: importFix(
        `Add a ruleset for ${branch} that requires a pull request, and leave the App off its bypass list.`,
      ),
    });
    apply.push(
      addRuleset(
        'pull-request',
        `Add a ruleset: ${branch} takes changes only through a pull request that a person merges; admins may merge without an approval.`,
      ),
    );
  } else if (approvals < 1 || !stale) {
    problems.push({
      id: 'approvals',
      text:
        approvals < 1
          ? `${branch} lets a pull request merge with no approval, so the board’s App could merge its own.`
          : `${branch} keeps an approval after new commits are pushed, so the board’s App could push after a person approves and merge.`,
      fix: importFix(
        `Add the kit’s ruleset beside the rules ${branch} has: rules add up, so its one approval, dismissed on a new push, then holds.`,
      ),
    });
    apply.push(
      addRuleset(
        'approvals',
        `Add a ruleset beside the existing rules: a pull request into ${branch} needs a person’s approval, dismissed on a new push; admins may merge without one.`,
      ),
    );
  }
  if (bypassed.length) {
    const inRuleset = bypassed.some((b) => b !== 'classic');
    const where = [
      inRuleset && 'the ruleset’s bypass list',
      bypassed.includes('classic') &&
        'the branch protection rule’s “Allow specified actors to bypass required pull requests” list',
    ].filter(Boolean);
    problems.push({
      id: 'bypass',
      text: 'The board’s App is allowed past the lock, so it could merge on its own.',
      fix: {
        text: `Remove the App from ${where.join(' and from ')}.`,
        link: inRuleset ? `${url}/settings/rules` : `${url}/settings/branches`,
      },
    });
  }
  if (autoDelete === false) {
    problems.push({
      id: 'auto-delete',
      text: ACCEPTABLE['auto-delete'],
      fix: {
        text: 'Turn on “Automatically delete head branches” in the repository’s General settings.',
        link: `${url}/settings`,
      },
    });
    apply.push({
      id: 'auto-delete',
      text: 'Turn on deleting merged branches automatically.',
      command: `gh api -X PATCH ${R} -F delete_branch_on_merge=true`,
      run: () => ctx.sh('gh', ['api', '-X', 'PATCH', R, '-F', 'delete_branch_on_merge=true']),
    });
  }
  if (!reporting) {
    // Vulnerability reports do not go on the board: a GitHub issue cannot be confidential (SECURITY.md).
    problems.push({
      id: 'reporting',
      text: ACCEPTABLE.reporting,
      fix: {
        text: 'Turn on private vulnerability reporting in the repository’s security settings. It is free for public repositories.',
        link: `${url}/settings/security_analysis`,
      },
    });
    apply.push({
      id: 'reporting',
      text: 'Turn on private vulnerability reporting.',
      command: `gh api -X PUT ${R}/private-vulnerability-reporting`,
      run: () => ctx.sh('gh', ['api', '-X', 'PUT', `${R}/private-vulnerability-reporting`]),
    });
  }
  return {
    branch,
    problems,
    apply,
    notes: [...(actionsApprove ? [ACTIONS_APPROVE_NOTE] : []), ...(isPublic ? [] : [PVR_NOTE])],
    unseen: unseen.length
      ? {
          text: `Your GitHub login is not an admin of ${repo}, so it cannot see: ${unseen.join(', ')}.`,
          link: `${url}/settings`,
        }
      : null,
  };
}

async function github(ctx, repo, appId) {
  const found = await inspectGithub(ctx, repo, appId);
  if (found.stop) return found.stop;
  return verdict(
    ctx,
    found.problems,
    `${found.branch} only changes through a pull request that a person merges.`,
    found,
  );
}

async function gitlab(ctx, projectId) {
  const P = `projects/${encodeURIComponent(projectId)}`;
  const meta = await ctx.sh('glab', ['api', P]);
  const stop = cliProblem(meta, 'glab');
  if (stop) return stop;
  const {
    default_branch: branch,
    remove_source_branch_after_merge: autoDelete,
    web_url: url,
  } = json(meta) ?? {};
  const prot = await ctx.sh('glab', ['api', `${P}/protected_branches/${encodeURIComponent(branch)}`]);
  const push = prot.code === 0 ? (json(prot)?.push_access_levels ?? []) : null;
  const merge = prot.code === 0 ? (json(prot)?.merge_access_levels ?? []) : null;

  const problems = [];
  if (!push || push.some((l) => l.access_level !== 0)) {
    problems.push({
      id: 'pull-request',
      text: `${branch} can be pushed to directly.`,
      fix: {
        text: `Protect ${branch} with “Allowed to push: No one”.`,
        link: url && `${url}/-/settings/repository`,
      },
    });
  }
  // The board's merge-request token is a Developer (docs/agents/issue-tracker.md): it opens a merge request,
  // and must not be able to merge one (#30). Any level from Developer (30) down lets it.
  if (merge?.some((l) => typeof l.access_level === 'number' && l.access_level > 0 && l.access_level <= 30)) {
    problems.push({
      id: 'merge',
      text: `Developers may merge into ${branch}, so the board’s merge-request token could merge its own.`,
      fix: {
        text: `Protect ${branch} with “Allowed to merge: Maintainers”.`,
        link: url && `${url}/-/settings/repository`,
      },
    });
  }
  if (autoDelete !== true) {
    problems.push({
      id: 'auto-delete',
      text: ACCEPTABLE['auto-delete'],
      fix: {
        text: 'Turn on “Enable Delete source branch option by default”.',
        link: url && `${url}/-/settings/merge_requests`,
      },
    });
  }
  return verdict(ctx, problems, `${branch} only changes through a merge request that a person merges.`);
}

/** Step 4. */
export async function checkProtection(ctx) {
  const { provider, values } = envValues(ctx);
  if (provider === 'github' && values.GITHUB_REPOSITORY) {
    return github(ctx, values.GITHUB_REPOSITORY, values.GITHUB_APP_ID);
  }
  if (provider === 'gitlab' && values.GITLAB_PROJECT_ID) return gitlab(ctx, values.GITLAB_PROJECT_ID);
  return { status: 'todo', summary: 'Connect the board first: this step checks the repository it names.' };
}

/**
 * Step 4's one button: makes, with the tech lead's own gh login, every change the check lists under
 * `apply`. The bypass is not among them: taking an actor off an existing ruleset is the person's edit.
 */
export async function applyProtection(ctx) {
  const { provider, values } = envValues(ctx);
  if (provider !== 'github' || !values.GITHUB_REPOSITORY) {
    return { status: 'fail', summary: 'The guide can only make these changes on GitHub.' };
  }
  const found = await inspectGithub(ctx, values.GITHUB_REPOSITORY, values.GITHUB_APP_ID);
  if (found.stop) return found.stop;
  const accepted = readAccepted(ctx);
  const todo = found.apply.filter((a) => !accepted.has(`protection/${a.id}`));
  if (!todo.length) return { status: 'pass', summary: 'Nothing to change.' };
  const refused = [];
  for (const a of todo) {
    const r = await a.run();
    if (r.code !== 0) refused.push(`${a.text} ${r.stderr.trim()}`);
  }
  if (refused.length) {
    return {
      status: 'fail',
      summary: `GitHub refused ${refused.length} of ${todo.length} changes.`,
      detail: refused.join('\n'),
    };
  }
  return { status: 'pass', summary: `Done: ${todo.length} settings changed.` };
}

/** Step 4's "Accept this risk": records one acceptable problem in docs/DECISIONS.md. */
export async function acceptProtectionRisk(ctx, input) {
  const problem = input?.problem;
  if (!Object.hasOwn(ACCEPTABLE, problem)) {
    return {
      status: 'fail',
      summary: 'This one cannot be accepted: it is what keeps a person in charge of merging.',
    };
  }
  return recordRisk(ctx, { key: `protection/${problem}`, text: ACCEPTABLE[problem], reason: input?.reason });
}

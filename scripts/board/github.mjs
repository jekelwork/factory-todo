// The GitHub board: a GitHub App's credentials, transport and normalizers behind the adapter interface
// (docs/adr/0002-board-provider-adapters.md). Targets GitHub Enterprise Cloud at api.github.com;
// GITHUB_API_URL points it elsewhere, and GitHub Enterprise Server is not otherwise supported or tested.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BoardError, envReader, fetchWithin } from './config.mjs';
import { addRelatesTo, MAX_UPLOAD_BYTES, relatesTo, stripRelatesTo } from './core.mjs';

/**
 * Where configuration comes from: `.env.github`, with a real environment variable winning over it (see
 * `envReader`). Documented in `.env.github.example`.
 */
export function githubConfig(env, root) {
  const pick = envReader('.env.github', env, root);
  const keyPath = pick('GITHUB_APP_PRIVATE_KEY_PATH');
  return {
    repository: pick('GITHUB_REPOSITORY').trim(),
    appId: pick('GITHUB_APP_ID').trim(),
    keyPath: keyPath && path.resolve(root, keyPath),
    installationId: pick('GITHUB_APP_INSTALLATION_ID').trim(),
    apiUrl: (pick('GITHUB_API_URL') || 'https://api.github.com').trim().replace(/\/+$/, ''),
    timeoutMs: Number(pick('GITHUB_TIMEOUT_MS')) || 8000,
  };
}

/**
 * What each command's installation token may do. The App is installed with the union, and every process
 * mints a token per scope it needs, for this one repository, and keeps it in memory only.
 *
 * Three rather than one for the reason GitLab has two tokens: the `board` token runs on every session start
 * and every list, show, comment and label, so it is the last one that should also be able to open a pull
 * request or write to the repository. `assets` writes only the `board-assets` branch, and a ruleset on the
 * default branch keeps it off product branches; `mr` opens pull requests and never merges them, because
 * the App is not a bypass actor on that ruleset. It reads contents too: without that, GitHub cannot see the
 * branches a pull request is opened between, and answers 422 "not all refs are readable".
 */
export const SCOPES = {
  board: { issues: 'write', metadata: 'read' },
  assets: { contents: 'write' },
  mr: { pull_requests: 'write', contents: 'read' },
};

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * The App's JSON Web Token, RS256-signed with its private key: what it presents to exchange for an
 * installation token. Issued 60 s in the past against clock drift, valid for nine minutes (GitHub's limit
 * is ten).
 */
export function appJwt(appId, privateKey, nowSec = Math.floor(Date.now() / 1000)) {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: String(appId) }));
  const signature = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), privateKey);
  return `${head}.${claims}.${b64url(signature)}`;
}

/** The `rel="next"` URL of a `Link` header, or null on the last page. */
export function nextLink(header) {
  for (const part of (header || '').split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (m) return m[1];
  }
  return null;
}

/**
 * The failure vocabulary for a GitHub response. A 403 is two different things on GitHub: an exhausted rate
 * limit, which is transient and says so in its headers, and a permission the App lacks, which is not.
 */
export function githubErrorCode(status, header) {
  if (status === 401) return 'unauthenticated';
  if (status === 429) return 'rate-limited';
  if (status === 403) {
    return header('x-ratelimit-remaining') === '0' || header('retry-after') != null
      ? 'rate-limited'
      : 'forbidden';
  }
  if (status === 404) return 'not-found';
  return 'http_error';
}

/**
 * What a failed response says, for the error message: its `message` and each entry of `errors`. A 422
 * says only "Validation Failed" in `message`; the reason, such as "not all refs are readable", is in
 * `errors`.
 */
export function githubErrorDetail(body) {
  const errors = Array.isArray(body?.errors) ? body.errors : [];
  return [
    body?.message,
    ...errors.map((e) => (typeof e === 'string' ? e : (e?.message ?? JSON.stringify(e)))),
  ]
    .filter(Boolean)
    .join('; ');
}

/**
 * The label that stands in for GitLab's confidential flag. GitHub issues have no such flag, so a board moved
 * from GitLab carries its confidential items as issues with this label, and the tooling keeps their titles
 * out of what it prints, as it does on GitLab (core.isConfidential). It hides nothing on GitHub itself:
 * everybody who can read the repository can open the issue.
 */
export const CONFIDENTIAL_LABEL = 'confidential';

/** A GitHub issue as an Item. `confidential` is the `confidential` label, matched without regard to case. */
export function githubItem(i) {
  const labels = (i.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name));
  return {
    iid: i.number,
    title: i.title,
    url: i.html_url,
    labels,
    description: i.body ?? '',
    state: i.state === 'closed' ? 'closed' : 'open',
    confidential: labels.some((l) => l?.toLowerCase() === CONFIDENTIAL_LABEL),
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    commentCount: i.comments ?? 0,
    milestone: i.milestone ? { title: i.milestone.title } : null,
  };
}

/**
 * GitHub's issues endpoint returns pull requests too. Each would read as a `new` work item on every
 * session start, so every listing goes through this.
 */
export const onlyIssues = (list) => list.filter((i) => !i.pull_request);

export function githubComment(c) {
  return {
    id: c.id,
    authorId: c.user?.id ?? null,
    author: c.user?.login ?? '',
    body: c.body ?? '',
    createdAt: c.created_at,
  };
}

/** A GitHub milestone as a Milestone. Its `number`, not its `id`, is what an issue is put in. */
export function githubMilestone(m) {
  return {
    id: m.number,
    title: m.title,
    state: m.state === 'closed' ? 'closed' : 'open',
    due: m.due_on ? m.due_on.slice(0, 10) : null,
    url: m.html_url ?? null,
  };
}

/**
 * A GitHub pull request as an Mr. GitHub reports one merge commit whichever way the request was merged; a
 * squash or a rebase leaves a single-parent commit there, which `release finalize` finds out with git.
 */
export function githubMr(p) {
  return {
    iid: p.number,
    title: p.title,
    sourceBranch: p.head?.ref,
    targetBranch: p.base?.ref,
    description: p.body ?? '',
    state: p.merged_at ? 'merged' : p.state === 'open' ? 'open' : 'closed',
    mergeSha: p.merged_at ? (p.merge_commit_sha ?? null) : null,
    url: p.html_url,
  };
}

/**
 * The pull requests a range of commit messages names, ascending: a merge commit's subject
 * (`Merge pull request #12 from owner/branch`), or a squash commit's, which GitHub ends with `(#12)`. Only
 * subjects: a squash commit's body lists the squashed commits, and their `(#n)` are other requests. A `#n`
 * that turns out to be an issue is dropped by the caller, which looks each one up.
 */
export function githubMrRefs(messages) {
  const out = new Set();
  for (const { subject } of messages) {
    const m = /^Merge pull request #(\d+) from /.exec(subject) ?? /\(#(\d+)\)\s*$/.exec(subject);
    if (m) out.add(Number(m[1]));
  }
  return [...out].sort((a, b) => a - b);
}

/** GitHub refuses a label description over 100 characters; ours are written for GitLab, which does not. */
export function labelDescription(text) {
  return text.length <= 100 ? text : `${text.slice(0, 99)}…`;
}

/** Where an attachment lands on the `board-assets` branch: one folder per item or pull request, per run. */
export function assetPath({ iid, mr }, stamp, name) {
  return `${mr != null ? `pulls/${mr}` : `items/${iid}`}/${stamp}/${name}`;
}

/** The markdown that shows an attachment: inline for an image, a link for anything else. */
export function assetMarkdown(name, htmlUrl) {
  const url = `${htmlUrl}?raw=true`;
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(name) ? `![${name}](${url})` : `[${name}](${url})`;
}

/** The orphan branch attachments are committed to, and the README it starts with. */
export const ASSETS_BRANCH = 'board-assets';
export const ASSETS_README = `# board-assets

Screenshots and attachments for the work-item board, written by \`pnpm items screenshots\` and the
batch skill's \`mr-attach.mjs\` (GitHub has no upload API for issue or pull request comments). One folder
per item (\`items/<n>/\`) or pull request (\`pulls/<n>/\`), one subfolder per run.

This branch shares no history with the code and is never merged. Nothing here is built or deployed.
`;

/** How long before an installation token's `expires_at` a new one is minted. */
const RENEW_BEFORE_MS = 5 * 60_000;

/**
 * A GitHub App's REST client for one repository: what every GitHub caller here shares, so there is one
 * token cache and one transport rather than one per script. `createGithub` is built on it, and so is the
 * board migration (`scripts/board/migrate.mjs`).
 *
 * - **One installation token per scope** (`SCOPES`), minted on first use and kept in memory only. A token
 *   lives an hour and a long run outlasts it, so one is minted again `RENEW_BEFORE_MS` before its
 *   `expires_at` (fifty minutes after minting when GitHub gives none). A failed mint is not cached.
 * - **A 401 gets a fresh token, once.** GitHub answers 401 to an expired or revoked installation token
 *   before it does anything, so repeating the request with a new one is safe, a write included.
 * - **`retries`** repeats a read, or a token mint, after a timeout, a dropped connection or a 5xx, waiting
 *   3 s, 6 s, … between attempts. A write is never repeated: one that timed out or answered 5xx may have
 *   happened, or used something up (GitHub has burnt an issue number on a 502 that created nothing), and
 *   only reading the repository back can tell. The default, 0, is the adapter's: a session hook should fail
 *   fast rather than wait.
 * - **`all`** follows `Link: rel="next"` to the last page.
 * - A failure is a `BoardError` in the shared vocabulary, carrying `retryAfterMs` when GitHub says how long
 *   to wait (`retry-after`, else `x-ratelimit-reset`, else a minute), for a caller that paces itself.
 */
export function createInstallationClient(
  env,
  root,
  {
    fetch: fetchImpl = fetch,
    now = () => Date.now(),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    timeoutMs,
    retries = 0,
  } = {},
) {
  const cfg = githubConfig(env, root);
  const repo = `/repos/${cfg.repository}`;
  const deadline = timeoutMs ?? cfg.timeoutMs;
  const tokens = new Map();
  let privateKey;
  let installationId = cfg.installationId;

  function configured() {
    if (!cfg.repository || !cfg.appId || !cfg.keyPath) {
      throw new BoardError(
        'GitHub is not configured — set GITHUB_REPOSITORY, GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY_PATH ' +
          'in .env.github (copy .env.github.example)',
        'network',
      );
    }
    if (!privateKey) {
      try {
        privateKey = fs.readFileSync(cfg.keyPath, 'utf8');
      } catch {
        throw new BoardError(`cannot read the GitHub App's private key at ${cfg.keyPath}`, 'unauthenticated');
      }
    }
  }

  async function requestOnce(urlPath, { method = 'GET', body, raw, auth }) {
    const url =
      urlPath.startsWith('https://') || urlPath.startsWith('http://') ? urlPath : `${cfg.apiUrl}${urlPath}`;
    const res = await fetchWithin(
      fetchImpl,
      url,
      {
        method,
        headers: {
          Authorization: `Bearer ${auth}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(raw
            ? { 'Content-Type': raw.type }
            : body === undefined
              ? {}
              : { 'Content-Type': 'application/json' }),
        },
        body: raw ? raw.bytes : body === undefined ? undefined : JSON.stringify(body),
      },
      { timeoutMs: deadline, name: 'GitHub' },
    );
    if (!res.ok) {
      const h = (k) => res.headers.get(k);
      const code = githubErrorCode(res.status, h);
      let detail = '';
      try {
        detail = githubErrorDetail(await res.json());
      } catch {
        /* no JSON body */
      }
      const shown = urlPath.replace(cfg.apiUrl, '');
      const e = new BoardError(
        `GitHub ${method} ${shown} answered ${res.status}${detail ? `: ${detail}` : ''}` +
          (code === 'not-found' ? ' (or the App cannot see this repository)' : ''),
        code,
        res.status,
      );
      const reset = Number(h('x-ratelimit-reset'));
      e.retryAfterMs =
        h('retry-after') != null
          ? Number(h('retry-after')) * 1000
          : reset
            ? Math.max(0, reset * 1000 - now())
            : 60_000;
      throw e;
    }
    return { json: res.status === 204 ? null : await res.json(), next: nextLink(res.headers.get('link')) };
  }

  /** One request with the `auth` given. Repeated per `retries` when it is a read or a token mint. */
  async function request(urlPath, opts = {}) {
    const safe = (opts.method ?? 'GET') === 'GET' || urlPath.endsWith('/access_tokens');
    for (let attempt = 0; ; attempt++) {
      try {
        return await requestOnce(urlPath, opts);
      } catch (e) {
        const again =
          e instanceof BoardError && (e.code === 'timeout' || e.code === 'network' || e.status >= 500);
        if (!safe || !again || attempt >= retries) throw e;
        await sleep(3000 * (attempt + 1));
      }
    }
  }

  /** The App's JWT, signed now. */
  const jwt = () => {
    configured();
    return appJwt(cfg.appId, privateKey, Math.floor(now() / 1000));
  };

  /** An installation token for one scope: from the cache while it has `RENEW_BEFORE_MS` left, else minted. */
  function token(scope) {
    const held = tokens.get(scope);
    if (held && held.until <= now()) tokens.delete(scope);
    if (!tokens.has(scope)) {
      const entry = { promise: null, until: Number.POSITIVE_INFINITY };
      entry.promise = (async () => {
        const auth = jwt();
        if (!installationId) installationId = (await request(`${repo}/installation`, { auth })).json.id;
        const { json } = await request(`/app/installations/${installationId}/access_tokens`, {
          method: 'POST',
          auth,
          body: { repositories: [cfg.repository.split('/')[1]], permissions: SCOPES[scope] },
        });
        entry.until = json.expires_at ? Date.parse(json.expires_at) - RENEW_BEFORE_MS : now() + 50 * 60_000;
        return json.token;
      })();
      // A failed mint is not cached: the next call tries again rather than repeating the old failure.
      entry.promise.catch(() => {
        if (tokens.get(scope) === entry) tokens.delete(scope);
      });
      tokens.set(scope, entry);
    }
    return tokens.get(scope).promise;
  }

  /** A request with this scope's token. A 401 (the token expired or was revoked: nothing happened) gets a new one, once. */
  async function authed(urlPath, opts, scope) {
    try {
      return await request(urlPath, { ...opts, auth: await token(scope) });
    } catch (e) {
      if (!(e instanceof BoardError && e.code === 'unauthenticated')) throw e;
      tokens.delete(scope);
      return request(urlPath, { ...opts, auth: await token(scope) });
    }
  }

  /** A REST call with the scope's token; its JSON, or null for a 204. */
  const api = async (urlPath, { method = 'GET', body, raw, scope = 'board' } = {}) =>
    (await authed(urlPath, { method, body, raw }, scope)).json;

  /** Every page, following `Link: rel="next"`. */
  async function all(urlPath, scope = 'board') {
    const out = [];
    for (let url = urlPath; url; ) {
      const page = await authed(url, {}, scope);
      out.push(...page.json);
      url = page.next;
    }
    return out;
  }

  /**
   * The App's bot user's id: `GET /app` names the App, and its comments are authored by `<slug>[bot]`. On
   * any failure, null.
   */
  async function botId() {
    try {
      const { json: app } = await request('/app', { auth: jwt() });
      return (await api(`/users/${encodeURIComponent(`${app.slug}[bot]`)}`)).id;
    } catch {
      return null;
    }
  }

  return { cfg, repo, request, jwt, token, api, all, botId };
}

export function createGithub(env, root, { fetch: fetchImpl = fetch, now = () => Date.now() } = {}) {
  const client = createInstallationClient(env, root, { fetch: fetchImpl, now });
  const { cfg, repo, api, all: apiAll } = client;

  const notFoundIsNull = async (promise) => {
    try {
      return await promise;
    } catch (e) {
      if (e instanceof BoardError && e.code === 'not-found') return null;
      throw e;
    }
  };

  // The bot's id, looked up once: `release prepare` reads every merged request in a range through `getMr`,
  // and `whoami` is two requests each time.
  let me;
  const myId = () => (me ??= client.botId());

  let projectInfo;
  /** The repository's settings that a release depends on. */
  function project() {
    projectInfo ??= api(repo).then((r) => ({
      defaultBranch: r.default_branch,
      path: r.full_name,
      url: r.html_url,
      // A release has to reach the default branch as a merge commit (docs/agents/releasing.md).
      squashAlways: r.allow_merge_commit === false,
      mergeMethod: r.allow_merge_commit === false ? 'squash' : 'merge',
    }));
    return projectInfo;
  }

  // Releases need `contents: write`, which is the assets scope's.
  const rawRelease = (tag) =>
    notFoundIsNull(api(`${repo}/releases/tags/${encodeURIComponent(tag)}`, { scope: 'assets' }));

  const issue = (n) => `${repo}/issues/${n}`;
  const get = async (n) => githubItem(await api(issue(n)));
  const patch = async (n, body) => githubItem(await api(issue(n), { method: 'PATCH', body }));
  let openListing;
  const listOpen = async () =>
    onlyIssues(await apiAll(`${repo}/issues?state=open&sort=created&direction=asc&per_page=100`)).map(
      githubItem,
    );
  let assetsBranch;

  /**
   * The orphan `board-assets` branch, created on first use through the Git Data API: a README blob, a tree
   * holding it, a commit with no parent, and the ref. The Contents API cannot start a branch with no
   * history, and branching off the default branch would put the product's whole tree on it.
   */
  function ensureAssetsBranch() {
    assetsBranch ??= (async () => {
      try {
        await api(`${repo}/git/ref/heads/${ASSETS_BRANCH}`, { scope: 'assets' });
        return;
      } catch (e) {
        if (!(e instanceof BoardError && e.code === 'not-found')) throw e;
      }
      const post = (p, body) => api(`${repo}/git/${p}`, { method: 'POST', body, scope: 'assets' });
      const blob = await post('blobs', { content: ASSETS_README, encoding: 'utf-8' });
      const tree = await post('trees', {
        tree: [{ path: 'README.md', mode: '100644', type: 'blob', sha: blob.sha }],
      });
      const commit = await post('commits', {
        message: 'chore: start the board-assets branch',
        tree: tree.sha,
        parents: [],
      });
      await post('refs', { ref: `refs/heads/${ASSETS_BRANCH}`, sha: commit.sha });
    })();
    return assetsBranch;
  }

  return {
    name: 'github',
    label: 'GitHub',
    where: cfg.repository,
    mrRef: (n) => `#${n}`,
    maxUploadBytes: MAX_UPLOAD_BYTES,

    /**
     * The App's bot user: `GET /app` names the App, and its comments are authored by `<slug>[bot]`. That
     * account is never a person, which is why the board runs as an App rather than on a developer's token:
     * a developer's own reply would otherwise read as our follow-up. On any failure, null, and the plan and
     * coverage markers carry the state machine as they do on GitLab.
     */
    whoami: () => client.botId(),
    listOpen,
    listAll: async () => onlyIssues(await apiAll(`${repo}/issues?state=all&per_page=100`)).map(githubItem),
    get,
    comments: async (n) => (await apiAll(`${issue(n)}/comments?per_page=100`)).map(githubComment),
    comment: async (n, body) => ({
      id: (await api(`${issue(n)}/comments`, { method: 'POST', body: { body } })).id,
    }),
    setLabels: (n, labels) => patch(n, { labels }),
    /** Creates the label when the repository has none of that name. True when it did. */
    async ensureLabel(name, color, description) {
      try {
        // A label name with `:` in it must be encoded in the path, or the request names another resource.
        await api(`${repo}/labels/${encodeURIComponent(name)}`);
        return false;
      } catch (e) {
        if (!(e instanceof BoardError && e.code === 'not-found')) throw e;
      }
      await api(`${repo}/labels`, {
        method: 'POST',
        body: { name, color: color.replace(/^#/, ''), description: labelDescription(description) },
      });
      return true;
    },
    create: async ({ title, description, labels }) =>
      githubItem(
        await api(`${repo}/issues`, {
          method: 'POST',
          body: { title, body: description, labels: labels ?? [] },
        }),
      ),
    /** State and labels in one PATCH, as on GitLab. */
    close: (n, labels) => patch(n, { state: 'closed', state_reason: 'completed', labels }),
    /**
     * The items this one names in a `Relates-to` line, and the open items whose own line names it. Open is
     * enough for the reverse direction: a closed sibling never blocks. The open listing is read once per
     * process, since `list` asks this for every item about to be acted on.
     */
    async links(n) {
      const own = relatesTo((await get(n)).description);
      openListing ??= listOpen();
      const back = (await openListing)
        .filter((i) => relatesTo(i.description).includes(Number(n)))
        .map((i) => i.iid);
      return [...new Set([...own, ...back])]
        .filter((i) => i !== Number(n))
        .sort((a, b) => a - b)
        .map((iid) => ({ iid }));
    },
    async link(n, other) {
      const item = await get(n);
      await patch(n, { body: addRelatesTo(item.description, other) });
    },
    /** Removes the line from whichever side carries it, or both. False when neither does. */
    async unlink(n, other) {
      let removed = false;
      for (const [a, b] of [
        [n, other],
        [other, n],
      ]) {
        const item = await get(a);
        if (!relatesTo(item.description).includes(Number(b))) continue;
        await patch(a, { body: stripRelatesTo(item.description, b) });
        removed = true;
      }
      return removed;
    },
    milestones: async (state) =>
      (await apiAll(`${repo}/milestones?state=${state === 'open' ? 'open' : 'all'}&per_page=100`)).map(
        githubMilestone,
      ),
    createMilestone: async (title) =>
      githubMilestone(await api(`${repo}/milestones`, { method: 'POST', body: { title } })),
    setMilestone: (n, number) => patch(n, { milestone: number }),
    /**
     * GitHub has no upload API for comments, so an attachment is committed to the `board-assets` branch and
     * linked by its blob URL with `?raw=true`, which renders inline for anybody who can read the repository,
     * a private one included.
     */
    async upload({ name, bytes }, target) {
      await ensureAssetsBranch();
      const stamp = new Date(now())
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d+Z$/, 'Z');
      const where = assetPath(target, stamp, name);
      const { content } = await api(
        `${repo}/contents/${where.split('/').map(encodeURIComponent).join('/')}`,
        {
          method: 'PUT',
          scope: 'assets',
          body: {
            message: `chore: attach ${where}`,
            content: Buffer.from(bytes).toString('base64'),
            branch: ASSETS_BRANCH,
          },
        },
      );
      return assetMarkdown(name, content.html_url);
    },
    defaultBranch: async () => (await project()).defaultBranch,
    project,

    mrUnavailable: () => null,
    mrForbidden:
      'The GitHub App was refused (403) opening a pull request. It needs the "Pull requests: read and\n' +
      'write" permission, and its installation on this repository must have accepted it.',
    async openMr({ source, target, title, description }) {
      const pr = await api(`${repo}/pulls`, {
        method: 'POST',
        scope: 'mr',
        body: { head: source, base: target, title, body: description },
      });
      return { iid: pr.number, url: pr.html_url };
    },
    mrRefs: async (messages) => githubMrRefs(messages),
    /**
     * Null for a number that is no pull request (an issue's, say). Pull requests need the mr scope to read.
     *
     * Also says who merged it, which only this single GET can: `pulls?state=…` listings leave `merged_by`
     * out. `mergedByBot` is true when the merger is the App's own bot user, which a ruleset that lists the
     * App as a bypass actor allows, and the setup guide's demo exists to show that it does not.
     */
    getMr: async (n) => {
      const pr = await notFoundIsNull(api(`${repo}/pulls/${n}`, { scope: 'mr' }));
      if (!pr) return null;
      const by = pr.merged_by ?? null;
      return {
        ...githubMr(pr),
        mergedBy: by?.login ?? null,
        mergedByBot: by != null && by.id === (await myId()),
      };
    },
    /** Pull requests from `source` (into `target`, when given), newest first. */
    async findMrs({ source, target, state = 'all' }) {
      const owner = cfg.repository.split('/')[0];
      const q = `head=${encodeURIComponent(`${owner}:${source}`)}${target ? `&base=${encodeURIComponent(target)}` : ''}`;
      return (
        await apiAll(`${repo}/pulls?state=${state === 'open' ? 'open' : 'all'}&${q}&per_page=100`, 'mr')
      )
        .map(githubMr)
        .sort((a, b) => b.iid - a.iid);
    },

    /** A GitHub release cannot carry a milestone; `finalize` links the milestone from the notes instead. */
    releaseCarriesMilestone: false,
    getRelease: async (tag) => {
      const r = await rawRelease(tag);
      return r && { url: r.html_url };
    },
    /** Creates the release for an existing tag, or rewrites its name and notes. */
    async saveRelease({ tag, name, description }) {
      const existing = await rawRelease(tag);
      const r = existing
        ? await api(`${repo}/releases/${existing.id}`, {
            method: 'PATCH',
            body: { name, body: description },
            scope: 'assets',
          })
        : await api(`${repo}/releases`, {
            method: 'POST',
            body: { tag_name: tag, name, body: description },
            scope: 'assets',
          });
      return { url: r.html_url };
    },
    /**
     * Uploads a file as a release asset, labelled `name`. One of the same file name is replaced, so a second
     * run leaves one asset rather than two.
     */
    async attachToRelease(tag, { name, filename, bytes, type }) {
      const r = await rawRelease(tag);
      if (!r) throw new BoardError(`GitHub has no release ${tag} to attach ${filename} to`, 'not-found', 404);
      const old = (r.assets ?? []).find((a) => a.name === filename);
      if (old) await api(`${repo}/releases/assets/${old.id}`, { method: 'DELETE', scope: 'assets' });
      const upload = `${r.upload_url.replace(/\{.*\}$/, '')}?name=${encodeURIComponent(filename)}&label=${encodeURIComponent(name)}`;
      const asset = await api(upload, { method: 'POST', raw: { bytes, type }, scope: 'assets' });
      return { url: asset.browser_download_url, replaced: Boolean(old) };
    },
    /** 'closed', 'already' or 'none'. */
    async closeMilestone(title) {
      const m = (await apiAll(`${repo}/milestones?state=all&per_page=100`)).find((x) => x.title === title);
      if (!m) return 'none';
      if (m.state === 'closed') return 'already';
      await api(`${repo}/milestones/${m.number}`, { method: 'PATCH', body: { state: 'closed' } });
      return 'closed';
    },
    commentMr: async (n, body) => ({
      id: (await api(`${issue(n)}/comments`, { method: 'POST', body: { body }, scope: 'mr' })).id,
    }),
  };
}

// The GitLab board: transport, credentials and normalizers behind the adapter interface
// (docs/adr/0002-board-provider-adapters.md). The endpoints and writes are the ones `work-items.mjs` made
// before the GitHub adapter existed; only the shapes returned to it are normalized.

import { BoardError, envReader, fetchWithin } from './config.mjs';
import { MAX_UPLOAD_BYTES } from './core.mjs';

/**
 * Where configuration comes from: `.env.gitlab`, with a real environment variable winning over it (see
 * `envReader`). Documented in `.env.gitlab.example`. The token needs the `api` scope: GitLab has no
 * read-only-plus-comment scope, and this both reads the board and writes comments and labels to it.
 */
export function gitlabConfig(env, root) {
  const pick = envReader('.env.gitlab', env, root);
  // A scheme-less host is assumed https. `new URL()` rejects "gitlab.example.com/api/v4/…" with "Failed to parse
  // URL", which reads as the server being unreachable rather than as a typo in a config file — a wrong
  // diagnosis of the one failure this script is otherwise careful to tell apart from a dead token.
  const host = pick('GITLAB_URL').trim().replace(/\/+$/, '');
  return {
    baseUrl: host && !/^https?:\/\//i.test(host) ? `https://${host}` : host,
    token: pick('GITLAB_TOKEN'),
    /**
     * A SECOND token, Developer-level, read by `mr` and by nothing else.
     *
     * GITLAB_TOKEN above is Reporter: enough to read the board and write comments and labels, and not
     * enough to open a merge request. Raising it would be the obvious move and is the wrong one — that
     * token runs on every session start and on every list, show, comment and label, so it is the one
     * credential here that is used constantly, and it is the last one that should also be able to ship.
     * Opening a merge request happens a handful of times per branch, so the elevated token is the rare
     * one and stays confined to the single code path that needs it.
     *
     * Absent, everything except `mr` works exactly as before. `mr` then refuses and says why.
     */
    mrToken: pick('GITLAB_MR_TOKEN'),
    projectId: pick('GITLAB_PROJECT_ID'),
    timeoutMs: Number(pick('GITLAB_TIMEOUT_MS')) || 8000,
  };
}

/** A GitLab issue as an Item. `locked` is GitLab's other open state. */
export function gitlabItem(i) {
  return {
    iid: i.iid,
    title: i.title,
    url: i.web_url,
    labels: i.labels ?? [],
    description: i.description ?? '',
    state: i.state === 'closed' ? 'closed' : 'open',
    // Fails closed: an issue whose flag did not come back is confidential (core.isConfidential).
    confidential: i.confidential !== false,
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    commentCount: i.user_notes_count ?? 0,
    milestone: i.milestone ? { title: i.milestone.title } : null,
  };
}

/** A GitLab note as a Comment. System notes ("changed the title") are dropped before this. */
export function gitlabComment(n) {
  return {
    id: n.id,
    authorId: n.author?.id ?? null,
    author: n.author?.username ?? '',
    body: n.body ?? '',
    createdAt: n.created_at,
  };
}

/** A GitLab milestone as a Milestone. GitLab calls an open milestone `active`. */
export function gitlabMilestone(m) {
  return {
    id: m.id,
    title: m.title,
    state: m.state === 'closed' ? 'closed' : 'open',
    due: m.due_date ?? null,
    url: m.web_url ?? null,
  };
}

/**
 * A GitLab merge request as an Mr. `mergeSha` is the commit it left on its target: the merge commit, else
 * the squash commit, else its own head (a fast-forward merge). `release finalize` checks with git which of
 * those it is.
 */
export function gitlabMr(m) {
  return {
    iid: m.iid,
    title: m.title,
    sourceBranch: m.source_branch,
    targetBranch: m.target_branch,
    description: m.description ?? '',
    state: m.state === 'merged' ? 'merged' : m.state === 'opened' ? 'open' : 'closed',
    mergeSha: m.state === 'merged' ? (m.merge_commit_sha ?? m.squash_commit_sha ?? m.sha ?? null) : null,
    url: m.web_url,
  };
}

/**
 * The merge requests a range of commit messages names, for this project only, ascending. GitLab writes
 * `See merge request group/project!167` into every merge commit; one from another project is not ours.
 */
export function gitlabMrRefs(messages, projectPath) {
  const out = new Set();
  for (const msg of messages) {
    for (const m of `${msg.subject}\n${msg.body}`.matchAll(/See merge request ([\w.\-/]+)!(\d+)/g)) {
      if (m[1] === projectPath) out.add(Number(m[2]));
    }
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * The id of the link between an item and `other`, from the item's `/links` listing, or null.
 *
 * GitLab deletes a link by its own `issue_link_id`, not by the pair of items, and the listing returns the
 * OTHER item of each link with that id attached.
 */
export function linkIdFor(links, other) {
  const hit = (links || []).find((l) => String(l.iid) === String(other));
  return hit?.issue_link_id ?? null;
}

export function createGitlab(env, root, { unconfigured = false, fetch: fetchImpl = fetch } = {}) {
  const cfg = gitlabConfig(env, root);

  async function call(urlPath, method = 'GET', body, token = cfg.token) {
    if (!cfg.baseUrl || !token || !cfg.projectId) {
      throw new BoardError(
        'GitLab is not configured — set GITLAB_URL, GITLAB_TOKEN and GITLAB_PROJECT_ID in .env.gitlab ' +
          `(copy .env.gitlab.example)${unconfigured ? ', or set up .env.github for a GitHub board' : ''}`,
        'network',
      );
    }
    const res = await fetchWithin(
      fetchImpl,
      `${cfg.baseUrl}/api/v4${urlPath}`,
      {
        method,
        headers: {
          'PRIVATE-TOKEN': token,
          // FormData carries its own multipart content type WITH the boundary, which only fetch can
          // generate. Setting the header ourselves here would produce a boundary-less type and GitLab would
          // reject the upload as malformed.
          ...(body === undefined || body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined || body instanceof FormData ? body : JSON.stringify(body),
      },
      { timeoutMs: cfg.timeoutMs, name: 'GitLab' },
    );
    if (!res.ok) {
      const code =
        res.status === 401
          ? 'unauthenticated'
          : res.status === 403
            ? 'forbidden'
            : res.status === 404
              ? 'not-found'
              : 'http_error';
      throw new BoardError(`GitLab ${method} ${urlPath} answered ${res.status}`, code, res.status);
    }
    return res.status === 204 ? null : await res.json();
  }

  const projectPath = `/projects/${encodeURIComponent(cfg.projectId)}`;
  const api = (urlPath, method, body, token) => call(`${projectPath}${urlPath}`, method, body, token);

  /** Every page of a GitLab list endpoint. `per_page` tops out at 100, and a board gets past that. */
  async function apiAll(urlPath) {
    const out = [];
    for (let page = 1; ; page++) {
      const sep = urlPath.includes('?') ? '&' : '?';
      const batch = await api(`${urlPath}${sep}per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) return out;
    }
  }

  let projectInfo;
  /** The project's settings that a release depends on. */
  function project() {
    projectInfo ??= api('').then((p) => ({
      defaultBranch: p.default_branch,
      path: p.path_with_namespace,
      url: p.web_url,
      // A release has to reach the default branch as a merge commit (docs/agents/releasing.md).
      squashAlways: p.squash_option === 'always',
      mergeMethod: p.merge_method,
    }));
    return projectInfo;
  }

  const notFoundIsNull = async (promise) => {
    try {
      return await promise;
    } catch (e) {
      if (e instanceof BoardError && e.code === 'not-found') return null;
      throw e;
    }
  };

  async function getRelease(tag) {
    const r = await notFoundIsNull(
      api(`/releases/${encodeURIComponent(tag)}`, 'GET', undefined, cfg.mrToken),
    );
    return r && { url: r._links?.self ?? `${(await project()).url}/-/releases/${tag}` };
  }

  /** The users behind our tokens, each looked up once; a failed lookup is null. */
  const users = new Map();
  const userOf = (token) => {
    if (!users.has(token))
      users.set(
        token,
        call('/user', 'GET', undefined, token).catch(() => null),
      );
    return users.get(token);
  };
  let ours;
  const ourIds = () =>
    (ours ??= Promise.all([userOf(cfg.token), cfg.mrToken ? userOf(cfg.mrToken) : null]).then((us) =>
      us.filter((u) => u?.id != null).map((u) => u.id),
    ));

  const putLabels = (iid, labels, extra = '') =>
    api(`/issues/${iid}?${extra}labels=${encodeURIComponent(labels.join(','))}`, 'PUT');

  return {
    name: 'gitlab',
    label: 'GitLab',
    where: cfg.projectId,
    mrRef: (iid) => `!${iid}`,
    maxUploadBytes: MAX_UPLOAD_BYTES,

    /**
     * Who the token is. "Is the newest comment ours?" used to be answered by prefix-matching
     * `## Remediation plan —`, which was wrong the moment we posted a SECOND kind of comment: a coverage
     * round does not carry that heading, so our own follow-up read as the reporter's reply and the item
     * would have sat in `answered` forever, looking as though the ball were with us when we had just
     * passed it back.
     *
     * The author is the honest test, and it needs no marker vocabulary to be kept in step. The prefix
     * survives for the different question of whether a PLAN exists.
     *
     * That test needs the token to be a project access token's bot user (ADR 0002). A personal token is
     * warned about on stderr, so `--json` and `--hook` stay parseable, and the run carries on (#39).
     */
    async whoami() {
      // A failed lookup is null: the markers carry it, and a listing must not fail over an identity lookup.
      const u = await userOf(cfg.token);
      if (u?.bot === false)
        console.error(
          `GITLAB_TOKEN belongs to ${u.username}, a person: their own replies will read as ours (ADR 0002)`,
        );
      return u?.id ?? null;
    },
    listOpen: async () => (await apiAll('/issues?state=opened&order_by=created_at&sort=asc')).map(gitlabItem),
    listAll: async () => (await apiAll('/issues?state=all')).map(gitlabItem),
    get: async (iid) => gitlabItem(await api(`/issues/${iid}`)),
    comments: async (iid) =>
      (await apiAll(`/issues/${iid}/notes?sort=asc&order_by=created_at`))
        .filter((n) => !n.system)
        .map(gitlabComment),
    comment: async (iid, body) => ({ id: (await api(`/issues/${iid}/notes`, 'POST', { body })).id }),
    setLabels: async (iid, labels) => gitlabItem(await putLabels(iid, labels)),
    /**
     * Creates the label when the project has none of that name. True when it did.
     *
     * Every page is read: GitLab lists group labels too, and `release-*` sorts late, so on a project past
     * 100 labels a one-page read missed it and the POST failed as a duplicate (#33, #36). A 409 still
     * means the label exists — one listed only to some tokens, or made since the read — so it is success.
     */
    async ensureLabel(name, color, description) {
      const existing = new Set((await apiAll('/labels')).map((l) => l.name));
      if (existing.has(name)) return false;
      try {
        await api('/labels', 'POST', { name, color, description });
      } catch (e) {
        if (e?.status === 409) return false;
        throw e;
      }
      return true;
    },
    create: async ({ title, description, labels }) =>
      gitlabItem(
        await api('/issues', 'POST', {
          title,
          description,
          ...(labels?.length ? { labels: labels.join(',') } : {}),
        }),
      ),
    /**
     * State and labels in one PUT, so there is no window in which the item is closed and still claims to
     * be under way. GitLab clears labels on an empty `labels=`, which `label <iid> none` also relies on.
     */
    close: async (iid, labels) => gitlabItem(await putLabels(iid, labels, 'state_event=close&')),
    /**
     * Linked items, or null when this instance has no linked issues (a 404 or 403 on the endpoint). Any
     * other failure is thrown: read as "no links", a timeout made a batch resume re-POST links that
     * existed and stop on GitLab's 409, naming the wrong cause (#36).
     */
    async links(iid) {
      try {
        return (await api(`/issues/${iid}/links`)).map((l) => ({ iid: l.iid }));
      } catch (e) {
        if (e?.code === 'not-found' || e?.code === 'forbidden') return null;
        throw e;
      }
    },
    /**
     * `relates_to` rather than `blocks`, because these are siblings split from one plan — `show`'s sibling
     * check reads any link, and a `blocks` edge would additionally claim a sequencing nobody here knows.
     * Linking a pair that is already linked is a no-op, not an error.
     */
    async link(iid, other) {
      try {
        return await api(`/issues/${iid}/links`, 'POST', {
          target_project_id: cfg.projectId,
          target_issue_iid: String(other),
          link_type: 'relates_to',
        });
      } catch (e) {
        if (e?.status === 409) return null; // GitLab's answer for a pair that is already linked
        throw e;
      }
    },
    /** False when the two are not linked. */
    async unlink(iid, other) {
      const id = linkIdFor(await api(`/issues/${iid}/links`), other);
      if (id == null) return false;
      await api(`/issues/${iid}/links/${id}`, 'DELETE');
      return true;
    },
    milestones: async (state) =>
      (await apiAll(`/milestones?state=${state === 'open' ? 'active' : 'all'}`)).map(gitlabMilestone),
    createMilestone: async (title) => gitlabMilestone(await api('/milestones', 'POST', { title })),
    setMilestone: (iid, id) => api(`/issues/${iid}?milestone_id=${id}`, 'PUT'),
    /** Uploads to the project and returns GitLab's own markdown for the file. */
    async upload({ name, bytes, type }) {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type }), name);
      return (await api('/uploads', 'POST', form)).markdown;
    },
    defaultBranch: async () => (await project()).defaultBranch,
    project,

    /** Why `mr` cannot run, or null when it can. */
    mrUnavailable: () =>
      cfg.mrToken
        ? null
        : 'GITLAB_MR_TOKEN is not set, and GITLAB_TOKEN is deliberately Reporter-level, which cannot open a\n' +
          'merge request. Add a Developer-level project access token as GITLAB_MR_TOKEN in .env.gitlab —\n' +
          'see .env.gitlab.example for why it is a second token rather than a bigger first one.',
    mrForbidden:
      'GITLAB_MR_TOKEN was refused (403). It needs at least Developer on this project to open a merge\n' +
      'request; Reporter is not enough.',
    /**
     * `forRelease` keeps the source branch and turns squashing off: a release reaches the default branch
     * as a merge commit, and its branches outlive the merge.
     */
    async openMr({ source, target, title, description, forRelease = false }) {
      const mr = await api(
        '/merge_requests',
        'POST',
        {
          source_branch: source,
          target_branch: target,
          title,
          description,
          remove_source_branch: !forRelease,
          ...(forRelease ? { squash: false } : {}),
        },
        cfg.mrToken,
      );
      return { iid: mr.iid, url: mr.web_url };
    },
    mrRefs: async (messages) => gitlabMrRefs(messages, (await project()).path),
    /**
     * Null for a number that is no merge request. Also says who merged it: `merge_user`, or on an older
     * instance the deprecated `merged_by`. `mergedByBot` is true when it was one of OUR tokens' users —
     * every project access token is a bot user of its own, and the Developer GITLAB_MR_TOKEN is the one
     * that could merge, so comparing with the board token alone would call its merge a person's.
     */
    getMr: async (iid) => {
      const mr = await notFoundIsNull(api(`/merge_requests/${iid}`));
      if (!mr) return null;
      const by = mr.merge_user ?? mr.merged_by ?? null;
      return {
        ...gitlabMr(mr),
        mergedBy: by?.username ?? null,
        mergedByBot: by != null && (await ourIds()).includes(by.id),
      };
    },
    /** Merge requests from `source` (into `target`, when given), newest first. */
    async findMrs({ source, target, state = 'all' }) {
      const q = `source_branch=${encodeURIComponent(source)}${target ? `&target_branch=${encodeURIComponent(target)}` : ''}`;
      return (await apiAll(`/merge_requests?state=${state === 'open' ? 'opened' : 'all'}&${q}`))
        .map(gitlabMr)
        .sort((a, b) => b.iid - a.iid);
    },

    // Releases, written with the Developer token: Reporter cannot create one.
    releaseCarriesMilestone: true,
    getRelease,
    /** Creates the release for an existing tag, or rewrites its name and notes. */
    async saveRelease({ tag, name, description, milestone }) {
      const payload = { name, description, ...(milestone ? { milestones: [milestone] } : {}) };
      const existing = await getRelease(tag);
      if (existing) await api(`/releases/${encodeURIComponent(tag)}`, 'PUT', payload, cfg.mrToken);
      else await api('/releases', 'POST', { tag_name: tag, ...payload }, cfg.mrToken);
      return getRelease(tag);
    },
    /**
     * Uploads a file to the project and links it from the release as `name`. Found again by that name, so
     * a second run moves the one link to the new upload rather than adding another.
     */
    async attachToRelease(tag, { name, filename, bytes, type }) {
      const form = new FormData();
      form.append('file', new Blob([bytes], { type }), filename);
      const up = await api('/uploads', 'POST', form);
      // `full_path` is instance-relative and carries the project; older GitLabs give only the project-relative `url`.
      const url = up.full_path ? `${cfg.baseUrl}${up.full_path}` : `${(await project()).url}${up.url}`;
      const linksPath = `/releases/${encodeURIComponent(tag)}/assets/links`;
      const mine = (await api(linksPath, 'GET', undefined, cfg.mrToken)).find((l) => l.name === name);
      if (mine) await api(`${linksPath}/${mine.id}`, 'PUT', { url }, cfg.mrToken);
      else await api(linksPath, 'POST', { name, url, link_type: 'other' }, cfg.mrToken);
      return { url, replaced: Boolean(mine) };
    },
    /** 'closed', 'already' or 'none'. */
    async closeMilestone(title) {
      const m = (await apiAll(`/milestones?title=${encodeURIComponent(title)}`))[0];
      if (!m) return 'none';
      if (m.state === 'closed') return 'already';
      await api(`/milestones/${m.id}?state_event=close`, 'PUT');
      return 'closed';
    },
    commentMr: async (iid, body) => ({
      id: (await api(`/merge_requests/${iid}/notes`, 'POST', { body })).id,
    }),
  };
}

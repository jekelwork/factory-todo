// `pnpm check:items`, the board migration's part: scripts/board/migrate.mjs driven against a fake GitLab, an
// in-memory GitHub and a real bare git repository standing in for `board-assets`, offline. Every case asserts
// the whole list of writes, not its length (AGENTS.md, "Assert the whole answer"). The lessons of the first
// real migration (docs/agents/migrating-a-board.md, "What the first real run taught") each have a case here,
// named `lesson:`.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BoardError } from './config.mjs';
import { classify, migratedFrom } from './core.mjs';
import {
  applyPlan,
  CONFIDENTIAL_DEFAULTS,
  commentBody,
  desired,
  expectedSeconds,
  fetchUpload,
  foldPoint,
  foreignNumbers,
  gitEnv,
  gitIn,
  gitlabReader,
  issueBody,
  mappingReport,
  migrateSettings,
  migrationClient,
  pacer,
  planSync as planSyncBare,
  readGithub,
  readGitlab,
  refusedUploads,
  releaseLinks,
  rewrite,
  stageAssets,
  tally,
  targetGuard,
  uploadsIn,
  verify,
  verifyReleases,
} from './migrate.mjs';
import { fakeFetch } from './selftest.mjs';

/** The `copy` policy with the defaults, as a package.json naming only the policy gives it. */
const COPY = migrateSettings({ factoryKit: { migrate: { confidential: { policy: 'copy' } } } }).confidential;
/** planSync with the confidential items copied: the fixture board has one. */
const planSync = (source, target, opts = {}) => planSyncBare(source, target, { confidential: COPY, ...opts });

const GL = 'https://git.example/g/p';
const BOT = 7; // the GitLab board bot
const ALICE = 50;
const APP = 4242; // the GitHub App's bot user
const SECRET = '0123456789abcdef0123456789abcdef';

/** The GitLab board: #1–#7, #5 deleted, #6 confidential, #7 closed, #4 carrying a plan and a reply. */
function gitlabBoard() {
  const issue = (iid, extra = {}) => ({
    id: 1000 + iid,
    iid,
    title: `Item ${iid}`,
    description: '',
    state: 'opened',
    confidential: false,
    labels: ['feedback'],
    milestone: null,
    author: { id: ALICE, username: 'alice' },
    created_at: `2026-10-0${Math.min(iid, 9)}T08:00:00Z`,
    updated_at: '2026-10-10T08:00:00Z',
    web_url: `${GL}/-/work_items/${iid}`,
    ...extra,
  });
  const issues = [
    issue(1),
    issue(2),
    issue(3),
    issue(4, {
      labels: ['ai:plan-posted', 'feedback'],
      milestone: { title: 'release-0.4.4' },
      description: `See #2 and #6, fixed in !12. cc @bob, not a@b.example\n\n![shot](/uploads/${SECRET}/shot.png)\n\n\`#3 in code @carol\``,
    }),
    issue(6, { confidential: true, labels: [], author: { id: 51, username: 'bob' } }),
    issue(7, { state: 'closed', author: { id: BOT, username: 'board-bot' } }),
  ];
  const notes = {
    4: [
      {
        id: 900,
        system: true,
        body: 'changed the title',
        author: { id: ALICE, username: 'alice' },
        created_at: '2026-10-04T09:00:00Z',
      },
      {
        id: 901,
        body: '## Remediation plan — x\n\n**[REVIEW 1]** a',
        author: { id: BOT, username: 'board-bot' },
        created_at: '2026-10-04T10:00:00Z',
      },
      {
        id: 902,
        body: 'yes, see #3',
        author: { id: ALICE, username: 'alice' },
        created_at: '2026-10-05T10:00:00Z',
      },
    ],
  };
  return { issues, notes, releases: [] };
}

/** A fake GitLab that answers the reader's GETs from `board`, and records them. */
function fakeGitlab(board) {
  const path_ = (u) => new URL(u).pathname.replace('/api/v4', '');
  return fakeFetch([
    [
      (m, u) => m === 'GET' && path_(u) === '/projects/9',
      { json: { id: 9, web_url: GL, path_with_namespace: 'g/p' } },
    ],
    [(m, u) => m === 'GET' && path_(u) === '/user', { json: { id: BOT, username: 'board-bot' } }],
    [(m, u) => m === 'GET' && path_(u) === '/projects/9/issues', () => ({ json: board.issues })],
    [(m, u) => m === 'GET' && path_(u) === '/projects/9/releases', () => ({ json: board.releases })],
    [
      (m, u) => m === 'GET' && path_(u) === '/projects/9/labels',
      { json: [{ name: 'feedback', color: '#428BCA', description: 'fb' }] },
    ],
    [
      (m, u) => m === 'GET' && path_(u) === '/projects/9/milestones',
      { json: [{ title: 'release-0.4.4', due_date: '2026-10-30', state: 'active' }] },
    ],
    [
      (m, u) => m === 'GET' && /^\/projects\/9\/issues\/\d+\/notes$/.test(path_(u)),
      (u) => ({ json: board.notes[Number(path_(u).split('/')[4])] ?? [] }),
    ],
    [
      (m, u) => m === 'GET' && /^\/projects\/9\/issues\/\d+\/links$/.test(path_(u)),
      (u) => ({
        json:
          path_(u).split('/')[4] === '4'
            ? [
                { iid: 7, project_id: 9 },
                { iid: 100, project_id: 10 },
              ]
            : [],
      }),
    ],
    [
      (m, u) => m === 'GET' && path_(u).startsWith('/projects/9/uploads/'),
      { json: null }, // bytes are read with arrayBuffer below
    ],
  ]);
}

/** An in-memory GitHub repository, just big enough for the migration's reads and writes. */
/** An in-memory GitHub; `board-assets` is read from the bare repository `remote` the staging pushes to. */
function fakeGithub(remote = null) {
  const s = {
    issues: new Map(),
    comments: [],
    labels: new Set(),
    milestones: [],
    tree: null,
    nextComment: 1,
    hidden: new Set(), // numbers the listings leave out, as GitHub's did while degraded
    refused: () => false, // paths that answer 403, as for an App installed without pull requests
    releases: [],
    tags: [],
    latestTag: null,
    tagsMadeByRelease: [], // a tag GitHub would make for a release whose tag is missing: must stay empty
    conflict: () => false, // paths that answer 409, as the git data API does on an empty repository
    spent: new Set(), // numbers GitHub used up without making an issue: 404 for good
    burnNext: false, // the next POST /issues answers 502 and spends its number, as on the first real run
  };
  const user = (id) => ({ id, login: id === APP ? 'board-app[bot]' : 'human' });
  const issueJson = (i) => ({
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    labels: i.labels.map((name) => ({ name })),
    milestone: i.milestone ? { title: i.milestone } : null,
    user: user(i.authorId),
    ...(i.pr ? { pull_request: {} } : {}),
  });
  const max = () => Math.max(0, ...s.issues.keys(), ...s.spent);
  const add = (fields) => {
    const number = max() + 1;
    s.issues.set(number, { number, state: 'open', labels: [], milestone: null, body: '', ...fields });
    return number;
  };
  const writes = [];
  const handle = (method, url, body) => {
    const u = new URL(url);
    const p = u.pathname.replace('/repos/o/r', '');
    if (method !== 'GET' && !p.endsWith('/access_tokens')) writes.push(`${method} ${p}`);
    if (p === '/installation') return { json: { id: 77 } };
    if (p === '/app/installations/77/access_tokens') return { json: { token: 'tok' } };
    if (p === '/app') return { json: { slug: 'board-app' } };
    if (p.startsWith('/users/')) return { json: { id: APP } };
    if (s.refused(p)) return { status: 403, json: { message: 'Resource not accessible by integration' } };
    if (s.conflict(p)) return { status: 409, json: { message: 'Git Repository is empty.' } };
    // As for the board token on GitHub: the issue listings leave pull requests out, and `issues/<n>` of
    // one answers 403. Only `pulls` shows them.
    if (p === '/issues' && method === 'GET') {
      const all = [...s.issues.values()]
        .filter((i) => !s.hidden.has(i.number) && !i.pr)
        .sort((a, b) => a.number - b.number)
        .map(issueJson);
      return { json: u.searchParams.get('direction') === 'desc' ? all.reverse().slice(0, 1) : all };
    }
    const one = /^\/issues\/(\d+)$/.exec(p);
    if (one && method === 'GET' && s.issues.get(Number(one[1]))?.pr)
      return { status: 403, json: { message: 'Resource not accessible by integration' } };
    if (one && method === 'GET' && s.issues.has(Number(one[1])))
      return { json: issueJson(s.issues.get(Number(one[1]))) };
    if (p === '/pulls' && method === 'GET') {
      const all = [...s.issues.values()]
        .filter((i) => i.pr)
        .sort((a, b) => a.number - b.number)
        .map(issueJson);
      return { json: u.searchParams.get('direction') === 'desc' ? all.reverse().slice(0, 1) : all };
    }
    const pull = /^\/pulls\/(\d+)$/.exec(p);
    if (pull && method === 'GET' && s.issues.get(Number(pull[1]))?.pr)
      return { json: issueJson(s.issues.get(Number(pull[1]))) };
    const theirs = /^\/issues\/(\d+)\/comments$/.exec(p);
    if (theirs && method === 'GET')
      return {
        json: s.comments
          .filter((c) => c.issue === Number(theirs[1]))
          .map((c) => ({ id: c.id, body: c.body, user: user(c.authorId) })),
      };
    if (p === '/issues' && method === 'POST' && s.burnNext) {
      s.burnNext = false;
      s.spent.add(max() + 1);
      return { status: 502, json: { message: 'Server Error' } };
    }
    if (p === '/issues' && method === 'POST') {
      const ms = s.milestones.find((m) => m.number === body.milestone);
      const number = add({
        title: body.title,
        body: body.body,
        labels: body.labels ?? [],
        milestone: ms?.title ?? null,
        authorId: APP,
      });
      return { status: 201, json: issueJson(s.issues.get(number)) };
    }
    let m = /^\/issues\/(\d+)$/.exec(p);
    if (m && method === 'PATCH') {
      const i = s.issues.get(Number(m[1]));
      if ('title' in body) i.title = body.title;
      if ('body' in body) i.body = body.body;
      if ('labels' in body) i.labels = body.labels;
      if ('state' in body) i.state = body.state;
      if ('milestone' in body)
        i.milestone = s.milestones.find((x) => x.number === body.milestone)?.title ?? null;
      return { json: issueJson(i) };
    }
    if (p === '/issues/comments' && method === 'GET') {
      return {
        json: s.comments.map((c) => ({
          id: c.id,
          body: c.body,
          user: user(c.authorId),
          issue_url: `https://api.github.com/repos/o/r/issues/${c.issue}`,
        })),
      };
    }
    m = /^\/issues\/(\d+)\/comments$/.exec(p);
    if (m && method === 'POST') {
      const c = { id: s.nextComment++, issue: Number(m[1]), body: body.body, authorId: APP };
      s.comments.push(c);
      return { status: 201, json: { id: c.id } };
    }
    m = /^\/issues\/comments\/(\d+)$/.exec(p);
    if (m && method === 'PATCH') {
      s.comments.find((c) => c.id === Number(m[1])).body = body.body;
      return { json: {} };
    }
    if (p === '/labels' && method === 'GET') return { json: [...s.labels].map((name) => ({ name })) };
    if (p === '/labels' && method === 'POST') {
      s.labels.add(body.name);
      return { status: 201, json: {} };
    }
    if (p === '/milestones' && method === 'GET')
      return { json: s.milestones.map((x) => ({ title: x.title, number: x.number })) };
    if (p === '/milestones' && method === 'POST') {
      const ms = { title: body.title, number: s.milestones.length + 1 };
      s.milestones.push(ms);
      return { status: 201, json: ms };
    }
    if (p === '/git/trees/board-assets') {
      let paths = null;
      try {
        paths = execFileSync('git', ['-C', remote, 'ls-tree', '-r', '--name-only', 'board-assets'], {
          env: gitEnv(),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .split('\n')
          .filter(Boolean);
      } catch {
        /* no branch yet */
      }
      return paths
        ? { json: { tree: paths.map((x) => ({ path: x, type: 'blob' })) } }
        : { status: 404, json: {} };
    }
    if (p === '/git/ref/heads/board-assets') return s.tree ? { json: {} } : { status: 404, json: {} };
    if (/^\/git\/(blobs|trees|commits)$/.test(p)) return { status: 201, json: { sha: 'abc' } };
    if (p === '/git/refs') {
      s.tree = ['README.md'];
      return { status: 201, json: {} };
    }
    m = /^\/contents\/(.+)$/.exec(p);
    if (m && method === 'PUT') {
      const where = m[1].split('/').map(decodeURIComponent).join('/');
      s.tree.push(where);
      return {
        status: 201,
        json: { content: { html_url: `https://github.com/o/r/blob/board-assets/${m[1]}` } },
      };
    }
    const relJson = (r) => ({
      id: r.id,
      tag_name: r.tag,
      name: r.name,
      body: r.body,
      draft: r.draft,
      prerelease: r.prerelease,
      upload_url: `https://uploads.github.com/repos/o/r/releases/${r.id}/assets{?name,label}`,
      assets: r.assets,
    });
    if (p === '/releases' && method === 'GET') return { json: s.releases.map(relJson) };
    if (p === '/releases/latest') {
      const r = s.releases.find((x) => x.tag === s.latestTag);
      return r ? { json: relJson(r) } : { status: 404, json: {} };
    }
    if (p === '/git/matching-refs/tags/') return { json: s.tags.map((t) => ({ ref: `refs/tags/${t}` })) };
    if (p === '/releases' && method === 'POST') {
      if (!s.tags.includes(body.tag_name)) s.tagsMadeByRelease.push(body.tag_name);
      if ('target_commitish' in body) s.tagsMadeByRelease.push(`commitish:${body.target_commitish}`);
      const r = {
        id: 500 + s.releases.length,
        tag: body.tag_name,
        name: body.name,
        body: body.body,
        draft: body.draft,
        prerelease: body.prerelease,
        assets: [],
      };
      s.releases.push(r);
      if (body.make_latest === 'true') s.latestTag = r.tag;
      return { status: 201, json: relJson(r) };
    }
    m = /^\/releases\/(\d+)$/.exec(p);
    if (m && method === 'PATCH') {
      const r = s.releases.find((x) => x.id === Number(m[1]));
      for (const k of ['name', 'body', 'draft', 'prerelease']) if (k in body) r[k] = body[k];
      if (body.make_latest === 'true') s.latestTag = r.tag;
      return { json: relJson(r) };
    }
    m = /^\/releases\/tags\/(.+)$/.exec(p);
    if (m) {
      const r = s.releases.find((x) => x.tag === decodeURIComponent(m[1]));
      return r ? { json: relJson(r) } : { status: 404, json: {} };
    }
    m = /^\/releases\/(\d+)\/assets$/.exec(p);
    if (m && method === 'POST') {
      const r = s.releases.find((x) => x.id === Number(m[1]));
      r.assets.push({
        id: r.assets.length + 1,
        name: u.searchParams.get('name'),
        label: u.searchParams.get('label'),
      });
      return { status: 201, json: {} };
    }
    return { status: 404, json: {} };
  };
  const impl = async (url, init = {}) => {
    const out = handle(
      init.method ?? 'GET',
      String(url),
      typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
    );
    const status = out.status ?? 200;
    return {
      ok: status < 300,
      status,
      headers: { get: () => null },
      json: async () => out.json,
      text: async () => JSON.stringify(out.json),
    };
  };
  return { s, impl, add, writes };
}

export async function migrateSelftest() {
  let failed = 0;
  const check = (name, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) console.log(`✓ ${name}`);
    else {
      failed++;
      console.error(`✗ ${name}:\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
    }
  };

  // ---- settings ------------------------------------------------------------------------------------------
  const refusal = (pkg) => {
    try {
      migrateSettings(pkg);
      return null;
    } catch (e) {
      return [e.code, e.message];
    }
  };
  const block = (migrate) => ({ factoryKit: { migrate } });
  check(
    'settings: none is no protection by name, no policy, every tracked file',
    [migrateSettings({}), migrateSettings(block({}))],
    [
      { protect: [], confidential: null, gitlab: null, linkFiles: [] },
      { protect: [], confidential: null, gitlab: null, linkFiles: [] },
    ],
  );
  check(
    "settings: a whole block is read, the repository lowercased, the URL trimmed, the colour given its '#'",
    migrateSettings(
      block({
        protectedRepository: ['Owner/Repo', 'owner/other'],
        confidential: { policy: 'copy', color: 'AA0000', description: 'd', notice: 'line one\nline two' },
        gitlab: 'https://gitlab.example/group/project/',
        linkFiles: ['docs', '*.md'],
      }),
    ),
    {
      protect: ['owner/repo', 'owner/other'],
      confidential: { policy: 'copy', color: '#AA0000', description: 'd', notice: 'line one\nline two' },
      gitlab: 'https://gitlab.example/group/project',
      linkFiles: ['docs', '*.md'],
    },
  );
  check('settings: the copy policy alone takes the defaults', COPY, {
    policy: 'copy',
    ...CONFIDENTIAL_DEFAULTS,
  });
  const pre = 'package.json factoryKit.migrate: ';
  check(
    'settings: placeholder and skip are named as not built, and every other mistake is refused, not ignored',
    [
      refusal(block({ confidential: { policy: 'placeholder' } })),
      refusal(block({ confidential: { policy: 'skip' } })),
      refusal(block({ confidential: {} })),
      refusal(block({ confidential: { policy: 'copy', label: 'secret' } })),
      refusal(block({ protectedRepositry: 'o/r' })),
      refusal(block({ protectedRepository: 'just-a-name' })),
      refusal(block({ gitlab: 'gitlab.example/g/p' })),
      refusal(block({ linkFiles: 'docs' })),
    ],
    [
      [
        'misconfigured',
        `${pre}confidential.policy "placeholder" is not built; only "copy" is (docs/agents/migrating-a-board.md, "Confidential items")`,
      ],
      [
        'misconfigured',
        `${pre}confidential.policy "skip" is not built; only "copy" is (docs/agents/migrating-a-board.md, "Confidential items")`,
      ],
      ['misconfigured', `${pre}confidential.policy is "copy", the one policy built; got undefined`],
      [
        'misconfigured',
        `${pre}unknown confidential setting label; they are policy, color, description, notice`,
      ],
      [
        'misconfigured',
        `${pre}unknown setting protectedRepositry; the settings are protectedRepository, confidential, gitlab, linkFiles`,
      ],
      ['misconfigured', `${pre}protectedRepository is an owner/name, or a list of them; got "just-a-name"`],
      [
        'misconfigured',
        `${pre}gitlab is the GitLab project's URL, such as "https://gitlab.example/group/project"; got "gitlab.example/g/p"`,
      ],
      ['misconfigured', `${pre}linkFiles is a list of git pathspecs, such as ["docs", "*.md"]`],
    ],
  );

  // ---- the guard -----------------------------------------------------------------------------------------
  const g = (repository, repoFlag, cutover, writes, foreign = 0, protect = ['owner/real']) =>
    targetGuard({ repository, repoFlag, cutover, writes, protect, foreign });
  check(
    'guard: a protected target is read only when named, and written only with --cutover too',
    [
      g('owner/real', undefined, false, false),
      g('owner/real', 'owner/real', false, false),
      g('owner/real', 'owner/real', false, true),
      g('Owner/Real', 'owner/real', true, true),
    ],
    [
      'owner/real is protected (factoryKit.migrate.protectedRepository): name it with --repo=owner/real to read it',
      null,
      'owner/real is protected: it takes writes only with --cutover as well',
      null,
    ],
  );
  check(
    'guard: with no protected target set, a write still names its target, and a target holding others’ numbers takes --cutover',
    [
      g('owner/scratch', undefined, false, false, 0, []),
      g('owner/scratch', undefined, false, true, 0, []),
      g('owner/scratch', 'owner/scratch', false, true, 0, []),
      g('owner/scratch', 'owner/scratch', false, true, 3, []),
      g('owner/scratch', 'owner/scratch', true, true, 3, []),
      g('', undefined, false, false, 0, []),
    ],
    [
      null,
      'a run that writes names its target: --repo=owner/scratch, or --dry-run to only look',
      null,
      'owner/scratch already holds 3 issue(s) or pull request(s) the migration did not write: writing there takes --cutover as well',
      null,
      'no target repository: set GITHUB_REPOSITORY in .env.github, or pass --repo=',
    ],
  );

  // ---- text ----------------------------------------------------------------------------------------------
  const ctx0 = { gitlabUrl: GL, collisions: new Set([1, 2, 3]), mapping: new Map([[2, 9]]), remap: false };
  check(
    'migrate: collision-range #N links to GitLab (or with --remap, to its GitHub number), !N to the MR, @ defused, code kept',
    [
      rewrite('see #2, #6 and !12; ask @bob or a@b.example `#3 @carol`', ctx0),
      rewrite('see #2 and #3', { ...ctx0, remap: true }),
      rewrite(
        `![x](/uploads/${SECRET}/a%20b.png) and ${GL}/uploads/${SECRET}/c.png`,
        ctx0,
        (u) => `ASSET:${u.file}`,
      ),
    ],
    [
      `see [#2](${GL}/-/issues/2), #6 and [!12](${GL}/-/merge_requests/12); ask @​bob or a@b.example \`#3 @carol\``,
      `see #9 and [#3](${GL}/-/issues/3)`,
      '![x](ASSET:a%20b.png) and ASSET:c.png',
    ],
  );

  // ---- reading GitLab ------------------------------------------------------------------------------------
  const board = gitlabBoard();
  const glFake = fakeGitlab(board);
  const glEnv = { GITLAB_URL: 'https://git.example', GITLAB_TOKEN: 'x', GITLAB_PROJECT_ID: '9' };
  const gl = gitlabReader(glEnv, os.tmpdir(), glFake.impl);
  // Uploads come back as bytes; the fake answers every upload with these.
  const realGet = gl.get;
  gl.get = (p, o) => (o?.raw ? Promise.resolve(Buffer.from('PNG')) : realGet(p, o));
  const source = await readGitlab(gl);
  check(
    'migrate: GitLab is read with GETs only, a deleted number is asked for, system notes and other projects dropped',
    [
      glFake.calls.every((c) => c.method === 'GET'),
      [...source.items.keys()].sort((a, b) => a - b),
      source.maxIid,
      source.items.get(4).comments.map((c) => c.id),
      source.items.get(4).links,
      glFake.calls.filter((c) => /\/issues\/5$/.test(new URL(c.url).pathname)).length,
    ],
    [true, [1, 2, 3, 4, 6, 7], 7, [901, 902], [7], 1],
  );

  // ---- a fresh run ---------------------------------------------------------------------------------------
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-migrate-'));
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(path.join(keyDir, 'key.pem'), privateKey.export({ type: 'pkcs1', format: 'pem' }));
  const ghEnv = { GITHUB_REPOSITORY: 'o/r', GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY_PATH: 'key.pem' };
  try {
    // board-assets lives in a real bare repository, pushed to with real git.
    const bare = path.join(keyDir, 'remote.git');
    execFileSync('git', ['init', '--bare', '-q', bare], { env: gitEnv() });
    execFileSync('git', ['-C', bare, 'config', 'uploadpack.allowFilter', 'true'], { env: gitEnv() });
    const fake = fakeGithub(bare);
    for (let n = 1; n <= 3; n++) fake.add({ title: `throwaway ${n}`, authorId: 1000 }); // the collision range
    const gh = migrationClient(ghEnv, keyDir, { fetch: fake.impl });
    const stages = [];
    const run = async (opts = {}) => {
      const target = await readGithub(gh);
      const plan = planSync(source, target, opts);
      return { target, plan };
    };
    const apply = async (plan, target) => {
      const staged = await stageAssets(plan.uploads, {
        workDir: path.join(keyDir, 'work'),
        remote: { url: bare, token: null },
        fetchBytes: async (u) => Buffer.from(`PNG ${u.file}`),
      });
      stages.push(staged);
      return applyPlan(plan, source, target, gh, { paced: (fn) => fn() });
    };

    const fresh = await run();
    const s4 = { iid: 4 };
    check(
      'migrate: a fresh run plans labels, the milestone, then each item in number order around the collision range',
      fresh.plan.writes,
      [
        {
          op: 'ensure-label',
          name: 'ai:plan-posted',
          color: '1F75CB',
          description:
            "A remediation plan is on this item, awaiting the reporter's answers to its [REVIEW] points.",
        },
        {
          op: 'ensure-label',
          name: 'confidential',
          color: '8B0000',
          description: 'Confidential on GitLab, copied in full by the board migration.',
        },
        { op: 'ensure-label', name: 'feedback', color: '428BCA', description: 'fb' },
        { op: 'create-milestone', title: 'release-0.4.4', due: '2026-10-30', state: 'open' },
        {
          op: 'create-issue',
          iid: 4,
          expect: 4,
          title: 'Item 4',
          source: s4,
          labels: ['ai:plan-posted', 'feedback'],
          milestone: 'release-0.4.4',
        },
        { op: 'comment', iid: 4, index: 0 },
        { op: 'comment', iid: 4, index: 1 },
        {
          op: 'create-issue',
          iid: 5,
          expect: 5,
          placeholder: true,
          title: 'GitLab #5 (deleted)',
          labels: [],
          milestone: null,
        },
        { op: 'set-state', iid: 5, state: 'closed', reason: 'not_planned' },
        {
          op: 'create-issue',
          iid: 6,
          expect: 6,
          title: 'Item 6',
          source: { iid: 6 },
          labels: ['confidential'],
          milestone: null,
        },
        {
          op: 'create-issue',
          iid: 7,
          expect: 7,
          title: 'Item 7',
          source: { iid: 7 },
          labels: ['feedback'],
          milestone: null,
        },
        { op: 'set-state', iid: 7, state: 'closed' },
      ],
    );
    check(
      'migrate: the dry run lists the confidential item by number only, and the skipped collision range, and counts by type',
      [fresh.plan.confidential, fresh.plan.skipped, tally(fresh.plan.writes)],
      [
        [{ iid: 6 }],
        [1, 2, 3],
        {
          'ensure-label': 3,
          'create-milestone': 1,
          'create-issue': 3,
          comment: 2,
          'create-placeholder': 1,
          'set-state': 2,
        },
      ],
    );

    check(
      'migrate: with confidential items and no policy, nothing is planned, and the stop names numbers, never titles',
      planSyncBare(source, fresh.target),
      {
        writes: [],
        uploads: [],
        stop:
          'GitLab holds 1 confidential item(s) (#6), and package.json says nothing about them: set ' +
          'factoryKit.migrate.confidential.policy. Only "copy" is built, which copies each in full, readable by ' +
          'everybody who can read the target (docs/agents/migrating-a-board.md). Nothing was written.',
        mapping: {},
      },
    );
    check(
      "guard: the target's own issues are foreign numbers, so writing there takes --cutover",
      foreignNumbers(source, fresh.target),
      [1, 2, 3],
    );

    const done = await apply(fresh.plan, fresh.target);
    const n4 = fake.s.issues.get(4);
    check(
      "migrate: applied, every planned write is made once, and the numbers are GitLab's",
      [
        done,
        [...fake.s.issues.keys()],
        fake.s.issues.get(5).state,
        fake.s.issues.get(7).state,
        fake.s.comments.length,
      ],
      [12, [1, 2, 3, 4, 5, 6, 7], 'closed', 'closed', 2],
    );
    check(
      "lesson: uploads go by git push, before the issue, under the adapter's layout; the first push starts board-assets",
      [fresh.plan.uploads, stages[0]],
      [
        [
          {
            iid: 4,
            secret: SECRET,
            file: 'shot.png',
            name: '01234567-shot.png',
            path: 'items/4/20261004T080000Z/01234567-shot.png',
          },
        ],
        { files: 1, commits: 2, pushes: 2, bytes: 12 },
      ],
    );
    const shot = `https://github.com/o/r/blob/board-assets/items/4/20261004T080000Z/01234567-shot.png?raw=true`;
    check(
      'migrate: the body names its origin, keeps code, links the collision range to GitLab, and shows the re-hosted image',
      n4.body,
      [
        `> Migrated from GitLab [#4](${GL}/-/issues/4) · filed by @​alice on 2026-10-04`,
        `See [#2](${GL}/-/issues/2) and #6, fixed in [!12](${GL}/-/merge_requests/12). cc @​bob, not a@b.example\n\n![shot](${shot})\n\n\`#3 in code @carol\``,
        'Relates-to: #7',
        `<!-- board:migrated from=gitlab note=1004 url=${GL}/-/issues/4 author=alice at=2026-10-04T08:00:00Z kind=reply -->`,
      ].join('\n\n'),
    );
    check(
      'migrate: the confidential item says so in its body',
      fake.s.issues.get(6).body.split('\n').slice(0, 4),
      [
        `> Migrated from GitLab [#6](${GL}/-/issues/6) · filed by @​bob on 2026-10-06`,
        '>',
        '> **This item was confidential on GitLab.** It is copied in full, so everybody who can read this',
        '> repository can read it.',
      ],
    );
    const [planC, replyC] = fake.s.comments;
    const ghComments = fake.s.comments.map((c) => ({
      id: c.id,
      authorId: APP,
      author: 'board-app[bot]',
      body: c.body,
      createdAt: '2026-10-12T10:00:00Z',
    }));
    check(
      'migrate: a migrated plan still opens with its heading, the reply with its attribution, and the item reads answered on both sides',
      [
        planC.body.startsWith('## Remediation plan'),
        migratedFrom(planC.body).kind,
        replyC.body.split('\n')[0],
        migratedFrom(replyC.body).kind,
        classify({ labels: n4.labels, updatedAt: '2026-10-10T08:00:00Z' }, ghComments, APP).state,
        classify({ labels: n4.labels, updatedAt: '2026-10-10T08:00:00Z' }, source.items.get(4).comments, BOT)
          .state,
      ],
      [
        true,
        'ours',
        `<sub>Originally by @​alice on GitLab, 2026-10-05 — [link](${GL}/-/issues/4#note_902)</sub>`,
        'reply',
        'answered',
        'answered',
      ],
    );

    const rerun = await run();
    check(
      'migrate: a rerun plans exactly 0 writes and 0 uploads',
      [rerun.plan.writes, rerun.plan.uploads],
      [[], []],
    );
    // GitHub's listings trailing a create: the issue is asked for by number, so it is not made again.
    fake.s.hidden = new Set([5, 7]); // a hole below the highest, and the highest itself
    const lagging = planSync(source, await readGithub(gh));
    fake.s.hidden = new Set();
    check(
      'migrate: issues the listing leaves out, a hole and the newest, are still seen, and plan 0 writes',
      [lagging.writes, lagging.uploads],
      [[], []],
    );
    check(
      'migrate: verify finds 0 mismatches, with the collision range pending',
      verify(source, rerun.target),
      {
        checked: 4,
        mismatches: [],
        pending: [1, 2, 3],
      },
    );

    // One new GitLab comment is one write: on a closed item it joins the history folded into the body (an
    // edit), and after the plan in force on an open one it is a comment of its own (an append).
    board.notes[4].push({
      id: 903,
      body: 'and one more thing',
      author: { id: ALICE, username: 'alice' },
      created_at: '2026-10-11T09:00:00Z',
    });
    const openNote = planSync(await readGitlab(gl), rerun.target);
    check(
      'migrate: one new GitLab comment after the plan on an open item plans exactly 1 write, an append',
      openNote.writes,
      [{ op: 'comment', iid: 4, index: 2 }],
    );
    board.notes[4].pop();
    board.notes[7] = [
      {
        id: 950,
        body: 'reopened? no.',
        author: { id: ALICE, username: 'alice' },
        created_at: '2026-10-11T10:00:00Z',
      },
    ];
    const withNote = await readGitlab(gl);
    const onePlan = planSync(withNote, rerun.target);
    check(
      'migrate: one new GitLab comment on a closed item plans exactly 1 write, a body edit',
      onePlan.writes,
      [{ op: 'edit-issue', iid: 7, body: true, source: { iid: 7 } }],
    );
    delete board.notes[7];

    // A GitLab edit is an edit, not a second copy.
    const edited = await readGitlab(gl);
    edited.items.get(6).title = 'Item 6, renamed';
    check('migrate: an edited GitLab title plans one edit', planSync(edited, rerun.target).writes, [
      { op: 'edit-issue', iid: 6, title: 'Item 6, renamed', source: { iid: 6 } },
    ]);

    // The collision range, created at the end, then the references remapped.
    const appended = await run({ appendCollisions: true });
    check(
      'migrate: --append-collisions creates the collision range after everything else',
      appended.plan.writes.map((w) => [w.op, w.iid, w.expect]),
      [
        ['create-issue', 1, 8],
        ['create-issue', 2, 9],
        ['create-issue', 3, 10],
      ],
    );
    await apply(appended.plan, appended.target);
    const remapped = await run({ remap: true });
    check(
      'migrate: --remap rewrites exactly the bodies that name the collision range',
      remapped.plan.writes.map((w) => [w.op, w.iid, w.index ?? null]),
      [
        ['edit-issue', 4, null],
        ['edit-comment', 4, 1],
      ],
    );
    await apply(remapped.plan, remapped.target);
    check(
      'migrate: after --remap the references are GitHub numbers, and code is untouched',
      [
        fake.s.issues.get(4).body.split('\n\n')[1].slice(0, 30),
        fake.s.issues.get(4).body.includes('`#3 in code @carol`'),
        fake.s.comments[1].body.split('\n\n')[1],
      ],
      ['See #9 and #6, fixed in [!12](', true, 'yes, see #10'],
    );
    const after = await run();
    const afterRemap = await run({ remap: true });
    check(
      'migrate: after --remap, a run and a --remap run both plan 0 writes',
      [after.plan.writes, afterRemap.plan.writes],
      [[], []],
    );
    check('migrate: verify still finds 0 mismatches and nothing pending', verify(source, after.target), {
      checked: 7,
      mismatches: [],
      pending: [],
    });
    check(
      'migrate: --mapping, before and after the collision range is appended',
      [mappingReport(source, rerun.target, 'o/r'), mappingReport(source, after.target, 'o/r')],
      [
        { repository: 'o/r', gitlab: GL, highest: 7, mapping: {}, unmapped: [1, 2, 3] },
        { repository: 'o/r', gitlab: GL, highest: 10, mapping: { 1: 8, 2: 9, 3: 10 }, unmapped: [8, 9, 10] },
      ],
    );

    // GitLab grows after the collision range was appended: its new #8 finds GitHub #8 holding GitLab #1's
    // copy. That number is spent, so #8 waits with the collision range rather than stopping the run, and
    // a reference to it links to GitLab instead of to the wrong copy.
    board.issues.push({
      ...board.issues[0],
      id: 1008,
      iid: 8,
      title: 'Item 8',
      web_url: `${GL}/-/work_items/8`,
      description: 'see #8',
    });
    const grown = await readGitlab(gl);
    const grownPlan = planSync(grown, await readGithub(gh));
    check(
      'migrate: a new GitLab number held by an appended collision item is skipped, not stopped on, and links to GitLab',
      [grownPlan.stop, grownPlan.skipped, grownPlan.writes, rewrite('see #8 and #6', grownPlan.ctx)],
      [null, [8], [], `see [#8](${GL}/-/issues/8) and #6`],
    );
    board.issues.pop();

    // ---- releases ------------------------------------------------------------------------------------
    const S3 = '33333333333333333333333333333333';
    const S4 = '44444444444444444444444444444444';
    const glRelease = (tag, at, extra = {}) => ({
      tag_name: tag,
      name: `Release ${tag.slice(8)}`,
      description: '',
      released_at: at,
      _links: { self: `${GL}/-/releases/${tag}` },
      assets: { links: [] },
      milestones: [],
      ...extra,
    });
    board.releases = [
      glRelease('release-0.2.0', '2026-10-01T10:00:00Z'),
      glRelease('release-0.1.0', '2026-09-01T10:00:00Z', {
        description: `Fixed #2, see ![d](/uploads/${S3}/d.png)`,
        milestones: [{ title: 'release-0.4.4' }],
        assets: {
          links: [
            { name: "What's new (slides)", url: `https://git.example/-/project/9/uploads/${S4}/deck.html` },
            { name: 'Site', url: 'https://example.org' },
          ],
        },
      }),
      glRelease('release-0.1.1', '2026-09-15T10:00:00Z'),
    ];
    fake.s.tags = ['release-0.1.0', 'release-0.2.0']; // release-0.1.1's tag is not on the target
    const withReleases = await readGitlab(gl);
    const relTarget = await readGithub(gh);
    const relPlan = planSync(withReleases, relTarget);
    check(
      'release: oldest first, only where the tag exists, the newest latest, a file link a release asset',
      [relPlan.writes, relPlan.uploads.map((u) => u.path), relPlan.refusedReleases],
      [
        [
          { op: 'create-release', tag: 'release-0.1.0', latest: false },
          {
            op: 'release-asset',
            tag: 'release-0.1.0',
            label: "What's new (slides)",
            secret: S4,
            file: 'deck.html',
            name: 'deck.html',
          },
          { op: 'create-release', tag: 'release-0.2.0', latest: true },
        ],
        ['releases/release-0.1.0/20260901T100000Z/33333333-d.png'],
        ['release-0.1.1'],
      ],
    );
    await stageAssets(relPlan.uploads, {
      workDir: path.join(keyDir, 'work'),
      remote: { url: bare, token: null },
      fetchBytes: async (u) => Buffer.from(`PNG ${u.file}`),
    });
    await applyPlan(relPlan, withReleases, relTarget, gh, { paced: (fn) => fn(), gl });
    const r010 = fake.s.releases.find((r) => r.tag === 'release-0.1.0');
    check(
      'release: the notes, the milestone line, the GitLab date, the links and the marker; no tag made, no commitish',
      [
        r010.body,
        fake.s.releases.map((r) => [r.tag, r.draft, r.prerelease]),
        fake.s.latestTag,
        r010.assets.map((a) => [a.name, a.label]),
        fake.s.tagsMadeByRelease,
      ],
      [
        [
          `Fixed [#2](${GL}/-/issues/2), see ![d](https://github.com/o/r/blob/board-assets/releases/release-0.1.0/20260901T100000Z/33333333-d.png?raw=true)`,
          '**Milestone:** [release-0.4.4](https://github.com/o/r/milestone/1)',
          'Released on GitLab on 2026-09-01.',
          'Links from GitLab:\n\n- [Site](https://example.org)',
          `<!-- board:migrated from=gitlab release=release-0.1.0 url=${GL}/-/releases/release-0.1.0 at=2026-09-01T10:00:00Z -->`,
        ].join('\n\n'),
        [
          ['release-0.1.0', false, false],
          ['release-0.2.0', false, false],
        ],
        'release-0.2.0',
        [['deck.html', "What's new (slides)"]],
        [],
      ],
    );
    const relAgain = await readGithub(gh);
    const relRerun = planSync(withReleases, relAgain);
    check(
      'release: a rerun plans 0 writes and 0 uploads, and verify finds 0 mismatches with the missing tag listed',
      [relRerun.writes, relRerun.uploads, verifyReleases(withReleases, relAgain)],
      [[], [], { checked: 2, mismatches: [], refused: ['release-0.1.1'] }],
    );
    fake.s.latestTag = 'release-0.1.0';
    const relLatest = planSync(withReleases, await readGithub(gh));
    fake.s.latestTag = 'release-0.2.0';
    const editedRel = await readGitlab(gl);
    editedRel.releases.find((r) => r.tag === 'release-0.2.0').description = 'now with notes';
    const relEdit = planSync(editedRel, await readGithub(gh));
    check(
      'release: another release made latest is set back once, and a changed GitLab release is one edit',
      [relLatest.writes, relEdit.writes],
      [
        [{ op: 'set-latest', tag: 'release-0.2.0', id: 501 }],
        [{ op: 'edit-release', tag: 'release-0.2.0', id: 501, latest: true }],
      ],
    );
    board.releases = [];

    // One new image is one file in one push, and the comment that shows it is one REST write.
    const SECRET2 = 'fedcba9876543210fedcba9876543210';
    board.notes[4].push({
      id: 904,
      body: `and here: ![b](/uploads/${SECRET2}/b.png)`,
      author: { id: ALICE, username: 'alice' },
      created_at: '2026-10-11T11:00:00Z',
    });
    const withImage = await readGitlab(gl);
    const imgTarget = await readGithub(gh);
    const imgPlan = planSync(withImage, imgTarget);
    const before = stages.length;
    const stagedImg = await stageAssets(imgPlan.uploads, {
      workDir: path.join(keyDir, 'work'),
      remote: { url: bare, token: null },
      fetchBytes: async (u) => Buffer.from(`PNG ${u.file}`),
    });
    await applyPlan(imgPlan, withImage, imgTarget, gh, { paced: (fn) => fn() });
    const again = planSync(withImage, await readGithub(gh));
    check(
      'migrate: a new image is exactly 1 file in 1 push, and a rerun after it plans 0 uploads and 0 writes',
      [
        imgPlan.writes,
        imgPlan.uploads.map((u) => u.path),
        stagedImg,
        stages.length - before,
        again.writes,
        again.uploads,
        fake.s.comments
          .at(-1)
          .body.includes(
            'https://github.com/o/r/blob/board-assets/items/4/20261011T110000Z/fedcba98-b.png?raw=true',
          ),
      ],
      [
        [{ op: 'comment', iid: 4, index: 2, remap: true }], // item 4 was remapped above, and stays so
        ['items/4/20261011T110000Z/fedcba98-b.png'],
        { files: 1, commits: 1, pushes: 1, bytes: 9 },
        0,
        [],
        [],
        true,
      ],
    );
    board.notes[4].pop();

    // An installation token lives an hour and a run outlasts it: it is minted again before it runs out,
    // and a 401 (the write never happened) gets a fresh one, once.
    let clock = Date.parse('2026-10-12T10:00:00Z');
    let mints = 0;
    let refuseOnce = false;
    const counting = async (url, init = {}) => {
      if (String(url).endsWith('/access_tokens')) mints++;
      if (refuseOnce && String(url).endsWith('/labels?per_page=100')) {
        refuseOnce = false;
        return {
          ok: false,
          status: 401,
          headers: { get: () => null },
          json: async () => ({ message: 'Bad credentials' }),
        };
      }
      return fake.impl(url, init);
    };
    const timed = migrationClient({ ...ghEnv, GITHUB_APP_INSTALLATION_ID: '77' }, keyDir, {
      fetch: counting,
      now: () => clock,
    });
    await timed.get('/repos/o/r/labels?per_page=100');
    await timed.get('/repos/o/r/labels?per_page=100');
    const afterOne = mints;
    clock += 51 * 60_000;
    await timed.get('/repos/o/r/labels?per_page=100');
    const afterExpiry = mints;
    refuseOnce = true;
    await timed.get('/repos/o/r/labels?per_page=100');
    check(
      'lesson: a token expiring mid-run is minted once, again after 50 minutes, and again after a 401',
      [afterOne, afterExpiry, mints],
      [1, 2, 3],
    );

    // The token reaches git through GIT_ASKPASS only, and no error carries it.
    const tokenDir = path.join(keyDir, 'tok', 'repo.git');
    fs.mkdirSync(tokenDir, { recursive: true });
    const secretToken = 'ghs_selftestTOKEN1234567890';
    const tgit = gitIn(tokenDir, secretToken);
    let tokenError = '';
    try {
      tgit(['ls-remote', `nowhere-${secretToken}`]);
    } catch (e) {
      tokenError = e.message;
    }
    check(
      'migrate: git gets the token through a private askpass script, and an error never shows it',
      [
        tokenError.startsWith('git ls-remote failed'),
        tokenError.includes(secretToken),
        (fs.statSync(path.join(keyDir, 'tok', 'askpass.sh')).mode & 0o777).toString(8),
        fs.readFileSync(path.join(keyDir, 'tok', 'askpass.sh'), 'utf8').includes(secretToken),
      ],
      [true, false, '700', false],
    );

    // Under a git hook, GIT_DIR names the hook's repository, and git follows it over -C and over init's
    // directory: the pre-push hook once re-initialised the developer's own repository as bare this way.
    check(
      'migrate: gitEnv drops every GIT_ variable and keeps the rest',
      gitEnv({ GIT_DIR: 'd', GIT_INDEX_FILE: 'i', GIT_WORK_TREE: 'w', PATH: 'p', HOME: 'h' }),
      { PATH: 'p', HOME: 'h' },
    );
    const decoy = path.join(keyDir, 'decoy');
    execFileSync('git', ['init', '-q', decoy], { env: gitEnv() });
    const decoyGit = path.join(decoy, '.git');
    const configOf = (gitDir, key) => {
      try {
        return execFileSync('git', ['--git-dir', gitDir, 'config', '--get', key], {
          env: gitEnv(),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        return null;
      }
    };
    const savedGitDir = process.env.GIT_DIR;
    process.env.GIT_DIR = decoyGit;
    const other = path.join(keyDir, 'other.git');
    try {
      execFileSync('git', ['init', '--bare', '-q', other], { env: gitEnv() });
      gitIn(other, null)(['config', 'uploadpack.allowFilter', 'true']);
    } finally {
      if (savedGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = savedGitDir;
    }
    check(
      "lesson: a hook's inherited GIT_DIR leaves that repository alone",
      [
        configOf(decoyGit, 'core.bare'),
        configOf(decoyGit, 'uploadpack.allowFilter'),
        configOf(other, 'core.bare'),
        configOf(other, 'uploadpack.allowFilter'),
      ],
      ['false', null, 'true', 'true'],
    );

    // Numbering: GitHub #4 was deleted, so its number is spent and GitLab #4 waits with the collision range.
    const holed = fakeGithub();
    for (const n of [1, 2, 3, 5])
      holed.s.issues.set(n, {
        number: n,
        title: 't',
        body: '',
        state: 'open',
        labels: [],
        milestone: null,
        authorId: 1000,
      });
    const holedGh = migrationClient(ghEnv, keyDir, { fetch: holed.impl });
    const holedPlan = planSync(source, await readGithub(holedGh));
    check(
      'migrate: a deleted GitHub number is in the collision range, so nothing is created under a shifted number',
      [
        holedPlan.stop,
        holedPlan.skipped,
        holedPlan.writes.filter((w) => w.op === 'create-issue').map((w) => [w.iid, w.expect]),
      ],
      [
        null,
        [1, 2, 3, 4],
        [
          [6, 6],
          [7, 7],
        ],
      ],
    );

    // Pull requests share the numbers, and the board token sees none of them: the listing leaves them out
    // and `issues/<n>` answers 403, as two did on the first real target. Each is read as a pull request instead.
    const someone = (n, extra = {}) => ({
      number: n,
      title: 't',
      body: '',
      state: 'closed',
      labels: [],
      milestone: null,
      authorId: 1000,
      ...extra,
    });
    const withPr = fakeGithub();
    // #4 is the newest pull request; #2 is a hole below it, found only by asking for it.
    for (const n of [1, 3, 5]) withPr.s.issues.set(n, someone(n));
    for (const n of [2, 4]) withPr.s.issues.set(n, someone(n, { pr: true }));
    const withPrTarget = await readGithub(migrationClient(ghEnv, keyDir, { fetch: withPr.impl }));
    const withPrPlan = planSync(source, withPrTarget);
    check(
      'lesson: a pull request, absent from the issue listing and refused by number, is read as one and is in the collision range',
      [
        withPrTarget.maxNumber,
        [2, 4].map((n) => withPrTarget.issues.get(n)?.isPr),
        withPrPlan.stop,
        withPrPlan.skipped,
        withPrPlan.writes.filter((w) => w.op === 'create-issue').map((w) => [w.iid, w.expect]),
      ],
      [
        5,
        [true, true],
        null,
        [1, 2, 3, 4],
        [
          [6, 6],
          [7, 7],
        ],
      ],
    );

    // A number refused as an issue and not found as a pull request is a deleted one, as before.
    const refusedHole = fakeGithub();
    for (const n of [1, 2, 3, 5]) refusedHole.s.issues.set(n, someone(n));
    refusedHole.s.refused = (p) => p === '/issues/4';
    const refusedHolePlan = planSync(
      source,
      await readGithub(migrationClient(ghEnv, keyDir, { fetch: refusedHole.impl })),
    );
    check(
      'migrate: a hole refused as an issue and 404 as a pull request is a deleted number',
      [
        refusedHolePlan.stop,
        refusedHolePlan.skipped,
        refusedHolePlan.writes.filter((w) => w.op === 'create-issue').map((w) => [w.iid, w.expect]),
      ],
      [
        null,
        holedPlan.skipped,
        [
          [6, 6],
          [7, 7],
        ],
      ],
    );

    // A hole the mr token cannot read either is not guessed at: the run stops and names it.
    const blind = fakeGithub();
    for (const n of [1, 2, 3, 5]) blind.s.issues.set(n, someone(n));
    for (const n of [4, 6]) blind.s.issues.set(n, someone(n, { pr: true }));
    blind.s.refused = (p) => p === '/pulls/4';
    let blindError = null;
    try {
      await readGithub(migrationClient(ghEnv, keyDir, { fetch: blind.impl }));
    } catch (e) {
      blindError = e instanceof BoardError ? [e.code, e.message] : String(e);
    }
    check('migrate: a hole refused as an issue and as a pull request stops the read, naming it', blindError, [
      'forbidden',
      'GitHub #4 is refused to the board token (GitHub GET /repos/o/r/issues/4 answered 403: Resource not accessible by integration), and reading it as a pull request failed too (GitHub GET /repos/o/r/pulls/4 answered 403: Resource not accessible by integration). Its number cannot be accounted for. Stopped.',
    ]);

    // …and so does a target whose pull requests cannot be listed: the next number is not known without them.
    const noPulls = fakeGithub();
    for (const n of [1, 2, 3]) noPulls.s.issues.set(n, someone(n));
    noPulls.s.refused = (p) => p === '/pulls';
    let noPullsError = null;
    try {
      await readGithub(migrationClient(ghEnv, keyDir, { fetch: noPulls.impl }));
    } catch (e) {
      noPullsError = e instanceof BoardError ? [e.code, e.message] : String(e);
    }
    check('lesson: pull requests that cannot be listed stop the read', noPullsError, [
      'forbidden',
      "reading GitHub's newest pull request failed (GitHub GET /repos/o/r/pulls?state=all&sort=created&direction=desc&per_page=1 answered 403: Resource not accessible by integration). Pull requests share the issues' numbers, so the next number is not known without it. Stopped.",
    ]);

    // The highest number a pull request, above a deleted one: the scan past the listing stops at the
    // deleted #4's 404, so only the newest pull request shows that #5 is spent.
    const prOnTop = fakeGithub();
    for (const n of [1, 2, 3]) prOnTop.s.issues.set(n, someone(n));
    prOnTop.s.issues.set(5, someone(5, { pr: true }));
    const prOnTopTarget = await readGithub(migrationClient(ghEnv, keyDir, { fetch: prOnTop.impl }));
    const prOnTopPlan = planSync(source, prOnTopTarget);
    check(
      'migrate: the highest number being a pull request puts the first create above it',
      [
        prOnTopTarget.maxNumber,
        prOnTopPlan.stop,
        prOnTopPlan.skipped,
        prOnTopPlan.writes.filter((w) => w.op === 'create-issue').map((w) => [w.iid, w.expect]),
      ],
      [
        5,
        null,
        [1, 2, 3, 4],
        [
          [6, 6],
          [7, 7],
        ],
      ],
    );

    // …and one that appears between the plan and the write stops the run before it creates anything.
    const race = fakeGithub();
    for (let n = 1; n <= 3; n++) race.add({ title: 't', authorId: 1000 });
    const raceGh = migrationClient(ghEnv, keyDir, { fetch: race.impl });
    const raceTarget = await readGithub(raceGh);
    const racePlan = planSync(source, raceTarget);
    race.add({ title: 'somebody else', authorId: 1000, pr: true });
    let raceError = null;
    try {
      await applyPlan(racePlan, source, raceTarget, raceGh, {
        paced: (fn) => fn(),
      });
    } catch (e) {
      raceError = e instanceof BoardError ? e.message : String(e);
    }
    check(
      'migrate: a number taken after planning stops the run before its first issue',
      [raceError, [...race.s.issues.keys()], race.writes.filter((w) => w === 'POST /issues').length],
      ["before GitLab #4: GitHub's highest number is #4, want #3. Stopped.", [1, 2, 3, 4], 0],
    );

    // A marker on somebody else's issue does not make it a migrated one.
    const forged = fakeGithub();
    for (let n = 1; n <= 3; n++) forged.add({ title: 't', authorId: 1000 });
    forged.add({
      title: 'forged',
      authorId: 1000,
      body: `x\n\n<!-- board:migrated from=gitlab url=${GL}/-/issues/4 kind=reply -->`,
    });
    const forgedPlan = planSync(
      source,
      await readGithub(migrationClient(ghEnv, keyDir, { fetch: forged.impl })),
    );
    check(
      'migrate: a pasted marker is not a migrated item, so GitLab #4 is a collision',
      [forgedPlan.stop, forgedPlan.skipped],
      [null, [1, 2, 3, 4]],
    );

    // An empty repository has no git data yet, and GitHub answers 409 to reading its trees and refs. That is
    // an empty board-assets and no tags, not a failure; the first push of the assets starts the branch.
    const empty = fakeGithub();
    empty.s.conflict = (p) => p.startsWith('/git/');
    const emptyTarget = await readGithub(migrationClient(ghEnv, keyDir, { fetch: empty.impl }));
    check(
      'lesson: an empty repository answers 409 on its git data, which reads as no assets and no tags',
      [
        [...emptyTarget.assets],
        [...emptyTarget.tags],
        emptyTarget.maxNumber,
        foreignNumbers(source, emptyTarget),
      ],
      [[], [], 0, []],
    );

    // GitHub burnt a number on the first real run: a create answered 502, made nothing, and used up its
    // number. The write is not repeated; the next create comes back one too high and the run stops there,
    // and a fresh read puts the stray copy in the collision range rather than creating under a shift.
    const burn = fakeGithub();
    for (let n = 1; n <= 3; n++) burn.add({ title: 't', authorId: 1000 });
    const burnGh = migrationClient(ghEnv, keyDir, { fetch: burn.impl });
    const tryApply = async (target) => {
      const plan = planSync(source, target);
      try {
        await applyPlan(plan, source, target, burnGh, { paced: (fn) => fn(), sleep: async () => {} });
        return 'done';
      } catch (e) {
        return e instanceof BoardError ? [e.code, e.status, e.message] : String(e);
      }
    };
    burn.s.burnNext = true;
    const burnt = await tryApply(await readGithub(burnGh));
    const shifted = await tryApply(await readGithub(burnGh));
    const afterBurn = await readGithub(burnGh);
    const burnPlan = planSync(source, afterBurn);
    check(
      'lesson: a number GitHub burns on a 5xx is not written twice, stops the next create, and joins the collision range',
      [
        burnt,
        shifted,
        burn.writes.filter((w) => w === 'POST /issues').length,
        burnPlan.stop,
        burnPlan.writes.filter((w) => w.op === 'create-issue').map((w) => [w.iid, w.expect]),
        mappingReport(source, afterBurn, 'o/r').mapping,
      ],
      [
        ['http_error', 502, 'GitHub POST /repos/o/r/issues answered 502: Server Error'],
        ['misconfigured', 0, 'GitLab #4 came back as GitHub #5, want #4. Stopped.'],
        2,
        null,
        [
          [6, 6],
          [7, 7],
        ],
        { 4: 5 },
      ],
    );

    // A protected repository refuses the client's writes and pushes unless the run was given --cutover.
    const guarded = fakeGithub();
    const refusedWrite = async (opts) => {
      const c = migrationClient(ghEnv, keyDir, { fetch: guarded.impl, protect: ['o/r'], ...opts });
      const out = [];
      for (const f of [() => c.write('/repos/o/r/labels', 'POST', { name: 'x' }), () => c.gitRemote()]) {
        try {
          await f();
          out.push('ok');
        } catch (e) {
          out.push(e.message);
        }
      }
      return out;
    };
    check(
      'guard: the client refuses a write and a push to a protected repository without --cutover',
      [
        await refusedWrite({}),
        [...guarded.writes],
        await refusedWrite({ allowProtected: true }),
        [...guarded.writes],
      ],
      [
        [
          'refused: a write to o/r, a protected repository, without --cutover',
          'refused: a push to o/r, a protected repository, without --cutover',
        ],
        [],
        ['ok', 'ok'],
        ['POST /labels'],
      ],
    );
  } finally {
    fs.rmSync(keyDir, { recursive: true, force: true });
  }

  // ---- bodies for unit cases ----------------------------------------------------------------------------
  const it = {
    iid: 8,
    id: 1,
    url: `${GL}/-/issues/8`,
    author: 'x',
    authorId: BOT,
    createdAt: '2026-10-01T00:00:00Z',
    description: 'd',
    links: [2],
    confidential: false,
  };
  check(
    'migrate: a link into the collision range stays a GitLab link until it is mapped',
    [
      issueBody(it, { ...ctx0, mapping: new Map(), gitlabBotId: BOT }).split('\n\n')[2],
      issueBody(it, { ...ctx0, remap: true, gitlabBotId: BOT }).split('\n\n')[2],
      commentBody(
        it,
        { id: 3, authorId: BOT, author: 'board-bot', body: 'ok', createdAt: '2026-10-02T00:00:00Z' },
        { ...ctx0, gitlabBotId: BOT },
      ).split('\n\n')[0],
    ],
    [`Linked on GitLab: [#2](${GL}/-/issues/2)`, 'Relates-to: #9', 'ok'],
  );

  // ---- folding -----------------------------------------------------------------------------------------
  const fctx = {
    gitlabUrl: GL,
    gitlabBotId: BOT,
    collisions: new Set(),
    mapping: new Map([[1, 1]]),
    remap: false,
  };
  const fnote = (id, authorId, body) => ({
    id,
    authorId,
    author: authorId === BOT ? 'board-bot' : 'alice',
    body,
    createdAt: `2026-10-0${id % 9 || 1}T10:00:00Z`,
  });
  const fitem = (state, comments, labels = ['feedback']) => ({
    iid: 1,
    id: 11,
    title: 'F',
    description: 'd',
    state,
    confidential: false,
    labels,
    milestone: null,
    author: 'alice',
    authorId: ALICE,
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-10T00:00:00Z',
    url: `${GL}/-/issues/1`,
    links: [],
    comments,
  });
  const revised = fitem('open', [
    fnote(1, ALICE, 'first'),
    fnote(2, BOT, '## Remediation plan — one\n\n[REVIEW 1] a'),
    fnote(3, ALICE, 'no'),
    fnote(4, BOT, '## Remediation plan (revision)\n\n[REVIEW 1] b'),
    fnote(5, ALICE, 'yes'),
  ]);
  const rv = desired(revised, fctx, () => null);
  const ghView = rv.comments.map((body, i) => ({
    id: i,
    authorId: APP,
    author: 'app',
    body,
    createdAt: '2026-10-12T00:00:00Z',
  }));
  check(
    'fold: an open item folds what precedes the plan in force into its body, keeps the plan and what follows, and reads the same',
    [
      foldPoint(revised),
      rv.comments.length,
      rv.comments.map((c) => migratedFrom(c).note),
      ['first', '## Remediation plan — one', '\nno'].map((t) => rv.body.includes(t)),
      classify({ labels: revised.labels, updatedAt: revised.updatedAt }, ghView, APP).state,
      classify({ labels: revised.labels, updatedAt: revised.updatedAt }, revised.comments, BOT).state,
    ],
    [3, 2, ['4', '5'], [true, true, true], 'answered', 'answered'],
  );
  check(
    'fold: an open item with no plan folds whole, unless a label claims a plan, when the newest stays a comment',
    [
      foldPoint(fitem('open', [fnote(1, ALICE, 'a'), fnote(2, ALICE, 'b')])),
      foldPoint(fitem('open', [fnote(1, ALICE, 'a'), fnote(2, ALICE, 'b')], ['ai:plan-posted'])),
      foldPoint(fitem('closed', [fnote(1, ALICE, 'a'), fnote(2, BOT, '## Remediation plan')])),
    ],
    [2, 1, 2],
  );
  const big = (id) => fnote(id, ALICE, 'x'.repeat(25000));
  const packed = desired(fitem('closed', [big(1), big(2), big(3)]), fctx, () => null);
  const huge = desired(fitem('closed', [fnote(1, ALICE, 'y'.repeat(130000))]), fctx, () => null);
  check(
    'fold: a history too big for the body packs into as few comments as hold it, and a huge note splits',
    [
      packed.body.includes('## GitLab history'),
      packed.comments.map((c) => migratedFrom(c).note),
      packed.comments.every((c) => c.length < 65536),
      huge.comments.map((c) => migratedFrom(c).note),
      huge.comments.every((c) => c.length < 65536),
      huge.comments.map((c) => (c.match(/y{100,}/g) ?? []).join('').length).reduce((a, b) => a + b, 0),
    ],
    [false, ['1,2', '3'], true, ['1.1/3', '1.2/3', '1.3/3'], true, 130000],
  );
  // On a closed item whose history is in comments, one more GitLab comment is one write: an edit of the
  // last folded comment while it has room, an append once it has not.
  const asTarget = (it, shape) => ({
    repository: 'o/r',
    botId: APP,
    labels: new Set(['feedback']),
    milestones: new Map(),
    assets: new Set(),
    maxNumber: 1,
    issues: new Map([
      [
        1,
        {
          number: 1,
          isPr: false,
          authorId: APP,
          title: it.title,
          body: shape.body,
          state: it.state,
          labels: it.labels,
          milestone: null,
          comments: shape.comments.map((body, i) => ({ id: 70 + i, authorId: APP, body })),
        },
      ],
    ]),
  });
  const asSource = (it) => ({
    url: GL,
    botId: BOT,
    labels: new Map(),
    milestones: new Map(),
    items: new Map([[1, it]]),
    maxIid: 1,
  });
  const three = fitem('closed', [big(1), big(2), big(3)]);
  const four = fitem('closed', [big(1), big(2), big(3), fnote(4, ALICE, 'short')]);
  const five = fitem('closed', [big(1), big(2), big(3), fnote(4, ALICE, 'z'.repeat(40000))]);
  check(
    'fold: a new comment on a folded closed item is exactly 1 write, an edit with room and an append without',
    [
      planSync(asSource(three), asTarget(three, packed)).writes,
      planSync(asSource(four), asTarget(three, packed)).writes,
      planSync(asSource(five), asTarget(three, packed)).writes,
    ],
    [[], [{ op: 'edit-comment', iid: 1, index: 1, commentId: 71 }], [{ op: 'comment', iid: 1, index: 2 }]],
  );

  // --remap can change how many comments a history folds into: a GitLab link is longer than `#9`. A normal
  // run must then leave the remapped item alone rather than rebuild the long form a comment at a time.
  const refs = fitem('closed', [fnote(1, ALICE, '#2 '.repeat(2000))]);
  const ctxR = {
    ...fctx,
    collisions: new Set([2]),
    mapping: new Map([
      [1, 1],
      [2, 9],
    ]),
  };
  const longForm = desired(refs, { ...ctxR, remap: false }, () => null);
  const shortForm = desired(refs, { ...ctxR, remap: true }, () => null);
  const remapTarget = asTarget(refs, shortForm);
  remapTarget.issues.set(2, {
    number: 2,
    isPr: false,
    authorId: 1000,
    title: 't',
    body: '',
    state: 'open',
    labels: [],
    milestone: null,
    comments: [],
  });
  remapTarget.issues.set(9, {
    number: 9,
    isPr: false,
    authorId: APP,
    title: 'two',
    body: `x\n\n<!-- board:migrated from=gitlab url=${GL}/-/issues/2 kind=reply -->`,
    state: 'open',
    labels: [],
    milestone: null,
    comments: [],
  });
  remapTarget.maxNumber = 9;
  check(
    'remap: when it changes the fold, a run and a --remap run both leave the remapped item alone, and verify agrees',
    [
      longForm.comments.length,
      shortForm.comments.length,
      planSync(asSource(refs), remapTarget).writes,
      planSync(asSource(refs), remapTarget, { remap: true }).writes,
      verify(asSource(refs), remapTarget).mismatches,
    ],
    [2, 0, [], [], []],
  );

  // ---- pacing --------------------------------------------------------------------------------------------
  let clock = 10_000;
  const slept = [];
  const paced = pacer({
    perHour: 2,
    minGapMs: 1000,
    now: () => clock,
    sleep: async (ms) => {
      slept.push(ms);
      clock += ms;
    },
  });
  let limited = true;
  await paced(async () => 1);
  await paced(async () => {
    if (limited) {
      limited = false;
      const e = new BoardError('slow down', 'rate-limited', 403);
      e.retryAfterMs = 5000;
      throw e;
    }
  });
  await paced(async () => 3);
  check(
    'lesson: the hourly content cap: pacing is one a second, at most perHour in any hour, and retry-after',
    slept,
    [1000, 5000, 3594000, 1000],
  );
  check(
    'migrate: the expected duration follows the pacing',
    [
      expectedSeconds(0, 450),
      expectedSeconds(450, 450),
      expectedSeconds(451, 450),
      expectedSeconds(2700, 450),
    ],
    [0, 450, 3601, 18450],
  );

  // ---- board text is untrusted: an upload name is one file name, or not an upload (#32) ------------------
  {
    const crafted = [
      '..%2F..%2Fx',
      '%2e%2e/x',
      '%2e%2e%2Fx',
      '../../x',
      '%2Fetc%2Fpasswd',
      '..%5C..%5Cx',
      'a%00b.png',
      'shot.png?x=1',
      '..',
    ];
    const link = (f) => `${GL}/uploads/${SECRET}/${f}`;
    const md = crafted.map((f) => `![a](${link(f)})`);
    const codeOf = (p) =>
      p.then(
        () => 'done',
        (e) => (e instanceof BoardError ? e.code : String(e)),
      );
    const text = [
      ...crafted.map((f) => `![a](${link(f)})`),
      `![b](${link('my%20shot.png')})`,
      `![c](/uploads/${SECRET}/shot.png)`,
    ].join('\n');
    check(
      'lesson: only a single file name is an upload; every crafted name is refused, in text order',
      uploadsIn(text, GL),
      [
        { secret: SECRET, file: 'my%20shot.png' },
        { secret: SECRET, file: 'shot.png' },
      ],
    );
    const ctx = { gitlabUrl: GL, collisions: new Set(), mapping: new Map(), remap: false };
    check(
      'lesson: a refused upload link is left byte for byte as it was',
      md.map((t) => rewrite(t, ctx, () => 'COPIED')),
      md,
    );
    const rel = {
      tag: 'v1/x',
      description: '',
      links: [
        ...crafted.map((f, i) => ({ name: `c${i}`, url: link(f) })),
        { name: 'ok', url: link('shot.png') },
      ],
    };
    const { files, external } = releaseLinks(rel, GL);
    check(
      'lesson: a refused release link is an external link, not an asset',
      [files, external.map((l) => l.name)],
      [[{ label: 'ok', secret: SECRET, file: 'shot.png', name: 'shot.png' }], crafted.map((_, i) => `c${i}`)],
    );
    check(
      'lesson: the plan lists every refused link, by item and by release',
      refusedUploads({
        url: GL,
        items: new Map([
          [
            3,
            { iid: 3, description: `![a](${link('..%2Fx')})`, comments: [{ body: `![a](${link('../y')})` }] },
          ],
        ]),
        releases: [rel],
      }),
      [
        { where: '#3', file: '..%2Fx' },
        { where: '#3', file: '../y' },
        ...crafted.map((file) => ({ where: 'release v1/x', file })),
      ],
    );

    // At the sinks, for a caller that did not go through uploadsIn.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'board-traversal-'));
    try {
      const bare = path.join(tmp, 'remote.git');
      execFileSync('git', ['init', '--bare', '-q', bare], { env: gitEnv() });
      let fetched = 0;
      const stage = (u) =>
        codeOf(
          stageAssets([u], {
            workDir: path.join(tmp, 'work'),
            remote: { url: bare, token: null },
            fetchBytes: async () => {
              fetched++;
              return Buffer.from('bytes');
            },
          }),
        );
      check(
        'lesson: the download cache refuses a name that leaves it, before fetching or writing anything',
        [
          await stage({
            iid: 1,
            secret: SECRET,
            file: 'x',
            name: '01234567-../../../../x',
            path: 'items/1/x',
          }),
          await stage({ iid: 1, secret: '../../..', file: 'x', name: 'x', path: 'items/1/y' }),
          fetched,
          fs.readdirSync(tmp).sort(),
          fs.existsSync(path.join(tmp, 'work', 'downloads')),
        ],
        ['unsafe-path', 'unsafe-path', 0, ['remote.git', 'work'], false],
      );
      check(
        "lesson: a release whose tag holds a '/' still stages its upload",
        await stage({
          iid: 'release v1/x',
          secret: SECRET,
          file: 'shot.png',
          name: '01234567-shot.png',
          path: 'releases/v1/x/s/01234567-shot.png',
        }),
        'done',
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    const asked = [];
    const gl = {
      project: '/projects/9',
      get: async (u) => {
        asked.push(u);
        return Buffer.from('ok');
      },
    };
    const refusedGet = await codeOf(fetchUpload(gl, { url: GL }, { secret: SECRET, file: '..%2Fx' }));
    await fetchUpload(gl, { url: GL }, { secret: SECRET, file: 'my%20shot.png' });
    check(
      'lesson: the authorised GET names one encoded file, and a crafted name is never requested',
      [refusedGet, asked],
      ['unsafe-path', [`/projects/9/uploads/${SECRET}/my%20shot.png`]],
    );
  }

  return failed;
}

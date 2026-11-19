// `pnpm check:items`, the batch create's part (#36): the file format, the order and the edges over strings,
// and `create --batch` driven through both real adapters against a fake API. Every case asserts the whole
// answer (AGENTS.md, "Assert the whole answer"), and every fake board starts with 150 items, so the listing
// the markers are read from crosses a page boundary.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cmdBatch } from './batch.mjs';
import { batchBody, parseBatch, planBatch } from './core.mjs';
import { createGithub } from './github.mjs';
import { createGitlab } from './gitlab.mjs';
import { fakeFetch } from './selftest.mjs';

// Three entries written out of order: `retire` needs `split`, which needs `inventory`.
const SEED = `Batch: seed-1
Lines before the first entry are notes for people.

=== retire
Needs: split
Relates: split

Retire the old host

=== inventory
Labels: release-1.0.0, feedback

Inventory the services
Every service, its owner and its runtime.

=== split
Labels: release-1.1.0
Needs: inventory
Relates: inventory, #5

# Split the monolith
By the inventory.
`;

const marker = (key) => `<!-- factory-kit-batch: seed-1/${key} -->`;
const BODY = {
  inventory: `Every service, its owner and its runtime.\n\n${marker('inventory')}`,
  split: `By the inventory.\n\nDepends on #151\n\n${marker('split')}`,
  retire: `Depends on #152\n\n${marker('retire')}`,
};

/**
 * A board in memory, served as GitLab or GitHub. `fail` maps a route name to the call numbers (1-based) that
 * answer with the status given, so a failure can be put on exactly the second create.
 */
function fakeBoard(kind, { fail = {}, labels: known = [] } = {}) {
  const issues = Array.from({ length: 150 }, (_, i) => ({
    iid: i + 1,
    title: `old ${i + 1}`,
    description: '',
    labels: [],
    milestone: null,
  }));
  const labels = [...known];
  const milestones = [];
  const links = [];
  const count = {};
  const failing = (name) => {
    count[name] = (count[name] ?? 0) + 1;
    return fail[name]?.[count[name]];
  };
  const page = (u) => Number(/[?&]page=(\d+)/.exec(u)?.[1] ?? 1);
  const body = (init) => JSON.parse(init.body);
  const addLabel = (_u, init) => {
    labels.push(body(init).name);
    return { json: {} };
  };
  const add = (title, description, ls) => {
    const it = { iid: issues.length + 1, title, description, labels: ls, milestone: null };
    issues.push(it);
    return it;
  };

  if (kind === 'gitlab') {
    const BASE = 'https://gitlab.example.com/api/v4/projects/g%2Fp';
    const json = (it) => ({
      iid: it.iid,
      title: it.title,
      web_url: `https://gitlab.example.com/g/p/-/issues/${it.iid}`,
      labels: it.labels,
      description: it.description,
      state: 'opened',
      confidential: false,
      created_at: '2026-11-10T10:00:00Z',
      updated_at: '2026-11-10T10:00:00Z',
      user_notes_count: 0,
      milestone: it.milestone,
    });
    const at = (method, re) => (m, u) => m === method && u.startsWith(BASE) && re.test(u.slice(BASE.length));
    const fake = fakeFetch([
      [
        at('GET', /^\/issues\?state=all/),
        (u) => ({ json: issues.slice((page(u) - 1) * 100, page(u) * 100).map(json) }),
      ],
      [
        at('POST', /^\/issues$/),
        (_u, init) => {
          const status = failing('create');
          if (status) return { status, json: {} };
          const b = body(init);
          return { json: json(add(b.title, b.description, b.labels ? b.labels.split(',') : [])) };
        },
      ],
      [
        at('PUT', /^\/issues\/\d+\?milestone_id=/),
        (u) => {
          const [, n, id] = /\/issues\/(\d+)\?milestone_id=(\d+)/.exec(u);
          const it = issues[Number(n) - 1];
          it.milestone = { title: milestones.find((m) => m.id === Number(id)).title };
          return { json: json(it) };
        },
      ],
      [
        at('POST', /^\/issues\/\d+\/links$/),
        (u, init) => {
          const status = failing('link');
          if (status) return { status, json: {} };
          const pair = [Number(/\/issues\/(\d+)\//.exec(u)[1]), Number(body(init).target_issue_iid)];
          // GitLab refuses a pair already linked, from either side, with a 409.
          if (links.some((l) => l.includes(pair[0]) && l.includes(pair[1]))) return { status: 409, json: {} };
          links.push(pair);
          return { json: {} };
        },
      ],
      [
        at('GET', /^\/issues\/\d+\/links$/),
        (u) => {
          const status = failing('readLinks');
          if (status) return { status, json: {} };
          const n = Number(/\/issues\/(\d+)\//.exec(u)[1]);
          return { json: links.filter((l) => l.includes(n)).map(([a, c]) => ({ iid: a === n ? c : a })) };
        },
      ],
      [
        at('GET', /^\/labels\?/),
        (u) => ({ json: labels.slice((page(u) - 1) * 100, page(u) * 100).map((name) => ({ name })) }),
      ],
      [at('POST', /^\/labels$/), addLabel],
      [
        at('GET', /^\/milestones\?state=all/),
        () => ({ json: milestones.map((m) => ({ ...m, state: 'active' })) }),
      ],
      [
        at('POST', /^\/milestones$/),
        (_u, init) => {
          const m = { id: milestones.length + 1, title: body(init).title };
          milestones.push(m);
          return { json: m };
        },
      ],
    ]);
    const env = { GITLAB_URL: 'gitlab.example.com', GITLAB_TOKEN: 'reporter', GITLAB_PROJECT_ID: 'g/p' };
    const writes = () =>
      fake.calls
        .filter((c) => c.method !== 'GET')
        .map((c) => [c.method, c.url.slice(BASE.length), c.body ? JSON.parse(c.body) : null]);
    return { board: (root) => createGitlab(env, root, { fetch: fake.impl }), fake, writes, issues, links };
  }

  const API = 'https://api.github.com';
  const REPO = `${API}/repos/knowit/factory-kit`;
  const json = (it) => ({
    number: it.iid,
    title: it.title,
    html_url: `https://github.com/knowit/factory-kit/issues/${it.iid}`,
    labels: it.labels.map((name) => ({ name })),
    body: it.description,
    state: 'open',
    created_at: '2026-11-10T10:00:00Z',
    updated_at: '2026-11-10T10:00:00Z',
    comments: 0,
    milestone: it.milestone,
  });
  const at = (method, re) => (m, u) => m === method && re.test(u.replace(API, ''));
  const fake = fakeFetch([
    [at('POST', /\/access_tokens$/), { json: { token: 'tok-board' } }],
    [
      at('GET', /^\/repos\/knowit\/factory-kit\/issues\?state=all/),
      (u) => ({
        json: issues.slice((page(u) - 1) * 100, page(u) * 100).map(json),
        headers:
          page(u) * 100 < issues.length
            ? { link: `<${REPO}/issues?state=all&per_page=100&page=${page(u) + 1}>; rel="next"` }
            : {},
      }),
    ],
    [
      at('POST', /^\/repos\/knowit\/factory-kit\/issues$/),
      (_u, init) => {
        const status = failing('create');
        if (status) return { status, json: { message: 'slow down' }, headers: { 'retry-after': '2' } };
        const b = body(init);
        return { json: json(add(b.title, b.body, b.labels)) };
      },
    ],
    [
      at('PATCH', /^\/repos\/knowit\/factory-kit\/issues\/\d+$/),
      (u, init) => {
        const it = issues[Number(/(\d+)$/.exec(u)[1]) - 1];
        const b = body(init);
        if ('milestone' in b)
          it.milestone = {
            number: b.milestone,
            title: milestones.find((m) => m.number === b.milestone).title,
          };
        if ('body' in b) it.description = b.body;
        return { json: json(it) };
      },
    ],
    [
      at('GET', /^\/repos\/knowit\/factory-kit\/labels\//),
      (u) =>
        labels.includes(decodeURIComponent(u.split('/labels/')[1]))
          ? { json: {} }
          : { status: 404, json: {} },
    ],
    [at('POST', /^\/repos\/knowit\/factory-kit\/labels$/), addLabel],
    [at('GET', /^\/repos\/knowit\/factory-kit\/milestones\?state=all/), () => ({ json: milestones })],
    [
      at('POST', /^\/repos\/knowit\/factory-kit\/milestones$/),
      (_u, init) => {
        const m = { number: milestones.length + 1, title: body(init).title, state: 'open' };
        milestones.push(m);
        return { json: m };
      },
    ],
  ]);
  const writes = () =>
    fake.calls
      .filter((c) => c.method !== 'GET' && !c.url.endsWith('/access_tokens'))
      .map((c) => [c.method, c.url.replace(REPO, ''), c.body ? JSON.parse(c.body) : null]);
  const env = {
    GITHUB_REPOSITORY: 'knowit/factory-kit',
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY_PATH: 'app.pem',
    GITHUB_APP_INSTALLATION_ID: '77',
  };
  return { board: (root) => createGithub(env, root, { fetch: fake.impl }), fake, writes, issues, links };
}

export async function batchSelftest() {
  let failed = 0;
  const check = (name, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) console.log(`✓ ${name}`);
    else {
      failed++;
      console.error(`✗ ${name}:\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
    }
  };

  // ---- the file, the order, the body ----------------------------------------------------------------------
  const parsed = parseBatch(SEED);
  check('batch: a file parses into its batch id and entries, headers and title apart from the body', parsed, {
    batch: 'seed-1',
    entries: [
      {
        key: 'retire',
        line: 4,
        labels: [],
        needs: ['split'],
        relates: ['split'],
        title: 'Retire the old host',
        body: '',
      },
      {
        key: 'inventory',
        line: 10,
        labels: ['release-1.0.0', 'feedback'],
        needs: [],
        relates: [],
        title: 'Inventory the services',
        body: 'Every service, its owner and its runtime.',
      },
      {
        key: 'split',
        line: 16,
        labels: ['release-1.1.0'],
        needs: ['inventory'],
        relates: ['inventory', '#5'],
        title: 'Split the monolith',
        body: 'By the inventory.',
      },
    ],
    errors: [],
  });
  check(
    'batch: every problem in a file is reported, with its line',
    parseBatch(
      [
        'no batch line here',
        '=== Bad_Key',
        'Title',
        '=== a',
        'Labels: release-1, release-2',
        'Labels: x',
        'Needs: b?',
        '',
        '=== a',
        'Needs: b',
        '',
      ].join('\n'),
    ).errors,
    [
      'line 2: key "Bad_Key" is not [a-z0-9-]+',
      'line 6: a second Labels: line in a',
      'line 7: "b?" is neither a key nor #n',
      'no "Batch: <id>" line before the first entry',
      'line 4: a has no title',
      'line 4: a has two release labels, release-1 and release-2',
      'line 9: key "a" is used twice',
      'line 9: a has no title',
    ],
  );

  const board = Array.from({ length: 150 }, (_, i) => ({ iid: i + 1, description: '' }));
  const order = (p) => p.steps.map((s) => [s.key, s.iid, s.links]);
  check(
    'batch: the order follows Needs, stable by file order, and each link is written at its later end once',
    order(planBatch(parsed, board)),
    [
      ['inventory', null, []],
      ['split', null, ['inventory', '#5']],
      ['retire', null, ['split']],
    ],
  );
  check(
    'batch: an entry whose marker is on the board, open or closed, is the item already created',
    order(
      planBatch(parsed, [
        ...board,
        { iid: 151, state: 'closed', description: `x\n${marker('inventory')}\n\nRelates-to: #9` },
      ]),
    ),
    [
      ['inventory', 151, []],
      ['split', null, ['inventory', '#5']],
      ['retire', null, ['split']],
    ],
  );
  check(
    "batch: another batch's marker for the same key is not this batch's",
    planBatch(parsed, [...board, { iid: 151, description: '<!-- factory-kit-batch: seed-2/inventory -->' }])
      .steps[0].iid,
    null,
  );
  check(
    'batch: a key found on two items is refused, for a person to settle',
    planBatch(parsed, [
      ...board,
      { iid: 151, description: marker('split') },
      { iid: 152, description: marker('split') },
    ]),
    { steps: [], errors: ['split is already on the board twice, as #151 and #152'] },
  );
  const refs = parseBatch('Batch: x\n=== a\nNeeds: zz, #999\nRelates: a\n\nA\n');
  check(
    'batch: an unknown key, an item not on the board and a self-link are refused',
    planBatch(refs, board),
    {
      steps: [],
      errors: [
        'a: Needs names zz, which is no entry in this file',
        'a: Needs names #999, which is not on the board',
        'a: Relates names itself',
      ],
    },
  );
  const CYCLE = 'Batch: x\n=== a\nNeeds: c\n\nA\n=== b\nNeeds: a\n\nB\n=== c\nNeeds: b\n\nC\n=== d\n\nD\n';
  check('batch: a cycle in Needs is refused, naming the keys on it', planBatch(parseBatch(CYCLE), board), {
    steps: [],
    errors: ['Needs: goes round in a circle: a -> c -> b -> a'],
  });
  check(
    'batch: a body is the text, a Depends on line, the marker, and on GitHub its Relates-to lines',
    batchBody({ key: 'k', body: 'Text.' }, 'b-1', { depends: [3, 4], relates: [5, 6] }),
    'Text.\n\nDepends on #3, #4\n\n<!-- factory-kit-batch: b-1/k -->\n\nRelates-to: #5\n\nRelates-to: #6',
  );

  // ---- the command, through both adapters ------------------------------------------------------------------
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-selftest-'));
  try {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    fs.writeFileSync(path.join(tmp, 'app.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const seed = path.join(tmp, 'seed.md');
    fs.writeFileSync(seed, SEED);
    const run = async (b, file, opts = {}) => {
      const out = [];
      const code = await cmdBatch(b, file, {
        log: (l) => out.push(l),
        err: (l) => out.push(`! ${l}`),
        ...opts,
      });
      return { code, out };
    };
    const marked = (issues) =>
      issues.filter((i) => i.description.includes('factory-kit-batch')).map((i) => [i.iid, i.title]);

    // A dry run reads the board and writes nothing.
    const dry = fakeBoard('gitlab');
    check(
      'batch: a dry run prints the order, the holds and the milestones, and writes nothing',
      [await run(dry.board(tmp), seed), dry.writes()],
      [
        {
          code: 0,
          out: [
            'batch seed-1: 3 entries, 3 to create, 0 already on the board',
            '  1. inventory  create — Inventory the services',
            '       labels release-1.0.0, feedback',
            '  2. split  create — Split the monolith',
            '       labels release-1.1.0',
            '       depends on inventory (text, no hold)',
            '       links to inventory, #5 (a hold)',
            '  3. retire  create — Retire the old host',
            '       depends on split (text, no hold)',
            '       links to split (a hold)',
            'would create milestone release-1.0.0',
            'would create milestone release-1.1.0',
            'would create label(s) release-1.0.0, release-1.1.0 where missing',
            `dry run: nothing written. Apply with: pnpm items create --batch ${seed} --apply`,
          ],
        },
        [],
      ],
    );

    // GitLab: one create per entry in order, a milestone per release entry, one link POST per edge.
    const gl = fakeBoard('gitlab');
    const glRun = await run(gl.board(tmp), seed, { apply: true });
    check('batch: GitLab apply exits 0', glRun.code, 0);
    check(
      'batch: GitLab apply writes labels, milestones, then per entry create, milestone, links',
      gl.writes(),
      [
        [
          'POST',
          '/labels',
          {
            name: 'release-1.0.0',
            color: '#0E7490',
            description: 'The release this item belongs to; its milestone follows it.',
          },
        ],
        [
          'POST',
          '/labels',
          {
            name: 'release-1.1.0',
            color: '#0E7490',
            description: 'The release this item belongs to; its milestone follows it.',
          },
        ],
        ['POST', '/milestones', { title: 'release-1.0.0' }],
        ['POST', '/milestones', { title: 'release-1.1.0' }],
        [
          'POST',
          '/issues',
          { title: 'Inventory the services', description: BODY.inventory, labels: 'release-1.0.0,feedback' },
        ],
        ['PUT', '/issues/151?milestone_id=1', null],
        [
          'POST',
          '/issues',
          { title: 'Split the monolith', description: BODY.split, labels: 'release-1.1.0' },
        ],
        ['PUT', '/issues/152?milestone_id=2', null],
        [
          'POST',
          '/issues/152/links',
          { target_project_id: 'g/p', target_issue_iid: '151', link_type: 'relates_to' },
        ],
        [
          'POST',
          '/issues/152/links',
          { target_project_id: 'g/p', target_issue_iid: '5', link_type: 'relates_to' },
        ],
        ['POST', '/issues', { title: 'Retire the old host', description: BODY.retire }],
        [
          'POST',
          '/issues/153/links',
          { target_project_id: 'g/p', target_issue_iid: '152', link_type: 'relates_to' },
        ],
      ],
    );
    gl.fake.calls.length = 0;
    const glAgain = await run(gl.board(tmp), seed, { apply: true });
    check(
      'batch: a second apply finds all three and writes nothing',
      [glAgain.code, gl.writes(), marked(gl.issues).length],
      [0, [], 3],
    );

    // A project past 100 labels, with release-1.0.0 on page 2: it is found, not re-created as a duplicate.
    const crowded = fakeBoard('gitlab', {
      labels: [...Array.from({ length: 100 }, (_, i) => `area-${i}`), 'release-1.0.0'],
    });
    const crowdedRun = await run(crowded.board(tmp), seed, { apply: true });
    check(
      'batch: on a project with 101 labels, only the release label that is missing is created',
      [
        crowdedRun.code,
        crowded
          .writes()
          .filter(([, u]) => u === '/labels')
          .map(([, , b]) => b.name),
        marked(crowded.issues).length,
      ],
      [0, ['release-1.1.0'], 3],
    );

    // A failure on the second create stops the run; the re-run makes exactly the two creates still owed.
    const half = fakeBoard('gitlab', { fail: { create: { 2: 500 } } });
    const stopped = await run(half.board(tmp), seed, { apply: true });
    check(
      'batch: a failed create stops the run and prints the resume command',
      [stopped.code, stopped.out.slice(-2)],
      [
        1,
        [
          '! stopped at split: GitLab POST /projects/g%2Fp/issues answered 500',
          `! it may be partly written; nothing after it is. Fix the cause, then resume with: pnpm items create --batch ${seed} --apply`,
        ],
      ],
    );
    check('batch: ... with only the first entry on the board', marked(half.issues), [
      [151, 'Inventory the services'],
    ]);
    half.fake.calls.length = 0;
    const resumed = await run(half.board(tmp), seed, { apply: true });
    check(
      'batch: the re-run creates exactly the two entries still owed, and no duplicate',
      [
        resumed.code,
        half
          .writes()
          .filter(([m, u]) => m === 'POST' && u === '/issues')
          .map(([, , b]) => b.title),
        marked(half.issues),
      ],
      [
        0,
        ['Split the monolith', 'Retire the old host'],
        [
          [151, 'Inventory the services'],
          [152, 'Split the monolith'],
          [153, 'Retire the old host'],
        ],
      ],
    );

    // A failed link leaves a created item without it; the re-run reads its links back and adds the missing.
    const unlinked = fakeBoard('gitlab', { fail: { link: { 1: 500 } } });
    check(
      'batch: a failed link stops the run after its create',
      (await run(unlinked.board(tmp), seed, { apply: true })).code,
      1,
    );
    unlinked.fake.calls.length = 0;
    await run(unlinked.board(tmp), seed, { apply: true });
    check(
      "batch: the re-run fills in the skipped entry's links, then creates the rest",
      [unlinked.writes().map(([m, u]) => `${m} ${u}`), unlinked.links],
      [
        ['POST /issues/152/links', 'POST /issues/152/links', 'POST /issues', 'POST /issues/153/links'],
        [
          [152, 151],
          [152, 5],
          [153, 152],
        ],
      ],
    );

    // On a resume, a links read that fails stops the run on that read, before any link is POSTed again.
    const flaky = fakeBoard('gitlab', { fail: { create: { 3: 500 }, readLinks: { 1: 503 } } });
    check(
      'batch: a failed third create stops the run',
      (await run(flaky.board(tmp), seed, { apply: true })).code,
      1,
    );
    flaky.fake.calls.length = 0;
    const unread = await run(flaky.board(tmp), seed, { apply: true });
    check(
      'batch: an unreadable link list stops the resume on the read, with no write',
      [unread.code, unread.out.slice(-2)[0], flaky.writes(), flaky.links],
      [
        1,
        '! stopped at split: GitLab GET /projects/g%2Fp/issues/152/links answered 503',
        [],
        [
          [152, 151],
          [152, 5],
        ],
      ],
    );
    // A link GitLab already holds answers 409, and that is "linked", not a failure.
    const dup = await flaky.board(tmp).link(151, 152);
    check('batch: GitLab link on a linked pair is a no-op', [dup, flaky.links.length], [null, 2]);
    flaky.fake.calls.length = 0;
    const healed = await run(flaky.board(tmp), seed, { apply: true });
    check(
      'batch: once the read works, the resume creates only the entry still owed',
      [healed.code, flaky.writes().map(([m, u]) => `${m} ${u}`), marked(flaky.issues).length],
      [0, ['POST /issues', 'POST /issues/153/links'], 3],
    );

    // Refusals write nothing at all, even with --apply.
    const cyc = path.join(tmp, 'cycle.md');
    fs.writeFileSync(cyc, CYCLE);
    const refused = fakeBoard('gitlab');
    check(
      'batch: a cycle is refused under --apply with zero writes',
      [await run(refused.board(tmp), cyc, { apply: true }), refused.writes()],
      [
        {
          code: 1,
          out: [`! ${cyc}: nothing written —`, '!   Needs: goes round in a circle: a -> c -> b -> a'],
        },
        [],
      ],
    );

    // GitHub: the links go into the body of the one POST that creates the item, so no PATCH carries a body.
    const gh = fakeBoard('github');
    check('batch: GitHub apply exits 0', (await run(gh.board(tmp), seed, { apply: true })).code, 0);
    check(
      'batch: GitHub writes one POST per item with its Relates-to lines in it, and no link PATCH',
      gh.writes(),
      [
        [
          'POST',
          '/labels',
          {
            name: 'release-1.0.0',
            color: '0E7490',
            description: 'The release this item belongs to; its milestone follows it.',
          },
        ],
        [
          'POST',
          '/labels',
          {
            name: 'release-1.1.0',
            color: '0E7490',
            description: 'The release this item belongs to; its milestone follows it.',
          },
        ],
        ['POST', '/milestones', { title: 'release-1.0.0' }],
        ['POST', '/milestones', { title: 'release-1.1.0' }],
        [
          'POST',
          '/issues',
          { title: 'Inventory the services', body: BODY.inventory, labels: ['release-1.0.0', 'feedback'] },
        ],
        ['PATCH', '/issues/151', { milestone: 1 }],
        [
          'POST',
          '/issues',
          {
            title: 'Split the monolith',
            body: `${BODY.split}\n\nRelates-to: #151\n\nRelates-to: #5`,
            labels: ['release-1.1.0'],
          },
        ],
        ['PATCH', '/issues/152', { milestone: 2 }],
        [
          'POST',
          '/issues',
          { title: 'Retire the old host', body: `${BODY.retire}\n\nRelates-to: #152`, labels: [] },
        ],
      ],
    );

    // Rate-limited once: waited out and retried. Twice in a row: stop.
    const one = path.join(tmp, 'one.md');
    fs.writeFileSync(one, 'Batch: r\n=== only\n\nOnly\n');
    const slow = fakeBoard('github', { fail: { create: { 1: 429 } } });
    const waits = [];
    const sleep = async (ms) => waits.push(ms);
    const slowRun = await run(slow.board(tmp), one, { apply: true, sleep });
    check(
      'batch: a rate-limited create is waited out once and retried',
      [slowRun.code, waits, marked(slow.issues)],
      [0, [2000], [[151, 'Only']]],
    );
    const slower = fakeBoard('github', { fail: { create: { 1: 429, 2: 429 } } });
    waits.length = 0;
    const slowerRun = await run(slower.board(tmp), one, { apply: true, sleep });
    check(
      'batch: a second rate limit in a row stops the run',
      [slowerRun.code, waits, marked(slower.issues)],
      [1, [2000], []],
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  return failed;
}

// The setup server's cases: the guard in front of the API first, because another page open in the same
// browser can send requests to 127.0.0.1 too (Review Focus 1). Real HTTP through node:http rather than
// fetch, because fetch will not let a test set the Host and Origin headers an attacker's page would send.

import http from 'node:http';
import { fakeContext } from './fake.mjs';
import { createServer } from './server.mjs';
import { STEPS } from './steps.mjs';

const KEY = 'a'.repeat(64);

/** A server on a free port, and a request function aimed at it that sends the given headers verbatim. */
async function start(opts) {
  const server = createServer({ key: KEY, ...opts });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const host = `127.0.0.1:${port}`;
  const request = ({ method = 'GET', path = '/', headers = {}, body } = {}) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method, path, headers: { host, ...headers } },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c) => {
            text += c;
          });
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  const close = () => new Promise((resolve) => server.close(resolve));
  // The printed link's one visit: the page it answers carries the session the API wants, as a header.
  const claim = async () => {
    const page = await request({ path: `/?key=${KEY}` });
    const session = page.body.match(/<meta name="kit-session" content="([0-9a-f]{64})">/)?.[1];
    return { page, auth: { 'x-kit-session': session } };
  };
  return { port, host, request, close, claim };
}

/** A step list that runs nothing real: one passing check, and one action that records what it was given. */
function fakeSteps() {
  const ran = [];
  const steps = [
    { id: 'one', title: 'One', check: async () => ({ status: 'pass', summary: 'fine' }), actions: [] },
    {
      id: 'two',
      title: 'Two',
      check: async () => ({ status: 'todo', summary: 'not yet' }),
      actions: [
        {
          id: 'go',
          label: 'Go',
          run: async (_ctx, input) => {
            ran.push(input);
            return { status: 'pass', summary: 'went' };
          },
        },
      ],
    },
    { id: 'done', title: 'Done', check: null, actions: [] },
  ];
  return { steps, ran };
}

const FAKE_STATE = [
  { id: 'one', title: 'One', result: { status: 'pass', summary: 'fine' }, copy: null, actions: [] },
  {
    id: 'two',
    title: 'Two',
    result: { status: 'todo', summary: 'not yet' },
    copy: null,
    actions: [{ id: 'go', label: 'Go' }],
  },
  {
    id: 'done',
    title: 'Done',
    result: { status: 'todo', summary: 'One step is not finished yet.', detail: '2. Two', open: ['two'] },
    copy: {
      why: 'The factory is running.',
      picture: 'img/done.svg',
      body: [
        'Your board answers, your checks run, and you have taken one item from the board to a merge.',
        'Next time, open Claude Code in this folder: it shows the board when a session starts.',
      ],
    },
    actions: [],
  },
];

export default async function (check) {
  const json = (o) => ({ 'content-type': 'application/json', 'content-length': Buffer.byteLength(o) });

  // ---- the guard ------------------------------------------------------------------------------------------
  {
    const ctx = fakeContext();
    const { steps, ran } = fakeSteps();
    const s = await start({ ctx, steps });
    const { page: first, auth } = await s.claim();
    const origin = `http://${s.host}`;
    const post = (o, headers = {}) => {
      const body = typeof o === 'string' ? o : JSON.stringify(o);
      return s.request({ method: 'POST', path: '/api/action', headers: { ...json(body), ...headers }, body });
    };

    check('server: no session → /api/state is 403', (await s.request({ path: '/api/state' })).status, 403);
    check(
      'server: a wrong session → 403',
      (await s.request({ path: '/api/state', headers: { 'x-kit-session': 'b'.repeat(64) } })).status,
      403,
    );
    check(
      'server: the printed key is not a session: once taken, it opens nothing',
      (await s.request({ path: '/api/state', headers: { 'x-kit-session': KEY } })).status,
      403,
    );
    // Cookies reach every port on a host, so another local service would have been sent one (#18).
    check(
      'server: no cookie is set, and a cookie carrying the session opens nothing',
      [
        first.headers['set-cookie'],
        (
          await s.request({
            path: '/api/state',
            headers: { cookie: `kit_setup_${s.port}=${auth['x-kit-session']}` },
          })
        ).status,
      ],
      [undefined, 403],
    );
    check(
      'server: the key in the query of an API call → 403 (only the page takes it, once)',
      (await s.request({ path: `/api/state?key=${KEY}` })).status,
      403,
    );
    check(
      'server: wrong Host header with the right key → 403 (DNS rebinding)',
      (await s.request({ path: '/api/state', headers: { ...auth, host: 'evil.example:1234' } })).status,
      403,
    );
    check(
      'server: the right host on another port → 403',
      (await s.request({ path: '/api/state', headers: { ...auth, host: `127.0.0.1:${s.port + 1}` } })).status,
      403,
    );
    check(
      'server: cross-origin POST with the key → 403, nothing runs',
      [
        (await post({ step: 'two', action: 'go', input: {} }, { ...auth, origin: 'https://evil.example' }))
          .status,
        ctx.calls,
        ran,
      ],
      [403, [], []],
    );
    check(
      'server: cross-origin GET with the key → 403',
      (await s.request({ path: '/api/state', headers: { ...auth, origin: 'https://evil.example' } })).status,
      403,
    );
    check(
      'server: POST without the key → 403, nothing runs',
      [(await post({ step: 'two', action: 'go' }, { origin })).status, ctx.calls, ran],
      [403, [], []],
    );
    check(
      'server: unknown action → 400, nothing runs',
      [(await post({ step: 'two', action: 'nope' }, { ...auth, origin })).status, ctx.calls, ran],
      [400, [], []],
    );
    check(
      'server: unknown step → 400, nothing runs',
      [(await post({ step: 'nope', action: 'go' }, { ...auth, origin })).status, ctx.calls, ran],
      [400, [], []],
    );
    check(
      'server: an inherited name is not an action → 400, nothing runs',
      [(await post({ step: 'two', action: 'constructor' }, { ...auth, origin })).status, ran],
      [400, []],
    );
    check(
      'server: a body that is not JSON → 400, nothing runs',
      [(await post('{"step":', { ...auth, origin })).status, ran],
      [400, []],
    );
    check(
      'server: a form-encoded POST → 415, nothing runs (a form on another page cannot send JSON)',
      [
        (
          await s.request({
            method: 'POST',
            path: '/api/action',
            headers: { ...auth, origin, 'content-type': 'text/plain' },
            body: '{"step":"two","action":"go"}',
          })
        ).status,
        ran,
      ],
      [415, []],
    );
    check(
      'server: a body over the cap → 413, nothing runs',
      [
        (await post({ step: 'two', action: 'go', input: 'x'.repeat(70_000) }, { ...auth, origin })).status,
        ran,
      ],
      [413, []],
    );
    check(
      'server: path traversal → 404',
      [
        (await s.request({ path: '/page/../../.env.github', headers: auth })).status,
        (await s.request({ path: '/page/%2e%2e/%2e%2e/.env.github', headers: auth })).status,
        (await s.request({ path: '/page/..%2f..%2f.env.github', headers: auth })).status,
        (await s.request({ path: '/page/img', headers: auth })).status,
      ],
      [404, 404, 404, 404],
    );

    // ---- the key ----------------------------------------------------------------------------------------------
    check(
      'server: the key in the page URL answers the page, not stored, carrying a fresh session',
      [
        first.status,
        first.headers['cache-control'],
        /^[0-9a-f]{64}$/.test(auth['x-kit-session'] ?? ''),
        auth['x-kit-session'] === KEY,
      ],
      [200, 'no-store', true, false],
    );
    check(
      'server: the key in the page URL is taken once, so a copied link is worth nothing afterwards',
      (await s.request({ path: `/?key=${KEY}` })).status,
      403,
    );
    const page = await s.request({ path: '/' });
    check(
      'server: the page itself needs no session, and carries none',
      [
        page.status,
        page.headers['content-type'],
        page.body.includes('<title>'),
        page.body.includes('kit-session'),
      ],
      [200, 'text/html; charset=utf-8', true, false],
    );
    const asset = await s.request({ path: '/page/copy.mjs', headers: auth });
    check(
      'server: a file under page/ is served with its type',
      [asset.status, asset.headers['content-type'], asset.body.startsWith('// The setup guide')],
      [200, 'text/javascript; charset=utf-8', true],
    );
    check(
      'server: localhost on the right port is accepted too',
      (await s.request({ path: '/api/state', headers: { ...auth, host: `localhost:${s.port}` } })).status,
      200,
    );

    // ---- the API ----------------------------------------------------------------------------------------------
    const state = await s.request({ path: '/api/state', headers: auth });
    check(
      'server: state answers every step with its result and copy',
      [state.status, state.headers['cache-control'], JSON.parse(state.body)],
      [200, 'no-store', { steps: FAKE_STATE, claudeCode: false }],
    );
    const act = await post({ step: 'two', action: 'go', input: { mode: 'local' } }, { ...auth, origin });
    check(
      'server: a known action runs once with its input and answers its result and the new state',
      [act.status, JSON.parse(act.body), ran],
      [
        200,
        { result: { status: 'pass', summary: 'went' }, steps: FAKE_STATE, claudeCode: false },
        [{ mode: 'local' }],
      ],
    );
    await s.close();
  }

  // ---- the real catalogue, against a fake machine -----------------------------------------------------------
  {
    const ctx = fakeContext({
      files: {
        '.env.github':
          'GITHUB_REPOSITORY=acme/widgets\nGITHUB_APP_ID=123456\n' +
          'GITHUB_APP_PRIVATE_KEY_PATH=/keys/app.pem\nGITHUB_APP_INSTALLATION_ID=7654321\n',
      },
    });
    const s = await start({ ctx, steps: STEPS });
    const { auth } = await s.claim();
    const res = await s.request({ path: '/api/state', headers: auth });
    const ids = JSON.parse(res.body).steps.map((x) => x.id);
    check(
      'server: state → 200 with exactly eight steps in catalogue order',
      [res.status, ids],
      [200, ['toolchain', 'history', 'board', 'protection', 'ci', 'project', 'demo', 'done']],
    );
    check(
      'server: state never carries a secret',
      ['/keys/app.pem', 'app.pem', 'acme/widgets', '123456', '7654321', KEY].filter((v) =>
        res.body.includes(v),
      ),
      [],
    );
    await s.close();
  }

  // ---- started from Claude Code: the page offers `!` lines and prompts ------------------------------------
  {
    const { steps } = fakeSteps();
    const s = await start({ ctx: fakeContext({ env: { CLAUDECODE: '1' } }), steps });
    const { auth } = await s.claim();
    check(
      'server: under Claude Code, state says so',
      JSON.parse((await s.request({ path: '/api/state', headers: auth })).body).claudeCode,
      true,
    );
    await s.close();
  }

  // ---- an action offered only when its step's result says it applies -------------------------------------
  {
    const steps = [
      {
        id: 'one',
        title: 'One',
        check: async () => ({ status: 'fail', summary: 'x', apply: ['a change'] }),
        actions: [
          { id: 'fix', label: 'Fix', when: (r) => Boolean(r.apply?.length), run: async () => ({}) },
          { id: 'hidden', label: 'Hidden', when: (r) => Boolean(r.accept?.length), run: async () => ({}) },
          { id: 'always', label: 'Always', run: async () => ({}) },
        ],
      },
      { id: 'done', title: 'Done', check: null, actions: [] },
    ];
    const s = await start({ ctx: fakeContext(), steps });
    const { auth } = await s.claim();
    check(
      'server: an action whose when() is false is not offered',
      JSON.parse((await s.request({ path: '/api/state', headers: auth })).body).steps[0].actions,
      [
        { id: 'fix', label: 'Fix' },
        { id: 'always', label: 'Always' },
      ],
    );
    await s.close();
  }

  // ---- the review's finding 1: the demo's poll must not re-run every check, nor overlap ------------------
  {
    const runs = { one: 0, two: 0 };
    let release;
    const gate = new Promise((r) => {
      release = r;
    });
    // A server that ignores ?step= would wait on the gate for ever; this turns that hang into a failure.
    const safety = setTimeout(() => release(), 2000);
    const steps = [
      {
        id: 'one',
        title: 'One',
        check: async () => {
          runs.one++;
          await gate;
          return { status: 'pass', summary: 'fine' };
        },
        actions: [],
      },
      {
        id: 'two',
        title: 'Two',
        check: async () => {
          runs.two++;
          return { status: 'todo', summary: 'not yet' };
        },
        actions: [],
      },
      { id: 'done', title: 'Done', check: null, actions: [] },
    ];
    const s = await start({ ctx: fakeContext(), steps });
    const { auth } = await s.claim();
    const one = await s.request({ path: '/api/state?step=two', headers: auth });
    check(
      'server: state for one step runs only that step',
      [one.status, JSON.parse(one.body).steps.map((x) => x.id), runs],
      [200, ['two'], { one: 0, two: 1 }],
    );
    check(
      'server: state for an unknown step, or for done, is 400',
      [
        (await s.request({ path: '/api/state?step=nope', headers: auth })).status,
        (await s.request({ path: '/api/state?step=done', headers: auth })).status,
      ],
      [400, 400],
    );
    const a = s.request({ path: '/api/state', headers: auth });
    const b = s.request({ path: '/api/state', headers: auth });
    await new Promise((r) => setTimeout(r, 50));
    release();
    await Promise.all([a, b]);
    clearTimeout(safety);
    check('server: two full checks asked for at once run once', runs, { one: 1, two: 2 });
    await s.close();
  }
}

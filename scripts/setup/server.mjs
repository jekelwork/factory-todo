// The setup guide's server: the page, and a small JSON API that re-runs every check and runs the actions
// the catalogue offers. `pnpm kit:setup` starts it. DEVELOPER TOOLING, Node built-ins only, like the rest of
// `scripts/`: it has to run before `pnpm install` has worked.
//
// It listens on 127.0.0.1 only, and that is not enough on its own: every other page open in the same browser
// can send requests to 127.0.0.1 too, and an action here writes to this repository. So every request is
// refused unless
//
//   - its Host is 127.0.0.1:<port> or localhost:<port>. A page on evil.example that re-points its own name
//     at 127.0.0.1 (DNS rebinding) is same-origin to itself and sends `Host: evil.example`;
//   - any Origin it carries is this server's own. A cross-site form or fetch carries the attacker's;
//   - an API call carries the session, in an `x-kit-session` header. The terminal prints a link with a key
//     (32 random bytes) that works once: that visit answers the page with a fresh session in it, which the
//     page keeps in localStorage and drops the key from the address bar, so the link in the browser
//     history is worth nothing afterwards. Not a cookie: a browser sends a cookie for 127.0.0.1 to every
//     port on it, so every other local service would have been handed the session. localStorage belongs
//     to this origin, port included; and a page on another site cannot add the header to a request here
//     without a CORS preflight, which this server never answers.
//
// The page and its files need no session: they are this repository's own code, and carry nothing secret.
//
// An action must also be a JSON POST, which no plain HTML form can send, under a size cap; and it must name
// a step and an action the catalogue lists, or nothing runs. No answer carries a secret: the checks already
// say only "set / not set", and the server adds nothing to what they return.

import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realContext } from './checks.mjs';
import { COPY } from './page/copy.mjs';
import { guarded, runAll, STEPS } from './steps.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = path.join(HERE, 'page');
// An action's input is a mode name or a few short fields. Anything larger is not from the page.
const MAX_BODY = 64 * 1024;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

// Sent with every answer. The page is never framed (an action is a click, and a framed page can be clicked
// through), never cached (a step's state is only true now), and never names this URL to a link it follows.
const HEADERS = {
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy':
    "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; " +
    "base-uri 'none'; form-action 'none'",
};

class Refused extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sameKey(got, want) {
  const a = Buffer.from(String(got ?? ''));
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) {
      reject(new Refused(413, 'request body too large'));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    // Past the cap the rest is read and dropped, so the 413 still reaches the client.
    req.on('data', (c) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return reject(new Refused(413, 'request body too large'));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Refused(400, 'request body is not JSON'));
      }
    });
    req.on('error', reject);
  });
}

/** A file under page/, or null for anything that is not one, `..` and encoded slashes included. */
function pageFile(rel) {
  let decoded;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    return null;
  }
  const file = path.resolve(PAGE, decoded);
  if (!file.startsWith(PAGE + path.sep)) return null;
  try {
    return fs.statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/**
 * The setup server, not yet listening. `ctx` is the machine the checks run against, `key` the session key
 * (64 hex characters), `steps` the catalogue (the selftest passes a fake one, so nothing real runs).
 */
export function createServer({ ctx, key, steps = STEPS }) {
  // Made on the link's one visit; until then, no API call is answered.
  let session = null;

  // The actions' ids and labels only: `run` is code, and the page needs only what to show and what to ask for.
  // An action with `when` is offered only while the step's result says it applies.
  const shown = (s) => ({
    ...s,
    copy: COPY[s.id] ?? null,
    actions: (steps.find((x) => x.id === s.id)?.actions ?? [])
      .filter((a) => !a.when || a.when(s.result))
      .map(({ id, label }) => ({ id, label })),
  });

  // One full round at a time. A round runs the project's own `pnpm check`, which may take minutes; a second
  // request while one is running (a reload, a double "Check again") waits for it rather than starting the
  // project's test suite again beside it, which against an embedded database can corrupt its data.
  let round = null;
  const state = () => {
    round ??= runAll(ctx, steps)
      // `claudeCode`: started from Claude Code, whose shells carry CLAUDECODE=1. The page then also offers each
      // fix as a `!` line to paste into Claude Code, and as a prompt asking Claude Code to run it.
      .then((all) => ({ steps: all.map(shown), claudeCode: ctx.env?.CLAUDECODE === '1' }))
      .finally(() => {
        round = null;
      });
    return round;
  };

  /** One step only: what the demo step polls, so watching the board never re-runs every other check. */
  async function stepState(id) {
    const step = steps.find((s) => s.id === id && s.check);
    if (!step) throw new Refused(400, 'no such step');
    return { steps: [shown({ id: step.id, title: step.title, result: await guarded(step, ctx) })] };
  }

  async function handle(req, res) {
    const { port } = server.address();
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    const host = String(req.headers.host ?? '').toLowerCase();
    if (!hosts.includes(host)) throw new Refused(403, 'unknown host');
    const origin = req.headers.origin;
    if (origin !== undefined && !hosts.some((h) => origin === `http://${h}`)) {
      throw new Refused(403, 'cross-origin request');
    }

    const url = new URL(req.url, `http://${host}`);

    // The one place the key is taken: the link's first visit, answered with the page and a fresh session.
    if (req.method === 'GET' && url.pathname === '/' && url.searchParams.has('key')) {
      if (session || !sameKey(url.searchParams.get('key'), key)) {
        throw new Refused(403, 'this link has been used; stop the guide and run pnpm kit:setup again');
      }
      session = randomBytes(32).toString('hex');
      const html = fs
        .readFileSync(path.join(PAGE, 'index.html'), 'utf8')
        .replace('</head>', () => `  <meta name="kit-session" content="${session}">\n</head>`);
      res.writeHead(200, { ...HEADERS, 'content-type': TYPES['.html'] });
      res.end(html);
      return;
    }
    if (url.pathname.startsWith('/api/') && !(session && sameKey(req.headers['x-kit-session'], session))) {
      throw new Refused(403, 'open the guide from the link pnpm kit:setup printed');
    }

    if (url.pathname === '/' || url.pathname.startsWith('/page/')) {
      if (req.method !== 'GET') throw new Refused(405, 'method not allowed');
      const file = url.pathname === '/' ? path.join(PAGE, 'index.html') : pageFile(url.pathname.slice(6));
      if (!file) throw new Refused(404, 'not found');
      res.writeHead(200, {
        ...HEADERS,
        'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
      });
      res.end(fs.readFileSync(file));
      return;
    }

    if (url.pathname === '/api/state') {
      if (req.method !== 'GET') throw new Refused(405, 'method not allowed');
      const one = url.searchParams.get('step');
      return send(res, 200, one === null ? await state() : await stepState(one));
    }

    if (url.pathname === '/api/action') {
      if (req.method !== 'POST') throw new Refused(405, 'method not allowed');
      if (!/^application\/json(;|$)/.test(String(req.headers['content-type'] ?? ''))) {
        throw new Refused(415, 'an action is sent as JSON');
      }
      const body = await readJson(req);
      const step = steps.find((s) => s.id === body?.step);
      const action = step?.actions.find((a) => a.id === body?.action);
      if (!action) throw new Refused(400, 'no such step or action');
      const result = await action.run(ctx, body.input);
      return send(res, 200, { result, ...(await state()) });
    }

    throw new Refused(404, 'not found');
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof Refused ? err.status : 500;
      // An unexpected failure is logged here, where the person can read it, and answered without detail.
      if (!(err instanceof Refused)) console.error(err);
      if (!res.headersSent)
        send(res, status, { error: err instanceof Refused ? err.message : 'internal error' });
      else res.end();
    });
  });
  return server;
}

function send(res, status, body) {
  res.writeHead(status, { ...HEADERS, 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** Opens the URL in the default browser. Failing is fine: the URL is printed for the person to open. */
function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(HERE, '..', '..');
  const key = randomBytes(32).toString('hex');
  const server = createServer({ ctx: realContext(root), key });
  // Port 0: the system picks a free one, so a busy port never stops the guide from starting.
  server.listen(0, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${server.address().port}/?key=${key}`;
    console.log(`The setup guide is open in your browser. If it is not, open this link:\n\n  ${url}\n`);
    console.log('The link works once. Press Ctrl-C here to stop the guide.');
    openBrowser(url);
  });
  process.on('SIGINT', () => {
    console.log('\nStopped.');
    server.close(() => process.exit(0));
    server.closeAllConnections();
  });
}

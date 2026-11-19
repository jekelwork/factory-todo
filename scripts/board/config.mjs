// Configuration and the failure vocabulary for the work-item board, shared by both providers. DEVELOPER
// TOOLING, Node builtins only: the SessionStart hook runs this before anybody has installed anything.

import fs from 'node:fs';
import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..', '..');

/**
 * Parse .env text. Deliberately a small local copy rather than a dependency.
 *
 * This script must run from a bare checkout with no `npm install` behind it — the SessionStart hook fires
 * before anybody has had the chance to install anything — so it uses Node builtins only. If this project
 * later grows its own runtime .env loader, do NOT import it here: that one will be TypeScript, will mutate
 * `process.env` at import time and will log what it loaded, all of which is right for a server booting and
 * wrong for a script answering a question. Nothing read here is JSON, so this copy is the simple case.
 */
export function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      const end = value.lastIndexOf(quote);
      value = end > 0 ? value.slice(1, end) : value.slice(1);
    } else if (value.startsWith('#')) {
      // `KEY=   # optional` is a blank value with a comment. Trimmed, the comment is the whole value, and the
      // ' #' search below cannot see it: an installation id read as "# optional" became a 404 from GitHub.
      value = '';
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * A reader for one provider's settings. A REAL environment variable always wins over the file, because a
 * file in the working tree must never silently override what the platform was told to use.
 *
 * `.env.gitlab` or `.env.github` rather than `.env`, and that separation is the point rather than tidiness.
 * `mise.toml` carries `[env] _.file = ".env"`, so everything in `.env` is exported into every shell opened in
 * this repository and inherited by every process started from one — the dev server, the tests, anything.
 * That is right for the application's own configuration, which is what `.env` is.
 *
 * The board's credentials are not application configuration. No application process reads them, they grant
 * write access to the issue tracker, and they are the only credentials here whose blast radius reaches past
 * this machine — so they live in a file mise does not load and nothing else reads. There is deliberately NO
 * fallback to `.env`: a fallback would let a token drift back into the exported file and nothing would
 * report it.
 */
export function envReader(file, env = process.env, root = ROOT) {
  let fromFile = {};
  const envPath = path.join(root, file);
  if (fs.existsSync(envPath)) {
    try {
      fromFile = parseEnv(fs.readFileSync(envPath, 'utf8'));
    } catch {
      /* an unreadable file is "not configured", handled by the adapter */
    }
  }
  return (k) => (env[k] && env[k] !== '' ? env[k] : fromFile[k] || '');
}

/**
 * Which board this checkout reads: the provider whose file exists, or whose credential is in the
 * environment. Pure, so the selftest can pin every case.
 *
 * Both present is refused rather than guessed: a guess that picks the wrong tracker posts a plan on an
 * unrelated item with the same number. `BOARD_PROVIDER` settles it, and is the only way to.
 */
export function selectProvider({ gitlab, github, override }) {
  if (override) {
    if (override === 'gitlab' || override === 'github') return { provider: override };
    return { error: `BOARD_PROVIDER is "${override}" — it must be gitlab or github` };
  }
  if (gitlab && github) {
    return {
      error:
        'both .env.gitlab and .env.github are configured — remove the one this repository does not use, ' +
        'or set BOARD_PROVIDER=gitlab|github',
    };
  }
  if (github) return { provider: 'github' };
  if (gitlab) return { provider: 'gitlab' };
  return { provider: null };
}

/** The provider for this checkout, from the files in it and the environment. */
export function detectProvider(env = process.env, root = ROOT) {
  const present = (file, key) => fs.existsSync(path.join(root, file)) || Boolean(env[key]);
  return selectProvider({
    gitlab: present('.env.gitlab', 'GITLAB_TOKEN'),
    github: present('.env.github', 'GITHUB_APP_ID'),
    override: env.BOARD_PROVIDER || '',
  });
}

/**
 * Failure vocabulary: timeout, network, rate-limited, unauthenticated, forbidden, not-found, misconfigured,
 * http_error — so that a dropped VPN is distinguishable from a dead token. During the run this script
 * replaces, the VPN went down mid-flight and that was the distinction that mattered: one is "try again
 * later", the other is "the token expired and nothing will work".
 */
export class BoardError extends Error {
  status = 0;
  code = 'http_error';
  constructor(message, code, status) {
    super(message);
    this.code = code;
    this.status = status ?? 0;
  }
  /** True when nothing is wrong with us — the board is simply out of reach right now. */
  get transient() {
    return this.code === 'timeout' || this.code === 'network' || this.code === 'rate-limited';
  }
}

/**
 * A fetch with a deadline, turning a failure to answer into the vocabulary above. Both adapters use it.
 *
 * The timer is cleared in `finally`. It was not, originally: nothing hung, because `main()` ends in
 * `process.exit()` and that tears down the event loop whatever is pending — so a timer per request survived
 * every call and aborted an already-settled controller up to `timeoutMs` later. Invisible, and only
 * invisible by accident.
 */
export async function fetchWithin(fetchImpl, url, init, { timeoutMs, name }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    const aborted = e?.name === 'AbortError';
    throw new BoardError(
      aborted
        ? `${name} did not answer within ${timeoutMs} ms`
        : // fetch says only "fetch failed"; what went wrong (a reset socket, DNS, TLS) is on `cause`.
          `could not reach ${name}: ${String(e?.message || e)}${e?.cause?.message ? ` (${e.cause.message})` : ''}`,
      aborted ? 'timeout' : 'network',
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The board for this checkout, or a `BoardError` that says why there is none. Adapters are imported lazily,
 * so a GitLab checkout never loads the GitHub one.
 */
export async function openBoard(env = process.env, root = ROOT) {
  const { provider, error } = detectProvider(env, root);
  if (error) throw new BoardError(error, 'misconfigured');
  if (provider === 'github') return (await import('./github.mjs')).createGithub(env, root);
  // No provider at all reads as an unconfigured GitLab, which is what this tooling was before GitHub: the
  // message names both files, and the hook stays silent on it (exit 3) as it always has.
  return (await import('./gitlab.mjs')).createGitlab(env, root, { unconfigured: provider === null });
}

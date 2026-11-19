// The setup selftests' fake machine: a shell that answers only what it is told, and a file tree in memory.

import { makeContext } from './checks.mjs';

/**
 * A context whose shell answers only the commands it was given. `commands` maps `"git log --format=%s"`
 * (the command and its arguments joined by spaces) to `{ code, stdout, stderr }`; anything else answers
 * like a missing program, so a check that runs a command nobody expected fails loudly rather than passing
 * on an empty stdout. Every call and every write is recorded, for the cases that assert nothing ran.
 */
export function fakeContext({ files = {}, commands = {}, env = {}, now } = {}) {
  const calls = [];
  const writes = {};
  const store = { ...files };
  const ctx = makeContext({
    root: '/repo',
    sh: async (cmd, args = []) => {
      const key = [cmd, ...args].join(' ');
      calls.push(key);
      return commands[key] ?? { code: 127, stdout: '', stderr: `${cmd}: not found` };
    },
    read: (rel) => (rel in store ? store[rel] : null),
    write: (rel, text) => {
      store[rel] = text;
      writes[rel] = text;
    },
    env,
    ...(now ? { now } : {}),
  });
  return Object.assign(ctx, { calls, writes });
}

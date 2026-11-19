#!/usr/bin/env node
// Claude Code PreToolUse guard: refuses the tool calls the instruction files forbid, so the rule holds
// whether or not the agent remembers it. A rule an agent cannot break beats a paragraph it has to recall.
//
// Three kinds of refusal:
//
// 1. **An edit to a generated file** (Edit, Write, MultiEdit, NotebookEdit). Ground rule 5: lockfiles,
//    migrations and clients are produced by the project's command, never by hand. A hand-edited lockfile
//    installs something nobody resolved; a hand-edited migration that has already run cannot be taken back.
// 2. **An edit to a protected path**, by the same tools: code that agents read but do not change unasked,
//    such as the legacy system during a modernization (docs/agents/modernizing.md; why it is a hard
//    refusal: docs/DECISIONS.md, "The modernization playbook"). Empty in the kit; the modernize skill
//    fills it in.
// 3. **A shell command that does damage nobody asked for** (Bash): killing processes by pattern, which
//    matches the developer's own dev server; a force push, which rewrites history somebody else has; and
//    `npm install`, which writes a second lockfile beside pnpm's.
//
// A project on npm or yarn that adopted the kit keeps the kit's tooling in a package of its own, named by
// `factoryKit.package` in the root package.json (`scripts/setup/adopt.mjs`). There `npm install` is the
// project's own workflow, so the refusal holds only inside that package, and its lockfile is generated too.
//
// `permissions.deny` in `.claude/settings.json` lists the plain forms too. A deny rule matches a command by
// its prefix, so `git push origin main --force` walks past `Bash(git push --force:*)`. This hook reads the
// whole command line, which is why both exist.
//
// Projects extend the lists below, and mark each addition as local until a kit sync exists (README,
// "Kit-owned and project-owned"). Makers Market's additions would be its migrations directory and `dist/`,
// `drizzle-kit push`, and starting a second API process while one already answers its health check.
//
// Exit 2 blocks the call and hands stderr to the agent as the reason. Anything unparseable is let through:
// this guards against a mistake, and a guard that wedges every tool call when its input changes shape
// gets disabled.
//
// Node builtins only. `--selftest` checks the rules offline.
import { readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/** Paths, relative to the repository root, that only a command may write. */
export const GENERATED = [
  { pattern: /^pnpm-lock\.yaml$/, command: 'pnpm install' },
  // local: { pattern: /^apps\/api\/drizzle\//, command: 'pnpm db:generate' },
  { pattern: /^src\/server\/db\/migrations\//, command: 'pnpm db:generate' }, // local:
];

/** Paths, relative to the repository root, that agents read but never edit unasked; each with what it is. */
export const PROTECTED = [
  // local: { pattern: /^legacy\//, what: 'the legacy system, kept as it runs while it is modernized' },
];

/** Shell commands refused outright, each with the reason the agent is shown. */
export const COMMANDS = [
  {
    pattern: /(^|[;&|(]\s*|\bsudo\s+)(pkill|killall)\b/,
    reason:
      'killing by pattern matches processes you did not start, the developer\u2019s dev server among them. ' +
      'Kill the exact PID you captured when you started the process.',
  },
  {
    // Anchored to where a command starts, like the other two, so a heredoc or a commit message that only
    // mentions a force push is not refused.
    pattern: /(^|[;&|(]\s*)git\s+push\b(?=[^;&|\n]*\s(--force(?!-with-lease)\b|-f\b|\+\S))/,
    reason: 'a force push rewrites history other people have. Ask the developer to do it if it is needed.',
  },
  {
    pattern: /(^|[;&|(]\s*)npm\s+(i|install|ci|add)\b/,
    reason: 'this repository uses pnpm (`pnpm install`, `pnpm add`). npm writes a second lockfile.',
    kitPackageOnly: true,
  },
];

/** `factoryKit.package` from the root package.json, or null. Read only when a rule needs it. */
function kitPackageOf(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).factoryKit?.package ?? null;
  } catch {
    return null;
  }
}

const posix = (root, p) => relative(root, resolve(root, p)).split('\\').join('/');

/** `kitPackage` is `factoryKit.package`; left out, it is read from the root package.json when needed. */
export function check(input, root, { protectedPaths = PROTECTED, kitPackage } = {}) {
  const tool = input?.tool_name;
  const args = input?.tool_input ?? {};
  const kitDir = () => (kitPackage === undefined ? kitPackageOf(root) : kitPackage);
  if (tool === 'Bash' && typeof args.command === 'string') {
    for (const c of COMMANDS) {
      if (!c.pattern.test(args.command)) continue;
      const dir = c.kitPackageOnly ? kitDir() : null;
      // With a kit package, only inside it: where the command runs from, or a command that names it.
      if (dir) {
        const cwd = posix(root, input?.cwd ?? root);
        if (cwd !== dir && !cwd.startsWith(`${dir}/`) && !args.command.includes(dir)) continue;
      }
      return `Refused: ${c.reason}`;
    }
    return null;
  }
  const file = args.file_path ?? args.notebook_path;
  if (typeof file === 'string') {
    const rel = posix(root, file);
    // The kit's package is a package root of its own: its lockfile is as generated as the root's.
    const inPackage = (g) => {
      const dir = kitDir();
      return Boolean(dir) && rel.startsWith(`${dir}/`) && g.pattern.test(rel.slice(dir.length + 1));
    };
    const hit = GENERATED.find((g) => g.pattern.test(rel)) ?? GENERATED.find(inPackage);
    if (hit) {
      return (
        `Refused: ${rel} is generated (AGENTS.md, ground rule 5). Produce it with \`${hit.command}\` ` +
        'and commit the output.'
      );
    }
    const kept = protectedPaths.find((p) => p.pattern.test(rel));
    if (kept) {
      return (
        `Refused: ${rel} is protected: ${kept.what}. Agents read it and do not change it unasked. If the ` +
        'work item asks for this change, ask the developer to lift the rule for it.'
      );
    }
  }
  return null;
}

function selftest() {
  const root = '/repo';
  const bash = (command) => check({ tool_name: 'Bash', tool_input: { command } }, root);
  const edit = (file_path) => check({ tool_name: 'Edit', tool_input: { file_path } }, root);
  // The kit ships PROTECTED empty, so its cases run against the entry the modernize skill writes.
  const legacy = [{ pattern: /^legacy\//, what: 'the legacy system' }];
  const write = (file_path) =>
    check({ tool_name: 'Write', tool_input: { file_path } }, root, { protectedPaths: legacy });
  const cases = [
    ['pkill is refused', bash('pkill -f node') !== null],
    ['pkill after && is refused', bash('cd x && pkill node') !== null],
    ['killall is refused', bash('killall node') !== null],
    ['kill by PID is allowed', bash('kill 12345') === null],
    ['a word containing pkill is allowed', bash('grep -n "pkill" CLAUDE.md') === null],
    ['git push --force is refused', bash('git push --force') !== null],
    ['a trailing --force is refused', bash('git push origin main --force') !== null],
    ['git push -f is refused', bash('git push -f origin x') !== null],
    ['a +refspec is refused', bash('git push origin +main') !== null],
    ['a force push after && is refused', bash('git fetch && git push -f') !== null],
    ['a force push in quoted text is allowed', bash('echo "use git push origin main --force"') === null],
    ['a later --force in another command is allowed', bash('git push && rm --force x') === null],
    ['--force-with-lease is allowed', bash('git push --force-with-lease') === null],
    ['a plain push is allowed', bash('git push -u origin feat/x') === null],
    ['npm install is refused', bash('npm install left-pad') !== null],
    ['npm i is refused', bash('cd a; npm i') !== null],
    ['npm view is allowed', bash('npm view lefthook version') === null],
    ['pnpm install is allowed', bash('pnpm install') === null],
    ['the lockfile is refused', edit('/repo/pnpm-lock.yaml') !== null],
    ['a relative lockfile path is refused', edit('pnpm-lock.yaml') !== null],
    ['a nested file of that name is allowed', edit('/repo/docs/pnpm-lock.yaml') === null],
    ['an ordinary file is allowed', edit('/repo/README.md') === null],
    [
      'a file in a protected path is refused, with its own reason',
      write('/repo/legacy/src/billing.js') ===
        'Refused: legacy/src/billing.js is protected: the legacy system. Agents read it and do not change it ' +
          'unasked. If the work item asks for this change, ask the developer to lift the rule for it.',
    ],
    ['a relative protected path is refused', write('legacy/README.md') !== null],
    ['a path outside the protected one is allowed', write('/repo/apps/billing/src/index.ts') === null],
    ['a lookalike prefix is allowed', write('/repo/legacy-notes/plan.md') === null],
    ['an unknown tool is allowed', check({ tool_name: 'Read', tool_input: {} }, root) === null],
    ['nothing at all is allowed', check(undefined, root) === null],
  ];
  // A project on npm that keeps the kit in tools/factory-kit (factoryKit.package).
  const sub = 'tools/factory-kit';
  const npmAt = (command, cwd) =>
    check({ tool_name: 'Bash', tool_input: { command }, cwd }, root, { kitPackage: sub });
  const editAt = (file_path) =>
    check({ tool_name: 'Edit', tool_input: { file_path } }, root, { kitPackage: sub });
  cases.push(
    ["with a kit package, the project's own npm install is allowed", npmAt('npm install', '/repo') === null],
    [
      'with a kit package, npm install inside it is refused',
      npmAt('npm install', '/repo/tools/factory-kit') !== null,
    ],
    [
      'with a kit package, npm install naming it is refused',
      npmAt('npm install --prefix tools/factory-kit x', '/repo') !== null,
    ],
    [
      'with a kit package, its lockfile is refused',
      editAt('/repo/tools/factory-kit/pnpm-lock.yaml') !== null,
    ],
    ['with a kit package, a force push is still refused', npmAt('git push -f', '/repo') !== null],
    [
      'without a kit package, npm install anywhere is refused',
      check({ tool_name: 'Bash', tool_input: { command: 'npm ci' } }, root, { kitPackage: null }) !== null,
    ],
  );
  const failed = cases.filter(([, ok]) => !ok);
  for (const [name] of failed) console.error(`\u2717 ${name}`);
  if (failed.length) process.exit(1);
  console.log(`\u2713 guard selftest: ${cases.length} case(s)`);
}

if (process.argv.includes('--selftest')) {
  selftest();
} else {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }
  const reason = check(input, process.env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd());
  if (reason) {
    console.error(reason);
    process.exit(2);
  }
}

// `pnpm kit:adopt`'s cases, against real scratch git repositories in the temp directory: an npm project
// with Husky and ESLint, a Maven project with no package.json, and a pnpm project on master that already has
// its own AGENTS.md, CLAUDE.md, CI workflow, CODEOWNERS and Claude Code settings. For each, the exact set of
// written paths and the exact conflict list, every file outside the additive merges byte for byte, the
// default branch where it was, no "type", and a second --apply refused (AGENTS.md, "Assert the whole answer").
// Found by selftest.mjs by its name.
//
// It reads the kit's lists from this clone's README, so it runs only in the kit. A project's own copy of
// this file says so and checks nothing: its README has no such lists, and it has no kit to adopt from.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gitEnv } from '../board/migrate.mjs';
import {
  apply,
  branchFor,
  expand,
  KIT_ROOT,
  lefthookHooks,
  MARK,
  nativeStacks,
  ownershipLists,
  plan,
  REPORT,
  readKit,
  SUB_PACKAGE,
} from './adopt.mjs';

const ADOPT = path.join(KIT_ROOT, 'scripts/setup/adopt.mjs');

// Without the caller's GIT_* variables: under the pre-push hook, GIT_DIR would aim every scratch
// repository's git at the developer's own.
const run = (cwd, cmd, args) => {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: gitEnv() });
  return { code: r.status ?? (r.error ? 127 : 1), out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
};
const git = (cwd, ...args) => run(cwd, 'git', args).out;

/** A folder with these files, for a case that only plans: plan() reads, and needs no git. */
function tree(dir, files) {
  const root = fs.mkdtempSync(path.join(dir, 'target-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

/** A repository with these files committed on `branch`. */
function repo(dir, files, branch = 'main') {
  const root = tree(dir, files);
  git(root, 'init', '--quiet', '-b', branch);
  git(root, 'config', 'user.name', 'Selftest');
  git(root, 'config', 'user.email', 'selftest@example.invalid');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'add', '-A');
  git(root, 'commit', '--quiet', '-m', 'feat: the project as it was');
  return root;
}

/** Every tracked file's bytes. */
const snapshot = (root) =>
  new Map(
    git(root, 'ls-files')
      .split('\n')
      .filter(Boolean)
      .map((f) => [f, fs.readFileSync(path.join(root, f))]),
  );

const conflicts = (p) => p.conflict.map((c) => `${c.path}: ${c.what}`);

/**
 * Applies the plan and returns what the cases compare: the written paths, the paths whose bytes changed,
 * the default branch's sha before and after, and the commits the branch added.
 */
function adopt(kit, root, branch) {
  const before = snapshot(root);
  const sha = git(root, 'rev-parse', branch);
  const p = plan(kit, root);
  const done = apply(p, root, { install: false });
  const changed = [...before].filter(([f, data]) => {
    const now = fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f)) : null;
    return !now || Buffer.compare(now, data) !== 0;
  });
  return {
    p,
    written: done.paths,
    changed: changed.map(([f]) => f).sort(),
    defaultBranch: [sha, git(root, 'rev-parse', branch)],
    log: git(root, 'log', '--format=%s', `${branch}..HEAD`),
    status: git(root, 'status', '--porcelain'),
    current: git(root, 'branch', '--show-current'),
  };
}

const refusal = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e.message;
  }
};

/** pnpm agrees the lockfile fits the package.json beside it, without the network. */
const lockfileFits = (dir) =>
  run(dir, 'pnpm', ['install', '--frozen-lockfile', '--lockfile-only', '--offline', '--ignore-scripts']).code;

/** What check-docs refuses in the adopted repository, one line each; empty when it passes. */
const docsFailures = (root) =>
  run(root, 'node', ['scripts/check-docs.mjs'])
    .out.split('\n')
    .filter((l) => l.startsWith('✗'));

const pkgOf = (root, rel = 'package.json') => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

export default async function (check) {
  // The same test readKit makes: a kit clone is a repository whose README has the ownership lists.
  if (!ownershipLists(fs.readFileSync(path.join(KIT_ROOT, 'README.md'), 'utf8')).kit) {
    console.log('- adopt: skipped, this is not the kit (its README has no ownership lists to adopt from)');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-adopt-'));
  try {
    await cases(check, dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function cases(check, dir) {
  // ---- the lists ----
  check(
    'adopt: the README lists parse, a directory and an ADR number expand',
    [
      ownershipLists(
        '## Kit-owned and project-owned\n\n**Kit-owned:** `a.mjs`, `b/*`.\n\n**Project-owned:** `c.md`.\n',
      ),
      expand(
        ['b/*', 'docs/adr/0001', 'd'],
        ['b/x.mjs', 'b/y/z.md', 'docs/adr/0001-x.md', 'docs/adr/0010-y.md', 'd/e.md', 'de.md'],
      ),
      ownershipLists('# no lists here\n'),
    ],
    [
      { kit: ['a.mjs', 'b/*'], project: ['c.md'] },
      ['b/x.mjs', 'b/y/z.md', 'd/e.md', 'docs/adr/0001-x.md'],
      { kit: null, project: null },
    ],
  );
  check(
    'adopt: a kit-owned name that matches nothing is an error, not a smaller kit',
    refusal(() => expand(['scripts/gone.mjs'], ['scripts/here.mjs'], { strict: true })),
    "the README's kit-owned list names scripts/gone.mjs, which is not here",
  );
  // ---- the gates under another hook manager (Phase 3) ----
  check(
    "adopt: lefthook.yml's hooks, read from the file",
    lefthookHooks(fs.readFileSync(path.join(KIT_ROOT, 'lefthook.yml'), 'utf8')),
    ['pre-commit', 'commit-msg', 'pre-push'],
  );

  // ---- the native builds (Phase 2) ----
  const stackCases = [
    [['pom.xml', 'mvnw', 'src'], [['Maven', './mvnw -B verify']]],
    [['build.gradle.kts', 'gradlew'], [['Gradle', './gradlew check']]],
    [['build.gradle'], [['Gradle', 'gradle check']]],
    [['Shop.sln', 'Shop.csproj'], [['.NET', 'dotnet test Shop.sln']]],
    [['A.sln', 'B.sln'], [['.NET', 'dotnet test']]],
    [['pyproject.toml', 'package.json'], [['Python', 'uv run pytest']]],
    [['package.json', 'README.md'], []],
  ];
  check(
    'adopt: each native build has its gate, a wrapper preferred to a global tool',
    stackCases.map(([names]) => nativeStacks(names).map((n) => [n.stack, n.gate])),
    stackCases.map(([, want]) => want),
  );
  // The header cites the ADR that holds the adoption boundary; 0005 is the leases', and check-docs reads
  // a number that prefixes a real file as resolved.
  check(
    'adopt: the ADRs its header cites are the adoption record',
    [
      ...fs
        .readFileSync(ADOPT, 'utf8')
        .split('\nimport ')[0]
        .matchAll(/docs\/adr\/(\d{4})/g),
    ].map(
      (m) => fs.readdirSync(path.join(KIT_ROOT, 'docs/adr')).find((n) => n.startsWith(`${m[1]}-`)) ?? m[1],
    ),
    ['0006-adoption-writes-only-on-a-branch.md'],
  );
  // A kit clone's untracked work (a scratch script, a pasted token) is not the kit, and would be committed
  // into the target under --no-verify.
  check(
    "adopt: the kit is what its clone tracks, not the clone's untracked files",
    (() => {
      const root = repo(dir, {
        'README.md':
          '## Kit-owned and project-owned\n\n**Kit-owned:** `scripts/*`.\n\n**Project-owned:** `AGENTS.md`.\n',
        'package.json': '{ "version": "9.9.9" }\n',
        'scripts/tool.mjs': 'export {};\n',
        'AGENTS.md': '# kit\n',
        '.gitignore': 'node_modules/\n',
        '.npmrc': '',
        'pnpm-lock.yaml': '',
      });
      fs.writeFileSync(path.join(root, 'scripts/scratch-token.txt'), 'GITLAB_TOKEN=x\n');
      fs.mkdirSync(path.join(root, 'scripts/wip'));
      fs.writeFileSync(path.join(root, 'scripts/wip/notes.md'), '# notes\n');
      const k = readKit(root);
      return [k.kitOwned, k.starters, [...k.files.keys()].sort()];
    })(),
    [
      ['scripts/tool.mjs'],
      ['AGENTS.md'],
      ['.gitignore', '.npmrc', 'AGENTS.md', 'pnpm-lock.yaml', 'scripts/tool.mjs'],
    ],
  );
  const kit = readKit();
  check(
    "adopt: the kit's own list holds its tooling",
    ['scripts/work-items.mjs', 'scripts/setup/adopt.mjs', '.claude/hooks/guard.mjs', 'lefthook.yml'].filter(
      (f) => !kit.kitOwned.includes(f),
    ),
    [],
  );
  const kitOwned = (except = []) => kit.kitOwned.filter((f) => !except.includes(f));
  const sorted = (...lists) => [...new Set(lists.flat())].sort();

  // ---- 1. npm, Husky, ESLint ----
  {
    const files = {
      'package.json': `${JSON.stringify(
        {
          name: 'shop',
          version: '3.4.0',
          scripts: { test: 'node --test', lint: 'eslint .', prepare: 'husky' },
          devDependencies: { eslint: '^9.0.0', husky: '^9.0.0' },
        },
        null,
        2,
      )}\n`,
      'package-lock.json': '{"lockfileVersion": 3}\n',
      '.husky/pre-commit': 'npm test\n',
      'eslint.config.js': 'export default [];\n',
      '.gitignore': 'node_modules/\n',
      'README.md': '# Shop\n\nSee `docs/missing.md`.\n',
      'src/index.js': 'module.exports = 1;\n',
    };
    const root = repo(dir, files);
    const a = adopt(kit, root, 'main');
    check(
      'adopt npm: the layout, the lint scope and the hook manager',
      [a.p.layout, a.p.scope, a.p.manager],
      ['sub', 'kit', 'Husky'],
    );
    check(
      'adopt npm: exactly these paths written',
      a.written,
      sorted(kitOwned(), [
        '.claude/settings.json',
        '.gitignore',
        '.github/workflows/ci.yml',
        '.husky/commit-msg',
        '.husky/pre-commit',
        '.husky/pre-push',
        'AGENTS.md',
        'CLAUDE.md',
        'CONTRIBUTING.md',
        'SECURITY.md',
        'TASKS.md',
        'biome.json',
        'docs/DECISIONS.md',
        'docs/adr/0001-build-with-agents-under-review.md',
        'docs/agents/project.md',
        'mise.toml',
        'package.json',
        REPORT,
        `${SUB_PACKAGE}/.npmrc`,
        `${SUB_PACKAGE}/package.json`,
        `${SUB_PACKAGE}/pnpm-lock.yaml`,
      ]),
    );
    // `prepare` is Husky's and the kit's is not offered at all: two hook managers overwrite each other.
    check('adopt npm: no conflicts', conflicts(a.p), []);
    check('adopt npm: only the merged files changed', a.changed, [
      '.gitignore',
      '.husky/pre-commit',
      'package.json',
    ]);
    const hook = (h) => fs.readFileSync(path.join(root, `.husky/${h}`), 'utf8');
    const lefthook = `mise exec -- ${SUB_PACKAGE}/node_modules/.bin/lefthook run`;
    check(
      "adopt npm: Husky's hooks hand over to lefthook, after the project's own",
      [hook('pre-commit'), hook('commit-msg'), hook('pre-push')],
      [
        `npm test\n\n${MARK}\n${lefthook} pre-commit --no-auto-install\n`,
        `#!/usr/bin/env sh\n${MARK}\n${lefthook} commit-msg --no-auto-install "$1"\n`,
        `#!/usr/bin/env sh\n${MARK}\n${lefthook} pre-push --no-auto-install "$@"\n`,
      ],
    );
    // Husky 5 to 8 point core.hooksPath at .husky, where git skips a hook file that is not executable.
    const mode = (h) => (fs.statSync(path.join(root, `.husky/${h}`)).mode & 0o111) !== 0;
    check(
      "adopt npm: the hooks the kit adds are executable, in the tree and in the commit; the project's keep their mode",
      [
        mode('commit-msg'),
        mode('pre-push'),
        mode('pre-commit'),
        git(root, 'ls-files', '-s', '.husky')
          .split('\n')
          .map((l) => `${l.split(' ')[0]} ${l.split('\t')[1]}`),
      ],
      [true, true, false, ['100755 .husky/commit-msg', '100644 .husky/pre-commit', '100755 .husky/pre-push']],
    );
    // lefthook sets the bit on a hook script before it runs one: without it, every push leaves it modified.
    check(
      "adopt npm: the kit's executable files are executable, in the tree and in the commit",
      [
        (fs.statSync(path.join(root, '.lefthook/pre-push/gates.sh')).mode & 0o111) !== 0,
        git(root, 'ls-files', '-s', '.lefthook').split(' ')[0],
        [...kit.executable].sort(),
      ],
      [true, '100755', ['.lefthook/pre-push/gates.sh']],
    );
    check(
      'adopt npm: one commit, on the adoption branch, the default branch untouched',
      [a.log, a.current, a.status, a.defaultBranch[0] === a.defaultBranch[1]],
      [`chore: adopt the Factory Kit ${kit.version}`, branchFor(kit.version), '', true],
    );
    const pkg = pkgOf(root);
    const sub = pkgOf(root, `${SUB_PACKAGE}/package.json`);
    check(
      "adopt npm: the root keeps npm and its scripts; the kit's tooling is in its own package",
      [
        pkg.scripts.test,
        pkg.scripts.lint,
        pkg.scripts.prepare,
        pkg.scripts['kit:lint'],
        pkg.scripts.check,
        pkg.scripts['lint:staged'],
        pkg.packageManager,
        pkg.devDependencies,
        'type' in pkg || 'type' in sub,
        pkg.factoryKit.kit,
        pkg.factoryKit.lint,
        pkg.factoryKit.package,
        Object.keys(pkg.factoryKit.manifest).sort(),
        sub.devDependencies,
        sub.scripts.check,
        sub.scripts.prepare,
      ],
      [
        'node --test',
        'eslint .',
        'husky',
        undefined,
        `pnpm --dir ${SUB_PACKAGE} run check`,
        `${SUB_PACKAGE}/node_modules/.bin/biome check --no-errors-on-unmatched`,
        undefined,
        { eslint: '^9.0.0', husky: '^9.0.0' },
        false,
        kit.version,
        'kit',
        SUB_PACKAGE,
        kitOwned(),
        kit.pkg.devDependencies,
        `cd ../.. && pnpm --dir ${SUB_PACKAGE} run lint && node .claude/hooks/guard.mjs --selftest && node scripts/setup/selftest.mjs && node scripts/lease.mjs selftest && node scripts/pre-push.mjs selftest && node scripts/ci-selftest.mjs && node scripts/check-secrets.mjs --selftest`,
        undefined,
      ],
    );
    check(
      "adopt npm: the kit's lockfile fits its package, as pnpm itself says",
      lockfileFits(path.join(root, SUB_PACKAGE)),
      0,
    );
    check(
      "adopt npm: npm stays the project's, so the settings refuse no npm command",
      pkgOf(root, '.claude/settings.json').permissions.deny.filter((r) => r.startsWith('Bash(npm')),
      [],
    );
    check(
      "adopt npm: Biome covers only the kit's files",
      pkgOf(root, 'biome.json').files.includes,
      kitOwned().filter((f) => /\.(ts|tsx|mts|js|mjs|cjs|json|jsonc|css|html)$/.test(f)),
    );
    // The project's README cites a file that does not exist; with factoryKit.lint it is the project's own.
    check('adopt npm: check-docs passes in the adopted project', docsFailures(root), []);
    check(
      'adopt npm: the guard passes its selftest there',
      run(root, 'node', ['.claude/hooks/guard.mjs', '--selftest']).code,
      0,
    );
    // The hooks and `check` run the kit's package, which the project's own `npm install` does not install.
    const report = fs.readFileSync(path.join(root, REPORT), 'utf8');
    check(
      "adopt npm: the report's next steps start with installing the kit's package",
      report.split('## Next\n')[1],
      [
        `- Install the kit's package, which the git hooks and \`check\` run from: \`mise exec -- pnpm --dir ${SUB_PACKAGE} install\`. Every developer needs it once, after the project's own \`npm install\`; until then the hooks and \`check\` fail on a missing lefthook or Biome. For \`npm install\` to bring it, make the project's \`prepare\` run it as well: \`"prepare": "husky && mise exec -- pnpm --dir ${SUB_PACKAGE} install --frozen-lockfile"\`.`,
        `- Push the branch and open a pull request: \`git push -u origin ${branchFor(kit.version)}\`.`,
        '- After merging, `pnpm kit:setup` takes the project through the board, the lock on the default branch and the start-project interview.',
        '',
      ].join('\n'),
    );
    check(
      'adopt npm: a second --apply is refused',
      refusal(() => apply(plan(kit, root), root, { install: false })),
      `the target already adopted the Factory Kit ${kit.version}; syncing is not built`,
    );
  }

  // ---- 1b. Python with pre-commit: the kit's gates as a local repo, lefthook not installed ----
  {
    const config =
      'repos:\n  - repo: https://github.com/astral-sh/ruff-pre-commit\n    rev: v0.6.0\n    hooks:\n      - id: ruff\n';
    const root = repo(dir, {
      'pyproject.toml': '[project]\nname = "tiles"\n',
      '.pre-commit-config.yaml': config,
      'README.md': '# Tiles\n',
    });
    const a = adopt(kit, root, 'main');
    const pkg = pkgOf(root);
    const text = fs.readFileSync(path.join(root, '.pre-commit-config.yaml'), 'utf8');
    check(
      'adopt pre-commit: the layout, the hook manager, no prepare, and the gate',
      [
        a.p.layout,
        a.p.scope,
        a.p.manager,
        'prepare' in pkg.scripts,
        pkg.scripts.check.endsWith(' && uv run pytest'),
      ],
      ['new', 'kit', 'pre-commit', false, true],
    );
    check(
      'adopt pre-commit: no conflicts, and only the config changed',
      [conflicts(a.p), a.changed],
      [[], ['.pre-commit-config.yaml']],
    );
    check(
      "adopt pre-commit: the project's repos stay first, the kit's follow, and its hook types are installed",
      [
        text.startsWith(config),
        text.includes(
          '  - repo: local\n    hooks:\n      - id: factory-kit-pre-commit\n        name: Factory Kit pre-commit\n        entry: mise exec -- pnpm exec lefthook run pre-commit --no-auto-install\n',
        ),
        [...text.matchAll(/- id: (factory-kit-[\w-]+)/g)].map((m) => m[1]),
        text.endsWith('default_install_hook_types: [pre-commit, commit-msg, pre-push]\n'),
      ],
      [true, true, ['factory-kit-pre-commit', 'factory-kit-commit-msg', 'factory-kit-pre-push'], true],
    );
  }
  check(
    'adopt: a pre-commit config whose repos are not last is proposed, not edited',
    (() => {
      const root = tree(dir, {
        '.pre-commit-config.yaml': 'repos: []\nfail_fast: true\n',
        'README.md': '# x\n',
      });
      const p = plan(kit, root);
      return [p.writes.has('.pre-commit-config.yaml'), conflicts(p)];
    })(),
    [
      false,
      [
        ".pre-commit-config.yaml: `repos:` is not the file's last key, or not a block list, so the kit's hooks cannot be appended to it",
      ],
    ],
  );
  // lefthook.yml's pre-commit calls `lint:staged` by name, so the project's own script of that name would
  // run in place of Biome.
  check(
    "adopt: a project's own lint:staged is a conflict, since the pre-commit hook calls it",
    (() => {
      const root = tree(dir, {
        'package.json': '{ "name": "x", "scripts": { "lint:staged": "lint-staged" } }\n',
        'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      });
      const p = plan(kit, root);
      const scripts = JSON.parse(p.writes.get('package.json')).scripts;
      return [
        p.conflict.map((c) => `${c.path}: ${c.what}. ${c.proposal}`),
        scripts['lint:staged'],
        scripts['kit:lint:staged'],
      ];
    })(),
    [
      [
        `package.json: the project has its own "lint:staged" script. lefthook.yml's pre-commit hook runs "pnpm run lint:staged --write <staged files>", which is now the project's "lint-staged" rather than Biome. Rename the project's script, then rename "kit:lint:staged" to "lint:staged".`,
      ],
      'lint-staged',
      kit.pkg.scripts['lint:staged'],
    ],
  );

  // ---- 1c. the paths the tool writes beside the kit's files are the project's, when it has them ----
  {
    const STARTER_AGENTS =
      'Insert the kit\'s "## Ground rules" section, its rules marked *(kit)*, and the "## The work-item board" section into the project\'s AGENTS.md. The setup guide\'s "Your project" step stays open until the *(kit)* rules are there.';
    const root = repo(dir, {
      'package.json': '{ "name": "y" }\n',
      'package-lock.json': '{}\n',
      'AGENTS.md': '# mine\n',
      'AGENTS.md.proposed': 'MY PROPOSED\n',
      [REPORT]: 'MY OWN REPORT\n',
      [`${SUB_PACKAGE}/package.json`]: '{ "name": "mine" }\n',
    });
    const a = adopt(kit, root, 'main');
    check(
      'adopt: an existing .proposed, report or kit package file is reported, not overwritten',
      [a.p.conflict.map((c) => `${c.path}: ${c.what}. ${c.proposal}`), a.changed],
      [
        [
          `AGENTS.md: the project has its own file at this path. ${STARTER_AGENTS} The project has its own AGENTS.md.proposed, so the kit's version is not written beside it.`,
          `${SUB_PACKAGE}/package.json: the project has its own file at this path. Merge what the project needs from it by hand. The kit's version is beside it as ${SUB_PACKAGE}/package.json.proposed.`,
          `${REPORT}: the project has its own file at this path. The report is not written on the branch; the dry run printed it.`,
        ],
        ['package.json'],
      ],
    );
  }
  check(
    "adopt: with no package.json, a lockfile of the project's own is kept",
    (() => {
      const root = tree(dir, { 'pom.xml': '<project/>\n', 'pnpm-lock.yaml': 'MINE-LOCK\n' });
      const p = plan(kit, root);
      return [conflicts(p), p.writes.has('pnpm-lock.yaml'), p.writes.has('pnpm-lock.yaml.proposed')];
    })(),
    [['pnpm-lock.yaml: the project has its own file at this path'], false, true],
  );

  // ---- 1d. the project's own ignore rules: what they hide is reported, and --apply never fails half-way ----
  {
    const root = repo(dir, {
      'pom.xml': '<project/>\n',
      '.gitignore': '.claude/\ntarget/\n',
      'README.md': '# z\n',
    });
    const a = adopt(kit, root, 'main');
    const claude = sorted(kit.kitOwned, kit.starters, ['.claude/settings.json']).filter((f) =>
      f.startsWith('.claude/'),
    );
    check(
      'adopt: a path the project ignores is a conflict, not written, not in the manifest, and the rest commits',
      [
        a.p.conflict.map((c) => `${c.path}: ${c.what}. ${c.proposal}`),
        a.written.filter((f) => f.startsWith('.claude/')),
        Object.keys(pkgOf(root).factoryKit.manifest).filter((f) => f.startsWith('.claude/')),
        [a.log, a.current, a.status],
      ],
      [
        [
          `.gitignore: line 1, .claude/, hides ${claude.length} paths the kit writes (${claude[0]}…). Not written, since git add refuses an ignored path. If the kit's files belong in the repository, add a negation for them (for example !${claude[0]}) and run the adoption again.`,
        ],
        [],
        [],
        [`chore: adopt the Factory Kit ${kit.version}`, branchFor(kit.version), ''],
      ],
    );
  }
  check(
    'adopt: a plan the target no longer fits is refused before anything is touched',
    (() => {
      const root = repo(dir, { 'README.md': '# s\n', '.gitignore': 'node_modules/\n' });
      const p = plan(kit, root);
      fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\nTASKS.md\n');
      git(root, 'commit', '--quiet', '-am', 'chore: ignore the task list');
      return [
        refusal(() => apply(p, root, { install: false })),
        git(root, 'branch', '--show-current'),
        git(root, 'status', '--porcelain'),
        git(root, 'branch', '--list', branchFor(kit.version)),
      ];
    })(),
    ['the target changed since the plan (TASKS.md is ignored); run the dry run again', 'main', '', ''],
  );
  {
    const root = repo(dir, {
      'package.json': '{ "name": "r" }\n',
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      '.gitignore': 'node_modules/\n',
    });
    const before = snapshot(root);
    const names = fs.readdirSync(root).sort();
    // A commit that cannot be signed fails after every file is written and staged.
    git(root, 'config', 'commit.gpgsign', 'true');
    git(root, 'config', 'gpg.program', 'false');
    const err = refusal(() => apply(plan(kit, root), root, { install: false }));
    check(
      'adopt: a step that fails after the switch puts the target back as it was',
      [
        err?.startsWith('git commit failed: ') &&
          err.endsWith('; nothing was kept, and the target is on main again'),
        git(root, 'branch', '--show-current'),
        git(root, 'status', '--porcelain', '--ignored'),
        git(root, 'branch', '--list', branchFor(kit.version)),
        fs.readdirSync(root).sort(),
        [...before].filter(([f, data]) => !fs.readFileSync(path.join(root, f)).equals(data)).map(([f]) => f),
      ],
      [true, 'main', '', '', names, []],
    );
  }

  // ---- 2. Maven, no package.json ----
  {
    const root = repo(dir, {
      'pom.xml': '<project><modelVersion>4.0.0</modelVersion></project>\n',
      'src/main/java/App.java': 'class App {}\n',
      'README.md': '# App\n',
      '.gitignore': 'target/\n',
    });
    const a = adopt(kit, root, 'main');
    check(
      'adopt maven: the layout and the lint scope',
      [a.p.layout, a.p.scope, a.p.manager],
      ['new', 'kit', null],
    );
    check(
      'adopt maven: exactly these paths written',
      a.written,
      sorted(kitOwned(), [
        '.claude/settings.json',
        '.gitignore',
        '.github/workflows/ci.yml',
        '.npmrc',
        'AGENTS.md',
        'CLAUDE.md',
        'CONTRIBUTING.md',
        'SECURITY.md',
        'TASKS.md',
        'biome.json',
        'docs/DECISIONS.md',
        'docs/adr/0001-build-with-agents-under-review.md',
        'docs/agents/project.md',
        'mise.toml',
        'package.json',
        'pnpm-lock.yaml',
        REPORT,
      ]),
    );
    check('adopt maven: no conflicts', conflicts(a.p), []);
    check('adopt maven: only .gitignore changed', a.changed, ['.gitignore']);
    const pkg = pkgOf(root);
    check(
      "adopt maven: a package.json of the kit's, without what describes the kit",
      [Object.keys(pkg), pkg.scripts, pkg.devDependencies, pkg.factoryKit.kit, pkg.factoryKit.lint],
      [
        ['name', 'private', 'packageManager', 'engines', 'scripts', 'devDependencies', 'factoryKit'],
        { ...kit.pkg.scripts, check: `${kit.pkg.scripts.check} && mvn -B verify` },
        kit.pkg.devDependencies,
        kit.version,
        'kit',
      ],
    );
    check("adopt maven: the kit's lockfile fits, as pnpm itself says", lockfileFits(root), 0);
    const written = fs.readFileSync(path.join(root, REPORT), 'utf8');
    check(
      'adopt maven: the report names the gate and carries the JDK recipe for ci.yml',
      [
        written.includes(
          "- A Maven build (pom.xml): `pnpm check` runs `mvn -B verify` after the kit's gates, and Biome and check-docs cover only the kit's files.",
        ),
        written.includes(
          "  ```yaml\n  - uses: actions/setup-java@v4\n    with:\n      distribution: temurin\n      java-version: '21'\n  ```",
        ),
      ],
      [true, true],
    );
    check('adopt maven: check-docs passes in the adopted project', docsFailures(root), []);
    check(
      'adopt maven: the .gitignore gained only lines, under a heading',
      fs
        .readFileSync(path.join(root, '.gitignore'), 'utf8')
        .startsWith('target/\n\n# Factory Kit\nnode_modules/\n'),
      true,
    );
  }

  // ---- 2b. Maven with an npm front end: the gate runs once, from the kit's package ----
  {
    const root = repo(dir, {
      'pom.xml': '<project/>\n',
      'package.json': '{ "name": "web" }\n',
      'package-lock.json': '{}\n',
    });
    const p = plan(kit, root);
    const json = (rel) => JSON.parse(p.writes.get(rel));
    check(
      'adopt maven+npm: the root check calls the package, whose check runs the gate',
      [p.layout, json('package.json').scripts.check, json(`${SUB_PACKAGE}/package.json`).scripts.check],
      [
        'sub',
        `pnpm --dir ${SUB_PACKAGE} run check`,
        `cd ../.. && pnpm --dir ${SUB_PACKAGE} run lint && node .claude/hooks/guard.mjs --selftest && node scripts/setup/selftest.mjs && node scripts/lease.mjs selftest && node scripts/pre-push.mjs selftest && node scripts/ci-selftest.mjs && node scripts/check-secrets.mjs --selftest && mvn -B verify`,
      ],
    );
  }

  // ---- 3. pnpm on master, with its own AGENTS.md, CLAUDE.md, CI workflow, CODEOWNERS and settings ----
  {
    const settings = { permissions: { allow: ['Bash(make test)', 'Bash(pnpm check)'] }, model: 'opus' };
    const files = {
      'package.json':
        '{\n    "name": "tiles",\n    "scripts": { "build": "tsc", "check": "tsc --noEmit" },\n    "devDependencies": { "lefthook": "^1.0.0" }\n}\n',
      'pnpm-lock.yaml': "lockfileVersion: '9.0'\n",
      'AGENTS.md': '# Tiles\n\nOur own rules.\n',
      'CLAUDE.md': '# Tiles for Claude\n',
      CODEOWNERS: '* @acme/tiles\n',
      '.github/workflows/build.yml': 'name: CI\non: push\n',
      '.github/workflows/ci.yml': 'name: Lint\non: push\n',
      '.claude/settings.json': `${JSON.stringify(settings, null, 2)}\n`,
      '.gitignore': 'node_modules/\n',
      'README.md': '# Tiles\n',
      'docs/adr/0002-our-own-record.md': '# 0002. Ours\n',
      'coverage/keep.txt': 'tracked on purpose\n',
    };
    const root = repo(dir, files, 'master');
    const dry = run(KIT_ROOT, 'node', [ADOPT, root]);
    check(
      'adopt pnpm: the dry run writes nothing and says so',
      [
        dry.code,
        git(root, 'status', '--porcelain'),
        git(root, 'branch', '--show-current'),
        dry.out.split('\n').at(-1),
      ],
      [
        0,
        '',
        'master',
        `A dry run: nothing was written. --apply writes this on ${branchFor(kit.version)}, in one commit.`,
      ],
    );
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Tiles, edited\n');
    check(
      'adopt pnpm: a dirty working tree is refused, and nothing is written',
      [
        refusal(() => apply({ branch: branchFor(kit.version) }, root, { install: false })),
        git(root, 'status', '--porcelain'),
      ],
      ['the target has uncommitted changes; commit or stash them first', 'M AGENTS.md'],
    );
    git(root, 'checkout', '--quiet', '--', 'AGENTS.md');
    const a = adopt(kit, root, 'master');
    check(
      'adopt pnpm: the layout and the lint scope',
      [a.p.layout, a.p.scope, a.p.manager, a.p.install],
      ['root', 'all', null, true],
    );
    const ADR2 = 'docs/adr/0002-board-provider-adapters.md';
    check(
      'adopt pnpm: exactly these paths written',
      a.written,
      sorted(kitOwned([ADR2]), [
        '.claude/settings.json',
        '.gitignore',
        '.github/workflows/ci.yml.proposed',
        '.npmrc',
        'AGENTS.md.proposed',
        'CLAUDE.md.proposed',
        'CONTRIBUTING.md',
        'SECURITY.md',
        'TASKS.md',
        'biome.json',
        'docs/DECISIONS.md',
        'docs/adr/0001-build-with-agents-under-review.md',
        'docs/agents/project.md',
        'mise.toml',
        'package.json',
        REPORT,
      ]),
    );
    check('adopt pnpm: exactly these conflicts', conflicts(a.p), [
      `${ADR2}: the project's own docs/adr/0002-our-own-record.md has the same number`,
      '.github/workflows/ci.yml: the project has its own file at this path',
      'AGENTS.md: the project has its own file at this path',
      'CLAUDE.md: the project has its own file at this path',
      '.gitignore: the kit ignores coverage/, which would match files the project tracks (coverage/keep.txt…)',
      'package.json: the project has its own "check" script',
      'package.json: the project pins lefthook at ^1.0.0; the kit at ^2.1.14',
      ".github/workflows/build.yml: this workflow is called CI, the name ci:remote and ci:fetch find the kit's runs by",
    ]);
    check('adopt pnpm: only the merged files changed', a.changed, [
      '.claude/settings.json',
      '.gitignore',
      'package.json',
    ]);
    check(
      'adopt pnpm: the default branch, master, is untouched',
      a.defaultBranch[0] === a.defaultBranch[1],
      true,
    );
    const pkg = pkgOf(root);
    check(
      "adopt pnpm: the project's check stays, the kit's goes in beside it",
      [
        pkg.scripts.check,
        pkg.scripts['kit:check'],
        pkg.scripts.lint,
        pkg.scripts.build,
        pkg.devDependencies,
        'type' in pkg,
      ],
      [
        'tsc --noEmit',
        kit.pkg.scripts.check,
        kit.pkg.scripts.lint,
        'tsc',
        { lefthook: '^1.0.0', '@biomejs/biome': kit.pkg.devDependencies['@biomejs/biome'] },
        false,
      ],
    );
    check(
      'adopt pnpm: package.json keeps its four-space indent',
      fs.readFileSync(path.join(root, 'package.json'), 'utf8').startsWith('{\n    "name": "tiles",\n'),
      true,
    );
    const merged = pkgOf(root, '.claude/settings.json');
    const ours = JSON.parse(kit.files.get('.claude/settings.json'));
    check(
      "adopt pnpm: the settings are a union, the project's own keys kept",
      [merged.model, merged.permissions.allow, merged.permissions.deny, Object.keys(merged.hooks)],
      [
        'opus',
        [
          'Bash(make test)',
          'Bash(pnpm check)',
          ...ours.permissions.allow.filter((r) => r !== 'Bash(pnpm check)'),
        ],
        ours.permissions.deny,
        ['SessionStart', 'PreToolUse'],
      ],
    );
    check(
      "adopt pnpm: the kit's version is beside the project's own file, which is unchanged",
      [
        fs.readFileSync(path.join(root, 'AGENTS.md.proposed'), 'utf8') ===
          kit.files.get('AGENTS.md').toString(),
        fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'),
      ],
      [true, '# Tiles\n\nOur own rules.\n'],
    );
    check(
      'adopt pnpm: the report travels with the branch',
      fs.readFileSync(path.join(root, REPORT), 'utf8').split('\n')[0],
      `# Adopting the Factory Kit ${kit.version}`,
    );
    check(
      'adopt pnpm: the CODEOWNERS note is in the report',
      a.p.notes.includes(
        "The project has a CODEOWNERS file; the setup guide's first item is filed as an edit to it.",
      ),
      true,
    );
    // Until the project renumbers its own 0002, the kit's documents that cite the kit's 0002 say so.
    check('adopt pnpm: check-docs names only the record the number clash kept out', docsFailures(root), [
      `✗ cited path does not exist: docs/agents/issue-tracker.md → ${ADR2}`,
    ]);
    git(root, 'switch', '--quiet', 'master');
    check(
      'adopt pnpm: an existing adoption branch is refused',
      refusal(() => apply(a.p, root, { install: false })),
      `the branch ${branchFor(kit.version)} already exists in the target`,
    );
  }
}

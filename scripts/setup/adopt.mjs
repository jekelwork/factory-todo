#!/usr/bin/env node
// `pnpm kit:adopt <target> [--apply] [--no-install]`: bring the kit into a repository that already has a
// history of its own, run from a clone of the kit. The fresh start (README, "Start a project") assumes a
// clone of the kit; this is the other way in.
//
// The worst case cannot be undone: an adoption that overwrites or drops a project's own configuration lands
// on somebody's default branch, where nobody looks again. So the direction is fixed (docs/adr/0006):
//
// - **A dry run is the default.** It writes nothing and prints three lists: *copy* (kit files the target
//   lacks), *merge* (additive changes to a file the target has, each one shown) and *conflict* (what collides,
//   and the proposed resolution).
// - **Merges are additive only**: a script name, a devDependency, a `.gitignore` line, a hook or a permission
//   the target does not have, a `factoryKit` key. Anything else is a conflict. A file the rules cannot merge
//   stays as it is and the kit's version is written beside it as `<name>.proposed`.
// - **`--apply` writes on a new branch, `chore/adopt-factory-kit-<version>`, in one commit**, and never on the
//   default branch or the remote. It refuses a dirty working tree and an existing adoption branch.
//
// Which files are the kit's is read from the README's "Kit-owned and project-owned" lists, so a file added to
// those lists is adopted without a change here. That is also why this runs only from a kit clone: a project's
// README has no such lists.
//
// A Node project on npm or yarn keeps its manager. Two lockfiles in one package root each rewrite
// `node_modules` in their own layout, so the kit's tooling goes in a package of its own, `tools/factory-kit/`,
// with pnpm's lockfile, and `factoryKit.package` names it for the guard, CI and `ci:local`.
//
// Node built-ins only, like the rest of `scripts/`.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitEnv } from '../board/migrate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const KIT_ROOT = path.resolve(HERE, '../..');

/** Where the kit's tooling lives in a target whose own package manager is not pnpm. */
export const SUB_PACKAGE = 'tools/factory-kit';
export const REPORT = 'docs/factory-kit-adoption.md';
export const branchFor = (version) => `chore/adopt-factory-kit-${version}`;

// ---- the ownership lists ------------------------------------------------------------------------------------

/** The backticked paths of the README's two ownership paragraphs, as written. */
export function ownershipLists(readme) {
  const section = readme.split(/^## Kit-owned and project-owned\s*$/m)[1]?.split(/^## /m)[0] ?? '';
  const paragraph = (label) => {
    const m = section.match(new RegExp(`\\*\\*${label}:\\*\\*([\\s\\S]*?)(?:\\n\\s*\\n|$)`));
    return m ? [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]) : null;
  };
  return { kit: paragraph('Kit-owned'), project: paragraph('Project-owned') };
}

/**
 * The files a list names: a path, a directory, `dir/*` for everything under it, and `docs/adr/0001` for the
 * record of that number. `strict` makes a name that matches nothing an error: the kit list going stale.
 */
export function expand(names, tracked, { strict = false } = {}) {
  const out = new Set();
  for (const name of names) {
    const star = name.endsWith('*') ? name.slice(0, -1) : null;
    const hits = tracked.filter((f) =>
      star !== null
        ? f.startsWith(star)
        : f === name || f.startsWith(`${name}/`) || (/\/\d{4}$/.test(name) && f.startsWith(`${name}-`)),
    );
    if (!hits.length && strict)
      throw new Error(`the README's kit-owned list names ${name}, which is not here`);
    for (const f of hits) out.add(f);
  }
  return [...out].sort();
}

// Every git call runs without the caller's GIT_* variables: under a git hook (`pnpm check` is the pre-push
// hook) GIT_DIR would aim it at the repository that ran the hook rather than the target.
const git = (cwd, args, input) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv(), input });
  return { code: r.status ?? 1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
};

/** The kit as this clone has it: its version, its package.json, and every file of both lists. */
export function readKit(root = KIT_ROOT) {
  const read = (rel) => fs.readFileSync(path.join(root, rel));
  const pkg = JSON.parse(read('package.json'));
  const lists = ownershipLists(read('README.md').toString('utf8'));
  if (!lists.kit || !lists.project) {
    throw new Error('this is not a clone of the kit: its README has no "Kit-owned and project-owned" lists');
  }
  // Tracked files only: the clone's untracked work (a scratch script, a pasted token) is not the kit, and the
  // adoption commit skips the target's own hooks.
  // `--stage` for the modes too: the kit's executable files keep the bit, since lefthook sets it on a hook
  // script before running one, which would leave `.lefthook/pre-push/gates.sh` modified after every push.
  const index = git(root, ['ls-files', '--stage'])
    .out.split('\n')
    .filter(Boolean)
    .map((l) => ({ mode: l.split(' ')[0], path: l.split('\t')[1] }));
  const tracked = index.map((e) => e.path);
  const kitOwned = expand(lists.kit, tracked, { strict: true });
  // A project-owned file is the kit's starting point for it: copied where the target has none.
  const starters = expand(lists.project, tracked).filter((f) => !kitOwned.includes(f));
  const files = new Map(
    [...kitOwned, ...starters, '.gitignore', '.npmrc', 'pnpm-lock.yaml'].map((f) => [f, read(f)]),
  );
  const executable = new Set(index.filter((e) => e.mode === '100755').map((e) => e.path));
  return { root, version: pkg.version, pkg, kitOwned, starters, files, executable };
}

// ---- what the target has ------------------------------------------------------------------------------------

/** A file's bytes (or text, given an encoding), or null when there is none. */
const readOrNull = (root, rel, encoding) => {
  try {
    return fs.readFileSync(path.join(root, rel), encoding);
  } catch {
    return null;
  }
};
const listOrEmpty = (dir) => {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
};
const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const parseJson = (text) => {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? { value: v } : { error: 'not an object' };
  } catch (e) {
    return { error: e.message };
  }
};

const LOCKFILES = {
  'pnpm-lock.yaml': 'pnpm',
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'yarn.lock': 'yarn',
  'bun.lockb': 'bun',
  'bun.lock': 'bun',
};
const LINTERS = [
  [/^\.eslintrc(\..+)?$|^eslint\.config\.[cm]?[jt]s$/, 'ESLint'],
  [/^\.prettierrc(\..+)?$|^prettier\.config\.[cm]?[jt]s$/, 'Prettier'],
  [/^biome\.jsonc?$/, 'Biome'],
];

const JAVA = [
  '- uses: actions/setup-java@v4',
  '  with:',
  '    distribution: temurin',
  "    java-version: '21'",
];

/**
 * The native builds, as a table: the file that marks one at the top level, its gate (a wrapper script in
 * the repository preferred to a global tool), and the CI step that gives a runner its toolchain. `pnpm
 * check` runs the gate after the kit's own; the CI step is a recipe in the report, not written into a
 * workflow, because a project's workflow is its own.
 */
const STACKS = [
  {
    stack: 'Maven',
    marker: /^pom\.xml$/,
    gate: (has) => (has('mvnw') ? './mvnw -B verify' : 'mvn -B verify'),
    ci: JAVA,
  },
  {
    stack: 'Gradle',
    marker: /^build\.gradle(\.kts)?$/,
    gate: (has) => (has('gradlew') ? './gradlew check' : 'gradle check'),
    ci: JAVA,
  },
  {
    stack: '.NET',
    marker: /\.(sln|csproj)$/,
    // `dotnet test` alone refuses a folder holding more than one solution or project; one solution is named.
    gate: (_, names) => {
      const solutions = names.filter((n) => n.endsWith('.sln'));
      return solutions.length === 1 ? `dotnet test ${solutions[0]}` : 'dotnet test';
    },
    ci: ['- uses: actions/setup-dotnet@v4', '  with:', "    dotnet-version: '8.0.x'"],
  },
  {
    stack: 'Python',
    marker: /^pyproject\.toml$/,
    gate: () => 'uv run pytest',
    ci: ['- uses: astral-sh/setup-uv@v5'],
  },
];

/** The native builds among a repository's top-level names. Pure. */
export function nativeStacks(names) {
  const has = (n) => names.includes(n);
  return STACKS.flatMap(({ stack, marker, gate, ci }) => {
    const file = names
      .filter((n) => marker.test(n))
      .sort((a, b) => a.endsWith('.csproj') - b.endsWith('.csproj'))[0];
    return file ? [{ stack, file, gate: gate(has, names), ci }] : [];
  });
}

/** Everything the plan depends on, read once. Reads only. */
function detect(root) {
  const names = listOrEmpty(root);
  const pkgText = readOrNull(root, 'package.json', 'utf8');
  const parsed = pkgText === null ? {} : parseJson(pkgText);
  const pkg = parsed.value ?? null;
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const lockfiles = names.filter((n) => n in LOCKFILES);
  const manager = pkg?.packageManager?.split('@')[0] ?? (lockfiles.length ? LOCKFILES[lockfiles[0]] : null);
  const linters = [
    ...new Set([
      ...LINTERS.filter(([re]) => names.some((n) => re.test(n))).map(([, l]) => l),
      ...(deps.eslint || pkg?.eslintConfig ? ['ESLint'] : []),
      ...(deps.prettier || pkg?.prettier ? ['Prettier'] : []),
    ]),
  ];
  const namedCi = listOrEmpty(path.join(root, '.github/workflows'))
    .filter((n) => /\.ya?ml$/.test(n))
    .map((n) => `.github/workflows/${n}`)
    .filter((f) => /^name:\s*['"]?CI['"]?\s*$/m.test(readOrNull(root, f, 'utf8') ?? ''));
  // A global core.hooksPath is the developer's machine, not the repository.
  const hooksPath = git(root, ['config', '--local', '--get', 'core.hooksPath']).out;
  const hookManager =
    exists(root, '.husky') || pkg?.husky
      ? 'Husky'
      : exists(root, '.pre-commit-config.yaml')
        ? 'pre-commit'
        : hooksPath
          ? `core.hooksPath (${hooksPath})`
          : null;
  return {
    commits: Number(git(root, ['rev-list', '--count', 'HEAD']).out || 0),
    branch: git(root, ['branch', '--show-current']).out,
    pkg,
    pkgText,
    pkgError: parsed.error ?? null,
    manager,
    lockfiles,
    linters,
    hookManager,
    namedCi,
    hasCodeowners: ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'].some((f) => exists(root, f)),
    hasToolVersions: exists(root, '.tool-versions'),
    native: nativeStacks(names),
    adrs: listOrEmpty(path.join(root, 'docs/adr')),
  };
}

// ---- the plan -----------------------------------------------------------------------------------------------

const sha = (data) => `sha256:${createHash('sha256').update(data).digest('hex')}`;
const indentOf = (text) => text?.match(/^[{[]\r?\n([ \t]+)/)?.[1] ?? '  ';
const json = (value, like) => `${JSON.stringify(value, null, indentOf(like))}\n`;
const BIOME_FILES = /\.(ts|tsx|mts|js|mjs|cjs|json|jsonc|css|html)$/;
const MERGE_BY_HAND = 'Merge what the project needs from it by hand.';

/**
 * The plan for one target: every file to write and why, every conflict, and the commit's details. Pure but
 * for reading the target. `writes` maps a path to its new content; `copy`, `merge` and `conflict` are the
 * three lists the dry run prints.
 *
 * A path the target's own ignore rules hide is not written: `git add` refuses it, and the rule may be the
 * project's on purpose. So the plan is drafted, the paths it writes checked, and drafted again without the
 * hidden ones, which also keeps them out of the manifest and the copy and merge lists.
 */
export function plan(kit, root) {
  const first = draft(kit, root, new Map());
  const ignored = ignoredIn(root, [...first.writes.keys(), ...(first.report ? [first.report] : [])]);
  return ignored.size ? draft(kit, root, ignored) : first;
}

/**
 * Which of these paths the target's ignore rules hide from `git add`, each with the rule that does:
 * `{ source, line, pattern }`. A tracked file is not hidden, and outside a repository nothing is.
 */
export function ignoredIn(root, paths) {
  const hidden = new Map();
  if (!paths.length) return hidden;
  const r = git(root, ['check-ignore', '--verbose', '--stdin'], paths.join('\n'));
  for (const row of r.code === 0 ? r.out.split('\n') : []) {
    const m = /^(.*):(\d+):(.*)\t(.*)$/.exec(row);
    // --verbose names a negation that matched too, and a negated path is not ignored.
    if (m && !m[3].startsWith('!')) hidden.set(m[4], { source: m[1], line: Number(m[2]), pattern: m[3] });
  }
  return hidden;
}

/** The conflicts for the hidden paths, one per rule that hides them. */
function hiddenConflicts(ignored) {
  const byRule = new Map();
  for (const [f, { source, line, pattern }] of ignored) {
    const key = `${source}:${line}:${pattern}`;
    if (!byRule.has(key)) byRule.set(key, { source, line, pattern, paths: [] });
    byRule.get(key).paths.push(f);
  }
  return [...byRule.values()].map(({ source, line, pattern, paths }) => {
    paths.sort();
    // A global excludes file is the developer's machine: named, not cited, and its path not committed.
    const global = path.isAbsolute(source);
    return {
      path: global ? 'the global ignore file (core.excludesFile)' : source,
      absent: global || source.startsWith('.git/'),
      what: `line ${line}, ${pattern}, hides ${paths.length === 1 ? 'a path' : `${paths.length} paths`} the kit writes (${paths[0]}${paths.length === 1 ? '' : '…'})`,
      proposal: `Not written, since git add refuses an ignored path. If the kit's files belong in the repository, add a negation for them (for example !${paths[0]}) and run the adoption again.`,
    };
  });
}

function draft(kit, root, ignored) {
  const found = detect(root);
  // A new package.json, the project's own pnpm root, or a package of the kit's own beside npm or yarn.
  const layout =
    found.pkgText === null ? 'new' : ['npm', 'yarn', 'bun'].includes(found.manager) ? 'sub' : 'root';
  // Biome and check-docs cover only the kit's files when the project lints itself, or is not JavaScript
  // (no package.json, or a native build beside one, as a Java service with a front end has).
  const scope = found.linters.length || !found.pkg || found.native.length ? 'kit' : 'all';
  const manager = found.hookManager;
  const out = { writes: new Map(), executable: new Set(), copy: [], merge: [], conflict: [] };
  /** Writes a path unless the target ignores it; says whether it did. */
  out.write = (f, data) => !ignored.has(f) && Boolean(out.writes.set(f, data));
  out.add = (f, data) => out.write(f, data) && Boolean(out.copy.push(f));
  const { writes, merge, conflict } = out;
  const manifest = {};
  const kitText = (f) => kit.files.get(f).toString('utf8');
  // `<name>.proposed` is a path like any other: the project may have its own there.
  const propose = (file, data, what, proposal) => {
    const beside = `${file}.proposed`;
    const theirs = readOrNull(root, beside);
    const there = theirs === null ? out.write(beside, data) : theirs.equals(Buffer.from(data));
    conflict.push({
      path: file,
      what,
      proposal: there
        ? `${proposal} The kit's version is beside it as ${beside}.`
        : theirs === null
          ? `${proposal} The project ignores ${beside}, so the kit's version is not written beside it.`
          : `${proposal} The project has its own ${beside}, so the kit's version is not written beside it.`,
    });
  };

  // A record numbered like one of the project's own would make two records of one number (check-docs).
  const taken = new Map(found.adrs.map((n) => [n.slice(0, 5), n]).filter(([k]) => /^\d{4}-$/.test(k)));
  /** A file the kit has: copied when absent, left when identical, proposed beside when different. */
  const place = (f, data, { kitOwned = false, proposal = MERGE_BY_HAND } = {}) => {
    if (ignored.has(f)) return;
    const name = f.startsWith('docs/adr/') ? path.basename(f) : null;
    const clash = name && taken.get(name.slice(0, 5));
    if (clash && clash !== name) {
      conflict.push({
        path: f,
        absent: true,
        what: `the project's own docs/adr/${clash} has the same number`,
        proposal: "Not copied. Renumber one of the two records, then copy the kit's by hand.",
      });
      return;
    }
    const theirs = readOrNull(root, f);
    if (theirs === null) {
      if (out.add(f, data) && kit.executable.has(f)) out.executable.add(f);
    } else if (!theirs.equals(Buffer.from(data))) {
      propose(f, data, 'the project has its own file at this path', proposal);
      return;
    }
    if (kitOwned) manifest[f] = sha(data);
  };
  out.place = place;

  // lefthook.yml too under another hook manager: copied, so the kit's files read the same everywhere and
  // its documents resolve, but not installed, because nothing wires it to `prepare`.
  for (const f of kit.kitOwned) {
    place(f, kit.files.get(f), {
      kitOwned: true,
      proposal:
        "Kit-owned files read the same in every kit repository: merge the two, or move the project's elsewhere.",
    });
  }

  // ---- the project-owned starting points ----
  const SPECIAL = new Set(['package.json', '.claude/settings.json', 'biome.json']);
  const STARTER_PROPOSALS = {
    'AGENTS.md':
      'Insert the kit\'s "## Ground rules" section, its rules marked *(kit)*, and the "## The work-item board" section into the project\'s AGENTS.md. The setup guide\'s "Your project" step stays open until the *(kit)* rules are there.',
    'CLAUDE.md':
      "Make the project's CLAUDE.md import AGENTS.md (a line reading @AGENTS.md), so Claude Code reads the kit's rules, and keep only Claude Code specifics below it.",
  };
  for (const f of kit.starters) {
    if (SPECIAL.has(f)) continue;
    place(f, kit.files.get(f), {
      kitOwned: false,
      proposal: STARTER_PROPOSALS[f] ?? MERGE_BY_HAND,
    });
  }
  place(layout === 'sub' ? `${SUB_PACKAGE}/.npmrc` : '.npmrc', kit.files.get('.npmrc'), {
    kitOwned: false,
    proposal: "Add the kit's two settings to it.",
  });

  // ---- biome.json: the kit's, covering only the kit's files when the project lints itself ----
  const biome = JSON.parse(kitText('biome.json'));
  if (scope === 'kit') {
    biome.files.includes = Object.keys(manifest).filter((f) => BIOME_FILES.test(f));
  }
  place('biome.json', json(biome, kitText('biome.json')), {
    kitOwned: false,
    proposal: "The project already configures Biome. Make it cover the kit's files with the kit's settings.",
  });

  // ---- .gitignore: the kit's lines the target lacks, unless one would hide a file the project tracks ----
  {
    const theirs = readOrNull(root, '.gitignore', 'utf8');
    if (theirs === null) out.add('.gitignore', kit.files.get('.gitignore'));
    else {
      const have = new Set(theirs.split(/\r?\n/).map((l) => l.trim()));
      const lines = kitText('.gitignore')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('#') && !have.has(l));
      const tracked = (patterns) =>
        patterns.length
          ? git(root, ['ls-files', '--cached', '--ignored', ...patterns.map((l) => `--exclude=${l}`)]).out
          : '';
      // One git call for every line; one per line only when that finds a tracked file, to say which line.
      const patterns = lines.filter((l) => !l.startsWith('!'));
      const hiding = tracked(patterns) ? patterns.filter((l) => tracked([l])) : [];
      for (const line of hiding) {
        conflict.push({
          path: '.gitignore',
          what: `the kit ignores ${line}, which would match files the project tracks (${tracked([line]).split('\n')[0]}…)`,
          proposal: 'Not added. Add it by hand if the project does not mean to track them.',
        });
      }
      const add = lines.filter((l) => !hiding.includes(l));
      if (
        add.length &&
        out.write('.gitignore', `${theirs.replace(/\n*$/, '\n')}\n# Factory Kit\n${add.join('\n')}\n`)
      ) {
        merge.push({ path: '.gitignore', changes: add.map((l) => `added ${l}`) });
      }
    }
  }

  // ---- .claude/settings.json: a union of hooks and permissions ----
  {
    const ours = JSON.parse(kitText('.claude/settings.json'));
    // On npm or yarn the project's own `npm install` is its workflow; the guard refuses it only inside the
    // kit's package (factoryKit.package), and a deny rule cannot tell where a command runs.
    if (layout === 'sub') ours.permissions.deny = ours.permissions.deny.filter((r) => !/^Bash\(npm /.test(r));
    const text = readOrNull(root, '.claude/settings.json', 'utf8');
    const theirs = text === null ? null : parseJson(text).value;
    if (text === null) out.add('.claude/settings.json', json(ours));
    else if (!theirs) {
      propose(
        '.claude/settings.json',
        json(ours),
        'it is not valid JSON',
        "Merge the kit's hooks and permissions into it.",
      );
    } else {
      const changes = unionSettings(theirs, ours);
      if (changes.length && out.write('.claude/settings.json', json(theirs, text))) {
        merge.push({ path: '.claude/settings.json', changes });
      }
    }
  }

  // ---- package.json ----
  const factoryKit = {
    kit: kit.version,
    ...(scope === 'kit' ? { lint: 'kit' } : {}),
    ...(layout === 'sub' ? { package: SUB_PACKAGE } : {}),
    manifest,
  };
  const install = packageJson(kit, root, found, { layout, manager, factoryKit }, out);

  // ---- what the target already has that the kit cannot merge ----
  if (manager) {
    hookGates(
      root,
      manager,
      {
        hooks: lefthookHooks(kitText('lefthook.yml')),
        lefthook: layout === 'sub' ? `${SUB_PACKAGE}/node_modules/.bin/lefthook` : 'pnpm exec lefthook',
      },
      out,
    );
  }
  for (const f of found.namedCi.filter((f) => f !== '.github/workflows/ci.yml')) {
    conflict.push({
      path: f,
      what: "this workflow is called CI, the name ci:remote and ci:fetch find the kit's runs by",
      proposal: "Rename it, or the kit's CI scripts read its runs as theirs.",
    });
  }
  // The report goes on the branch only where the project has no file of its own.
  const reportAt = readOrNull(root, REPORT) === null && !ignored.has(REPORT) ? REPORT : null;
  if (!reportAt && !ignored.has(REPORT)) {
    conflict.push({
      path: REPORT,
      what: 'the project has its own file at this path',
      proposal: 'The report is not written on the branch; the dry run printed it.',
    });
  }
  conflict.push(...hiddenConflicts(ignored));
  const notes = found.native.map(
    (n) =>
      `A ${n.stack} build (${n.file}): \`pnpm check\` runs \`${n.gate}\` after the kit's gates, and Biome and check-docs cover only the kit's files.`,
  );
  if (found.hasCodeowners) {
    notes.push("The project has a CODEOWNERS file; the setup guide's first item is filed as an edit to it.");
  }
  if (found.hasToolVersions) {
    notes.push('The project pins tools in .tool-versions; mise reads it beside mise.toml.');
  }
  if (scope === 'all') {
    notes.push('Biome now lints the whole repository; `pnpm lint:fix` applies its formatting.');
  }
  if (layout === 'sub') {
    notes.push(
      `CI's setup action installs only ${SUB_PACKAGE}; a job that runs the project's own scripts needs its \`${found.manager} install\` step as well.`,
    );
  }

  return {
    version: kit.version,
    branch: branchFor(kit.version),
    subject: `chore: adopt the Factory Kit ${kit.version}`,
    found,
    layout,
    scope,
    manager,
    writes,
    executable: out.executable,
    copy: out.copy,
    merge,
    conflict,
    notes,
    install,
    report: reportAt,
  };
}

// ---- the kit's git gates under another hook manager ------------------------------------------------------

/** The hooks lefthook.yml defines, in its order: its top-level keys. */
export function lefthookHooks(text) {
  return [...text.matchAll(/^([\w-]+):\s*$/gm)].map((m) => m[1]);
}

export const MARK = '# Factory Kit gates (pnpm kit:adopt): lefthook runs what lefthook.yml says';

/** A text with a block of lines after it, a blank line between. */
const appendBlock = (theirs, lines) => `${theirs.replace(/\n*$/, '\n')}\n${lines.join('\n')}\n`;

/**
 * The kit's gates added to the hook manager the project already has, rather than lefthook beside it: two
 * managers overwrite each other's hooks. Each of the manager's hooks hands over to `lefthook run <hook>`, so
 * lefthook.yml stays the one statement of the gates, its globs, staged files and `stage_fixed` included,
 * and a gate added there later reaches the project with nothing else to change. `--no-auto-install` keeps
 * lefthook from installing its own hooks over the manager's. Husky's hook files get the line appended;
 * pre-commit gets a `repo: local` entry per hook; anything else is reported with the line to add.
 */
export function hookGates(root, manager, { hooks, lefthook }, out) {
  const runs = (hook, args = '') => `mise exec -- ${lefthook} run ${hook} --no-auto-install${args}`;
  if (manager === 'Husky' && exists(root, '.husky')) {
    for (const hook of hooks) {
      const rel = `.husky/${hook}`;
      const theirs = readOrNull(root, rel, 'utf8');
      // git hands commit-msg the message file, and pre-push the remote's name and URL, which the pre-push
      // gates need to know which remote's objects a push is measured against (#34).
      const args = { 'commit-msg': ' "$1"', 'pre-push': ' "$@"' }[hook] ?? '';
      const block = [MARK, runs(hook, args)];
      // Husky 5 to 8 point core.hooksPath at .husky, so git runs the file itself, and skips it unless it is
      // executable. Husky 9 runs it through sh, where the shebang is a comment.
      if (theirs === null) {
        if (out.add(rel, `#!/usr/bin/env sh\n${block.join('\n')}\n`)) out.executable.add(rel);
      } else if (!theirs.includes(MARK) && out.write(rel, appendBlock(theirs, block))) {
        out.merge.push({ path: rel, changes: [`appended: ${block[1]}`] });
      }
    }
    return;
  }
  const entries = (indent) => [
    `${indent}${MARK}`,
    `${indent}- repo: local`,
    `${indent}  hooks:`,
    ...hooks.flatMap((hook) => [
      `${indent}    - id: factory-kit-${hook}`,
      `${indent}      name: Factory Kit ${hook}`,
      `${indent}      entry: ${runs(hook)}`,
      `${indent}      language: system`,
      `${indent}      stages: [${hook}]`,
      // pre-commit hands a commit-msg hook the message file; lefthook finds the staged files itself.
      ...(hook === 'commit-msg'
        ? []
        : [`${indent}      pass_filenames: false`, `${indent}      always_run: true`]),
    ]),
  ];
  if (manager === 'pre-commit') {
    const rel = '.pre-commit-config.yaml';
    const theirs = readOrNull(root, rel, 'utf8');
    const keys = [...theirs.matchAll(/^([\w-]+):/gm)].map((m) => m[1]);
    const item = /^repos:\s*\n(?:\s*#.*\n)*([ ]*)- /m.exec(theirs);
    // Appending is safe only while `repos:` is the last top-level key and its list is in block style.
    if (keys.at(-1) !== 'repos' || !item) {
      out.conflict.push({
        path: rel,
        what: "`repos:` is not the file's last key, or not a block list, so the kit's hooks cannot be appended to it",
        proposal: `Add this to its repos:\n${entries('  ').join('\n')}`,
      });
      return;
    }
    const block = entries(item[1]);
    const changes = [`added a local repo that runs lefthook for ${hooks.join(', ')}`];
    if (!keys.includes('default_install_hook_types')) {
      block.push(`default_install_hook_types: [${hooks.join(', ')}]`);
      changes.push(`added default_install_hook_types: ${hooks.join(', ')}`);
    } else {
      out.conflict.push({
        path: rel,
        what: 'it sets default_install_hook_types already',
        proposal: `Make sure it holds ${hooks.join(', ')}, or the kit's commit-msg and pre-push gates never run.`,
      });
    }
    if (out.write(rel, appendBlock(theirs, block))) out.merge.push({ path: rel, changes });
    return;
  }
  out.conflict.push({
    path: manager === 'Husky' ? 'package.json' : '.git/config',
    what: `the project's hooks are run by ${manager}, which the kit cannot add to`,
    proposal: `Nothing runs lefthook install, since two hook managers overwrite each other's hooks. Make each of the project's ${hooks.join(', ')} hooks also run: ${runs('<hook>')}.`,
  });
}

/** Adds the kit's hooks and permissions `theirs` lacks, in place. Returns what changed, one line each. */
function unionSettings(theirs, ours) {
  const changes = [];
  theirs.hooks ??= {};
  for (const [event, groups] of Object.entries(ours.hooks ?? {})) {
    theirs.hooks[event] ??= [];
    const have = theirs.hooks[event];
    for (const group of groups) {
      const match = have.find((g) => (g.matcher ?? '') === (group.matcher ?? ''));
      if (!match) {
        have.push(structuredClone(group));
        changes.push(`added the ${event} hooks for "${group.matcher ?? ''}"`);
        continue;
      }
      match.hooks ??= [];
      for (const hook of group.hooks) {
        if (match.hooks.some((h) => h.command === hook.command)) continue;
        match.hooks.push(structuredClone(hook));
        changes.push(`added a ${event} hook for "${group.matcher ?? ''}": ${hook.command}`);
      }
    }
  }
  for (const list of ['allow', 'deny']) {
    const rules = ours.permissions?.[list] ?? [];
    if (!rules.length) continue;
    theirs.permissions ??= {};
    theirs.permissions[list] ??= [];
    const have = theirs.permissions[list];
    const add = rules.filter((r) => !have.includes(r));
    have.push(...add);
    if (add.length) changes.push(`${list}: ${add.join(', ')}`);
  }
  return changes;
}

/**
 * The kit's scripts, devDependencies and `factoryKit` record in the target's package.json, and on npm or
 * yarn the kit's own package beside it. Returns whether `pnpm install` has to produce the lockfile.
 */
function packageJson(kit, root, found, { layout, manager, factoryKit }, out) {
  const { merge, conflict } = out;
  const kitScripts = { ...kit.pkg.scripts };
  // A native build's gates run after the kit's, so `pnpm check` is the one gate it has always been.
  const gates = found.native.map((n) => n.gate);
  if (gates.length) kitScripts.check = [kitScripts.check, ...gates].join(' && ');
  // Another hook manager keeps its job, so `prepare` does not install lefthook. The devDependency stays:
  // pnpm runs no dependency's install script unasked, and with it the kit's lockfile still fits.
  if (manager) delete kitScripts.prepare;
  const devDependencies = { ...kit.pkg.devDependencies };
  const lock = kit.files.get('pnpm-lock.yaml');

  if (layout === 'new') {
    // No package.json: the kit's own, without what describes the kit itself ("type" would change how every
    // .js file in the project loads). Its dependencies are exactly the kit's, so the kit's lockfile is theirs.
    const pkg = {
      name: path
        .basename(root)
        .toLowerCase()
        .replace(/[^a-z0-9._-]/g, '-'),
      private: true,
      packageManager: kit.pkg.packageManager,
      engines: kit.pkg.engines,
      scripts: kitScripts,
      devDependencies,
      factoryKit,
    };
    out.add('package.json', json(pkg));
    out.place('pnpm-lock.yaml', lock);
    return false;
  }
  if (!found.pkg) {
    conflict.push({
      path: 'package.json',
      what: `it is not valid JSON (${found.pkgError})`,
      proposal: 'Fix it, then run the adoption again.',
    });
    return false;
  }
  if (found.pkg.factoryKit?.kit) {
    throw new Error(
      `the target already adopted the Factory Kit ${found.pkg.factoryKit.kit}; syncing is not built`,
    );
  }

  const pkg = structuredClone(found.pkg);
  const changes = [];
  pkg.scripts ??= {};
  const scripts = pkg.scripts;
  let wanted = kitScripts;

  if (layout === 'sub') {
    // The kit's package: its dependencies and the scripts that need them, run from the repository's root.
    // Not `audit:prod`: it would audit only the kit's two tools, and the project audits with its own manager.
    const free = {};
    const tooling = {};
    for (const [name, cmd] of Object.entries(kitScripts)) {
      if (/^node\s/.test(cmd)) free[name] = cmd;
      else if (name !== 'audit:prod') {
        tooling[name] = `cd ../.. && ${cmd.replace(/\bpnpm run (\S+)/g, `pnpm --dir ${SUB_PACKAGE} run $1`)}`;
      }
    }
    const sub = {
      name: 'factory-kit-tooling',
      private: true,
      packageManager: kit.pkg.packageManager,
      scripts: tooling,
      devDependencies,
    };
    out.place(`${SUB_PACKAGE}/package.json`, json(sub));
    out.place(`${SUB_PACKAGE}/pnpm-lock.yaml`, lock);
    // At the root: what runs without an install, and a `check` and `lint:staged` that reach into the package.
    wanted = {
      ...free,
      // Its check already runs the native gates (kitScripts.check), from the repository's root.
      check: `pnpm --dir ${SUB_PACKAGE} run check`,
      ...(kitScripts['lint:staged'] && {
        'lint:staged': kitScripts['lint:staged'].replace(
          /^biome\b/,
          `${SUB_PACKAGE}/node_modules/.bin/biome`,
        ),
      }),
    };
  }

  // A script name the project uses for something else: the kit's goes in as `kit:<name>`, and the kit's
  // scripts that call it follow. `check`, `lint` and `prepare` stay the project's when it has them.
  const taken = (name) => name in scripts && scripts[name] !== wanted[name];
  const as = (name) => (taken(name) ? `kit:${name}` : name);
  const rewrite = (cmd) =>
    cmd.replace(/\bpnpm run (\S+)/g, (m, s) => (s in wanted ? `pnpm run ${as(s)}` : m));
  for (const [name, cmd] of Object.entries(wanted)) {
    if (!taken(name)) {
      if (!(name in scripts)) {
        scripts[name] = rewrite(cmd);
        changes.push(`added the script "${name}": ${scripts[name]}`);
      }
      continue;
    }
    // A hook calls `check` and `lint:staged` by name, and lefthook.yml is kit-owned, so it is not rewritten.
    const proposal = {
      prepare: `Run both: "${scripts.prepare} && ${cmd}".`,
      check: `Run the kit's gates from it: "${scripts.check} && pnpm run kit:check". The pre-push hook and CI run "check".`,
      'lint:staged': `lefthook.yml's pre-commit hook runs "pnpm run lint:staged --write <staged files>", which is now the project's "${scripts[name]}" rather than Biome. Rename the project's script, then rename "kit:lint:staged" to "lint:staged".`,
    }[name];
    if (name === 'prepare' || name.startsWith('kit:') || as(name) in scripts) {
      conflict.push({
        path: 'package.json',
        what: `the project's "${name}" script is "${scripts[name]}"; the kit's is "${cmd}"`,
        proposal: proposal ?? 'Rename one of them.',
      });
      continue;
    }
    scripts[as(name)] = rewrite(cmd);
    changes.push(`added the script "${as(name)}": ${scripts[as(name)]}`);
    if (proposal)
      conflict.push({ path: 'package.json', what: `the project has its own "${name}" script`, proposal });
  }

  let install = false;
  if (layout === 'root') {
    pkg.devDependencies ??= {};
    for (const [dep, spec] of Object.entries(devDependencies)) {
      const theirs = found.pkg.dependencies?.[dep] ?? found.pkg.devDependencies?.[dep];
      if (theirs === undefined) {
        pkg.devDependencies[dep] = spec;
        changes.push(`added the devDependency ${dep} ${spec}`);
        install = true;
      } else if (theirs !== spec) {
        conflict.push({
          path: 'package.json',
          what: `the project pins ${dep} at ${theirs}; the kit at ${spec}`,
          proposal: 'Left as the project has it. The kit is tested against its own.',
        });
      }
    }
    if (!pkg.packageManager) {
      pkg.packageManager = kit.pkg.packageManager;
      changes.push(`added "packageManager": "${kit.pkg.packageManager}"`);
    } else if (pkg.packageManager !== kit.pkg.packageManager) {
      conflict.push({
        path: 'package.json',
        what: `the project uses ${pkg.packageManager}; the kit ${kit.pkg.packageManager}`,
        proposal: 'Left as the project has it.',
      });
    }
    if (!found.lockfiles.includes('pnpm-lock.yaml')) install = true;
  }
  pkg.factoryKit = { ...pkg.factoryKit, ...factoryKit };
  changes.push(
    `added "factoryKit": the kit version ${factoryKit.kit} and a hash of each of its ${Object.keys(factoryKit.manifest).length} files`,
  );
  if (out.write('package.json', json(pkg, found.pkgText))) merge.push({ path: 'package.json', changes });
  return install;
}

// ---- the report ---------------------------------------------------------------------------------------------

const code = (s) => `\`${s}\``;

/** The plan in words: the dry run's output, and with `--apply` the report committed on the branch. */
function report(p, { markdown = false } = {}) {
  const f = p.found;
  const head = (s) => (markdown ? `## ${s}` : `${s}:`);
  const li = (s) => (markdown ? `- ${s}` : `  ${s}`);
  const at = (s) => (markdown ? code(s) : s);
  const lines = [];
  if (markdown) {
    lines.push(
      `# Adopting the Factory Kit ${p.version}`,
      '',
      `Written by ${code('pnpm kit:adopt')} on the branch ${code(p.branch)}, in the commit "${p.subject}". It changed nothing outside the lists below. Settle each conflict in the pull request, then delete this file.`,
      '',
    );
  }
  lines.push(head('Found'));
  lines.push(li(`${f.commits} commit${f.commits === 1 ? '' : 's'} on ${f.branch || 'a detached HEAD'}`));
  lines.push(
    li(
      {
        new: 'no package.json: the kit brings one, with its own lockfile',
        root: `a Node project on ${f.manager ?? 'no declared manager'}: the kit's tooling joins its package.json`,
        sub: `a Node project on ${f.manager}: the kit's tooling goes in ${at(SUB_PACKAGE)}, with pnpm's lockfile, and the project keeps ${f.manager}`,
      }[p.layout],
    ),
  );
  if (f.linters.length) lines.push(li(`its own linting: ${f.linters.join(', ')}`));
  lines.push(
    li(
      p.scope === 'kit'
        ? "Biome and check-docs cover only the kit's files (factoryKit.lint)"
        : 'Biome and check-docs cover the whole repository',
    ),
  );
  if (p.manager) lines.push(li(`git hooks run by ${p.manager}`));
  for (const n of p.notes) lines.push(li(n));
  lines.push('', head(`Copy (${p.copy.length})`), ...p.copy.map((c) => li(at(c))));
  lines.push('', head(`Merge (${p.merge.length})`));
  for (const m of p.merge)
    lines.push(li(`${at(m.path)}:`), ...m.changes.map((c) => (markdown ? `  - ${c}` : `    ${c}`)));
  lines.push('', head(`Conflict (${p.conflict.length})`));
  // A path the branch does not bring is named, not cited: check-docs would read a citation as a claim.
  for (const c of p.conflict) lines.push(li(`${c.absent ? c.path : at(c.path)}: ${c.what}. ${c.proposal}`));
  if (!p.conflict.length) lines.push(li('none'));
  lines.push('', head('Next'));
  if (p.install)
    lines.push(
      li('`pnpm install` produces the lockfile for the new devDependencies; commit it on the branch.'),
    );
  if (p.layout === 'sub') {
    // Reported, not written into the project's `prepare`: that script is the project's own.
    const install = `mise exec -- pnpm --dir ${SUB_PACKAGE} install`;
    const prepare = [f.pkg?.scripts?.prepare, `${install} --frozen-lockfile`].filter(Boolean).join(' && ');
    lines.push(
      li(
        `Install the kit's package, which the git hooks and ${code('check')} run from: ${code(install)}. Every developer needs it once, after the project's own ${code(`${f.manager} install`)}; until then the hooks and ${code('check')} fail on a missing lefthook or Biome. For ${code(`${f.manager} install`)} to bring it, make the project's ${code('prepare')} run it as well: ${code(`"prepare": "${prepare}"`)}.`,
      ),
    );
  }
  for (const n of f.native) {
    // The fence keeps the recipe out of check-docs' sight and keeps its indentation.
    const step = markdown
      ? ['  ```yaml', ...n.ci.map((l) => `  ${l}`), '  ```']
      : n.ci.map((l) => `      ${l}`);
    lines.push(
      li(
        `CI for ${n.stack}: give each job in ${at('.github/workflows/ci.yml')} that runs \`check\` its toolchain, after the ${code('./.github/actions/setup')} step (pin the action by its commit, as the kit's own setup action does):`,
      ),
      ...step,
    );
  }
  lines.push(
    li(`Push the branch and open a pull request: ${code(`git push -u origin ${p.branch}`)}.`),
    li(
      `After merging, ${code('pnpm kit:setup')} takes the project through the board, the lock on the default branch and the start-project interview.`,
    ),
  );
  return `${lines.join('\n')}\n`;
}

// ---- applying it --------------------------------------------------------------------------------------------

/**
 * Writes the plan on its branch in one commit. Refuses rather than writes over anything: everything it can
 * check is checked before the target is touched, and a step that still fails puts the target back on the
 * branch it was on, with the files and the adoption branch gone.
 */
export function apply(p, root, { install = true, env = process.env } = {}) {
  if (git(root, ['status', '--porcelain']).out) {
    throw new Error('the target has uncommitted changes; commit or stash them first');
  }
  if (git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${p.branch}`]).code === 0) {
    throw new Error(`the branch ${p.branch} already exists in the target`);
  }
  const files = new Map(p.writes);
  if (p.report) files.set(p.report, report(p, { markdown: true }));
  const paths = [...files.keys()];
  // The plan was made from what the target had; a path it copies to must still be free, and none ignored.
  const taken = p.copy.filter((f) => exists(root, f));
  const hidden = [...ignoredIn(root, paths).keys()];
  if (taken.length || hidden.length) {
    throw new Error(
      `the target changed since the plan (${taken.length ? `${taken[0]} exists` : `${hidden[0]} is ignored`}); run the dry run again`,
    );
  }
  const from = git(root, ['branch', '--show-current']).out || git(root, ['rev-parse', 'HEAD']).out;
  const created = [...paths, 'pnpm-lock.yaml'].filter((f) => !exists(root, f));
  const made = git(root, ['switch', '--quiet', '-c', p.branch]);
  if (made.code !== 0) throw new Error(`could not create ${p.branch}: ${made.err}`);
  try {
    return commitOnBranch(p, root, files, { install, env });
  } catch (e) {
    // The tree was clean, so a hard reset restores every tracked file; what the plan created goes by name.
    git(root, ['reset', '--quiet', '--hard']);
    for (const f of created) {
      fs.rmSync(path.join(root, f), { force: true });
      // The directories it made, deepest first, while they are empty (a sibling may have emptied one).
      for (let d = path.dirname(f); d !== '.'; d = path.dirname(d)) {
        const full = path.join(root, d);
        if (!fs.existsSync(full)) continue;
        if (listOrEmpty(full).length) break;
        fs.rmdirSync(full);
      }
    }
    git(root, ['switch', '--quiet', ...(/^[0-9a-f]{40,64}$/.test(from) ? ['--detach'] : []), from]);
    git(root, ['branch', '--quiet', '-D', p.branch]);
    throw new Error(`${e.message}; nothing was kept, and the target is on ${from} again`);
  }
}

function commitOnBranch(p, root, files, { install, env }) {
  for (const [rel, data] of files) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), data);
    if (p.executable?.has(rel)) fs.chmodSync(path.join(root, rel), 0o755);
  }
  const paths = [...files.keys()];
  let installed = false;
  if (p.install && install) {
    const r = spawnSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
      env,
    });
    installed = r.status === 0;
    if (installed) paths.push('pnpm-lock.yaml');
  }
  const add = git(root, ['add', '--', ...paths]);
  if (add.code !== 0) throw new Error(`git add failed: ${add.err}`);
  // The index too, where core.fileMode is false (Windows) and the mode on disk is not read.
  if (p.executable?.size) {
    const x = git(root, ['update-index', '--chmod=+x', '--', ...p.executable]);
    if (x.code !== 0) throw new Error(`git update-index failed: ${x.err}`);
  }
  // The project's own hooks are not the kit's gates yet, and may lint the kit's files by other rules; the
  // pull request's CI runs them. --no-verify is why this commit is never on the default branch.
  const commit = git(root, [
    'commit',
    '--quiet',
    '--no-verify',
    '-m',
    p.subject,
    '-m',
    p.report ? `Written by pnpm kit:adopt. The report is ${p.report}.` : 'Written by pnpm kit:adopt.',
  ]);
  if (commit.code !== 0) throw new Error(`git commit failed: ${commit.err}`);
  return { paths: paths.sort(), installed };
}

// ---- the command --------------------------------------------------------------------------------------------

function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  if (args.length !== 1) {
    console.error('usage: pnpm kit:adopt <target repository> [--apply] [--no-install]');
    return 2;
  }
  // pnpm runs a script from the package root; the path was typed relative to where the person was.
  const target = path.resolve(process.env.INIT_CWD ?? process.cwd(), args[0]);
  const top = git(target, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || fs.realpathSync(top.out) !== fs.realpathSync(target)) {
    console.error(`kit:adopt: ${target} is not the top of a git repository`);
    return 2;
  }
  if (fs.realpathSync(target) === fs.realpathSync(KIT_ROOT)) {
    console.error('kit:adopt: that is this kit clone; name the repository to adopt the kit into');
    return 2;
  }
  if (git(target, ['rev-parse', '--verify', '--quiet', 'HEAD']).code !== 0) {
    console.error(
      'kit:adopt: the target has no commits; start from the kit instead (README, "Start a project")',
    );
    return 2;
  }
  try {
    const p = plan(readKit(), target);
    console.log(`Adopting the Factory Kit ${p.version} into ${target}\n`);
    console.log(report(p));
    if (!argv.includes('--apply')) {
      console.log(`A dry run: nothing was written. --apply writes this on ${p.branch}, in one commit.`);
      return 0;
    }
    const done = apply(p, target, { install: !argv.includes('--no-install') });
    console.log(`Committed ${done.paths.length} file(s) on ${p.branch}: "${p.subject}".`);
    if (p.install && !done.installed) {
      console.log(
        'The lockfile was not produced: run `pnpm install` in the target and commit pnpm-lock.yaml.',
      );
    }
    console.log(`Nothing was pushed. Next: git -C ${target} push -u origin ${p.branch}`);
    return 0;
  } catch (e) {
    console.error(`kit:adopt: ${e.message}`);
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}

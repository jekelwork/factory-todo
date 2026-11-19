// `pnpm check:items`, the link rewrite's part: scripts/board/links.mjs over strings and over a scratch git
// repository, offline. Every case asserts the whole answer (AGENTS.md, "Assert the whole answer").

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, readMapping, remaining, rewriteLinks, rewriteTree, summarise } from './links.mjs';
import { gitEnv } from './migrate.mjs';

const GL = 'https://git.example/g/p';
const GH = 'https://github.com/o/r/issues';

export async function linksSelftest() {
  let failed = 0;
  const check = (name, got, want) => {
    if (JSON.stringify(got) === JSON.stringify(want)) console.log(`✓ ${name}`);
    else {
      failed++;
      console.error(`✗ ${name}:\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`);
    }
  };

  // GitLab #1 and #2 moved to #8 and #9 (the collision range, appended); #8, #9 and #10 hold other things,
  // and nothing on GitHub is past #10, so GitLab #11 has no copy either.
  const map = readMapping({
    repository: 'o/r',
    gitlab: `${GL}/`,
    highest: 10,
    mapping: { 1: 8, 2: 9 },
    unmapped: [8, 9, 10],
  });
  check(
    'links: the mapping is read with its URL trimmed and its numbers as numbers',
    [map.repository, map.gitlab, map.highest, [...map.moved], [...map.unmapped]],
    [
      'o/r',
      GL,
      10,
      [
        [1, 8],
        [2, 9],
      ],
      [8, 9, 10],
    ],
  );

  const text = [
    `[#1](${GL}/-/work_items/1) and [#4](${GL}/-/issues/4), see ${GL}/-/work_items/2#note_95754.`,
    `Bare #1, !12, [!12](${GL}/-/merge_requests/12), ${GL}/-/work_items and another/-/work_items/3.`,
    `No copy: ${GL}/-/work_items/9 and ${GL}/-/work_items/11. In brackets: (${GL}/-/work_items/7)`,
  ].join('\n');
  const once = rewriteLinks(text, map);
  check('links: only work-item URLs change; link text, #N, !N and merge requests stay', once, {
    text: [
      `[#1](${GH}/8) and [#4](${GH}/4), see ${GH}/9.`,
      `Bare #1, !12, [!12](${GL}/-/merge_requests/12), ${GL}/-/work_items and another/-/work_items/3.`,
      `No copy: ${GL}/-/work_items/9 and ${GL}/-/work_items/11. In brackets: (${GH}/7)`,
    ].join('\n'),
    changes: [
      [1, 8],
      [4, 4],
      [2, 9],
      [7, 7],
    ],
    left: [9, 11],
    dropped: 1,
  });
  check(
    'links: a second pass changes nothing but reports the same links left',
    rewriteLinks(once.text, map),
    {
      text: once.text,
      changes: [],
      left: [9, 11],
      dropped: 0,
    },
  );
  let refused = null;
  try {
    readMapping({ repository: 'o/r', gitlab: GL, highest: 10, mapping: { 1: '8' }, unmapped: [] });
  } catch (e) {
    refused = e.message;
  }
  check(
    'links: a mapping with a bad entry is refused',
    refused,
    'not a migrate.mjs --mapping file: a bad entry 1 → 8',
  );

  // ---- over a scratch repository: tracked files only, binaries skipped, idempotent ------------------------
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-links-'));
  try {
    // Every inherited GIT_* dropped, or a git hook's GIT_DIR would point this at the developer's repository.
    const git = (...args) => execFileSync('git', args, { cwd: dir, env: gitEnv(), stdio: 'ignore' });
    git('init', '-q');
    const write = (f, body) => {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), body);
    };
    write('TASKS.md', `- [#1](${GL}/-/work_items/1), [#3](${GL}/-/work_items/3)\n`);
    write('docs/adr/0001-x.md', `Work item: ${GL}/-/work_items/2#note_7\n`);
    write('docs/releases/1.0.0.md', `- ${GL}/-/work_items/10 has no copy\n`);
    write('img.png', Buffer.concat([Buffer.from([0, 1]), Buffer.from(`${GL}/-/work_items/1`)]));
    write('untracked.md', `${GL}/-/work_items/1\n`);
    git('add', 'TASKS.md', 'docs', 'img.png');

    const before = fs.readFileSync(path.join(dir, 'TASKS.md'), 'utf8');
    const dry = rewriteTree(dir, map, { dryRun: true });
    check(
      'links: a dry run reports per tracked text file and writes nothing',
      [dry, fs.readFileSync(path.join(dir, 'TASKS.md'), 'utf8') === before],
      [
        [
          {
            file: 'TASKS.md',
            changes: [
              [1, 8],
              [3, 3],
            ],
            left: [],
            dropped: 0,
          },
          { file: 'docs/adr/0001-x.md', changes: [[2, 9]], left: [], dropped: 1 },
          { file: 'docs/releases/1.0.0.md', changes: [], left: [10], dropped: 0 },
        ],
        true,
      ],
    );
    check(
      'links: the summary names the totals, the moved numbers, what was left, and each file',
      summarise(dry, { dryRun: true }),
      [
        'would rewrite 3 link(s) in 2 file(s); 2 to a different number, 1 #note fragment(s) dropped',
        'moved: #1 → #8, #2 → #9',
        'LEFT  docs/releases/1.0.0.md: GitLab #10 has no copy on GitHub',
        '  2\tTASKS.md',
        '  1\tdocs/adr/0001-x.md',
      ],
    );
    rewriteTree(dir, map);
    const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
    check(
      'links: the run rewrites tracked text files only, and a second run finds nothing to change',
      [
        read('TASKS.md'),
        read('docs/adr/0001-x.md'),
        read('docs/releases/1.0.0.md'),
        read('img.png').includes(`${GL}/-/work_items/1`),
        read('untracked.md'),
        rewriteTree(dir, map).map((r) => [r.file, r.changes.length, r.left]),
      ],
      [
        `- [#1](${GH}/8), [#3](${GH}/3)\n`,
        `Work item: ${GH}/9\n`,
        `- ${GL}/-/work_items/10 has no copy\n`,
        true,
        `${GL}/-/work_items/1\n`,
        [['docs/releases/1.0.0.md', 0, [10]]],
      ],
    );
    check(
      'links: --check names the file a link is left in, and only tracked text files',
      remaining(dir, GL),
      [['docs/releases/1.0.0.md', 1]],
    );

    // linkFiles narrows both the rewrite and the check to the pathspecs it names.
    write('docs/adr/0002-y.md', `${GL}/-/work_items/4\n`);
    write('src/a.js', `// ${GL}/-/work_items/4\n`);
    git('add', 'docs', 'src');
    check(
      'links: linkFiles narrows the rewrite and the check to its pathspecs',
      [
        rewriteTree(dir, map, { dryRun: true, files: ['docs/adr'] }).map((r) => [r.file, r.changes]),
        remaining(dir, GL, { files: ['src'] }),
        remaining(dir, GL),
      ],
      [
        [['docs/adr/0002-y.md', [[4, 4]]]],
        [['src/a.js', 1]],
        [
          ['docs/adr/0002-y.md', 1],
          ['docs/releases/1.0.0.md', 1],
          ['src/a.js', 1],
        ],
      ],
    );

    // The command: --check reads the URL from package.json, refuses with none, and fails on a link left.
    const run = (argv, pkg) => {
      if (pkg === undefined) fs.rmSync(path.join(dir, 'package.json'), { force: true });
      else fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
      const out = [];
      const code = main(argv, { root: dir, log: (l) => out.push(l), error: (l) => out.push(l) });
      return [code, out];
    };
    const settings = (migrate) => ({ factoryKit: { migrate } });
    fs.writeFileSync(
      path.join(dir, 'map.json'),
      JSON.stringify({
        repository: 'o/r',
        gitlab: GL,
        highest: 10,
        mapping: { 1: 8, 2: 9 },
        unmapped: [8, 9, 10],
      }),
    );
    check(
      'links: --check with no GitLab URL refuses, rather than passing over nothing',
      run(['--check'], undefined),
      [
        2,
        [
          '✖ --check has no GitLab URL to look for: set factoryKit.migrate.gitlab in package.json, or pass --gitlab=<url>',
        ],
      ],
    );
    check(
      'links: --check exits 1 on a link left, naming each file, with the URL from package.json',
      run(['--check'], settings({ gitlab: GL, linkFiles: ['docs', 'src'] })),
      [
        1,
        [
          '✖ docs/adr/0002-y.md: 1 link(s) to a GitLab work item',
          '✖ docs/releases/1.0.0.md: 1 link(s) to a GitLab work item',
          '✖ src/a.js: 1 link(s) to a GitLab work item',
          'Run scripts/board/links.mjs with the migration mapping (docs/agents/migrating-a-board.md, "The links in the tree").',
        ],
      ],
    );
    check(
      'links: a mapping for another GitLab project than the setting names is refused',
      run([path.join(dir, 'map.json')], settings({ gitlab: 'https://git.example/g/other' })),
      [2, [`✖ the mapping is for ${GL}, and factoryKit.migrate.gitlab is https://git.example/g/other`]],
    );
    fs.writeFileSync(path.join(dir, 'docs/releases/1.0.0.md'), 'gone\n');
    fs.writeFileSync(path.join(dir, 'src/a.js'), '// gone\n');
    rewriteTree(dir, map);
    check(
      'links: --check passes once nothing is left, and --gitlab= overrides the setting',
      [
        run(['--check'], settings({ gitlab: GL })),
        run(['--check', `--gitlab=${GL}/`], settings({ gitlab: 'https://git.example/x/y' })),
      ],
      [
        [0, ['✓ no link to a GitLab work item is left in the tracked files']],
        [0, ['✓ no link to a GitLab work item is left in the tracked files']],
      ],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return failed;
}

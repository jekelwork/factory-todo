// Step 6 of the setup guide: the parts of the kit that describe the project, not the kit. The board skills
// read AGENTS.md and docs/agents/project.md as true; a skill following the Makers Market example in a
// project that is not Makers Market posts a confidently wrong plan under the project's name. So the step
// stays open while any placeholder or example marker is left, and then until the project's own checks pass.
//
// The guide does not write these files. Claude does (the start-project skill): on an existing codebase it
// reads the code first and writes cited proposals into the files, then interviews the tech lead for the
// rest. The page only shows the prompt to paste and re-runs this scan. Run directly with `--list`, this
// module prints what is left, one per line, which is how the skill knows where to start.
//
// Not scanned for emptiness: the lists in `.claude/hooks/guard.mjs`. A project may have no generated files
// and nothing to refuse beyond the kit's own, so an empty list is a valid answer the scan cannot tell from
// a forgotten one. The skill asks instead. Scanned in every file the skill writes proposals into: a proposal
// it has not had reviewed, which would otherwise read as the lead's answer.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realContext } from './checks.mjs';

// The kit's own `check`: lint plus the kit's selftests. A project whose `check` is still exactly this runs
// none of its own typecheck or tests, so every gate in the method passes on code nobody tested.
const KIT_CHECK =
  'pnpm run lint && node .claude/hooks/guard.mjs --selftest && node scripts/setup/selftest.mjs';
const literal = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

const ADR = 'docs/adr/0001-build-with-agents-under-review.md';
const UNREVIEWED = 'proposals not yet reviewed';

/**
 * The files the skill writes tagged proposals into, and so the files scanned for a tag left behind. Not
 * `package.json`: JSON carries no tag, so the skill asks the lead for `check` before it writes one.
 */
export const PROPOSED_IN = ['AGENTS.md', 'docs/agents/project.md', 'SECURITY.md', '.claude/hooks/guard.mjs'];

/** Each part left for the project, as the kit ships it. A part is filled in once its pattern stops matching. */
export const PLACEHOLDERS = [
  { file: 'AGENTS.md', pattern: /<Project name>/, what: 'title line' },
  { file: 'AGENTS.md', pattern: /<One sentence:/, what: 'one-sentence description' },
  // The rule-10 stub, and the Makers Market example beneath it: a project that wrote its rules but kept the
  // example would have agents enforcing another project's design tokens.
  {
    file: 'AGENTS.md',
    pattern: /Add this codebase's own rules here|Makers Market example of project rules/,
    what: 'project ground rules',
  },
  { file: 'AGENTS.md', pattern: /<add the project's own directories>/, what: 'layout' },
  { file: 'docs/agents/project.md', pattern: /<!-- example -->/, what: 'example blocks' },
  { file: 'SECURITY.md', pattern: /<!-- example -->/, what: 'example scope' },
  { file: ADR, pattern: /^Date: YYYY-MM-DD/m, what: 'date' },
  {
    file: 'package.json',
    pattern: new RegExp(`"check":\\s*"${literal(KIT_CHECK)}"`),
    what: "check runs only the kit's lint",
  },
  // A proposal the skill drew from the code, not yet accepted, corrected or deleted by the tech lead.
  ...PROPOSED_IN.map((file) => ({
    file,
    pattern: /<!-- proposed -->/,
    what: UNREVIEWED,
  })),
];

/**
 * What has to be there, rather than gone: a part that is missing until its pattern matches. A project that
 * adopted the kit (`pnpm kit:adopt`) keeps its own AGENTS.md, which has no placeholder to stop matching, so
 * without this the step would call a file with none of the kit's rules in it described.
 */
export const REQUIRED = [
  { file: 'AGENTS.md', pattern: /^## Ground rules[\s\S]*\*\(kit\)\*/m, what: "the kit's ground rules" },
];

// An ADR is cited by its number, so the list names it that way: `docs/adr/0001`, not its full file name.
const label = (file) => file.replace(/^(docs\/adr\/\d{4})-.*$/, '$1');

/** The exact text the page shows, to paste into Claude Code. It names the skill so the right one loads. */
export const HANDOVER_PROMPT =
  'Use the start-project skill: read the code first if there is any, propose the parts the Factory Kit ' +
  'left for this project, then ask me what the code cannot tell, one question at a time.';

const CHECK = ['exec', '--', 'pnpm', 'run', 'check'];

/** What is still the kit's text, as `<file>: <what>` lines in the order the list gives. */
export function leftToFill(ctx) {
  // A file that is gone has nothing left to fill. Deleting SECURITY.md is a choice the docs guard and the
  // review see; it is not this step's to second-guess.
  const left = PLACEHOLDERS.filter((p) => p.pattern.test(ctx.read(p.file) ?? ''));
  const missing = REQUIRED.filter((p) => !p.pattern.test(ctx.read(p.file) ?? ''));
  return [...left, ...missing].map((p) => `${label(p.file)}: ${p.what}`);
}

/**
 * What is left, in words: the kit's own text, and the project's proposals nobody has reviewed yet, which
 * are drafts drawn from the project's code and not the kit's text at all.
 */
function leftSummary(left) {
  const drafts = left.filter((l) => l.endsWith(`: ${UNREVIEWED}`)).length;
  const kit = left.length - drafts;
  const parts = kit
    ? `${kit} part${kit === 1 ? ' still describes' : 's still describe'} the kit, not your project`
    : '';
  const proposals = drafts
    ? `${parts ? 'p' : 'P'}roposals in ${drafts} file${drafts === 1 ? ' are' : 's are'} not reviewed yet`
    : '';
  return `${[parts, proposals].filter(Boolean).join(', and ')}.`;
}

/** Step 6: no placeholder left, then `pnpm check` green. */
export async function checkProject(ctx) {
  const left = leftToFill(ctx);
  if (left.length) {
    // `pnpm check` is not run yet: it takes minutes, and while the kit's text is still there it can only
    // pass on the kit's own lint, which says nothing about the project.
    return {
      status: 'todo',
      summary: leftSummary(left),
      detail: left.join('\n'),
      fix: {
        text:
          'Paste this into Claude Code, opened in this folder. Where there is code, Claude reads it first and ' +
          'writes proposals into the files for you to review with git diff. Then it asks you about the rest, ' +
          'one question at a time, and fills it in.',
        copy: HANDOVER_PROMPT,
        forClaude: true,
      },
    };
  }
  const r = await ctx.sh('mise', CHECK);
  if (r.code !== 0) {
    // The tail is where a failing gate names itself; the whole output is a command away.
    const tail = `${r.stdout}${r.stderr}`.trimEnd().split('\n').slice(-20).join('\n');
    return {
      status: 'fail',
      summary: 'Everything is filled in, but the project’s own checks do not pass yet.',
      detail: tail,
      fix: {
        text: 'Ask Claude Code to make them pass, or run them yourself to see the whole output:',
        commands: [['mise', ...CHECK].join(' ')],
      },
    };
  }
  return { status: 'pass', summary: 'The kit knows your project, and its checks pass.' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== '--list') {
    console.error('usage: node scripts/setup/project.mjs --list');
    process.exitCode = 2;
  } else {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    for (const line of leftToFill(realContext(root))) console.log(line);
  }
}

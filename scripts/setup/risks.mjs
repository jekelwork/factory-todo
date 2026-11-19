// Risks a person chose to live with during setup, kept in docs/DECISIONS.md. In the repository rather than
// in the page or a dot-file, because an accepted risk is a decision about the project: the team reads it in
// review, it survives a restart of the guide, and deleting the line takes it back.
//
// One line per risk, under one heading:
//
//   - `setup:<step>/<problem>` <what is wrong> Accepted because: <reason>. (<who>, <YYYY-MM-DD>)

const FILE = 'docs/DECISIONS.md';
const HEAD =
  '## Risks accepted at setup\n\nThe setup guide (`pnpm kit:setup`) records here each check that a person ' +
  'chose to live with, and why. Delete a line and the guide asks again.\n\n';
const LINE = /^- `setup:([a-z-]+\/[a-z-]+)` .*? Accepted because: (.*?)\.? \([^()]*, \d{4}-\d{2}-\d{2}\)$/gm;

/** The accepted risks: `'<step>/<problem>'` → the reason given. */
export function readAccepted(ctx) {
  const text = ctx.read(FILE) ?? '';
  return new Map([...text.matchAll(LINE)].map((m) => [m[1], m[2]]));
}

/**
 * Records one risk, once. The reason is the person's own words on one line: whitespace collapsed and
 * backticks dropped, so it cannot break out of the list item or the code span before it.
 */
export async function recordRisk(ctx, { key, text, reason }) {
  const why = String(reason ?? '')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.$/, '')
    .slice(0, 300);
  if (!why) return { status: 'fail', summary: 'Say in a few words why this risk is fine for your project.' };
  const saved = { status: 'pass', summary: `Recorded in ${FILE}. Commit it, so the team sees it too.` };
  if (readAccepted(ctx).has(key)) return saved;

  const name = await ctx.sh('git', ['config', 'user.name']);
  const who = (name.code === 0 && name.stdout.trim()) || 'unknown';
  const line = `- \`setup:${key}\` ${text} Accepted because: ${why}. (${who}, ${ctx.now().toISOString().slice(0, 10)})\n`;
  const old = ctx.read(FILE) ?? '# Decisions and traps\n';
  const at = old.indexOf('## Risks accepted at setup');
  let next;
  if (at === -1) {
    next = `${old.replace(/\n*$/, '\n\n')}${HEAD}${line}`;
  } else {
    // Append to the end of the section: the next heading, or the end of the file.
    const after = old.indexOf('\n## ', at + 1);
    const end = after === -1 ? old.length : after + 1;
    const section = old.slice(0, end).replace(/\n*$/, '\n');
    next = `${section}${line}${after === -1 ? '' : `\n${old.slice(end)}`}`;
  }
  ctx.write(FILE, next);
  return saved;
}

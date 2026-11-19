// What the page hands over to a terminal or to Claude Code: a fix's commands as one line, and a prompt that
// asks Claude Code to run them. Kept apart from the page so the selftest can pin the exact words, and the
// server can build the same `gh repo create` line the page shows.

/** A fix's commands as one line, each run only if the one before it worked. */
export function oneLine(commands) {
  return commands.join(' && ');
}

/**
 * The prompt that asks Claude Code to take a step's fix, or null when there is nothing for it to run, or
 * when the fix is one the person keeps (`byHand`: deleting history is never handed to an agent).
 */
export function claudePrompt({ title, result }) {
  // `forClaude`: the fix's text to copy is already a prompt for Claude Code (step 6's interview).
  if (result.fix?.forClaude) return result.fix.copy;
  // `handoff`: a step whose fix is a screen to click through hands over what its own button would run.
  const commands = result.handoff ?? result.fix?.commands ?? [];
  if (!commands.length || (!result.handoff && result.fix?.byHand)) return null;
  return [
    `The Factory Kit setup guide is open, at its step "${title}". It says: ${result.summary}`,
    '',
    'Run these in this folder, in this order, and stop at the first one that fails:',
    '',
    ...commands,
    '',
    'Then tell me what happened. I will press "Check again" in the guide.',
  ].join('\n');
}

/** The one command that creates an empty repository on GitHub and connects this folder to it as origin. */
export function repoCreateCommand({ owner, name, visibility }) {
  return `gh repo create ${owner}/${name} --${visibility} --source=. --remote=origin`;
}

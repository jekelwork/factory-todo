// The setup guide's words, one entry per step. Kept apart from the page so the selftest can read them: a term
// a newcomer may not know is only used in a step whose body also says what it means, in TERMS' own words.
//
// Written for a tech lead who has never seen this kit and may never have set up a GitHub App: plain words,
// one idea per sentence, the reason before the instruction.

/** Every term the copy may use, with the one sentence that explains it. */
export const TERMS = {
  'GitHub App':
    'A GitHub App is a helper account with its own key: the kit writes to the board as the App, so its notes are never mistaken for yours.',
  ruleset:
    'A ruleset is a lock on the main branch: nothing reaches it except through a pull request that a person merges.',
  'pull request':
    'A pull request is a proposed change, shown side by side with what it replaces, waiting for a person to accept it.',
  'CI mode':
    'The CI mode says where the automatic checks run before a merge: on this computer, on GitHub, or both at once.',
  '[REVIEW]': 'A [REVIEW] point is a numbered question in an agent’s plan that only a person can answer.',
};

/** Per step: why it exists, the picture beside it (a path under page/), and what to do. */
export const COPY = {
  toolchain: {
    why: 'Everyone on the project, people and agents alike, uses the same versions of the tools.',
    picture: 'img/toolchain.svg',
    body: [
      'mise is a small program that installs the exact versions this project names, so a build that works for you works for everybody.',
      'If this step is red, run the command it shows in a terminal opened in this folder.',
    ],
  },
  history: {
    why: 'Your project starts with a history of its own, and lives on GitHub or GitLab where your team can reach it.',
    picture: 'img/history.svg',
    body: [
      'You copied the kit, and the copy still remembers how the kit was written. Your project starts fresh instead.',
      'Then give it a home online: an empty repository, with nothing in it yet.',
      'Last, make the first commit and push it. The first commit names the kit version you started from.',
      'If you brought the kit into an existing repository with pnpm kit:adopt, its history stays. This step then waits until the adoption’s branch is merged into your main branch.',
    ],
  },
  board: {
    why: 'Work arrives as items on a board, and the kit reads and writes that board for you.',
    picture: 'img/board-flow.svg',
    body: [
      'On GitHub the board is the repository’s issues. On GitLab it is the project’s work items.',
      TERMS['GitHub App'],
      'Your organisation may already have one for the kit. Then you only install it on this repository and get its key. If not, an organisation admin creates one once; the guide gives you the exact request to send them.',
      'The key is a file ending in .pem. Keep it outside this folder, and never commit it.',
    ],
  },
  protection: {
    why: 'Agents propose changes, but only a person can accept one.',
    picture: 'img/protection.svg',
    body: [
      TERMS.ruleset,
      TERMS['pull request'],
      'The board’s App, from the step before, must not be allowed past the lock. That is what keeps merging a human decision.',
      'The guide checks this with your own GitHub login, through the gh program, so the App never needs to see your settings.',
    ],
  },
  ci: {
    why: 'Every change is checked automatically before it is merged, and you choose where.',
    picture: 'img/ci-modes.svg',
    body: [
      TERMS['CI mode'],
      'Local costs nothing and needs nothing set up. Remote runs on GitHub, so your laptop stays free. Split does both at once, for the fastest answer.',
      'This choice is yours alone: it is saved on this computer, not in the project.',
    ],
  },
  project: {
    why: 'The kit is the same everywhere; this step teaches it about your project.',
    picture: 'img/project.svg',
    body: [
      'Some files describe the project for the agents: what can go badly wrong, how to check a change, which files only a command may write.',
      'Where code already exists, Claude reads it first and writes what it finds into the files as proposals, each one marked, for you to review with git diff. Then it asks you what the code cannot tell, one question at a time. Paste the prompt below into Claude Code in this folder.',
      'This step is green when no placeholder and no unreviewed proposal is left, and the project’s own checks pass.',
    ],
  },
  demo: {
    why: 'You walk one small piece of work all the way through, so you have seen every point where a person decides.',
    picture: 'img/loop.svg',
    body: [
      'The guide puts a small item on your board: add a CODEOWNERS file, which says who reviews which part of the project.',
      'Claude writes a plan for it. The plan ends with numbered questions for you.',
      TERMS['[REVIEW]'],
      'Answer the first one on the board, as a comment. Answer the second in Claude Code, where it offers you a choice to pick from.',
      'Then say go. Claude builds the change and opens a pull request. You review it and merge it yourself.',
      TERMS['pull request'],
      'The item stays on your board afterwards, as the worked example for the next person.',
    ],
  },
  done: {
    why: 'The factory is running.',
    picture: 'img/done.svg',
    body: [
      'Your board answers, your checks run, and you have taken one item from the board to a merge.',
      'Next time, open Claude Code in this folder: it shows the board when a session starts.',
    ],
  },
};

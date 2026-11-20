# Factory Kit: feedback from a first run

Written by a solo developer setting up a new project from the Factory Kit 1.2.0 on macOS (zsh), using Claude
Code. Each note says what I did, what happened, why (where I know), and what would have helped. Where I do
not know the cause, I say so.

## 1. The install command assumes mise is already installed

- **What I did:** followed the GitHub page, which says to run `mise trust && mise install && pnpm install`.
- **What happened:** I did not have mise, so the command could not run.
- **Suggestion:** say before that line that mise has to be installed first, and link to how to install it.

## 2. `pnpm` is "command not found" until mise is activated in the shell

- **What I did:** installed mise, then ran `pnpm kit:setup`.
- **What happened:** `zsh: command not found: pnpm`. The same error came back later in the same project when I
  typed `pnpm items list`.
- **Why:** `mise install` downloads Node and pnpm, but it does not put them on the shell's PATH. That only
  happens once mise is activated in the shell, by adding `eval "$(mise activate zsh)"` to `~/.zshrc` and
  opening a new terminal. The `pnpm install` at the end of the install chain never ran either, so
  dependencies were not installed.
- **My workaround:** put `mise exec --` in front of every command:
  `mise exec -- pnpm install`, then `mise exec -- pnpm kit:setup`.
- **Why it hurts:** the README, the setup guide and the docs all write plain `pnpm …` and never mention this,
  so every command in them fails in a fresh terminal.
- **Suggestion:** have the setup guide check whether `pnpm` is on PATH. If not, show the one-time activation
  line for the user's shell (zsh, bash and fish differ), or say that `mise exec --` goes in front of each
  command.

## 3. The setup guide loses its connection if its terminal is interrupted

- **What I did:** ran `mise exec -- pnpm kit:setup`. A page opened in the browser and told me to run some
  commands myself in the terminal. I pressed Ctrl-C in that terminal to get the prompt back and pasted the
  commands there.
- **What happened:** back in the browser, the page had lost its connection. Ctrl-C stopped the server that
  serves the guide.
- **What I should have done:** open a second terminal window for the pasted commands and leave the guide's
  process running.
- **Suggestion:** tell the user to use a second terminal, and, if the connection is lost, say how to get it
  back (run `pnpm kit:setup` again).

## 4. No help with creating a GitHub App as a solo developer, and permission changes do not apply on their own

- **What I did:** created a GitHub App for the board, on a personal account and not an organisation.
- **What happened:**
  - The guide listed only some of the permissions to enable (I saw pull requests, contents and metadata;
    I am not sure the list was complete). The kit's own docs list Issues, Pull requests and Contents
    (read and write) and Metadata (read), so the guide and the docs may disagree.
  - After I fixed the permissions and saved, it still did not work.
- **Why:** changing an App's permissions does not apply them to an existing installation until the
  installation's owner accepts the new permissions. GitHub shows a banner and sends an email. It can also
  be done under Settings → Applications → Installed GitHub Apps → Configure → Review request. The guide did
  not mention this step, and it is easy to miss.
- **Suggestion:**
  - Add a solo-developer path: how to create the App on a personal account, with the exact permissions to
    tick.
  - Say that after any permission change the installation must accept the request, and where to do it.

## 5. `pnpm check` fails when `.env.github.example` is missing

- **What I did:** I renamed `.env.github.example` to `.env.github`, instead of copying it.
- **What happened:** `pnpm check` went red. The kit's setup selftest (`scripts/setup/adopt.selftest.mjs`)
  reads `.env.github.example` and crashed with `ENOENT`. Restoring the file with
  `git checkout .env.github.example` fixed it.
- **Why:** the selftest needs the example file to exist in the tree. The docs say to copy it
  (`docs/agents/issue-tracker.md`, GitHub setup, step 5), so the rename was my mistake, but nothing warned me.
- **Suggestion:** say "copy, do not rename" where the file is mentioned, or make the selftest tolerate a
  missing example file and say what is missing in a clear message.

## 6. The agent missed my replies on the board item, and read "go" as an answer

- **What I did:** item #1 had a plan with two `[REVIEW]` questions. I answered both on the item itself on
  GitHub (https://github.com/jekelwork/factory-todo/issues/1): "2. follows the same rules as 1" and
  "[REVIEW 2]  same as [REVIEW 1]". I then asked in Claude Code "did you get my answers".
- **What happened:**
  - The board did register my replies: `pnpm items show 1` lists both as `reply`, posted before the agent's
    coverage round.
  - The agent never re-read the item. It told me nobody had answered the second question, did not answer my
    "did you get my answers", and took my "go" as acceptance of its recommended option. Its message was:
    "Ownership of * went to @jekelwork, and docs/ follows it since the second review question got no answer,
    which I've logged on #1. I'm committing and opening the pull request now, unless you want a separate
    line for docs/ first."
  - The result happened to match what I had answered, but the board's coverage round gives the wrong reason
    ("go"), and I did not know my replies had been seen.
- **What the agent should have done:** read the item again when I said I had answered, and never treat "go"
  as an answer to a `[REVIEW]` question.
- **Earlier version of this note:** I first wrote that I had answered in the wrong place. That was wrong; the
  fault was in the agent's reading of the board.
- **Suggestion:**
  - Before saying a point is unanswered, the agent should re-read the item, since replies arrive while the
    session is open.
  - When the user says they have answered, the agent should check the board and say what it found.
  - When a plan has open `[REVIEW]` points, "go" should never close them.

## 7. "Board" is ambiguous: I thought answering on the issue and answering through the board were different

- **What I did:** I answered the `[REVIEW]` questions on issue #1. I also had GitHub's Projects view of the
  repository open, which shows the same issue in a side pane
  (https://github.com/users/jekelwork/projects/13?pane=issue&itemId=311081149&issue=jekelwork%7Cfactory-todo%7C1).
- **What I was confused about:** the docs say to answer "on the board", and I thought the board was a
  separate place from the issue. I thought that answering on the issue and answering through the Projects
  board were two different things, and that only one of them counted.
- **What is actually true:** they are the same thing. In the kit, the "board" is the repository's issues,
  read through the API (`pnpm items list`). GitHub Projects is a separate feature that the kit does not use.
  A comment written in the Projects side pane is a comment on the same issue, so it counts the same.
- **Why it hurts:** because I believed I might have answered in the wrong place, I accepted a wrong
  explanation in note 6 for a while. A new user has no way to tell that the two are the same.
- **Suggestion:** say in the README and the setup guide that on GitHub the "board" is the repository's
  issues, that GitHub Projects is not needed, and that a reply in either place is the same reply.

## 8. `pnpm check` prints a Biome version warning on a fresh install

- **What I did:** ran `mise exec -- pnpm check` on `main` after merging my first pull request.
- **What happened:** the check passed, but the lint step printed an info message:
  "The configuration schema version does not match the CLI version 2.5.15. Expected: 2.5.15, Found: 2.5.13.
  Run the command `biome migrate` to migrate the configuration file." (`biome.json:2`.) It also printed a
  style hint about string concatenation in `scripts/board/release-deck/deck.html:88`.
- **Why:** `biome.json` names schema 2.5.13, and `package.json` allows `@biomejs/biome ^2.5.13`, so a fresh
  install gets the newer 2.5.15 and the two no longer match.
- **Why it hurts:** neither message fails the check, but a new user cannot tell whether they need to act on
  them, and they appear in the first clean run.
- **Suggestion:** pin Biome exactly, or update the schema version in `biome.json` when the dependency moves,
  and fix or ignore the hint in `deck.html`.

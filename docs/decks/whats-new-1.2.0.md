# What's new in the Factory Kit 1.2.0

The kit now goes into repositories that already exist, and into legacy systems on their way out. And the gates check what actually leaves your machine.

## Bring the kit into an existing repository

### pnpm kit:adopt

- Run `pnpm kit:adopt <path>` from a kit clone. It is a dry run that lists every file and every conflict.
- `--apply` commits on a branch of its own in the target, so the adoption reaches main only through a pull request.
- A project file is never overwritten. A conflict is reported with a proposal instead.

### It fits what is already there

- Husky or pre-commit keeps running the hooks, and hands over to the kit's gates.
- `pnpm check` runs the project's own build gates (Maven, Gradle, .NET, Python) beside the kit's.
- On npm or yarn, the kit's two tools live in a package of their own.

## Modernize a legacy system

### The modernize skill

- Places the old code in a protected directory that no agent may edit.
- Surveys it, and writes the analysis and a strategy ADR.
- Stops until a person approves a merge request holding only those.

### Then the board

- Writes a seed file in which every entry traces to its analysis section.
- `pnpm items create --batch` creates the whole backlog from that file, with links between items, and only after a person says go.

## Gates that check what leaves

### The secret scan

- At commit, it reads the staged content, so a file staged and then deleted is still checked.
- At push and in `pnpm ci:remote`, it reads every object being sent. A secret committed and later removed is refused, because its history still travels.

### The pre-push gates

- One script runs every pre-push gate, on exactly the refs being pushed.
- A branch pushed from another checkout is refused rather than checked against the wrong tree.

## Numbers that never collide

### Number leases

- `pnpm lease adr` takes the next ADR number on origin for this branch, before the file is written.
- Two branches can no longer both write ADR 0007. The pre-push hook refuses an unleased number.

### Protected paths

- `factoryKit.protected` names directories the guard and the docs checks leave alone, such as `legacy/` during a modernization.

## Fixes worth knowing

### Security

- The board migration treats board text as untrusted: an upload link that is not a single file name is not copied, and the dry run lists it.
- A confidential item's title no longer appears in the output of the items linked to it.

### The setup guide

- Step 4 checks the lock itself: at least one approval, approvals dismissed on a new push, and the App on no bypass list.
- On GitLab, it fails when Developers may merge.

## Upgrading

### For projects on 1.1.x

- Nothing has to change.
- Upgrade before running a board migration again, and read the dry run's list of refused upload links before archiving GitLab.

### Behaviour you may notice

- A push whose history still holds a removed secret is now refused. Rewrite the commit and rotate the key.
- Setup step 4 may now fail a ruleset that passed before.

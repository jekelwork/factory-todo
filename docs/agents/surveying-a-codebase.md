# Surveying an existing codebase

How an agent reads code that was here before the kit, so that what it then writes about that code can be
checked. Two skills cite this file: `start-project` drafts the project-owned parts of the kit from the
survey, and `modernize` builds its analysis documents on it. Each skill says what it does with the
findings; this file says how they are gathered and what makes one admissible.

The risk is not a survey that misses something. It is a confident finding that is false, written into a
file the board skills read as true: an "irreversible failure" invented from a directory name sends triage
to the wrong model under the project's name, and nobody can tell it from a real one by reading it.

## 1. Is there code here?

Count the tracked files outside the kit's own tree:

```
git ls-files | grep -vE '^(\.claude|\.github|\.gitlab|docs|scripts)/' | grep '/' | wc -l
```

Files at the repository root are left out too: they are the kit's (`package.json`, `AGENTS.md`, …) or
config that every repository has. **Ten or more** means an existing codebase. Fewer means a fresh project
with a starter file or two, and the survey is skipped. A project that kept its own code under `scripts/`
or `docs/` before adopting the kit will count low: when the tree plainly holds more than the kit, say so
and ask rather than trust the number.

## 2. The rules

1. **Read only.** The survey edits nothing, runs nothing that writes (no install, no build, no migration,
   no code generator), and calls no network service. Reading a manifest's `scripts` is how a command is
   found; running it is the project's checks' job, later.
2. **Every finding cites the file it came from**, as `path` or `path:line` where the line is cheap to
   give. The docs guard (`scripts/check-docs.mjs`) fails `pnpm lint` on a cited path that does not exist,
   so a made-up file in a Markdown document is caught mechanically. A wrong line number, and a citation in a
   code comment (the guard's lists), are the reviewer's to catch.
3. **A finding states what was seen, not what it probably means.** "found: `db/migrations/` (14 files,
   numbered, applied by the knexfile)" is a finding. "likely data loss" is not.
4. **No citation, no finding.** Something the code suggests but no file shows becomes a question for the
   person who knows, worded with what was seen. It is never written down as a guess.
5. **Confirmed or suspected.** A finding read in the code that does the thing is *confirmed*. One inferred
   from a name, a config key or a comment is *suspected*, and says what would confirm it. The vocabulary is
   the triage skill's, so a plan and an analysis mean the same thing by it.
6. **What was not read is said.** The survey ends with a coverage table, one row per area: *read*,
   *skimmed* (sampled, see §4) or *not read*. An unread area is visible instead of silently absent.

## 3. What to read, in this order

Each step narrows the next, so the order matters more than completeness.

1. **Manifests**, in full: `package.json` and its workspaces, `pom.xml`, `build.gradle`, `*.csproj` and
   `*.sln`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`. They give the stack, the package
   boundaries and the commands. A lockfile is only noted, never read: its name gives the package manager,
   and it is a generated path.
2. **CI configuration**, in full: GitHub workflows, a GitLab CI file, a Jenkinsfile, Azure pipelines.
   The commands CI runs are the verification commands, whatever the README says.
3. **Lint, format and type configuration**, in full: ESLint, Biome, Prettier, Checkstyle, EditorConfig,
   TypeScript's compiler options, Ruff or mypy sections. A rule configured as an error is a candidate
   project rule; its reason is a question.
4. **The directory tree to depth 2**, from tracked files only (`git ls-files | cut -d/ -f1-2 | sort -u`), so
   installed dependencies and build output stay out. It gives the layout and the top-level packages.
5. **Schema and migrations**: `migrations/`, `db/`, `prisma/`, `drizzle/`, `alembic/`, `flyway`, Liquibase
   changelogs, `*.sql`. A migration that has run cannot be taken back, so each set found is a candidate
   irreversible failure and a generated path.
6. **Generated code**: files carrying `@generated` or `DO NOT EDIT` (`git grep -lE`, which searches
   tracked files only, as every search here should), codegen steps in the manifests
   (`openapi-generator`, `graphql-codegen`, `protoc`, `prisma generate`), and the directories they write
   to. These are the guard's generated paths, each with the command that produces it.
7. **External side effects**: HTTP clients, queues, mail, payments, file or blob stores, scheduled jobs.
   Search for the client libraries the manifests name, not for words. Each call site that cannot be
   undone (a charge, a sent mail, a deleted object) is a candidate irreversible failure.
8. **Contracts between packages**: which package imports which, found by searching import lines for the
   other packages' names rather than building a full import graph. The direction of the imports is the order
   of work (contract first, then its producers, then its consumers), and a package everybody imports is
   what conflicts by construction.
9. **Tests**: where they live, what runs them, and roughly how much of the code they reach. Coverage
   reports already in the tree count; a guess does not.
10. **What people wrote down**: the README, `docs/`, any existing agent instructions (an AGENTS.md
    or CLAUDE.md of its own, Cursor rules, Copilot instructions), ADRs, a changelog. They say what was
    intended; the code says what is. Where the two disagree, the code is the finding and the document is
    the question.

## 4. How much to read

- **Manifests and configuration in full.** They are short and everything else depends on them.
- **Anything else is sampled**: at most five files per area, chosen as the largest, the most imported and
  the most recently changed (`git log -n 500 --format= --name-only -- <area> | sort | uniq -c | sort -rn |
  head`, bounded so an old repository's whole history is not walked). The coverage table marks a sampled
  area *skimmed*.
- **Past 1,000 tracked files** (the count in §1), give each top-level package to **one read-only subagent** (in Claude Code, the Explore agent). Its brief
  is this file, the package's path and the list in §3. It returns at most 60 lines: its findings, each
  cited, and its row of the coverage table. The main session writes everything that follows, and trusts a
  subagent's finding only as far as its citation goes: open the cited file before writing a finding that
  becomes an irreversible failure or a guard entry.

## 5. What the code cannot tell

Always asked, never derived, however much was read: what must never break, and for whom; who decides
which way a trade-off goes; product and business risk; the security scope, meaning where a mistake is
invisible to the person it affects; branching and release habits; and what is deliberately not built.
The survey arrives at these questions with what it found, so the person corrects a proposal instead of
answering into a blank.

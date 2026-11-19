#!/usr/bin/env node
// Conventional Commits gate. Types kept small on purpose.
import { readFileSync } from 'node:fs';

const msg = readFileSync(process.argv[2], 'utf8').split('\n')[0] ?? '';
const re = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([a-z0-9/-]+\))?!?: .{3,}/;
if (!re.test(msg) && !msg.startsWith('Merge') && !msg.startsWith('fixup!')) {
  console.error(
    `✖ Commit message must follow Conventional Commits, e.g. "feat(web): add listing gallery"\n  got: "${msg}"`,
  );
  process.exit(1);
}

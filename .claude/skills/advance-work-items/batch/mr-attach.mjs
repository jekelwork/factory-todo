#!/usr/bin/env node
/**
 * Attach a file to a merge request (a pull request on GitHub): upload it, then post it as a comment with
 * an intro.
 *
 *   node .claude/skills/advance-work-items/batch/mr-attach.mjs <mr iid> <file> <intro.md>
 *
 * Node builtins only, and the board's own credentials (`.env.gitlab` or `.env.github`), through the same
 * adapter `pnpm items` uses. Both providers cap an upload at 10 MB.
 */
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { openBoard } from '../../../../scripts/board/config.mjs';

const [iid, file, introFile] = process.argv.slice(2);
if (!iid || !file || !introFile) {
  console.error('usage: mr-attach.mjs <mr iid> <file> <intro.md>');
  process.exit(2);
}
const TYPES = { '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.zip': 'application/zip' };

const board = await openBoard();
if (statSync(file).size > board.maxUploadBytes) {
  console.error(`${file} is over ${board.label}'s ${board.maxUploadBytes / 1024 / 1024} MB attachment cap`);
  process.exit(1);
}
const markdown = await board.upload(
  {
    name: basename(file),
    bytes: readFileSync(file),
    type: TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
  },
  { mr: iid },
);
const body = `${readFileSync(introFile, 'utf8').trim()}\n\n${markdown}\n`;
const note = await board.commentMr(iid, body);
console.log(`posted note ${note.id} on ${board.mrRef(iid)}`);

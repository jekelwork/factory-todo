#!/usr/bin/env node
// Renders the kit's own decks into self-contained slide decks with the what's-new deck's renderer
// (scripts/board/whats-new.mjs), so they read and look like the release decks. Every kit release attaches
// the cheat sheet, the about deck and its what's-new deck (docs/DECISIONS.md, "How the kit itself is
// released").
//
//   node scripts/cheatsheet.mjs [out.html]                 # docs/cheatsheet.md → factory-kit-cheatsheet.html
//   node scripts/cheatsheet.mjs --deck=<file.md> [out.html]
//       docs/decks/about.md         → factory-kit-about.html
//       docs/decks/whats-new-X.Y.Z.md → factory-kit-whats-new.html
//
// Output goes to the repository root by default, where factory-kit-*.html is git-ignored. The version and
// date on the cover come from package.json and today. Node builtins only.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { renderDeck } from './board/whats-new.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(readFileSync(resolve(repo, 'package.json'), 'utf8'));
const { values, positionals } = parseArgs({ options: { deck: { type: 'string' } }, allowPositionals: true });

const source = resolve(values.deck ?? resolve(repo, 'docs/cheatsheet.md'));
// A what's-new source carries its version in its name; the rendered file does not, so the listing's
// attachment keeps one name from release to release.
const name = basename(source, '.md').replace(/-\d+\.\d+\.\d+$/, '');
const out = resolve(positionals[0] ?? resolve(repo, `factory-kit-${name}.html`));
const cover = name === 'whats-new' ? "What's new" : 'Knowit Factory Kit';

const html = renderDeck({
  markdown: readFileSync(source, 'utf8'),
  version: `v${version}`,
  date: new Date().toISOString().slice(0, 10),
})
  // The renderer labels a deck as release notes and each slide with the bare version; these are the kit's
  // own decks, so every slide names the kit.
  .replace('<p class="eyebrow">Release notes</p>', `<p class="eyebrow">${cover}</p>`)
  .replaceAll(
    `<p class="eyebrow">v${version}</p>`,
    `<p class="eyebrow">Knowit Factory Kit · v${version}</p>`,
  );

writeFileSync(out, html);
console.log(`wrote ${out}`);

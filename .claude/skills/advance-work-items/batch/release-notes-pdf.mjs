#!/usr/bin/env node
/**
 * The release-notes PDF for a batch merge request: one page per work item, with its e2e screenshots.
 *
 *   node .claude/skills/advance-work-items/batch/release-notes-pdf.mjs <features.json> <screenshots dir> <out.pdf>
 *
 * Run it from anywhere once `pnpm install` has run. It borrows Playwright's Chromium from whichever package
 * depends on `@playwright/test`: `PLAYWRIGHT_FROM` names that package's directory, relative to the repository
 * root, and it defaults to the root itself. `apps/web` is typical in a workspace.
 * Screenshots are re-encoded as JPEG in the page before printing, which keeps a batch's PDF well under
 * GitLab's 10 MB upload cap (eight items and 16 screenshots came to under 3 MB).
 *
 * features.json:
 *   {
 *     "title": "Release 0.3.0 — batch A",
 *     "subtitle": "Eight work items … merged as one merge request. 30 September 2026.",
 *     "intro": ["paragraph", …],
 *     "features": [{
 *       "iid": 217, "title": "Presentation mode at /screen", "url": "https://…/work_items/217",
 *       "summary": "one paragraph", "points": ["bullet", …],
 *       "migration": "0050",                     // optional, shown in the table
 *       "screenshots": ["screen-mode.png", …],   // file names inside <screenshots dir>
 *       "novisual": "No visual change: …"        // shown when screenshots is empty
 *     }]
 *   }
 *
 * A confidential item is `{ "iid": N, "confidential": true }` and nothing more: it renders as
 * `#N (confidential)`. The script looks every feature's flag up in the tracker itself, with the board's
 * credentials (.env.gitlab or .env.github), and treats an item whose flag it cannot read as confidential, so it
 * needs the network. It exits 1, before rendering, when a confidential feature carries a summary, points,
 * screenshots, url, migration or novisual text. The rule is in sanitize-features.mjs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openBoard } from '../../../../scripts/board/config.mjs';
import { sanitizeFeatures } from './sanitize-features.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const from = join(repo, process.env.PLAYWRIGHT_FROM ?? '.', 'package.json');
const { chromium } = createRequire(from)('@playwright/test');

const [featuresFile, shots, out] = process.argv.slice(2);
if (!featuresFile || !shots || !out) {
  console.error('usage: release-notes-pdf.mjs <features.json> <screenshots dir> <out.pdf>');
  process.exit(2);
}
const doc = JSON.parse(readFileSync(featuresFile, 'utf8'));

// Confidentiality is read from the tracker here, not taken from the JSON, so an author who forgot the rule
// is caught. Through the board adapter, so the credentials and the provider are the ones `pnpm items` uses;
// on GitHub, an issue labelled `confidential` comes back confidential (scripts/board/github.mjs).
let board;
try {
  board = await openBoard();
} catch (e) {
  console.error(`✖ ${e.message}; cannot check which items are confidential`);
  process.exit(1);
}
const flags = new Map();
let lastError;
await Promise.all(
  doc.features.map(async (f) => {
    try {
      flags.set(f.iid, (await board.get(f.iid)).confidential);
    } catch (e) {
      lastError = e; // unreadable: left unset, so the feature is treated as confidential
    }
  }),
);
// Not one item readable is a board out of reach, not a batch of confidential items: say that instead.
if (doc.features.length && !flags.size) {
  console.error(`✖ could not read any item from ${board.label}: ${lastError?.message}`);
  process.exit(1);
}
const checked = sanitizeFeatures(doc.features, (iid) => flags.get(iid));
if (checked.errors.length) {
  for (const e of checked.errors) console.error(`✖ ${e}`);
  console.error('Reduce each confidential item to { "iid": N, "confidential": true } and run again.');
  process.exit(1);
}
doc.features = checked.features;
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const img = (f) => {
  const p = join(shots, f);
  if (!existsSync(p)) return `<p class="missing">Screenshot ${esc(f)} was not produced by the run.</p>`;
  return `<figure><img src="data:image/png;base64,${readFileSync(p).toString('base64')}"><figcaption>${esc(f)}</figcaption></figure>`;
};

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  @page { size: A4; margin: 16mm 14mm; }
  body { font: 10.5pt/1.45 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #1a1a1a; }
  h1 { font-size: 20pt; margin: 0 0 4px; } .sub { color: #555; margin: 0 0 14px; }
  h2 { font-size: 14pt; margin: 0 0 2px; border-bottom: 2px solid #1a1a1a; padding-bottom: 3px; }
  .feature { break-before: page; } .feature:first-of-type { break-before: auto; }
  .meta { color: #555; font-size: 9pt; margin: 2px 0 8px; }
  ul { margin: 4px 0 8px 18px; padding: 0; } li { margin: 2px 0; }
  table { border-collapse: collapse; width: 100%; font-size: 9.5pt; margin: 8px 0 12px; }
  td, th { border: 1px solid #ccc; padding: 4px 6px; text-align: left; vertical-align: top; }
  figure { margin: 10px 0; break-inside: avoid; } figcaption { font-size: 8pt; color: #666; }
  img { max-width: 100%; max-height: 190mm; border: 1px solid #ddd; }
  .missing, .novisual { color: #777; font-style: italic; }
</style></head><body>
<h1>${esc(doc.title)}</h1><p class="sub">${esc(doc.subtitle ?? '')}</p>
<table><tr><th>Item</th><th>Feature</th><th>Migration</th></tr>
${doc.features.map((f) => `<tr><td>#${f.iid}</td><td>${esc(f.title)}</td><td>${esc(f.migration ?? 'no')}</td></tr>`).join('')}
</table>
${(doc.intro ?? []).map((p) => `<p>${esc(p)}</p>`).join('')}
${doc.features
  .map(
    (f) => `<section class="feature"><h2>#${f.iid} · ${esc(f.title)}</h2>
<p class="meta">${esc(f.url ?? '')}</p>
<p>${esc(f.summary ?? '')}</p><ul>${(f.points ?? []).map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
${f.screenshots?.length ? f.screenshots.map(img).join('') : `<p class="novisual">${esc(f.novisual ?? 'No visual change.')}</p>`}
</section>`,
  )
  .join('')}
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  // Re-encode every screenshot as JPEG in the page, so the PDF embeds the smaller image.
  await page.evaluate(async () => {
    for (const el of document.querySelectorAll('img')) {
      await el.decode();
      const canvas = document.createElement('canvas');
      canvas.width = el.naturalWidth;
      canvas.height = el.naturalHeight;
      canvas.getContext('2d').drawImage(el, 0, 0);
      el.src = canvas.toDataURL('image/jpeg', 0.72);
      await el.decode();
    }
  });
  await page.pdf({ path: out, format: 'A4', printBackground: true });
} finally {
  await browser.close();
}
console.log(`wrote ${out}`);

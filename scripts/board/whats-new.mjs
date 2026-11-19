// The "what's new" deck: a release's notes for the people who use the product, as slides. DEVELOPER
// TOOLING, used only by release.mjs. Ported from Makers Market, markers included.
//
// The release notes (`docs/releases/X.Y.Z.md`) are the administrators' deploy checklist: configuration,
// migrations, every item by its engineering title, confidential ones by number. None of that is for a
// user, and an item title ("Two concurrent uploads OOM-kill the pod…") cannot be turned into a sentence a
// user reads by any rule a script could follow. So a release carries a second file,
// `docs/releases/X.Y.Z.whats-new.md`, which `prepare` seeds from the delivered items and marks FILL IN line
// by line, and which a person rewrites in the same release merge request. `finalize` renders it into one
// self-contained HTML file and attaches it to the release.
//
// The file's shape is the deck's shape: `#` is the cover's title, the paragraphs under it the cover's
// text, each `##` one slide, and each `###` a column on that slide. Lists, paragraphs, **bold**, *italics*,
// `code` and [links](https://…) are rendered. Anything else is shown as text, and HTML comments are dropped,
// so a FILL IN marker can never reach the deck — except the three audience markers `parseDeck` reads
// (`admin`, `spotlight`, `quiet`; docs/adr/0003-release-hooks-and-deck-markers.md). A project whose app shows the same file
// to its users reads them there too, and Makers Market holds its app's parser to this one with a test.
//
// Node builtins only.

import fs from 'node:fs';
import path from 'node:path';

/** A gap `finalize` refuses to publish while it is still there, in the notes and in this file alike. */
export const FILL_IN = '<!-- FILL IN';

export const whatsNewPath = (version) => `docs/releases/${version}.whats-new.md`;
export const deckFileName = (version) => `whats-new-${version}.html`;
/** The name of the release's asset. `finalize` finds its own again by it, so it never adds two. */
export const DECK_LINK_NAME = "What's new (slides)";

const TEMPLATE_DIR = path.join(import.meta.dirname, 'release-deck');

/**
 * The draft `prepare` writes. `features` and `fixes` are item titles, confidential items already left
 * out. Every seeded line keeps its marker until a person rewrites it, so a title cannot ship by accident.
 */
export function draftWhatsNew({ version, features, fixes }) {
  const seeded = (title) =>
    `- ${title} ${FILL_IN}: rewrite for the people who use it, or delete the line -->`;
  const lines = [
    `# What's new in ${version}`,
    '',
    `${FILL_IN}: one or two sentences on this release, for the people who use it -->`,
    '',
    '<!--',
    '  Who reads this: the people who use the product. Features, additions and fixes only, in plain words:',
    '  nothing about deployment, configuration, sign-in plumbing, tooling or confidential work. Each `##` is a',
    '  slide and each `###` a column on it; keep a slide to what fits a screen, about eight lines, and split a',
    '  longer one into two. `finalize` renders this file into the slides attached to the release, and refuses',
    '  while a FILL IN marker is left. `pnpm items release deck <release-X.Y.Z>` previews it.',
    '',
    '  Three markers, each an HTML comment of its own (written here without the angle brackets, which would',
    '  end this one), and a misspelt one is refused:',
    '    "admin" on a ## line (or straight under it) keeps the slide for administrators, and on a list item',
    '      that line. Left out of the slides on the release, which everybody can open.',
    '    "spotlight: name" on a ## line, or on a line of its own in the slide, names the element the slide is',
    '      about, for a product that shows this file in its own UI. The slides ignore it.',
    '    "quiet" anywhere: a product that opens this file by itself should not. The slides ignore it.',
    '',
    '  How a slide reads best: one headline and one sentence. Fixes are one line on the cover, not a slide of',
    '  their own, and the last slide is a feature, so the presentation ends on something to try.',
    '-->',
    '',
    '## Highlights',
    '',
    `${FILL_IN}: the three to five things worth trying, one line each -->`,
    '',
  ];
  if (features.length) lines.push("## What's new", '', ...features.map(seeded), '');
  if (fixes.length) lines.push('## Fixes', '', ...fixes.map(seeded), '');
  return `${lines.join('\n').trimEnd()}\n`;
}

// A marker survives the comments being dropped as a private-use sentinel on its line. Makers Market's app
// parser (`packages/shared/src/whats-new.ts` there) is this one ported, and its
// `apps/api/test/whats-new-files.test.ts` holds the two together, so the output shape is a contract.
const SENTINELS = /[\uE000-\uE00F]/g;
/** A marker exactly as written: the only comments that survive. */
export const MARKER_RE = /^\s*(?:spotlight\s*:([^\n]*)|(admin)|(quiet))\s*$/i;
/** A comment whose first word looks like a marker but is not one: `admin only`, `admins`, `spotlite: x`. */
export const MARKER_LIKE_RE = /^\s*(?:admin|spot|quiet)/i;

/**
 * Throws on a comment that looks like a marker and is not one: a misspelled `admin` that was quietly
 * dropped would publish administrators' text to everybody who can open the release.
 */
const markComments = (md) =>
  (md ?? '').replace(SENTINELS, '').replace(/<!--([\s\S]*?)-->/g, (_, body) => {
    const m = MARKER_RE.exec(body);
    if (!m) {
      if (MARKER_LIKE_RE.test(body)) {
        throw new Error(`whats-new: "<!--${body}-->" looks like a marker and is not one; fix or remove it`);
      }
      return '';
    }
    return `\uE000${m[2] ? 'admin' : m[3] ? 'quiet' : `spotlight:${(m[1] ?? '').trim()}`}\uE001`;
  });

/**
 * The deck's structure: `{ title, quiet, intro: [paragraph], slides: [{ heading, spotlight, blocks }] }`,
 * where a block is `{ h3 }`, `{ p }` or `{ ul: [item] }`. A list item's indented continuation lines join the
 * item; a nested item becomes an item of the same list, which is as deep as a slide should go.
 *
 * Markers, each an HTML comment of its own: `<!-- admin -->` on a `##` line (or straight under it)
 * makes the slide administrators-only, and on a list item that line; `<!-- spotlight: … -->` names the
 * element the slide is about in the app; `<!-- quiet -->` stops the app opening the release by itself.
 * Admin-only content is left out unless `admin` is true, which nothing here asks for: the slides on the
 * release are read by everybody, and so is anything a project's release hook publishes from them.
 */
export function parseDeck(markdown, { admin: forAdmin = false } = {}) {
  const deck = { title: '', quiet: false, intro: [], slides: [] };
  let slide = null;
  let para = [];
  let list = null;
  const target = () => slide?.blocks ?? deck.intro;
  const flush = () => {
    if (para.length) target().push({ p: para.join(' ') });
    para = [];
    list = null;
  };
  for (const raw of markComments(markdown).split('\n')) {
    const marks = [];
    const line = raw
      .replace(/\uE000([^\uE001]*)\uE001/g, (_, m) => {
        marks.push(m);
        return '';
      })
      .trimEnd();
    const admin = marks.includes('admin');
    if (marks.includes('quiet')) deck.quiet = true;
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const item = /^\s*[-*+](?:\s+(.*))?$/.exec(line);
    // An admin marker where it means nothing is refused: the writer meant something by it.
    const misplaced = () => {
      throw new Error(
        `whats-new: an admin marker on "${line.trim() || '(an empty line)'}" means nothing there`,
      );
    };
    if (h) {
      flush();
      if (admin && h[1] !== '##') misplaced();
      if (h[1] === '#') deck.title = h[2].trim();
      else if (h[1] === '##') {
        slide = { heading: h[2].trim(), admin, spotlight: [], blocks: [] };
        deck.slides.push(slide);
      } else target().push({ h3: h[2].trim() });
    } else if (item) {
      if (para.length) flush();
      if (!list) {
        list = { ul: [] };
        target().push(list);
      }
      if (admin && !slide) misplaced();
      list.ul.push({ text: (item[1] ?? '').trim(), admin });
    } else if (!line.trim()) {
      flush();
      if (admin && slide && slide.blocks.length === 0) slide.admin = true;
      else if (admin) misplaced();
    } else if (list && /^\s/.test(line)) {
      const last = list.ul[list.ul.length - 1];
      last.text += ` ${line.trim()}`;
      if (admin) last.admin = true;
    } else {
      if (admin) misplaced();
      list = null;
      para.push(line.trim());
    }
    for (const m of marks) {
      if (!m.startsWith('spotlight:') || !slide) continue;
      for (const name of m
        .slice('spotlight:'.length)
        .split(',')
        .map((n) => n.trim())) {
        if (name && !slide.spotlight.includes(name)) slide.spotlight.push(name);
      }
    }
  }
  flush();
  const shown = (blocks) =>
    blocks
      .map((b) =>
        b.ul ? { ul: b.ul.filter((i) => i.text && (forAdmin || !i.admin)).map((i) => i.text) } : b,
      )
      .filter((b) => !b.ul || b.ul.length);
  deck.intro = shown(deck.intro);
  // A list item whose words were all a comment (a deleted seed) leaves nothing to show, nor does a slide
  // that held only administrators' lines.
  deck.slides = deck.slides
    .filter((s) => forAdmin || !s.admin)
    .map((s) => ({ heading: s.heading, spotlight: s.spotlight, blocks: shown(s.blocks) }))
    .filter((s) => s.blocks.some((b) => b.p || b.ul?.length || b.h3));
  return deck;
}

/**
 * The file's lines with administrators' content cut out, and nothing else changed: an admin `##` slide up
 * to the next `##`, and an admin list item with its continuation lines. For a release hook that publishes
 * the file's Markdown somewhere everybody reads it, so the admin rule lives in one place and a hook never
 * re-implements it.
 *
 * `parseDeck` defines the rule, and this follows it line for line. It has no notion of a fenced block, so
 * neither does this: a marker inside a fence counts. The file is read by `parseDeck` first, which refuses
 * a misspelt or misplaced marker, and the result is read again at the end: unless it shows administrators
 * exactly what `parseDeck` shows everybody, this throws rather than return text that could carry theirs.
 */
export function withoutAdmin(markdown) {
  const everybody = JSON.stringify(parseDeck(markdown)); // throws on a misspelt or misplaced marker
  const isAdmin = (line) => /<!--\s*admin\s*-->/i.test(line);
  const lines = (markdown ?? '').split('\n');
  const out = [];
  let slideAdmin = false;
  let slideHasContent = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) {
      slideAdmin = isAdmin(line);
      slideHasContent = false;
    } else if (!slideAdmin && !slideHasContent && /^\s*<!--\s*admin\s*-->\s*$/i.test(line)) {
      // Straight under the heading: the whole slide, heading included.
      slideAdmin = true;
      while (out.length && !/^##\s/.test(out[out.length - 1])) out.pop();
      out.pop();
      continue;
    } else if (/^\s*[-*+]\s/.test(line)) {
      // An item and its continuation lines go together.
      let end = i + 1;
      while (end < lines.length && /^\s+\S/.test(lines[end]) && !/^\s*[-*+]\s/.test(lines[end])) end++;
      if (slideAdmin || lines.slice(i, end).some(isAdmin)) {
        i = end - 1;
        continue;
      }
    }
    if (slideAdmin) continue;
    if (line.replace(/<!--[\s\S]*?-->/g, '').trim() && !/^##\s/.test(line)) slideHasContent = true;
    out.push(line);
  }
  const result = out.join('\n');
  if (JSON.stringify(parseDeck(result, { admin: true })) !== everybody) {
    throw new Error(
      "whats-new: the administrators' content could not be cut out without changing what everybody " +
        'else sees; put a blank line between an admin list item and a paragraph next to it',
    );
  }
  return result;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/**
 * One line of Markdown as HTML, escaped first. Code spans are cut out before anything else, so nothing
 * inside one is formatted. A link is kept only when it is https: the deck is opened by people who did not
 * write it, so a `javascript:` or plain `http:` link is shown as text.
 */
export function inline(text) {
  return String(text)
    .split(/(`[^`]+`)/)
    .map((part, i) => {
      if (i % 2) return `<code>${esc(part.slice(1, -1))}</code>`;
      return esc(part)
        .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(^|[^\w*])\*([^*\s][^*]*)\*(?!\w)/g, '$1<em>$2</em>')
        .replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>');
    })
    .join('');
}

const blockHtml = (b) =>
  b.h3 != null
    ? `<h3>${inline(b.h3)}</h3>`
    : b.p != null
      ? `<p>${inline(b.p)}</p>`
      : `<ul>${b.ul.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`;

/** A slide's body: as it is with no `###`, otherwise one column per `###`, with anything before the first above them. */
function slideBody(blocks) {
  const first = blocks.findIndex((b) => b.h3 != null);
  if (first === -1) return blocks.map(blockHtml).join('\n');
  const cols = [];
  for (const b of blocks.slice(first)) {
    if (b.h3 != null) cols.push([]);
    cols[cols.length - 1].push(b);
  }
  return [
    ...blocks.slice(0, first).map(blockHtml),
    `<div class="cols">${cols.map((c) => `<div class="col">${c.map(blockHtml).join('\n')}</div>`).join('\n')}</div>`,
  ].join('\n');
}

const longDate = (iso) =>
  new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${iso}T00:00:00Z`));

const stripTags = (s) => String(s).replace(/[*_`]/g, '');

/** The whole deck, one self-contained HTML file. `date` is `YYYY-MM-DD`. */
export function renderDeck({ markdown, version, date }) {
  const deck = parseDeck(markdown);
  const title = deck.title || `What's new in ${version}`;
  const when = longDate(date);
  const slide = (cls, inner) =>
    `<section class="slide${cls ? ` ${cls}` : ''}">\n<div class="logo">{{LOGO}}</div>\n${inner}\n</section>`;
  const slides = [
    slide(
      'cover',
      [
        '<p class="eyebrow">Release notes</p>',
        `<h1>${inline(title)}</h1>`,
        ...deck.intro.map((b) => (b.p != null ? `<p class="lead">${inline(b.p)}</p>` : blockHtml(b))),
        `<p><span class="badge">${esc(version)} · ${esc(when)}</span></p>`,
      ].join('\n'),
    ),
    ...deck.slides.map((s) =>
      slide(
        '',
        `<p class="eyebrow">${esc(version)}</p>\n<h2>${inline(s.heading)}</h2>\n${slideBody(s.blocks)}`,
      ),
    ),
    slide('cover', '<h1>Thank you</h1>\n<p class="lead">Found something, or missing something? Tell us.</p>'),
  ];
  const template = fs.readFileSync(path.join(TEMPLATE_DIR, 'deck.html'), 'utf8');
  const logo = fs.readFileSync(path.join(TEMPLATE_DIR, 'logo.svg'), 'utf8').trim();
  // Functions, not strings, as replacements: a `$&` in somebody's notes must stay text.
  return template
    .replace('{{TITLE}}', () => esc(`${stripTags(title)} · ${version}`))
    .replace('{{SLIDES}}', () => slides.join('\n\n'))
    .replaceAll('{{LOGO}}', () => logo);
}

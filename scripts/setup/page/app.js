// The setup guide's page. It holds no progress of its own: every load asks the server to re-run every check,
// so closing the tab or coming back tomorrow loses nothing. The one thing kept only here is which steps the
// person chose to skip in this tab, which is a choice about the page, not a fact about the repository.

import { claudePrompt, oneLine, repoCreateCommand } from '/page/handoff.mjs';

const MARK = { pass: '✓', fail: '✗', blocked: '⏳', todo: '○' };
// The demo's stages, in the words the person reads, and the three where they were the human in the loop.
const STAGE_WORDS = {
  filed: 'The item is on your board',
  planned: 'Claude posted a plan with questions',
  'answered-board': 'You answered a question on the board',
  'answered-picker': 'You answered a question in Claude Code',
  go: 'You said go',
  pr: 'Claude opened a pull request',
  merged: 'You merged it',
  closed: 'The item is closed',
};
const IN_THE_LOOP = new Set(['answered-board', 'answered-picker', 'go', 'merged']);

let steps = [];
let current = null;
const skipped = new Set();
let poll = null;
// When the last full round answered, shown under the result so an unchanged answer reads as re-confirmed.
let checkedAt = null;
// The last action's own answer ("GitHub refused 1 of 3 changes"), shown on its step until the next round.
let lastAction = null;
// Started from Claude Code: every fix is also offered as a `!` line and as a prompt for Claude Code.
let claudeCode = false;

const el = (tag, attrs = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) n.setAttribute(k, v === true ? '' : v);
  }
  // Flattened all the way: a block may return lists of lists (notes inside a step's extras), and append()
  // given an array writes "[object HTMLParagraphElement]".
  for (const k of kids.flat(Infinity)) if (k != null) n.append(k);
  return n;
};

/**
 * The session the server handed this browser on the link's one visit: in the page then, in localStorage after,
 * which belongs to this origin and port alone. The key in the address bar is dropped, so the link left in
 * the history opens nothing.
 */
const session = (() => {
  const given = document.querySelector('meta[name="kit-session"]')?.content;
  try {
    if (given) localStorage.setItem('kit-session', given);
    if (location.search) history.replaceState(null, '', '/');
    return given ?? localStorage.getItem('kit-session');
  } catch {
    return given ?? null;
  }
})();

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: {
      'x-kit-session': session ?? '',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.json();
}

function copyButton(text, label = 'Copy', cls = 'btn') {
  return el(
    'button',
    {
      class: cls,
      type: 'button',
      onclick: async (e) => {
        try {
          await navigator.clipboard.writeText(text);
          e.target.textContent = 'Copied';
        } catch {
          e.target.textContent = 'Select and copy';
        }
        setTimeout(() => {
          e.target.textContent = label;
        }, 1500);
      },
    },
    label,
  );
}

/** A file the page hands over (a ruleset to import), made here so nothing is fetched for it. */
function downloadButton({ name, text }) {
  return el(
    'button',
    {
      class: 'btn',
      type: 'button',
      onclick: () => {
        const a = el('a', {
          href: URL.createObjectURL(new Blob([text], { type: 'application/json' })),
          download: name,
        });
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      },
    },
    `Download ${name}`,
  );
}

const pictures = new Map();
/** The step's diagram, inlined so it follows the page's colours in light and dark. */
async function picture(src) {
  if (!pictures.has(src)) {
    pictures.set(
      src,
      fetch(`/page/${src}`)
        .then((r) => (r.ok ? r.text() : ''))
        .catch(() => ''),
    );
  }
  const box = el('div', { class: 'picture' });
  box.innerHTML = await pictures.get(src);
  return box;
}

function firstOpen() {
  return steps.find((s) => s.result.status !== 'pass' && !skipped.has(s.id))?.id ?? 'done';
}

function renderRail() {
  const rail = document.querySelector('nav.rail ol');
  rail.replaceChildren(
    ...steps.map((s, i) =>
      el(
        'li',
        {},
        el(
          'button',
          {
            type: 'button',
            'aria-current': s.id === current ? 'step' : false,
            onclick: () => show(s.id),
          },
          el(
            'span',
            { class: `mark ${s.result.status}`, 'aria-label': s.result.status },
            MARK[s.result.status],
          ),
          el('span', { class: 'title' }, `${i + 1}. ${s.title}`),
          skipped.has(s.id) ? el('span', { class: 'skipped' }, 'skipped') : null,
        ),
      ),
    ),
  );
  const done = steps.filter((s) => s.result.status === 'pass').length;
  document.querySelector('header .progress').textContent = `${done} of ${steps.length} done`;
}

const PROMPT_LABEL = 'Copy a prompt for Claude Code (recommended)';

/**
 * Started from Claude Code, handing the step to Claude is the first and recommended choice: the prompt
 * comes before the commands, as the page's primary button. Null when there is no prompt to offer.
 */
function recommendedBlock(prompt) {
  if (!claudeCode || !prompt) return null;
  return el(
    'div',
    { class: 'recommended' },
    el('p', {}, 'Recommended: paste this into Claude Code, and Claude does this step with you.'),
    copyButton(prompt, PROMPT_LABEL, 'btn primary'),
  );
}

/** A fix's runnable commands, or none when one is a placeholder (`<the URL it shows you>`). */
function runnable(fix) {
  const commands = fix.commands ?? [];
  return commands.length && !commands.some((c) => c.includes('<')) ? commands : null;
}

/**
 * The ways to run a fix's commands besides one by one: all of them as one line and, under Claude Code, that
 * line with `! ` to paste into its prompt. The prompt itself goes first, in recommendedBlock.
 */
function handoffBlock(fix) {
  const commands = runnable(fix);
  if (!commands) return null;
  const line = oneLine(commands);
  return [
    commands.length > 1
      ? el(
          'div',
          { class: 'cmd' },
          el('code', {}, line),
          copyButton(line, commands.length > 1 ? 'Copy as one line' : 'Copy'),
        )
      : null,
    claudeCode
      ? el('div', { class: 'buttons handoff' }, copyButton(`! ${line}`, 'Copy for Claude Code (!)'))
      : null,
  ];
}

function fixBlock(fix, s) {
  if (!fix) return null;
  const recommended = s ? recommendedBlock(claudePrompt({ title: s.title, result: s.result })) : null;
  return el(
    'div',
    { class: 'fix' },
    recommended,
    // When the fix is itself the prompt (step 6), the box above is the whole of it.
    recommended && !fix.forClaude ? el('p', { class: 'note' }, 'Or do it yourself:') : null,
    fix.text && !(recommended && fix.forClaude) ? el('p', {}, fix.text) : null,
    (fix.commands ?? []).map((c) => el('div', { class: 'cmd' }, el('code', {}, c), copyButton(c))),
    s ? handoffBlock(fix) : null,
    // A file to hand over (a ruleset) is long: its text stays folded away behind its download button.
    fix.copy && fix.download
      ? el(
          'details',
          {},
          el('summary', {}, 'Show the file'),
          el('div', { class: 'cmd' }, el('div', { class: 'copytext' }, fix.copy), copyButton(fix.copy)),
        )
      : // A prompt shown as the recommended choice above is not repeated here.
        fix.copy && !(recommended && fix.forClaude)
        ? el('div', { class: 'cmd' }, el('div', { class: 'copytext' }, fix.copy), copyButton(fix.copy))
        : null,
    fix.download ? el('p', {}, downloadButton(fix.download)) : null,
    fix.link
      ? /^https?:/.test(fix.link)
        ? el('p', {}, el('a', { href: fix.link, target: '_blank', rel: 'noopener' }, 'Open the page'))
        : // A path in this repository: the guide is running inside it, so name the file to open.
          el('p', {}, 'The full steps are in ', el('code', {}, fix.link), ', in this folder.')
      : null,
  );
}

function stagesBlock(stages) {
  if (!stages) return null;
  return el(
    'ol',
    { class: 'stages' },
    stages.map((s) =>
      el(
        'li',
        { class: s.done ? 'done' : '' },
        STAGE_WORDS[s.id] ?? s.id,
        s.done && IN_THE_LOOP.has(s.id)
          ? el('span', { class: 'loop' }, 'This is where you were in the loop.')
          : null,
      ),
    ),
  );
}

/**
 * Every button off and the result dimmed until the answer is back, and the pressed button says what is
 * happening: a round can take minutes (step 6 runs the project's checks), and a page that does not move
 * reads as broken (#18, snag 2). It also stops a second "Put the item on my board" asking for a second item.
 */
function busy(button, words) {
  const main = document.querySelector('main');
  for (const b of main.querySelectorAll('button')) b.disabled = true;
  main.setAttribute('aria-busy', 'true');
  main.querySelector('.result')?.classList.add('busy');
  if (button) button.textContent = words;
}

async function act(step, action, input, button) {
  busy(button, 'Working…');
  try {
    const answer = await api('/api/action', { step, action, input });
    steps = answer.steps;
    claudeCode = answer.claudeCode;
    lastAction = { step, result: answer.result };
    checkedAt = new Date();
  } catch (e) {
    alert(`That did not work: ${e.message}`);
  }
  document.querySelector('main').removeAttribute('aria-busy');
  render();
}

async function recheck(e) {
  busy(e?.currentTarget, 'Checking…');
  try {
    ({ steps, claudeCode } = await api('/api/state'));
    lastAction = null;
    checkedAt = new Date();
  } catch (err) {
    alert(`The guide could not check again: ${err.message}`);
  }
  document.querySelector('main').removeAttribute('aria-busy');
  render();
}

/**
 * Step 2's home online in one press: create an empty repository on GitHub, or connect one that is already
 * there and empty. The page shows what will be created before the button is pressed.
 */
function connectBlock(s) {
  const c = s.result.connect;
  const offered = new Set((s.actions ?? []).map((a) => a.id));
  if (!c || !offered.has('create')) return null;
  const owner = el(
    'select',
    { 'aria-label': 'Owner' },
    c.owners.map((o) => el('option', { value: o }, o)),
  );
  const name = el('input', { 'aria-label': 'Name', value: c.name, spellcheck: 'false' });
  const visibility = el(
    'select',
    { 'aria-label': 'Who can see it' },
    ['private', 'internal', 'public'].map((v) => el('option', { value: v }, v)),
  );
  const input = () => ({ owner: owner.value, name: name.value.trim(), visibility: visibility.value });
  const command = el('code', {});
  const what = el('p', { class: 'note' });
  const copies = el('div', { class: 'buttons handoff' });
  const recommended = el('div', {});
  const update = () => {
    const cmd = repoCreateCommand(input());
    command.textContent = cmd;
    what.textContent = `This creates ${input().owner}/${input().name} on GitHub, ${input().visibility} and empty, and connects this folder to it.`;
    recommended.replaceChildren(
      recommendedBlock(
        claudePrompt({ title: s.title, result: { summary: s.result.summary, fix: { commands: [cmd] } } }),
      ) ?? '',
    );
    copies.replaceChildren(
      copyButton(cmd),
      claudeCode ? copyButton(`! ${cmd}`, 'Copy for Claude Code (!)') : null,
    );
  };
  for (const f of [owner, name, visibility]) f.addEventListener('input', update);
  update();

  const existing = el('input', {
    'aria-label': 'Repository',
    placeholder: 'owner/name or its GitHub address',
  });
  return el(
    'div',
    { class: 'connect' },
    el('h3', {}, 'Create a new, empty repository'),
    el('div', { class: 'fields' }, owner, el('span', {}, '/'), name, visibility),
    el('div', { class: 'cmd' }, command),
    what,
    recommended,
    el(
      'div',
      { class: 'buttons' },
      el(
        'button',
        {
          // Under Claude Code the prompt above is the primary choice; the button is the second.
          class: claudeCode ? 'btn' : 'btn primary',
          type: 'button',
          onclick: (e) => act(s.id, 'create', input(), e.currentTarget),
        },
        'Create it on GitHub',
      ),
      copies,
    ),
    el('h3', {}, 'Or use an empty one you already have'),
    el(
      'p',
      { class: 'note' },
      'Only an empty one: the guide will not put this project on top of a repository that already has commits.',
    ),
    el(
      'div',
      { class: 'fields' },
      existing,
      el(
        'button',
        {
          class: 'btn',
          type: 'button',
          onclick: (e) => act(s.id, 'use', { repo: existing.value }, e.currentTarget),
        },
        'Connect it',
      ),
    ),
  );
}

/** The accepted risks, the notes, and the one-press changes a result carries, each under its own words. */
function extrasBlock(s) {
  const r = s.result;
  const offered = new Set((s.actions ?? []).map((a) => a.id));
  return [
    (r.notes ?? []).map((n) => el('p', { class: 'note' }, n)),
    r.apply?.length && offered.has('apply')
      ? el(
          'div',
          { class: 'apply' },
          el(
            'p',
            {},
            'Or press “Make these changes with my GitHub login” below, and the guide makes them for you:',
          ),
          el(
            'ul',
            {},
            r.apply.map((a) => el('li', {}, a)),
          ),
        )
      : null,
    r.accepted?.length
      ? el(
          'div',
          { class: 'accepted' },
          el('p', {}, 'Risks you accepted, recorded in docs/DECISIONS.md:'),
          el(
            'ul',
            {},
            r.accepted.map((a) => el('li', {}, a)),
          ),
        )
      : null,
    r.accept?.length && offered.has('accept')
      ? el(
          'div',
          { class: 'accept' },
          el(
            'p',
            {},
            'If one of these does not matter for your project, accept it. The guide writes it, with your reason, into docs/DECISIONS.md, and stops asking.',
          ),
          r.accept.map((p) =>
            el(
              'div',
              { class: 'cmd' },
              el('span', { class: 'copytext' }, p.text),
              el(
                'button',
                {
                  class: 'btn',
                  type: 'button',
                  onclick: (e) => {
                    const reason = prompt(`Why is this fine for your project?\n\n${p.text}`);
                    if (reason?.trim()) act(s.id, 'accept', { problem: p.id, reason }, e.currentTarget);
                  },
                },
                'Accept this risk',
              ),
            ),
          ),
        )
      : null,
    r.open?.length
      ? el(
          'div',
          { class: 'buttons' },
          r.open.map((id) => {
            const i = steps.findIndex((x) => x.id === id);
            return el(
              'button',
              { class: 'btn', type: 'button', onclick: () => show(id) },
              `Go to ${i + 1}. ${steps[i].title}`,
            );
          }),
        )
      : null,
  ];
}

/**
 * The demo step's watch: that one step only, and the next look only once this one has answered, so a slow
 * board never piles up requests. The full round (with the project's own checks) runs on load and on
 * "Check again", never on a timer.
 */
async function watchDemo() {
  try {
    const {
      steps: [fresh],
    } = await api('/api/state?step=demo');
    steps = steps.map((s) => (s.id === fresh.id ? fresh : s));
    if (current === 'demo') render();
  } catch {
    // Missed once; the next look is ten seconds away.
  }
  if (current === 'demo') poll = setTimeout(watchDemo, 10_000);
}

async function render() {
  renderRail();
  const s = steps.find((x) => x.id === current);
  const i = steps.indexOf(s);
  const r = s.result;
  const red = r.status !== 'pass' && !skipped.has(s.id);
  const options = s.id === 'ci' && r.options;

  const panel = [
    el('div', { class: 'label' }, `Step ${i + 1} of ${steps.length}`),
    el('h2', {}, s.title),
    el('p', { class: 'why' }, s.copy?.why ?? ''),
    s.copy?.picture ? await picture(s.copy.picture) : null,
    (s.copy?.body ?? []).map((p) => el('p', {}, p)),
    el(
      'div',
      { class: `result ${r.status}`, role: 'status' },
      el('p', { class: 'summary' }, `${MARK[r.status]} ${r.summary}`),
      r.detail && !r.open ? el('p', { class: 'detail' }, r.detail) : null,
      // Step 2's one-press home comes first when offered; the steps by hand follow it.
      connectBlock(s),
      r.connect && s.actions?.some((x) => x.id === 'create')
        ? el('h3', { class: 'byhand' }, 'Or by hand, in the browser')
        : null,
      fixBlock(r.fix, s),
      stagesBlock(r.stages),
      extrasBlock(s),
      lastAction?.step === s.id
        ? el(
            'p',
            { class: `answer ${lastAction.result.status}` },
            `${MARK[lastAction.result.status] ?? ''} ${lastAction.result.summary}`,
            lastAction.result.detail ? el('span', { class: 'detail' }, ` ${lastAction.result.detail}`) : null,
          )
        : null,
      checkedAt ? el('p', { class: 'checked' }, `Checked at ${checkedAt.toLocaleTimeString()}`) : null,
    ),
    options
      ? el(
          'div',
          { class: 'buttons' },
          options.map((m) =>
            el(
              'button',
              {
                class: 'btn',
                type: 'button',
                onclick: (e) => act('ci', 'set', { mode: m }, e.currentTarget),
              },
              `Use ${m}`,
            ),
          ),
        )
      : null,
    el(
      'div',
      { class: 'buttons' },
      el('button', { class: 'btn', type: 'button', onclick: recheck }, 'Check again'),
      // The CI modes, "Accept this risk" and step 2's two ways to a home are drawn beside what they act on.
      (s.actions ?? [])
        .filter((a) => !(s.id === 'ci' && a.id === 'set') && !['accept', 'create', 'use'].includes(a.id))
        .map((a) =>
          el(
            'button',
            { class: 'btn', type: 'button', onclick: (e) => act(s.id, a.id, undefined, e.currentTarget) },
            a.label,
          ),
        ),
      red && s.id !== 'done'
        ? el(
            'button',
            {
              class: 'btn',
              type: 'button',
              onclick: () => {
                skipped.add(s.id);
                show(firstOpen());
              },
            },
            'Skip this for now',
          )
        : null,
      i < steps.length - 1
        ? el(
            'button',
            { class: 'btn primary', type: 'button', disabled: red, onclick: () => show(steps[i + 1].id) },
            'Next',
          )
        : null,
    ),
  ];
  document.querySelector('main').replaceChildren(...panel.flat().filter((n) => n != null));

  // The demo moves on the board, not here: watch it only while it is on screen.
  clearTimeout(poll);
  poll = s.id === 'demo' ? setTimeout(watchDemo, 10_000) : null;
}

function show(id) {
  current = id;
  render();
  document.querySelector('main').focus();
}

(async () => {
  try {
    ({ steps, claudeCode } = await api('/api/state'));
    checkedAt = new Date();
  } catch (e) {
    document.querySelector('main').textContent =
      `The guide could not reach its server (${e.message}). Is pnpm kit:setup still running in your terminal?`;
    return;
  }
  show(firstOpen());
})();

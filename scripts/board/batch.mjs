// `create --batch <file>`: many work items from one file, in dependency order, safe to re-run (#36).
//
// The rules (the file format, the order, which edge is written where, the body) are pure and live in
// core.mjs, next to the other board rules. This is the part that talks to the board, kept out of
// work-items.mjs because that file runs `main()` when it is imported and so cannot be driven by the
// selftest, which is where the "a re-run after a failure creates no duplicate" promise is pinned.

import fs from 'node:fs';
import { BoardError } from './config.mjs';
import { batchBody, parseBatch, planBatch, RELEASE_LABEL, RELEASE_LABEL_COLOUR, releaseOf } from './core.mjs';

/**
 * Dry run unless `apply`. Returns an exit code.
 *
 * Writes go create, milestone, links, per entry, and stop at the first failure with the command that
 * resumes: the markers make a re-run skip what was created and fill in a skipped entry's missing milestone
 * and links, which it reads back rather than assumes. A `rate-limited` answer is waited out once.
 */
export async function cmdBatch(
  b,
  file,
  {
    apply = false,
    log = console.log,
    err = console.error,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  } = {},
) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    err(`cannot read ${file}: ${e.message}`);
    return 1;
  }
  const parsed = parseBatch(text);
  if (parsed.errors.length) return refuse(err, file, parsed.errors);
  const items = await b.listAll();
  const { steps, errors } = planBatch(parsed, items);
  if (errors.length) return refuse(err, file, errors);

  const resume = `pnpm items create --batch ${file} --apply`;
  const github = b.name === 'github';
  const byIid = new Map(items.map((i) => [i.iid, i]));
  const iidOf = new Map(steps.filter((s) => s.iid).map((s) => [s.key, s.iid]));
  const num = (r) => (r.startsWith('#') ? Number(r.slice(1)) : iidOf.get(r));
  const show = (r) => (r.startsWith('#') ? r : iidOf.has(r) ? `${r} (#${iidOf.get(r)})` : r);

  const toCreate = steps.filter((s) => !s.iid);
  log(
    `batch ${parsed.batch}: ${steps.length} entries, ${toCreate.length} to create, ` +
      `${steps.length - toCreate.length} already on the board`,
  );
  steps.forEach((s, i) => {
    log(
      `${String(i + 1).padStart(3)}. ${s.key}  ${s.iid ? `#${s.iid} already created` : 'create'} — ${s.title}`,
    );
    if (s.labels.length) log(`       labels ${s.labels.join(', ')}`);
    if (s.needs.length) log(`       depends on ${s.needs.map(show).join(', ')} (text, no hold)`);
    if (s.links.length) log(`       links to ${s.links.map(show).join(', ')} (a hold)`);
  });

  const releases = [
    ...new Set(steps.map((s) => releaseOf(s.iid ? byIid.get(s.iid).labels : s.labels).release)),
  ]
    .filter(Boolean)
    .sort();
  const milestones = new Map(releases.length ? (await b.milestones('all')).map((m) => [m.title, m.id]) : []);
  const missing = releases.filter((r) => !milestones.has(r));
  const labels = [...new Set(toCreate.flatMap((s) => s.labels).filter((l) => RELEASE_LABEL.test(l)))].sort();
  if (!apply) {
    for (const r of missing) log(`would create milestone ${r}`);
    if (labels.length) log(`would create label(s) ${labels.join(', ')} where missing`);
    log(`dry run: nothing written. Apply with: ${resume}`);
    return 0;
  }

  // Waited out once: a second refusal means the board wants a longer pause than this run should take.
  const write = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof BoardError && e.code === 'rate-limited')) throw e;
      const ms = e.retryAfterMs ?? 60_000;
      log(`rate-limited — waiting ${Math.ceil(ms / 1000)} s, once`);
      await sleep(ms);
      return fn();
    }
  };

  let current = 'labels and milestones';
  try {
    for (const l of labels) {
      if (await write(() => b.ensureLabel(l, ...RELEASE_LABEL_COLOUR))) log(`created label ${l}`);
    }
    for (const r of missing) {
      milestones.set(r, (await write(() => b.createMilestone(r))).id);
      log(`created milestone ${r}`);
    }

    for (const s of steps) {
      current = s.key;
      const links = s.links.map(num);
      let item;
      let have;
      if (s.iid) {
        // Created by an earlier run: the same fill-in below covers what that run may not have got to.
        item = byIid.get(s.iid);
        log(`${s.key} = #${s.iid}, created before`);
        have = new Set(links.length ? ((await b.links(s.iid)) ?? []).map((l) => l.iid) : []);
      } else {
        const description = batchBody(s, parsed.batch, {
          depends: s.needs.map(num),
          relates: github ? links : [],
        });
        item = await write(() => b.create({ title: s.title, description, labels: s.labels }));
        iidOf.set(s.key, item.iid);
        log(`${s.key} -> #${item.iid}  ${s.title}`);
        have = new Set(github ? links : []);
        for (const n of have) log(`       linked #${item.iid} <-> #${n} (in its body)`);
      }
      const { release } = releaseOf(item.labels);
      if (release && item.milestone?.title !== release) {
        await write(() => b.setMilestone(item.iid, milestones.get(release)));
        log(`       milestone ${release}`);
      }
      for (const n of links.filter((n) => !have.has(n))) {
        await write(() => b.link(item.iid, n));
        log(`       linked #${item.iid} <-> #${n}`);
      }
    }
  } catch (e) {
    err(`stopped at ${current}: ${e.message}`);
    err(`it may be partly written; nothing after it is. Fix the cause, then resume with: ${resume}`);
    return 1;
  }
  log(`batch ${parsed.batch}: done`);
  return 0;
}

function refuse(err, file, errors) {
  err(`${file}: nothing written —`);
  for (const e of errors) err(`  ${e}`);
  return 1;
}

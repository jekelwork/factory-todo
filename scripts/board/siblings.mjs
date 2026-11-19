// An item's linked siblings, each with its own computed state. Its own file, out of work-items.mjs (which
// runs `main()` on import), so the selftest can drive it through both adapters (#31).
import { classify, isConfidential, WITHHELD_WHY } from './core.mjs';

/**
 * The link records a judgement a line-distance heuristic cannot supply — *these two are one defect* — and
 * `advance-work-items` refuses to implement an item whose sibling is not also ready. That refusal needs the
 * sibling's STATE, not just its number, so it is resolved here rather than left to the caller.
 *
 * A confidential sibling keeps its iid, state and closed flag, which the hold reads, and shows
 * `(confidential)` for its title and a fixed `why`, which can name whoever replied, unless the caller was
 * allowed confidential items (`show <iid> --confidential`).
 */
export async function siblings(b, iid, meId, { allowConfidential = false } = {}) {
  const links = await b.links(iid);
  if (!links) return null;
  const out = [];
  for (const l of links) {
    const item = await b.get(l.iid);
    const comments = item.commentCount ? await b.comments(l.iid) : [];
    const { state, why } = classify(item, comments, meId);
    const hidden = isConfidential(item) && !allowConfidential;
    out.push({
      iid: l.iid,
      title: hidden ? '(confidential)' : item.title,
      state,
      why: hidden ? WITHHELD_WHY : why,
      closed: item.state === 'closed',
    });
  }
  return out.sort((x, y) => x.iid - y.iid);
}

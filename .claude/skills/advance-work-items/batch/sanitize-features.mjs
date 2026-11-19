// The pure half of release-notes-pdf.mjs (#271): which features may show their details. No I/O, no
// Playwright, Node builtins only, so `pnpm check:items` can assert it offline.

/** What a confidential feature must not carry. Its title is not listed: it is dropped, never refused. */
export const DETAIL_FIELDS = ['summary', 'points', 'screenshots', 'url', 'migration', 'novisual'];

const present = (v) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== '');

/**
 * `flagOf(iid)` is the item's `confidential` flag as GitLab reports it: true, false, or undefined when it
 * could not be read. Anything but an explicit false counts as confidential (fails closed), as does a
 * `"confidential": true` the author wrote. A confidential feature comes out as `#N (confidential)` and
 * nothing else; one that carried details is an error, so the author fixes the file rather than relying on
 * the script to hide what they wrote.
 */
export function sanitizeFeatures(features, flagOf) {
  const errors = [];
  const out = features.map((f) => {
    if (!Number.isInteger(f.iid)) {
      errors.push(`a feature has no numeric iid: ${JSON.stringify(f.title ?? f)}`);
      return { iid: 0, title: '(confidential)', confidential: true };
    }
    const confidential = f.confidential === true || flagOf(f.iid) !== false;
    if (!confidential) return f;
    const carried = DETAIL_FIELDS.filter((k) => present(f[k]));
    if (carried.length) errors.push(`#${f.iid} is confidential but carries ${carried.join(', ')}`);
    return { iid: f.iid, title: '(confidential)', confidential: true };
  });
  return { features: out, errors };
}

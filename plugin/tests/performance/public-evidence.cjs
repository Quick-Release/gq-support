// Evidence for B1 (plugin/tests/browser/performance.spec.ts) when a public page differs with Support
// on: sanitized copies of both pages and a bounded summary of the changed lines. The comparison
// itself runs on the raw pages; only these copies leave the run. A public page carries real
// WordPress and WooCommerce nonces, which the artifact scan (scripts/ci/scan-artifact.sh) rightly
// withholds, so each one becomes `<REDACTED>`: ten characters, so columns still line up.
// CommonJS, because Playwright loads the TypeScript specs as CommonJS.

// A nonce field's name, then up to 24 characters of quoting, escaping or URL encoding, then the
// nonce: ten hex characters. Covers `_wpnonce=`, `X-WP-Nonce:`, `"nonce":"`, `storeApiNonce: '`,
// its URL-encoded copy in the mini-cart's dependencies, and `createNonceMiddleware( "`.
const NONCE = /(nonce(?:middleware)?(?:%[0-9a-f]{2}|\\[\\'"]|amp;|[\s"'`:=(),&;]){1,24})[0-9a-f]{10}(?![0-9a-z])/gi;

/** @param {string} html */
exports.redactNonces = (html) => html.replace(NONCE, '$1<REDACTED>');

const MAX_LINES = 20;
const BEFORE = 120;
const AFTER = 240;

/** The first index where two strings differ, or -1. */
function firstDifference(a, b) {
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i++) if (a[i] !== b[i]) return i;
  return a.length === b.length ? -1 : length;
}

/** Up to BEFORE + AFTER characters of a sanitized line, around `at`. */
function excerpt(line, at) {
  const start = Math.max(0, at - BEFORE);
  const end = Math.min(line.length, at + AFTER);
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`;
}

/**
 * The lines that differ between the plugin-off and plugin-on pages: those between their common
 * first and last lines, at most MAX_LINES from each page, sanitized and cut around the change.
 * @param {string} offHtml
 * @param {string} onHtml
 */
exports.describeChange = (offHtml, onHtml) => {
  const off = offHtml.split('\n');
  const on = onHtml.split('\n');
  let head = 0;
  while (head < off.length && head < on.length && off[head] === on[head]) head++;
  if (head === off.length && head === on.length) return `No line differs (${off.length} lines).\n`;
  let tail = 0;
  while (tail < off.length - head && tail < on.length - head && off[off.length - 1 - tail] === on[on.length - 1 - tail]) tail++;
  const removed = off.slice(head, off.length - tail);
  const added = on.slice(head, on.length - tail);

  const out = [
    `Support off: ${off.length} lines; Support on: ${on.length} lines.`,
    `The first ${head} and last ${tail} lines match; nonces read <REDACTED>.`,
  ];
  const describe = (sign, lines, others) => {
    lines.slice(0, MAX_LINES).forEach((raw, i) => {
      const line = exports.redactNonces(raw);
      const other = others[i];
      let at = 0;
      let note = '';
      if (other !== undefined) {
        const sanitizedOther = exports.redactNonces(other);
        at = firstDifference(line, sanitizedOther);
        // Equal once sanitized: only a nonce changed. Redaction keeps lengths, so the raw index holds.
        if (at === -1) {
          at = firstDifference(raw, other);
          note = ' (differs only inside a redacted nonce)';
        }
      }
      out.push(`${sign} line ${head + i + 1}${note}, column ${at + 1}, ${raw.length} characters: ${excerpt(line, at)}`);
    });
    if (lines.length > MAX_LINES) out.push(`${sign} … ${lines.length - MAX_LINES} more changed lines`);
  };
  describe('-', removed, added);
  describe('+', added, removed);
  return `${out.join('\n')}\n`;
};

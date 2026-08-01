import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMark,
  markupTools,
  COPY_FIELD_TOOLS,
  STANDARD_MARKUP,
  STOREFRONT_MARKUP,
  CAMPAIGN_MARKUP,
  tokenizeInline,
  stripInline,
  type InlineToken,
} from '../src/markup';

/**
 * The editorial markup grammar. Two products render its tokens (a public
 * storefront with CSS classes, a campaign designer with inlined styles), so a
 * mistake here is a mistake on 93 live pages and in every email that ships.
 *
 * The specs are grouped by what they defend:
 *   1. the WRITER — what a toolbar button types, and where the caret lands;
 *   2. the READER — the token contract both renderers depend on;
 *   3. the GUARDS — the strings that made those guards necessary, all of them
 *      real: `{{first_name}}` from a mail merge, `Ranked #1 and #2` from a
 *      campaign, `2004 * Holden HSV GTS*` from an email that actually sent;
 *   4. the LEGACY EQUIVALENCE — the grammar reading today's stored copy exactly
 *      as the regexes it replaces did. That is the whole point of the step: the
 *      grammar grows, nothing published moves.
 */

// ── 1. The writer ──────────────────────────────────────────────────────────

test('bold wraps the selection and puts the caret inside the marks', () => {
  const r = applyMark('hello world', 6, 11, 'bold');
  assert.equal(r.text, 'hello **world**');
  assert.equal(r.text.slice(r.selectionStart, r.selectionEnd), 'world');
});

test('pressing the same button again unwraps', () => {
  const once = applyMark('hello world', 6, 11, 'bold');
  const twice = applyMark(once.text, once.selectionStart, once.selectionEnd, 'bold');
  assert.equal(twice.text, 'hello world');
  assert.equal(twice.text.slice(twice.selectionStart, twice.selectionEnd), 'world');
});

test('an empty selection inserts a placeholder, selected so typing replaces it', () => {
  const r = applyMark('', 0, 0, 'highlight');
  assert.equal(r.text, '==highlighted text==');
  assert.equal(r.text.slice(r.selectionStart, r.selectionEnd), 'highlighted text');
});

test('italic writes an underscore, never an asterisk', () => {
  // The asterisk means the accent colour in both products. If this ever
  // regresses to `*`, every italic press silently paints copy gold instead.
  assert.equal(applyMark('gold', 0, 4, 'italic').text, '_gold_');
});

test('the italic button does not unwrap an accent run', () => {
  // `*gold*` is an accent run, not italic. Toggling must leave it intact.
  const r = applyMark('*gold*', 1, 5, 'italic');
  assert.equal(r.text, '*_gold_*');
});

test('highlight round-trips', () => {
  const on = applyMark('for speed', 4, 9, 'highlight');
  assert.equal(on.text, 'for ==speed==');
  const off = applyMark(on.text, on.selectionStart, on.selectionEnd, 'highlight');
  assert.equal(off.text, 'for speed');
});

test('a copy field offers exactly four buttons, in toolbar order', () => {
  assert.deepEqual(
    markupTools(COPY_FIELD_TOOLS).map((t) => t.style),
    ['bold', 'italic', 'strike', 'highlight'],
  );
});

test('no copy-field button writes something an inline renderer cannot draw', () => {
  // A link or a list prefix would print literally in a storefront section and
  // in an email block, so the four must all be inline marks the grammar parses.
  const kinds = new Set(STANDARD_MARKUP.map((r) => r.kind));
  for (const style of COPY_FIELD_TOOLS) {
    assert.ok(kinds.has(style as never), `${style} has no parse rule`);
  }
});

// ── 2. The reader ──────────────────────────────────────────────────────────

const kinds = (t: InlineToken[]) => t.map((x) => `${x.kind}:${x.text}`);

test('tokens alternate and start and end with text, even when empty', () => {
  // The storefront wraps EVERY segment in a span, empty ones included, so this
  // shape is what keeps a published page byte-identical.
  assert.deepEqual(
    kinds(tokenizeInline('*a*', STOREFRONT_MARKUP)),
    ['text:', 'accent:a', 'text:'],
  );
  assert.deepEqual(
    kinds(tokenizeInline('*a**b*', STOREFRONT_MARKUP)),
    ['text:', 'accent:a', 'text:', 'accent:b', 'text:'],
  );
});

test('the four standard marks parse in both products', () => {
  for (const rules of [STOREFRONT_MARKUP, CAMPAIGN_MARKUP]) {
    assert.deepEqual(
      kinds(tokenizeInline('**b** _i_ ~~s~~ ==h==', rules)),
      ['text:', 'bold:b', 'text: ', 'italic:i', 'text: ', 'strike:s', 'text: ', 'highlight:h', 'text:'],
    );
  }
});

test('double asterisks are bold, not two accent runs', () => {
  assert.deepEqual(kinds(tokenizeInline('**b**', STOREFRONT_MARKUP)), ['text:', 'bold:b', 'text:']);
});

test('the campaign keeps its three legacy runs', () => {
  assert.deepEqual(
    kinds(tokenizeInline('#b# *a* [i]', CAMPAIGN_MARKUP)),
    ['text:', 'bold:b', 'text: ', 'accent:a', 'text: ', 'italic:i', 'text:'],
  );
});

test('the storefront has no legacy bold or italic run', () => {
  // `#…#` and `[…]` are campaign-only. On a page they are literal — and 88
  // production fields hold a hex colour like `#1b1b1b`.
  assert.deepEqual(
    kinds(tokenizeInline('#1b1b1b# [x]', STOREFRONT_MARKUP)),
    ['text:#1b1b1b# [x]'],
  );
});

test('strip returns the words a screen reader and a search engine should get', () => {
  assert.equal(stripInline('Built for ==speed== and *style*', STOREFRONT_MARKUP), 'Built for speed and style');
  assert.equal(stripInline('#Ten# years of [forged] wheels', CAMPAIGN_MARKUP), 'Ten years of forged wheels');
});

test('strip leaves an unpaired delimiter alone, so it matches what renders', () => {
  assert.equal(stripInline('50% * off', STOREFRONT_MARKUP), '50% * off');
});

// ── 3. The guards ──────────────────────────────────────────────────────────

test('a mail-merge line with two underscores is not italicised', () => {
  const line = 'Hi {{first_name}} {{last_name}}, your order shipped';
  assert.deepEqual(kinds(tokenizeInline(line, CAMPAIGN_MARKUP)), [`text:${line}`]);
});

test('an intraword underscore stays literal', () => {
  for (const s of ['snake_case_name', 'a_b', 'FILE_NAME_HERE']) {
    assert.deepEqual(kinds(tokenizeInline(s, STOREFRONT_MARKUP)), [`text:${s}`], s);
  }
});

test('an underscore that ENDS a word cannot open a run', () => {
  // Only the opening guard can refuse this one: the closing `_` is followed by a
  // space, which is a perfectly legal neighbour. Without the guard the copy
  // silently italicises " and tyres ".
  const s = 'Wheels_ and tyres _ in stock';
  assert.deepEqual(kinds(tokenizeInline(s, STOREFRONT_MARKUP)), [`text:${s}`]);
});

test('an underscore that STARTS a word cannot close a run', () => {
  // The mirror case, and only the closing guard can refuse it: the opening `_`
  // is at position 0, where there is nothing to its left to object to.
  assert.deepEqual(kinds(tokenizeInline('_a_b', STOREFRONT_MARKUP)), ['text:_a_b']);
  assert.deepEqual(kinds(tokenizeInline('_a_ b', STOREFRONT_MARKUP)), ['text:', 'italic:a', 'text: b']);
});

test('a non-ASCII word is treated as a word', () => {
  assert.deepEqual(kinds(tokenizeInline('汉_字_汉', STOREFRONT_MARKUP)), ['text:汉_字_汉']);
});

test('an underscore run with punctuation or space around it does italicise', () => {
  assert.deepEqual(
    kinds(tokenizeInline('read _this_ now', STOREFRONT_MARKUP)),
    ['text:read ', 'italic:this', 'text: now'],
  );
  assert.deepEqual(
    kinds(tokenizeInline('(_this_)', STOREFRONT_MARKUP)),
    ['text:(', 'italic:this', 'text:)'],
  );
});

test('rank markers do not bold, but a run that starts with a number does', () => {
  // Both `#`s are rejected: the first closes on a digit, the second never
  // closes. So the line is wholly literal — which is what the campaign parser
  // did, and why the guard sits on the CLOSING delimiter only.
  assert.deepEqual(kinds(tokenizeInline('Ranked #1 and #2', CAMPAIGN_MARKUP)), ['text:Ranked #1 and #2']);
  assert.deepEqual(kinds(tokenizeInline('Save #20%#', CAMPAIGN_MARKUP)), ['text:Save ', 'bold:20%', 'text:']);
  // …but a rank marker followed by a real run still pairs the way it always
  // has: the first close is rejected, the SECOND opening starts a run.
  assert.deepEqual(
    kinds(tokenizeInline('#a#1 and #b#', CAMPAIGN_MARKUP)),
    ['text:#a', 'bold:1 and ', 'text:b#'],
  );
});

test('a real sent email\'s stray asterisk parses as it did when it shipped', () => {
  // Nobody can infer the author's intent here; the point is that the grammar
  // does not change its mind about it.
  assert.deepEqual(
    kinds(tokenizeInline('2004 * Holden HSV GTS*  with #HAMMER# wheels', CAMPAIGN_MARKUP)),
    ['text:2004 ', 'accent: Holden HSV GTS', 'text:  with ', 'bold:HAMMER', 'text: wheels'],
  );
});

test('a bullet-looking line start is not a delimiter', () => {
  // 16 stored fields begin a line with `* `, including the correctly authored
  // `* North America*`. The grammar has no block rules at all, so a leading
  // `* ` can never become a list.
  assert.deepEqual(
    kinds(tokenizeInline('* North America*', STOREFRONT_MARKUP)),
    ['text:', 'accent: North America', 'text:'],
  );
});

test('an empty run is literal', () => {
  assert.deepEqual(kinds(tokenizeInline('**', STOREFRONT_MARKUP)), ['text:**']);
  assert.deepEqual(kinds(tokenizeInline('====', STOREFRONT_MARKUP)), ['text:====']);
});

// ── 4. Legacy equivalence ──────────────────────────────────────────────────

/** The storefront's parser before this change, frozen. */
const legacyStorefront = (v: string) => v.split(/\*([^*]+)\*/g);

/** The campaign's parser before this change, frozen — the whole-line pattern. */
const legacyCampaign = (v: string) => v.split(/(\*[^*]+\*|#[^#]+#(?![0-9])|\[[^\]]+\])/g);

/** Stored-copy shapes: the storefront's 704 live instances reduce to these, plus
 *  the awkward ones the census turned up. No new marker appears in any of them —
 *  that is why adding markers cannot move a published page. */
const STORED = [
  'Forged for *the long way round*',
  '*Every wheel* is built to order',
  'FusionForge® *precision*',
  'Line one\n*Line two*',
  'First paragraph.\n\nSecond *paragraph*.',
  '* North America*',
  '50% * off',
  '#1b1b1b',
  'Ranked #1 and #2',
  'a_b snake_case',
  'A = B, 100% == pure',
  'no marks at all',
  '*a**b*',
  '**',
  '*',
  '',
  'trailing *',
  '* leading',
  'Wheels, *tyres* and *packages*',
  '2004 * Holden HSV GTS*  with #HAMMER# wheels',
];

test('every stored shape tokenizes exactly as the storefront parser split it', () => {
  for (const s of STORED) {
    const before = legacyStorefront(s);
    const after = tokenizeInline(s, STOREFRONT_MARKUP).map((t) => t.text);
    assert.deepEqual(after, before, JSON.stringify(s));
  }
});

test('every stored shape tokenizes exactly as the campaign parser split it', () => {
  for (const s of STORED) {
    // The campaign parser runs per line, so compare line by line.
    for (const line of s.split('\n')) {
      const before = legacyCampaign(line).filter((seg) => seg !== undefined);
      const after = tokenizeInline(line, CAMPAIGN_MARKUP).map((t) => t.text);
      // The legacy split keeps a matched run WITH its delimiters; unwrap them
      // the way the renderer did, so the comparison is on the same values.
      const unwrapped = before.map((seg, i) => (i % 2 === 1 ? seg.slice(1, -1) : seg));
      assert.deepEqual(after, unwrapped, JSON.stringify(line));
    }
  }
});

test('the kind of every legacy run is unchanged', () => {
  // Same split, but also: `*` still means accent (not italic), `#` still bold,
  // `[…]` still italic. A swap here would repaint live copy.
  assert.deepEqual(
    kinds(tokenizeInline('*a* #b# [c]', CAMPAIGN_MARKUP)),
    ['text:', 'accent:a', 'text: ', 'bold:b', 'text: ', 'italic:c', 'text:'],
  );
});

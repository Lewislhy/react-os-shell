/**
 * Where the date-range panel opens (BG#00480).
 *
 * The panel used to be pinned to `right: 0`, so it always grew LEFTWARD from
 * the trigger. On the Customer window's Account Statement tab the trigger is
 * the first control in the filter bar, hard against the left edge of the window
 * body — and that body is `overflow-hidden`, so the overhang was not off to one
 * side, it was gone: no From box, no month/year header, no previous-month
 * arrow, and nothing to scroll to reach them. "The view is only the half
 * portion. I can't select properly the date that I want." Maximising did not
 * help, because the trigger stays pinned to the edge that moves.
 *
 * It is a continuum, not a two-screen bug: the same clip hits any trigger whose
 * distance from the clipping container's left edge is less than the panel's
 * width — the customer and supplier ProductionProgressList filter bars put the
 * picker one `w-56` search box in, which with no dates set renders the short
 * "Date Range" placeholder.
 *
 * jsdom does no layout, so every rect is zero and the placement logic would
 * read nothing. The geometry is therefore supplied here, per element, by
 * selector. That is the honest shape of the test: the component's job is not to
 * measure, it is to DECIDE, and what it decides is asserted on the one thing
 * that reaches the browser — the inline `left`/`right` on the panel.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render, act } from './dom';
import DateRangePicker from '../src/forms/DateRangePicker';

/** A stubbed horizontal geometry, applied to the first selector that matches. */
interface Rect { selector: string; left: number; width: number }

let RECTS: Rect[] = [];

// Node's runner gives each spec file its own process, so patching the
// prototype here cannot leak into another file.
window.HTMLElement.prototype.getBoundingClientRect = function stubRect(this: HTMLElement) {
  const hit = RECTS.find((r) => this.matches(r.selector));
  const left = hit ? hit.left : 0;
  const width = hit ? hit.width : 0;
  return {
    x: left, y: 0, left, right: left + width, width,
    top: 0, bottom: 0, height: 0, toJSON: () => ({}),
  } as DOMRect;
};

/** The panel's real width in a browser, near enough. The COMPONENT measures. */
const PANEL_WIDTH = 460;

/** The shell window's body, spanning 100 … 1000. */
const BODY_LEFT = 100;
const BODY_WIDTH = 900;

/**
 * Mount the picker inside a fixed box that CLIPS, with the trigger at
 * `triggerLeft`, and hand back the panel's inline placement once opened.
 *
 * `overflow` is written as the shorthand because that is what Tailwind's
 * `overflow-hidden` compiles to and jsdom does not expand it into `overflow-x`
 * — the component has to read both spellings.
 */
function place(opts: { triggerLeft: number; triggerWidth: number; bodyWidth?: number }) {
  RECTS = [
    { selector: '[role="dialog"]', left: 0, width: PANEL_WIDTH },
    { selector: '.relative', left: opts.triggerLeft, width: opts.triggerWidth },
    { selector: '[data-spec="window-body"]', left: BODY_LEFT, width: opts.bodyWidth ?? BODY_WIDTH },
  ];
  const { container, unmount } = render(
    <div data-spec="window-body" style={{ overflow: 'hidden' }}>
      <DateRangePicker from="" to="" onChange={() => {}} />
    </div>,
  );
  const trigger = container.querySelector('button[aria-haspopup="dialog"]') as HTMLElement;
  assert.ok(trigger, 'trigger button is rendered');
  act(() => { trigger.click(); });
  const panel = container.querySelector('[role="dialog"]') as HTMLElement;
  assert.ok(panel, 'panel opens');
  return { left: panel.style.left, right: panel.style.right, unmount };
}

test('a trigger at the left of the window opens the panel rightward', () => {
  // Johna's case: first control in the filter bar, 8px in from the body edge.
  const { left, right, unmount } = place({ triggerLeft: BODY_LEFT + 8, triggerWidth: 140 });
  assert.equal(left, '0px', 'panel hangs off the LEFT edge of the trigger');
  assert.equal(right, '', 'and is not pinned right');
  unmount();
});

test('a trigger at the right of a toolbar keeps opening leftward', () => {
  // What the original `right: 0` was protecting: 880 + 460 runs past 1000.
  const { left, right, unmount } = place({ triggerLeft: 880, triggerWidth: 100 });
  assert.equal(right, '0px', 'panel hangs off the RIGHT edge of the trigger');
  assert.equal(left, '', 'and is not pinned left');
  unmount();
});

test('a trigger one search box in from the left still opens rightward', () => {
  // The customer/supplier ProductionProgressList bars: a `w-56` input and a
  // `gap-3` ahead of the picker. Right-aligned, this clipped too.
  const { left, unmount } = place({ triggerLeft: BODY_LEFT + 12 + 224 + 12, triggerWidth: 130 });
  assert.equal(left, '0px');
  unmount();
});

test('a container narrower than the panel keeps the dates end visible', () => {
  // Neither alignment fits. Left wins: the half worth keeping is the one with
  // the From/To boxes and the calendar header in it.
  const { left, unmount } = place({ triggerLeft: BODY_LEFT + 8, triggerWidth: 140, bodyWidth: 300 });
  assert.equal(left, '0px');
  unmount();
});

test('with nothing clipping, the panel is placed against the viewport', () => {
  // No overflow ancestor: the fallback bound is `window.innerWidth`, and a
  // trigger sitting near it still has to flip.
  RECTS = [
    { selector: '[role="dialog"]', left: 0, width: PANEL_WIDTH },
    { selector: '.relative', left: window.innerWidth - 160, width: 140 },
  ];
  const { container, unmount } = render(
    <div><DateRangePicker from="" to="" onChange={() => {}} /></div>,
  );
  const trigger = container.querySelector('button[aria-haspopup="dialog"]') as HTMLElement;
  act(() => { trigger.click(); });
  const panel = container.querySelector('[role="dialog"]') as HTMLElement;
  assert.equal(panel.style.right, '0px');
  unmount();
});

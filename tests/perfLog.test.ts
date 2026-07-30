import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendRecord,
  summariseLog,
  toCsv,
  isInteracting,
  classifyActivity,
  MIN_GROUP_SAMPLES,
  MIN_EVENT_SAMPLES,
  type PerfLogRecord,
} from '../src/shell/perfLog';

/** A quiet, smooth sample. Tests vary only the axis under test. */
const rec = (over: Partial<PerfLogRecord> = {}): PerfLogRecord => ({
  t: 0,
  fps: 60,
  frameMs: 16.7,
  worstMs: 18,
  blockedPct: 0,
  heapMB: 100,
  verdict: 'smooth',
  windows: 0,
  active: null,
  clicks: 0,
  keys: 0,
  scrolls: 0,
  dragMs: 0,
  menus: 0,
  submenus: 0,
  menuKey: null,
  moveMs: 0,
  resizeMs: 0,
  ...over,
});

/** n samples sharing a shape, stamped with increasing time. */
const many = (n: number, over: Partial<PerfLogRecord> = {}): PerfLogRecord[] =>
  Array.from({ length: n }, (_, i) => rec({ t: i * 500, ...over }));

test('appending past the cap drops the oldest and keeps the newest', () => {
  let log: PerfLogRecord[] = [];
  for (let i = 0; i < 10; i++) log = appendRecord(log, rec({ t: i }), 4);
  assert.equal(log.length, 4);
  assert.deepEqual(log.map(r => r.t), [6, 7, 8, 9]);
});

test('appending never mutates the array it was given', () => {
  // The caller holds this across renders; mutating in place would let a stale
  // reference silently diverge from what was logged.
  const original = [rec({ t: 1 })];
  const next = appendRecord(original, rec({ t: 2 }));
  assert.equal(original.length, 1);
  assert.equal(next.length, 2);
});

test('any input at all counts as interacting', () => {
  assert.equal(isInteracting(rec()), false);
  for (const axis of ['clicks', 'keys', 'scrolls', 'dragMs', 'menus', 'submenus', 'moveMs', 'resizeMs'] as const) {
    assert.equal(isInteracting(rec({ [axis]: 1 })), true, axis);
  }
});

test('a hover-opened flyout is interaction, not idle', () => {
  // The regression this axis exists for: opening a submenu by hover fires no
  // click and no keypress, so the frame it painted on used to be filed as
  // idle — diluting the one bucket that is supposed to mean "at rest" with
  // the exact samples someone opened the HUD to find.
  assert.equal(isInteracting(rec({ submenus: 1 })), true);
  assert.equal(classifyActivity(rec({ submenus: 1 })), 'submenu');
});

test('a sample is filed under its most expensive gesture, not its incidental click', () => {
  // Opening a flyout involves a click and a pointer move too. Filing that
  // sample under "click" would point at the wrong thing.
  assert.equal(classifyActivity(rec({ submenus: 1, menus: 1, clicks: 2, dragMs: 40 })), 'submenu');
  assert.equal(classifyActivity(rec({ menus: 1, clicks: 1 })), 'menu');
  assert.equal(classifyActivity(rec({ moveMs: 200, resizeMs: 300, dragMs: 500, clicks: 1 })), 'resize');
  assert.equal(classifyActivity(rec({ moveMs: 200, dragMs: 200, clicks: 1 })), 'move');
  assert.equal(classifyActivity(rec({ scrolls: 3, clicks: 1 })), 'scroll');
  assert.equal(classifyActivity(rec({ keys: 3, clicks: 1 })), 'type');
  assert.equal(classifyActivity(rec({ clicks: 1 })), 'click');
  assert.equal(classifyActivity(rec()), 'idle');
});

test('the activity breakdown ranks the slowest gesture first', () => {
  const summary = summariseLog([
    ...many(MIN_EVENT_SAMPLES, { fps: 59 }),
    ...many(MIN_EVENT_SAMPLES, { fps: 48, moveMs: 480, dragMs: 480 }),
    ...many(MIN_EVENT_SAMPLES, { fps: 14, submenus: 1, menuKey: 'Inventory' }),
  ]);
  assert.deepEqual(
    summary.byActivity.map(a => [a.kind, a.medianFps]),
    [['submenu', 14], ['move', 48], ['idle', 59]],
  );
});

test('menu and gesture groups report from a lower floor than window groups', () => {
  // A flyout opens inside one 500ms interval, not across twenty. Holding these
  // to the window floor would suppress exactly the findings they exist for.
  const log = many(MIN_EVENT_SAMPLES, { fps: 12, submenus: 1, menuKey: 'Inventory' });
  assert.ok(MIN_EVENT_SAMPLES < MIN_GROUP_SAMPLES);
  assert.equal(summariseLog(log).worstMenus[0].key, 'Inventory');
  assert.deepEqual(summariseLog(many(1, { submenus: 1, menuKey: 'Inventory' })).worstMenus, []);
});

test('the slowest menu names itself, worst first', () => {
  const summary = summariseLog([
    ...many(MIN_EVENT_SAMPLES, { menuKey: 'start', menus: 1, fps: 57 }),
    ...many(MIN_EVENT_SAMPLES, { menuKey: '/inventory/stock-on-hand', submenus: 1, fps: 15 }),
  ]);
  assert.equal(summary.worstMenus[0].key, '/inventory/stock-on-hand');
  assert.equal(summary.worstMenus[0].medianFps, 15);
});

test('a group keeps the worst frame it contains, even from a stalled sample', () => {
  // The whole point of a group of brief interactions: one 380ms frame barely
  // moves a median but is precisely what the user saw and reported.
  const summary = summariseLog([
    ...many(MIN_EVENT_SAMPLES, { submenus: 1, fps: 55, worstMs: 20 }),
    ...many(MIN_EVENT_SAMPLES, { submenus: 1, fps: 0, worstMs: 380, verdict: 'cpu' }),
  ]);
  const submenu = summary.byActivity.find(a => a.kind === 'submenu');
  assert.equal(submenu?.worstMs, 380);
  assert.equal(submenu?.stalls, MIN_EVENT_SAMPLES);
  // The stall is counted, never averaged into a frame rate the display never showed.
  assert.equal(submenu?.medianFps, 55);
});

test('an empty log summarises to zeroes rather than throwing', () => {
  const summary = summariseLog([]);
  assert.equal(summary.samples, 0);
  assert.equal(summary.medianFps, 0);
  assert.deepEqual(summary.byWindowCount, []);
  assert.deepEqual(summary.worstWindows, []);
  assert.equal(summary.interacting, null);
});

test('the idle/interacting split is the headline comparison', () => {
  const summary = summariseLog([
    ...many(MIN_GROUP_SAMPLES, { fps: 60 }),
    ...many(MIN_GROUP_SAMPLES, { fps: 20, clicks: 3 }),
  ]);
  assert.equal(summary.idle?.medianFps, 60);
  assert.equal(summary.interacting?.medianFps, 20);
});

test('a group below the sample floor is withheld, not reported thinly', () => {
  // One unlucky reading is not a finding. Reporting it would send someone off
  // to optimise a window on the strength of a single frame.
  const summary = summariseLog([
    ...many(MIN_GROUP_SAMPLES, { fps: 60 }),
    ...many(MIN_GROUP_SAMPLES - 1, { fps: 5, clicks: 1 }),
  ]);
  assert.equal(summary.interacting, null);
  assert.notEqual(summary.idle, null);
});

test('frame rate is bucketed by window count, ascending', () => {
  const summary = summariseLog([
    ...many(MIN_GROUP_SAMPLES, { windows: 1, fps: 60 }),
    ...many(MIN_GROUP_SAMPLES, { windows: 6, fps: 24 }),
  ]);
  assert.deepEqual(
    summary.byWindowCount.map(b => [b.windows, b.medianFps]),
    [[1, 60], [6, 24]],
  );
});

test('the slowest window names itself, worst first', () => {
  const summary = summariseLog([
    ...many(MIN_GROUP_SAMPLES, { active: 'page:dashboard', fps: 58 }),
    ...many(MIN_GROUP_SAMPLES, { active: 'page:sales-invoice', fps: 18 }),
  ]);
  assert.equal(summary.worstWindows[0].key, 'page:sales-invoice');
  assert.equal(summary.worstWindows[0].medianFps, 18);
});

test('a stalled sample counts as CPU-bound but never lands in a frame-rate median', () => {
  // fps 0 means the thread was too blocked to deliver frames. Averaging that
  // in would report a frame rate the display never actually showed, so it
  // shapes verdictShare and nothing else.
  const summary = summariseLog([
    ...many(MIN_GROUP_SAMPLES, { fps: 30 }),
    ...many(MIN_GROUP_SAMPLES, { fps: 0, verdict: 'cpu', blockedPct: 100 }),
  ]);
  assert.equal(summary.medianFps, 30);
  assert.equal(summary.verdictShare.cpu, 0.5);
  assert.equal(summary.verdictShare.smooth, 0.5);
});

test('the worst frame survives even when its own sample is unmeasurable', () => {
  const summary = summariseLog([rec({ worstMs: 20 }), rec({ fps: 0, worstMs: 480 })]);
  assert.equal(summary.worstFrameMs, 480);
});

test('median takes the middle, not the mean an outlier would drag', () => {
  const summary = summariseLog(
    [10, 60, 60, 60, 1000].map((fps, i) => rec({ fps, t: i * 500 })),
  );
  assert.equal(summary.medianFps, 60);
});

test('CSV escapes a window key containing a comma or a quote', () => {
  // Window keys are app-supplied text; an unescaped one silently shifts every
  // later column and quietly corrupts the export.
  const csv = toCsv([rec({ active: 'page:invoice, draft' }), rec({ active: 'say "hi"' })]);
  const [header, ...rows] = csv.split('\n');
  assert.match(header, /^t,fps,/);
  assert.match(rows[0], /"page:invoice, draft"/);
  assert.match(rows[1], /"say ""hi"""/);
});

test('a null column exports as empty, not as the string "null"', () => {
  const csv = toCsv([rec({ blockedPct: null, heapMB: null, active: null })]);
  assert.doesNotMatch(csv, /null/);
});

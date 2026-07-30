import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setPerfCollecting,
  markMenuOpen,
  beginWindowGesture,
  drainPerfEvents,
} from '../src/shell/perfEvents';

/** Module state is global by design (the marks come from all over the shell),
 *  so every test starts from a known-clean slate. */
const collecting = (): void => { setPerfCollecting(false); setPerfCollecting(true); };

test('marks accumulate only while the HUD is collecting', () => {
  // A counter climbing since page load would hand a morning's worth of menu
  // opens to whichever 500ms interval happened to drain it first.
  setPerfCollecting(false);
  markMenuOpen('menu', 'start');
  markMenuOpen('submenu', 'Inventory');
  assert.deepEqual(drainPerfEvents(), { menus: 0, submenus: 0, menuKey: null, moveMs: 0, resizeMs: 0 });
});

test('opening the HUD discards whatever was already counted', () => {
  collecting();
  markMenuOpen('menu', 'start');
  setPerfCollecting(true);
  assert.equal(drainPerfEvents().menus, 0);
});

test('menu layers are counted apart and the last one is named', () => {
  collecting();
  markMenuOpen('menu', 'start');
  markMenuOpen('submenu', 'Inventory');
  markMenuOpen('submenu', '/inventory/stock-on-hand');
  const counts = drainPerfEvents();
  assert.equal(counts.menus, 1);
  assert.equal(counts.submenus, 2);
  assert.equal(counts.menuKey, '/inventory/stock-on-hand');
});

test('draining starts a fresh interval', () => {
  collecting();
  markMenuOpen('menu', 'start');
  drainPerfEvents();
  assert.deepEqual(drainPerfEvents(), { menus: 0, submenus: 0, menuKey: null, moveMs: 0, resizeMs: 0 });
});

test('a window gesture credits its own axis for as long as it ran', () => {
  collecting();
  const endMove = beginWindowGesture('move');
  const endResize = beginWindowGesture('resize');
  endMove();
  endResize();
  const counts = drainPerfEvents();
  assert.ok(counts.moveMs >= 0);
  assert.ok(counts.resizeMs >= 0);
  // The axes are separate: a resize must never be reported as a move.
  assert.equal(drainPerfEvents().moveMs, 0);
});

test('ending a gesture twice adds its span once', () => {
  // `beginPointerGesture` returns an idempotent cleanup that pointerup,
  // pointercancel and unmount may all call.
  collecting();
  const end = beginWindowGesture('move');
  const start = performance.now();
  while (performance.now() - start < 2) { /* spin briefly so the span is measurable */ }
  end();
  const once = drainPerfEvents().moveMs;
  end();
  assert.ok(once > 0);
  assert.equal(drainPerfEvents().moveMs, 0);
});

test('a gesture that outlives the HUD does not seed the next session', () => {
  collecting();
  const end = beginWindowGesture('move');
  setPerfCollecting(false);
  end();
  setPerfCollecting(true);
  assert.equal(drainPerfEvents().moveMs, 0);
  setPerfCollecting(false);
});

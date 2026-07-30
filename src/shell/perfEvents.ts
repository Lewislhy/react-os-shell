/**
 * Shell interaction marks, folded into every perf-log record.
 *
 * The HUD can see that frames were dropped and it can see that the pointer
 * moved, but "the pointer moved" covers wandering across the desktop and
 * opening a third-level flyout, and only one of those repaints a frosted
 * surface. The first version of the log conflated them, so the readings that
 * mattered most — the frame the start menu opened on, the frame a window was
 * dragged across — arrived indistinguishable from an idle mouse. A report full
 * of anonymous samples points at nothing.
 *
 * So the places that do the expensive things say so. Menus mark themselves when
 * they open; window drags and resizes mark themselves for as long as they run.
 * Everything here is a plain counter drained once per flush interval — no
 * subscriptions, no allocation per event, nothing that would make marking an
 * event cost more than the event.
 *
 * Marks accumulate only while the HUD is mounted (`setPerfCollecting`). That is
 * not really about cost — incrementing a number is free — but about honesty: a
 * counter that had been climbing since page load would attribute a morning's
 * worth of menu opens to whichever 500ms interval happened to drain it first.
 */

/** Which menu layer opened. The distinction is the point: the root menu is one
 *  surface appearing, a flyout is a second one appearing *over* it, and the
 *  cost of the second is what people report. */
export type MenuLayer = 'menu' | 'submenu';

/** One flush interval's worth of marks. */
export interface PerfEventCounts {
  /** Root start-menu opens. */
  menus: number;
  /** Flyout opens — the 2nd- and 3rd-level menus. */
  submenus: number;
  /** The last menu or flyout opened, so a slow one can be named rather than
   *  merely counted. Null when no menu opened during the interval. */
  menuKey: string | null;
  /** Milliseconds spent dragging a window by its title bar. */
  moveMs: number;
  /** Milliseconds spent dragging a window's resize handle. */
  resizeMs: number;
}

const empty = (): PerfEventCounts => ({ menus: 0, submenus: 0, menuKey: null, moveMs: 0, resizeMs: 0 });

let collecting = false;
let counts = empty();

/** Shared no-op, so a gesture that starts while the HUD is closed allocates
 *  nothing at all. */
const NOOP = () => {};

/** Start or stop accumulating. Both directions reset — see the module
 *  docstring on why a stale count is worse than no count. */
export function setPerfCollecting(on: boolean): void {
  collecting = on;
  counts = empty();
}

/** Record that a menu surface opened. `key` names it (a section label, a route)
 *  so the summary can rank flyouts against each other. */
export function markMenuOpen(layer: MenuLayer, key: string): void {
  if (!collecting) return;
  if (layer === 'submenu') counts.submenus++;
  else counts.menus++;
  counts.menuKey = key;
}

/**
 * Record a window drag or resize for as long as it runs. Returns the end
 * function; calling it twice adds the span once.
 *
 * Duration rather than a count because these are the gestures whose *cost is
 * their length* — a drag that stutters for four seconds and a drag that lasted
 * one frame are the same event and very different reports. The span is credited
 * to the interval it ends in, which can straddle a flush boundary; that is
 * accepted rather than apportioned, because a drag long enough to straddle two
 * intervals is already the thing being investigated.
 */
export function beginWindowGesture(kind: 'move' | 'resize'): () => void {
  if (!collecting) return NOOP;
  const startedAt = performance.now();
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    // The HUD may have been closed mid-gesture, which reset the counters.
    // Adding to them now would seed the next session with a stale span.
    if (!collecting) return;
    const elapsed = performance.now() - startedAt;
    if (kind === 'move') counts.moveMs += elapsed;
    else counts.resizeMs += elapsed;
  };
}

/** Take the accumulated marks and start a fresh interval. */
export function drainPerfEvents(): PerfEventCounts {
  const drained = counts;
  counts = empty();
  return drained;
}

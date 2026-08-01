/**
 * Staging channels for app-mounted windows.
 *
 * ## The pattern this exists for
 *
 * Most windows are opened through `WindowManager` (`openEntity` / `openPage`),
 * which knows how to reuse one that is already open and bring it forward. But
 * some windows aren't opened at all — they are mounted once, for the life of the
 * session, and merely RETARGETED: one form builder that every "Edit form" entry
 * point points at, one media picker every slot borrows, one Edit Coupon window
 * per list. The host stays mounted and swaps what it is showing.
 *
 * That third kind used to have a hole in it. The window rose when it was first
 * created, because creating it is a mount and `Modal` raises a fresh mount. It
 * did NOT rise when it was asked for again, because asking again only changed
 * some content — and no amount of content changing is distinguishable, from
 * inside the shell, from a re-render. So a window that was already open but
 * buried under another one stayed buried, and the button that opened it read as
 * dead.
 *
 * ## Why the fix lives here and not at the call sites
 *
 * The shell could have exported "raise this window" and asked every button to
 * remember to call it. The four hand-written copies of this channel that this
 * module replaces are the argument against that: each carried a comment saying
 * it mirrored the others so they could not drift apart, and they had drifted
 * anyway — only one of the four had thought to make a repeat staging of the
 * SAME target observable. A rule that four call sites must remember is a rule
 * three of them will forget.
 *
 * So the ask is built into the channel. `set()` is the only way to show one of
 * these windows, and `set()` brings it forward.
 *
 * ## The two halves, and why they cannot be confused
 *
 * A window must come forward when it is asked for, and must NEVER come forward
 * on its own. Those pull against each other, and the separation here is
 * structural rather than a matter of care:
 *
 *   - The raise is emitted from exactly one place — `set()`, an imperative
 *     "show this" call. There is no path from rendering to raising. A window
 *     that refetches, re-renders, receives a socket push or resolves a query
 *     has no way to reach that line, so it cannot leap in front of somebody
 *     typing in another window. Somebody has to ask.
 *   - `set(null)` is a close, and closes never raise.
 *
 * Note what this deliberately does NOT do: gate the raise on a browser user
 * gesture. That reads like a stronger guarantee and is in fact a worse one —
 * a real user-initiated open can arrive without a gesture attached (an embedded
 * editor asking its host for a window relays the click through `postMessage`,
 * which lands in a plain listener with no activation), and the window would then
 * silently fail to rise for the one entry point that is hardest to test. The
 * contract is `set()` means the user asked; a caller staging a target for any
 * other reason says so with `{ raise: false }`.
 */
import { useSyncExternalStore } from 'react';

import { cancelWindowFront, requestWindowFront } from './Modal';

/**
 * A target as the window receives it: what was asked for, plus the stamp that
 * makes THIS staging distinct from the last one.
 *
 * The stamp is not decoration. Without it, staging is only observable when the
 * target's contents change — so asking for the window that is already showing
 * exactly what you asked for would be a no-op, and "New form" on top of an open
 * blank form would neither reset it nor (before this module) raise it. Callers
 * never set `nav`; staging does.
 */
export type StagedTarget<T> = T & { readonly nav: number };

export interface WindowTargetOptions {
  /**
   * Whether staging this target should also bring the window forward.
   * Defaults to `true`, because staging a target is how the product says
   * "the user asked to see this".
   *
   * Pass `false` for the rare staging that is not a request to be looked at —
   * restoring a session's window state on load, say, where several windows are
   * re-staged at once and none of them was just asked for.
   */
  raise?: boolean;
}

export interface WindowTarget<T> {
  /** The stable key the window's `Modal` must be given, so the shell can find
   *  it to raise. Read it straight off the channel:
   *  `<Modal windowKey={myTarget.windowKey}>`. */
  readonly windowKey: string;
  /** Point the window at something — or `null` to close it. A non-null target
   *  also brings the window forward, whether it was closed, open and buried, or
   *  already showing this very thing. */
  set(target: T | null, options?: WindowTargetOptions): void;
  /** What is staged right now (`null` if nothing) — for readers outside React. */
  get(): StagedTarget<T> | null;
  /** Watch for stagings. Returns its own unsubscribe. */
  subscribe(listener: () => void): () => void;
}

/**
 * Create the staging channel for one app-mounted window.
 *
 * `windowKey` identifies the window to the shell and must match the `windowKey`
 * given to that window's `Modal`. Use a stable, namespaced string — it also
 * becomes the key the window's position and stacking order are remembered
 * under, so it outlives a page refresh.
 */
export function createWindowTarget<T extends object>(windowKey: string): WindowTarget<T> {
  let current: StagedTarget<T> | null = null;
  let nav = 0;
  const listeners = new Set<() => void>();

  const emit = () => { listeners.forEach((fn) => fn()); };

  return {
    windowKey,
    set(target, options) {
      if (target === null) {
        current = null;
        // Withdraw an ask that nothing ever mounted to honour. Staging and
        // then immediately clearing (an editor request cancelled before the
        // window rendered) would otherwise leave the request in the shell to
        // be claimed by the next, unrelated open.
        cancelWindowFront(windowKey);
        emit();
        return;
      }
      current = { ...target, nav: ++nav };
      emit();
      if (options?.raise !== false) requestWindowFront(windowKey);
    },
    get() { return current; },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/**
 * Read the staged target inside the window's host component, re-rendering
 * whenever a new one is staged — including a fresh staging of an identical
 * target, which `nav` makes a distinct value.
 *
 * Replaces the `useState` + `useEffect(subscribe)` pair every hand-written
 * version of this channel used to carry, and closes that pair's own gap: it
 * reads the currently-staged target during render rather than after mount, so a
 * host mounted while something is already staged shows it on its first frame.
 */
export function useWindowTarget<T extends object>(target: WindowTarget<T>): StagedTarget<T> | null {
  return useSyncExternalStore(target.subscribe, target.get, target.get);
}

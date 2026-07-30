/**
 * Asking for a window that is already open.
 *
 * The complaint this covers is entirely about z-order, so every spec here ends
 * in the same assertion: after the ask, is that window the frontmost one?
 * `getActiveModalId` reads the last element of the shell's activation order,
 * which is what `Modal` renders its z-index from — so it is the same fact the
 * user sees, not a proxy for it.
 *
 * The specs are written against the module functions rather than a rendered
 * `<Modal>` on purpose, following `UndoProvider.test.tsx`: the activation order
 * is module-level state, `mountModal` is exactly what a `Modal` calls as it
 * mounts, and driving it directly is the difference between a spec that
 * exercises the mechanism and one that exercises a mock of it. The one spec
 * that genuinely needs React — does the host re-render when the same target is
 * staged twice — renders a real component in a real DOM.
 *
 * Every spec below fails on 4.3.1.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
// First, and before anything that touches `src/` — `dom.ts` installs the
// globals that `Modal.tsx` reads as it evaluates.
import { act, render } from './dom';
import {
  activateModal,
  deactivateAllModals,
  getActiveModalId,
  mountModal,
  requestWindowFront,
  unmountModal,
} from '../src/shell/Modal';
import { createWindowTarget, useWindowTarget } from '../src/shell/windowTarget';

/**
 * Open a window the way `Modal` does — a private per-mount id, registered
 * against the stable `windowKey` the shell knows it by. Going through the real
 * `mountModal` is the point: the hand-off between those two id spaces is where
 * a deferred open request is claimed.
 */
let seq = 0;
function openWindow(windowKey: string) {
  const modalId = `modal-test-${++seq}`;
  mountModal(modalId, windowKey);
  return modalId;
}

/** Close it the way `Modal`'s unmount does. Note what this does NOT clear: the
 *  key's place in the saved order. That is what makes a reopen land where the
 *  user left the window — and it is why the specs below have to open a window
 *  once before they can test what a REopen does. A key the shell has never seen
 *  mounts at the front no matter what, which would agree with every version. */
function closeWindow(modalId: string) {
  unmountModal(modalId);
}

function reset() {
  deactivateAllModals();
}

test('a window already open but buried comes forward when it is asked for again', () => {
  reset();
  const builder = createWindowTarget<{ mode: string }>('spec-builder');

  // The builder is open...
  builder.set({ mode: 'create' });
  const builderId = openWindow('spec-builder');
  assert.equal(getActiveModalId(), builderId);

  // ...and the user buries it under another window.
  const otherId = openWindow('spec-other');
  activateModal(otherId);
  assert.equal(getActiveModalId(), otherId, 'precondition: the builder is buried');

  // Clicking the button that opens the builder stages the same target again.
  // Nothing mounts, nothing unmounts, no content changes — and that is the
  // whole bug: before this, the click was indistinguishable from a re-render.
  builder.set({ mode: 'create' });

  assert.equal(getActiveModalId(), builderId, 'the builder should be frontmost again');
});

test('a window that is not open yet is raised by the request that arrives before it mounts', () => {
  reset();
  const picker = createWindowTarget<{ slot: string }>('spec-picker');

  // The picker has been open before, so the shell remembers where it sat.
  // Without this the spec would pass on any version: a key the shell has never
  // seen has no saved place to slot into, so it mounts at the front for free.
  closeWindow(openWindow('spec-picker'));

  // Something else is in front, and the picker does not exist yet.
  const otherId = openWindow('spec-other-2');
  activateModal(otherId);

  // The ask lands before React has rendered anything — this is the ordinary
  // first open, not an edge case.
  picker.set({ slot: 'hero' });
  assert.equal(getActiveModalId(), otherId, 'nothing to raise yet');

  const pickerId = openWindow('spec-picker');
  assert.equal(getActiveModalId(), pickerId, 'the picker should mount in front');
});

test('a request outlives a StrictMode remount', () => {
  reset();
  const builder = createWindowTarget<{ mode: string }>('spec-strict');

  // Give the key a place in the saved order, so a later mount slots back into
  // it instead of landing on top for free.
  closeWindow(openWindow('spec-strict'));
  const otherId = openWindow('spec-other-3');
  activateModal(otherId);

  builder.set({ mode: 'create' });

  // React's StrictMode mounts the tree, tears it down, and mounts it again.
  // A request spent by the first of those leaves the window buried on the
  // second — in development only, which is where anyone would look for it.
  const firstMount = openWindow('spec-strict');
  assert.equal(getActiveModalId(), firstMount);
  closeWindow(firstMount);
  const secondMount = openWindow('spec-strict');

  assert.equal(getActiveModalId(), secondMount, 'the second mount should still be raised');
});

test('a stale request does not raise a window the user did not ask for', () => {
  reset();
  const builder = createWindowTarget<{ mode: string }>('spec-stale');

  builder.set({ mode: 'create' });
  const builderId = openWindow('spec-stale');
  assert.equal(getActiveModalId(), builderId);

  // The user moves on: they click another window, which is what puts it in
  // front. That overtakes the outstanding ask.
  closeWindow(builderId);
  const otherId = openWindow('spec-other-4');
  activateModal(otherId);

  // Much later the builder's modal remounts for a reason nobody asked for — a
  // query resolving, a parent re-keying it. It must NOT steal focus.
  openWindow('spec-stale');

  assert.equal(getActiveModalId(), otherId, 'the window the user is using must keep the front');
});

test('closing a window withdraws an ask nothing has honoured yet', () => {
  reset();
  const picker = createWindowTarget<{ slot: string }>('spec-withdraw');
  closeWindow(openWindow('spec-withdraw'));
  const otherId = openWindow('spec-other-5');
  activateModal(otherId);

  // Staged, then cancelled before the window ever rendered — an editor request
  // abandoned while its window was still loading.
  picker.set({ slot: 'hero' });
  picker.set(null);

  // The window opening later, for an unrelated reason, must not inherit the
  // withdrawn ask.
  openWindow('spec-withdraw');

  assert.equal(getActiveModalId(), otherId, 'the withdrawn ask must not be claimed later');
});

test('staging without asking to be seen does not raise', () => {
  reset();
  const builder = createWindowTarget<{ mode: string }>('spec-quiet');
  const builderId = openWindow('spec-quiet');
  const otherId = openWindow('spec-other-6');
  activateModal(otherId);

  builder.set({ mode: 'create' }, { raise: false });

  assert.equal(getActiveModalId(), otherId, 'an explicit quiet staging must not steal focus');
  assert.equal(builder.get()?.mode, 'create', 'but it must still stage');
  assert.notEqual(builderId, null);
});

test('nothing but an ask can raise a window', () => {
  reset();
  const builder = createWindowTarget<{ mode: string }>('spec-norender');
  const builderId = openWindow('spec-norender');
  const otherId = openWindow('spec-other-7');
  activateModal(otherId);

  // Everything a background window does on its own: it is read, it is
  // subscribed to, its host re-renders. None of it is a request to be seen.
  builder.get();
  const stop = builder.subscribe(() => {});
  builder.get();
  stop();

  assert.equal(getActiveModalId(), otherId, 'reading and subscribing must never raise');
  assert.notEqual(builderId, null);
});

test('staging the same target twice re-renders the host', async () => {
  reset();
  const channel = createWindowTarget<{ mode: string }>('spec-rerender');
  const seen: Array<number | null> = [];

  function Host() {
    const target = useWindowTarget(channel);
    seen.push(target?.nav ?? null);
    return null;
  }

  const view = render(<Host />);
  try {
    await act(async () => { channel.set({ mode: 'create' }); });
    await act(async () => { channel.set({ mode: 'create' }); });

    // Identical targets. Without a stamp the second staging is not observable,
    // so the host never learns it was asked again — which is how "New form" on
    // top of an already-open blank form did nothing at all.
    assert.deepEqual(seen.filter((n) => n !== null), [1, 2]);
  } finally {
    view.unmount();
  }
});

test('a host mounted while a target is already staged shows it on its first render', () => {
  reset();
  const channel = createWindowTarget<{ mode: string }>('spec-firstframe');
  channel.set({ mode: 'edit' }, { raise: false });

  const seen: Array<string | null> = [];
  function Host() {
    const target = useWindowTarget(channel);
    seen.push(target?.mode ?? null);
    return null;
  }

  const view = render(<Host />);
  try {
    assert.equal(seen[0], 'edit', 'the first render must already see the staged target');
  } finally {
    view.unmount();
  }
});

test('requestWindowFront is usable on its own as the imperative escape hatch', () => {
  reset();
  const targetId = openWindow('spec-imperative');
  const otherId = openWindow('spec-other-8');
  activateModal(otherId);
  assert.equal(getActiveModalId(), otherId);

  requestWindowFront('spec-imperative');

  assert.equal(getActiveModalId(), targetId);
});

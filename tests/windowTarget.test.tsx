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
function openWindow(windowKey: string, modalId = `modal-test-${++seq}`) {
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
  //
  // Both mounts carry the SAME modalId, because `Modal` takes its id from a
  // `useRef` and React keeps refs across the StrictMode tear-down (measured,
  // not assumed).
  //
  // What actually holds this up is NOT the request surviving — the request is
  // spent by the first mount. Honouring it called `activateModal`, which put
  // this key at the top of the SAVED order, and the second mount is restored
  // from that order. So the window comes back in front with nothing left
  // outstanding, which is what lets an ask be spent immediately.
  const strictId = 'modal-test-strict';
  const firstMount = openWindow('spec-strict', strictId);
  assert.equal(getActiveModalId(), firstMount);
  closeWindow(firstMount);
  const secondMount = openWindow('spec-strict', strictId);

  assert.equal(getActiveModalId(), secondMount, 'the second mount should still be raised');
});

test('an ask is spent, so a genuinely new mount of that window is not raised', () => {
  reset();
  const builder = createWindowTarget<{ mode: string }>('spec-spent');
  closeWindow(openWindow('spec-spent'));

  // The user asks, and the window rises. The ask is now satisfied.
  builder.set({ mode: 'create' });
  const asked = openWindow('spec-spent');
  assert.equal(getActiveModalId(), asked, 'the ask is honoured');

  // They close it from its own title bar. The host flips `open` to false and
  // never calls `set(null)` — nothing withdraws the ask, and nothing should
  // need to.
  closeWindow(asked);

  // Another window comes up. Note it is not ACTIVATED: a window mounting into
  // a key the shell has not seen lands in front on its own, which is how a
  // second window arrives in practice and why the old expiry — which ran only
  // on activation — never fired here.
  const otherId = openWindow('spec-spent-other');
  assert.equal(getActiveModalId(), otherId, 'precondition: the other window is in front');

  // Much later the first window remounts for a reason nobody asked for.
  // Different mount, different id, spent ask: it must stay where it is.
  openWindow('spec-spent');

  assert.equal(getActiveModalId(), otherId, 'a spent ask must not raise a later mount');
});

test('an ask still waiting to be honoured is dropped when the user moves on', () => {
  reset();
  const builder = createWindowTarget<{ mode: string }>('spec-overtaken');
  closeWindow(openWindow('spec-overtaken'));

  // Asked for, but its window is still loading and has not mounted — so unlike
  // the specs above there is no honouring here to spend the ask. This is the
  // only case the expiry in `activateModal` still has to catch.
  builder.set({ mode: 'create' });

  // The user gives up waiting and clicks another window.
  const otherId = openWindow('spec-overtaken-other');
  activateModal(otherId);

  // The builder finally renders, into a session that has moved on without it.
  openWindow('spec-overtaken');

  assert.equal(getActiveModalId(), otherId, 'an overtaken ask must not raise');
});

test('a quiet staging does not inherit the raise from an earlier ask', () => {
  reset();
  const picker = createWindowTarget<{ slot: string }>('spec-quiet-after');
  closeWindow(openWindow('spec-quiet-after'));

  picker.set({ slot: 'hero' });                 // a real ask, honoured
  closeWindow(openWindow('spec-quiet-after'));

  const otherId = openWindow('spec-quiet-after-other');
  assert.equal(getActiveModalId(), otherId, 'precondition');

  // Session restore re-stages several windows at once and asks for none of
  // them. If the earlier ask were still outstanding, `{ raise: false }` would
  // be honoured as a raise anyway — the option saying the exact opposite.
  picker.set({ slot: 'hero' }, { raise: false });
  openWindow('spec-quiet-after');

  assert.equal(getActiveModalId(), otherId, 'a quiet staging must never raise');
});

test('when two windows are asked for, the one asked for LAST comes forward', () => {
  reset();
  const form = createWindowTarget<{ id: number }>('spec-race-form');
  const media = createWindowTarget<{ slot: string }>('spec-race-media');

  // Give both keys a saved place, with the FORM on top — so that on their own,
  // with nothing asked for, the form is the one that mounts in front. Without
  // this the media picker would end up in front for free and the spec would
  // agree with a shell that ignored the second ask entirely.
  closeWindow(openWindow('spec-race-media'));
  const seededForm = openWindow('spec-race-form');
  activateModal(seededForm);
  closeWindow(seededForm);

  // The user clicks "Edit form", changes their mind and clicks the media
  // picker before either window has rendered.
  form.set({ id: 1 });
  media.set({ slot: 'hero' });

  // The form's host happens to render first — which host wins that race is not
  // something the user can see or control, so it must not decide what they get.
  const formId = openWindow('spec-race-form');
  assert.equal(getActiveModalId(), formId, 'precondition: the form is in front on its own');

  const mediaId = openWindow('spec-race-media');

  assert.equal(getActiveModalId(), mediaId, 'the window asked for last must be in front');
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

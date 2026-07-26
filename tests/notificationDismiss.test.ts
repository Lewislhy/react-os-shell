import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readingTimeMs, type ShellNotification } from '../src/shell/NotificationBell';

/**
 * The pop-up notification card used to clip title and message to one line
 * each, so a flat 5s dismiss was always enough to read what was on screen.
 * Now that the card wraps and grows, the dwell time has to follow the text —
 * otherwise the fix that made the message visible is undone by a timer that
 * hides it mid-sentence. These guard the two bounds that keep that honest.
 */

const notif = (title: string, message?: string): ShellNotification => ({
  id: '1', title, message, is_read: false, created_at: '2026-07-26T00:00:00Z',
});

test('short notifications keep the original 5s — no regression for the common case', () => {
  assert.equal(readingTimeMs(notif('Sales Order SO#10241 shipped', 'Tracking 7X22H901')), 5000);
  assert.equal(readingTimeMs(notif('Saved')), 5000, 'the floor holds for a near-empty card');
});

test('a message too long to read in 5s buys more time', () => {
  const long = notif(
    'Support replied to your report BG#00412',
    'Hi Victor — fixed and shipped. The packing list now re-pulls the lines after a reset.',
  );
  assert.ok(readingTimeMs(long) > 5000, `expected more than the floor, got ${readingTimeMs(long)}`);
});

test('a runaway message cannot park the card on screen', () => {
  assert.equal(readingTimeMs(notif('x'.repeat(500), 'y'.repeat(5000))), 12000);
});

test('a missing message is not counted as characters', () => {
  // `message` is optional on ShellNotification, and undefined.length would
  // have thrown rather than simply contributing nothing.
  assert.equal(readingTimeMs(notif('Saved', undefined)), 5000);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mediaFileName } from '../src/forms/mediaShared';

// A realistic (if short) base64 payload. The point of the `data:` cases is that
// none of this ever reaches the returned name — a real favicon runs to hundreds
// of kilobytes, and `MediaUploadField` puts the result straight into `alt`.
const PNG_BODY =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('a base64 PNG is named from its subtype', () => {
  assert.equal(mediaFileName(`data:image/png;base64,${PNG_BODY}`), 'image.png');
});

test('the base64 payload never leaks into the name', () => {
  const name = mediaFileName(`data:image/png;base64,${PNG_BODY}`);
  assert.ok(!name.includes(PNG_BODY), 'payload must not appear in the name');
  assert.ok(!name.includes('base64'), 'the encoding marker must not appear either');
  assert.ok(name.length < 32, `name should stay short, got ${name.length} chars`);
});

test('the +xml structured-syntax suffix is dropped on SVG', () => {
  assert.equal(mediaFileName('data:image/svg+xml;base64,PHN2ZyB4bWxucz0i'), 'image.svg');
  assert.equal(mediaFileName('data:image/svg+xml,%3Csvg%20xmlns%3D%22'), 'image.svg', 'URL-encoded payload too');
});

test('a tree-d vendor subtype reduces to its last segment', () => {
  assert.equal(mediaFileName('data:image/vnd.microsoft.icon;base64,AAAB'), 'image.icon');
});

test('an experimental x- prefix is shed', () => {
  assert.equal(mediaFileName('data:image/x-icon;base64,AAAB'), 'image.icon');
});

test('non-PNG and non-image media types are named the same way', () => {
  assert.equal(mediaFileName('data:image/jpeg;base64,/9j/4AAQSkZJRg=='), 'image.jpeg');
  assert.equal(mediaFileName('data:video/mp4;base64,AAAAIGZ0eXA='), 'video.mp4');
});

test('the media type is lowercased', () => {
  assert.equal(mediaFileName('DATA:IMAGE/PNG;base64,AAAA'), 'image.png');
});

test('a data URL with no usable media type falls back to "media"', () => {
  assert.equal(mediaFileName('data:,hello'), 'media');
  assert.equal(mediaFileName('data:;base64,AAAA'), 'media');
  assert.equal(mediaFileName('data:image/x-;base64,AAAA'), 'media', 'subtype reduces to nothing');
});

test('path-shaped URLs keep their existing derivation', () => {
  const url = `/media/uploads/${'9f3a'.repeat(8)}_My%20Clip.mp4?v=2`;
  assert.equal(mediaFileName(url), 'My Clip.mp4', 'hex prefix, query and encoding all stripped');
  assert.equal(mediaFileName('/media/logo.svg#icon'), 'logo.svg', 'hash fragment dropped');
  assert.equal(mediaFileName('https://cdn.example.com/a/b/photo.png?w=100#top'), 'photo.png');
  assert.equal(mediaFileName('photo.png'), 'photo.png', 'a bare filename is already the name');
});

test('a blob: object URL keeps its last segment', () => {
  assert.equal(
    mediaFileName('blob:http://localhost:5173/8f14e45f-ceea-467a-9575-4a1d1b4b30c9'),
    '8f14e45f-ceea-467a-9575-4a1d1b4b30c9',
  );
});

test('a malformed percent-escape is survived, not thrown on', () => {
  assert.equal(mediaFileName('/media/100%.png'), '100%.png');
});

test('an empty URL falls back to "media"', () => {
  assert.equal(mediaFileName(''), 'media');
});

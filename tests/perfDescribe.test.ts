import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describePerfReport } from '../src/shell/perfDescribe';
import type { PerfReport } from '../src/shell/PerfStats';
import type { PerfEnvironment } from '../src/shell/perfEnvironment';

/**
 * The description a filed performance report leads with — the part that decides
 * whether the report gets acted on or scrolled past, and the only part of the
 * pipeline checkable without a browser producing real frame timings.
 */

const group = (medianFps: number, worstMs = 20, samples = 8) => ({
  samples,
  medianFps,
  worstMs,
  stalls: 0,
});

const environment = (over: Partial<PerfEnvironment> = {}): PerfEnvironment => ({
  userAgent: 'Mozilla/5.0 …',
  browser: 'Chrome 141.0.7390.55',
  platform: 'macOS',
  platformVersion: '15.5.0',
  architecture: 'arm',
  model: '',
  cpuCores: 12,
  deviceMemoryGB: 8,
  gpu: 'Apple M3 Max',
  gpuVendor: 'Apple',
  webglAvailable: true,
  screen: { width: 3456, height: 2234, dpr: 2, colorDepth: 30 },
  viewport: { width: 1600, height: 1000 },
  heapLimitMB: 4096,
  network: { effectiveType: '4g', downlinkMbps: 10, rttMs: 50, saveData: false },
  battery: { charging: true, level: 0.9 },
  prefersReducedMotion: false,
  forcedColors: false,
  reducedTransparency: false,
  touchPoints: 0,
  ...over,
});

const report = (
  over: Partial<PerfReport['summary']> = {},
  message = '',
  env = environment(),
): PerfReport => ({
  message,
  filename: 'perf-log-2026-07-30T12-38-00.json',
  json: '{}',
  verdict: 'GPU-bound (compositing)',
  environment: env,
  summary: {
    samples: 240,
    durationMs: 120_000,
    medianFps: 34,
    worstFrameMs: 412,
    verdictShare: { smooth: 0.4, gpu: 0.5, cpu: 0.1, unknown: 0 },
    interacting: group(28),
    idle: group(59),
    byActivity: [],
    byWindowCount: [],
    worstWindows: [],
    worstMenus: [],
    ...over,
  },
});

test('the description leads with the verdict and the headline numbers', () => {
  const text = describePerfReport(report());
  assert.match(text, /^Performance report — GPU-bound \(compositing\)/);
  assert.match(text, /Median 34 fps over 2m \(240 samples\), worst frame 412 ms\./);
  assert.match(text, /At rest 59 fps vs in use 28 fps\./);
});

test('the machine comes before the numbers', () => {
  // Whether 34 fps is a bad application or an old laptop is not decidable from
  // the frame rate, and a triager who has to open a 140 KB attachment to find
  // out will mostly guess instead.
  const text = describePerfReport(report());
  assert.match(text, /Machine: Chrome 141\.0\.7390\.55 · macOS 15\.5\.0 \(arm\) · Apple M3 Max · 12 cores/);
  assert.ok(text.indexOf('Machine:') < text.indexOf('Median'));
});

test('a slow connection gets a line; an ordinary one stays quiet', () => {
  // A slow link is a different complaint from a slow UI, worth separating
  // before anyone goes profiling the render path.
  const slow = environment({ network: { effectiveType: '2g', downlinkMbps: 0.2, rttMs: 700, saveData: false } });
  assert.match(describePerfReport(report({}, '', slow)), /Connection: 2g · 700 ms round trip/);
  assert.doesNotMatch(describePerfReport(report()), /Connection:/);
});

test('the slowest gesture, menu and window are all named', () => {
  const text = describePerfReport(
    report({
      byActivity: [
        { kind: 'submenu', ...group(14, 380) },
        { kind: 'move', ...group(41, 90) },
      ],
      worstMenus: [{ key: '/inventory/stock-on-hand', ...group(12) }],
      worstWindows: [{ key: 'page:sales-invoice', ...group(18) }],
    }),
  );
  assert.match(text, /Slowest while: submenu 14 fps \(worst 380 ms\) · move 41 fps \(worst 90 ms\)/);
  assert.match(text, /Slowest menu: \/inventory\/stock-on-hand — 12 fps/);
  assert.match(text, /Slowest window: page:sales-invoice — 18 fps/);
});

test("the user's own sentence is carried, and its absence is stated", () => {
  assert.match(describePerfReport(report({}, '  second-level menu stutters  ')), /second-level menu stutters/);
  assert.match(describePerfReport(report({}, '   ')), /\(No description given\.\)/);
});

test('a group that stalled reads as stalled, never as 0 fps', () => {
  // Zero is not a slow reading, it is the absence of one. "0 fps" looks like a
  // measurement the display actually showed.
  const text = describePerfReport(
    report({ byActivity: [{ kind: 'submenu', samples: 4, medianFps: 0, worstMs: 900, stalls: 4 }] }),
  );
  assert.match(text, /Slowest while: submenu stalled \(worst 900 ms\)/);
});

test('the description names the attachment it is describing', () => {
  assert.match(describePerfReport(report()), /Full log attached as perf-log-2026-07-30T12-38-00\.json\./);
});

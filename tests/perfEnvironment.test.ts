import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeMachine, type PerfEnvironment } from '../src/shell/perfEnvironment';

/** A fully-answered Chromium machine, plugged in, nothing switched on. Tests
 *  take fields away or flip flags, because the interesting cases are all about
 *  what a browser refused to say or what the user had already turned on. */
const env = (over: Partial<PerfEnvironment> = {}): PerfEnvironment => ({
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

test('the machine line reads like a spec sheet: browser, OS, GPU, cores, RAM, screen', () => {
  assert.equal(
    describeMachine(env()),
    'Chrome 141.0.7390.55 · macOS 15.5.0 (arm) · Apple M3 Max · 12 cores · 8GB+ RAM · 3456×2234 @2x',
  );
});

test('a field the browser withheld is omitted, not printed as unknown', () => {
  // Firefox publishes no deviceMemory and no client hints. A line of
  // "unknown · unknown · unknown" reads as a broken probe rather than as a
  // browser that simply declines to answer.
  const line = describeMachine(
    env({ browser: null, deviceMemoryGB: null, platform: null, platformVersion: null, architecture: null }),
  );
  assert.doesNotMatch(line, /unknown|null|undefined/);
  assert.equal(line, 'Apple M3 Max · 12 cores · 3456×2234 @2x');
});

test('the screen is always named, even when everything else is refused', () => {
  // Whatever else a browser hides, the panel it is painting is knowable — and
  // pixel count is half of any compositing story.
  const bare = env({
    browser: null, gpu: null, gpuVendor: null, cpuCores: null, deviceMemoryGB: null,
    platform: null, platformVersion: null, architecture: null, battery: null,
  });
  assert.equal(describeMachine(bare), '3456×2234 @2x');
});

test('software rendering is called out where the GPU name would be', () => {
  // No WebGL means the browser is compositing on the CPU, which explains a
  // GPU-bound verdict outright — an absence that is itself the finding.
  assert.match(describeMachine(env({ gpu: null, webglAvailable: false })), /no WebGL \(software rendering\)/);
});

test('an OS with no version still names itself', () => {
  assert.match(describeMachine(env({ platformVersion: null, architecture: null })), /· macOS ·/);
});

test('states that throttle the machine are flagged; their absence is silent', () => {
  // A laptop in Low Power Mode is capped at 30 fps by the OS — the commonest
  // cause of "it halved this afternoon". Listing the off states too would bury
  // the one that is on.
  const throttled = describeMachine(env({
    battery: { charging: false, level: 0.37 },
    prefersReducedMotion: true,
    reducedTransparency: true,
  }));
  assert.match(throttled, /on battery 37% · reduce transparency on · reduced motion$/);
  assert.doesNotMatch(describeMachine(env()), /battery|transparency|motion/);
});

test('a charging laptop is not reported as being on battery', () => {
  assert.doesNotMatch(describeMachine(env({ battery: { charging: true, level: 0.4 } })), /on battery/);
});

/**
 * What machine the readings came off.
 *
 * A frame rate without a machine attached is half a report. "GPU-bound
 * (compositing)" means something very different on an Intel UHD 620 driving a
 * 4K panel than on an M3 Max, and the first question anyone triaging a
 * slowdown asks is which one they are looking at — a question the reporter is
 * usually the worst-placed person to answer, and often simply cannot.
 *
 * The user agent alone does not settle it. Chromium freezes its UA string, so
 * Windows 11 reports itself as Windows 10 and an ARM machine looks like an x86
 * one; and no UA string has ever named the GPU, which is the part that matters
 * most here. So this reads the specifics directly, from four sources:
 *
 *   - **Synchronous navigator and screen fields** — cores, memory, panel,
 *     network, display settings. Cheap, and occasionally withheld.
 *   - **A WebGL context**, purely to ask the driver its own name. Created and
 *     destroyed inside one call, at report time and never during measurement,
 *     because a live context is exactly the sort of thing that would show up in
 *     the numbers it is meant to explain.
 *   - **Client hints and the battery**, both async, both unchanging, so both
 *     are resolved once when the HUD mounts rather than while a report is being
 *     assembled.
 *   - **Media queries**, for the settings that change how much compositing the
 *     browser is being asked to do in the first place.
 *
 * Everything is best-effort and every field degrades to null. Firefox and
 * Safari withhold `deviceMemory`; Safari has no client hints; a blocklisted
 * driver refuses WebGL. A report missing one line is a far smaller loss than a
 * report that failed to send, so nothing here is allowed to throw.
 */

/** Async platform detail from `navigator.userAgentData`. */
export interface PlatformHints {
  /** 'macOS', 'Windows', 'Linux', … */
  platform: string | null;
  /** The real OS version, which the frozen UA string no longer carries. */
  platformVersion: string | null;
  /** 'arm' | 'x86' — an Intel Mac and an Apple Silicon Mac are not the same
   *  machine and do not have the same compositing story. */
  architecture: string | null;
  /** Device model, on mobile. */
  model: string | null;
  /** Browser name and full version, e.g. 'Chrome 141.0.7390.55'. */
  browser: string | null;
}

/** Power state. A laptop in Low Power Mode is capped at 30 fps by the OS, which
 *  is the single most common cause of "it halved this afternoon". */
export interface BatteryInfo {
  charging: boolean;
  /** 0–1. */
  level: number;
}

/** The parts that cannot be read synchronously, resolved once on mount. */
export interface AsyncEnvironment {
  hints: PlatformHints | null;
  battery: BatteryInfo | null;
}

export interface PerfEnvironment {
  userAgent: string;
  /** Browser name and version from client hints; null outside Chromium, where
   *  `userAgent` above is the fallback. */
  browser: string | null;
  platform: string | null;
  platformVersion: string | null;
  architecture: string | null;
  model: string | null;
  /** Logical cores. The shell is single-threaded, so this mostly says how much
   *  else the machine can be doing at once. */
  cpuCores: number | null;
  /** Approximate RAM in GB. Deliberately coarse — the spec has browsers round
   *  to a power of two and permits clamping to 8 to blunt fingerprinting, so
   *  treat it as a floor ("this much or more"), not a measurement. Chromium
   *  only; Firefox and Safari publish nothing. */
  deviceMemoryGB: number | null;
  /** The driver's own name for itself, e.g. 'Apple M3 Max' or
   *  'ANGLE (Intel, Intel(R) UHD Graphics 620 …)'. */
  gpu: string | null;
  gpuVendor: string | null;
  /** False when the browser fell back to software rendering — which explains a
   *  GPU-bound verdict outright. */
  webglAvailable: boolean;
  screen: { width: number; height: number; dpr: number; colorDepth: number | null };
  /** The window, which is what actually gets composited — a maximised window on
   *  a 4K panel and a small one are different amounts of work. */
  viewport: { width: number; height: number };
  /** Heap ceiling this tab was given, MB. Chromium only. */
  heapLimitMB: number | null;
  /** Effective connection class, downlink Mb/s and round-trip ms. Separates a
   *  UI that is slow from a UI that is waiting. */
  network: { effectiveType: string | null; downlinkMbps: number | null; rttMs: number | null; saveData: boolean } | null;
  battery: BatteryInfo | null;
  /** Settings that change how much work the browser is being asked to do. */
  prefersReducedMotion: boolean;
  forcedColors: boolean;
  /** The shell's own "reduce transparency" — the first thing to suggest, and
   *  the first thing to check has not already been tried. */
  reducedTransparency: boolean;
  /** Screens can be scaled; a report from a 4K panel at 200% is not the same as
   *  one at 100%. */
  touchPoints: number | null;
}

interface UADataLike {
  platform?: string;
  brands?: { brand: string; version: string }[];
  getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>;
}

interface ChromeMemoryLike {
  jsHeapSizeLimit: number;
}

interface ConnectionLike {
  effectiveType?: string;
  downlink?: number;
  rtt?: number;
  saveData?: boolean;
}

interface BatteryManagerLike {
  charging: boolean;
  level: number;
}

/** Chromium reports itself under several brands, most of them decoys ("Not;A
 *  Brand") planted to break naive UA sniffing. Pick the real one. */
function pickBrand(brands: { brand: string; version: string }[] | undefined): string | null {
  if (!brands?.length) return null;
  const real = brands.filter(b => !/not[^a-z]*a[^a-z]*brand/i.test(b.brand));
  // Chromium itself is the generic engine brand; the specific product (Chrome,
  // Edge, Opera) is what someone reproducing the report needs to install.
  const named = real.find(b => b.brand !== 'Chromium') ?? real[0];
  return named ? `${named.brand} ${named.version}` : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/**
 * Resolve everything that needs a promise. Call once, keep the result — the
 * values cannot change for the life of the page, and the prompt some browsers
 * attach to high-entropy hints must not fire while someone is filing a report.
 *
 * Never rejects. A browser with no client hints and no battery API is the
 * normal case outside Chromium, not an error worth handling at the call site.
 */
export async function requestAsyncEnvironment(): Promise<AsyncEnvironment> {
  return { hints: await readHints(), battery: await readBattery() };
}

async function readHints(): Promise<PlatformHints | null> {
  const uaData = (navigator as Navigator & { userAgentData?: UADataLike }).userAgentData;
  if (!uaData) return null;
  const base: PlatformHints = {
    platform: uaData.platform ?? null,
    platformVersion: null,
    architecture: null,
    model: null,
    browser: pickBrand(uaData.brands),
  };
  if (!uaData.getHighEntropyValues) return base;
  try {
    const high = await uaData.getHighEntropyValues([
      'platform',
      'platformVersion',
      'architecture',
      'model',
      'fullVersionList',
    ]);
    const full = high.fullVersionList as { brand: string; version: string }[] | undefined;
    return {
      platform: asString(high.platform) ?? base.platform,
      platformVersion: asString(high.platformVersion),
      architecture: asString(high.architecture),
      model: asString(high.model),
      // The full list carries the build number; the low-entropy brands only
      // carry the major, which is not enough to match against a known bug.
      browser: pickBrand(full) ?? base.browser,
    };
  } catch {
    // The browser may decline the high-entropy set outright.
    return base;
  }
}

async function readBattery(): Promise<BatteryInfo | null> {
  const getBattery = (navigator as Navigator & { getBattery?: () => Promise<BatteryManagerLike> }).getBattery;
  if (!getBattery) return null;
  try {
    const battery = await getBattery.call(navigator);
    return { charging: battery.charging, level: battery.level };
  } catch {
    return null;
  }
}

/**
 * Ask the GPU its name, then throw the context away.
 *
 * `WEBGL_debug_renderer_info` is the extension that returns the unmasked
 * string; without it `RENDERER` reports a generic sanitised name, which is
 * still worth having. The context is explicitly lost afterwards because
 * browsers cap how many may exist at once, and a diagnostic must not be the
 * thing that exhausts them.
 */
export function readGpu(): { renderer: string | null; vendor: string | null; available: boolean } {
  if (typeof document === 'undefined') return { renderer: null, vendor: null, available: false };
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return { renderer: null, vendor: null, available: false };
    const debug = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    const vendor = debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { renderer: asString(renderer), vendor: asString(vendor), available: true };
  } catch {
    // A blocklisted driver, a headless browser, or WebGL disabled outright —
    // all of which are themselves an answer to "why is compositing slow".
    return { renderer: null, vendor: null, available: false };
  }
}

function matches(query: string): boolean {
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** Snapshot the machine. Synchronous — pass what `requestAsyncEnvironment`
 *  resolved earlier, or null if it never arrived. */
export function readEnvironment(async_: AsyncEnvironment | null): PerfEnvironment {
  const nav = navigator as Navigator & { deviceMemory?: number; connection?: ConnectionLike };
  const memory = (performance as Performance & { memory?: ChromeMemoryLike }).memory;
  const hints = async_?.hints ?? null;
  const gpu = readGpu();
  const conn = nav.connection;
  return {
    userAgent: nav.userAgent,
    browser: hints?.browser ?? null,
    platform: hints?.platform ?? null,
    platformVersion: hints?.platformVersion ?? null,
    architecture: hints?.architecture ?? null,
    model: hints?.model ?? null,
    cpuCores: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
    deviceMemoryGB: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
    gpu: gpu.renderer,
    gpuVendor: gpu.vendor,
    webglAvailable: gpu.available,
    screen: {
      width: screen.width,
      height: screen.height,
      dpr: window.devicePixelRatio,
      colorDepth: typeof screen.colorDepth === 'number' ? screen.colorDepth : null,
    },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    heapLimitMB: memory ? Math.round(memory.jsHeapSizeLimit / 1048576) : null,
    network: conn
      ? {
          effectiveType: asString(conn.effectiveType),
          downlinkMbps: typeof conn.downlink === 'number' ? conn.downlink : null,
          rttMs: typeof conn.rtt === 'number' ? conn.rtt : null,
          saveData: conn.saveData === true,
        }
      : null,
    battery: async_?.battery ?? null,
    prefersReducedMotion: matches('(prefers-reduced-motion: reduce)'),
    forcedColors: matches('(forced-colors: active)'),
    reducedTransparency: document.documentElement.classList.contains('rosh-reduce-transparency'),
    touchPoints: typeof nav.maxTouchPoints === 'number' ? nav.maxTouchPoints : null,
  };
}

/**
 * One line naming the machine, for a report title or a bug-tracker
 * description — the place where a reader decides whether this report is about
 * a slow machine or a slow application. The full record is in the attachment;
 * this is the digest.
 *
 * Omits what it does not know rather than printing "unknown": a line of
 * absences reads as a broken probe, when in truth Firefox simply does not
 * publish RAM.
 */
export function describeMachine(env: PerfEnvironment): string {
  const parts: string[] = [];
  if (env.browser) parts.push(env.browser);
  const os = [env.platform, env.platformVersion].filter(Boolean).join(' ');
  if (os) parts.push(env.architecture ? `${os} (${env.architecture})` : os);
  if (env.gpu) parts.push(env.gpu);
  else if (!env.webglAvailable) parts.push('no WebGL (software rendering)');
  if (env.cpuCores) parts.push(`${env.cpuCores} cores`);
  if (env.deviceMemoryGB) parts.push(`${env.deviceMemoryGB}GB+ RAM`);
  parts.push(`${env.screen.width}×${env.screen.height} @${env.screen.dpr}x`);
  // Flags only when they are true — each one is a live explanation for a low
  // frame rate, and a list of "off" states is noise.
  if (env.battery && !env.battery.charging) parts.push(`on battery ${Math.round(env.battery.level * 100)}%`);
  if (env.reducedTransparency) parts.push('reduce transparency on');
  if (env.prefersReducedMotion) parts.push('reduced motion');
  return parts.join(' · ');
}

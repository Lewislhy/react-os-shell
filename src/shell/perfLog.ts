/**
 * Session log for the desktop perf HUD — and the analysis that turns it into
 * a conclusion.
 *
 * A live frame rate tells you the UI is slow *now*. It does not tell you what
 * made it slow, and the person watching it is usually the last person able to
 * say. So while the HUD is on, every reading is stamped with what was
 * happening around it: how many windows were open, which one was on top,
 * whether the user was clicking, typing, scrolling or dragging. The log is
 * exportable, so a laggy machine somewhere else can produce evidence rather
 * than an adjective.
 *
 * The maths here is deliberately non-clever. Median rather than mean, because
 * one 400ms stall would drag a mean somewhere no frame ever was. Buckets
 * rather than a fitted curve, because "6 windows open halves the frame rate"
 * is a sentence someone can act on and a correlation coefficient is not.
 */
import type { BottleneckKind } from './perfVerdict';

/** One flush interval's worth of measurement plus its context. Keys are short
 *  because thousands of these get JSON-serialised into localStorage and into
 *  whatever the user sends afterwards. */
export interface PerfLogRecord {
  /** Milliseconds since logging began. */
  t: number;
  fps: number;
  frameMs: number;
  worstMs: number;
  blockedPct: number | null;
  heapMB: number | null;
  verdict: BottleneckKind;
  /** Open shell windows at the moment of the reading. */
  windows: number;
  /** Identity of the topmost window, when there is one — so a summary can name
   *  the screen that was slow rather than just the count. */
  active: string | null;
  clicks: number;
  keys: number;
  scrolls: number;
  /** Milliseconds spent with the pointer down and moving. Dragging is the
   *  single most compositing-heavy thing a user does in a window shell, so it
   *  gets its own axis rather than being lumped in with clicks. Covers any
   *  drag — a window gesture, a desktop icon, a text selection; `moveMs` and
   *  `resizeMs` below are the window subset of it. */
  dragMs: number;
  /** Start-menu opens (`perfEvents`). */
  menus: number;
  /** Flyout opens — 2nd- and 3rd-level menus. Hover-opened flyouts fire no
   *  click and no keypress, so before this axis existed the frame a submenu
   *  painted on was filed as *idle*, which is where the jank people actually
   *  report was going missing. */
  submenus: number;
  /** Last menu or flyout opened in the interval, so one can be named. */
  menuKey: string | null;
  /** Milliseconds spent dragging a window by its title bar. */
  moveMs: number;
  /** Milliseconds spent dragging a window's resize handle. */
  resizeMs: number;
}

export interface FpsGroup {
  samples: number;
  /** Median across the group's *measurable* samples — see `summariseLog`. Zero
   *  when every sample in the group stalled. */
  medianFps: number;
  /** Slowest single frame anywhere in the group. For a group of brief
   *  interactions this is the number that matters: a flyout that costs one
   *  300ms frame barely moves a median but is exactly what the user saw. */
  worstMs: number;
  /** Samples too blocked to report a frame rate at all. Kept beside the median
   *  rather than folded into it, so a group that is entirely stalls reads as
   *  the emergency it is instead of as a 0 fps reading. */
  stalls: number;
}

/**
 * What the user was doing during a sample, reduced to one label.
 *
 * A single interval routinely carries several axes at once — opening a flyout
 * involves a click, a pointer move and a menu mark — so the ranking below
 * decides which one the sample is filed under. It runs most-specific first:
 * the deliberate, expensive gesture beats the incidental click that came with
 * it, because filing a janky submenu open under "click" is how you end up
 * optimising the wrong thing.
 */
export type ActivityKind = 'submenu' | 'menu' | 'resize' | 'move' | 'scroll' | 'type' | 'click' | 'idle';

const ACTIVITY_ORDER: { kind: ActivityKind; test: (r: PerfLogRecord) => boolean }[] = [
  { kind: 'submenu', test: r => r.submenus > 0 },
  { kind: 'menu', test: r => r.menus > 0 },
  { kind: 'resize', test: r => r.resizeMs > 0 },
  { kind: 'move', test: r => r.moveMs > 0 },
  { kind: 'scroll', test: r => r.scrolls > 0 },
  { kind: 'type', test: r => r.keys > 0 },
  { kind: 'click', test: r => r.clicks > 0 || r.dragMs > 0 },
];

/** File a sample under the one thing most likely to have cost it. */
export function classifyActivity(r: PerfLogRecord): ActivityKind {
  return ACTIVITY_ORDER.find(entry => entry.test(r))?.kind ?? 'idle';
}

export interface LogSummary {
  samples: number;
  durationMs: number;
  medianFps: number;
  worstFrameMs: number;
  /** Fraction of samples in each verdict, 0–1. */
  verdictShare: Record<BottleneckKind, number>;
  /** Split by whether the user was doing anything. The gap between these two
   *  is the headline: a desktop that is smooth at rest and janky in use has a
   *  rendering cost that only shows up under interaction. */
  interacting: FpsGroup | null;
  idle: FpsGroup | null;
  /** Frame rate per kind of interaction, worst-first — the answer to "which
   *  gesture is slow", which is the question a report is usually filed to
   *  ask. */
  byActivity: (FpsGroup & { kind: ActivityKind })[];
  /** Frame rate against how many windows were open. */
  byWindowCount: (FpsGroup & { windows: number })[];
  /** Windows ranked worst-first, so the slowest screen names itself. */
  worstWindows: (FpsGroup & { key: string })[];
  /** Menus and flyouts ranked worst-first, same idea one layer up. */
  worstMenus: (FpsGroup & { key: string })[];
}

/** Records kept in memory before the oldest are dropped. At one record per
 *  500ms this is about 20 minutes — long enough to catch an intermittent
 *  stall, small enough to serialise without thinking about it. */
export const LOG_CAP = 2400;

/** Minimum samples before a group is reported. One unlucky reading is not a
 *  finding, and a summary that names a window off a single sample invites
 *  someone to go optimise the wrong screen. */
export const MIN_GROUP_SAMPLES = 4;

/** The floor for menu and gesture groups. Lower because these events are rare
 *  by construction — a flyout opens inside a single 500ms interval, not across
 *  twenty of them, so holding them to the window floor would suppress exactly
 *  the findings the axes were added for. Two still rules out a one-off, and
 *  every group carries its own `samples` for whoever reads it. */
export const MIN_EVENT_SAMPLES = 2;

/** Append with a cap, oldest dropped first. Returns a new array — callers hold
 *  this in React state, where mutation would not re-render. */
export function appendRecord(log: PerfLogRecord[], record: PerfLogRecord, cap = LOG_CAP): PerfLogRecord[] {
  const next = log.length >= cap ? log.slice(log.length - cap + 1) : log.slice();
  next.push(record);
  return next;
}

/** True when the user was doing something during the interval. */
export function isInteracting(r: PerfLogRecord): boolean {
  return classifyActivity(r) !== 'idle';
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Reduce a bucket of samples to a group.
 *
 * A reading taken while the main thread was too blocked to deliver frames
 * carries fps 0. Letting those into a median would report a frame rate the
 * display never showed, so the median is taken over the measurable samples
 * only — but the stall is not thrown away, because a stall is the worst thing
 * in the log. It survives as `stalls`, and its frame time still sets
 * `worstMs`.
 */
function group(records: PerfLogRecord[]): FpsGroup {
  const measured = records.filter(r => r.fps > 0);
  return {
    samples: records.length,
    medianFps: median(measured.map(r => r.fps)),
    worstMs: records.reduce((worst, r) => (r.worstMs > worst ? r.worstMs : worst), 0),
    stalls: records.length - measured.length,
  };
}

/** Bucket by a key, dropping records that have none. */
function bucket<K>(records: PerfLogRecord[], keyOf: (r: PerfLogRecord) => K | null): Map<K, PerfLogRecord[]> {
  const map = new Map<K, PerfLogRecord[]>();
  for (const r of records) {
    const key = keyOf(r);
    if (key === null) continue;
    const existing = map.get(key);
    if (existing) existing.push(r); else map.set(key, [r]);
  }
  return map;
}

/** Groups worst-first. A group that stalled outright sorts above one that
 *  merely ran slowly — `medianFps` is 0 there, which is already the bottom of
 *  the order, and that is the correct place for it. */
function rankWorstFirst<T extends FpsGroup>(groups: T[]): T[] {
  return groups.sort((a, b) => a.medianFps - b.medianFps);
}

/** Reduce a log to the handful of statements worth acting on. */
export function summariseLog(log: PerfLogRecord[]): LogSummary {
  const empty: LogSummary = {
    samples: 0,
    durationMs: 0,
    medianFps: 0,
    worstFrameMs: 0,
    verdictShare: { smooth: 0, gpu: 0, cpu: 0, unknown: 0 },
    interacting: null,
    idle: null,
    byActivity: [],
    byWindowCount: [],
    worstWindows: [],
    worstMenus: [],
  };
  if (!log.length) return empty;

  const verdictShare = { ...empty.verdictShare };
  for (const r of log) verdictShare[r.verdict] += 1 / log.length;

  const interacting = log.filter(isInteracting);
  const idle = log.filter(r => !isInteracting(r));

  return {
    samples: log.length,
    durationMs: log[log.length - 1].t - log[0].t,
    medianFps: median(log.filter(r => r.fps > 0).map(r => r.fps)),
    worstFrameMs: log.reduce((worst, r) => (r.worstMs > worst ? r.worstMs : worst), 0),
    verdictShare,
    interacting: interacting.length >= MIN_GROUP_SAMPLES ? group(interacting) : null,
    idle: idle.length >= MIN_GROUP_SAMPLES ? group(idle) : null,
    byActivity: rankWorstFirst(
      [...bucket(log, classifyActivity).entries()]
        .filter(([, rs]) => rs.length >= MIN_EVENT_SAMPLES)
        .map(([kind, rs]) => ({ kind, ...group(rs) })),
    ),
    byWindowCount: [...bucket(log, r => r.windows).entries()]
      .filter(([, rs]) => rs.length >= MIN_GROUP_SAMPLES)
      .map(([windows, rs]) => ({ windows, ...group(rs) }))
      .sort((a, b) => a.windows - b.windows),
    worstWindows: rankWorstFirst(
      [...bucket(log, r => r.active).entries()]
        .filter(([, rs]) => rs.length >= MIN_GROUP_SAMPLES)
        .map(([key, rs]) => ({ key, ...group(rs) })),
    ),
    worstMenus: rankWorstFirst(
      [...bucket(log, r => r.menuKey).entries()]
        .filter(([, rs]) => rs.length >= MIN_EVENT_SAMPLES)
        .map(([key, rs]) => ({ key, ...group(rs) })),
    ),
  };
}

const CSV_COLUMNS: (keyof PerfLogRecord)[] = [
  't', 'fps', 'frameMs', 'worstMs', 'blockedPct', 'heapMB',
  'verdict', 'windows', 'active', 'clicks', 'keys', 'scrolls', 'dragMs',
  'menus', 'submenus', 'menuKey', 'moveMs', 'resizeMs',
];

/** Flat CSV, for opening in a spreadsheet without writing any code. */
export function toCsv(log: PerfLogRecord[]): string {
  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = typeof value === 'number' ? String(Math.round(value * 10) / 10) : String(value);
    // Window and menu keys are app-supplied text and can contain a comma or a
    // quote — a section label is literally whatever the nav config says.
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [
    CSV_COLUMNS.join(','),
    ...log.map(r => CSV_COLUMNS.map(c => cell(r[c])).join(',')),
  ].join('\n');
}

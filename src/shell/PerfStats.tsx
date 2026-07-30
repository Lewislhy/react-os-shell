/**
 * Desktop performance HUD — an opt-in overlay that measures where the UI is
 * actually spending its time, so "it feels laggy" can become a number someone
 * can act on, and a report someone can file.
 *
 * Filing is the end of the story, not an export: the person who can see the
 * jank is rarely the person who can fix it, and a downloaded JSON that has to
 * be found, attached and explained mostly does not get sent. One button
 * freezes the log, asks the one question a log cannot answer — what were you
 * doing? — and hands both to the host's feedback channel.
 *
 * Two rules shape the implementation, both about not corrupting the reading:
 *
 *  1. **The HUD must be nearly free to render.** The rAF loop and the activity
 *     counters write to refs and never set state; a 500ms interval is the only
 *     thing that re-renders, and the session log lives in a ref too — only its
 *     size is state, because only its size is on screen. A HUD that
 *     re-rendered per frame would be measuring itself.
 *  2. **No frosted glass on the panel.** Every other surface in the shell
 *     uses `glassStyle()`, but a perf overlay that costs a 40px backdrop blur
 *     would add exactly the GPU load it is trying to attribute. Solid
 *     background, deliberately.
 *
 * Caveat worth knowing when reading the numbers: a running rAF loop keeps the
 * browser rendering continuously, so an idle desktop with the HUD open is
 * doing more work than an idle desktop without it. Read the numbers while
 * actually using the UI — scrolling, dragging a window, opening a menu — which
 * is when the interesting jank happens anyway.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { classify, summariseFrames, type PerfReading, type Verdict } from './perfVerdict';
import { appendRecord, summariseLog, type LogSummary, type PerfLogRecord } from './perfLog';
import { drainPerfEvents, setPerfCollecting } from './perfEvents';
import {
  readEnvironment,
  requestAsyncEnvironment,
  type AsyncEnvironment,
  type PerfEnvironment,
} from './perfEnvironment';

/** How often the accumulated frame data is turned into a render and a log record. */
const FLUSH_MS = 500;
/** Rolling window of frames each reading is computed from. */
const WINDOW_MS = 1000;
/** Sparkline width, in flush samples — 40 × 500ms ≈ 20s of history, enough to
 *  catch intermittent hitches (a periodic refetch, a GC pause) that a single
 *  instantaneous number hides. */
const HISTORY = 40;
/** The log is mirrored to localStorage this often, so a reload or a crash does
 *  not throw away a session someone spent ten minutes reproducing. Throttled
 *  rather than per-flush because serialising thousands of records twice a
 *  second would itself become main-thread work the HUD would then report. */
const PERSIST_EVERY_MS = 10_000;
const LOG_STORAGE_KEY = 'react-os-shell:perf-log';
/** Longest gap between two pointer moves still counted as drag time. Far above
 *  one frame even on a machine in trouble, so a real drag is never clipped; a
 *  gap beyond it means the pointer stopped. */
const MAX_DRAG_GAP_MS = 100;

/** Chrome exposes heap numbers off `performance`; nothing else does, and it is
 *  not in any spec — hence the local shape rather than a lib type. */
interface ChromeMemory {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

const VERDICT_STYLES: Record<Verdict['kind'], { dot: string; text: string }> = {
  smooth: { dot: 'bg-emerald-400', text: 'text-emerald-300' },
  gpu: { dot: 'bg-amber-400', text: 'text-amber-300' },
  cpu: { dot: 'bg-sky-400', text: 'text-sky-300' },
  unknown: { dot: 'bg-gray-400', text: 'text-gray-300' },
};

/** Count the open shell windows and identify the topmost one. Read from the
 *  DOM rather than threaded through context because that is how the shell
 *  already counts its own windows (Layout, WindowManager), and a diagnostic
 *  should observe what is really on screen rather than trust a mirror of it. */
function readWindows(): { windows: number; active: string | null } {
  if (typeof document === 'undefined') return { windows: 0, active: null };
  const panels = document.querySelectorAll<HTMLElement>('[data-modal-panel]');
  let active: string | null = null;
  let topZ = -Infinity;
  panels.forEach(panel => {
    const z = parseInt(window.getComputedStyle(panel).zIndex, 10);
    // `auto` parses to NaN; fall back to DOM order, which is paint order.
    const rank = Number.isFinite(z) ? z : 0;
    if (rank >= topZ) {
      topZ = rank;
      active = panel.dataset.windowKey ?? panel.dataset.modalId ?? null;
    }
  });
  return { windows: panels.length, active };
}

/** A finished report, handed to the host to file. The JSON is pre-serialised
 *  because the host's job is to attach it, not to re-derive it; `summary` and
 *  `verdict` come along so a host can title or route the report without
 *  parsing the attachment back apart. */
export interface PerfReport {
  /** What the user typed about what they were doing. May be empty. */
  message: string;
  /** Suggested attachment filename, stamped with the local time. */
  filename: string;
  /** The whole report — environment, summary and every raw record. */
  json: string;
  summary: LogSummary;
  /** The HUD's current headline, e.g. "GPU-bound (compositing)". */
  verdict: string;
  /** The machine the readings came off — GPU, cores, memory, OS, screen. A
   *  verdict of "GPU-bound" is not actionable until you know which GPU. */
  environment: PerfEnvironment;
}

export interface PerfStatsProps {
  /** Dismiss handler — the shell wires this to turn the pref back off, so the
   *  HUD can be closed from itself rather than only from Preferences. */
  onClose?: () => void;
  /** File the report through the host's own feedback channel — the whole point
   *  of the HUD, since a log that reaches nobody fixes nothing. Rejecting
   *  surfaces the error and keeps the composer open with the text intact.
   *  Without it the button downloads the same JSON instead, so the shell stays
   *  usable standalone. */
  onSubmit?: (report: PerfReport) => void | Promise<void>;
  className?: string;
}

export default function PerfStats({ onClose, onSubmit, className = '' }: PerfStatsProps) {
  const framesRef = useRef<number[]>([]);
  const blockedMsRef = useRef(0);
  const activityRef = useRef({ clicks: 0, keys: 0, scrolls: 0, dragMs: 0 });
  const dragRef = useRef({ down: false, since: 0 });
  const logRef = useRef<PerfLogRecord[]>([]);
  const startedAtRef = useRef(0);
  const persistedAtRef = useRef(0);

  /** The log as it stood when the composer opened. Frozen there so the twenty
   *  seconds someone spends typing "the second-level menu stutters" do not
   *  become twenty samples of typing at the end of the very report that
   *  sentence is about. */
  const snapshotRef = useRef<PerfLogRecord[] | null>(null);
  /** Client hints and battery state are async and unchanging, so they are
   *  fetched once here and read synchronously when a report is built. */
  const envRef = useRef<AsyncEnvironment | null>(null);

  const [longTaskSupported, setLongTaskSupported] = useState(false);
  const [reading, setReading] = useState<PerfReading>({ fps: 0, frameMs: 0, worstMs: 0, blockedPct: null });
  const [history, setHistory] = useState<number[]>([]);
  const [heap, setHeap] = useState<{ usedMB: number; limitMB: number } | null>(null);
  const [logSize, setLogSize] = useState(0);
  const [composing, setComposing] = useState(false);
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // ── Interaction marks: menus and window gestures only accumulate while the
  //    HUD is up. See perfEvents for why a counter left running would lie.
  useEffect(() => {
    setPerfCollecting(true);
    return () => setPerfCollecting(false);
  }, []);

  // ── Machine detail. Resolved on mount rather than at report time: the values
  //    cannot change, and some browsers gate high-entropy hints behind a
  //    prompt that must not fire while someone is filing a report.
  useEffect(() => {
    let live = true;
    requestAsyncEnvironment().then(env => { if (live) envRef.current = env; });
    return () => { live = false; };
  }, []);

  // ── Frame sampling: refs only, so this never triggers a render ──
  useEffect(() => {
    let raf = 0;
    const tick = (now: number) => {
      const frames = framesRef.current;
      frames.push(now);
      const cutoff = now - WINDOW_MS;
      while (frames.length && frames[0] < cutoff) frames.shift();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // ── Long tasks: the signal that separates a busy main thread from a busy GPU ──
  useEffect(() => {
    if (typeof PerformanceObserver === 'undefined') return;
    let observer: PerformanceObserver | undefined;
    try {
      observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) blockedMsRef.current += entry.duration;
      });
      observer.observe({ entryTypes: ['longtask'] });
      setLongTaskSupported(true);
    } catch {
      // Safari has no `longtask` entry type. Leaving `longTaskSupported`
      // false makes the verdict report "cause unknown" rather than silently
      // attributing every dropped frame to the GPU.
      return;
    }
    return () => observer?.disconnect();
  }, []);

  // ── Activity: what the user was doing while the frames were being measured ──
  useEffect(() => {
    // Every handler reads `activityRef.current` at call time rather than
    // closing over the object. The flush zeroes these counters in place for
    // the same reason: an earlier version swapped in a fresh object each
    // flush, which silently orphaned the one these listeners were still
    // incrementing — the log kept recording zero activity forever after the
    // first interval, while looking perfectly healthy.
    const onPointerDown = () => {
      activityRef.current.clicks++;
      dragRef.current = { down: true, since: performance.now() };
    };
    const onPointerMove = () => {
      if (!dragRef.current.down) return;
      const now = performance.now();
      const gap = now - dragRef.current.since;
      dragRef.current.since = now;
      // Only time the pointer actually spent moving. Without the cap, a press
      // held still for five seconds and then nudged credits all five to the
      // move it ended on — which is how a 500ms interval came to report 5,004ms
      // of dragging, a number that cannot be true and quietly discredits the
      // column beside it. A gap this long is a stationary press, not a drag.
      if (gap <= MAX_DRAG_GAP_MS) activityRef.current.dragMs += gap;
    };
    const onPointerUp = () => { dragRef.current.down = false; };
    const onKeyDown = () => { activityRef.current.keys++; };
    const onWheel = () => { activityRef.current.scrolls++; };

    // Capture phase, so a handler that stops propagation cannot hide activity
    // from the log; passive, so the HUD never delays the very input it times.
    const opts = { capture: true, passive: true } as const;
    window.addEventListener('pointerdown', onPointerDown, opts);
    window.addEventListener('pointermove', onPointerMove, opts);
    window.addEventListener('pointerup', onPointerUp, opts);
    window.addEventListener('pointercancel', onPointerUp, opts);
    window.addEventListener('keydown', onKeyDown, opts);
    window.addEventListener('wheel', onWheel, opts);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, opts);
      window.removeEventListener('pointermove', onPointerMove, opts);
      window.removeEventListener('pointerup', onPointerUp, opts);
      window.removeEventListener('pointercancel', onPointerUp, opts);
      window.removeEventListener('keydown', onKeyDown, opts);
      window.removeEventListener('wheel', onWheel, opts);
    };
  }, []);

  const persist = useCallback(() => {
    try {
      localStorage.setItem(LOG_STORAGE_KEY, JSON.stringify(logRef.current));
    } catch {
      // A full or disabled localStorage must never take the HUD down — the
      // in-memory log and the exports still work without it.
    }
  }, []);

  // ── Durability: the throttle above can leave up to PERSIST_EVERY_MS of
  //    unsaved tail, and the tail is exactly the part someone was watching
  //    when they gave up and closed the tab. Flush on the way out. `pagehide`
  //    rather than `beforeunload` because it also fires when a tab is frozen
  //    or restored from the back/forward cache, which `beforeunload` misses.
  useEffect(() => {
    const onHide = () => persist();
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onHide);
      persist();
    };
  }, [persist]);

  // ── Flush: the only thing here that renders ──
  useEffect(() => {
    const id = setInterval(() => {
      const now = performance.now();
      if (!startedAtRef.current) startedAtRef.current = now;

      const frames = summariseFrames(framesRef.current);
      const blockedPct = longTaskSupported
        ? Math.min(100, (blockedMsRef.current / FLUSH_MS) * 100)
        : null;
      blockedMsRef.current = 0;

      const memory = (performance as Performance & { memory?: ChromeMemory }).memory;
      const heapMB = memory ? memory.usedJSHeapSize / 1048576 : null;
      const nextReading: PerfReading = { ...frames, blockedPct };

      const activity = activityRef.current;
      const events = drainPerfEvents();
      const { windows, active } = readWindows();
      logRef.current = appendRecord(logRef.current, {
        t: Math.round(now - startedAtRef.current),
        ...frames,
        blockedPct,
        heapMB,
        verdict: classify(nextReading).kind,
        windows,
        active,
        clicks: activity.clicks,
        keys: activity.keys,
        scrolls: activity.scrolls,
        dragMs: Math.round(activity.dragMs),
        menus: events.menus,
        submenus: events.submenus,
        menuKey: events.menuKey,
        moveMs: Math.round(events.moveMs),
        resizeMs: Math.round(events.resizeMs),
      });
      // Zero in place — never reassign. See the listener effect above.
      activity.clicks = 0;
      activity.keys = 0;
      activity.scrolls = 0;
      activity.dragMs = 0;

      // Zero means "never written", so the first flush always persists. Timing
      // the throttle off `performance.now()` alone would measure from page
      // load, not from when logging started — opening the HUD on a fresh page
      // would then leave the log unsaved for the first ten seconds, while
      // opening it on a long-lived tab would save on the very first flush.
      if (!persistedAtRef.current || now - persistedAtRef.current >= PERSIST_EVERY_MS) {
        persistedAtRef.current = now;
        persist();
      }

      setReading(nextReading);
      setHistory(prev => [...prev, frames.fps].slice(-HISTORY));
      setHeap(memory ? { usedMB: memory.usedJSHeapSize / 1048576, limitMB: memory.jsHeapSizeLimit / 1048576 } : null);
      setLogSize(logRef.current.length);
    }, FLUSH_MS);
    return () => clearInterval(id);
  }, [longTaskSupported, persist]);

  /** Freeze the log and open the composer. */
  const beginReport = useCallback(() => {
    snapshotRef.current = logRef.current.slice();
    setSendError(null);
    setComposing(true);
  }, []);

  const verdict = classify(reading);

  /** Build the report from the frozen snapshot. The summary rides alongside the
   *  raw records so whoever opens the file gets the conclusion without having
   *  to run the analysis themselves, and the user's own sentence goes in the
   *  file too — the attachment has to stand alone once it is detached from the
   *  message that carried it. */
  const buildReport = useCallback((): PerfReport => {
    const records = snapshotRef.current ?? logRef.current;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const summary = summariseLog(records);
    const environment = readEnvironment(envRef.current);
    return {
      message,
      filename: `perf-log-${stamp}.json`,
      summary,
      environment,
      verdict: verdict.label,
      json: JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          message,
          verdict: verdict.label,
          environment,
          summary,
          records,
        },
        null,
        2,
      ),
    };
  }, [message, verdict.label]);

  /** Fallback when no host channel is wired: the same JSON, to disk. */
  const downloadReport = useCallback((report: PerfReport) => {
    const url = URL.createObjectURL(new Blob([report.json], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = report.filename;
    link.click();
    URL.revokeObjectURL(url);
  }, []);

  const send = useCallback(async () => {
    const report = buildReport();
    setSending(true);
    setSendError(null);
    try {
      if (onSubmit) await onSubmit(report);
      else downloadReport(report);
      snapshotRef.current = null;
      setMessage('');
      setComposing(false);
    } catch (err) {
      // Keep the composer open with the text intact — retyping a description
      // of something that has already stopped happening is how a report stops
      // getting filed at all.
      setSendError(err instanceof Error && err.message ? err.message : 'Could not send. Try again.');
    } finally {
      setSending(false);
    }
  }, [buildReport, downloadReport, onSubmit]);

  const styles = VERDICT_STYLES[verdict.kind];
  const peak = Math.max(60, ...history);
  const loggedSeconds = Math.round((logSize * FLUSH_MS) / 1000);
  const sendLabel = onSubmit ? 'Send' : 'Download';
  const reportSamples = snapshotRef.current?.length ?? logSize;

  return (
    <div
      className={`w-56 rounded-lg border border-white/15 bg-[#11111b]/95 px-3 py-2 font-mono text-[10px] text-white/80 shadow-lg select-none ${className}`}
      /* No backdrop-filter here on purpose — see the module docstring. */
      role="status"
      aria-live="off"
      aria-label="Performance statistics"
    >
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-[9px] uppercase tracking-wider text-white/40">Performance</span>
        {onClose && (
          <button
            onClick={onClose}
            className="-mr-1 px-1 leading-none text-white/40 transition-colors hover:text-white/90"
            aria-label="Hide performance statistics"
          >
            ×
          </button>
        )}
      </div>

      <div className="flex items-baseline justify-between">
        <span className={`text-base font-semibold tabular-nums ${styles.text}`}>
          {reading.fps ? reading.fps.toFixed(0) : '—'}
          <span className="ml-1 text-[10px] font-normal text-white/40">fps</span>
        </span>
        <span className="tabular-nums text-white/50">
          {reading.frameMs ? `${reading.frameMs.toFixed(1)} ms` : '—'}
        </span>
      </div>

      {/* Frame-rate history. Plain divs: cheap to lay out, and a shape is far
          quicker to read than a column of numbers when hunting a periodic hitch. */}
      <div className="mt-1.5 flex h-5 items-end gap-px" aria-hidden="true">
        {Array.from({ length: HISTORY }, (_, i) => {
          const value = history[history.length - HISTORY + i];
          return (
            <div
              key={i}
              className={`flex-1 rounded-sm ${value === undefined ? 'bg-white/5' : styles.dot}`}
              style={{ height: value === undefined ? '2px' : `${Math.max(6, (value / peak) * 100)}%` }}
            />
          );
        })}
      </div>

      <dl className="mt-2 space-y-0.5">
        <Row label="worst frame" value={reading.worstMs ? `${reading.worstMs.toFixed(0)} ms` : '—'} />
        <Row
          label="main thread"
          value={reading.blockedPct === null ? 'n/a' : `${reading.blockedPct.toFixed(0)}% blocked`}
        />
        <Row
          label="JS heap"
          value={heap ? `${heap.usedMB.toFixed(0)} / ${heap.limitMB.toFixed(0)} MB` : 'n/a'}
        />
      </dl>

      <div className="mt-2 border-t border-white/10 pt-1.5">
        <div className="flex items-center gap-1.5">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${styles.dot}`} aria-hidden="true" />
          <span className={`font-semibold ${styles.text}`}>{verdict.label}</span>
        </div>
        <p className="mt-0.5 leading-snug text-white/45">{verdict.detail}</p>
      </div>

      <div className="mt-2 border-t border-white/10 pt-1.5">
        {composing ? (
          /* Composer. `select-text` because the panel as a whole is
             `select-none` — without it the user cannot correct their own
             sentence. */
          <div className="select-text space-y-1.5">
            <label className="block text-white/40" htmlFor="perf-report-message">
              What were you doing?
            </label>
            <textarea
              id="perf-report-message"
              value={message}
              onChange={e => setMessage(e.target.value)}
              rows={3}
              autoFocus
              placeholder="e.g. opening the second-level menu stutters"
              className="w-full resize-none rounded border border-white/15 bg-black/40 px-1.5 py-1 font-mono text-[10px] text-white/90 placeholder:text-white/25 focus:border-white/40 focus:outline-none"
            />
            {sendError && <p className="leading-snug text-rose-300">{sendError}</p>}
            <div className="flex items-center justify-between">
              {/* Just the count — "samples attached" wraps to a second line in
                  the panel's 224px and shoves the buttons down. */}
              <span className="text-white/35">{reportSamples} samples</span>
              <span className="flex gap-1">
                <button
                  onClick={() => { setComposing(false); snapshotRef.current = null; setSendError(null); }}
                  disabled={sending}
                  className="rounded border border-white/15 px-1.5 py-0.5 text-white/50 transition-colors hover:border-white/30 hover:text-white disabled:opacity-40"
                >
                  Cancel
                </button>
                <button
                  onClick={send}
                  disabled={sending}
                  className="rounded border border-white/30 bg-white/10 px-1.5 py-0.5 text-white/90 transition-colors hover:bg-white/20 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {sending ? 'Sending…' : sendLabel}
                </button>
              </span>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-between">
            <span className="text-white/35">
              log {logSize} · {loggedSeconds < 60 ? `${loggedSeconds}s` : `${Math.round(loggedSeconds / 60)}m`}
            </span>
            <button
              onClick={beginReport}
              disabled={!logSize}
              className="rounded border border-white/15 px-1.5 py-0.5 text-white/60 transition-colors hover:border-white/30 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
            >
              {onSubmit ? 'Report this' : 'Save report'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-white/40">{label}</dt>
      <dd className="tabular-nums text-white/70">{value}</dd>
    </div>
  );
}

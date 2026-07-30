/**
 * A perf report as plain text, for whatever the host files it into.
 *
 * The attachment is complete but nobody opens it first. A bug tracker shows
 * descriptions, so a performance report whose description is one sentence
 * about a stutter sits in the list looking like every other vague complaint
 * while the numbers that would rank it stay zipped inside a 140 KB file.
 *
 * So the description carries the findings: the machine, then the verdict, the
 * median, the worst frame, and the gesture that was slowest. That last line is
 * what changed the HUD's usefulness — the log marks menu opens, flyout opens
 * and window move/resize separately, so "slowest while: submenu (14 fps)" is a
 * sentence the report can lead with instead of leaving a triager to guess from
 * an average taken across a whole session.
 *
 * This lives in the shell rather than in each consuming portal because it is
 * pure formatting of a shell type and was otherwise going to exist three
 * times — which is how three copies quietly stop agreeing about what a report
 * says. What stays portal-side is everything genuinely portal-shaped: which
 * endpoint to post to, and which module list to seed from.
 */
import { describeMachine } from './perfEnvironment';
import type { PerfReport } from './PerfStats';

/** Groups worth naming in the description. More than this and the summary
 *  stops being a summary; the attachment has the rest. */
const TOP_GROUPS = 3;

/** A frame rate of zero is not a slow reading, it is the absence of one — the
 *  thread was too blocked to deliver frames at all. Printing "0 fps" makes it
 *  look like a measurement. */
const fps = (n: number): string => (n > 0 ? `${n.toFixed(0)} fps` : 'stalled');

const duration = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.round(seconds / 60)}m`;
};

/** The description body for a filed performance report. */
export function describePerfReport(report: PerfReport): string {
  const { summary, message, verdict, environment } = report;
  const lines: string[] = [`Performance report — ${verdict}`, ''];

  lines.push(message.trim() || '(No description given.)', '');

  // The machine, before the numbers. Whether 34 fps is a bad application or an
  // old laptop is not decidable from the frame rate, and a triager who has to
  // open the attachment to find out will mostly just guess instead.
  lines.push(`Machine: ${describeMachine(environment)}`);
  const net = environment.network;
  if (net?.effectiveType && net.effectiveType !== '4g') {
    // Only when it is not the unremarkable case — a slow link is a different
    // complaint from a slow UI, and worth separating before anyone profiles.
    lines.push(`Connection: ${net.effectiveType}${net.rttMs ? ` · ${net.rttMs} ms round trip` : ''}`);
  }
  lines.push('');

  lines.push(
    `Median ${fps(summary.medianFps)} over ${duration(summary.durationMs)} ` +
    `(${summary.samples} samples), worst frame ${summary.worstFrameMs.toFixed(0)} ms.`,
  );

  // Worst-first already, so the head of each list is the finding.
  const activity = summary.byActivity.slice(0, TOP_GROUPS);
  if (activity.length) {
    lines.push(
      `Slowest while: ${activity.map(a => `${a.kind} ${fps(a.medianFps)} (worst ${a.worstMs.toFixed(0)} ms)`).join(' · ')}`,
    );
  }

  const menu = summary.worstMenus[0];
  if (menu) lines.push(`Slowest menu: ${menu.key} — ${fps(menu.medianFps)}`);

  const win = summary.worstWindows[0];
  if (win) lines.push(`Slowest window: ${win.key} — ${fps(win.medianFps)}`);

  if (summary.idle && summary.interacting) {
    lines.push(`At rest ${fps(summary.idle.medianFps)} vs in use ${fps(summary.interacting.medianFps)}.`);
  }

  lines.push('', `Full log attached as ${report.filename}.`);
  return lines.join('\n');
}

/** The attachment. A `File` rather than a `Blob` so the multipart part carries
 *  the stamped filename the receiving end stores. */
export function perfReportFile(report: PerfReport): File {
  return new File([report.json], report.filename, { type: 'application/json' });
}

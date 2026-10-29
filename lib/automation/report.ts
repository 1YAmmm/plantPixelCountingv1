import { calibrationBaseline } from "../detection/baseline";
import type { DetectionSettings } from "../detection/settings";
import { hasDiscoloration, STATUS_LABELS, statusFromIndex, wiltIndex, type Status } from "../detection/status";
import type { Metrics } from "../vision/measure";
import type { QualityIssue } from "../vision/quality";
import { formatZoned } from "./schedule";

// The daily report (newplan.md step 3): the numbers of one automatic photo compared with the ESP32
// baseline, and the email that carries them. Pure, no I/O.

export interface PlantReport {
  /** "unknown" without a baseline or when the photo failed a check. */
  status: Status;
  /** Wilting index %, null without a baseline. Negative = grown since the baseline. */
  wilt: number | null;
  coverPct: number;
  discolorationPct: number;
  discolored: boolean;
  baselinePct: number | null;
  /** Why the photo cannot be trusted (too dark, blurry…). */
  issues: string[];
  valid: boolean;
}

export function buildReport(
  analysis: { metrics: Pick<Metrics, "coveragePct" | "discolorationPct">; issues: Pick<QualityIssue, "message">[] },
  { thresholds, baselineCoverPcts }: { thresholds: DetectionSettings; baselineCoverPcts: number[] },
): PlantReport {
  const { coveragePct, discolorationPct } = analysis.metrics;
  const issues = analysis.issues.map((i) => i.message);
  // Same rule as the Analyze page (result-view.tsx): any issue means the status is not computed.
  // Its tilt check needs the phone's motion sensor, so it does not apply to the fixed camera.
  const valid = issues.length === 0;
  const baselinePct = baselineCoverPcts.length ? calibrationBaseline(baselineCoverPcts) : null;
  const wilt = baselinePct != null ? wiltIndex(baselinePct, coveragePct) : null;
  return {
    status: valid ? statusFromIndex(wilt, thresholds) : "unknown",
    wilt,
    coverPct: coveragePct,
    discolorationPct,
    discolored: valid && hasDiscoloration(discolorationPct, thresholds),
    baselinePct,
    issues,
    valid,
  };
}

/** Content ids of the inline images (attachments with these cids). */
export const PHOTO_CID = "photo@plant-report";
export const OVERLAY_CID = "overlay@plant-report";

/** Hex versions of the status colours in app/globals.css (email clients do not support oklch). */
const STATUS_COLORS: Record<Status, string> = {
  healthy: "#16894a",
  mild: "#c4861b",
  wilting: "#c93a2e",
  unknown: "#84878e",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function pct(value: number | null, digits = 1): string {
  return value == null ? "—" : `${value.toFixed(digits)}%`;
}

export interface EmailOptions {
  /** When the photo was taken, epoch ms. */
  takenAt: number;
  timeZone: string;
  /** Taken well after the set time (the camera was offline). */
  late: boolean;
  /** The scheduled time, epoch ms, for the late note. */
  scheduledAt?: number | null;
  /** Inline photo and overlay (attached with PHOTO_CID / OVERLAY_CID). */
  images: boolean;
  /** "Send test email": sample numbers, no photo. */
  test?: boolean;
  /** A test photo asked for from the Settings page. */
  manual?: boolean;
}

export function renderReportEmail(report: PlantReport, opts: EmailOptions): { subject: string; html: string; text: string } {
  const when = formatZoned(opts.takenAt, opts.timeZone);
  const label = STATUS_LABELS[report.status];
  const prefix = opts.test ? "Test email · " : opts.manual ? "Test photo · " : "";
  const subject = `${prefix}Plant report · ${when} · ${label}`;
  const color = STATUS_COLORS[report.status];

  const notes: string[] = [];
  if (opts.test) notes.push("This is a test email from the plant monitor. The numbers below are an example; real reports also include the photo.");
  if (opts.late && opts.scheduledAt != null) {
    notes.push(`Late: this photo was due at ${formatZoned(opts.scheduledAt, opts.timeZone, { year: false })}. The camera was offline then.`);
  }
  if (!report.valid) notes.push(`Photo problem: ${report.issues.join("; ")}. Status not computed.`);
  else if (report.baselinePct == null) notes.push("No baseline yet: take 3 healthy ESP32-CAM photos on the Analyze page, then copy the settings again on the Settings page.");

  const rows: Array<[string, string]> = [
    ["Wilting index", report.wilt == null ? "—" : `${Math.max(0, report.wilt).toFixed(1)}%${report.wilt < 0 ? " (grown since the baseline)" : ""}`],
    ["Leaf cover", `${pct(report.coverPct)} of the guide square`],
    ["Discoloration", `${pct(report.discolorationPct)}${report.discolored ? " (above the note threshold)" : ""}`],
    ["Baseline", report.baselinePct == null ? "not set" : `${pct(report.baselinePct)} leaf cover`],
  ];

  const text = [
    subject,
    "",
    `Status: ${label}`,
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(notes.length ? ["", ...notes] : []),
    "",
    "Sent by the plant monitor. Change the days, time or recipients on the Settings page.",
  ].join("\n");

  const e = escapeHtml;
  const cell = "padding:6px 0;border-bottom:1px solid #e5e7eb;font-size:14px;";
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#111827;">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px;border:1px solid #e5e7eb;">
<p style="margin:0 0 4px;font-size:13px;color:#6b7280;">${e(prefix)}Plant report · ${e(when)}</p>
<p style="margin:0 0 16px;"><span style="display:inline-block;padding:4px 12px;border-radius:999px;font-weight:600;font-size:16px;color:${color};background:${color}1f;border:1px solid ${color}55;">${e(label)}</span></p>
${notes.map((n) => `<p style="margin:0 0 12px;padding:10px 12px;border-radius:8px;background:#fef3c7;color:#78350f;font-size:13px;">${e(n)}</p>`).join("\n")}
<table role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 16px;">
${rows.map(([k, v]) => `<tr><td style="${cell}color:#6b7280;">${e(k)}</td><td style="${cell}text-align:right;font-weight:600;">${e(v)}</td></tr>`).join("\n")}
</table>
${
  opts.images
    ? `<p style="margin:0 0 6px;font-size:13px;color:#6b7280;">Photo (guide square) and analysis overlay: green = leaf, orange = yellow/brown, yellow outline = plant region.</p>
<img src="cid:${PHOTO_CID}" alt="Plant photo" width="512" style="display:block;width:100%;max-width:512px;border-radius:8px;margin:0 0 8px;">
<img src="cid:${OVERLAY_CID}" alt="Analysis overlay" width="512" style="display:block;width:100%;max-width:512px;border-radius:8px;">`
    : ""
}
<p style="margin:16px 0 0;font-size:12px;color:#9ca3af;">Sent by the plant monitor. Change the days, time or recipients on the Settings page.</p>
</div></body></html>`;

  return { subject, html, text };
}

/** Example numbers for "Send test email". */
export const SAMPLE_REPORT: PlantReport = {
  status: "healthy",
  wilt: 3.2,
  coverPct: 41.5,
  discolorationPct: 2.1,
  discolored: false,
  baselinePct: 42.9,
  issues: [],
  valid: true,
};

import type { ReportSummary } from "@/lib/automation/config";
import { buildReport, OVERLAY_CID, PHOTO_CID, renderReportEmail, type PlantReport } from "@/lib/automation/report";
import { LATE_AFTER_MS, slotTime } from "@/lib/automation/schedule";
import { DEFAULT_DETECTION_SETTINGS } from "@/lib/detection/settings";
import { requireDevice } from "@/lib/server/auth";
import { acceptsSlot, isSlotId, KEYS, readConfig, REPORT_TTL_SEC } from "@/lib/server/automation";
import { sendEmail } from "@/lib/server/email";
import { getKv } from "@/lib/server/kv";
import { SQUARE_PX } from "@/lib/vision/guide";
import { cropGuideSquare, runPipeline } from "@/lib/vision/node";
import { DEFAULT_VISION_SETTINGS } from "@/lib/vision/settings";

// The camera uploads the photo it was asked for (newplan.md step 5): crop the guide square, run the
// pipeline, compare with the baseline, email everyone, keep a short summary for the Settings page.
//
// Body: the JPEG (Content-Type: image/jpeg). Headers: X-Slot (from the poll), Authorization.
// Replies text/plain: "ok", "duplicate" (already done; a retry after a lost reply) or an error.
// Each slot is processed once: the report key doubles as the lock. If processing fails the lock
// is released and the reply is 500, so the camera tries again.

export const maxDuration = 60;

/** Vercel accepts request bodies up to 4.5 MB. A UXGA photo is about 200 KB. */
const MAX_BYTES = 4 * 1024 * 1024;

function reply(body: string, status = 200) {
  return new Response(`${body}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function POST(request: Request) {
  const denied = requireDevice(request);
  if (denied) return denied;

  const slot = request.headers.get("x-slot")?.trim() ?? "";
  if (!isSlotId(slot)) return reply("missing or invalid X-Slot", 400);

  const kv = getKv();
  const now = Date.now();
  if (await kv.get(KEYS.report(slot))) return reply("duplicate");
  const config = await readConfig(kv);
  if (!acceptsSlot(config, slot, now)) return reply("this photo was not asked for", 409);

  const jpeg = Buffer.from(await request.arrayBuffer());
  if (jpeg.length === 0) return reply("empty photo", 400);
  if (jpeg.length > MAX_BYTES) return reply("photo larger than 4 MB", 413);
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return reply("not a JPEG", 415);

  const scheduledAt = slotTime(slot);
  const base = {
    slotId: slot,
    receivedAt: new Date(now).toISOString(),
    scheduledAt: scheduledAt != null ? new Date(scheduledAt).toISOString() : null,
    late: scheduledAt != null && now - scheduledAt > LATE_AFTER_MS,
  };
  const locked = await kv.setIfAbsent(KEYS.report(slot), { ...base, state: "processing" }, { ttlSec: REPORT_TTL_SEC });
  if (!locked) return reply("duplicate");

  const analysis = config.analysis ?? { vision: DEFAULT_VISION_SETTINGS, thresholds: DEFAULT_DETECTION_SETTINGS, baselineCoverPcts: [] };
  let report: PlantReport;
  let images: { photo: Buffer; overlay: Buffer };
  try {
    const square = await cropGuideSquare(jpeg);
    const result = await runPipeline(square, { settings: analysis.vision, roi: null, maxLongEdge: SQUARE_PX });
    report = buildReport(result.analysis, analysis);
    images = { photo: result.imageJpeg, overlay: result.overlayJpeg };
  } catch (e) {
    console.error("[captures] analysis failed", e);
    await kv.del(KEYS.report(slot));
    return reply("could not analyze the photo", 500);
  }

  const recipients = config.recipients ?? [];
  let emailError: string | null = null;
  try {
    const email = renderReportEmail(report, {
      takenAt: now,
      timeZone: config.schedule?.timeZone ?? "UTC",
      late: base.late,
      scheduledAt,
      images: true,
      manual: scheduledAt == null,
    });
    await sendEmail({
      to: recipients,
      ...email,
      attachments: [
        { filename: "plant-photo.jpg", content: images.photo, contentType: "image/jpeg", cid: PHOTO_CID },
        { filename: "plant-overlay.jpg", content: images.overlay, contentType: "image/jpeg", cid: OVERLAY_CID },
      ],
    });
  } catch (e) {
    console.error("[captures] email failed", e);
    emailError = errorMessage(e);
  }

  const summary: ReportSummary = {
    ...base,
    state: "done",
    status: report.status,
    wilt: report.wilt,
    coverPct: report.coverPct,
    discolorationPct: report.discolorationPct,
    baselinePct: report.baselinePct,
    issues: report.issues,
    sentTo: emailError ? [] : recipients,
    emailError,
  };
  await kv.set(KEYS.report(slot), summary, { ttlSec: REPORT_TTL_SEC });
  await kv.set(KEYS.lastReport, slot);
  if (config.captureNow === slot) {
    // Re-read: the schedule or recipients may have been saved meanwhile.
    const latest = await readConfig(kv);
    if (latest.captureNow === slot) await kv.set(KEYS.config, { ...latest, captureNow: undefined });
  }
  return reply(emailError ? "ok (email failed)" : "ok");
}

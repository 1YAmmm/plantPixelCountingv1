import type { AnalyzeError, AnalyzeResponse } from "@/lib/analyze-api";
import { SQUARE_PX } from "@/lib/vision/guide";
import { runPipeline } from "@/lib/vision/node";
import { clampNormRect, isFullFrame } from "@/lib/vision/roi";
import { parseVisionSettings } from "@/lib/vision/settings";
import type { NormRect } from "@/lib/vision/types";

// Runs the full pixel-counting pipeline (plan §5) on one photo and returns the numbers and the
// overlay. Nothing is stored. The browser sends the guide-square crop (see lib/vision/guide.ts);
// any other image is analyzed whole, resized so its long edge is SQUARE_PX.
//
// multipart/form-data fields:
//   image     JPEG/PNG/WebP photo (required)
//   settings  JSON vision settings (optional; missing fields use defaults)
//   roi       JSON {x, y, width, height} crop box, normalized 0–1 (optional)
//   prepared  "true" when re-sending the imageDataUrl from a previous response (skips resizing)

const MAX_BYTES = 20 * 1024 * 1024;

function fail(error: string, status: number) {
  return Response.json({ error } satisfies AnalyzeError, { status });
}

function parseJson(value: FormDataEntryValue | null): unknown {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parseRoi(value: unknown): NormRect | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (![r.x, r.y, r.width, r.height].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const rect = clampNormRect(r as unknown as NormRect);
  return isFullFrame(rect) || rect.width < 0.02 || rect.height < 0.02 ? null : rect;
}

export async function POST(request: Request) {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail("Send the photo as multipart/form-data with an 'image' field.", 400);
  }
  const file = form.get("image");
  if (!(file instanceof Blob) || file.size === 0) return fail("Missing image.", 400);
  if (file.size > MAX_BYTES) return fail("The photo is larger than 20 MB.", 413);

  const settings = parseVisionSettings(parseJson(form.get("settings")));
  const roi = parseRoi(parseJson(form.get("roi")));
  const prepared = form.get("prepared") === "true";

  let result: Awaited<ReturnType<typeof runPipeline>>;
  try {
    result = await runPipeline(Buffer.from(await file.arrayBuffer()), {
      settings,
      roi,
      maxLongEdge: prepared ? "prepared" : SQUARE_PX,
    });
  } catch (error) {
    console.error("[analyze] pipeline failed", error);
    return fail("Could not read the image. Use a JPEG, PNG or WebP photo.", 422);
  }

  const a = result.analysis;
  const body: AnalyzeResponse = {
    width: a.width,
    height: a.height,
    roi,
    metrics: a.metrics,
    whiteBalance: { applied: a.whiteBalance.applied, gains: a.whiteBalance.gains },
    brightnessPct: a.brightnessPct,
    sharpness: a.sharpness,
    issues: a.issues,
    cleanup: a.cleanup,
    timingsMs: a.timingsMs,
    totalMs: result.totalMs,
    imageDataUrl: `data:image/jpeg;base64,${result.imageJpeg.toString("base64")}`,
    overlayDataUrl: `data:image/jpeg;base64,${result.overlayJpeg.toString("base64")}`,
  };
  return Response.json(body);
}

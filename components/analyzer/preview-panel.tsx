"use client";

import { Check, Loader2, RotateCcw, ScanLine, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActionBar, Stat } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { canvasToRgb, drawMask, drawScaled } from "@/lib/browser/image";
import { usePreviewJob } from "@/lib/browser/preview-worker";
import { formatNumber, formatPct } from "@/lib/format";
import { LEVEL_TOLERANCE_DEG } from "@/lib/vision/guide";
import type { VisionSettings } from "@/lib/vision/settings";

// Plan §7.2 preview step: the square photo with its mask, an estimated leaf cover and quality
// warnings, computed in the browser with the same rules as the server. Retake or analyze.
// The photo shows at once; the checks run in a worker and fill in a moment later.

const PREVIEW_EDGE = 500;

/** Warning shown when the phone was not held flat (the level indicator was not green). */
export function tiltWarning(tiltDeg: number | null): string | null {
  return tiltDeg != null && tiltDeg > LEVEL_TOLERANCE_DEG ? `Phone was tilted ${Math.round(tiltDeg)}° — hold it flat` : null;
}

export function PreviewPanel({
  photo,
  tiltDeg,
  settings,
  analyzing,
  onRetake,
  onAnalyze,
}: {
  photo: HTMLCanvasElement;
  tiltDeg: number | null;
  settings: VisionSettings;
  analyzing: boolean;
  onRetake: () => void;
  onAnalyze: () => void;
}) {
  const photoRef = useRef<HTMLCanvasElement>(null);
  const maskRef = useRef<HTMLCanvasElement>(null);
  const [showMask, setShowMask] = useState(true);
  const pixels = useMemo(() => canvasToRgb(drawScaled(photo, photo.width, photo.height, PREVIEW_EDGE)), [photo]);
  const preview = usePreviewJob("preview", pixels, settings);

  const warnings = [...(preview?.issues.map((i) => i.message) ?? []), tiltWarning(tiltDeg)].filter((w): w is string => !!w);

  useEffect(() => {
    photoRef.current?.getContext("2d")!.drawImage(photo, 0, 0);
  }, [photo]);

  useEffect(() => {
    if (preview) drawMask(maskRef.current, preview);
  }, [preview]);

  return (
    <div className="space-y-4">
      <div className="relative mx-auto overflow-hidden rounded-xl border bg-muted" style={{ maxWidth: "62svh" }}>
        <canvas ref={photoRef} width={photo.width} height={photo.height} role="img" aria-label="Captured photo (guide square)" className="block h-auto w-full" />
        <canvas ref={maskRef} aria-hidden className={showMask && preview ? "absolute inset-0 size-full" : "hidden"} />
      </div>

      <label className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <Switch checked={showMask} onCheckedChange={setShowMask} /> Show mask preview
        <span className="flex items-center gap-3 text-xs text-muted-foreground sm:ml-1">
          <span className="flex items-center gap-1">
            <span className="size-2.5 rounded-sm bg-[#22c55e]" /> leaf
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2.5 rounded-sm bg-[#f97316]" /> yellow/brown
          </span>
        </span>
      </label>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Estimated leaf cover" value={preview ? formatPct(preview.estimatedCoverPct) : "…"} hint="of the square, before cleanup" />
        <Stat label="Level" value={tiltDeg == null ? "—" : `${Math.round(tiltDeg)}°`} hint={tiltDeg == null ? "no tilt sensor" : `ok ≤ ${LEVEL_TOLERANCE_DEG}°`} />
        <Stat label="Brightness" value={preview ? `${preview.brightnessPct.toFixed(0)}%` : "…"} hint={`ok ${settings.quality.minBrightness}–${settings.quality.maxBrightness}%`} />
        <Stat label="Sharpness" value={preview ? formatNumber(preview.sharpness) : "…"} hint={`min ${settings.quality.minSharpness}`} />
      </div>

      {warnings.length > 0 ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Retake recommended</AlertTitle>
          <AlertDescription>
            <ul className="list-inside list-disc">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : preview ? (
        <Alert>
          <Check />
          <AlertTitle>Looks good</AlertTitle>
          <AlertDescription>Analyze it to get the official numbers after mask cleanup.</AlertDescription>
        </Alert>
      ) : (
        <Alert>
          <Loader2 className="animate-spin" />
          <AlertTitle>Checking the photo…</AlertTitle>
          <AlertDescription>Brightness, sharpness and an estimate of the leaf cover.</AlertDescription>
        </Alert>
      )}

      <ActionBar>
        <Button variant="outline" size="lg" onClick={onRetake} disabled={analyzing}>
          <RotateCcw /> Retake
        </Button>
        <Button size="lg" onClick={onAnalyze} disabled={analyzing} className="sm:min-w-40">
          {analyzing ? <Loader2 className="animate-spin" /> : <ScanLine />}
          {analyzing ? "Analyzing…" : "Analyze"}
        </Button>
      </ActionBar>
    </div>
  );
}

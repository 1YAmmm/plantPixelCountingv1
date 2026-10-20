"use client";
/* eslint-disable @next/next/no-img-element -- local data URL of the captured photo */

import { Check, Loader2, RotateCcw, ScanLine, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Stat } from "@/components/page-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { canvasToRgb, drawScaled } from "@/lib/browser/image";
import { formatNumber, formatPct } from "@/lib/format";
import { LEVEL_TOLERANCE_DEG } from "@/lib/vision/guide";
import { previewAnalyze } from "@/lib/vision/preview";
import type { VisionSettings } from "@/lib/vision/settings";

// Plan §7.2 preview step: the square photo with its mask, an estimated leaf cover and quality
// warnings, computed in the browser with the same rules as the server. Retake or analyze.

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
  const maskRef = useRef<HTMLCanvasElement>(null);
  const [showMask, setShowMask] = useState(true);
  const photoUrl = useMemo(() => photo.toDataURL("image/jpeg", 0.85), [photo]);

  const preview = useMemo(() => {
    const small = drawScaled(photo, photo.width, photo.height, PREVIEW_EDGE);
    return previewAnalyze(canvasToRgb(small), settings);
  }, [photo, settings]);

  const warnings = [...preview.issues.map((i) => i.message), tiltWarning(tiltDeg)].filter((w): w is string => !!w);

  useEffect(() => {
    const canvas = maskRef.current;
    if (!canvas) return;
    canvas.width = preview.width;
    canvas.height = preview.height;
    canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(preview.maskRgba), preview.width, preview.height), 0, 0);
  }, [preview]);

  return (
    <div className="space-y-4">
      <div className="relative mx-auto overflow-hidden rounded-xl border bg-muted" style={{ maxWidth: "62vh" }}>
        <img src={photoUrl} alt="Captured photo (guide square)" className="block w-full" />
        <canvas ref={maskRef} aria-hidden className={showMask ? "absolute inset-0 size-full" : "hidden"} />
      </div>

      <label className="flex items-center gap-2 text-sm">
        <Switch checked={showMask} onCheckedChange={setShowMask} /> Show mask preview
        <span className="ml-1 flex items-center gap-3 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="size-2.5 rounded-sm bg-[#22c55e]" /> leaf
          </span>
          <span className="flex items-center gap-1">
            <span className="size-2.5 rounded-sm bg-[#f97316]" /> yellow/brown
          </span>
        </span>
      </label>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Stat label="Estimated leaf cover" value={formatPct(preview.estimatedCoverPct)} hint="of the square, before cleanup" />
        <Stat label="Level" value={tiltDeg == null ? "—" : `${Math.round(tiltDeg)}°`} hint={tiltDeg == null ? "no tilt sensor" : `ok ≤ ${LEVEL_TOLERANCE_DEG}°`} />
        <Stat label="Brightness" value={`${preview.brightnessPct.toFixed(0)}%`} hint={`ok ${settings.quality.minBrightness}–${settings.quality.maxBrightness}%`} />
        <Stat label="Sharpness" value={formatNumber(preview.sharpness)} hint={`min ${settings.quality.minSharpness}`} />
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
      ) : (
        <Alert>
          <Check />
          <AlertTitle>Looks good</AlertTitle>
          <AlertDescription>Analyze it to get the official numbers after mask cleanup.</AlertDescription>
        </Alert>
      )}

      <div className="grid grid-cols-2 gap-2 sm:flex">
        <Button variant="outline" size="lg" onClick={onRetake} disabled={analyzing}>
          <RotateCcw /> Retake
        </Button>
        <Button size="lg" onClick={onAnalyze} disabled={analyzing} className="sm:min-w-40">
          {analyzing ? <Loader2 className="animate-spin" /> : <ScanLine />}
          {analyzing ? "Analyzing…" : "Analyze"}
        </Button>
      </div>
    </div>
  );
}

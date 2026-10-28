"use client";
/* eslint-disable @next/next/no-img-element -- data URLs returned by /api/analyze */

import { CircleCheck, Crop, Download, RotateCcw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { cn } from "cn";
import { Stat } from "@/components/page-header";
import { DiscolorationNote } from "@/components/status-badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { AnalyzeResponse } from "@/lib/analyze-api";
import { thresholdStore, type CameraSource } from "@/lib/browser/store";
import { hasDiscoloration } from "@/lib/detection/status";
import { formatNumber, formatPct } from "@/lib/format";
import type { NormRect } from "@/lib/vision/types";
import { BaselineCard } from "./baseline-card";
import { CropEditor } from "./crop-editor";
import { tiltWarning } from "./preview-panel";

const LEGEND = [
  { label: "Leaf (green)", className: "bg-[#22c55e]" },
  { label: "Yellow/brown", className: "bg-[#f97316]" },
  { label: "Plant region", className: "bg-[#facc15]" },
];

export function ResultView({
  result,
  source,
  tiltDeg,
  busy,
  onRecrop,
  onNew,
}: {
  result: AnalyzeResponse;
  source: CameraSource;
  tiltDeg: number | null;
  busy: boolean;
  onRecrop: (roi: NormRect | null) => Promise<boolean>;
  onNew: () => void;
}) {
  const [view, setView] = useState<"overlay" | "original">("overlay");
  const [cropping, setCropping] = useState(false);
  const thresholds = thresholdStore.useValue();
  const m = result.metrics;
  const problems = [...result.issues.map((i) => i.message), tiltWarning(tiltDeg)].filter((p): p is string => !!p);
  const valid = problems.length === 0;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="space-y-3">
        {cropping ? (
          <CropEditor
            imageUrl={result.imageDataUrl}
            aspect={result.width / result.height}
            initial={result.roi}
            busy={busy}
            onCancel={() => setCropping(false)}
            onApply={async (roi) => {
              if (await onRecrop(roi)) setCropping(false);
            }}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex gap-1 rounded-lg bg-muted p-1 text-sm">
                {(["overlay", "original"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    onClick={() => setView(v)}
                    className={cn(
                      "rounded-md px-3 py-1 capitalize text-muted-foreground pointer-coarse:py-2",
                      view === v && "bg-background font-medium text-foreground shadow-sm",
                    )}
                  >
                    {v}
                  </button>
                ))}
              </div>
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" onClick={() => setCropping(true)} disabled={busy}>
                  <Crop /> {result.roi ? "Edit crop" : "Crop"}
                </Button>
                <Button asChild variant="ghost" size="sm">
                  <a href={view === "overlay" ? result.overlayDataUrl : result.imageDataUrl} download={`plant-${view}.jpg`}>
                    <Download /> Save
                  </a>
                </Button>
              </div>
            </div>
            <div
              className={cn("mx-auto overflow-hidden rounded-xl border bg-muted transition-opacity", busy && "opacity-50")}
              style={{ maxWidth: `calc(70svh * ${result.width / result.height})` }}
            >
              <img src={view === "overlay" ? result.overlayDataUrl : result.imageDataUrl} alt={view === "overlay" ? "Analysis overlay" : "Analyzed photo"} className="block w-full" />
            </div>
            {view === "overlay" && (
              <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                {LEGEND.map((l) => (
                  <li key={l.label} className="flex items-center gap-1.5">
                    <span className={cn("size-2.5 rounded-sm", l.className)} /> {l.label}
                  </li>
                ))}
                {result.roi && <li>Dimmed: outside the crop box</li>}
              </ul>
            )}
          </>
        )}
      </div>

      <div className="space-y-4">
        {valid ? (
          <Alert>
            <CircleCheck />
            <AlertTitle>Valid capture</AlertTitle>
            <AlertDescription>Passed the level, brightness and sharpness checks.</AlertDescription>
          </Alert>
        ) : (
          <Alert variant="destructive">
            <TriangleAlert />
            <AlertTitle>Rejected — retake the photo</AlertTitle>
            <AlertDescription>
              <ul className="list-inside list-disc">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {/* Side by side from 360 px: narrower tiles cannot fit the discoloration note. */}
        <div className="grid grid-cols-1 gap-2 min-[360px]:grid-cols-2">
          <div className="min-[360px]:col-span-2">
            <Stat large label="Leaf cover" value={formatPct(m.coveragePct)} hint={`of the guide square · ${formatNumber(m.leafPixels)} leaf pixels`} />
          </div>
          <Stat
            label="Discoloration"
            value={formatPct(m.discolorationPct)}
            hint={hasDiscoloration(m.discolorationPct, thresholds) ? <DiscolorationNote pct={m.discolorationPct} className="mt-1" /> : "yellow/brown in plant region"}
          />
          <Stat label="Stressed pixels" value={formatNumber(m.stressedPixels)} />
        </div>

        <BaselineCard result={result} source={source} valid={valid} onNext={onNew} />

        <details className="rounded-lg border bg-card px-4 py-3 text-sm">
          <summary className="cursor-pointer font-medium">Analysis details</summary>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 tabular-nums">
            <dt className="text-muted-foreground">Camera</dt>
            <dd>{source === "esp32" ? "ESP32-CAM (Bluetooth)" : "Phone"}</dd>
            <dt className="text-muted-foreground">Image</dt>
            <dd>
              {result.width} × {result.height} px (guide square)
            </dd>
            <dt className="text-muted-foreground">Level</dt>
            <dd>{tiltDeg == null ? "no tilt sensor" : `${tiltDeg.toFixed(1)}° from flat`}</dd>
            <dt className="text-muted-foreground">White balance</dt>
            <dd>
              {result.whiteBalance.applied
                ? `from the white background · R ${result.whiteBalance.gains[0].toFixed(2)} · G ${result.whiteBalance.gains[1].toFixed(2)} · B ${result.whiteBalance.gains[2].toFixed(2)}`
                : "not applied (not enough white background visible)"}
            </dd>
            <dt className="text-muted-foreground">Brightness</dt>
            <dd>{result.brightnessPct.toFixed(0)}%</dd>
            <dt className="text-muted-foreground">Sharpness</dt>
            <dd>{result.sharpness.toFixed(0)}</dd>
            <dt className="text-muted-foreground">Plant height</dt>
            <dd>{m.plantHeightPx != null ? `${m.plantHeightPx} px (for side views)` : "—"}</dd>
            <dt className="text-muted-foreground">Region of interest</dt>
            <dd>
              {formatNumber(m.roiPixels)} px{result.roi ? " (cropped)" : ""}
            </dd>
            <dt className="text-muted-foreground">Leaf blobs</dt>
            <dd>
              {result.cleanup.keptBlobs} kept of {result.cleanup.blobCount}
            </dd>
            <dt className="text-muted-foreground">Processing</dt>
            <dd>
              {result.totalMs} ms ({Object.entries(result.timingsMs).map(([k, v]) => `${k} ${v}`).join(", ")})
            </dd>
          </dl>
        </details>

        <Button size="lg" className="w-full" onClick={onNew}>
          <RotateCcw /> New photo
        </Button>
      </div>
    </div>
  );
}

"use client";

import { Check, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { DiscolorationNote, StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { AnalyzeResponse } from "@/lib/analyze-api";
import { loadImage, thumbnailDataUrl } from "@/lib/browser/image";
import { BASELINE_SAMPLES, baselineStores, thresholdStore, useBaseline, type CameraSource } from "@/lib/browser/store";
import { calibrationBaseline } from "@/lib/detection/baseline";
import { hasDiscoloration, statusFromIndex, wiltIndex } from "@/lib/detection/status";
import { formatDateTime, formatPct, formatWilt } from "@/lib/format";

// Optional comparison with a healthy baseline kept in this browser (plan §6.1–6.3): the baseline is
// the average leaf cover of up to 3 healthy photos; the wilting index is the share of it now missing.
// Only meaningful when every photo is framed the same way (pot rim on the circle, phone flat), so
// the phone and the ESP32-CAM each keep their own baseline.

const SOURCE_LABEL: Record<CameraSource, string> = { phone: "phone", esp32: "ESP32-CAM" };

export function BaselineCard({ result, source, valid, onNext }: { result: AnalyzeResponse; source: CameraSource; valid: boolean; onNext: () => void }) {
  const store = baselineStores[source];
  const { samples } = useBaseline(source);
  const thresholds = thresholdStore.useValue();
  // Remember which result was added so the same photo cannot be counted twice (a re-crop is a new result).
  const [addedFor, setAddedFor] = useState<AnalyzeResponse | null>(null);
  const added = addedFor === result;
  const cover = result.metrics.coveragePct;
  const baseline = samples.length ? calibrationBaseline(samples.map((s) => s.coverPct)) : null;
  const wilt = baseline != null ? wiltIndex(baseline, cover) : null;
  const status = statusFromIndex(wilt, thresholds);

  async function addSample() {
    let thumb: string | undefined;
    try {
      thumb = thumbnailDataUrl(await loadImage(result.imageDataUrl));
    } catch {
      thumb = undefined;
    }
    const next = [...samples, { coverPct: cover, at: new Date().toISOString(), thumb }].slice(-BASELINE_SAMPLES);
    // Only the newest sample keeps its thumbnail (used as the ghost overlay) to stay small.
    const saved = store.write({ samples: next.map((s, i) => (i === next.length - 1 ? s : { ...s, thumb: undefined })) });
    setAddedFor(result);
    const more = next.length < BASELINE_SAMPLES;
    if (!saved) toast.warning("Added for this visit only: this browser blocked saving.");
    else toast.success(`Added to baseline (${next.length}/${BASELINE_SAMPLES})${more ? ". Take the next photo." : ""}`);
    // Until the baseline is complete, go straight back to the camera (with the ghost overlay) for the next photo.
    if (more) onNext();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Baseline comparison</CardTitle>
        <CardDescription>
          Water the plant, wait about an hour, then add {BASELINE_SAMPLES} good photos. Later photos are compared with their average leaf cover, so
          frame the pot the same way every time. The phone and the ESP32-CAM each have their own baseline.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {baseline != null ? (
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge status={valid ? status : "unknown"} size="lg" />
              {valid && hasDiscoloration(result.metrics.discolorationPct, thresholds) && <DiscolorationNote pct={result.metrics.discolorationPct} />}
            </div>
            <p className="text-sm text-muted-foreground">
              {valid ? (
                <>
                  Wilting index <span className="font-semibold text-foreground">{formatWilt(wilt)}</span>
                  {wilt != null && wilt < 0 && " (grown since the baseline)"}
                </>
              ) : (
                "Not compared: the photo failed a check."
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              Baseline {formatPct(baseline)} leaf cover · {samples.length} sample{samples.length === 1 ? "" : "s"}, last{" "}
              {formatDateTime(samples[samples.length - 1].at)} · thresholds {thresholds.mildPct}% / {thresholds.wiltingPct}%
            </p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No {SOURCE_LABEL[source]} baseline yet. Add this photo if the plant is well watered and healthy.</p>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={addSample} disabled={!valid || added}>
            {added ? (
              <>
                <Check /> Added to baseline
              </>
            ) : (
              <>
                <Plus /> Add to baseline ({Math.min(samples.length, BASELINE_SAMPLES)}/{BASELINE_SAMPLES})
              </>
            )}
          </Button>
          {samples.length > 0 && (
            <Button
              variant="ghost"
              onClick={() => {
                store.write(null);
                setAddedFor(null);
                toast("Baseline cleared");
              }}
            >
              <Trash2 /> Clear baseline
            </Button>
          )}
        </div>
        {!valid && <p className="text-xs text-muted-foreground">Only photos that pass all checks can be added.</p>}
      </CardContent>
    </Card>
  );
}

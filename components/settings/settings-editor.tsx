"use client";
/* eslint-disable @next/next/no-img-element -- local sample photo */

import { Download, ImageUp, RotateCcw, Save, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import { canvasToRgb, drawMask, drawScaled, fileToSquare, loadImage } from "@/lib/browser/image";
import { usePreviewJob } from "@/lib/browser/preview-worker";
import { cameraSourceStore, thresholdStore, useBaseline, visionSettingsStore } from "@/lib/browser/store";
import { DEFAULT_DETECTION_SETTINGS, detectionSettingsSchema, type DetectionSettings } from "@/lib/detection/settings";
import { formatNumber, formatPct } from "@/lib/format";
import { DEFAULT_VISION_SETTINGS, visionSettingsSchema, type HsvRule, type VisionSettings } from "@/lib/vision/settings";

// Plan §7.6, simplified: what counts as leaf and the wilting thresholds are always shown, with a
// live preview on a sample photo; everything else is under "Advanced settings". Saved in this
// browser; export/import moves the settings between devices.

const SAMPLE_EDGE = 500;

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  hint?: ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="text-sm font-normal">{label}</Label>
        <div className="flex items-center gap-1">
          <Input
            type="number"
            className="h-7 w-20 text-right tabular-nums pointer-coarse:h-9"
            value={value}
            min={min}
            max={max}
            step={step}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (e.target.value !== "" && Number.isFinite(n)) onChange(n);
            }}
          />
          {unit && <span className="w-6 text-xs text-muted-foreground">{unit}</span>}
        </div>
      </div>
      <Slider min={min} max={max} step={step} value={[Math.min(max, Math.max(min, value))]} onValueChange={([v]) => onChange(v)} aria-label={label} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

const HUE_GRADIENT =
  "linear-gradient(to right, hsl(0 85% 50%), hsl(60 85% 50%), hsl(120 85% 45%), hsl(180 85% 45%), hsl(240 85% 55%), hsl(300 85% 50%), hsl(360 85% 50%))";

function HsvFields({ rule, onChange }: { rule: HsvRule; onChange: (rule: HsvRule) => void }) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <div className="flex items-center justify-between text-sm">
          <Label className="font-normal">Colour (hue) range</Label>
          <span className="tabular-nums text-muted-foreground">
            {rule.hueMin}° – {rule.hueMax}°
          </span>
        </div>
        <div className="h-2 rounded-full" style={{ background: HUE_GRADIENT }} aria-hidden />
        <Slider
          min={0}
          max={360}
          step={1}
          value={[Math.min(rule.hueMin, rule.hueMax), Math.max(rule.hueMin, rule.hueMax)]}
          onValueChange={([a, b]) => onChange({ ...rule, hueMin: a, hueMax: b })}
          aria-label="Hue range"
        />
      </div>
      <NumberField label="Minimum saturation" value={rule.satMin} min={0} max={100} unit="%" onChange={(v) => onChange({ ...rule, satMin: v })} />
      <NumberField label="Minimum brightness" value={rule.valMin} min={0} max={100} unit="%" onChange={(v) => onChange({ ...rule, valMin: v })} />
    </div>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent className="grid gap-5 sm:grid-cols-2">{children}</CardContent>
    </Card>
  );
}

function SamplePreview({ settings }: { settings: VisionSettings }) {
  const { samples } = useBaseline(cameraSourceStore.useValue());
  const [sample, setSample] = useState<HTMLCanvasElement | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const maskRef = useRef<HTMLCanvasElement>(null);
  const ghost = samples.at(-1)?.thumb;

  // Use the latest baseline photo (already a guide square) as the sample until one is chosen.
  useEffect(() => {
    if (sample || !ghost) return;
    let cancelled = false;
    loadImage(ghost)
      .then((img) => !cancelled && setSample(drawScaled(img, img.naturalWidth, img.naturalHeight, SAMPLE_EDGE)))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [ghost, sample]);

  const sampleUrl = useMemo(() => sample?.toDataURL("image/jpeg", 0.85), [sample]);
  const pixels = useMemo(() => (sample ? canvasToRgb(sample) : null), [sample]);
  // Reruns in a worker on every slider move; the sliders never wait for it.
  const preview = usePreviewJob("mask", pixels, settings);

  useEffect(() => {
    if (preview) drawMask(maskRef.current, preview);
  }, [preview]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Live preview</CardTitle>
        <CardDescription>What the values on this page count as leaf (green) and yellow/brown on a sample photo.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {sampleUrl ? (
          <div className="relative overflow-hidden rounded-lg border bg-muted">
            <img src={sampleUrl} alt="Sample photo" className="block w-full" />
            <canvas ref={maskRef} aria-hidden className={preview ? "absolute inset-0 size-full" : "hidden"} />
          </div>
        ) : (
          <div className="flex aspect-square items-center justify-center rounded-lg border border-dashed text-sm text-muted-foreground">No sample photo</div>
        )}
        {preview && (
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm tabular-nums">
            <dt className="text-muted-foreground">Leaf cover</dt>
            <dd className="text-right">{formatPct(preview.estimatedCoverPct)}</dd>
            <dt className="text-muted-foreground">Leaf pixels</dt>
            <dd className="text-right">{formatNumber(preview.leafPixels)}</dd>
            <dt className="text-muted-foreground">Yellow/brown pixels</dt>
            <dd className="text-right">{formatNumber(preview.stressedPixels)}</dd>
          </dl>
        )}
        <Button variant="outline" className="w-full" onClick={() => fileRef.current?.click()}>
          <ImageUp /> Choose sample photo
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            try {
              setSample(await fileToSquare(file, SAMPLE_EDGE));
            } catch {
              toast.error("Could not open that file");
            }
          }}
        />
      </CardContent>
    </Card>
  );
}

export function SettingsEditor() {
  const savedVision = visionSettingsStore.useValue();
  const savedThresholds = thresholdStore.useValue();
  const [visionEdits, setVisionEdits] = useState<VisionSettings | null>(null);
  const [thresholdEdits, setThresholdEdits] = useState<DetectionSettings | null>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const v = visionEdits ?? savedVision;
  const t = thresholdEdits ?? savedThresholds;
  const dirty = visionEdits != null || thresholdEdits != null;

  const setV = <K extends keyof VisionSettings>(key: K, value: VisionSettings[K]) => setVisionEdits({ ...v, [key]: value });
  const setT = (patch: Partial<DetectionSettings>) => setThresholdEdits({ ...t, ...patch });

  function save(nextVision: VisionSettings, nextThresholds: DetectionSettings) {
    const vision = visionSettingsSchema.safeParse(nextVision);
    const thresholds = detectionSettingsSchema.safeParse(nextThresholds);
    if (!vision.success || !thresholds.success) {
      toast.error("Some values are out of range");
      return false;
    }
    if (thresholds.data.mildPct > thresholds.data.wiltingPct) {
      toast.error("The mild threshold must be lower than the wilting threshold");
      return false;
    }
    const ok = visionSettingsStore.write(vision.data) && thresholdStore.write(thresholds.data);
    setVisionEdits(null);
    setThresholdEdits(null);
    if (ok) toast.success("Settings saved in this browser");
    else toast.warning("Applied for this visit only: this browser blocked saving.");
    return true;
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify({ vision: v, thresholds: t }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "plant-pixel-settings.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function importJson(file: File) {
    try {
      const data = JSON.parse(await file.text()) as { vision?: unknown; thresholds?: unknown };
      const vision = visionSettingsSchema.safeParse(data.vision);
      const thresholds = detectionSettingsSchema.safeParse(data.thresholds ?? DEFAULT_DETECTION_SETTINGS);
      if (!vision.success || !thresholds.success) throw new Error("invalid");
      save(vision.data, thresholds.data);
    } catch {
      toast.error("That file is not a valid settings export");
    }
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="order-2 space-y-6 lg:order-1">
        <Section title="Leaf (green)" description="Colours counted as leaf. Adjust if leaves are not green in the preview, or if the background is.">
          <div className="sm:col-span-2">
            <HsvFields rule={v.leaf} onChange={(rule) => setV("leaf", rule)} />
          </div>
        </Section>

        <Section title="Wilting thresholds" description="Leaf cover lost compared with the baseline photos.">
          <NumberField label="Mild wilting from" value={t.mildPct} min={0} max={100} step={0.5} unit="%" onChange={(n) => setT({ mildPct: n })} />
          <NumberField label="Wilting from" value={t.wiltingPct} min={0} max={100} step={0.5} unit="%" onChange={(n) => setT({ wiltingPct: n })} />
        </Section>

        <details className="group rounded-xl border bg-card px-4 py-3">
          <summary className="cursor-pointer text-sm font-medium">
            Advanced settings <span className="font-normal text-muted-foreground">— rarely needed; the defaults come from the plan</span>
          </summary>
          <div className="mt-4 space-y-6">
            <Section title="Yellow/brown (discoloration)" description="Counted only inside the plant region.">
              <div className="sm:col-span-2">
                <HsvFields rule={v.stressed} onChange={(rule) => setV("stressed", rule)} />
              </div>
              <NumberField label="Discoloration note from" value={t.discolorationPct} min={0} max={100} step={0.5} unit="%" onChange={(n) => setT({ discolorationPct: n })} />
            </Section>

            <Section title="White balance" description="Uses the white background to correct colour and exposure.">
              <label className="flex items-center justify-between gap-2 text-sm">
                Enabled
                <Switch checked={v.whiteBalance.enabled} onCheckedChange={(c) => setV("whiteBalance", { ...v.whiteBalance, enabled: c })} />
              </label>
              <label className="flex items-center justify-between gap-2 text-sm">
                Normalize exposure
                <Switch checked={v.whiteBalance.normalizeExposure} onCheckedChange={(c) => setV("whiteBalance", { ...v.whiteBalance, normalizeExposure: c })} />
              </label>
              <NumberField label="Target gray" value={v.whiteBalance.targetGray} min={50} max={255} hint="0–255 level the background is scaled to" onChange={(n) => setV("whiteBalance", { ...v.whiteBalance, targetGray: n })} />
              <NumberField label="Background max saturation" value={v.whiteBalance.maxSaturation} min={0} max={100} unit="%" onChange={(n) => setV("whiteBalance", { ...v.whiteBalance, maxSaturation: n })} />
              <NumberField label="Background min brightness" value={v.whiteBalance.minValue} min={0} max={100} unit="%" onChange={(n) => setV("whiteBalance", { ...v.whiteBalance, minValue: n })} />
            </Section>

            <Section title="Mask cleanup" description="Applied on the server after classification.">
              <NumberField label="Opening (speckle removal)" value={v.cleanup.openSize} min={0} max={15} unit="px" onChange={(n) => setV("cleanup", { ...v.cleanup, openSize: n })} />
              <NumberField label="Closing (fill holes)" value={v.cleanup.closeSize} min={0} max={25} unit="px" onChange={(n) => setV("cleanup", { ...v.cleanup, closeSize: n })} />
              <NumberField label="Yellow/brown mask opening" value={v.cleanup.stressedOpenSize} min={0} max={15} unit="px" onChange={(n) => setV("cleanup", { ...v.cleanup, stressedOpenSize: n })} />
              <NumberField label="Drop blobs smaller than" value={v.cleanup.minBlobPct} min={0} max={2} step={0.01} unit="%" hint="of the square" onChange={(n) => setV("cleanup", { ...v.cleanup, minBlobPct: n })} />
              <NumberField
                label="Keep blobs within"
                value={v.cleanup.mergeDistancePct}
                min={0}
                max={30}
                step={0.5}
                unit="%"
                hint="of the square from the main plant"
                onChange={(n) => setV("cleanup", { ...v.cleanup, mergeDistancePct: n })}
              />
              <div className="grid gap-2">
                <Label className="text-sm font-normal">Plant region</Label>
                <select
                  value={v.plantRegion.mode}
                  onChange={(e) => setV("plantRegion", { ...v.plantRegion, mode: e.target.value as "hull" | "dilate" })}
                  className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-base md:text-sm dark:bg-input/30 pointer-coarse:h-11"
                >
                  <option value="hull">Convex hull of the leaf mask</option>
                  <option value="dilate">Leaf mask grown by a radius</option>
                </select>
              </div>
              {v.plantRegion.mode === "dilate" && (
                <NumberField label="Grow radius" value={v.plantRegion.dilatePx} min={0} max={200} unit="px" onChange={(n) => setV("plantRegion", { ...v.plantRegion, dilatePx: n })} />
              )}
            </Section>

            <Section title="Quality checks" description="A photo failing any check is marked for retake.">
              <NumberField label="Minimum brightness" value={v.quality.minBrightness} min={0} max={100} unit="%" onChange={(n) => setV("quality", { ...v.quality, minBrightness: n })} />
              <NumberField label="Maximum brightness" value={v.quality.maxBrightness} min={0} max={100} unit="%" onChange={(n) => setV("quality", { ...v.quality, maxBrightness: n })} />
              <NumberField label="Minimum sharpness" value={v.quality.minSharpness} min={0} max={100} hint="Edge strength score; crisp photos score 60+" onChange={(n) => setV("quality", { ...v.quality, minSharpness: n })} />
            </Section>

            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={exportJson}>
                <Download /> Export settings
              </Button>
              <Button variant="outline" size="sm" onClick={() => importRef.current?.click()}>
                <Upload /> Import settings
              </Button>
              <input
                ref={importRef}
                type="file"
                accept="application/json,.json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (file) importJson(file);
                }}
              />
            </div>
          </div>
        </details>
      </div>

      <div className="order-1 space-y-4 lg:sticky lg:top-20 lg:order-2 lg:self-start">
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => save(v, t)} disabled={!dirty}>
            <Save /> Save
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setVisionEdits(null);
              setThresholdEdits(null);
            }}
            disabled={!dirty}
          >
            Discard
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              setVisionEdits(DEFAULT_VISION_SETTINGS);
              setThresholdEdits(DEFAULT_DETECTION_SETTINGS);
            }}
          >
            <RotateCcw /> Restore defaults
          </Button>
        </div>
        <SamplePreview settings={v} />
      </div>
    </div>
  );
}

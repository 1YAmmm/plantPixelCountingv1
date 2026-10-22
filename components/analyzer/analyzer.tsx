"use client";

import { Bluetooth, Smartphone } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { cn } from "cn";
import type { AnalyzeError, AnalyzeResponse } from "@/lib/analyze-api";
import { canvasToBlob, dataUrlToBlob } from "@/lib/browser/image";
import { cameraSourceStore, useBaseline, visionSettingsStore, type CameraSource } from "@/lib/browser/store";
import type { NormRect } from "@/lib/vision/types";
import { CameraCapture } from "./camera-capture";
import { Esp32Capture } from "./esp32-capture";
import { PreviewPanel } from "./preview-panel";
import { ResultView } from "./result-view";

// Capture (guide square, phone or ESP32-CAM) → preview (browser, plan §5 steps 3–5) → analyze
// (server, full pipeline) → result.

type Step =
  | { name: "capture" }
  | { name: "preview"; source: CameraSource; photo: HTMLCanvasElement; tiltDeg: number | null }
  | { name: "result"; source: CameraSource; result: AnalyzeResponse; tiltDeg: number | null };

const SOURCES = [
  { value: "phone", label: "Phone camera", icon: Smartphone },
  { value: "esp32", label: "ESP32-CAM", icon: Bluetooth },
] as const;

const TIPS: Record<CameraSource, string[]> = {
  phone: [
    "Same distance every time: pot rim on the circle",
    "Phone flat, straight above the plant",
    "Shade or even indoor light, no flash",
    "Plain white or light-gray backdrop, one plant",
  ],
  esp32: [
    "Fixed mount straight above the plant: pot rim on the circle",
    "Put the plant back in the same spot every time",
    "Even room light; the LED is a last resort",
    "Plain white or light-gray backdrop, one plant",
  ],
};

function SourcePicker({ value, onChange }: { value: CameraSource; onChange: (source: CameraSource) => void }) {
  return (
    <div role="radiogroup" aria-label="Camera" className="flex gap-1 rounded-lg bg-muted p-1 text-sm sm:w-fit">
      {SOURCES.map(({ value: v, label, icon: Icon }) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={cn(
            "flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-muted-foreground sm:flex-none",
            value === v && "bg-background font-medium text-foreground shadow-sm",
          )}
        >
          <Icon className="size-4" /> {label}
        </button>
      ))}
    </div>
  );
}

export function Analyzer() {
  const settings = visionSettingsStore.useValue();
  const source = cameraSourceStore.useValue();
  const { samples } = useBaseline(source);
  const [step, setStep] = useState<Step>({ name: "capture" });
  const [busy, setBusy] = useState(false);
  const ghostUrl = samples.at(-1)?.thumb;

  const analyze = useCallback(
    async (image: Blob, opts: { source: CameraSource; prepared: boolean; roi: NormRect | null; tiltDeg: number | null }) => {
      const form = new FormData();
      form.set("image", image, "photo.jpg");
      form.set("settings", JSON.stringify(settings));
      form.set("prepared", String(opts.prepared));
      if (opts.roi) form.set("roi", JSON.stringify(opts.roi));
      setBusy(true);
      try {
        const res = await fetch("/api/analyze", { method: "POST", body: form });
        const body = (await res.json()) as AnalyzeResponse | AnalyzeError;
        if (!res.ok || "error" in body) throw new Error("error" in body ? body.error : `Analysis failed (${res.status})`);
        setStep({ name: "result", source: opts.source, result: body, tiltDeg: opts.tiltDeg });
        window.scrollTo({ top: 0, behavior: "smooth" });
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Analysis failed");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [settings],
  );

  const onCapture = useCallback((photo: HTMLCanvasElement, tiltDeg: number | null) => setStep({ name: "preview", source, photo, tiltDeg }), [source]);

  return (
    <div className="space-y-5">
      {step.name === "capture" && (
        <>
          <SourcePicker value={source} onChange={(s) => cameraSourceStore.write(s)} />
          {source === "phone" ? (
            <CameraCapture settings={settings} ghostUrl={ghostUrl} onCapture={onCapture} />
          ) : (
            <Esp32Capture settings={settings} ghostUrl={ghostUrl} onCapture={onCapture} />
          )}
          <ul className="grid gap-1 text-sm text-muted-foreground sm:grid-cols-2">
            {TIPS[source].map((tip) => (
              <li key={tip}>• {tip}</li>
            ))}
          </ul>
        </>
      )}

      {step.name === "preview" && (
        <PreviewPanel
          photo={step.photo}
          tiltDeg={step.tiltDeg}
          settings={settings}
          analyzing={busy}
          onRetake={() => setStep({ name: "capture" })}
          onAnalyze={async () => analyze(await canvasToBlob(step.photo), { source: step.source, prepared: false, roi: null, tiltDeg: step.tiltDeg })}
        />
      )}

      {step.name === "result" && (
        <ResultView
          result={step.result}
          source={step.source}
          tiltDeg={step.tiltDeg}
          busy={busy}
          onNew={() => setStep({ name: "capture" })}
          onRecrop={async (roi) =>
            analyze(await dataUrlToBlob(step.result.imageDataUrl), { source: step.source, prepared: true, roi, tiltDeg: step.tiltDeg })
          }
        />
      )}
    </div>
  );
}

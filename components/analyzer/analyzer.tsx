"use client";

import { useCallback, useState } from "react";
import { toast } from "sonner";
import type { AnalyzeError, AnalyzeResponse } from "@/lib/analyze-api";
import { canvasToBlob, dataUrlToBlob } from "@/lib/browser/image";
import { baselineStore, visionSettingsStore } from "@/lib/browser/store";
import type { NormRect } from "@/lib/vision/types";
import { CameraCapture } from "./camera-capture";
import { PreviewPanel } from "./preview-panel";
import { ResultView } from "./result-view";

// Capture (guide square) → preview (browser, plan §5 steps 3–5) → analyze (server, full pipeline) → result.

type Step =
  | { name: "capture" }
  | { name: "preview"; photo: HTMLCanvasElement; tiltDeg: number | null }
  | { name: "result"; result: AnalyzeResponse; tiltDeg: number | null };

export function Analyzer() {
  const settings = visionSettingsStore.useValue();
  const { samples } = baselineStore.useValue();
  const [step, setStep] = useState<Step>({ name: "capture" });
  const [busy, setBusy] = useState(false);
  const ghostUrl = samples.at(-1)?.thumb;

  const analyze = useCallback(
    async (image: Blob, opts: { prepared: boolean; roi: NormRect | null; tiltDeg: number | null }) => {
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
        setStep({ name: "result", result: body, tiltDeg: opts.tiltDeg });
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

  const onCapture = useCallback((photo: HTMLCanvasElement, tiltDeg: number | null) => setStep({ name: "preview", photo, tiltDeg }), []);

  return (
    <div className="space-y-5">
      {step.name === "capture" && (
        <>
          <CameraCapture settings={settings} ghostUrl={ghostUrl} onCapture={onCapture} />
          <ul className="grid gap-1 text-sm text-muted-foreground sm:grid-cols-2">
            <li>• Same distance every time: pot rim on the circle</li>
            <li>• Phone flat, straight above the plant</li>
            <li>• Shade or even indoor light, no flash</li>
            <li>• Plain white or light-gray backdrop, one plant</li>
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
          onAnalyze={async () => analyze(await canvasToBlob(step.photo), { prepared: false, roi: null, tiltDeg: step.tiltDeg })}
        />
      )}

      {step.name === "result" && (
        <ResultView
          result={step.result}
          tiltDeg={step.tiltDeg}
          busy={busy}
          onNew={() => setStep({ name: "capture" })}
          onRecrop={async (roi) => analyze(await dataUrlToBlob(step.result.imageDataUrl), { prepared: true, roi, tiltDeg: step.tiltDeg })}
        />
      )}
    </div>
  );
}

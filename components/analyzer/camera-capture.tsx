"use client";
/* eslint-disable @next/next/no-img-element -- ghost overlay is a local data URL */

import { Camera, CameraOff, Compass, ImageUp, Layers, Loader2, ScanEye } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "cn";
import { ActionBar } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { canvasToRgb, drawMask, fileToSquare, videoToSquare } from "@/lib/browser/image";
import { previewRunner } from "@/lib/browser/preview-worker";
import { guideRect, LEVEL_TOLERANCE_DEG, POT_CIRCLE_FRACTION } from "@/lib/vision/guide";
import type { VisionSettings } from "@/lib/vision/settings";
import { useDeviceLevel, type DeviceLevel } from "./use-device-level";

// Plan §7.2 camera step, with an on-screen square guide instead of a printed marker: the plant is
// framed in the square (pot rim on the circle) and a level shows when the phone is flat. Only the
// square is captured. Native camera / file upload are the fallback (their centre square is used).

export const LIVE_EDGE = 320;
/** The mask is computed in a worker, so it can refresh this often without slowing the video. */
const LIVE_INTERVAL_MS = 200;

type CameraState = "starting" | "live" | "unavailable";

/** The square, pot circle, level bubble, ghost and live mask, positioned over the video (or a still photo). */
export function GuideOverlay({
  aspect,
  level,
  ghostUrl,
  maskRef,
  showMask = false,
}: {
  aspect: number;
  /** Omitted for the ESP32-CAM, which has no tilt sensor. */
  level?: DeviceLevel;
  ghostUrl?: string;
  maskRef?: React.RefObject<HTMLCanvasElement | null>;
  showMask?: boolean;
}) {
  const r = guideRect(aspect, 1);
  const active = level?.status === "active" && level.tiltDeg != null;
  const flat = active && level.tiltDeg! <= LEVEL_TOLERANCE_DEG;
  const pot = `${POT_CIRCLE_FRACTION * 100}%`;

  return (
    <div
      className={cn(
        "pointer-events-none absolute rounded-md border-2 shadow-[0_0_0_9999px_rgba(0,0,0,0.45)] transition-colors",
        flat ? "border-healthy" : "border-white/85",
      )}
      style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.width * 100}%`, height: `${r.height * 100}%` }}
    >
      {ghostUrl && <img src={ghostUrl} alt="" className="absolute inset-0 size-full rounded-sm object-cover opacity-30" />}
      {maskRef && <canvas ref={maskRef} aria-hidden className={cn("absolute inset-0 size-full", !showMask && "hidden")} />}
      <div
        className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-dashed border-white/70"
        style={{ width: pot, height: pot }}
      />
      {active && (
        <>
          <div className="absolute top-1/2 left-1/2 size-9 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white/80" />
          <div
            className={cn("absolute top-1/2 left-1/2 size-4 rounded-full shadow", flat ? "bg-healthy" : "bg-mild")}
            style={{ transform: `translate(calc(-50% + ${level!.x * 60}px), calc(-50% + ${level!.y * 60}px))` }}
          />
        </>
      )}
    </div>
  );
}

export function CameraCapture({
  settings,
  ghostUrl,
  onCapture,
}: {
  settings: VisionSettings;
  ghostUrl?: string;
  /** Square photo, plus the phone tilt at capture time (null without a sensor or for uploads). */
  onCapture: (square: HTMLCanvasElement, tiltDeg: number | null) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const maskRef = useRef<HTMLCanvasElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const nativeRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<CameraState>("starting");
  const [error, setError] = useState<string | null>(null);
  const [aspect, setAspect] = useState(4 / 3);
  const [showMask, setShowMask] = useState(false);
  const [showGhost, setShowGhost] = useState(true);
  const [busy, setBusy] = useState(false);
  const [liveMask] = useState(() => previewRunner("live"));
  const level = useDeviceLevel(state === "live");
  const flat = level.status === "active" && level.tiltDeg != null && level.tiltDeg <= LEVEL_TOLERANCE_DEG;

  // Start the rear camera. getUserMedia needs HTTPS (or localhost).
  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    async function start() {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setState("unavailable");
        setError("Live camera needs HTTPS. Use “Take photo” or “Upload” instead.");
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1440 } },
          audio: false,
        });
        if (cancelled) return stream.getTracks().forEach((t) => t.stop());
        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play();
        setAspect(video.videoWidth / video.videoHeight || 4 / 3);
        setState("live");
      } catch (e) {
        setState("unavailable");
        setError(e instanceof DOMException && e.name === "NotAllowedError" ? "Camera permission was denied." : "No camera available.");
      }
    }
    start();
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Live mask preview of the square, several times per second.
  useEffect(() => {
    if (state !== "live" || !showMask) return;
    const frame = document.createElement("canvas");
    let stopped = false;
    const timer = setInterval(() => {
      const video = videoRef.current;
      if (!video || video.readyState < 2) return;
      liveMask(canvasToRgb(videoToSquare(video, LIVE_EDGE, frame)), settings).then((mask) => mask && !stopped && drawMask(maskRef.current, mask));
    }, LIVE_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [state, settings, showMask, liveMask]);

  const capture = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    onCapture(videoToSquare(video), level.status === "active" ? level.tiltDeg : null);
  }, [onCapture, level.status, level.tiltDeg]);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBusy(true);
    try {
      onCapture(await fileToSquare(file), null);
    } catch {
      setError("Could not open that file. Choose a JPEG, PNG or HEIC photo.");
    } finally {
      setBusy(false);
    }
  }

  const boxAspect = state === "live" ? aspect : 4 / 3;

  return (
    <div className="space-y-3">
      <div
        className="relative mx-auto w-full overflow-hidden rounded-xl border bg-black"
        style={{ aspectRatio: boxAspect, maxWidth: `calc(62svh * ${boxAspect})` }}
      >
        <video ref={videoRef} playsInline muted className={cn("absolute inset-0 size-full object-contain", state !== "live" && "hidden")} />
        {state === "live" && <GuideOverlay aspect={aspect} level={level} ghostUrl={showGhost ? ghostUrl : undefined} maskRef={maskRef} showMask={showMask} />}

        {state === "starting" && (
          <div className="absolute inset-0 flex items-center justify-center text-white/80">
            <Loader2 className="size-6 animate-spin" />
          </div>
        )}
        {state === "unavailable" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-sm text-white/80 sm:p-6">
            <CameraOff className="size-8" />
            {error}
          </div>
        )}
        {state === "live" && level.status === "active" && level.tiltDeg != null && (
          <div
            role="status"
            className={cn(
              "absolute top-3 left-3 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium text-white backdrop-blur",
              flat ? "bg-healthy/90" : "bg-black/60",
            )}
          >
            <span className={cn("size-2 rounded-full", flat ? "bg-white" : "bg-mild")} />
            {flat ? "Level" : `Tilted ${Math.round(level.tiltDeg)}° — hold the phone flat`}
          </div>
        )}
      </div>

      <p className="text-center text-sm text-muted-foreground">
        {state === "live"
          ? "Fit the pot rim to the dashed circle and keep all leaves inside the square. Hold the phone flat, straight above the plant."
          : "Take the photo straight from above with the pot in the centre. Only the centre square of the photo is analyzed."}
      </p>

      {state === "live" && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <label className="flex items-center gap-2">
            <Switch checked={showMask} onCheckedChange={setShowMask} />
            <Layers className="size-4 text-muted-foreground" /> Live mask
          </label>
          {ghostUrl && (
            <label className="flex items-center gap-2">
              <Switch checked={showGhost} onCheckedChange={setShowGhost} />
              <ScanEye className="size-4 text-muted-foreground" /> Baseline ghost
            </label>
          )}
          {level.status === "needs-permission" && (
            <Button variant="outline" size="sm" onClick={level.requestPermission}>
              <Compass /> Enable level
            </Button>
          )}
          {level.status === "unsupported" && <span className="text-xs text-muted-foreground">No tilt sensor: hold the phone flat by eye.</span>}
        </div>
      )}

      <ActionBar>
        {state === "live" ? (
          <Button size="lg" className="col-span-2 sm:min-w-48" onClick={capture}>
            <Camera /> Capture
          </Button>
        ) : (
          <Button size="lg" className="col-span-2 sm:min-w-48" onClick={() => nativeRef.current?.click()} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <Camera />} Take photo
          </Button>
        )}
        <Button size="lg" variant="outline" onClick={() => fileRef.current?.click()} disabled={busy} className="col-span-2 sm:col-span-1">
          <ImageUp /> Upload photo
        </Button>
      </ActionBar>
      <input ref={nativeRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={onFile} />
      <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
    </div>
  );
}

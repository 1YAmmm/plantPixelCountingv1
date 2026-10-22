"use client";

import { Bluetooth, BluetoothOff, BluetoothSearching, Camera, CameraOff, Layers, Lightbulb, Loader2, ScanEye, Unplug, Video } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { esp32Camera, type TransferProgress } from "@/lib/ble/esp32-camera";
import { FRAME_SIZES, type FrameSize } from "@/lib/ble/protocol";
import { canvasToRgb, cropToGuide, drawMask, fileToSquare } from "@/lib/browser/image";
import { previewRunner } from "@/lib/browser/preview-worker";
import type { VisionSettings } from "@/lib/vision/settings";
import { GuideOverlay, LIVE_EDGE } from "./camera-capture";

// Plan §11.3: the ESP32-CAM as the camera, over Bluetooth (Web Bluetooth). The live view is small
// frames sent one after another (several a second) with the guide square, for aiming the fixed
// mount. Capture takes the full-size photo on the board and sends it over (a few seconds); only its
// guide square is analyzed, exactly like phone photos.

/** On-board LED brightness (0–255) when the LED switch is on. Full power is harsh and draws a lot of current. */
const LED_LEVEL = 128;

const FRAME_HINTS: Partial<Record<FrameSize, string>> = {
  VGA: "fastest, may be too soft",
  SXGA: "recommended",
  UXGA: "sharpest, slowest",
};

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong with the ESP32-CAM";
}

function Placeholder({ icon: Icon, spin, children }: { icon: React.ElementType; spin?: boolean; children?: React.ReactNode }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center text-sm text-white/80">
      <Icon className={cn("size-8", spin && "animate-spin")} />
      {children}
    </div>
  );
}

export function Esp32Capture({
  settings,
  ghostUrl,
  onCapture,
}: {
  settings: VisionSettings;
  ghostUrl?: string;
  /** Square photo; the ESP32-CAM has no tilt sensor, so tilt is always null. */
  onCapture: (square: HTMLCanvasElement, tiltDeg: number | null) => void;
}) {
  const cam = useSyncExternalStore(esp32Camera.subscribe, esp32Camera.getSnapshot, esp32Camera.getServerSnapshot);
  const viewRef = useRef<HTMLCanvasElement>(null);
  const maskRef = useRef<HTMLCanvasElement>(null);
  /** Reused for reading each live frame's guide square. */
  const squareRef = useRef<HTMLCanvasElement>(null);
  const [liveMask] = useState(() => previewRunner("live"));
  const [progress, setProgress] = useState<TransferProgress | null>(null);
  const [showMask, setShowMask] = useState(false);
  const [showGhost, setShowGhost] = useState(true);
  const connected = cam.connection === "connected";
  const capturing = progress != null;
  const frame = cam.previewFrame;
  const aspect = frame ? frame.width / frame.height : 4 / 3;
  const cameraFailed = connected && cam.info?.camera === false;

  // Live preview while this view is shown and the camera is connected.
  useEffect(() => {
    if (!connected || cameraFailed) return;
    esp32Camera.startPreview();
    return () => esp32Camera.stopPreview();
  }, [connected, cameraFailed]);

  // Draw each preview frame, and the live mask of its guide square.
  useEffect(() => {
    if (!frame) return;
    let cancelled = false;
    createImageBitmap(frame.blob)
      .then((bitmap) => {
        const view = viewRef.current;
        if (!cancelled && view) {
          if (view.width !== bitmap.width || view.height !== bitmap.height) {
            view.width = bitmap.width;
            view.height = bitmap.height;
          }
          view.getContext("2d")!.drawImage(bitmap, 0, 0);
        }
        if (!cancelled && showMask) {
          squareRef.current ??= document.createElement("canvas");
          const square = canvasToRgb(cropToGuide(bitmap, bitmap.width, bitmap.height, LIVE_EDGE, squareRef.current));
          // Not tied to `cancelled`: the next frame often arrives before the mask is done, and drawing it late is fine.
          liveMask(square, settings).then((mask) => mask && drawMask(maskRef.current, mask));
        }
        bitmap.close();
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [frame, showMask, settings, liveMask]);

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  async function capture() {
    setProgress({ received: 0, total: 0 });
    try {
      const photo = await esp32Camera.capture(setProgress);
      onCapture(await fileToSquare(photo.blob), null);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setProgress(null);
    }
  }

  let hint: string;
  if (!cam.supported) hint = "Use the phone camera, or open this page in a browser with Bluetooth.";
  else if (!connected) hint = "Power the ESP32-CAM, then connect to it. It shows up as “PlantCam-…”.";
  else if (!cam.previewing && cam.previewError) hint = `Live preview stopped: ${cam.previewError} Turn it on again to retry.`;
  else hint = "Fit the pot rim to the dashed circle and keep all leaves inside the square. The live view is low resolution; Capture takes the full-size photo.";

  let badge = "Paused";
  if (cam.previewing) badge = cam.previewFps ? `Live · ${cam.previewFps.toFixed(1)} fps` : "Live";

  return (
    <div className="space-y-3">
      <div
        className="relative mx-auto w-full overflow-hidden rounded-xl border bg-black"
        style={{ aspectRatio: aspect, maxWidth: `calc(62vh * ${aspect})` }}
      >
        {connected && frame && (
          <>
            <canvas ref={viewRef} aria-label="Live view from the ESP32-CAM" className={cn("absolute inset-0 size-full", capturing && "opacity-60")} />
            <GuideOverlay aspect={aspect} ghostUrl={showGhost ? ghostUrl : undefined} maskRef={maskRef} showMask={showMask} />
          </>
        )}

        {!cam.supported && (
          <Placeholder icon={BluetoothOff}>
            This browser cannot use Bluetooth. Open the page in Chrome or Edge (Android, Windows, macOS, ChromeOS) over HTTPS or on localhost. On iPhone,
            use the Bluefy browser.
          </Placeholder>
        )}
        {cam.supported && cam.connection === "disconnected" && (
          <Placeholder icon={Bluetooth}>{cam.deviceName ? `Disconnected from ${cam.deviceName}.` : "ESP32-CAM not connected."}</Placeholder>
        )}
        {cam.connection === "connecting" && (
          <Placeholder icon={Loader2} spin>
            Connecting to {cam.deviceName ?? "the ESP32-CAM"}…
          </Placeholder>
        )}
        {cameraFailed && <Placeholder icon={CameraOff}>The board&apos;s camera did not start. Check the ribbon cable, then restart the ESP32-CAM.</Placeholder>}
        {connected && !cameraFailed && !frame && (
          <Placeholder icon={cam.previewing ? Loader2 : Camera} spin={cam.previewing}>
            {cam.previewing ? "Starting live view…" : "Live preview is off. Press Capture to take a photo."}
          </Placeholder>
        )}

        {connected && (
          <div className="absolute top-3 left-3 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-white backdrop-blur">
            <span className={cn("size-2 rounded-full", cam.previewing ? "bg-healthy" : "bg-white/60")} />
            {cam.deviceName} · {badge}
          </div>
        )}

        {capturing && (
          <div role="status" className="absolute inset-x-0 bottom-0 space-y-1.5 bg-black/70 px-4 py-3 text-xs text-white">
            <div className="flex justify-between tabular-nums">
              <span>{progress.total ? "Receiving photo…" : "Taking photo…"}</span>
              {progress.total > 0 && (
                <span>
                  {Math.round(progress.received / 1024)} / {Math.round(progress.total / 1024)} KB
                </span>
              )}
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/20">
              <div className="h-full rounded-full bg-healthy transition-[width]" style={{ width: `${progress.total ? (100 * progress.received) / progress.total : 0}%` }} />
            </div>
          </div>
        )}
      </div>

      <p className="text-center text-sm text-muted-foreground">{hint}</p>

      {connected && !cameraFailed && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
          <label className="flex items-center gap-2">
            <Switch checked={cam.previewing} onCheckedChange={(on) => (on ? esp32Camera.startPreview() : esp32Camera.stopPreview())} />
            <Video className="size-4 text-muted-foreground" /> Live preview
          </label>
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
          <label className="flex items-center gap-2">
            <Switch checked={(cam.info?.led ?? 0) > 0} disabled={cam.busy} onCheckedChange={(on) => run(() => esp32Camera.setLed(on ? LED_LEVEL : 0))} />
            <Lightbulb className="size-4 text-muted-foreground" /> LED light
          </label>
          <label className="flex items-center gap-2">
            Photo size
            <select
              value={cam.info?.frame ?? ""}
              disabled={cam.busy}
              onChange={(e) => run(() => esp32Camera.setFrame(e.target.value as FrameSize))}
              className="h-9 rounded-lg border border-input bg-transparent px-2.5 text-sm disabled:opacity-50 dark:bg-input/30"
            >
              {cam.info?.frame == null && <option value="">Unknown</option>}
              {FRAME_SIZES.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name} · {f.width}×{f.height}
                  {FRAME_HINTS[f.name] ? ` (${FRAME_HINTS[f.name]})` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {cam.supported && (
        <div className="grid grid-cols-2 gap-2 sm:flex">
          {!connected && (
            <>
              <Button
                size="lg"
                className="col-span-2 sm:min-w-48"
                disabled={cam.connection === "connecting"}
                onClick={() => run(() => (cam.deviceName ? esp32Camera.connect() : esp32Camera.pick()))}
              >
                {cam.connection === "connecting" ? <Loader2 className="animate-spin" /> : <Bluetooth />}
                {cam.deviceName ? `Reconnect ${cam.deviceName}` : "Connect ESP32-CAM"}
              </Button>
              {cam.deviceName && (
                <Button size="lg" variant="outline" className="col-span-2 sm:col-span-1" disabled={cam.connection === "connecting"} onClick={() => run(() => esp32Camera.pick())}>
                  <BluetoothSearching /> Other device
                </Button>
              )}
            </>
          )}
          {connected && (
            <>
              <Button size="lg" className="sm:min-w-48" disabled={cam.busy || cameraFailed} onClick={capture}>
                {capturing ? <Loader2 className="animate-spin" /> : <Camera />} Capture
              </Button>
              <Button size="lg" variant="ghost" disabled={cam.busy} onClick={() => esp32Camera.disconnect()}>
                <Unplug /> Disconnect
              </Button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

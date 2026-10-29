"use client";

import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { esp32Camera } from "@/lib/ble/esp32-camera";
import { guideRect } from "@/lib/vision/guide";
import { cameraError, useCamera } from "./shared";

// The camera's live view while setting it up, with the square it measures, so the plant can be
// framed. The view is a small 4:3 frame of the whole sensor; the reports use a 1280 × 1024 (5:4)
// photo, for which the OV2640 driver reads the sensor without a strip on each side.

/** Share of the preview's width on each side that the report photo does not show: the driver's 5:4 window skips 50 of 1600 px. */
const PHOTO_CROP_X = 50 / 1600;

/** The measured square in the preview frame, normalized. */
const SQUARE = (() => {
  const r = guideRect(1280, 1024);
  const inner = 1 - 2 * PHOTO_CROP_X;
  return { x: PHOTO_CROP_X + r.x * inner, y: r.y, width: r.width * inner, height: r.height };
})();

export function CameraPreview() {
  const cam = useCamera();
  const [frame, setFrame] = useState<{ url: string; width: number; height: number } | null>(null);
  const url = useRef<string | null>(null);

  // Stop the view and free the last frame when the panel goes away.
  useEffect(
    () => () => {
      esp32Camera.stopPreview();
      if (url.current) URL.revokeObjectURL(url.current);
    },
    [],
  );

  async function start() {
    try {
      await esp32Camera.startPreview(({ jpeg, width, height }) => {
        if (url.current) URL.revokeObjectURL(url.current);
        url.current = URL.createObjectURL(jpeg);
        setFrame({ url: url.current, width, height });
      });
    } catch (e) {
      toast.error(cameraError(e));
    }
  }

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-0.5">
          <h3 className="font-medium">Camera view</h3>
          <p className="text-sm text-muted-foreground">Aim the camera so the plant is inside the square: only the square is measured.</p>
        </div>
        {cam.previewing ? (
          <Button variant="outline" size="sm" onClick={() => esp32Camera.stopPreview()}>
            <EyeOff /> Stop
          </Button>
        ) : (
          <Button variant="outline" size="sm" onClick={start} disabled={cam.busy}>
            <Eye /> Show the camera view
          </Button>
        )}
      </div>
      {(cam.previewing || frame) && (
        <div
          className="relative mx-auto w-full max-w-md overflow-hidden rounded-md bg-muted"
          style={{ aspectRatio: frame ? `${frame.width} / ${frame.height}` : "4 / 3" }}
        >
          {frame ? (
            // eslint-disable-next-line @next/next/no-img-element -- a blob URL from the camera, nothing to optimize
            <img src={frame.url} alt="What the camera sees" className="absolute inset-0 size-full object-cover" />
          ) : (
            <div className="flex size-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" /> Getting the view…
            </div>
          )}
          {/* The measured square; the shadow dims everything outside it. */}
          <div
            className="pointer-events-none absolute rounded-sm border-2 border-white shadow-[0_0_0_9999px_rgb(0_0_0/0.4)]"
            style={{ left: `${SQUARE.x * 100}%`, top: `${SQUARE.y * 100}%`, width: `${SQUARE.width * 100}%`, height: `${SQUARE.height * 100}%` }}
          />
        </div>
      )}
      {cam.previewing && <p className="text-xs text-muted-foreground">Live view. The camera does nothing else while it is on; press Stop when the plant is framed.</p>}
    </div>
  );
}

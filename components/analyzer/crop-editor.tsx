"use client";
/* eslint-disable @next/next/no-img-element -- local data URL */

import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { NormRect } from "@/lib/vision/types";

// Plan §5 step 4: an optional crop box to keep other things out of the region of interest.

type Handle = "move" | "nw" | "ne" | "sw" | "se";
const MIN = 0.05;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function CropEditor({
  imageUrl,
  aspect,
  initial,
  busy,
  onApply,
  onCancel,
}: {
  imageUrl: string;
  /** Image width ÷ height, used to keep the editor within the viewport height. */
  aspect: number;
  initial: NormRect | null;
  busy: boolean;
  onApply: (rect: NormRect | null) => void;
  onCancel: () => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<NormRect>(initial ?? { x: 0.05, y: 0.05, width: 0.9, height: 0.9 });
  const drag = useRef<{ handle: Handle; startX: number; startY: number; start: NormRect } | null>(null);

  function onPointerDown(e: React.PointerEvent<HTMLElement>) {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    const handle = (e.currentTarget.dataset.handle ?? "move") as Handle;
    drag.current = { handle, startX: e.clientX, startY: e.clientY, start: rect };
  }

  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    const box = boxRef.current?.getBoundingClientRect();
    if (!d || !box) return;
    const dx = (e.clientX - d.startX) / box.width;
    const dy = (e.clientY - d.startY) / box.height;
    const s = d.start;
    let { x, y, width, height } = s;
    if (d.handle === "move") {
      x = clamp(s.x + dx, 0, 1 - s.width);
      y = clamp(s.y + dy, 0, 1 - s.height);
    } else {
      const right = s.x + s.width;
      const bottom = s.y + s.height;
      if (d.handle.includes("w")) x = clamp(s.x + dx, 0, right - MIN);
      if (d.handle.includes("n")) y = clamp(s.y + dy, 0, bottom - MIN);
      const newRight = d.handle.includes("e") ? clamp(right + dx, x + MIN, 1) : right;
      const newBottom = d.handle.includes("s") ? clamp(bottom + dy, y + MIN, 1) : bottom;
      width = newRight - x;
      height = newBottom - y;
    }
    setRect({ x, y, width, height });
  }

  const pct = (v: number) => `${v * 100}%`;
  const handles: Handle[] = ["nw", "ne", "sw", "se"];

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Drag the box or its corners so only the plant (and the marker card) are inside.</p>
      <div
        ref={boxRef}
        className="relative mx-auto touch-none overflow-hidden rounded-xl border select-none"
        style={{ maxWidth: `calc(70svh * ${aspect})` }}
        onPointerMove={onPointerMove}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        <img src={imageUrl} alt="Photo to crop" className="block w-full" draggable={false} />
        <div
          className="absolute cursor-move border-2 border-white shadow-[0_0_0_9999px_rgba(0,0,0,0.5)]"
          style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.width), height: pct(rect.height) }}
          data-handle="move"
          onPointerDown={onPointerDown}
        >
          {handles.map((h) => (
            <span
              key={h}
              data-handle={h}
              onPointerDown={onPointerDown}
              // The ::after extends the grab area to 48 px for fingers.
              className="absolute size-6 rounded-full border-2 border-white bg-primary after:absolute after:-inset-3"
              style={{
                left: h.includes("w") ? -12 : undefined,
                right: h.includes("e") ? -12 : undefined,
                top: h.includes("n") ? -12 : undefined,
                bottom: h.includes("s") ? -12 : undefined,
                cursor: h === "nw" || h === "se" ? "nwse-resize" : "nesw-resize",
              }}
            />
          ))}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => onApply(rect)} disabled={busy}>
          Apply crop
        </Button>
        <Button variant="outline" onClick={() => onApply(null)} disabled={busy}>
          Use whole image
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

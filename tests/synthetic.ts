import type { RgbImage } from "@/lib/vision/types";

// Synthetic guide-square photos with known answers: a white backdrop and leaf-green / yellow
// shapes whose exact pixel counts are recorded while drawing. Used by the tests and by
// scripts/make-fixtures.ts to produce test-images/synthetic/.

export type Rgb = [number, number, number];

export const COLORS = {
  backdrop: [228, 228, 222] as Rgb,
  leaf: [62, 138, 48] as Rgb,
  leafDark: [38, 96, 34] as Rgb,
  yellow: [214, 184, 46] as Rgb,
  brown: [128, 84, 40] as Rgb,
};

export interface Shape {
  kind: "ellipse" | "rect";
  cx: number;
  cy: number;
  /** Half width / half height (rect) or radii (ellipse). */
  rx: number;
  ry: number;
  angleDeg?: number;
  color: Rgb;
  /** What the pixels of this shape count as in the truth. */
  class: "leaf" | "stressed" | "other";
}

export interface SceneSpec {
  width: number;
  height: number;
  background?: Rgb;
  /** Uniform noise amplitude added to each channel. */
  noise?: number;
  shapes: Shape[];
  /** Per-channel multiplier simulating a lighting colour cast / exposure. */
  cast?: Rgb;
  seed?: number;
}

export interface SceneTruth {
  leafPixels: number;
  stressedPixels: number;
  /** Leaf pixels as percent of the image (the guide square). */
  coverPct: number;
}

function inside(shape: Shape, x: number, y: number): boolean {
  const a = ((shape.angleDeg ?? 0) * Math.PI) / 180;
  const dx = x - shape.cx;
  const dy = y - shape.cy;
  const u = dx * Math.cos(a) + dy * Math.sin(a);
  const v = -dx * Math.sin(a) + dy * Math.cos(a);
  if (shape.kind === "rect") return Math.abs(u) <= shape.rx && Math.abs(v) <= shape.ry;
  return (u * u) / (shape.rx * shape.rx) + (v * v) / (shape.ry * shape.ry) <= 1;
}

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10000) / 10000;
  };
}

export function renderScene(spec: SceneSpec): { image: RgbImage; truth: SceneTruth } {
  const { width, height, shapes } = spec;
  const data = new Uint8Array(width * height * 3);
  const bg = spec.background ?? COLORS.backdrop;
  let leafPixels = 0;
  let stressedPixels = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let color = bg;
      let cls: Shape["class"] = "other";
      for (const s of shapes) {
        if (inside(s, x + 0.5, y + 0.5)) {
          color = s.color;
          cls = s.class;
        }
      }
      if (cls === "leaf") leafPixels++;
      else if (cls === "stressed") stressedPixels++;
      data.set(color, (y * width + x) * 3);
    }
  }

  const rand = rng(spec.seed ?? 42);
  const noise = spec.noise ?? 0;
  const cast = spec.cast ?? [1, 1, 1];
  for (let i = 0; i < data.length; i++) {
    const n = noise ? (rand() * 2 - 1) * noise : 0;
    data[i] = Math.max(0, Math.min(255, Math.round(data[i] * cast[i % 3] + n)));
  }

  return {
    image: { width, height, data, channels: 3 },
    truth: { leafPixels, stressedPixels, coverPct: (leafPixels / (width * height)) * 100 },
  };
}

/**
 * A rosette-like plant seen from above in the guide square: overlapping leaf ellipses around the
 * centre, optionally with yellow leaves. `leafLength` sets the size (smaller = drooped / wilted).
 */
export function rosetteScene(opts: {
  size?: number;
  leaves?: number;
  leafLength?: number;
  yellowLeaves?: number;
  noise?: number;
  cast?: Rgb;
  background?: Rgb;
  extras?: Shape[];
}): SceneSpec {
  const size = opts.size ?? 1000;
  const c = size / 2;
  const n = opts.leaves ?? 7;
  const len = (opts.leafLength ?? 220) * (size / 1000);
  const shapes: Shape[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * 360;
    const r = (a * Math.PI) / 180;
    const yellow = k < (opts.yellowLeaves ?? 0);
    shapes.push({
      kind: "ellipse",
      cx: c + Math.cos(r) * len * 0.55,
      cy: c + Math.sin(r) * len * 0.55,
      rx: len * 0.6,
      ry: len * 0.25,
      angleDeg: a,
      color: yellow ? COLORS.yellow : k % 2 ? COLORS.leaf : COLORS.leafDark,
      class: yellow ? "stressed" : "leaf",
    });
  }
  shapes.push(...(opts.extras ?? []));
  return { width: size, height: size, noise: opts.noise ?? 4, cast: opts.cast, background: opts.background, shapes };
}

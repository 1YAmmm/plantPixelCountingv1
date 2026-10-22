"use client";

import { useSyncExternalStore } from "react";
import { DEFAULT_DETECTION_SETTINGS, parseDetectionSettings, type DetectionSettings } from "../detection/settings";
import { DEFAULT_VISION_SETTINGS, parseVisionSettings, type VisionSettings } from "../vision/settings";

// Settings and baseline samples live in this browser's localStorage (there is no database).
// Every read and write is guarded: storage can be unavailable (private mode, blocked site data).

function createStore<T>(key: string, parse: (raw: unknown) => T, fallback: T) {
  const listeners = new Set<() => void>();
  let cache: { raw: string | null; value: T } | null = null;

  function read(): T {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(key);
    } catch {
      return cache?.value ?? fallback;
    }
    if (cache && cache.raw === raw) return cache.value;
    let value = fallback;
    if (raw) {
      try {
        value = parse(JSON.parse(raw));
      } catch {
        value = fallback;
      }
    }
    cache = { raw, value };
    return value;
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    const onStorage = (e: StorageEvent) => {
      if (e.key === key) listener();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      listeners.delete(listener);
      window.removeEventListener("storage", onStorage);
    };
  }

  function write(value: T | null): boolean {
    let ok = true;
    try {
      if (value == null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      ok = false;
      // Keep the value for this page view even if it could not be persisted.
      cache = { raw: cache?.raw ?? null, value: value ?? fallback };
    }
    listeners.forEach((l) => l());
    return ok;
  }

  function useValue(): T {
    return useSyncExternalStore(subscribe, read, () => fallback);
  }

  return { read, write, subscribe, useValue };
}

export const visionSettingsStore = createStore<VisionSettings>("plant-wilt:vision-settings", parseVisionSettings, DEFAULT_VISION_SETTINGS);

export const thresholdStore = createStore<DetectionSettings>("plant-wilt:thresholds", parseDetectionSettings, DEFAULT_DETECTION_SETTINGS);

export interface BaselineSample {
  /** Leaf cover, % of the guide square. */
  coverPct: number;
  /** ISO timestamp. */
  at: string;
  /** Small square JPEG data URL used as the ghost overlay when framing the next photo. */
  thumb?: string;
}

export interface BaselineState {
  samples: BaselineSample[];
}

/** Plan §6.1: the baseline is the average of 3 healthy calibration photos. */
export const BASELINE_SAMPLES = 3;

/** Samples saved by older versions (without coverPct) are dropped. */
function parseBaseline(raw: unknown): BaselineState {
  const samples = (raw as BaselineState | null)?.samples;
  if (!Array.isArray(samples)) return { samples: [] };
  return {
    samples: samples
      .filter((s) => s && typeof s.coverPct === "number" && Number.isFinite(s.coverPct) && typeof s.at === "string")
      .map((s) => ({ coverPct: s.coverPct, at: s.at, thumb: typeof s.thumb === "string" ? s.thumb : undefined }))
      .slice(-BASELINE_SAMPLES),
  };
}

const EMPTY_BASELINE: BaselineState = { samples: [] };

/** Which camera the Analyze page uses. */
export type CameraSource = "phone" | "esp32";

export const cameraSourceStore = createStore<CameraSource>("plant-wilt:camera-source", (raw) => (raw === "esp32" ? "esp32" : "phone"), "phone");

/** Plan §6: one baseline per source. Phone and ESP32-CAM photos are framed differently, so they are not comparable. */
export const baselineStores = {
  phone: createStore<BaselineState>("plant-wilt:baseline", parseBaseline, EMPTY_BASELINE),
  esp32: createStore<BaselineState>("plant-wilt:baseline:esp32", parseBaseline, EMPTY_BASELINE),
} satisfies Record<CameraSource, unknown>;

export function useBaseline(source: CameraSource): BaselineState {
  const store = baselineStores[source];
  return useSyncExternalStore(store.subscribe, store.read, () => EMPTY_BASELINE);
}

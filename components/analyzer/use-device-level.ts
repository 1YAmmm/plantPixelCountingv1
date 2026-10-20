"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

// Phone tilt from the orientation sensor, for the "hold the phone flat" level indicator.
// Flat (screen up, camera straight down at the plant) is 0°.

export type LevelStatus = "pending" | "unsupported" | "needs-permission" | "active";

export interface DeviceLevel {
  status: LevelStatus;
  /** Angle between the phone and flat, degrees (null until the first reading). */
  tiltDeg: number | null;
  /** Bubble offset in −1…1 (left/right, up/down). */
  x: number;
  y: number;
  /** iOS only: ask for sensor access (must be called from a tap). */
  requestPermission: () => Promise<void>;
}

type OrientationCtor = typeof DeviceOrientationEvent & { requestPermission?: () => Promise<"granted" | "denied"> };
type Capability = "pending" | "none" | "permission" | "available";

function capability(): Capability {
  const ctor = (window as { DeviceOrientationEvent?: OrientationCtor }).DeviceOrientationEvent;
  if (!ctor) return "none";
  return typeof ctor.requestPermission === "function" ? "permission" : "available";
}

const noopSubscribe = () => () => {};
const clamp = (v: number) => Math.max(-1, Math.min(1, v));
const RAD = Math.PI / 180;
/** Sensors fire ~60 times a second; ~12 updates are enough for the indicator. */
const UPDATE_MS = 80;
/** Desktops expose the API but never send readings. */
const NO_SENSOR_AFTER_MS = 1500;

export function useDeviceLevel(enabled: boolean): DeviceLevel {
  const cap = useSyncExternalStore(noopSubscribe, capability, () => "pending" as Capability);
  const [granted, setGranted] = useState(false);
  const [noReadings, setNoReadings] = useState(false);
  const [reading, setReading] = useState<{ tiltDeg: number; x: number; y: number } | null>(null);
  const listening = enabled && (cap === "available" || (cap === "permission" && granted));

  useEffect(() => {
    if (!listening) return;
    let received = false;
    let last = 0;
    const onOrientation = (e: DeviceOrientationEvent) => {
      if (e.beta == null || e.gamma == null) return;
      received = true;
      const now = performance.now();
      if (now - last < UPDATE_MS) return;
      last = now;
      // Angle between the phone's screen normal and vertical.
      const tiltDeg = Math.acos(Math.max(-1, Math.min(1, Math.cos(e.beta * RAD) * Math.cos(e.gamma * RAD)))) / RAD;
      setReading({ tiltDeg, x: clamp(e.gamma / 15), y: clamp(e.beta / 15) });
    };
    window.addEventListener("deviceorientation", onOrientation);
    const timer = setTimeout(() => {
      if (!received) setNoReadings(true);
    }, NO_SENSOR_AFTER_MS);
    return () => {
      window.removeEventListener("deviceorientation", onOrientation);
      clearTimeout(timer);
    };
  }, [listening]);

  const requestPermission = useCallback(async () => {
    try {
      const result = await (DeviceOrientationEvent as OrientationCtor).requestPermission?.();
      if (result === "granted") setGranted(true);
      else setNoReadings(true);
    } catch {
      setNoReadings(true);
    }
  }, []);

  let status: LevelStatus;
  if (cap === "none" || noReadings) status = "unsupported";
  else if (cap === "permission" && !granted) status = "needs-permission";
  else if (reading) status = "active";
  else status = "pending";

  return { status, tiltDeg: reading?.tiltDeg ?? null, x: reading?.x ?? 0, y: reading?.y ?? 0, requestPermission };
}

"use client";

import { useEffect, useState } from "react";
import { PREVIEW_JOBS, type PreviewJob, type PreviewJobResult } from "../vision/preview";
import type { PreviewReply, PreviewRequest } from "../vision/preview.worker";
import type { VisionSettings } from "../vision/settings";
import type { RgbImage } from "../vision/types";

// The browser previews loop over every pixel, which takes tens of milliseconds on a phone: on the
// main thread that freezes the camera view, sliders and buttons. They run in one shared Web Worker
// instead, or on the main thread if the worker cannot start.

let worker: Worker | null | undefined;
let nextId = 0;
/** Callbacks of jobs sent to the worker; null means the worker died and the job must run here. */
const pending = new Map<number, (reply: PreviewReply | null) => void>();

function getWorker(): Worker | null {
  if (worker !== undefined) return worker;
  try {
    worker = new Worker(new URL("../vision/preview.worker.ts", import.meta.url));
  } catch {
    return (worker = null);
  }
  worker.onmessage = (e: MessageEvent<PreviewReply>) => {
    pending.get(e.data.id)?.(e.data);
    pending.delete(e.data.id);
  };
  worker.onerror = () => {
    worker?.terminate();
    worker = null;
    pending.forEach((done) => done(null));
    pending.clear();
  };
  return worker;
}

export function runPreviewJob<J extends PreviewJob>(job: J, image: RgbImage, settings: VisionSettings): Promise<PreviewJobResult<J>> {
  const runHere = () => PREVIEW_JOBS[job](image, settings) as PreviewJobResult<J>;
  const w = typeof Worker === "undefined" ? null : getWorker();
  if (!w) return Promise.resolve().then(runHere);
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, (reply) => {
      if (!reply) resolve(Promise.resolve().then(runHere));
      else if ("error" in reply) reject(new Error(reply.error));
      else resolve(reply.result as PreviewJobResult<J>);
    });
    w.postMessage({ id, job, image, settings } satisfies PreviewRequest);
  });
}

/**
 * Runs `job` one call at a time. A call made while one is running waits, replacing (and resolving
 * to null) any call already waiting, so frames or slider moves never pile up. Failures resolve to null.
 */
export function previewRunner<J extends PreviewJob>(job: J) {
  type Call = { image: RgbImage; settings: VisionSettings; resolve: (result: PreviewJobResult<J> | null) => void };
  let running = false;
  let waiting: Call | null = null;

  function start({ image, settings, resolve }: Call) {
    running = true;
    runPreviewJob(job, image, settings)
      .then(resolve, (error) => {
        console.error(`[preview] ${job} failed`, error);
        resolve(null);
      })
      .finally(() => {
        running = false;
        const next = waiting;
        waiting = null;
        if (next) start(next);
      });
  }

  return (image: RgbImage, settings: VisionSettings) =>
    new Promise<PreviewJobResult<J> | null>((resolve) => {
      if (!running) return start({ image, settings, resolve });
      waiting?.resolve(null);
      waiting = { image, settings, resolve };
    });
}

/** Result of `job` for these inputs, rerun whenever they change; null until the first result for this image. */
export function usePreviewJob<J extends PreviewJob>(job: J, image: RgbImage | null, settings: VisionSettings): PreviewJobResult<J> | null {
  const [run] = useState(() => previewRunner(job));
  const [latest, setLatest] = useState<{ image: RgbImage; result: PreviewJobResult<J> } | null>(null);

  useEffect(() => {
    if (!image) return;
    run(image, settings).then((result) => result && setLatest({ image, result }));
  }, [run, image, settings]);

  return latest?.image === image ? latest.result : null;
}

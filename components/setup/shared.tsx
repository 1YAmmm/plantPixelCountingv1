"use client";

import { Check } from "lucide-react";
import { useSyncExternalStore, type ReactNode } from "react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { esp32Camera } from "@/lib/ble/esp32-camera";

export function useCamera() {
  return useSyncExternalStore(esp32Camera.subscribe, esp32Camera.getSnapshot, esp32Camera.getServerSnapshot);
}

const subscribeNothing = () => () => {};

/** False during the server render and hydration, so browser-only checks do not flash. */
export function useMounted(): boolean {
  return useSyncExternalStore(
    subscribeNothing,
    () => true,
    () => false,
  );
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "Something went wrong";
}

/** The camera's reason ("Camera: wrong password"), as a sentence. */
export function cameraError(e: unknown): string {
  const message = errorMessage(e).replace(/^Camera: /, "");
  if (message === "unknown command") return "The camera's firmware is too old for this. Flash the latest firmware (README → Flash the firmware), then try again.";
  return message.charAt(0).toUpperCase() + message.slice(1);
}

export function ExternalLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="font-medium text-foreground underline underline-offset-3">
      {children}
    </a>
  );
}

export function StepRow({
  n,
  title,
  state,
  summary,
  onChange,
  changeLabel = "Change",
  children,
}: {
  n: number;
  title: string;
  state: "done" | "active" | "locked";
  summary?: ReactNode;
  onChange?: () => void;
  changeLabel?: string;
  children?: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
          state === "done" && "bg-healthy/15 text-healthy",
          state === "active" && "bg-primary text-primary-foreground",
          state === "locked" && "bg-muted text-muted-foreground",
        )}
        aria-hidden
      >
        {state === "done" ? <Check className="size-4" /> : n}
      </span>
      <div className="min-w-0 flex-1 space-y-3 pt-0.5">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h3 className={cn("font-medium", state === "locked" && "text-muted-foreground")}>
            <span className="sr-only">Step {n}: </span>
            {title}
          </h3>
          {state === "done" && onChange && (
            <Button variant="ghost" size="sm" onClick={onChange}>
              {changeLabel}
            </Button>
          )}
        </div>
        {state === "done" && summary && <div className="text-sm text-muted-foreground">{summary}</div>}
        {state === "locked" && <p className="text-sm text-muted-foreground">Finish step {n - 1} first.</p>}
        {state === "active" && children}
      </div>
    </li>
  );
}

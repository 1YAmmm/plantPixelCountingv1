import type { ReactNode } from "react";

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * The main buttons of a step. On phones it sticks to the bottom of the screen, so Capture or Analyze
 * stays in reach while the camera view or photo above takes most of the height.
 */
export function ActionBar({ children }: { children: ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 -mx-4 grid grid-cols-2 gap-2 border-t bg-background/90 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:flex sm:border-0 sm:bg-transparent sm:p-0 sm:backdrop-blur-none">
      {children}
    </div>
  );
}

export function Stat({ label, value, hint, large }: { label: string; value: ReactNode; hint?: ReactNode; large?: boolean }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={large ? "mt-0.5 text-3xl font-semibold" : "mt-0.5 text-lg font-semibold"}>{value}</div>
      {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}

import { CircleAlert, CircleCheck, CircleHelp, Droplets, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { STATUS_LABELS, type Status } from "@/lib/detection/status";

const STYLES: Record<Status, string> = {
  healthy: "bg-healthy/15 text-healthy ring-healthy/30",
  mild: "bg-mild/15 text-mild ring-mild/40",
  wilting: "bg-wilting/15 text-wilting ring-wilting/30",
  unknown: "bg-unknown/15 text-unknown ring-unknown/30",
};

const ICONS: Record<Status, typeof CircleCheck> = {
  healthy: CircleCheck,
  mild: CircleAlert,
  wilting: TriangleAlert,
  unknown: CircleHelp,
};

export function StatusBadge({ status, className, size = "md" }: { status: Status; className?: string; size?: "sm" | "md" | "lg" }) {
  const Icon = ICONS[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full font-medium whitespace-nowrap ring-1 ring-inset",
        size === "sm" && "px-2 py-0.5 text-xs",
        size === "md" && "px-2.5 py-0.5 text-sm",
        size === "lg" && "px-3 py-1 text-base",
        STYLES[status],
        className,
      )}
    >
      <Icon className={size === "lg" ? "size-4.5" : "size-3.5"} aria-hidden />
      {STATUS_LABELS[status]}
    </span>
  );
}

export function DiscolorationNote({ pct, className }: { pct: number; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full bg-stressed/15 px-2 py-0.5 text-xs font-medium text-stressed ring-1 ring-inset ring-stressed/30", className)}>
      <Droplets className="size-3.5" aria-hidden />
      Discoloration {pct.toFixed(0)}%
    </span>
  );
}

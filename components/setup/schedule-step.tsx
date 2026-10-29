"use client";

import { Check, Loader2 } from "lucide-react";
import { useState, type ComponentProps, type FormEvent } from "react";
import { toast } from "sonner";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { esp32Camera } from "@/lib/ble/esp32-camera";
import type { DeviceSchedule } from "@/lib/ble/protocol";
import { ALL_DAYS, DAY_NAMES, describeEvery, describeSchedule, EVERY_HOURS, EVERY_MINUTES, formatUtcOffset, localUtcOffset, WEEK_ORDER } from "@/lib/schedule";
import { cameraError } from "./shared";

type Repeat = "daily" | "days" | "hours" | "minutes";

const REPEAT_LABELS: Record<Repeat, string> = {
  daily: "Every day",
  days: "On certain days",
  hours: "Every few hours",
  minutes: "Every few minutes",
};

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * A native select styled like Input. Its colours are solid, options included: the browser draws
 * the open list on its own (white) popup, where Input's see-through background left the light
 * dark-mode text invisible.
 */
function Select({ className, ...props }: ComponentProps<"select">) {
  return (
    <select
      className={cn(
        "h-8 rounded-lg border border-input bg-background px-2 text-base text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 md:text-sm dark:bg-popover pointer-coarse:h-10",
        "[&_option]:bg-popover [&_option]:text-popover-foreground",
        className,
      )}
      {...props}
    />
  );
}

/** The form's starting values from the saved schedule, or every day at 7:00 AM. */
function initialState(current: DeviceSchedule | null) {
  const every = current?.everyMinutes ?? 0;
  const [hh, mm] = (current && !every ? current.time : "07:00").split(":").map(Number);
  const hoursMatch = every % 60 === 0 && (EVERY_HOURS as readonly number[]).includes(every / 60);
  let repeat: Repeat = "daily";
  if (every) repeat = hoursMatch ? "hours" : "minutes";
  else if (current && current.days.length < 7) repeat = "days";
  return {
    repeat,
    days: current && !every && current.days.length ? current.days : [...ALL_DAYS],
    hour12: hh % 12 || 12,
    minute: mm,
    pm: hh >= 12,
    everyHours: hoursMatch ? every / 60 : 1,
    everyMinutes: !hoursMatch && (EVERY_MINUTES as readonly number[]).includes(every) ? every : 30,
  };
}

export function ScheduleStep({
  current,
  canSave,
  intervals,
  onDone,
  onCancel,
}: {
  current: DeviceSchedule | null;
  canSave: boolean;
  /** The firmware can report every N minutes (INTERVAL_FIRMWARE). */
  intervals: boolean;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [form, setForm] = useState(() => initialState(current));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const utcOffset = localUtcOffset();
  const { repeat, days } = form;
  const atTime = repeat === "daily" || repeat === "days";
  const update = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  function toggleDay(day: number) {
    setForm((f) => ({ ...f, days: f.days.includes(day) ? f.days.filter((x) => x !== day) : [...f.days, day].sort((a, b) => a - b) }));
  }

  function schedule(): DeviceSchedule {
    if (repeat === "minutes" || repeat === "hours") {
      const everyMinutes = repeat === "hours" ? form.everyHours * 60 : form.everyMinutes;
      return { days: [...ALL_DAYS], time: "00:00", utcOffset, everyMinutes };
    }
    const time = `${pad((form.hour12 % 12) + (form.pm ? 12 : 0))}:${pad(form.minute)}`;
    return { days: repeat === "daily" ? [...ALL_DAYS] : days, time, utcOffset };
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = schedule();
      await esp32Camera.setSchedule(s);
      toast.success(`Reports: ${describeSchedule(s)}`);
      onDone();
    } catch (err) {
      setError(cameraError(err));
    } finally {
      setBusy(false);
    }
  }

  const repeats: Repeat[] = intervals ? ["daily", "days", "hours", "minutes"] : ["daily", "days"];
  const noDays = repeat === "days" && days.length === 0;

  return (
    <form onSubmit={save} className="grid gap-4">
      <div className="grid gap-1.5">
        <Label htmlFor="report-repeat">Repeat</Label>
        <Select id="report-repeat" value={repeat} onChange={(e) => update({ repeat: e.target.value as Repeat })} className="w-fit">
          {repeats.map((r) => (
            <option key={r} value={r}>
              {REPEAT_LABELS[r]}
            </option>
          ))}
        </Select>
      </div>

      {repeat === "days" && (
        <div className="grid gap-2">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Days">
            {WEEK_ORDER.map((day) => {
              const on = days.includes(day);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleDay(day)}
                  className={cn(
                    "h-8 min-w-11 rounded-lg border px-2 text-sm transition-colors pointer-coarse:h-10",
                    on ? "border-primary bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted",
                  )}
                >
                  {DAY_NAMES[day]}
                </button>
              );
            })}
          </div>
          {noDays && <p className="text-xs text-destructive">Pick at least one day.</p>}
        </div>
      )}

      {atTime && (
        <div className="grid gap-1.5">
          <Label htmlFor="report-hour">Time</Label>
          <div className="flex items-center gap-1.5">
            <Select id="report-hour" aria-label="Hour" value={form.hour12} onChange={(e) => update({ hour12: Number(e.target.value) })}>
              {Array.from({ length: 12 }, (_, i) => i + 1).map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </Select>
            <span aria-hidden>:</span>
            <Select aria-label="Minute" value={form.minute} onChange={(e) => update({ minute: Number(e.target.value) })}>
              {Array.from({ length: 60 }, (_, m) => (
                <option key={m} value={m}>
                  {pad(m)}
                </option>
              ))}
            </Select>
            <Select aria-label="AM or PM" value={form.pm ? "PM" : "AM"} onChange={(e) => update({ pm: e.target.value === "PM" })}>
              <option value="AM">AM</option>
              <option value="PM">PM</option>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">
            This device&apos;s time ({formatUtcOffset(utcOffset)}). The camera takes the photo at this time, analyzes it and sends the report.
          </p>
        </div>
      )}

      {!atTime && (
        <div className="grid gap-1.5">
          <Label htmlFor="report-every">How often</Label>
          {repeat === "hours" ? (
            <Select id="report-every" value={form.everyHours} onChange={(e) => update({ everyHours: Number(e.target.value) })} className="w-fit">
              {EVERY_HOURS.map((h) => (
                <option key={h} value={h}>
                  {describeEvery(h * 60)}
                </option>
              ))}
            </Select>
          ) : (
            <Select id="report-every" value={form.everyMinutes} onChange={(e) => update({ everyMinutes: Number(e.target.value) })} className="w-fit">
              {EVERY_MINUTES.map((m) => (
                <option key={m} value={m}>
                  {describeEvery(m)}
                </option>
              ))}
            </Select>
          )}
          <p className="text-xs text-muted-foreground">
            Counted from midnight, this device&apos;s time ({formatUtcOffset(utcOffset)}), so the reports come at the same times every day; the first
            one at the next of those times.
            {repeat === "minutes" && form.everyMinutes <= 5 && " A report takes about 20 seconds, and this many fill the chat fast: good for testing."}
          </p>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy || noDays || !canSave}>
          {busy ? <Loader2 className="animate-spin" /> : <Check />} Save
        </Button>
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
        )}
        {!canSave && <p className="w-full text-xs text-destructive">The camera&apos;s firmware cannot save this yet (see above).</p>}
      </div>
    </form>
  );
}

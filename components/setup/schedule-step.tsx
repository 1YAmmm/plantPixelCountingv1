"use client";

import { Check, Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { esp32Camera } from "@/lib/ble/esp32-camera";
import type { DeviceSchedule } from "@/lib/ble/protocol";
import { ALL_DAYS, DAY_NAMES, describeSchedule, formatUtcOffset, localUtcOffset, WEEK_ORDER } from "@/lib/schedule";
import { cameraError } from "./shared";

export function ScheduleStep({
  current,
  canSave,
  onDone,
  onCancel,
}: {
  current: DeviceSchedule | null;
  canSave: boolean;
  onDone: () => void;
  onCancel?: () => void;
}) {
  const [days, setDays] = useState<number[]>(() => current?.days ?? [...ALL_DAYS]);
  const [time, setTime] = useState(() => current?.time ?? "07:00");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const utcOffset = localUtcOffset();
  const everyDay = days.length === 7;

  function toggleDay(day: number) {
    setDays((d) => (d.includes(day) ? d.filter((x) => x !== day) : [...d, day].sort((a, b) => a - b)));
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const schedule: DeviceSchedule = { days, time, utcOffset };
      await esp32Camera.setSchedule(schedule);
      toast.success(`Reports: ${describeSchedule(schedule)}`);
      onDone();
    } catch (err) {
      setError(cameraError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} className="grid gap-4">
      <div className="grid gap-2">
        <label className="flex w-fit items-center gap-2 text-sm font-medium">
          <Switch checked={everyDay} onCheckedChange={(on) => setDays(on ? [...ALL_DAYS] : [])} />
          Every day
        </label>
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
        {days.length === 0 && <p className="text-xs text-destructive">Pick at least one day.</p>}
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="report-time">Time</Label>
        <Input id="report-time" type="time" value={time} onChange={(e) => e.target.value && setTime(e.target.value)} required className="w-32 pointer-coarse:h-10" />
        <p className="text-xs text-muted-foreground">
          This device&apos;s time ({formatUtcOffset(utcOffset)}). The camera takes the photo at this time, analyzes it and sends the report.
        </p>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={busy || days.length === 0 || !canSave}>
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

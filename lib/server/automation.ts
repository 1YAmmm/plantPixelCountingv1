import type { AutomationConfig, AutomationState, DeviceRecord, ReportSummary } from "../automation/config";
import { dueSlot, LATE_LIMIT_MS, nextRunAt, slotTime } from "../automation/schedule";
import { deviceKey } from "./auth";
import { emailConfigured } from "./email";
import type { Kv } from "./kv";

// Server state of the daily report (newplan.md steps 1 and 5), shared by the route handlers.

export const KEYS = {
  config: "automation:config",
  device: "automation:device",
  lastReport: "automation:last-report",
  report: (slotId: string) => `automation:report:${slotId}`,
};

export const REPORT_TTL_SEC = 30 * 24 * 60 * 60;
/** How often the camera asks for work. */
export const POLL_SECONDS = 60;
/** A test photo not picked up within this time is dropped, so it never fires hours later. */
export const MANUAL_LIMIT_MS = 10 * 60 * 1000;
/** Upload retries can arrive a little after the late limit. */
const UPLOAD_MARGIN_MS = 10 * 60 * 1000;

const SLOT_PATTERN = /^(sched-\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z|manual-\d{1,15})$/;

export function isSlotId(value: string): boolean {
  return SLOT_PATTERN.test(value);
}

export function manualSlotId(now: number): string {
  return `manual-${now}`;
}

/** Request time of a "manual-<ms>" slot, or null. */
export function manualTime(slotId: string): number | null {
  const m = /^manual-(\d{1,15})$/.exec(slotId);
  return m ? Number(m[1]) : null;
}

export async function readConfig(kv: Kv): Promise<AutomationConfig> {
  return (await kv.get<AutomationConfig>(KEYS.config)) ?? {};
}

function scheduleSince(config: AutomationConfig): number {
  const since = config.scheduleSince ? Date.parse(config.scheduleSince) : NaN;
  return Number.isFinite(since) ? since : 0;
}

/** A test photo still waiting for the camera, or null. */
function pendingManual(config: AutomationConfig, now: number): string | null {
  const t = config.captureNow ? manualTime(config.captureNow) : null;
  return t != null && now - t <= MANUAL_LIMIT_MS ? config.captureNow! : null;
}

/** The slot the camera should photograph on this poll, or null. */
export async function pendingSlot(kv: Kv, config: AutomationConfig, now: number): Promise<string | null> {
  const manual = pendingManual(config, now);
  if (manual && !(await kv.get(KEYS.report(manual)))) return manual;
  if (!config.schedule || !config.recipients?.length) return null;
  const slot = dueSlot(config.schedule, now, scheduleSince(config));
  if (!slot) return null;
  return (await kv.get(KEYS.report(slot.id))) ? null : slot.id;
}

/** Whether a photo uploaded for `slotId` was asked for: the pending test photo, or a set time within the late limit. */
export function acceptsSlot(config: AutomationConfig, slotId: string, now: number): boolean {
  const manual = manualTime(slotId);
  if (manual != null) return slotId === config.captureNow && now - manual <= MANUAL_LIMIT_MS + UPLOAD_MARGIN_MS;
  const at = slotTime(slotId);
  if (at == null || !config.schedule) return false;
  return at <= now + 2 * 60 * 1000 && now - at <= LATE_LIMIT_MS + UPLOAD_MARGIN_MS;
}

export async function readState(kv: Kv, now: number): Promise<AutomationState> {
  const [config, device, lastId] = await Promise.all([readConfig(kv), kv.get<DeviceRecord>(KEYS.device), kv.get<string>(KEYS.lastReport)]);
  const lastReport = lastId ? await kv.get<ReportSummary>(KEYS.report(lastId)) : null;
  const next = config.schedule ? nextRunAt(config.schedule, now) : null;
  return {
    schedule: config.schedule ?? null,
    recipients: config.recipients ?? [],
    analysis: config.analysis ?? null,
    nextRunAt: next != null ? new Date(next).toISOString() : null,
    device,
    lastReport,
    captureNow: pendingManual(config, now),
    deviceKey: deviceKey(),
    emailConfigured: emailConfigured(),
    serverTime: new Date(now).toISOString(),
  };
}

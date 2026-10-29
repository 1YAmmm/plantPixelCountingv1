// The BLE setup protocol of the PlantCam firmware (firmware/esp32-cam/esp32-cam.ino). The web app
// only sets the camera up; the camera takes the photo, analyzes it and sends the report to
// Telegram by itself. One custom GATT service; the web app uses three of its characteristics:
//   Control (write)  text commands, one at a time:
//                      "info"
//                      "wifi-ssid:<name>", "wifi-pass:<password>", "wifi:connect", "wifi:forget"
//                      "tg-token:<bot token>", "tg-chat:<chat id>", "tg-label:<who gets the reports>"
//                      "schedule:<days>,<HH:MM>,<UTC offset in minutes>"   days: bit 0 = Sunday … bit 6 = Saturday, 0 = off
//                      "report"   take a photo, analyze it and send it to Telegram now
//   Status  (notify) "ready" | "connecting" | "capturing" | "analyzing" | "sending" | "error:<message>"
//   Info    (read)   JSON: firmware version, WiFi, Telegram and schedule (see parseInfo)
// No DOM or Next.js dependencies, so it is tested directly.

export const SERVICE_UUID = "7a1e0000-5c3b-4d2a-8f1e-3b9c6d4a2e10";
export const CONTROL_UUID = "7a1e0001-5c3b-4d2a-8f1e-3b9c6d4a2e10";
export const STATUS_UUID = "7a1e0002-5c3b-4d2a-8f1e-3b9c6d4a2e10";
export const INFO_UUID = "7a1e0004-5c3b-4d2a-8f1e-3b9c6d4a2e10";

/** The firmware advertises as PlantCam-XXXX (last bytes of its Bluetooth address). */
export const DEVICE_NAME_PREFIX = "PlantCam";

/** First firmware that sends Telegram reports by itself (older ones only join WiFi). */
export const TELEGRAM_FIRMWARE = 3;

/** Longest command the firmware accepts (its Command.text buffer, minus the terminator). */
export const MAX_COMMAND_LENGTH = 199;

/** Longest "tg-label" value, bytes: room for a chat title and the bot's username. */
export const MAX_LABEL_BYTES = 120;

export interface DeviceSchedule {
  /** 0 = Sunday … 6 = Saturday, sorted. Empty = no reports. */
  days: number[];
  /** "HH:MM", the camera's local time. */
  time: string;
  /** Minutes east of UTC (Manila: 480). */
  utcOffset: number;
}

const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function daysMask(days: readonly number[]): number {
  return days.reduce((mask, d) => mask | (1 << d), 0);
}

export const command = {
  info: "info",
  wifiSsid: (ssid: string) => `wifi-ssid:${ssid}`,
  wifiPass: (password: string) => `wifi-pass:${password}`,
  /** Join the saved WiFi; answers "connecting", then "ready" or "error:<reason>". */
  wifiConnect: "wifi:connect",
  wifiForget: "wifi:forget",
  telegramToken: (token: string) => `tg-token:${token}`,
  telegramChat: (chatId: number | string) => `tg-chat:${chatId}`,
  telegramLabel: (label: string) => `tg-label:${label}`,
  schedule: ({ days, time, utcOffset }: DeviceSchedule) => `schedule:${daysMask(days)},${time},${Math.round(utcOffset)}`,
  /** Photo, analysis and Telegram report now; answers "capturing", "analyzing", "sending", then "ready". */
  report: "report",
};

/** "127,07:00,480" (the Info "schedule" value) → schedule; null when off or unreadable. */
export function parseSchedule(text: string): DeviceSchedule | null {
  const [mask = "", time = "", offset = ""] = text.split(",");
  if (!/^\d+$/.test(mask) || !TIME_PATTERN.test(time) || !/^-?\d+$/.test(offset)) return null;
  const bits = Number(mask);
  const utcOffset = Number(offset);
  if (bits <= 0 || bits > 127) return null;
  const days = [0, 1, 2, 3, 4, 5, 6].filter((d) => bits & (1 << d));
  return { days, time, utcOffset };
}

/** Cut `text` to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateBytes(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) return text;
  let out = "";
  for (const ch of text) {
    if (encoder.encode(out + ch + "…").length > maxBytes) break;
    out += ch;
  }
  return `${out}…`;
}

export function firmwareMajor(version: string): number {
  const n = Number.parseInt(version, 10);
  return Number.isFinite(n) ? n : 0;
}

export type DeviceStatus = { state: "ready" | "connecting" | "capturing" | "analyzing" | "sending" } | { state: "error"; message: string };

const STATES = ["ready", "connecting", "capturing", "analyzing", "sending"] as const;

export function parseStatus(text: string): DeviceStatus {
  const state = STATES.find((s) => s === text);
  if (state) return { state };
  if (text.startsWith("error:")) return { state: "error", message: text.slice(6) || "unknown error" };
  return { state: "error", message: `unexpected status "${text}"` };
}

export interface DeviceInfo {
  firmware: string;
  model: string;
  /** False when the camera did not start (usually the ribbon cable). */
  camera: boolean;
  /** Joined to WiFi now. */
  wifi: boolean;
  /** The saved WiFi name, null if none. */
  ssid: string | null;
  ip: string | null;
  /** WiFi signal, dBm. */
  rssi: number | null;
  /** A bot token and a chat are saved (firmware 3+). */
  telegram: boolean;
  /** Who gets the reports, as saved with "tg-label". */
  telegramLabel: string | null;
  schedule: DeviceSchedule | null;
  /** The camera has the time from the internet, so the schedule can run. */
  clock: boolean;
}

export function parseInfo(text: string): DeviceInfo {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") raw = parsed as Record<string, unknown>;
  } catch {
    // Keep the defaults: an unreadable Info value should not block the setup.
  }
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    firmware: str(raw.fw) ?? "unknown",
    model: str(raw.model) ?? "ESP32-CAM",
    camera: raw.camera !== false,
    wifi: raw.wifi === true,
    ssid: str(raw.ssid),
    ip: str(raw.ip),
    rssi: typeof raw.rssi === "number" ? raw.rssi : null,
    telegram: raw.telegram === true,
    telegramLabel: str(raw.tgLabel),
    schedule: typeof raw.schedule === "string" ? parseSchedule(raw.schedule) : null,
    clock: raw.clock === true,
  };
}

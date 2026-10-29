// The BLE setup protocol of the PlantCam firmware (firmware/esp32-cam/esp32-cam.ino). The web app
// only sets the camera up; the camera takes the photo, analyzes it and sends the report to
// Telegram by itself. One custom GATT service; the web app uses three of its characteristics:
//   Control (write)  text commands, one at a time:
//                      "info"
//                      "wifi-ssid:<name>", "wifi-pass:<password>", "wifi:connect", "wifi:forget"
//                      "tg-token:<bot token>", "tg-chat:<chat id>", "tg-label:<who gets the reports>"
//                      "schedule:<days>,<HH:MM>,<UTC offset in minutes>"   days: bit 0 = Sunday … bit 6 = Saturday, 0 = off
//                      "schedule:every:<minutes>,<UTC offset in minutes>"   round the clock (firmware 3.3)
//                      "report"   take the photos, analyze them and send the result to Telegram now
//                      "preview"  one small frame of the camera's view on Data (firmware 3.5)
//   Status  (notify) "ready" | "connecting" | "capturing" | "analyzing" | "sending" | "error:<message>"
//   Data    (notify) the preview frame as START, CHUNK × n, END packets (see parsePacket)
//   Info    (read)   JSON: firmware version, WiFi, Telegram and schedule (see parseInfo)
// No DOM or Next.js dependencies, so it is tested directly.

export const SERVICE_UUID = "7a1e0000-5c3b-4d2a-8f1e-3b9c6d4a2e10";
export const CONTROL_UUID = "7a1e0001-5c3b-4d2a-8f1e-3b9c6d4a2e10";
export const STATUS_UUID = "7a1e0002-5c3b-4d2a-8f1e-3b9c6d4a2e10";
export const DATA_UUID = "7a1e0003-5c3b-4d2a-8f1e-3b9c6d4a2e10";
export const INFO_UUID = "7a1e0004-5c3b-4d2a-8f1e-3b9c6d4a2e10";

export const PACKET_START = 0x01;
export const PACKET_CHUNK = 0x02;
export const PACKET_END = 0x03;

/** The firmware advertises as PlantCam-XXXX (last bytes of its Bluetooth address). */
export const DEVICE_NAME_PREFIX = "PlantCam";

/** First firmware that sends Telegram reports by itself (older ones only join WiFi). */
export const TELEGRAM_FIRMWARE = 3;

/** First firmware with "every N minutes" schedules. */
export const INTERVAL_FIRMWARE = "3.3";

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
  /** Instead of `time` on `days`: every this many minutes round the clock, from midnight. */
  everyMinutes?: number;
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
  schedule: ({ days, time, utcOffset, everyMinutes }: DeviceSchedule) =>
    everyMinutes ? `schedule:every:${everyMinutes},${Math.round(utcOffset)}` : `schedule:${daysMask(days)},${time},${Math.round(utcOffset)}`,
  /** Photos, analysis and Telegram report now; answers "capturing" and "analyzing" (per photo), "sending", then "ready". */
  report: "report",
  /** One preview frame on Data; no status unless it fails. */
  preview: "preview",
};

export interface StartPacket {
  type: "start";
  /** JPEG size, bytes. */
  size: number;
  chunkCount: number;
  crc: number;
  width: number;
  height: number;
  frameId: number;
}

export interface ChunkPacket {
  type: "chunk";
  seq: number;
  payload: Uint8Array;
}

export interface EndPacket {
  type: "end";
  chunkCount: number;
  frameId: number;
}

export type DataPacket = StartPacket | ChunkPacket | EndPacket;

/** Parse one Data notification (little-endian). Returns null for a packet this version does not know. */
export function parsePacket(view: DataView): DataPacket | null {
  if (view.byteLength < 1) return null;
  const type = view.getUint8(0);
  if (type === PACKET_START && view.byteLength >= 19) {
    return {
      type: "start",
      size: view.getUint32(1, true),
      chunkCount: view.getUint16(5, true),
      crc: view.getUint32(7, true),
      // bytes 11–12: the chunk size, not needed to put the frame together
      width: view.getUint16(13, true),
      height: view.getUint16(15, true),
      frameId: view.getUint16(17, true),
    };
  }
  if (type === PACKET_CHUNK && view.byteLength >= 3) {
    // Copy: the browser may reuse the notification's buffer.
    const payload = new Uint8Array(view.buffer, view.byteOffset + 3, view.byteLength - 3).slice();
    return { type: "chunk", seq: view.getUint16(1, true), payload };
  }
  if (type === PACKET_END && view.byteLength >= 5) {
    return { type: "end", chunkCount: view.getUint16(1, true), frameId: view.getUint16(3, true) };
  }
  return null;
}

/** Collects the chunks of one preview frame and rebuilds the JPEG. */
export class FrameAssembler {
  private readonly chunks: (Uint8Array | undefined)[];
  private received = 0;

  constructor(readonly start: StartPacket) {
    this.chunks = new Array(start.chunkCount);
  }

  add(chunk: ChunkPacket): void {
    if (chunk.seq >= this.chunks.length || this.chunks[chunk.seq]) return;
    this.chunks[chunk.seq] = chunk.payload;
    this.received++;
  }

  get complete(): boolean {
    return this.received === this.chunks.length;
  }

  /** The JPEG, or null if a chunk is missing or the size or CRC-32 does not match. */
  assemble(): Uint8Array<ArrayBuffer> | null {
    if (!this.complete) return null;
    const out = new Uint8Array(this.start.size);
    let offset = 0;
    for (const chunk of this.chunks as Uint8Array[]) {
      if (offset + chunk.length > out.length) return null;
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return offset === out.length && crc32(out) === this.start.crc ? out : null;
  }
}

let crcTable: Uint32Array | null = null;

/** CRC-32 (IEEE 802.3, the zlib one), as computed by the firmware. */
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** "127,07:00,480" or "every:30,480" (the Info "schedule" value) → schedule; null when off or unreadable. */
export function parseSchedule(text: string): DeviceSchedule | null {
  const every = /^every:(\d+),(-?\d+)$/.exec(text);
  if (every) {
    const everyMinutes = Number(every[1]);
    if (everyMinutes < 1 || everyMinutes > 1440) return null;
    return { days: [0, 1, 2, 3, 4, 5, 6], time: "00:00", utcOffset: Number(every[2]), everyMinutes };
  }
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

/** "3.3.0" is at least "3.3"; "unknown" is at least nothing. */
export function firmwareAtLeast(version: string, minimum: string): boolean {
  const parts = (v: string) => v.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const have = parts(version);
  const want = parts(minimum);
  for (let i = 0; i < want.length; i++) {
    if ((have[i] ?? 0) !== want[i]) return (have[i] ?? 0) > want[i];
  }
  return true;
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

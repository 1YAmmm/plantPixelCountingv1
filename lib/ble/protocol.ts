// Plan §11.3: the BLE wire format of the ESP32-CAM firmware (firmware/esp32-cam/esp32-cam.ino).
// One custom GATT service with four characteristics:
//   Control (write)  text commands: "capture", "preview", "frame:<size>", "led:<0–255>", "resend:<from>:<count>", "info"
//   Status  (notify) "ready" | "capturing" | "sending" | "error:<message>"
//   Data    (notify) the photo as START, CHUNK × n, END packets (little-endian)
//   Info    (read)   JSON: firmware version, frame size, LED level, …
// Lost chunks are requested again with "resend"; the whole JPEG is checked with CRC-32.
// "preview" sends a small QVGA frame the same way, without status updates, for the live view.
// No DOM or Next.js dependencies, so it is tested directly.

export const SERVICE_UUID = "7a1e0000-5c3b-4d2a-8f1e-3b9c6d4a2e10";
export const CONTROL_UUID = "7a1e0001-5c3b-4d2a-8f1e-3b9c6d4a2e10";
export const STATUS_UUID = "7a1e0002-5c3b-4d2a-8f1e-3b9c6d4a2e10";
export const DATA_UUID = "7a1e0003-5c3b-4d2a-8f1e-3b9c6d4a2e10";
export const INFO_UUID = "7a1e0004-5c3b-4d2a-8f1e-3b9c6d4a2e10";

/** The firmware advertises as PlantCam-XXXX (last bytes of its Bluetooth address). */
export const DEVICE_NAME_PREFIX = "PlantCam";

export const PACKET_START = 0x01;
export const PACKET_CHUNK = 0x02;
export const PACKET_END = 0x03;

/** OV2640 frame sizes the firmware accepts (QVGA is too small for the 1000 px square). */
export const FRAME_SIZES = [
  { name: "VGA", width: 640, height: 480 },
  { name: "SVGA", width: 800, height: 600 },
  { name: "XGA", width: 1024, height: 768 },
  { name: "SXGA", width: 1280, height: 1024 },
  { name: "UXGA", width: 1600, height: 1200 },
] as const;

export type FrameSize = (typeof FRAME_SIZES)[number]["name"];

export const command = {
  capture: "capture",
  preview: "preview",
  info: "info",
  frame: (size: FrameSize) => `frame:${size}`,
  led: (level: number) => `led:${Math.round(Math.max(0, Math.min(255, level)))}`,
  resend: (from: number, count: number) => `resend:${from}:${count}`,
};

export interface StartPacket {
  type: "start";
  /** JPEG size, bytes. */
  size: number;
  chunkCount: number;
  crc: number;
  chunkSize: number;
  width: number;
  height: number;
  captureId: number;
}

export interface ChunkPacket {
  type: "chunk";
  seq: number;
  payload: Uint8Array;
}

export interface EndPacket {
  type: "end";
  chunkCount: number;
  captureId: number;
}

export type DataPacket = StartPacket | ChunkPacket | EndPacket;

/** Parse one Data notification. Returns null for a packet this version does not know. */
export function parsePacket(view: DataView): DataPacket | null {
  if (view.byteLength < 1) return null;
  const type = view.getUint8(0);
  if (type === PACKET_START && view.byteLength >= 19) {
    return {
      type: "start",
      size: view.getUint32(1, true),
      chunkCount: view.getUint16(5, true),
      crc: view.getUint32(7, true),
      chunkSize: view.getUint16(11, true),
      width: view.getUint16(13, true),
      height: view.getUint16(15, true),
      captureId: view.getUint16(17, true),
    };
  }
  if (type === PACKET_CHUNK && view.byteLength >= 3) {
    // Copy: the browser may reuse the notification's buffer.
    const payload = new Uint8Array(view.buffer, view.byteOffset + 3, view.byteLength - 3).slice();
    return { type: "chunk", seq: view.getUint16(1, true), payload };
  }
  if (type === PACKET_END && view.byteLength >= 5) {
    return { type: "end", chunkCount: view.getUint16(1, true), captureId: view.getUint16(3, true) };
  }
  return null;
}

export class ChecksumError extends Error {
  constructor() {
    super("The photo arrived damaged (checksum mismatch)");
    this.name = "ChecksumError";
  }
}

/** Collects the chunks of one photo, in any order, and rebuilds the JPEG. */
export class PhotoAssembler {
  private readonly chunks: (Uint8Array | undefined)[];
  private receivedChunks = 0;
  private receivedBytes = 0;

  constructor(readonly start: StartPacket) {
    this.chunks = new Array(start.chunkCount);
  }

  add(chunk: ChunkPacket): void {
    if (chunk.seq >= this.chunks.length || this.chunks[chunk.seq]) return;
    this.chunks[chunk.seq] = chunk.payload;
    this.receivedChunks++;
    this.receivedBytes += chunk.payload.length;
  }

  get bytes(): number {
    return this.receivedBytes;
  }

  get complete(): boolean {
    return this.receivedChunks === this.chunks.length;
  }

  /** Runs of missing chunks as [from, count], for "resend" commands. */
  missingRanges(): Array<[number, number]> {
    const ranges: Array<[number, number]> = [];
    for (let i = 0; i < this.chunks.length; i++) {
      if (this.chunks[i]) continue;
      const from = i;
      while (i + 1 < this.chunks.length && !this.chunks[i + 1]) i++;
      ranges.push([from, i - from + 1]);
    }
    return ranges;
  }

  /** The JPEG bytes. Throws ChecksumError if the size or the CRC-32 does not match. */
  assemble(): Uint8Array<ArrayBuffer> {
    if (!this.complete) throw new Error("The photo is incomplete");
    const out = new Uint8Array(this.start.size);
    let offset = 0;
    for (const chunk of this.chunks as Uint8Array[]) {
      if (offset + chunk.length > out.length) throw new ChecksumError();
      out.set(chunk, offset);
      offset += chunk.length;
    }
    if (offset !== out.length || crc32(out) !== this.start.crc) throw new ChecksumError();
    return out;
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

export type DeviceStatus = { state: "ready" | "capturing" | "sending" } | { state: "error"; message: string };

export function parseStatus(text: string): DeviceStatus {
  if (text === "ready" || text === "capturing" || text === "sending") return { state: text };
  if (text.startsWith("error:")) return { state: "error", message: text.slice(6) || "unknown error" };
  return { state: "error", message: `unexpected status "${text}"` };
}

export interface DeviceInfo {
  firmware: string;
  model: string;
  /** False when the camera did not start (usually the ribbon cable). */
  camera: boolean;
  frame: FrameSize | null;
  /** On-board LED brightness during capture, 0 = off. */
  led: number;
  psram: boolean;
}

export function parseInfo(text: string): DeviceInfo {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object") raw = parsed as Record<string, unknown>;
  } catch {
    // Keep the defaults: an unreadable Info value should not block capturing.
  }
  const frame = FRAME_SIZES.find((f) => f.name === raw.frame)?.name ?? null;
  return {
    firmware: typeof raw.fw === "string" ? raw.fw : "unknown",
    model: typeof raw.model === "string" ? raw.model : "ESP32-CAM",
    camera: raw.camera !== false,
    frame,
    led: typeof raw.led === "number" ? raw.led : 0,
    psram: raw.psram === true,
  };
}

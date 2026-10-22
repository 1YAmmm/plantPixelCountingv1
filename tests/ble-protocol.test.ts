import { readFileSync } from "node:fs";
import path from "node:path";
import { crc32 as zlibCrc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  ChecksumError,
  command,
  CONTROL_UUID,
  crc32,
  DATA_UUID,
  INFO_UUID,
  PACKET_CHUNK,
  PACKET_END,
  PACKET_START,
  parseInfo,
  parsePacket,
  parseStatus,
  PhotoAssembler,
  SERVICE_UUID,
  STATUS_UUID,
  type ChunkPacket,
  type StartPacket,
} from "@/lib/ble/protocol";

// Packets built byte for byte the way firmware/esp32-cam/esp32-cam.ino sends them.

function startBytes(s: Omit<StartPacket, "type">): DataView {
  const v = new DataView(new ArrayBuffer(19));
  v.setUint8(0, PACKET_START);
  v.setUint32(1, s.size, true);
  v.setUint16(5, s.chunkCount, true);
  v.setUint32(7, s.crc, true);
  v.setUint16(11, s.chunkSize, true);
  v.setUint16(13, s.width, true);
  v.setUint16(15, s.height, true);
  v.setUint16(17, s.captureId, true);
  return v;
}

function chunkBytes(seq: number, payload: Uint8Array): DataView {
  const bytes = new Uint8Array(3 + payload.length);
  bytes[0] = PACKET_CHUNK;
  new DataView(bytes.buffer).setUint16(1, seq, true);
  bytes.set(payload, 3);
  return new DataView(bytes.buffer);
}

function endBytes(chunkCount: number, captureId: number): DataView {
  const v = new DataView(new ArrayBuffer(5));
  v.setUint8(0, PACKET_END);
  v.setUint16(1, chunkCount, true);
  v.setUint16(3, captureId, true);
  return v;
}

/** What the firmware sends for one photo: START, then the chunks. */
function sendPhoto(jpeg: Uint8Array, chunkSize: number) {
  const chunkCount = Math.ceil(jpeg.length / chunkSize);
  const start = parsePacket(startBytes({ size: jpeg.length, chunkCount, crc: crc32(jpeg), chunkSize, width: 1280, height: 1024, captureId: 7 })) as StartPacket;
  const chunks = Array.from({ length: chunkCount }, (_, seq) => parsePacket(chunkBytes(seq, jpeg.subarray(seq * chunkSize, (seq + 1) * chunkSize))) as ChunkPacket);
  return { start, chunks };
}

const fixture = new Uint8Array(readFileSync(path.join(import.meta.dirname, "../test-images/synthetic/rosette-healthy.jpg")));

describe("crc32", () => {
  it("matches the standard check value and zlib", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
    expect(crc32(fixture)).toBe(zlibCrc32(fixture));
  });
});

describe("packets", () => {
  it("parses START, CHUNK and END", () => {
    expect(parsePacket(startBytes({ size: 183178, chunkCount: 359, crc: 0xdeadbeef, chunkSize: 511, width: 1600, height: 1200, captureId: 3 }))).toEqual({
      type: "start",
      size: 183178,
      chunkCount: 359,
      crc: 0xdeadbeef,
      chunkSize: 511,
      width: 1600,
      height: 1200,
      captureId: 3,
    });
    const chunk = parsePacket(chunkBytes(300, new Uint8Array([1, 2, 3])));
    expect(chunk).toEqual({ type: "chunk", seq: 300, payload: new Uint8Array([1, 2, 3]) });
    expect(parsePacket(endBytes(359, 3))).toEqual({ type: "end", chunkCount: 359, captureId: 3 });
  });

  it("copies chunk payloads out of the notification buffer", () => {
    const view = chunkBytes(0, new Uint8Array([9, 9]));
    const chunk = parsePacket(view) as ChunkPacket;
    new Uint8Array(view.buffer).fill(0);
    expect([...chunk.payload]).toEqual([9, 9]);
  });

  it("ignores unknown or truncated packets", () => {
    expect(parsePacket(new DataView(new ArrayBuffer(0)))).toBeNull();
    expect(parsePacket(new DataView(new Uint8Array([0x7f, 1, 2]).buffer))).toBeNull();
    expect(parsePacket(new DataView(new Uint8Array([PACKET_START, 1, 2]).buffer))).toBeNull();
  });
});

describe("photo reassembly", () => {
  it("rebuilds the JPEG from chunks in any order, ignoring duplicates", () => {
    const { start, chunks } = sendPhoto(fixture, 244);
    const photo = new PhotoAssembler(start);
    [...chunks].reverse().forEach((c) => photo.add(c));
    photo.add(chunks[0]);
    expect(photo.complete).toBe(true);
    expect(photo.bytes).toBe(fixture.length);
    expect(photo.assemble()).toEqual(fixture);
  });

  it("asks for lost chunks as ranges and completes after the resend", () => {
    const { start, chunks } = sendPhoto(fixture, 100);
    const lost = new Set([0, 5, 6, 7, chunks.length - 1]);
    const photo = new PhotoAssembler(start);
    chunks.filter((c) => !lost.has(c.seq)).forEach((c) => photo.add(c));
    expect(photo.complete).toBe(false);
    expect(() => photo.assemble()).toThrow(/incomplete/);
    expect(photo.missingRanges()).toEqual([
      [0, 1],
      [5, 3],
      [chunks.length - 1, 1],
    ]);
    // The client resends one range per "resend" command.
    for (const [from, count] of photo.missingRanges()) {
      expect(command.resend(from, count)).toBe(`resend:${from}:${count}`);
      chunks.slice(from, from + count).forEach((c) => photo.add(c));
    }
    expect(photo.assemble()).toEqual(fixture);
  });

  it("rejects a damaged photo", () => {
    const { start, chunks } = sendPhoto(fixture, 244);
    const photo = new PhotoAssembler(start);
    chunks.forEach((c, i) => photo.add(i === 3 ? { ...c, payload: c.payload.map((b) => b ^ 0xff) } : c));
    expect(() => photo.assemble()).toThrow(ChecksumError);

    const short = new PhotoAssembler({ ...start, size: start.size + 1 });
    chunks.forEach((c) => short.add(c));
    expect(() => short.assemble()).toThrow(ChecksumError);
  });
});

describe("status, info and commands", () => {
  it("parses the status text", () => {
    expect(parseStatus("ready")).toEqual({ state: "ready" });
    expect(parseStatus("sending")).toEqual({ state: "sending" });
    expect(parseStatus("error:capture failed")).toEqual({ state: "error", message: "capture failed" });
    expect(parseStatus("???").state).toBe("error");
  });

  it("parses the Info JSON with safe defaults", () => {
    expect(parseInfo('{"fw":"1.0.0","model":"AI-Thinker ESP32-CAM","camera":true,"frame":"SXGA","quality":12,"led":128,"psram":true,"mtu":517}')).toEqual({
      firmware: "1.0.0",
      model: "AI-Thinker ESP32-CAM",
      camera: true,
      frame: "SXGA",
      led: 128,
      psram: true,
    });
    expect(parseInfo('{"frame":"QVGA","camera":false}')).toMatchObject({ frame: null, camera: false, led: 0 });
    expect(parseInfo("not json")).toMatchObject({ firmware: "unknown", camera: true, frame: null });
  });

  it("formats commands", () => {
    expect(command.frame("UXGA")).toBe("frame:UXGA");
    expect(command.preview).toBe("preview");
    expect(command.led(300)).toBe("led:255");
    expect(command.led(-4)).toBe("led:0");
  });
});

describe("firmware", () => {
  const firmware = readFileSync(path.join(import.meta.dirname, "../firmware/esp32-cam/esp32-cam.ino"), "utf8");
  const define = (name: string) => firmware.match(new RegExp(`#define ${name} "([^"]+)"`))?.[1];
  const constant = (name: string) => Number(firmware.match(new RegExp(`${name} = (0x[0-9a-f]+);`, "i"))?.[1]);

  it("uses the same UUIDs and packet types as the web client", () => {
    expect(define("SERVICE_UUID")).toBe(SERVICE_UUID);
    expect(define("CONTROL_UUID")).toBe(CONTROL_UUID);
    expect(define("STATUS_UUID")).toBe(STATUS_UUID);
    expect(define("DATA_UUID")).toBe(DATA_UUID);
    expect(define("INFO_UUID")).toBe(INFO_UUID);
    expect(constant("PKT_START")).toBe(PACKET_START);
    expect(constant("PKT_CHUNK")).toBe(PACKET_CHUNK);
    expect(constant("PKT_END")).toBe(PACKET_END);
  });
});

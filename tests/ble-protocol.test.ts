import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  command,
  CONTROL_UUID,
  crc32,
  DATA_UUID,
  firmwareAtLeast,
  firmwareMajor,
  FrameAssembler,
  INFO_UUID,
  INTERVAL_FIRMWARE,
  MAX_COMMAND_LENGTH,
  MAX_LABEL_BYTES,
  parseInfo,
  parsePacket,
  parseSchedule,
  parseStatus,
  SERVICE_UUID,
  STATUS_UUID,
  TELEGRAM_FIRMWARE,
  truncateBytes,
  type StartPacket,
} from "@/lib/ble/protocol";
import { framePackets } from "./ble-packets";

describe("preview packets", () => {
  const jpeg = Uint8Array.from({ length: 1000 }, (_, i) => (i * 7) % 256);

  it("computes the zlib CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("rebuilds a frame from its packets, in any order", () => {
    const [start, ...rest] = framePackets(jpeg).map(parsePacket);
    expect(start).toMatchObject({ type: "start", size: 1000, chunkCount: 5, width: 640, height: 480, frameId: 1 });
    const assembler = new FrameAssembler(start as StartPacket);
    for (const p of rest.slice(0, -1).reverse()) if (p?.type === "chunk") assembler.add(p);
    expect(rest.at(-1)).toEqual({ type: "end", chunkCount: 5, frameId: 1 });
    expect(assembler.complete).toBe(true);
    expect(assembler.assemble()).toEqual(jpeg);
  });

  it("refuses a damaged or incomplete frame", () => {
    const damaged = framePackets(jpeg, { crc: 1 }).map(parsePacket);
    const a = new FrameAssembler(damaged[0] as StartPacket);
    for (const p of damaged) if (p?.type === "chunk") a.add(p);
    expect(a.assemble()).toBeNull();

    const packets = framePackets(jpeg).map(parsePacket);
    const b = new FrameAssembler(packets[0] as StartPacket);
    b.add(packets[1] as Parameters<FrameAssembler["add"]>[0]);
    expect(b.complete).toBe(false);
    expect(b.assemble()).toBeNull();
    expect(parsePacket(new DataView(new ArrayBuffer(0)))).toBeNull();
  });
});

describe("status", () => {
  it("parses the status text", () => {
    expect(parseStatus("ready")).toEqual({ state: "ready" });
    expect(parseStatus("connecting")).toEqual({ state: "connecting" });
    expect(parseStatus("capturing")).toEqual({ state: "capturing" });
    expect(parseStatus("analyzing")).toEqual({ state: "analyzing" });
    expect(parseStatus("sending")).toEqual({ state: "sending" });
    expect(parseStatus("error:wrong password")).toEqual({ state: "error", message: "wrong password" });
    expect(parseStatus("error:")).toEqual({ state: "error", message: "unknown error" });
    expect(parseStatus("???").state).toBe("error");
  });
});

describe("info", () => {
  it("reads a firmware 2 Info (WiFi only) with safe defaults", () => {
    expect(
      parseInfo('{"fw":"2.0.0","model":"AI-Thinker ESP32-CAM","camera":true,"frame":"SXGA","wifi":true,"ssid":"Farm \\"A\\"","ip":"192.168.1.23","rssi":-61,"server":true}'),
    ).toEqual({
      firmware: "2.0.0",
      model: "AI-Thinker ESP32-CAM",
      camera: true,
      wifi: true,
      ssid: 'Farm "A"',
      ip: "192.168.1.23",
      rssi: -61,
      telegram: false,
      telegramLabel: null,
      schedule: null,
      clock: false,
    });
  });

  it("reads the Telegram and schedule fields", () => {
    expect(parseInfo('{"fw":"3.0.0","wifi":true,"telegram":true,"tgLabel":"Ana via @plant_bot","schedule":"62,07:00,480","clock":true}')).toMatchObject({
      firmware: "3.0.0",
      telegram: true,
      telegramLabel: "Ana via @plant_bot",
      schedule: { days: [1, 2, 3, 4, 5], time: "07:00", utcOffset: 480 },
      clock: true,
    });
    expect(parseInfo('{"fw":"3.0.0","telegram":false,"tgLabel":"","schedule":""}')).toMatchObject({ telegram: false, telegramLabel: null, schedule: null });
  });

  it("survives unreadable JSON", () => {
    expect(parseInfo("not json")).toMatchObject({ firmware: "unknown", camera: true, wifi: false, telegram: false, schedule: null });
    expect(parseInfo('{"camera":false,"ssid":"","ip":""}')).toMatchObject({ camera: false, ssid: null, ip: null });
  });

  it("reads the firmware's major version", () => {
    expect(firmwareMajor("3.0.0")).toBe(3);
    expect(firmwareMajor("2.0.0")).toBe(2);
    expect(firmwareMajor("unknown")).toBe(0);
  });

  it("compares firmware versions", () => {
    expect(firmwareAtLeast("3.3.0", "3.3")).toBe(true);
    expect(firmwareAtLeast("3.10.0", "3.3")).toBe(true);
    expect(firmwareAtLeast("4.0.0", "3.3")).toBe(true);
    expect(firmwareAtLeast("3.2.0", "3.3")).toBe(false);
    expect(firmwareAtLeast("unknown", "3.3")).toBe(false);
  });
});

describe("schedule", () => {
  it("formats days as a bit mask, Sunday = bit 0", () => {
    expect(command.schedule({ days: [0, 1, 2, 3, 4, 5, 6], time: "07:00", utcOffset: 480 })).toBe("schedule:127,07:00,480");
    expect(command.schedule({ days: [1, 5], time: "18:30", utcOffset: -300 })).toBe("schedule:34,18:30,-300");
    expect(command.schedule({ days: [], time: "07:00", utcOffset: 0 })).toBe("schedule:0,07:00,0");
  });

  it("formats a schedule every few minutes, round the clock", () => {
    expect(command.schedule({ days: [0, 1, 2, 3, 4, 5, 6], time: "00:00", utcOffset: 480, everyMinutes: 30 })).toBe("schedule:every:30,480");
  });

  it("parses what it formats", () => {
    for (const s of [
      { days: [0, 6], time: "00:00", utcOffset: 0 },
      { days: [1, 3, 5], time: "23:59", utcOffset: 330 },
      { days: [2], time: "12:15", utcOffset: -210 },
      { days: [0, 1, 2, 3, 4, 5, 6], time: "00:00", utcOffset: 480, everyMinutes: 720 },
    ]) {
      expect(parseSchedule(command.schedule(s).slice("schedule:".length))).toEqual(s);
    }
  });

  it("returns null when off or unreadable", () => {
    for (const text of ["0,07:00,480", "128,07:00,480", "127,7:00,480", "127,24:00,480", "127,07:00,", "127,07:00,4.5", "", "abc", "every:0,480", "every:1441,480", "every:30"]) {
      expect(parseSchedule(text)).toBeNull();
    }
  });
});

describe("commands", () => {
  it("formats the setup commands", () => {
    expect(command.wifiSsid("Farm WiFi")).toBe("wifi-ssid:Farm WiFi");
    expect(command.wifiPass("p:w")).toBe("wifi-pass:p:w");
    expect(command.wifiConnect).toBe("wifi:connect");
    expect(command.wifiForget).toBe("wifi:forget");
    expect(command.telegramToken("123456:AA-bb_cc")).toBe("tg-token:123456:AA-bb_cc");
    expect(command.telegramChat(-1001234567890)).toBe("tg-chat:-1001234567890");
    expect(command.telegramLabel("Ana via @plant_bot")).toBe("tg-label:Ana via @plant_bot");
    expect(command.report).toBe("report");
  });

  it("cuts a label to a byte limit without splitting characters", () => {
    expect(truncateBytes("Ana", 10)).toBe("Ana");
    const cut = truncateBytes("Halaman 🌱🌱🌱🌱🌱", 16);
    expect(new TextEncoder().encode(cut).length).toBeLessThanOrEqual(16);
    expect(cut).toBe("Halaman 🌱…");
  });
});

describe("firmware", () => {
  const firmware = readFileSync(path.join(import.meta.dirname, "../firmware/esp32-cam/esp32-cam.ino"), "utf8");
  const define = (name: string) => firmware.match(new RegExp(`#define ${name} "([^"]+)"`))?.[1];

  it("uses the same UUIDs as the web client", () => {
    expect(define("SERVICE_UUID")).toBe(SERVICE_UUID);
    expect(define("CONTROL_UUID")).toBe(CONTROL_UUID);
    expect(define("STATUS_UUID")).toBe(STATUS_UUID);
    expect(define("INFO_UUID")).toBe(INFO_UUID);
    expect(define("DATA_UUID")).toBe(DATA_UUID);
  });

  it("accepts commands as long as the web client sends, and knows every WiFi command", () => {
    expect(Number(firmware.match(/char text\[(\d+)\]/)?.[1])).toBe(MAX_COMMAND_LENGTH + 1);
    for (const c of [command.info, command.wifiSsid(""), command.wifiPass(""), command.wifiConnect, command.wifiForget]) {
      expect(firmware).toContain(`"${c}"`);
    }
  });

  it("knows the Telegram, schedule and report commands, and reports what the web app reads", () => {
    expect(firmwareMajor(define("FIRMWARE_VERSION") ?? "")).toBeGreaterThanOrEqual(TELEGRAM_FIRMWARE);
    const prefix = (c: string) => c.slice(0, c.indexOf(":") + 1);
    for (const c of [prefix(command.telegramToken("x")), prefix(command.telegramChat(1)), prefix(command.telegramLabel("x")), prefix(command.schedule({ days: [1], time: "07:00", utcOffset: 0 })), command.report, command.preview]) {
      expect(firmware).toContain(`"${c}"`);
    }
    expect(firmwareAtLeast(define("FIRMWARE_VERSION") ?? "", INTERVAL_FIRMWARE)).toBe(true);
    expect(firmware).toContain('"every:"');
    for (const key of ["telegram", "tgLabel", "schedule", "clock", "wifi", "ssid", "ip"]) {
      expect(firmware).toContain(`\\"${key}\\":`);
    }
    expect(Number(firmware.match(/MAX_LABEL_BYTES = (\d+)/)?.[1])).toBe(MAX_LABEL_BYTES);
  });
});

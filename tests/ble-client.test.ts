import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Esp32Camera } from "@/lib/ble/esp32-camera";
import { CONTROL_UUID, crc32, DATA_UUID, INFO_UUID, PACKET_CHUNK, PACKET_END, PACKET_START, SERVICE_UUID, STATUS_UUID } from "@/lib/ble/protocol";

// The Web Bluetooth client against a fake ESP32-CAM that answers like firmware/esp32-cam/esp32-cam.ino.

const jpeg = new Uint8Array(readFileSync(path.join(import.meta.dirname, "../test-images/synthetic/rosette-healthy.jpg")));
/** Stands in for a QVGA preview frame (the client only checks size and CRC). */
const previewJpeg = jpeg.slice(0, 5000);
const CHUNK = 244;

class FakeCharacteristic extends EventTarget {
  value: DataView | null = null;
  constructor(private readonly onWrite?: (text: string) => void) {
    super();
  }
  async startNotifications() {
    return this;
  }
  async readValue() {
    return this.value!;
  }
  async writeValueWithResponse(data: Uint8Array) {
    this.onWrite?.(new TextDecoder().decode(data));
  }
  notify(bytes: Uint8Array) {
    this.value = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.dispatchEvent(new Event("characteristicvaluechanged"));
  }
}

const text = (s: string) => new TextEncoder().encode(s);

class FakeEsp32 extends EventTarget {
  readonly name = "PlantCam-627E";
  readonly commands: string[] = [];
  /** Chunks not delivered on the next transfer (the client must ask for them again). */
  drop = new Set<number>();
  /** Flip a byte in the next transfer (the client must retake the photo). */
  corruptNext = 0;
  failCapture = false;
  failPreview = false;
  disconnectAfterChunks: number | null = null;
  frame = "SXGA";
  connected = false;
  /** Set if a command other than resend arrived while a photo was still being sent. */
  overlapped = false;
  private sending = false;
  /** The last photo, kept for resends like the firmware does. */
  private image = jpeg;
  private sendTimer: ReturnType<typeof setImmediate> | null = null;

  readonly control = new FakeCharacteristic((t) => this.handle(t));
  readonly status = new FakeCharacteristic();
  readonly data = new FakeCharacteristic();
  readonly info = new FakeCharacteristic();

  readonly gatt = {
    connected: false,
    connect: async () => {
      this.connected = true;
      return { getPrimaryService: async (uuid: string) => (uuid === SERVICE_UUID ? this.service : Promise.reject(new Error("no service"))) };
    },
    disconnect: () => {
      if (!this.connected) return;
      this.connected = false;
      if (this.sendTimer) clearImmediate(this.sendTimer);
      this.dispatchEvent(new Event("gattserverdisconnected"));
    },
  };

  private readonly service = {
    getCharacteristic: async (uuid: string) => ({ [CONTROL_UUID]: this.control, [STATUS_UUID]: this.status, [DATA_UUID]: this.data, [INFO_UUID]: this.info })[uuid],
  };

  constructor() {
    super();
    this.status.value = new DataView(text("ready").buffer);
    this.updateInfo();
  }

  private updateInfo() {
    this.info.value = new DataView(text(JSON.stringify({ fw: "1.0.0", model: "AI-Thinker ESP32-CAM", camera: true, frame: this.frame, led: 0, psram: true })).buffer);
  }

  private setStatus(s: string) {
    this.status.notify(text(s));
  }

  /** Packets go out one per task, like notifications arriving over the air (setImmediate: Windows timers tick at ~15 ms). */
  private sendAll(packets: Uint8Array[], then: () => void) {
    const next = (i: number) => {
      if (!this.connected) return;
      if (i === packets.length) return then();
      // The transfer is over once the last packet is out; the client may answer it right away.
      this.sending = i < packets.length - 1;
      this.data.notify(packets[i]);
      this.sendTimer = setImmediate(() => next(i + 1));
    };
    next(0);
  }

  private chunk(seq: number, corrupt = false) {
    const payload = this.image.slice(seq * CHUNK, (seq + 1) * CHUNK);
    if (corrupt) payload[0] ^= 0xff;
    const p = new Uint8Array(3 + payload.length);
    p[0] = PACKET_CHUNK;
    new DataView(p.buffer).setUint16(1, seq, true);
    p.set(payload, 3);
    return p;
  }

  private end(count: number) {
    const p = new Uint8Array(5);
    p[0] = PACKET_END;
    new DataView(p.buffer).setUint16(1, count, true);
    return p;
  }

  private handle(t: string) {
    this.commands.push(t);
    if (this.sending && !t.startsWith("resend:")) this.overlapped = true;
    setTimeout(() => {
      const preview = t === "preview";
      if (t === "capture" || preview) {
        // Like the firmware: a preview frame sends no status, only errors.
        if (!preview) this.setStatus("capturing");
        if (preview ? this.failPreview : this.failCapture) return this.setStatus("error:capture failed");
        if (!preview) this.setStatus("sending");
        this.image = preview ? previewJpeg : jpeg;
        const count = Math.ceil(this.image.length / CHUNK);
        const start = new Uint8Array(19);
        const v = new DataView(start.buffer);
        start[0] = PACKET_START;
        v.setUint32(1, this.image.length, true);
        v.setUint16(5, count, true);
        v.setUint32(7, crc32(this.image), true);
        v.setUint16(11, CHUNK, true);
        v.setUint16(13, preview ? 320 : 1280, true);
        v.setUint16(15, preview ? 240 : 1024, true);
        const corrupt = this.corruptNext-- > 0;
        const chunks: Uint8Array[] = [];
        for (let seq = 0; seq < count; seq++) {
          if (this.disconnectAfterChunks === seq) {
            this.sendAll([start, ...chunks], () => this.gatt.disconnect());
            return;
          }
          if (!this.drop.has(seq)) chunks.push(this.chunk(seq, corrupt && seq === 2));
        }
        this.drop.clear();
        this.sendAll([start, ...chunks, this.end(count)], () => !preview && this.setStatus("ready"));
      } else if (t.startsWith("resend:")) {
        const [from, n] = t.slice(7).split(":").map(Number);
        const count = Math.ceil(this.image.length / CHUNK);
        this.setStatus("sending");
        const chunks = Array.from({ length: Math.min(n, count - from) }, (_, i) => this.chunk(from + i));
        this.sendAll([...chunks, this.end(count)], () => this.setStatus("ready"));
      } else if (t.startsWith("frame:")) {
        this.frame = t.slice(6);
        this.updateInfo();
        this.setStatus("ready");
      } else {
        this.setStatus("error:unknown command");
      }
    }, 0);
  }
}

let device: FakeEsp32;
let camera: Esp32Camera;

beforeEach(async () => {
  device = new FakeEsp32();
  vi.stubGlobal("window", { isSecureContext: true });
  vi.stubGlobal("navigator", { bluetooth: { getAvailability: async () => true, requestDevice: async () => device } });
  camera = new Esp32Camera();
  await camera.pick();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function bytesOf(blob: Blob) {
  return new Uint8Array(await blob.arrayBuffer());
}

describe("Esp32Camera", () => {
  it("connects and reads the device info and status", () => {
    const s = camera.getSnapshot();
    expect(s).toMatchObject({ supported: true, connection: "connected", deviceName: "PlantCam-627E", status: { state: "ready" }, busy: false });
    expect(s.info).toMatchObject({ firmware: "1.0.0", frame: "SXGA", camera: true });
  });

  it("receives a photo with progress", async () => {
    const progress: number[] = [];
    const photo = await camera.capture((p) => progress.push(p.received / p.total));
    expect(await bytesOf(photo.blob)).toEqual(jpeg);
    expect(photo).toMatchObject({ width: 1280, height: 1024 });
    expect(progress.at(-1)).toBe(1);
    expect(camera.getSnapshot().busy).toBe(false);
    expect(device.commands).toEqual(["capture"]);
  });

  it("asks again for lost chunks", async () => {
    device.drop = new Set([0, 4, 5, 6, 30]);
    const photo = await camera.capture();
    expect(await bytesOf(photo.blob)).toEqual(jpeg);
    expect(device.commands).toEqual(["capture", "resend:0:1", "resend:4:3", "resend:30:1"]);
  });

  it("retakes a photo that arrived damaged", async () => {
    device.corruptNext = 1;
    const photo = await camera.capture();
    expect(await bytesOf(photo.blob)).toEqual(jpeg);
    expect(device.commands).toEqual(["capture", "capture"]);
  });

  it("reports camera errors from the board", async () => {
    device.failCapture = true;
    await expect(camera.capture()).rejects.toThrow("ESP32-CAM: capture failed");
    expect(camera.getSnapshot().busy).toBe(false);
  });

  it("changes the frame size and rereads the info", async () => {
    await camera.setFrame("UXGA");
    expect(device.commands).toEqual(["frame:UXGA"]);
    expect(camera.getSnapshot().info?.frame).toBe("UXGA");
  });

  it("runs one command at a time", async () => {
    const first = camera.capture();
    await expect(camera.setFrame("VGA")).rejects.toThrow(/busy/);
    await first;
  });

  it("fails the capture and reports the disconnect when the link drops", async () => {
    device.disconnectAfterChunks = 10;
    await expect(camera.capture()).rejects.toThrow(/disconnected/);
    expect(camera.getSnapshot()).toMatchObject({ connection: "disconnected", deviceName: "PlantCam-627E", busy: false });

    // Reconnect without the chooser, then capture normally.
    device.disconnectAfterChunks = null;
    await camera.connect();
    expect(camera.getSnapshot().connection).toBe("connected");
    expect(await bytesOf((await camera.capture()).blob)).toEqual(jpeg);
  });
});

describe("live preview", () => {
  afterEach(() => camera.stopPreview());

  it("streams preview frames until stopped", async () => {
    camera.startPreview();
    await vi.waitFor(() => expect(device.commands.length).toBeGreaterThanOrEqual(3));
    const s = camera.getSnapshot();
    expect(s).toMatchObject({ previewing: true, previewFrame: { width: 320, height: 240 } });
    expect(await bytesOf(s.previewFrame!.blob)).toEqual(previewJpeg);
    await vi.waitFor(() => expect(camera.getSnapshot().previewFps).toBeGreaterThan(0));

    camera.stopPreview();
    await new Promise((r) => setTimeout(r, 50));
    const sent = device.commands.length;
    await new Promise((r) => setTimeout(r, 100));
    expect(device.commands.length).toBe(sent);
    expect(device.commands.every((c) => c === "preview")).toBe(true);
    expect(camera.getSnapshot()).toMatchObject({ previewing: false, previewFps: null });
  });

  it("pauses for a capture and a settings change, then resumes", async () => {
    camera.startPreview();
    await vi.waitFor(() => expect(device.commands.length).toBeGreaterThanOrEqual(2));
    const photo = await camera.capture();
    expect(await bytesOf(photo.blob)).toEqual(jpeg);
    await camera.setFrame("UXGA");
    await vi.waitFor(() => expect(device.commands.lastIndexOf("preview")).toBeGreaterThan(device.commands.indexOf("frame:UXGA")));
    // The capture waited for the frame in flight: transfers never overlap.
    expect(device.overlapped).toBe(false);
    expect(device.commands.filter((c) => c !== "preview")).toEqual(["capture", "frame:UXGA"]);
  });

  it("stops by itself after repeated failures", async () => {
    device.failPreview = true;
    camera.startPreview();
    await vi.waitFor(() => expect(camera.getSnapshot().previewing).toBe(false));
    expect(camera.getSnapshot().previewError).toBe("ESP32-CAM: capture failed");
    expect(device.commands).toEqual(["preview", "preview", "preview"]);
  });

  it("ends with the connection and resumes after reconnecting", async () => {
    camera.startPreview();
    await vi.waitFor(() => expect(device.commands.length).toBeGreaterThanOrEqual(2));
    camera.disconnect();
    expect(camera.getSnapshot().connection).toBe("disconnected");
    const sent = device.commands.length;
    await camera.connect();
    await vi.waitFor(() => expect(device.commands.length).toBeGreaterThan(sent));
    expect(camera.getSnapshot().previewing).toBe(true);
  });
});

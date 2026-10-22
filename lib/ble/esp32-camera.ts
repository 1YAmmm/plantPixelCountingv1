import {
  command,
  CONTROL_UUID,
  DATA_UUID,
  DEVICE_NAME_PREFIX,
  INFO_UUID,
  parseInfo,
  parsePacket,
  parseStatus,
  PhotoAssembler,
  SERVICE_UUID,
  STATUS_UUID,
  type DeviceInfo,
  type DeviceStatus,
  type FrameSize,
} from "./protocol";

// Plan §11.3, browser side: Web Bluetooth client for the ESP32-CAM firmware. The phone (or
// computer) is the bridge: it asks for a photo, reassembles the chunks and hands the JPEG to the
// analyzer. The connection lives at module level so it survives the analyzer switching steps
// (capture → preview → retake) without opening the device chooser again.
//
// Live preview: small frames requested back to back (about 6–8 a second at MTU 517). A capture or
// a settings change pauses it, so only one transfer runs at a time. The preview (4:3) and every
// photo size share the sensor's full height, and the 5:4 SXGA photo is a centred crop, so the
// guide square drawn on the preview covers the same area as the photo's.

export type Connection = "disconnected" | "connecting" | "connected";

export interface Esp32Photo {
  blob: Blob;
  width: number;
  height: number;
  /** Transfer time, ms. */
  ms: number;
}

export interface Esp32State {
  /** False without Web Bluetooth (Safari, Firefox) or outside HTTPS / localhost. */
  supported: boolean;
  connection: Connection;
  /** The chosen device, kept so Reconnect does not need the chooser. */
  deviceName: string | null;
  status: DeviceStatus | null;
  info: DeviceInfo | null;
  /** A capture or a settings change is running. */
  busy: boolean;
  /** Live preview is on: frames keep coming while connected. */
  previewing: boolean;
  /** The latest live preview frame. */
  previewFrame: Esp32Photo | null;
  /** Frames per second, smoothed (null until the second frame). */
  previewFps: number | null;
  /** Why the live preview stopped by itself. */
  previewError: string | null;
}

export interface TransferProgress {
  received: number;
  total: number;
}

type WaitKind = "end" | "status";

interface Waiter {
  kind: WaitKind;
  gapMs: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface Characteristics {
  control: BluetoothRemoteGATTCharacteristic;
  status: BluetoothRemoteGATTCharacteristic;
  data: BluetoothRemoteGATTCharacteristic;
  info: BluetoothRemoteGATTCharacteristic;
}

/** Taking the photo and the first packet; the largest frame sizes take a few seconds. */
const FIRST_PACKET_TIMEOUT_MS = 15_000;
/** Longest silence allowed between two packets of a transfer. */
const PACKET_GAP_TIMEOUT_MS = 6_000;
const COMMAND_TIMEOUT_MS = 6_000;
/** Resend rounds in a row that recover nothing before giving up. */
const MAX_STALLED_RESENDS = 3;
const CAPTURE_ATTEMPTS = 2;
const PROGRESS_INTERVAL_MS = 100;
/** Failed preview frames in a row before the live preview stops. */
const MAX_PREVIEW_FAILURES = 3;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

function isSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.bluetooth && window.isSecureContext;
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

const SERVER_STATE: Esp32State = {
  supported: false,
  connection: "disconnected",
  deviceName: null,
  status: null,
  info: null,
  busy: false,
  previewing: false,
  previewFrame: null,
  previewFps: null,
  previewError: null,
};

export class Esp32Camera {
  private state: Esp32State | null = null;
  private readonly listeners = new Set<() => void>();
  private device: BluetoothDevice | null = null;
  private chars: Characteristics | null = null;
  private gattQueue: Promise<unknown> = Promise.resolve();
  private assembler: PhotoAssembler | null = null;
  private waiter: Waiter | null = null;
  private onProgress: ((p: TransferProgress) => void) | null = null;
  private lastProgress = 0;
  private previewWanted = false;
  private previewLoop: Promise<void> | null = null;
  /** Set while a capture or settings change runs: the preview loop stops after its current frame. */
  private paused = false;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): Esp32State => (this.state ??= { ...SERVER_STATE, supported: isSupported() });

  getServerSnapshot = (): Esp32State => SERVER_STATE;

  private set(patch: Partial<Esp32State>) {
    this.state = { ...this.getSnapshot(), ...patch };
    this.listeners.forEach((l) => l());
  }

  /** Open the browser's device chooser and connect. Resolves quietly if the chooser is cancelled. */
  async pick(): Promise<void> {
    const bluetooth = navigator.bluetooth;
    if (!(await bluetooth.getAvailability())) throw new Error("Bluetooth is off or missing on this device. Turn it on and try again.");
    let device: BluetoothDevice;
    try {
      device = await bluetooth.requestDevice({
        filters: [{ services: [SERVICE_UUID] }, { namePrefix: DEVICE_NAME_PREFIX }],
        optionalServices: [SERVICE_UUID],
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "NotFoundError") return; // chooser closed
      throw e;
    }
    if (device !== this.device) {
      this.device?.removeEventListener("gattserverdisconnected", this.onDisconnected);
      this.device?.gatt?.disconnect();
      device.addEventListener("gattserverdisconnected", this.onDisconnected);
      this.device = device;
    }
    this.set({ deviceName: device.name ?? "ESP32-CAM" });
    await this.connect();
  }

  /** Connect (again) to the device chosen with pick(). */
  async connect(): Promise<void> {
    const device = this.device;
    if (!device?.gatt) throw new Error("Choose the ESP32-CAM first");
    this.set({ connection: "connecting" });
    try {
      try {
        await this.setup(device.gatt);
      } catch {
        // A first attempt right after the chooser often fails on Windows and Android; try once more.
        device.gatt.disconnect();
        await new Promise((r) => setTimeout(r, 600));
        await this.setup(device.gatt);
      }
      this.set({ connection: "connected" });
      this.ensurePreview();
    } catch (e) {
      device.gatt.disconnect();
      this.set({ connection: "disconnected" });
      throw new Error(`Could not connect to ${device.name ?? "the ESP32-CAM"}. Check that it is powered and nearby. (${asError(e).message})`);
    }
  }

  disconnect(): void {
    this.device?.gatt?.disconnect();
  }

  private async setup(gatt: BluetoothRemoteGATTServer) {
    const server = await gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    const chars: Characteristics = {
      control: await service.getCharacteristic(CONTROL_UUID),
      status: await service.getCharacteristic(STATUS_UUID),
      data: await service.getCharacteristic(DATA_UUID),
      info: await service.getCharacteristic(INFO_UUID),
    };
    this.detach();
    chars.data.addEventListener("characteristicvaluechanged", this.onData);
    chars.status.addEventListener("characteristicvaluechanged", this.onStatus);
    await chars.data.startNotifications();
    await chars.status.startNotifications();
    this.chars = chars;
    const status = parseStatus(decoder.decode(await chars.status.readValue()));
    const info = parseInfo(decoder.decode(await chars.info.readValue()));
    this.set({ status, info });
  }

  private detach() {
    this.chars?.data.removeEventListener("characteristicvaluechanged", this.onData);
    this.chars?.status.removeEventListener("characteristicvaluechanged", this.onStatus);
    this.chars = null;
  }

  private onDisconnected = () => {
    this.detach();
    this.settle(new Error("The ESP32-CAM disconnected"));
    this.set({ connection: "disconnected", previewFps: null });
  };

  /** Keep requesting preview frames until stopPreview() or a disconnect. */
  startPreview(): void {
    this.previewWanted = true;
    this.set({ previewing: true, previewError: null });
    this.ensurePreview();
  }

  stopPreview(): void {
    this.previewWanted = false;
    this.set({ previewing: false, previewFps: null });
  }

  private ensurePreview() {
    if (this.previewLoop || !this.previewWanted || !this.chars || this.paused) return;
    this.previewLoop = this.runPreview().finally(() => {
      this.previewLoop = null;
    });
  }

  private async runPreview() {
    let failures = 0;
    let last = 0;
    while (this.previewWanted && this.chars && !this.paused) {
      try {
        const frame = await this.receive(command.preview);
        const now = performance.now();
        const fps = last ? 1000 / (now - last) : null;
        const smoothed = this.getSnapshot().previewFps;
        last = now;
        failures = 0;
        if (this.previewWanted) this.set({ previewFrame: frame, previewFps: fps == null || smoothed == null ? fps : smoothed * 0.8 + fps * 0.2 });
      } catch (e) {
        if (!this.chars) return;
        if (++failures >= MAX_PREVIEW_FAILURES) {
          this.previewWanted = false;
          this.set({ previewing: false, previewFps: null, previewError: asError(e).message });
          return;
        }
      }
    }
  }

  /** Take a photo and receive it. Lost chunks are requested again; a damaged photo is retaken once. */
  async capture(onProgress?: (p: TransferProgress) => void): Promise<Esp32Photo> {
    return this.exclusive(async () => {
      this.onProgress = onProgress ?? null;
      try {
        for (let attempt = 1; ; attempt++) {
          try {
            return await this.receive(command.capture);
          } catch (e) {
            if (attempt >= CAPTURE_ATTEMPTS || !this.chars) throw e;
          }
        }
      } finally {
        this.onProgress = null;
      }
    });
  }

  setFrame(size: FrameSize): Promise<void> {
    return this.configure(command.frame(size));
  }

  /** On-board LED brightness during capture, 0 = off. */
  setLed(level: number): Promise<void> {
    return this.configure(command.led(level));
  }

  private configure(text: string): Promise<void> {
    return this.exclusive(async () => {
      await this.request(text, "status", COMMAND_TIMEOUT_MS);
      const info = this.chars?.info;
      if (info) this.set({ info: parseInfo(decoder.decode(await this.gatt(() => info.readValue()))) });
    });
  }

  /** Send "capture" or "preview" and receive the photo, asking again for lost chunks. */
  private async receive(text: string): Promise<Esp32Photo> {
    const started = performance.now();
    this.assembler = null;
    await this.request(text, "end", FIRST_PACKET_TIMEOUT_MS, PACKET_GAP_TIMEOUT_MS);
    const photo = this.assembler as PhotoAssembler | null;
    if (!photo) throw new Error("The photo did not arrive");
    let stalled = 0;
    while (!photo.complete) {
      const before = photo.bytes;
      const [from, count] = photo.missingRanges()[0];
      await this.request(command.resend(from, count), "end", PACKET_GAP_TIMEOUT_MS);
      stalled = photo.bytes > before ? 0 : stalled + 1;
      if (stalled >= MAX_STALLED_RESENDS) throw new Error("Parts of the photo kept getting lost");
    }
    const bytes = photo.assemble();
    const blob = new Blob([bytes], { type: "image/jpeg" });
    return { blob, width: photo.start.width, height: photo.start.height, ms: performance.now() - started };
  }

  /**
   * Run one capture or settings change at a time: the firmware answers one command at a time.
   * The live preview pauses (after its current frame) and resumes afterwards.
   */
  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (!this.chars) throw new Error("The ESP32-CAM is not connected");
    if (this.getSnapshot().busy) throw new Error("The ESP32-CAM is busy");
    this.set({ busy: true });
    this.paused = true;
    try {
      await this.previewLoop;
      if (!this.chars) throw new Error("The ESP32-CAM disconnected");
      return await run();
    } finally {
      this.paused = false;
      this.set({ busy: false });
      this.ensurePreview();
    }
  }

  /** Write a command and wait for its END packet or its status reply. */
  private request(text: string, kind: WaitKind, firstMs: number, gapMs = firstMs): Promise<void> {
    const done = new Promise<void>((resolve, reject) => {
      this.waiter = { kind, gapMs, resolve, reject, timer: setTimeout(() => this.settle(this.timeoutError()), firstMs) };
    });
    const control = this.chars?.control;
    if (!control) this.settle(new Error("The ESP32-CAM is not connected"));
    else this.gatt(() => control.writeValueWithResponse(encoder.encode(text))).catch((e) => this.settle(asError(e)));
    return done;
  }

  private timeoutError() {
    return new Error("The ESP32-CAM stopped responding. Move it closer, or reconnect.");
  }

  private settle(error?: Error) {
    const waiter = this.waiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiter = null;
    if (error) waiter.reject(error);
    else waiter.resolve();
  }

  /** Any packet restarts the silence timer, so large photos do not time out. */
  private touch() {
    const waiter = this.waiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    waiter.timer = setTimeout(() => this.settle(this.timeoutError()), waiter.gapMs);
  }

  /** Web Bluetooth allows one GATT operation at a time (Chrome on Windows throws otherwise). */
  private gatt<T>(op: () => Promise<T>): Promise<T> {
    const next = this.gattQueue.then(op);
    this.gattQueue = next.catch(() => {});
    return next;
  }

  private onData = (e: Event) => {
    const value = (e.target as BluetoothRemoteGATTCharacteristic).value;
    const packet = value ? parsePacket(value) : null;
    if (!packet) return;
    if (packet.type === "start") this.assembler = new PhotoAssembler(packet);
    else if (packet.type === "chunk") {
      this.assembler?.add(packet);
      this.reportProgress();
    }
    if (this.waiter?.kind !== "end") return;
    if (packet.type === "end") this.settle();
    else this.touch();
  };

  private onStatus = (e: Event) => {
    const value = (e.target as BluetoothRemoteGATTCharacteristic).value;
    if (!value) return;
    const status = parseStatus(decoder.decode(value));
    this.set({ status });
    if (!this.waiter) return;
    if (status.state === "error") this.settle(new Error(`ESP32-CAM: ${status.message}`));
    else if (this.waiter.kind === "status" && status.state === "ready") this.settle();
    else this.touch();
  };

  private reportProgress() {
    const photo = this.assembler;
    if (!photo || !this.onProgress) return;
    const now = performance.now();
    if (!photo.complete && now - this.lastProgress < PROGRESS_INTERVAL_MS) return;
    this.lastProgress = now;
    this.onProgress({ received: photo.bytes, total: photo.start.size });
  }
}

export const esp32Camera = new Esp32Camera();

import {
  command,
  CONTROL_UUID,
  DEVICE_NAME_PREFIX,
  INFO_UUID,
  MAX_COMMAND_LENGTH,
  parseInfo,
  parseStatus,
  SERVICE_UUID,
  STATUS_UUID,
  type DeviceInfo,
  type DeviceSchedule,
  type DeviceStatus,
} from "./protocol";

// Web Bluetooth client for setting up the PlantCam (lib/ble/protocol.ts): WiFi, the Telegram chat
// for its reports and when to send them. The connection lives at module level so it survives the
// setup steps re-rendering, without opening the device chooser again.

export type Connection = "disconnected" | "connecting" | "connected";

export interface Esp32State {
  /** False without Web Bluetooth (Safari, Firefox) or outside HTTPS / localhost. */
  supported: boolean;
  connection: Connection;
  /** The chosen device, kept so Reconnect does not need the chooser. */
  deviceName: string | null;
  status: DeviceStatus | null;
  info: DeviceInfo | null;
  /** A command is running. */
  busy: boolean;
}

interface Waiter {
  gapMs: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: () => void;
  reject: (error: Error) => void;
}

interface Characteristics {
  control: BluetoothRemoteGATTCharacteristic;
  status: BluetoothRemoteGATTCharacteristic;
  info: BluetoothRemoteGATTCharacteristic;
}

const COMMAND_TIMEOUT_MS = 6_000;
/** The firmware tries to join the WiFi for up to 15 s. */
const WIFI_CONNECT_TIMEOUT_MS = 20_000;
/** A report: photo, analysis, then the upload to Telegram over a slow link. */
const REPORT_TIMEOUT_MS = 90_000;

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
};

export class Esp32Camera {
  private state: Esp32State | null = null;
  private readonly listeners = new Set<() => void>();
  private device: BluetoothDevice | null = null;
  private chars: Characteristics | null = null;
  private gattQueue: Promise<unknown> = Promise.resolve();
  private waiter: Waiter | null = null;

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
    this.set({ deviceName: device.name ?? "PlantCam" });
    await this.connect();
  }

  /** Connect (again) to the device chosen with pick(). */
  async connect(): Promise<void> {
    const device = this.device;
    if (!device?.gatt) throw new Error("Choose the camera first");
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
    } catch (e) {
      device.gatt.disconnect();
      this.set({ connection: "disconnected" });
      throw new Error(`Could not connect to ${device.name ?? "the camera"}. Check that it is powered and nearby. (${asError(e).message})`);
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
      info: await service.getCharacteristic(INFO_UUID),
    };
    this.detach();
    chars.status.addEventListener("characteristicvaluechanged", this.onStatus);
    await chars.status.startNotifications();
    this.chars = chars;
    const status = parseStatus(decoder.decode(await chars.status.readValue()));
    const info = parseInfo(decoder.decode(await chars.info.readValue()));
    this.set({ status, info });
  }

  private detach() {
    this.chars?.status.removeEventListener("characteristicvaluechanged", this.onStatus);
    this.chars = null;
  }

  private onDisconnected = () => {
    this.detach();
    this.settle(new Error("The camera disconnected"));
    this.set({ connection: "disconnected", busy: false });
  };

  /** Read the Info again (the camera may have joined the WiFi or got the time since). */
  async refresh(): Promise<DeviceInfo | null> {
    const char = this.chars?.info;
    if (!char) return null;
    const info = parseInfo(decoder.decode(await this.gatt(() => char.readValue())));
    this.set({ info });
    return info;
  }

  /** Save the WiFi and join it. Throws with the camera's reason ("wrong password", "network not found", …). */
  setupWifi({ ssid, password }: { ssid: string; password: string }): Promise<DeviceInfo | null> {
    return this.run([command.wifiSsid(ssid), command.wifiPass(password)], { text: command.wifiConnect, timeoutMs: WIFI_CONNECT_TIMEOUT_MS });
  }

  /** Save the bot token and the chat that gets the reports; `label` is shown here later. */
  setupTelegram({ token, chatId, label }: { token: string; chatId: number | string; label: string }): Promise<DeviceInfo | null> {
    return this.run([command.telegramToken(token), command.telegramChat(chatId), command.telegramLabel(label)]);
  }

  /** When to take the photo and send the report. */
  setSchedule(schedule: DeviceSchedule): Promise<DeviceInfo | null> {
    return this.run([command.schedule(schedule)]);
  }

  /** Take a photo, analyze it and send the report to Telegram now. */
  async sendReport(): Promise<void> {
    await this.run([], { text: command.report, timeoutMs: REPORT_TIMEOUT_MS });
  }

  /** Send `commands` one by one, each answered with "ready", then `last` with its own timeout; then reread the Info. */
  private run(commands: string[], last?: { text: string; timeoutMs: number }): Promise<DeviceInfo | null> {
    const all = last ? [...commands, last.text] : commands;
    if (all.some((c) => encoder.encode(c).length > MAX_COMMAND_LENGTH)) {
      return Promise.reject(new Error("A value is too long for the camera"));
    }
    return this.exclusive(async () => {
      for (const text of commands) await this.request(text, COMMAND_TIMEOUT_MS);
      if (last) await this.request(last.text, last.timeoutMs);
      return this.refresh();
    });
  }

  /** The firmware answers one command at a time. */
  private async exclusive<T>(run: () => Promise<T>): Promise<T> {
    if (!this.chars) throw new Error("The camera is not connected");
    if (this.getSnapshot().busy) throw new Error("The camera is busy");
    this.set({ busy: true });
    try {
      return await run();
    } finally {
      this.set({ busy: false });
    }
  }

  /** Write a command and wait for "ready" (or an error). Any other status restarts the timer. */
  private request(text: string, timeoutMs: number): Promise<void> {
    const done = new Promise<void>((resolve, reject) => {
      this.waiter = { gapMs: timeoutMs, resolve, reject, timer: setTimeout(() => this.settle(this.timeoutError()), timeoutMs) };
    });
    const control = this.chars?.control;
    if (!control) this.settle(new Error("The camera is not connected"));
    else this.gatt(() => control.writeValueWithResponse(encoder.encode(text))).catch((e) => this.settle(asError(e)));
    return done;
  }

  private timeoutError() {
    return new Error("The camera stopped responding. Move closer to it, or reconnect.");
  }

  private settle(error?: Error) {
    const waiter = this.waiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    this.waiter = null;
    if (error) waiter.reject(error);
    else waiter.resolve();
  }

  /** Web Bluetooth allows one GATT operation at a time (Chrome on Windows throws otherwise). */
  private gatt<T>(op: () => Promise<T>): Promise<T> {
    const next = this.gattQueue.then(op);
    this.gattQueue = next.catch(() => {});
    return next;
  }

  private onStatus = (e: Event) => {
    const value = (e.target as BluetoothRemoteGATTCharacteristic).value;
    if (!value) return;
    const status = parseStatus(decoder.decode(value));
    this.set({ status });
    const waiter = this.waiter;
    if (!waiter) return;
    if (status.state === "error") this.settle(new Error(`Camera: ${status.message}`));
    else if (status.state === "ready") this.settle();
    else {
      clearTimeout(waiter.timer);
      waiter.timer = setTimeout(() => this.settle(this.timeoutError()), waiter.gapMs);
    }
  };
}

export const esp32Camera = new Esp32Camera();

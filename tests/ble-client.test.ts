import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Esp32Camera, type PreviewFrame } from "@/lib/ble/esp32-camera";
import { CONTROL_UUID, DATA_UUID, INFO_UUID, SERVICE_UUID, STATUS_UUID } from "@/lib/ble/protocol";
import { framePackets } from "./ble-packets";

// The Web Bluetooth setup client against a fake PlantCam that answers like firmware/esp32-cam/esp32-cam.ino.

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

class FakePlantCam extends EventTarget {
  readonly name = "PlantCam-627E";
  readonly commands: string[] = [];
  firmware = "3.0.0";
  /** "wifi:connect" fails with a password of "wrong". */
  wifi = { ssid: "", pass: "", joined: false };
  telegram = { token: "", chat: "", label: "" };
  schedule = "";
  /** The status the "report" command ends with. */
  reportResult = "ready";
  /** Drop the link during the next "report". */
  disconnectDuringReport = false;
  connected = false;

  readonly control = new FakeCharacteristic((t) => this.handle(t));
  readonly status = new FakeCharacteristic();
  readonly info = new FakeCharacteristic();
  readonly data = new FakeCharacteristic();
  /** Firmware 3.5+: a Data characteristic and "preview". */
  hasPreview = true;
  /** Send preview frames with a wrong CRC. */
  damagePreview = false;
  previewId = 0;

  readonly gatt = {
    connected: false,
    connect: async () => {
      this.connected = true;
      return { getPrimaryService: async (uuid: string) => (uuid === SERVICE_UUID ? this.service : Promise.reject(new Error("no service"))) };
    },
    disconnect: () => {
      if (!this.connected) return;
      this.connected = false;
      this.dispatchEvent(new Event("gattserverdisconnected"));
    },
  };

  private readonly service = {
    getCharacteristic: async (uuid: string) => {
      const chars: Record<string, FakeCharacteristic> = { [CONTROL_UUID]: this.control, [STATUS_UUID]: this.status, [INFO_UUID]: this.info };
      if (this.hasPreview) chars[DATA_UUID] = this.data;
      if (!chars[uuid]) throw new Error("No Characteristics matching UUID");
      return chars[uuid];
    },
  };

  constructor() {
    super();
    this.status.value = new DataView(text("ready").buffer);
    this.updateInfo();
  }

  /** The bytes of preview frame `n`. */
  static frame(n: number): Uint8Array {
    return Uint8Array.from({ length: 900 }, (_, i) => (i + n) % 256);
  }

  updateInfo() {
    const w = this.wifi;
    const t = this.telegram;
    const info = {
      fw: this.firmware,
      model: "AI-Thinker ESP32-CAM",
      camera: true,
      wifi: w.joined,
      ssid: w.ssid,
      ip: w.joined ? "192.168.1.23" : "",
      telegram: !!(t.token && t.chat),
      tgLabel: t.label,
      schedule: this.schedule,
      clock: w.joined,
    };
    this.info.value = new DataView(text(JSON.stringify(info)).buffer);
  }

  private setStatus(s: string) {
    this.status.notify(text(s));
  }

  private handle(t: string) {
    this.commands.push(t);
    setTimeout(() => {
      const [name, ...rest] = t.split(":");
      const value = rest.join(":");
      const v3 = this.firmware.startsWith("3");
      if (name === "wifi-ssid") this.wifi.ssid = value;
      else if (name === "wifi-pass") this.wifi.pass = value;
      else if (t === "wifi:connect") {
        this.setStatus("connecting");
        setTimeout(() => {
          this.wifi.joined = this.wifi.pass !== "wrong" && !!this.wifi.ssid;
          this.updateInfo();
          this.setStatus(this.wifi.joined ? "ready" : "error:wrong password");
        }, 5);
        return;
      } else if (v3 && name === "tg-token") this.telegram.token = value;
      else if (v3 && name === "tg-chat") this.telegram.chat = value;
      else if (v3 && name === "tg-label") this.telegram.label = value;
      else if (v3 && name === "schedule") this.schedule = value;
      else if (this.hasPreview && t === "preview") {
        this.previewId++;
        const jpeg = FakePlantCam.frame(this.previewId);
        framePackets(jpeg, { frameId: this.previewId, crc: this.damagePreview ? 1 : undefined }).forEach((p, i) =>
          setTimeout(() => this.connected && this.data.notify(new Uint8Array(p.buffer)), i),
        );
        return;
      } else if (v3 && t === "report") {
        // Three photos, each taken and analyzed, then the result to Telegram.
        ["capturing", "analyzing", "capturing", "analyzing", "capturing", "analyzing"].forEach((s, i) => setTimeout(() => this.setStatus(s), i));
        setTimeout(() => (this.disconnectDuringReport ? this.gatt.disconnect() : this.setStatus("sending")), 7);
        setTimeout(() => this.connected && this.setStatus(this.reportResult), 9);
        return;
      } else return this.setStatus("error:unknown command");
      this.updateInfo();
      this.setStatus("ready");
    }, 0);
  }
}

let device: FakePlantCam;
let camera: Esp32Camera;

beforeEach(async () => {
  device = new FakePlantCam();
  vi.stubGlobal("window", { isSecureContext: true });
  vi.stubGlobal("navigator", { bluetooth: { getAvailability: async () => true, requestDevice: async () => device } });
  camera = new Esp32Camera();
  await camera.pick();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("connection", () => {
  it("connects and reads the device info and status", () => {
    const s = camera.getSnapshot();
    expect(s).toMatchObject({ supported: true, connection: "connected", deviceName: "PlantCam-627E", status: { state: "ready" }, busy: false });
    expect(s.info).toMatchObject({ firmware: "3.0.0", camera: true, wifi: false, telegram: false, schedule: null });
  });

  it("rereads the Info on refresh", async () => {
    device.wifi = { ssid: "Farm WiFi", pass: "x", joined: true };
    device.updateInfo();
    await camera.refresh();
    expect(camera.getSnapshot().info).toMatchObject({ wifi: true, ssid: "Farm WiFi", ip: "192.168.1.23", clock: true });
  });

  it("reports the disconnect and reconnects without the chooser", async () => {
    device.gatt.disconnect();
    expect(camera.getSnapshot()).toMatchObject({ connection: "disconnected", deviceName: "PlantCam-627E" });
    await camera.connect();
    expect(camera.getSnapshot().connection).toBe("connected");
  });
});

describe("WiFi", () => {
  it("sends the WiFi, joins it and returns the new Info", async () => {
    const info = await camera.setupWifi({ ssid: "Farm WiFi", password: "pa:ss" });
    expect(device.commands).toEqual(["wifi-ssid:Farm WiFi", "wifi-pass:pa:ss", "wifi:connect"]);
    expect(device.wifi).toMatchObject({ ssid: "Farm WiFi", pass: "pa:ss" });
    expect(info).toMatchObject({ wifi: true, ssid: "Farm WiFi", ip: "192.168.1.23" });
    expect(camera.getSnapshot()).toMatchObject({ busy: false, info: { wifi: true } });
  });

  it("reports the camera's reason when it cannot join", async () => {
    await expect(camera.setupWifi({ ssid: "Farm WiFi", password: "wrong" })).rejects.toThrow("Camera: wrong password");
    expect(camera.getSnapshot().busy).toBe(false);
  });

  it("refuses values longer than the firmware's command buffer", async () => {
    await expect(camera.setupWifi({ ssid: "x", password: "p".repeat(200) })).rejects.toThrow(/too long/);
    expect(device.commands).toEqual([]);
  });
});

describe("Telegram and schedule", () => {
  it("saves the bot token, chat and label", async () => {
    const info = await camera.setupTelegram({ token: "123456:AAbbcc", chatId: -1001234567890, label: "Farm group via @plant_bot" });
    expect(device.commands).toEqual(["tg-token:123456:AAbbcc", "tg-chat:-1001234567890", "tg-label:Farm group via @plant_bot"]);
    expect(info).toMatchObject({ telegram: true, telegramLabel: "Farm group via @plant_bot" });
  });

  it("saves the schedule", async () => {
    const info = await camera.setSchedule({ days: [1, 2, 3, 4, 5], time: "07:30", utcOffset: 480 });
    expect(device.commands).toEqual(["schedule:62,07:30,480"]);
    expect(info?.schedule).toEqual({ days: [1, 2, 3, 4, 5], time: "07:30", utcOffset: 480 });
  });

  it("fails clearly on firmware without Telegram", async () => {
    device.firmware = "2.0.0";
    await expect(camera.setupTelegram({ token: "123456:AAbbcc", chatId: 42, label: "Ana" })).rejects.toThrow("Camera: unknown command");
    expect(device.commands).toEqual(["tg-token:123456:AAbbcc"]);
  });
});

describe("test report", () => {
  it("follows the camera through photo, analysis and upload", async () => {
    const states: string[] = [];
    camera.subscribe(() => states.push(camera.getSnapshot().status?.state ?? ""));
    await camera.sendReport();
    expect(device.commands).toEqual(["report"]);
    expect(states.filter((s, i) => s !== states[i - 1])).toEqual(expect.arrayContaining(["capturing", "analyzing", "sending", "ready"]));
    expect(camera.getSnapshot().busy).toBe(false);
  });

  it("passes on the camera's error", async () => {
    device.reportResult = "error:Telegram refused the photo";
    await expect(camera.sendReport()).rejects.toThrow("Camera: Telegram refused the photo");
  });

  it("runs one command at a time", async () => {
    const report = camera.sendReport();
    await expect(camera.setSchedule({ days: [0], time: "07:00", utcOffset: 0 })).rejects.toThrow(/busy/);
    await report;
  });

  it("fails when the link drops", async () => {
    device.disconnectDuringReport = true;
    await expect(camera.sendReport()).rejects.toThrow(/disconnected/);
    expect(camera.getSnapshot()).toMatchObject({ connection: "disconnected", busy: false });
  });
});

describe("preview", () => {
  it("shows frames until stopped, then frees the camera", async () => {
    expect(camera.getSnapshot().canPreview).toBe(true);
    const frames: PreviewFrame[] = [];
    await camera.startPreview((f) => {
      frames.push(f);
      expect(camera.getSnapshot()).toMatchObject({ busy: true, previewing: true });
      if (frames.length === 2) camera.stopPreview();
    });
    expect(device.commands).toEqual(["preview", "preview"]);
    expect(frames.map((f) => [f.width, f.height])).toEqual([
      [640, 480],
      [640, 480],
    ]);
    expect(new Uint8Array(await frames[1].jpeg.arrayBuffer())).toEqual(FakePlantCam.frame(2));
    expect(camera.getSnapshot()).toMatchObject({ busy: false, previewing: false });
  });

  it("keeps other commands out while it runs", async () => {
    const preview = camera.startPreview(() => camera.stopPreview());
    await expect(camera.sendReport()).rejects.toThrow(/busy/);
    await preview;
  });

  it("gives up when the frames keep arriving damaged", async () => {
    device.damagePreview = true;
    await expect(camera.startPreview(() => {})).rejects.toThrow(/damaged/);
    expect(device.commands).toEqual(["preview", "preview", "preview"]);
    expect(camera.getSnapshot().previewing).toBe(false);
  });

  it("is not offered by firmware without it", async () => {
    device.hasPreview = false;
    await camera.connect();
    expect(camera.getSnapshot().canPreview).toBe(false);
    await expect(camera.startPreview(() => {})).rejects.toThrow(/no preview/);
  });
});

describe("schedule every few minutes", () => {
  it("saves it and reads it back", async () => {
    const info = await camera.setSchedule({ days: [0, 1, 2, 3, 4, 5, 6], time: "00:00", utcOffset: 480, everyMinutes: 30 });
    expect(device.commands).toEqual(["schedule:every:30,480"]);
    expect(info?.schedule).toEqual({ days: [0, 1, 2, 3, 4, 5, 6], time: "00:00", utcOffset: 480, everyMinutes: 30 });
  });
});

# Plant Pixel Counter

An AI-Thinker ESP32-CAM (the **PlantCam**) mounted above a plant photographs it on a schedule,
measures how much of a guide square the leaves cover by counting green pixels, and sends the
report to a Telegram chat. The web app only **sets the camera up** over Bluetooth: its WiFi, the
Telegram bot and chat that get the reports, and the days and time. There is no server, login or
database: everything is saved on the camera.

```
web app --Bluetooth--> PlantCam: WiFi, Telegram bot token + chat, schedule (saved in its flash)
PlantCam --WiFi/HTTPS--> api.telegram.org: photo + leaf cover + status, at the set time
```

> **Status:** the setup page is done. Firmware 3 (Telegram settings, the clock from the internet,
> analysis on the camera and the upload to Telegram) is next; firmware 2.0 on the board today only
> takes the WiFi step, and the page says so.

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
```

The setup needs Web Bluetooth: Chrome or Edge on Android, Windows, macOS or ChromeOS, on
`localhost` or HTTPS. For a phone on the same WiFi:

```bash
npm run dev:phone    # https://<your-computer-ip>:3000 (accept the self-signed certificate)
```

Safari and Firefox do not have Web Bluetooth (on iPhone, the Bluefy browser does).

## Set up the camera

Open the page near the powered camera, **Connect camera** and pick `PlantCam-XXXX`. Then, in order:

1. **WiFi**: name and password of a 2.4 GHz network with internet (the camera cannot join 5 GHz).
2. **Telegram**: create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and paste its
   token; the page checks it. Press **Start** in the bot's chat (or add the bot to a group), then
   **Find chats** and pick the chat. **Save and send a test message** sends a first message from
   the browser and saves the token and chat on the camera. The bot only sends; it reads no
   commands.
3. **When to send the report**: the days and the time, in this device's time zone (saved as a
   fixed UTC offset, so a DST change needs a new save).

**Send a test report now** runs the whole chain on the camera. After that the page can be closed.

The browser talks to the Telegram Bot API directly (`lib/telegram.ts`): `api.telegram.org`
allows any origin but answers CORS preflights with 501, so it uses only simple requests (GET, or a
form POST without custom headers).

## Pipeline (to run on the camera)

The analysis is written and tested in TypeScript in `lib/vision/` and `lib/detection/`, and is
being ported to the firmware. Steps:

| Step | Code |
|---|---|
| 1. Guide-square crop, resize to 1000 px | `lib/vision/guide.ts` |
| 2. White balance from the white backdrop (also normalizes exposure) | `lib/vision/white-balance.ts` |
| 3. Region of interest | `lib/vision/roi.ts` |
| 4. HSV classification: leaf / stressed / background | `lib/vision/classify.ts`, `color.ts` |
| 5. Mask cleanup: open, close, small-blob removal, main-plant selection | `lib/vision/cleanup.ts` |
| 6. Plant region (convex hull) for discoloration | `lib/vision/region.ts` |
| 7. Leaf cover %, discoloration %, height | `lib/vision/measure.ts` |
| 8. Quality: brightness, sharpness | `lib/vision/quality.ts` |
| 9. Overlay image | `lib/vision/overlay.ts` |
| 10. Status vs. the healthy baseline (wilting index) | `lib/detection/` |

Without a reference of known size the result is **leaf cover in % of the square**, not cm², so it
is comparable between photos only when the camera mount stays put.

## Firmware

The sketch is `firmware/esp32-cam/esp32-cam.ino` (ESP32 Arduino core 3.x, no extra libraries).

- **Arduino IDE:** board **AI Thinker ESP32-CAM**, partition scheme **Huge APP** (the default),
  then Upload. With an ESP32-CAM-MB (USB) board the reset/boot is automatic.
- **arduino-cli** (bundled with Arduino IDE 2); the port is the one shown as `USB-SERIAL CH340`:

  ```bash
  arduino-cli compile --fqbn esp32:esp32:esp32cam:PartitionScheme=huge_app firmware/esp32-cam
  arduino-cli upload  --fqbn esp32:esp32:esp32cam:PartitionScheme=huge_app -p COM9 firmware/esp32-cam
  ```

The serial monitor (115200 baud) shows `[camera] ok, PSRAM yes`, `[ble] advertising as
PlantCam-XXXX` and the WiFi state. The camera needs a steady 5 V 2 A supply: WiFi bursts reset it
on weak ones.

BLE, WiFi and the PSRAM fix together nearly fill the ESP32's instruction RAM (IRAM): v2.0 uses
about 125 of 128 KB. Keep an eye on IRAM when adding libraries.

### Bluetooth protocol

One GATT service, `7a1e0000-5c3b-4d2a-8f1e-3b9c6d4a2e10` (UUIDs and parsing in
`lib/ble/protocol.ts`, client in `lib/ble/esp32-camera.ts`):

| Characteristic | Type | Content |
|---|---|---|
| Control `…0001` | write | One command at a time, up to 199 bytes: `info`; `wifi-ssid:<name>`, `wifi-pass:<password>`, `wifi:connect`, `wifi:forget`; `tg-token:<bot token>`, `tg-chat:<chat id>`, `tg-label:<who gets the reports>`; `schedule:<days>,<HH:MM>,<UTC offset, min>` (days: bit 0 = Sunday … bit 6 = Saturday); `report` |
| Status `…0002` | read, notify | `ready` / `connecting` / `capturing` / `analyzing` / `sending` / `error:<message>` (`wifi:connect` fails with `wrong password`, `network not found` or `timeout`) |
| Info `…0004` | read | JSON: `fw`, `model`, `camera`, `wifi`, `ssid`, `ip`, `rssi`, `telegram`, `tgLabel`, `schedule` (as sent), `clock` (has the time) |

Each command answers `ready` or `error:…`; `wifi:connect` and `report` pass through the other
states first. The `tg-*`, `schedule` and `report` commands come with firmware 3.

## Tests

```bash
npm test             # unit tests, the BLE client against a simulated camera, the pipeline on synthetic photos
npm run fixtures     # regenerate test-images/synthetic/*.jpg with known answers (manifest.json)
```

The pipeline tests check: leaf pixel count within 3% of the truth, identical results on
re-analysis, the same cover % at any camera resolution, colour-cast and exposure correction from
the backdrop, rejection of blurry/dark/bright photos, and processing time.

# Plant Pixel Counter

An AI-Thinker ESP32-CAM (the **PlantCam**) mounted above a plant photographs it on a schedule,
measures its leaves by counting green and yellow/brown pixels in a guide square, and sends the
result to a Telegram chat. The web app only **sets the camera up** over Bluetooth: its WiFi, the
Telegram bot and chat that get the reports, and when. There is no server, login or database:
everything is saved on the camera.

```
web app --Bluetooth--> PlantCam: WiFi, Telegram bot token + chat, schedule (saved in its flash)
PlantCam --WiFi/HTTPS--> api.telegram.org: the plant beside its leaf mask, and the result, at the set times
```

> **Status:** the setup page and firmware 3.4 work end to end. At the set times (or on **Send a
> test report now**) the camera takes 3 photos, measures the leaves itself and sends Telegram one
> picture, the plant on the left and its mask on the right (leaves green, yellow/brown parts
> orange), with a short result.

A report, straight from that day's photos:

```
🌱 PlantCam-627E
Thu 29 Oct 2026, 7:00 AM

🟡 Needs attention
Some leaves are turning yellow or brown.

Green leaves: 10% of the picture
Yellow or brown: 26% of the plant
```

The status is how much of the plant is yellow or brown: under 15% **Healthy**, from 15%
**Needs attention**, from 30% **Unhealthy** (`lib/detection`). A photo that is too dark, too
bright or blurry gives **Can't tell** with what to fix; no green at all gives **No green leaves
found** (the camera may point elsewhere, or the plant is dry or dead), never Unhealthy, since
yellow/brown alone may just be the room.
Each report takes 3 photos one after the other and uses the middle one by leaf cover, so one bad
frame does not decide the result. The status is about colour: a plant that droops but stays green
is still Healthy, and its smaller "Green leaves" number is the sign.

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
3. **When to send the report** (**Repeat**): every day or on certain days at a time (12-hour
   clock), or every 1–12 hours or every 1–30 minutes, counted from midnight so the reports come
   at the same times every day. All in this device's time zone (saved as a fixed UTC offset, so a
   DST change needs a new save).

**Send a test report now** runs the whole chain on the camera (about 25 seconds). After that the
page can be closed.

The browser talks to the Telegram Bot API directly (`lib/telegram.ts`): `api.telegram.org`
allows any origin but answers CORS preflights with 501, so it uses only simple requests (GET, or a
form POST without custom headers).

## Pipeline

The analysis is written and tested in TypeScript in `lib/vision/` and `lib/detection/`, and runs
on the camera as a line-by-line port: steps 1–8 in `firmware/esp32-cam/vision.cpp`, which also
makes the picture (with its own JPEG encoder, `jpeg.cpp`), and step 10 in `esp32-cam.ino`. The
camera analyzes the guide square at 500 px instead of 1000 (`CAMERA_SQUARE_PX`,
`CAMERA_VISION_SETTINGS`), which gives the same leaf cover within 0.1 point. Steps:

| Step | Code |
|---|---|
| 1. Guide-square crop, resize to 1000 px | `lib/vision/guide.ts` |
| 2. White balance from the white backdrop (also normalizes exposure) | `lib/vision/white-balance.ts` |
| 3. Region of interest | `lib/vision/roi.ts` |
| 4. HSV classification: leaf / stressed / background | `lib/vision/classify.ts`, `color.ts` |
| 5. Mask cleanup: open, close, small-blob removal, main-plant selection | `lib/vision/cleanup.ts` |
| 6. The plant: green and yellow/brown pixels together, cleaned up the same way, so a fully yellowed leaf counts and a brown object away from the plant does not | `lib/vision/cleanup.ts` (`plantRegion`) |
| 7. Leaf cover %, discoloration % (yellow/brown share of the plant), height | `lib/vision/measure.ts` |
| 8. Quality: brightness, sharpness | `lib/vision/quality.ts` |
| 9. Overlay image | `lib/vision/overlay.ts` |
| 10. Status from the discoloration | `lib/detection/` |

The discoloration counts any yellow or brown inside the plant, so soil or a brown pot showing
between the leaves counts too; a backdrop that covers the soil keeps it out.

Without a reference of known size the result is **leaf cover in % of the square**, not cm², so it
is comparable between photos only when the camera mount stays put.

## Firmware

The sketch is `firmware/esp32-cam/esp32-cam.ino` with the analysis in `vision.cpp` and the
picture's JPEG encoder in `jpeg.cpp` (ESP32 Arduino core 3.x, no extra libraries).

- **Arduino IDE:** board **AI Thinker ESP32-CAM**, partition scheme **Huge APP** (the default),
  then Upload. With an ESP32-CAM-MB (USB) board the reset/boot is automatic.
- **arduino-cli** (bundled with Arduino IDE 2); the port is the one shown as `USB-SERIAL CH340`:

  ```bash
  arduino-cli compile --fqbn esp32:esp32:esp32cam:PartitionScheme=huge_app firmware/esp32-cam
  arduino-cli upload  --fqbn esp32:esp32:esp32cam:PartitionScheme=huge_app -p COM9 firmware/esp32-cam
  ```

The serial monitor (115200 baud) shows `[camera] ok, PSRAM yes`, `[ble] advertising as
PlantCam-XXXX`, the WiFi, `[clock] …` once the time arrives, and each report with its
`[analysis] {…}` numbers for each photo, which photo it used, and its caption. The Bluetooth
commands can also be typed there, one per line (`report`, `info`, …), plus:

| Serial command | |
|---|---|
| `heap` | free memory |
| `analyze` | take a photo and analyze it, without sending it |
| `analyze:<bytes>` followed by that many bytes of a JPEG | analyze that JPEG instead of a photo, to compare with `lib/vision` on the PC (wait for the reply to `heap` before sending: the serial buffer is 256 bytes) |
| `report-file:<bytes>` followed by a JPEG | a whole report to Telegram with that JPEG instead of the photos, to test the status with the fixtures |
| `jpeg`, `picture` | the last photo or the last picture (square and mask) in base64, between `[jpeg] begin` and `[jpeg] end` |

The camera needs a steady 5 V 2 A supply: WiFi bursts reset it on weak ones.

A scheduled report is sent once per set time. A daily one missed while the camera was off or
offline is still sent up to 3 hours late (the caption says so), an "every N minutes" one up to 15
minutes late; one that cannot reach Telegram is retried every 5 minutes (or every N minutes if
sooner) in that window. The first scheduled time after saving a schedule is the next one, not
one already past.

**Memory.** The ESP32 has about 190 KB of internal RAM at start; the camera driver takes 43 KB,
BLE 87 KB and WiFi 48 KB, which leaves about 13 KB, too little for an HTTPS upload. So the TLS
buffers are allocated in PSRAM (`mbedtls_platform_set_calloc_free`), and the camera driver is
stopped during each upload (about 50 KB free then) and started again after. If it cannot start
again, the camera restarts and sends a missed scheduled report late. BLE, WiFi and the PSRAM fix
also nearly fill the instruction RAM (IRAM): about 127 of 128 KB, so the firmware avoids libc's
time functions (the PSRAM fix puts them in IRAM) and computes dates itself. For the same reason
the analysis uses no libm, `qsort` or `printf("%f")`.

**Analysis.** The camera decodes its 1280 × 1024 JPEG with the ESP32's ROM decoder, block by
block, adding the guide square's pixels into a 500 × 500 grid, so the full image is never held in
memory. The analysis then takes about 2.8 MB of PSRAM with the camera driver stopped: per photo
1.7 s to decode, 2.5 s to analyze and 0.5 s to encode the picture (1000 × 500, square and mask
side by side). The camera library's JPEG encoder (`fmt2jpg`) is not used: its tables are static
arrays that would take 8 KB of internal RAM for good, which the upload needs; `jpeg.cpp` keeps
them in flash and reads the picture pixel by pixel, so it is never in memory whole.

**Windows and an older firmware.** If Windows paired with the camera under an older firmware, it
keeps that firmware's Bluetooth layout and connections fail ("Invalid handle"). Remove
PlantCam-XXXX under Settings → Bluetooth & devices, then connect again.

### Bluetooth protocol

One GATT service, `7a1e0000-5c3b-4d2a-8f1e-3b9c6d4a2e10` (UUIDs and parsing in
`lib/ble/protocol.ts`, client in `lib/ble/esp32-camera.ts`):

| Characteristic | Type | Content |
|---|---|---|
| Control `…0001` | write | One command at a time, up to 199 bytes: `info`; `wifi-ssid:<name>`, `wifi-pass:<password>`, `wifi:connect`, `wifi:forget`; `tg-token:<bot token>`, `tg-chat:<chat id>`, `tg-label:<who gets the reports>`; `schedule:<days>,<HH:MM>,<UTC offset, min>` (days: bit 0 = Sunday … bit 6 = Saturday) or `schedule:every:<minutes>,<UTC offset, min>`; `report` |
| Status `…0002` | read, notify | `ready` / `connecting` / `capturing` / `analyzing` / `sending` / `error:<message>` (`wifi:connect` fails with `wrong password`, `network not found` or `timeout`) |
| Info `…0004` | read | JSON: `fw`, `model`, `camera`, `wifi`, `ssid`, `ip`, `rssi`, `telegram`, `tgLabel`, `schedule` (as sent), `clock` (has the time) |

Each command answers `ready` or `error:…`; `wifi:connect` and `report` pass through the other
states first (`report`: `capturing` and `analyzing` for each photo). The `tg-*`, `schedule` and
`report` commands come with firmware 3, `schedule:every:` with 3.3.

## Tests

```bash
npm test             # unit tests, the BLE client against a simulated camera, the pipeline on synthetic photos
npm run fixtures     # regenerate test-images/synthetic/*.jpg with known answers (manifest.json)
```

The pipeline tests check: leaf pixel count within 3% of the truth, discoloration within 2 points
of the truth (yellow spots and fully yellowed leaves), identical results on re-analysis, the same
cover % at any camera resolution, colour-cast and exposure correction from the backdrop,
rejection of blurry/dark/bright photos, and processing time. `camera-vision.test.ts`
checks that the camera's 500 px analysis (`cameraSquare` in `lib/vision/node.ts` is its crop in
TypeScript) gives the same answers on the fixtures, that `vision.cpp` and `esp32-cam.ino` use the
same settings and status thresholds, and that `jpeg.cpp`'s tables are complete.

On the camera itself, the fixtures sent with `analyze:<bytes>` give the same leaf cover as
`cameraSquare` within 0.02 point (leaf pixels within 0.2%), and the same photo checks; their
overlays decode on the PC and match `renderOverlay` within about 1 level of 255 (JPEG noise).

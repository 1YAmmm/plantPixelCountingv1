# Plant Pixel Counter

Measures how much of a guide square a plant's leaves cover by counting green pixels, and compares
it with the plant's own healthy baseline to detect wilting. Built from `plan.md` (§5–§6), trimmed
to the UI and the pixel counting: **no login, no database, no printed marker**. The one exception
is the [daily email report](#daily-email-report) (`newplan.md`): the ESP32-CAM photographs the
plant on a schedule over WiFi and the server emails the results, so that part keeps a little state
on the server.

## Run it

```bash
npm install
npm run dev          # http://localhost:3000
```

On a phone, the live camera and the level sensor need HTTPS:

```bash
npm run dev:phone    # https://<your-computer-ip>:3000 (accept the self-signed certificate)
```

Without HTTPS, **Take photo** still opens the phone's native camera (the centre square is used).

The ESP32-CAM option needs Web Bluetooth: Chrome or Edge on Android, Windows, macOS or ChromeOS,
on `localhost` or HTTPS (`npm run dev:phone` for a phone). Safari and Firefox do not have it; on
iPhone use the Bluefy browser. See [ESP32-CAM over Bluetooth](#esp32-cam-over-bluetooth).

## Using it

1. Put the plant on a plain white or light-gray backdrop, in even light.
2. **Analyze** page → choose **Phone camera** or **ESP32-CAM** (remembered in this browser). The
   camera shows a **square** with a dashed **circle**:
   - Fit the pot rim to the circle and keep all leaves inside the square. This keeps the
     distance, and so the scale, the same for every photo.
   - Hold the phone flat above the plant. The square and the level dot turn green when the
     phone is level (within 5°). On iPhone, tap **Enable level** first.
   - **Capture** keeps only the square (resized to 1000 × 1000 px). Uploaded photos use their
     centre square.
3. The preview shows the mask, an estimated leaf cover and warnings (tilt, brightness, blur).
   **Analyze** runs the full pipeline on the server; **Crop** removes clutter inside the square.
4. **Add to baseline** for up to 3 photos of the healthy, well-watered plant. Later photos then
   show a wilting index (leaf cover lost vs. the baseline) and Healthy / Mild Wilting / Wilting.
   The phone and the ESP32-CAM keep separate baselines, because their framing differs.
5. **Settings** → the colour range counted as leaf and the wilting thresholds, with a live
   preview. Everything else is under **Advanced settings**.

Settings and baseline samples are kept in the browser's localStorage. Export/Import (under
Advanced settings) moves settings between devices. The daily email report is the exception: it is
saved on the server, with a copy of these settings.

## Pipeline (plan §5, with the guide square instead of the marker)

| Step | Where | Code |
|---|---|---|
| 1. Orientation, guide-square crop, resize to 1000 px | browser | `lib/browser/image.ts`, `lib/vision/guide.ts` |
| 3. White balance from the white backdrop (also normalizes exposure) | shared | `lib/vision/white-balance.ts` |
| 4. Region of interest (the square, optional crop box) | shared | `lib/vision/roi.ts` |
| 5. HSV classification: leaf / stressed / background | shared | `lib/vision/classify.ts`, `color.ts` |
| 6. Mask cleanup: open, close, small-blob removal, main-plant selection | server (image-js) | `lib/vision/cleanup.ts` |
| 7. Plant region (convex hull) for discoloration | server | `lib/vision/region.ts` |
| 8. Leaf cover %, discoloration %, height | server | `lib/vision/measure.ts` |
| 9. Quality: brightness, sharpness (+ tilt in the browser) | shared | `lib/vision/quality.ts` |
| 10. Overlay image | server | `lib/vision/overlay.ts` |

"Shared" modules have no Next.js or Node dependencies and run identically in the browser
preview and on the server. `POST /api/analyze` (`app/api/analyze/route.ts`) is stateless.

Without a reference of known size the result is **leaf cover in % of the square**, not cm².
It is comparable between photos only when the framing is the same, which is what the circle
and the level indicator are for.

## ESP32-CAM over Bluetooth

Plan §11.3. An AI-Thinker ESP32-CAM is mounted above the plant and sends photos to the browser
over Bluetooth Low Energy. The browser is the bridge: it reassembles the photo and analyzes it
exactly like a phone photo (centre guide square, same pipeline). No WiFi is needed.

### Flash the firmware

The sketch is `firmware/esp32-cam/esp32-cam.ino` (ESP32 Arduino core 3.x, no extra libraries).
Version 2.0 adds WiFi for the daily email report; BLE works as before.

- **Arduino IDE:** board **AI Thinker ESP32-CAM**, partition scheme **Huge APP** (the default),
  then Upload. With an ESP32-CAM-MB (USB) board the reset/boot is automatic.
- **arduino-cli** (bundled with Arduino IDE 2):

  ```bash
  arduino-cli compile --fqbn esp32:esp32:esp32cam firmware/esp32-cam
  arduino-cli upload  --fqbn esp32:esp32:esp32cam -p COM10 firmware/esp32-cam
  ```

The serial monitor (115200 baud) shows `[camera] ok, PSRAM yes` and
`[ble] advertising as PlantCam-XXXX`, then `[wifi] …` and a `[poll] ok` line every minute once
the daily report is set up.

BLE, WiFi and the PSRAM fix together nearly fill the ESP32's instruction RAM (IRAM): v2.0 uses
about 125 of 128 KB. That is why it talks HTTP with a small built-in client instead of the core's
`HTTPClient`, which would add 6 KB of date functions. Keep an eye on IRAM when adding libraries.

### Use it

1. Power the board (a stable 5 V supply; USB from the MB board is fine for BLE).
2. **Analyze** → **ESP32-CAM** → **Connect ESP32-CAM** and pick `PlantCam-XXXX` in the browser's
   chooser.
3. The **live preview** starts: small 320 × 240 frames, about 6–8 a second, with the guide square
   and pot circle. Adjust the mount until the pot rim fits the circle. **Live mask** shows what
   counts as leaf, as on the phone.
4. **Capture** pauses the live view, takes the full-size photo on the board and sends it over
   (about 1–4 s, with a progress bar), then opens the preview → Analyze, as for the phone.
   **Retake** returns to the live view. The connection stays open between photos; after a
   disconnect, **Reconnect** skips the chooser.

**Photo size** and the **LED light** are saved on the board (the live view is always QVGA). With
the LED on, it stays lit while the live view runs and turns off 1.5 s after the last frame. SXGA (1280 × 1024) is the default:
VGA is fastest but its guide square is only 384 px, which sits right at the minimum sharpness.
Measured with Chrome on Windows (MTU 517): SXGA ≈ 125 KB in 2.6 s, UXGA ≈ 185 KB in 3.9 s.

### Protocol

One GATT service, `7a1e0000-5c3b-4d2a-8f1e-3b9c6d4a2e10` (UUIDs in `lib/ble/protocol.ts`):

| Characteristic | Type | Content |
|---|---|---|
| Control `…0001` | write | `capture`, `preview`, `frame:<VGA…UXGA>`, `led:<0–255>`, `resend:<from>:<count>`, `info`; for the daily report `wifi-ssid:<name>`, `wifi-pass:<password>`, `server:<url>`, `key:<device key>`, `wifi:connect`, `wifi:forget` (up to 199 bytes) |
| Status `…0002` | read, notify | `ready` / `capturing` / `sending` / `connecting` / `error:<message>` (`wifi:connect` fails with `wrong password`, `network not found` or `timeout`) |
| Data `…0003` | notify | START (size, chunk count, CRC-32, chunk size, width, height), CHUNK (sequence number + up to MTU − 6 bytes), END |
| Info `…0004` | read | JSON: firmware version, frame size, LED level, PSRAM, WiFi (joined, name, IP, signal), whether a server is set |

`preview` sends a QVGA frame the same way but without status updates; the browser requests the
next one as soon as a frame arrives. The preview and every photo size share the sensor's full
height (SXGA is a centred 5:4 crop), so the guide square on the live view covers the same area as
the photo's. The browser asks again for lost chunks (`resend`), checks the CRC-32, and retakes the
photo once if it still arrives damaged. Browser side: `lib/ble/esp32-camera.ts` (Web Bluetooth client) and
`components/analyzer/esp32-capture.tsx`. `tests/ble-*.test.ts` cover the wire format, the
reassembly and the client against a simulated board, and check the firmware's UUIDs.

## Daily email report

`newplan.md`. The ESP32-CAM takes a photo by itself on the days and at the time set on the
Settings page, the server analyzes it like an ESP32-CAM photo from the Analyze page (same guide
square, same pipeline, compared with the ESP32-CAM baseline) and emails the status, the numbers,
the photo and the overlay to everyone on the list.

```
ESP32-CAM (WiFi) --every 60 s--> GET  /api/device/config      "anything to do?"
                 <-------------- poll=60 [capture=<slot>]       (only when a set time is due)
ESP32-CAM -- JPEG -------------> POST /api/device/captures    (X-Slot: <slot>)
                                   crop guide square → pipeline → status vs baseline
                                   → Gmail to all recipients → summary for the Settings page
```

The server keeps the schedule, so the camera needs no clock and changes apply at its next poll.
A photo missed at the set time (camera offline) is still taken if the camera is back within 3
hours, and the email says it was late. Each set time is photographed and emailed once, even if the
camera retries the upload.

### Set it up

1. Set the environment variables below (in `.env.local` for local use, in Vercel for the deployed
   site) and flash firmware 2.0.
2. **Settings → Daily email report**, sign in with `ADMIN_PASSWORD`, then three steps in order:
   1. **Camera WiFi**, over Bluetooth, near the camera (2.4 GHz WiFi only). Skipped when the
      server already hears from the camera. The step is done when the camera checks in.
   2. **Email recipients**, up to 20. **Send test email** checks Gmail and the spam folders.
   3. **When**: **Every day** or some days, and the time (in this device's time zone). **Start
      daily report** also copies this browser's leaf colours, thresholds and ESP32-CAM baseline
      to the server; **Copy again** appears when they change.
3. **Take test photo now** runs the whole chain within about a minute.

The photo uses the frame size and LED level last set on the Analyze page; set them once for the
light at that hour. Without an ESP32-CAM baseline the status is "Unknown" (the numbers are still
sent). The camera needs a steady 5 V 2 A supply: WiFi bursts reset it on weak ones.

Local testing: run `npm run dev -- -H 0.0.0.0` (plain HTTP, which the camera can reach), open
`http://localhost:3000/settings` in Chrome on the computer (Web Bluetooth works on localhost) and,
in step 1 under **Advanced**, set the server to `http://<this computer's LAN IP>:3000`.

### Environment variables

| Variable | Purpose |
|---|---|
| `ADMIN_PASSWORD` | Protects the Daily email report card (recipients, schedule, test buttons) |
| `DEVICE_API_KEY` | A long random string; the camera sends it with every request (set during WiFi setup) |
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | The Gmail account that sends the reports, and an [App Password](https://myaccount.google.com/apppasswords) for it (needs 2-step verification) |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Upstash Redis (Vercel → Storage → Upstash Redis adds them; `UPSTASH_REDIS_REST_*` also work) |

Without the Redis variables the server keeps its state in `.data/automation.json` (local
development and tests). Without the Gmail variables, development saves each email as a `.eml` file
in `.data/emails/`; production reports the error on the card.

Code: `lib/automation/` (schedule, report and email content, shared types), `lib/server/` (storage,
auth, Gmail), `app/api/device/*` (the camera), `app/api/automation/*` (the Settings card),
`components/settings/daily-report.tsx`. Tests: `tests/automation-*.test.ts`, `tests/device-api.test.ts`.

## Tests

```bash
npm test             # unit tests and pipeline tests on synthetic photos
npm run fixtures     # regenerate test-images/synthetic/*.jpg with known answers (manifest.json)
```

The synthetic tests check: leaf pixel count within 3% of the truth, identical results on
re-analysis, the same cover % at any camera resolution, colour-cast and exposure correction from
the backdrop, rejection of blurry/dark/bright photos, and processing time (< 2 s).

## Not included (from plan.md)

Accounts, database, plant history and charts, alert rules and reminders (the daily email report
above sends every result, not only problems), QR labels
and the printed marker card (cm² measurement). The detection rules that need history
(confirmation retake, rolling baseline, midday rule) are therefore not implemented; the
baseline comparison above is the browser-only subset.

# Plan: Automatic daily plant analysis + email report

## Context

The client wants the ESP32-CAM to photograph the plant automatically (for example every day at 7:00), analyze it, and email the results to several people. The only things set by hand are which days and what time it runs, and the list of email addresses.

**Is it possible?** Yes, but the camera can't be reached as it works today:
- The firmware (`firmware/esp32-cam/esp32-cam.ino`, v1.1.0) only talks Bluetooth, and only to an open browser tab (`lib/ble/esp32-camera.ts`).
- Settings, thresholds and the baseline are kept only in the browser (`lib/browser/store.ts`).
- The app stores nothing on the server, and it has no scheduler or email code.

The good part is that the analysis already runs on the server (`runPipeline` in `lib/vision/node.ts`), so a scheduled run can reuse it unchanged.

**Decisions (from the user):**
- The ESP32 gets WiFi.
- The app is hosted on Vercel (project `wpdv1` is already linked).
- Email goes through Gmail with an App Password (Nodemailer).
- Setup is done once, in this order, on the Settings page (Step 6):
  1. **WiFi**: connect the camera to WiFi. Skipped if the camera is already on WiFi.
  2. **Email**: the addresses the results are sent to.
  3. **Time**: the days and the time the camera takes the photo, analyzes it and emails the results.

## How it will work

```
ESP32-CAM (WiFi) --every 60 s--> GET  /api/device/config     "anything to do?"
                 <-------------- poll=60 / capture=<slot-id>  (only when a scheduled time is due)
ESP32-CAM -- JPEG -------------> POST /api/device/captures   (X-Slot: <slot-id>)
                                   -> crop guide square -> runPipeline -> status vs baseline
                                   -> Gmail email to all recipients (photo + overlay attached)
                                   -> save a short report summary (shown on the Settings page)
```

**The server holds all the logic.** The ESP32 needs no clock, time zone or schedule; it just polls and does what the server says:
- Changing the days, time or recipients takes effect on the next poll, with nothing to reflash.
- The photo is taken within about a minute of the set time (7:00–7:01).
- If the camera was offline at 7:00 and comes back within 3 hours, it still takes the photo, and the email says it was late.
- A "Take test photo now" button works the same way, through the poll.

---

## Step 0: save this plan

Copy this plan to `newplan.md` in the project root, as the user asked.

## Step 1: server storage (`lib/server/kv.ts`)

Add a small key-value helper (`get`, `set`, `setIfAbsent`, `del`, optional TTL) with two backends:
- **Upstash Redis** (`@upstash/redis`) when `KV_REST_API_URL`/`KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_*`) are set. Connect it in the Vercel dashboard under Storage → Upstash Redis; the free tier is enough. A 60 s poll uses about 130k commands a month, under the 500k free limit.
- **A JSON file at `.data/automation.json`** otherwise, for local dev and tests. `.gitignore` already ignores `/.data/`.

Keys:
- `automation:config` (every part is optional until its setup step is saved):
  - `{ schedule: { enabled, days: 0–6[], time: "HH:MM", timeZone }`
  - `recipients: string[]`
  - `analysis: { vision, thresholds, baselineCoverPcts: number[], copiedAt }`
  - `captureNow?: slotId }`
- `automation:device`: `{ lastSeenAt, firmware, ip, rssi, freeHeap }`
- `automation:report:<slotId>`: summary with a 30-day TTL. `automation:last-report` holds the latest slot id.

## Step 2: schedule logic (`lib/automation/schedule.ts`, pure)

- A zod `scheduleSchema`: `days` are 0 = Sun … 6 = Sat, `time` is `HH:MM` (default `07:00`), and `timeZone` is an IANA name.
- A zod `recipientsSchema`: 1–20 unique, trimmed, lowercased emails.
- `zonedToUtc(dateParts, time, timeZone)` uses `Intl.DateTimeFormat` offsets with no extra library, and handles DST.
- `dueSlot(schedule, now, isDone)` returns the latest scheduled time that is ≤ now, at most `LATE_LIMIT_MS` (3 h) ago and not yet done. Slot id: `sched-<UTC ISO>`.
- `nextRunAt(schedule, now)` is used for the "Next photo: Tue 29 Oct, 7:00" display.

## Step 3: report + email

**`lib/automation/report.ts`** (pure):
- `buildReport(analysis, { thresholds, baselineCoverPcts })` returns `{ status, wilt, coverPct, discolorationPct, baselinePct, issues, valid }`.
- It reuses `calibrationBaseline` (`lib/detection/baseline.ts`) and `wiltIndex`, `statusFromIndex`, `hasDiscoloration`, `STATUS_LABELS` (`lib/detection/status.ts`).
- It follows the same validity rule as `result-view.tsx:45`: any issue means status `unknown`. The tilt check is phone-only and is skipped.

**`renderReportEmail(report, { takenAt, timeZone, late })`** returns `{ subject, html, text }`:
- Subject example: `Plant report · Tue 29 Oct 2026, 7:00 · Mild Wilting`.
- HTML uses inline styles, with status colours matching `components/status-badge.tsx`.
- It shows the wilting index, leaf cover, discoloration and baseline, plus any photo problems ("too dark: status not computed").
- The photo and overlay are inline (`cid:`) images.
- All text is HTML-escaped.

**`lib/server/email.ts`:**
- A Nodemailer Gmail transport (`GMAIL_USER`, `GMAIL_APP_PASSWORD`).
- `sendEmail({ to: string[], subject, html, text, attachments })` sends one message with all recipients in **To**.
- Add the `nodemailer` and `@types/nodemailer` dependencies.

## Step 4: crop the guide square on the server (`lib/vision/node.ts`)

Add `cropGuideSquare(input: Buffer): Promise<Buffer>`:
- Steps: sharp `autoOrient` → `guideRect(w, h)` (`lib/vision/guide.ts`) → `extract` → `resize` to `SQUARE_PX` → JPEG.
- It is the server version of `fileToSquare` in `lib/browser/image.ts:42`, so the numbers match what the browser ESP32 flow analyzes (and the baseline taken that way).
- The automatic run then calls `runPipeline(cropped, { settings, roi: null, maxLongEdge: SQUARE_PX })`.

## Step 5: API routes (Node runtime; every GET reads request headers, so none is prerendered with `cacheComponents`)

Before writing these, read `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`, `.../03-api-reference/03-file-conventions/route.md`, `.../02-route-segment-config/maxDuration.md` and `.../02-guides/environment-variables.md`.

**`lib/server/auth.ts`:**
- `requireDevice(request)`: `Authorization: Bearer <DEVICE_API_KEY>`, checked with `timingSafeEqual`.
- `requireAdmin(request)`: an httpOnly `plant_admin` cookie holding `HMAC-SHA256(ADMIN_PASSWORD, "plant-admin")`.

This protection matters: without it, anyone with the URL could change the recipients and send email from the client's Gmail.

| Route | Who | What |
|---|---|---|
| `app/api/device/config/route.ts` `GET` | device | Saves `automation:device` (`?fw=&ip=&rssi=&heap=`). The first save is what marks setup step 1 (WiFi) as done. Replies in `text/plain`: `poll=60` and, when a slot is due or `captureNow` is set, `capture=<slotId>`. |
| `app/api/device/captures/route.ts` `POST` | device | Raw `image/jpeg` body (≤ 4 MB, Vercel's limit is 4.5 MB) with an `X-Slot` header. Checks the slot is due or pending, then `setIfAbsent(report:<slot>)`; a duplicate retry answers `duplicate` and sends no second email. Then `cropGuideSquare` → `runPipeline` → `buildReport` → `sendEmail`, and stores the summary (with `emailError` if Gmail failed). If processing fails it releases the lock and returns 500 so the device retries. `export const maxDuration = 60`. |
| `app/api/automation/route.ts` `GET` / `PUT` | admin | `GET` returns config, `nextRunAt`, the device record (last seen, IP, RSSI, firmware), last report, and `DEVICE_API_KEY` (for WiFi setup). The card works out which setup step is next from this. `PUT` takes a partial body, `{ recipients }` (step 2) or `{ schedule, analysis }` (step 3), validates each part with zod and merges it into the stored config. Turning the schedule on with no recipients saved returns 400 ("Add at least one email first"). |
| `app/api/automation/session/route.ts` `POST` | anyone | Checks the password and sets the admin cookie (secure, sameSite strict, 30 days). |
| `app/api/automation/test/route.ts` `POST` | admin | `{ kind: "email" }` sends a sample email to the recipients. `{ kind: "capture" }` sets `captureNow = manual-<ms>`. |

## Step 6: Settings page, "Daily email report" card (guided setup)

Add `components/settings/daily-report.tsx` and render it from `app/settings/page.tsx` above `SettingsEditor`. Update the header text: thresholds stay in this browser, but the daily report is saved on the server.

The card first asks for the admin password, until signed in. It then walks through three numbered steps, in this order:
- A step opens only after the one before it is done.
- A finished step collapses to a one-line summary with a **Change** button.
- On page load the card opens at the first step that isn't done yet.

**Step 1: Camera WiFi (skipped if the camera already has WiFi)**
- It counts as done once the server has heard from the camera (`automation:device.lastSeenAt` exists). The summary then reads "✓ Camera on WiFi · last seen 40 s ago · IP 192.168.1.23", and the card goes straight to step 2. **Change WiFi** reopens the form, for a new router or a new location.
- If it isn't done, the card shows **Connect camera**, which uses Bluetooth through the existing `esp32Camera` singleton (`pick()` / `connect()`). It reads Info, and if the camera says it is already on WiFi (`DeviceInfo.wifi`), it skips the WiFi fields and only sends the server address and key.
- If WiFi isn't set, it asks for the WiFi name and password and shows a note: "2.4 GHz WiFi only".
- The server address is prefilled with `window.location.origin`. It can be edited under **Advanced**, for local testing over `http://`.
- **Save WiFi** sends the WiFi name, password, server address and device key. Errors reported by the firmware ("wrong password", "network not found", "timeout") are shown in the step.
- When the camera answers "Connected, IP …", the card polls `GET /api/automation` every 5 s with "Waiting for the camera to check in…" until `lastSeenAt` appears. The firmware polls right after it joins WiFi, so this takes a few seconds.
- If the camera hasn't checked in after 2 minutes, the card lists the likely causes: a wrong server address, a server the camera's network can't reach, or a wrong key.

**Step 2: Email recipients**
- Addresses go one per line or comma-separated. They are validated with `recipientsSchema`, up to 20.
- **Save emails** saves only the recipients (`PUT { recipients }`).
- Once saved, **Send test email** sends a sample report to everyone on the list, so they can check that it didn't land in spam.
- The step is done when at least one recipient is saved.

**Step 3: When to take the photo and send the results**
- An **Every day** option above the Mon–Sun day toggles, on by default:
  - Turning it on selects all 7 days. Turning it off clears them so specific days can be picked.
  - Turning off any single day turns **Every day** off, and selecting all 7 turns it back on.
  - It is shown on the card only and saved as `days: [0…6]`, so `scheduleSchema` doesn't change.
  - Turning it off with no day picked disables **Start daily report** ("Pick at least one day").
- A time input (default 07:00). The time zone is detected from the browser and shown, for example "Asia/Manila".
- **Start daily report** saves the schedule with `enabled: true` (`PUT { schedule, analysis }`). It also copies this browser's `visionSettingsStore`, `thresholdStore` and ESP32 baseline (`baselineStores.esp32` cover %) into `analysis`.
- If there is no ESP32 baseline yet, it warns that the status will show "unknown" until one is taken. The numbers are still sent.
- A note says "Analysis settings copied from this browser on …". If the browser's settings have changed since, it shows **Copy again**.

**After setup**, the card shows:
- An **On/off** switch, to pause the daily report without losing the settings.
- A status line, for example "Camera online · last seen 40 s ago · Every day at 7:00 · Next photo Tue 29 Oct, 7:00 · Last report Mon 7:00 Healthy (sent to 3)". It says "Mon, Wed, Fri at 7:00" when only some days are picked. It shows the error instead when the camera has been offline for more than 5 minutes or the last email failed.
- **Take test photo now**, which runs the whole chain (photo → analysis → email) within about a minute.

Reuse the existing `Card`, `Button`, `Input`, `Label`, `Switch` and `sonner` toast patterns from `settings-editor.tsx`, and `formatDateTime`/`formatPct` from `lib/format.ts`.

## Step 7: Bluetooth client for WiFi setup

**`lib/ble/protocol.ts`:**
- Add the commands `wifiSsid(s)` → `wifi-ssid:<s>`, `wifiPass(p)` → `wifi-pass:<p>`, `server(url)`, `key(k)`, `wifiConnect()` → `wifi:connect`, `wifiForget()`.
- Add a `connecting` state to `DeviceStatus`/`parseStatus`.
- Add `wifi`, `ip` and `server` to `DeviceInfo`/`parseInfo`.

**`lib/ble/esp32-camera.ts`:**
- Add `setupWifi({ ssid?, password?, server, key })`. It uses `exclusive()` + `request(…, "status")` like `configure()` (line 299) and allows a 20 s timeout on `wifi:connect`. It then re-reads Info and returns `{ ip }`, or throws with the firmware's `error:<reason>` message.
- With no `ssid`, it sends only `server` and `key`. This is for a camera that is already on WiFi (step 1 of the card).

## Step 8: firmware v2.0.0 (`firmware/esp32-cam/esp32-cam.ino`)

**Unchanged:** BLE keeps working as now, so manual capture and live preview in the Analyze page stay as they are.

**Additions:**
- Enlarge `Command.text` from 48 to 200 characters.
- New commands in `handleCommand`: `wifi-ssid:`, `wifi-pass:`, `server:`, `key:` (each saved in `Preferences`), `wifi:connect` and `wifi:forget`. `updateInfo()` adds `wifi`, `ip`, `rssi` and `server` (whether one is set).
- `wifi:connect` waits up to 15 s. It answers `ready` once the camera has an IP, or `error:wrong password` / `error:network not found` / `error:timeout`, mapped from the disconnect reason.
- On boot, if the WiFi credentials are saved, connect (`WiFi.setAutoReconnect(true)`).
- Poll the server right after WiFi connects, without waiting the first 60 s, so step 1 of the card confirms within seconds.

**Work in `loop()`:** it runs one thing at a time, so BLE commands and WiFi uploads never use the camera at once. Every `poll` seconds:
- It does an HTTP(S) `GET {server}/api/device/config?fw=…&ip=…&rssi=…&heap=…` with `Authorization: Bearer key`, and parses the `key=value` lines.
- On `capture=<slot>`, it calls the existing `takePhoto(FRAMES[frameIndex].size, false)`. The frame size and LED are the ones already set over BLE.
- It then POSTs the JPEG with `X-Slot`, making up to 3 attempts 20 s apart.

**HTTPS and reconnecting:**
- It uses `NetworkClientSecure` with the core's built-in root CA bundle for `https://`, and a plain client for `http://` (local testing).
- After 30 min without a successful poll it calls `ESP.restart()`.

**Memory check first (risk noted in `plan.md` §11.1):**
- Log `ESP.getFreeHeap()` and `heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)` before and after the first TLS handshake, with BLE running.
- If TLS fails for lack of memory, fall back to a **BLE setup window**: BLE runs only for the first 5 minutes after power-on (or while WiFi is not set up), then `BLEDevice::deinit()` before WiFi work.

Bump `FIRMWARE_VERSION` and update the header comment and README flashing notes.

## Step 9 (optional): "no photo today" alert

Add `app/api/cron/watchdog/route.ts`, protected by `Authorization: Bearer CRON_SECRET` (Vercel sends this), plus a `vercel.json` cron that runs once a day (the Hobby plan allows one run a day, ±1 h). If today was a scheduled day and no report exists for it, it emails "No photo received today, check the camera's power and WiFi."

## Environment variables (set in Vercel and in `.env.local`)

| Variable | Purpose |
|---|---|
| `GMAIL_USER`, `GMAIL_APP_PASSWORD` | Send the emails |
| `ADMIN_PASSWORD` | Protects the Settings card |
| `DEVICE_API_KEY` | A long random string the camera sends with each request |
| `KV_REST_API_URL`, `KV_REST_API_TOKEN` | Added automatically by the Upstash integration |
| `CRON_SECRET` | Only needed for Step 9 |

Document them in the README, with names only and no values.

## Tests (Vitest, `tests/`)

- `automation-schedule.test.ts`:
  - The selected days only.
  - The `Asia/Manila` time zone, and a DST zone (`America/New_York`, both transition days).
  - The 3 h late limit, a slot that is already done, a disabled or empty schedule, and `nextRunAt` across a week.
- `automation-report.test.ts`:
  - Status and wilting index against the baseline, and no baseline → unknown.
  - Photo issues → unknown with the message included.
  - The email contains the numbers and escapes HTML.
- `vision-units.test.ts`: `cropGuideSquare` gives 1000×1000 and matches `guideRect` on a synthetic image with a marked centre.
- `device-api.test.ts`:
  - Calls the route handlers directly with the file KV in a temp dir, and `vi.mock("@/lib/server/email")`.
  - A wrong key → 401.
  - Config returns `capture=` only when a slot is due.
  - Upload → report stored and email sent once; the same slot again → `duplicate` with no second email.
  - A failed pipeline releases the lock.
  - The first config poll creates the device record, which marks step 1 as done in `GET /api/automation`.
  - `PUT { recipients }` keeps the saved schedule, and the reverse.
  - Turning the schedule on with no recipients → 400.
- `ble-protocol.test.ts`: the new command strings, the parsing of the new Info fields, and the `error:wrong password` status.

## Verification

1. Run `npm test` and `npm run lint`.
2. Firmware: flash v2 on COM10 with the bundled arduino-cli (FQBN `esp32:esp32:esp32cam`), and keep the serial monitor open.
3. Run locally:
   - Fill in `.env.local` without the KV variables, so the `.data/` file is used.
   - Run `npm run dev -- -H 0.0.0.0`. This is plain HTTP, so the camera can reach it. Web Bluetooth still works in the PC's Chrome on `http://localhost:3000`, because localhost counts as a secure context.
   - Open the Settings page and sign in. The card opens at step 1.
4. Step 1 (WiFi):
   - Connect the camera over Bluetooth, enter the WiFi name and password, and under **Advanced** set the server to `http://<PC-LAN-IP>:3000`.
   - "Waiting for the camera to check in…" turns into ✓ within seconds, and the serial monitor shows polls and heap numbers.
   - A wrong password shows "wrong password" in the step.
   - Reload the page: step 1 shows as done and the card opens at step 2.
5. Step 2 (Email): add 2 recipients and click **Send test email**. Both must receive it.
6. Step 3 (Time): set today, 2 minutes from now, and click **Start daily report**.
   - The photo and email arrive automatically, with the status, numbers, photo and overlay.
   - The card shows the last report and the next run.
   - **Take test photo now** also delivers within about a minute.
7. Pull the camera's power past the set time, then restore it within 3 h. The late photo is taken and the email says it was late.
8. Deploy to Vercel:
   - Add Upstash Redis and the environment variables, then run `vercel deploy`.
   - On the production Settings page, step 1 is not done yet (new storage). The camera already has WiFi, so **Connect camera** only sends the production `https://` address and key. This checks TLS and memory.
   - Repeat steps 5–6.

## Notes for the client

- The camera needs 2.4 GHz WiFi at the plant (it can't join 5 GHz-only networks) and a steady 5 V 2 A power supply, because WiFi bursts cause brownout resets on weak supplies.
- Setup is three steps on the Settings page: WiFi → Email → Time. Bluetooth is only needed for step 1, so do that step on a phone or laptop near the camera.
- Gmail allows about 500 emails a day, far more than needed.
- The 7:00 photo uses the LED level and frame size last set in the Analyze page. Set them once for the morning light.
- The status needs an ESP32 baseline: 3 healthy photos taken in the Analyze page, then **Save** or **Copy again** on the card.

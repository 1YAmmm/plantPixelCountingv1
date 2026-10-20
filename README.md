# Plant Pixel Counter

Measures how much of a guide square a plant's leaves cover by counting green pixels, and compares
it with the plant's own healthy baseline to detect wilting. Built from `plan.md` (§5–§6), trimmed
to the UI and the pixel counting: **no login, no database, no printed marker**.

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

## Using it

1. Put the plant on a plain white or light-gray backdrop, in even light.
2. **Analyze** page → the camera shows a **square** with a dashed **circle**:
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
5. **Settings** → the colour range counted as leaf and the wilting thresholds, with a live
   preview. Everything else is under **Advanced settings**.

Settings and baseline samples are kept in the browser's localStorage. Export/Import (under
Advanced settings) moves settings between devices.

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

## Tests

```bash
npm test             # unit tests and pipeline tests on synthetic photos
npm run fixtures     # regenerate test-images/synthetic/*.jpg with known answers (manifest.json)
```

The synthetic tests check: leaf pixel count within 3% of the truth, identical results on
re-analysis, the same cover % at any camera resolution, colour-cast and exposure correction from
the backdrop, rejection of blurry/dark/bright photos, and processing time (< 2 s).

## Not included (from plan.md)

Accounts, database, plant history and charts, email alerts, reminders, ESP32 capture, QR labels
and the printed marker card (cm² measurement). The detection rules that need history
(confirmation retake, rolling baseline, midday rule) are therefore not implemented; the
baseline comparison above is the browser-only subset.

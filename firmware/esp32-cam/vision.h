// The leaf analysis of lib/vision, ported for the camera: white balance from the backdrop, HSV
// classification, mask cleanup, plant region, leaf cover, discoloration, brightness and
// sharpness, and the picture for the report (the measured square beside its mask).
// It runs on the photo's guide square shrunk to VISION_SQUARE_PX (lib/vision/guide.ts
// CAMERA_SQUARE_PX) with lib/vision/settings.ts CAMERA_VISION_SETTINGS; keep them in sync
// (tests/camera-vision.test.ts checks the numbers in vision.cpp).

#pragma once

#include <stddef.h>
#include <stdint.h>

#define VISION_SQUARE_PX 500

/** Photo problems (lib/vision/quality.ts): any of them makes the numbers unreliable. */
enum : uint8_t { VISION_TOO_DARK = 1, VISION_TOO_BRIGHT = 2, VISION_BLURRY = 4 };

struct VisionResult {
  int size;                // side of the analyzed square, px
  float coverPct;          // leaf pixels, % of the guide square
  float discolorationPct;  // yellow/brown pixels inside the plant region, % of the plant
  float brightnessPct;
  float sharpness;
  uint8_t issues;  // VISION_* bits
  uint32_t leafPixels;
  uint32_t stressedPixels;
  uint32_t blobCount;  // leaf blobs after the morphology
  uint32_t keptBlobs;  // the main plant and the blobs near it
  bool whiteBalanced;
  float gains[3];
  float reference[3];  // mean R, G, B of the backdrop before the correction
  uint32_t decodeMs;
  uint32_t analyzeMs;
  uint32_t pictureMs;
};

/**
 * Decode a JPEG photo, shrink its guide square to VISION_SQUARE_PX and analyze it. Needs about
 * 2.8 MB of PSRAM. With `picture`, also returns the square and beside it its mask (leaves green,
 * yellow/brown orange) as a JPEG in PSRAM for heap_caps_free(), or nullptr if that failed.
 * Returns nullptr, or why it could not analyze.
 */
const char *analyzeJpeg(const uint8_t *jpeg, size_t len, VisionResult &out, uint8_t **picture = nullptr, size_t *pictureLen = nullptr);

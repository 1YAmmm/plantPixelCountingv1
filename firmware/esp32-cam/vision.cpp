// lib/vision ported to C++: see vision.h. Each step names the TypeScript it follows.
//
// No libm, qsort or printf("%f") here: with the PSRAM cache workaround the C library's math,
// sorting and number functions are linked into the nearly full IRAM (see esp32-cam.ino). Where
// the TypeScript rounds or takes a square root, this uses integer math or its own square root.
// Everything big lives in PSRAM; the JPEG decoder is the one in the ESP32's ROM.

#include "vision.h"

#include <string.h>
#include "esp32/rom/tjpgd.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "jpeg.h"

// ---- Settings: lib/vision/settings.ts CAMERA_VISION_SETTINGS and lib/vision/guide.ts ----

struct HsvRule {
  float hueMin, hueMax, satMin, valMin;
};

static const HsvRule LEAF = {70, 170, 16, 16};
static const HsvRule STRESSED = {20, 65, 25, 15};
static const float WB_MAX_SATURATION = 35;
static const float WB_MIN_VALUE = 25;
static const float WB_TARGET_GRAY = 230;  // normalizeExposure: true
static const int OPEN_SIZE = 3;
static const int CLOSE_SIZE = 3;
static const int STRESSED_OPEN_SIZE = 3;
static const double MIN_BLOB_PCT = 0.1;
static const double MERGE_DISTANCE_PCT = 5;
static const float MIN_BRIGHTNESS = 20;
static const float MAX_BRIGHTNESS = 90;
static const float MIN_SHARPNESS = 25;
static const double GUIDE_FRACTION = 0.8;

// lib/vision/white-balance.ts. Doubles where the TypeScript compares a pixel count with them.
static const double BRIGHT_SHARE = 0.2;
static const double MIN_REFERENCE_SHARE = 0.02;

static const size_t DECODER_POOL = 6144;  // tjpgd's tables and MCU buffers (about 3.7 KB for 4:2:0)

static void *psram(size_t size) {
  return heap_caps_malloc(size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
}

static uint32_t nowMs() {
  return (uint32_t)(esp_timer_get_time() / 1000);
}

/** Math.round for x ≥ 0. */
static inline int roundPos(double x) {
  return (int)(x + 0.5);
}

/** √x for x ≥ 0 to float precision: Newton's method on 1/√x, so no division and no libm. */
static float squareRoot(float x) {
  if (x <= 0) return 0;
  uint32_t bits;
  memcpy(&bits, &x, 4);
  bits = 0x5f3759df - (bits >> 1);
  float y;
  memcpy(&y, &bits, 4);
  for (int i = 0; i < 3; i++) y *= 1.5f - 0.5f * x * y * y;
  return x * y;
}

/** Rec. 601 luma × 1000, exact. */
static inline int32_t luma1000(const uint8_t *p) {
  return 299 * p[0] + 587 * p[1] + 114 * p[2];
}

// ---- Step 1: decode and crop (lib/vision/node.ts cameraSquare) ----

struct Decoder {
  const uint8_t *src;
  size_t len;
  size_t pos;
  int left, top, side, n;
  uint16_t *sums;  // n × n × 3: the photo pixels of each cell added up
};

static UINT readJpeg(JDEC *jd, BYTE *buf, UINT len) {
  Decoder *d = (Decoder *)jd->device;
  if (len > d->len - d->pos) len = d->len - d->pos;
  if (buf) memcpy(buf, d->src + d->pos, len);
  d->pos += len;
  return len;
}

/** Called for each decoded block (RGB888): add its pixels inside the guide square to their cell. */
static UINT addBlock(JDEC *jd, void *bitmap, JRECT *rect) {
  Decoder *d = (Decoder *)jd->device;
  const uint8_t *p = (const uint8_t *)bitmap;
  int w = rect->right - rect->left + 1;
  for (int y = rect->top; y <= rect->bottom; y++, p += w * 3) {
    int sy = y - d->top;
    if (sy < 0 || sy >= d->side) continue;
    uint16_t *row = d->sums + (size_t)(sy * d->n / d->side) * d->n * 3;
    const uint8_t *q = p;
    for (int x = rect->left; x <= rect->right; x++, q += 3) {
      int sx = x - d->left;
      if (sx < 0 || sx >= d->side) continue;
      uint16_t *s = row + (sx * d->n / d->side) * 3;
      s[0] += q[0];
      s[1] += q[1];
      s[2] += q[2];
    }
  }
  return 1;
}

/**
 * Decode `jpeg` into a new n × n × 6 byte buffer whose first n × n × 3 bytes are the guide square
 * as RGB (the rest is free for the masks). Returns nullptr, or why it failed.
 */
static const char *decodeSquare(const uint8_t *jpeg, size_t len, uint8_t *&buf, int &n) {
  JDEC jd;
  Decoder d = {jpeg, len, 0, 0, 0, 0, 0, nullptr};
  void *pool = heap_caps_malloc(DECODER_POOL, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  if (!pool) pool = psram(DECODER_POOL);
  if (!pool) return "out of memory";
  JRESULT res = jd_prepare(&jd, readJpeg, pool, DECODER_POOL, &d);
  if (res != JDR_OK) {
    heap_caps_free(pool);
    return res == JDR_MEM1 || res == JDR_MEM2 ? "the JPEG needs more decoder memory" : "the photo is not a JPEG the camera can read";
  }
  // guideBox() in lib/vision/guide.ts, with the same double arithmetic.
  int w = jd.width, h = jd.height;
  double side = (w < h ? w : h) * GUIDE_FRACTION;
  d.side = (int)(side / w * w);
  if (d.side > w) d.side = w;
  if (d.side > h) d.side = h;
  if (d.side < 1) d.side = 1;
  d.left = roundPos((w - side) / 2 / w * w);
  d.top = roundPos((h - side) / 2 / h * h);
  if (d.left > w - d.side) d.left = w - d.side;
  if (d.top > h - d.side) d.top = h - d.side;
  n = d.side < VISION_SQUARE_PX ? d.side : VISION_SQUARE_PX;
  d.n = n;
  if (d.side > 16 * n) {  // a cell's sum would not fit 16 bits
    heap_caps_free(pool);
    return "the photo is too large";
  }

  size_t px = (size_t)n * n;
  buf = (uint8_t *)psram(px * 6);
  if (!buf) {
    heap_caps_free(pool);
    return "out of memory";
  }
  memset(buf, 0, px * 6);
  d.sums = (uint16_t *)buf;
  res = jd_decomp(&jd, addBlock, 0);
  heap_caps_free(pool);
  if (res != JDR_OK) {
    heap_caps_free(buf);
    buf = nullptr;
    return "the photo could not be decoded";
  }

  // Photo pixels per grid row (and column); each cell's mean, rounded, written over the sums in
  // place (byte i reads bytes 2i and 2i + 1, which are not written yet).
  uint16_t *cells = (uint16_t *)psram(n * sizeof(uint16_t));
  if (!cells) {
    heap_caps_free(buf);
    buf = nullptr;
    return "out of memory";
  }
  memset(cells, 0, n * sizeof(uint16_t));
  for (int s = 0; s < d.side; s++) cells[s * n / d.side]++;
  const uint16_t *sums = d.sums;
  for (int ty = 0; ty < n; ty++) {
    for (int tx = 0; tx < n; tx++) {
      uint32_t count = (uint32_t)cells[ty] * cells[tx];
      size_t t = ((size_t)ty * n + tx) * 3;
      for (int k = 0; k < 3; k++) buf[t + k] = (uint8_t)((sums[t + k] + (count >> 1)) / count);
    }
  }
  heap_caps_free(cells);
  return nullptr;
}

// ---- Colour (lib/vision/color.ts) ----

struct Hsv {
  float h, s, v;
};

static inline void rgbToHsv(float r, float g, float b, Hsv &o) {
  float max = r > g ? (r > b ? r : b) : g > b ? g : b;
  float min = r < g ? (r < b ? r : b) : g < b ? g : b;
  float delta = max - min;
  o.v = max / 255 * 100;
  o.s = max == 0 ? 0 : delta / max * 100;
  if (delta == 0) {
    o.h = 0;
  } else if (max == r) {
    float t = (g - b) / delta;  // ((t + 6) % 6) for t in [-1, 1]
    o.h = 60 * (t < 0 ? t + 6 : t);
  } else if (max == g) {
    o.h = 60 * ((b - r) / delta + 2);
  } else {
    o.h = 60 * ((r - g) / delta + 4);
  }
}

static inline bool matches(const Hsv &c, const HsvRule &rule) {
  bool hue = rule.hueMin <= rule.hueMax ? c.h >= rule.hueMin && c.h <= rule.hueMax : c.h >= rule.hueMin || c.h <= rule.hueMax;
  return c.s >= rule.satMin && c.v >= rule.valMin && hue;
}

// ---- Step 2: white balance (lib/vision/white-balance.ts) ----

static void whiteBalance(const uint8_t *rgb, size_t px, VisionResult &out) {
  out.gains[0] = out.gains[1] = out.gains[2] = 1;
  uint32_t bins[256] = {};
  for (size_t i = 0; i < px; i++) bins[(luma1000(rgb + i * 3) + 500) / 1000]++;
  int threshold = 255;
  for (uint32_t acc = 0; threshold > 0; threshold--) {
    acc += bins[threshold];
    if (acc >= px * BRIGHT_SHARE) break;
  }

  uint32_t r = 0, g = 0, b = 0, n = 0;
  Hsv c;
  for (size_t i = 0; i < px; i++) {
    const uint8_t *p = rgb + i * 3;
    if ((luma1000(p) + 500) / 1000 < threshold) continue;
    rgbToHsv(p[0], p[1], p[2], c);
    if (c.s > WB_MAX_SATURATION || c.v < WB_MIN_VALUE) continue;
    r += p[0];
    g += p[1];
    b += p[2];
    n++;
  }
  if (n < px * MIN_REFERENCE_SHARE) return;
  float mean[3] = {(float)r / n, (float)g / n, (float)b / n};
  for (int k = 0; k < 3; k++) {
    float gain = WB_TARGET_GRAY / (mean[k] > 1 ? mean[k] : 1);
    out.gains[k] = gain < 0.5f ? 0.5f : gain > 3 ? 3 : gain;
    out.reference[k] = mean[k];
  }
  out.whiteBalanced = true;
}

// ---- Step 3: classification (lib/vision/classify.ts), the whole square is the ROI ----

static void classify(const uint8_t *rgb, size_t px, const float gains[3], uint8_t *leaf, uint8_t *stressed) {
  Hsv c;
  for (size_t i = 0; i < px; i++) {
    const uint8_t *p = rgb + i * 3;
    float r = p[0] * gains[0], g = p[1] * gains[1], b = p[2] * gains[2];
    rgbToHsv(r < 255 ? r : 255, g < 255 ? g : 255, b < 255 ? b : 255, c);
    leaf[i] = matches(c, LEAF);
    stressed[i] = !leaf[i] && matches(c, STRESSED);
  }
}

// ---- Step 4: mask cleanup (lib/vision/cleanup.ts with image-js) ----

/**
 * Erode (AND) or dilate (OR) a 0/1 mask with a size × size square, in place. Like image-js,
 * pixels outside the image are left out of the window.
 */
static void morph(uint8_t *mask, uint8_t *tmp, int n, int size, bool dilate) {
  int r = size / 2;
  for (int y = 0; y < n; y++) {
    int y0 = y - r < 0 ? 0 : y - r, y1 = y + r >= n ? n - 1 : y + r;
    uint8_t *t = tmp + (size_t)y * n;
    memcpy(t, mask + (size_t)y0 * n, n);
    for (int yy = y0 + 1; yy <= y1; yy++) {
      const uint8_t *m = mask + (size_t)yy * n;
      if (dilate)
        for (int x = 0; x < n; x++) t[x] |= m[x];
      else
        for (int x = 0; x < n; x++) t[x] &= m[x];
    }
  }
  for (int y = 0; y < n; y++) {
    const uint8_t *t = tmp + (size_t)y * n;
    uint8_t *m = mask + (size_t)y * n;
    for (int x = 0; x < n; x++) {
      int x0 = x - r < 0 ? 0 : x - r, x1 = x + r >= n ? n - 1 : x + r;
      uint8_t v = t[x0];
      for (int xx = x0 + 1; xx <= x1; xx++) v = dilate ? v | t[xx] : v & t[xx];
      m[x] = v;
    }
  }
}

static void openMask(uint8_t *mask, uint8_t *tmp, int n, int size) {
  if (size <= 1) return;
  morph(mask, tmp, n, size, false);
  morph(mask, tmp, n, size, true);
}

static void closeMask(uint8_t *mask, uint8_t *tmp, int n, int size) {
  if (size <= 1) return;
  morph(mask, tmp, n, size, true);
  morph(mask, tmp, n, size, false);
}

struct Blob {
  uint32_t area;
  uint32_t seed;
  int minX, minY, maxX, maxY;
};

/** 8-connected flood fill from `seed`: pixels equal to `from` become `to`. `stack` holds n × n entries. */
static void floodFill(uint8_t *mask, int n, uint32_t seed, uint8_t from, uint8_t to, uint32_t *stack, Blob &b) {
  b = {0, seed, n, n, -1, -1};
  size_t top = 0;
  mask[seed] = to;
  stack[top++] = seed;
  while (top) {
    uint32_t i = stack[--top];
    int x = i % n, y = i / n;
    b.area++;
    if (x < b.minX) b.minX = x;
    if (x > b.maxX) b.maxX = x;
    if (y < b.minY) b.minY = y;
    if (y > b.maxY) b.maxY = y;
    for (int yy = y > 0 ? y - 1 : 0; yy <= y + 1 && yy < n; yy++) {
      for (int xx = x > 0 ? x - 1 : 0; xx <= x + 1 && xx < n; xx++) {
        uint32_t j = (uint32_t)yy * n + xx;
        if (mask[j] == from) {
          mask[j] = to;
          stack[top++] = j;
        }
      }
    }
  }
}

/** Squared gap between two blobs' boxes (lib/vision/geometry.ts rectGap, squared). */
static float gapSquared(const Blob &a, const Blob &b) {
  int dx = (a.minX > b.minX ? a.minX : b.minX) - ((a.maxX < b.maxX ? a.maxX : b.maxX) + 1);
  int dy = (a.minY > b.minY ? a.minY : b.minY) - ((a.maxY < b.maxY ? a.maxY : b.maxY) + 1);
  if (dx < 0) dx = 0;
  if (dy < 0) dy = 0;
  return (float)dx * dx + (float)dy * dy;
}

/**
 * cleanupLeafMask(): open, close, then keep the largest blob of at least MIN_BLOB_PCT of the
 * square and the blobs of that size within MERGE_DISTANCE_PCT of it; counts them into `blobs`
 * and `kept`. Returns false if out of memory.
 */
static bool cleanupMask(uint8_t *mask, uint8_t *tmp, int n, uint32_t *stack, uint32_t &blobs, uint32_t &kept) {
  openMask(mask, tmp, n, OPEN_SIZE);
  closeMask(mask, tmp, n, CLOSE_SIZE);

  size_t px = (size_t)n * n;
  double minArea = MIN_BLOB_PCT / 100 * px;
  size_t capacity = (size_t)(px / (minArea > 1 ? minArea : 1)) + 1;  // blobs that big that fit
  Blob *big = (Blob *)psram(capacity * sizeof(Blob));
  if (!big) return false;
  size_t bigCount = 0;
  Blob b;
  for (size_t i = 0; i < px; i++) {
    if (mask[i] != 1) continue;
    floodFill(mask, n, i, 1, 2, stack, b);
    blobs++;
    if (b.area >= minArea && bigCount < capacity) big[bigCount++] = b;
  }
  if (bigCount) {
    size_t main = 0;  // the first of the largest, like reduce() in the TypeScript
    for (size_t k = 1; k < bigCount; k++)
      if (big[k].area > big[main].area) main = k;
    float maxGap = (float)(MERGE_DISTANCE_PCT / 100 * n);
    for (size_t k = 0; k < bigCount; k++) {
      if (k != main && gapSquared(big[k], big[main]) > maxGap * maxGap) continue;
      floodFill(mask, n, big[k].seed, 2, 3, stack, b);
      kept++;
    }
  }
  heap_caps_free(big);
  for (size_t i = 0; i < px; i++) mask[i] = mask[i] == 3;
  return true;
}

// ---- Step 5: photo quality (lib/vision/quality.ts) ----

static float meanBrightness(const uint8_t *rgb, int n) {
  uint64_t sum = 0;
  uint32_t count = 0;
  for (int y = 0; y < n; y += 2) {
    for (int x = 0; x < n; x += 2) {
      sum += luma1000(rgb + ((size_t)y * n + x) * 3);
      count++;
    }
  }
  return count ? (float)((double)sum / count / 2550) : 0;
}

/** sharpnessScore() on a square under 640 px (so not downsampled), with `gray` holding n × n entries. */
static float sharpnessScore(const uint8_t *rgb, int n, int32_t *gray) {
  if (n < 3) return 0;
  size_t px = (size_t)n * n;
  uint32_t lumaBins[256] = {};
  for (size_t i = 0; i < px; i++) {
    gray[i] = luma1000(rgb + i * 3);
    lumaBins[(gray[i] + 500) / 1000]++;
  }
  auto percentile = [&](uint32_t pct) {  // the first luma with pct% of the pixels at or below it
    uint64_t acc = 0;
    for (int v = 0; v < 256; v++) {
      acc += lumaBins[v];
      if (acc * 100 >= (uint64_t)px * pct) return v;
    }
    return 255;
  };
  int contrast = percentile(99) - percentile(1);
  if (contrast < 20) contrast = 20;

  uint32_t *bins = (uint32_t *)psram(400 * sizeof(uint32_t));
  if (!bins) return 0;
  memset(bins, 0, 400 * sizeof(uint32_t));
  uint32_t total = 0;
  for (int y = 1; y < n - 1; y++) {
    for (int x = 1; x < n - 1; x++) {
      const int32_t *c = gray + (size_t)y * n + x;
      int32_t tl = c[-n - 1], t = c[-n], tr = c[-n + 1], l = c[-1], r = c[1], bl = c[n - 1], b = c[n], br = c[n + 1];
      float gx = (tr + 2 * r + br - tl - 2 * l - bl) * 0.001f;
      float gy = (bl + 2 * b + br - tl - 2 * t - tr) * 0.001f;
      int mag = (int)(squareRoot(gx * gx + gy * gy) / 4 + 0.5f);
      bins[mag < 399 ? mag : 399]++;
      total++;
    }
  }
  uint32_t take = (uint32_t)roundPos(total * 0.005);
  if (take < 1) take = 1;
  uint32_t taken = 0;
  uint64_t sum = 0;
  for (int m = 399; m >= 0 && taken < take; m--) {
    uint32_t k = bins[m] < take - taken ? bins[m] : take - taken;
    sum += (uint64_t)k * m;
    taken += k;
  }
  heap_caps_free(bins);
  return (float)(100.0 * sum / taken / contrast);
}

// ---- Step 6: the picture for the report: the measured square, and beside it its mask ----

static const uint8_t LEAF_COLOR[3] = {34, 197, 94};        // lib/vision/overlay.ts OVERLAY_COLORS
static const uint8_t STRESSED_COLOR[3] = {249, 115, 22};
static const uint8_t BACKGROUND_COLOR[3] = {18, 18, 18};
static const int PICTURE_QUALITY = 80;

struct PictureSource {
  const uint8_t *rgb, *leaf, *stressed;
  int n;
};

/** Left half: the photo. Right half: leaves green, yellow/brown parts of the plant orange, the rest dark. */
static void picturePixel(const void *ctx, int x, int y, uint8_t out[3]) {
  const PictureSource *s = (const PictureSource *)ctx;
  if (x < s->n) {
    memcpy(out, s->rgb + ((size_t)y * s->n + x) * 3, 3);
    return;
  }
  size_t i = (size_t)y * s->n + (x - s->n);
  memcpy(out, s->leaf[i] ? LEAF_COLOR : s->stressed[i] ? STRESSED_COLOR : BACKGROUND_COLOR, 3);
}

// ---- The pipeline (lib/vision/analyze.ts) ----

const char *analyzeJpeg(const uint8_t *jpeg, size_t len, VisionResult &out, uint8_t **picture, size_t *pictureLen) {
  memset(&out, 0, sizeof(out));
  if (picture) *picture = nullptr;
  if (pictureLen) *pictureLen = 0;
  uint32_t start = nowMs();
  uint8_t *buf = nullptr;
  int n = 0;
  const char *error = decodeSquare(jpeg, len, buf, n);
  if (error) return error;
  out.size = n;
  out.decodeMs = nowMs() - start;
  start = nowMs();

  size_t px = (size_t)n * n;
  uint8_t *rgb = buf;
  uint8_t *leaf = buf + 3 * px, *stressed = buf + 4 * px, *tmp = buf + 5 * px;
  uint32_t *scratch = (uint32_t *)psram(px * 4);  // the gray image for the sharpness, then the flood fill's stack
  if (!scratch) {
    heap_caps_free(buf);
    return "out of memory";
  }

  out.brightnessPct = meanBrightness(rgb, n);
  out.sharpness = sharpnessScore(rgb, n, (int32_t *)scratch);
  if (out.brightnessPct < MIN_BRIGHTNESS) out.issues |= VISION_TOO_DARK;
  else if (out.brightnessPct > MAX_BRIGHTNESS) out.issues |= VISION_TOO_BRIGHT;
  if (out.sharpness < MIN_SHARPNESS) out.issues |= VISION_BLURRY;

  whiteBalance(rgb, px, out);
  classify(rgb, px, out.gains, leaf, stressed);

  // Step 4: the leaves, cleaned up. Then the plant (lib/vision/cleanup.ts plantRegion): the green
  // and yellow/brown pixels together, cleaned up the same way, so a fully yellowed leaf is part
  // of it and a brown object away from it is not.
  uint8_t *plant = (uint8_t *)psram(px);
  uint32_t plantBlobs = 0, plantKept = 0;
  if (!plant) {
    error = "out of memory";
  } else {
    for (size_t i = 0; i < px; i++) plant[i] = leaf[i] | stressed[i];
    if (!cleanupMask(leaf, tmp, n, scratch, out.blobCount, out.keptBlobs) || !cleanupMask(plant, tmp, n, scratch, plantBlobs, plantKept)) {
      error = "out of memory";
    }
  }

  if (!error) {
    // Stressed pixels count only inside the plant and not where the leaf mask already is.
    openMask(stressed, tmp, n, STRESSED_OPEN_SIZE);
    for (size_t i = 0; i < px; i++) {
      stressed[i] = stressed[i] && plant[i] && !leaf[i];
      out.stressedPixels += stressed[i];
      out.leafPixels += leaf[i];
    }
    uint32_t plantPixels = out.leafPixels + out.stressedPixels;
    out.coverPct = (float)out.leafPixels / px * 100;
    out.discolorationPct = plantPixels ? (float)out.stressedPixels / plantPixels * 100 : 0;
  }
  heap_caps_free(plant);
  heap_caps_free(scratch);
  out.analyzeMs = nowMs() - start;

  if (!error && picture) {
    start = nowMs();
    PictureSource source = {rgb, leaf, stressed, n};
    size_t encoded = 0;
    *picture = encodeJpeg(2 * n, n, picturePixel, &source, PICTURE_QUALITY, encoded);
    if (pictureLen) *pictureLen = encoded;
    out.pictureMs = nowMs() - start;
  }
  heap_caps_free(buf);
  return error;
}

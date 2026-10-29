// A small baseline JPEG encoder (4:4:4, the standard tables of the JPEG spec's Annex K) for the
// report's picture, which it reads pixel by pixel so it never has to be in memory whole. After
// Jon Olick's public-domain jo_jpeg. The camera library has one (fmt2jpg), but its tables are
// static arrays that would hold about 8 KB of internal RAM for good, which the upload to Telegram
// needs; these tables are in flash, and the working ones in the heap only while encoding.
// No libm (see vision.cpp). tests/camera-vision.test.ts checks the tables.

#include "jpeg.h"

#include <string.h>
#include "esp_heap_caps.h"

// Natural (row-major) position in a block → zigzag position.
static const uint8_t ZIGZAG[64] = {
  0,  1,  5,  6,  14, 15, 27, 28, 2,  4,  7,  13, 16, 26, 29, 42, 3,  8,  12, 17, 25, 30, 41, 43, 9,  11, 18, 24, 31, 40, 44, 53,
  10, 19, 23, 32, 39, 45, 52, 54, 20, 22, 33, 38, 46, 51, 55, 60, 21, 34, 37, 47, 50, 56, 59, 61, 35, 36, 48, 49, 57, 58, 62, 63,
};

// Quantization tables at quality 50, natural order.
static const uint8_t LUMA_QUANT[64] = {
  16, 11, 10, 16, 24,  40,  51,  61,  12, 12, 14, 19, 26,  58,  60,  55,  14, 13, 16, 24, 40,  57,  69,  56,  14, 17, 22, 29, 51,  87,  80,  62,
  18, 22, 37, 56, 68,  109, 103, 77,  24, 35, 55, 64, 81,  104, 113, 92,  49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
};
static const uint8_t CHROMA_QUANT[64] = {
  17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 99,
};

// Huffman tables: how many codes of each length 1–16, then the symbols in code order.
static const uint8_t DC_LUMA_BITS[16] = {0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0};
static const uint8_t DC_CHROMA_BITS[16] = {0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0};
static const uint8_t DC_VALUES[12] = {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11};
static const uint8_t AC_LUMA_BITS[16] = {0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d};
static const uint8_t AC_LUMA_VALUES[162] = {
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1,
  0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26,
  0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56,
  0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85,
  0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa,
  0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6,
  0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9,
  0xfa,
};
static const uint8_t AC_CHROMA_BITS[16] = {0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77};
static const uint8_t AC_CHROMA_VALUES[162] = {
  0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42,
  0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19,
  0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55,
  0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83,
  0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8,
  0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4,
  0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9,
  0xfa,
};

// The AAN DCT's output scale per row and column: cos(kπ/16) × √2.
static const float AAN_SCALE[8] = {1.0f, 1.387039845f, 1.306562965f, 1.175875602f, 1.0f, 0.785694958f, 0.541196100f, 0.275899379f};

struct Code {
  uint16_t bits;
  uint8_t len;
};

struct Encoder {
  uint8_t *out;
  size_t cap, len;
  bool overflow;
  uint32_t bitBuf;
  int bitCount;
  uint8_t quant[2][64];  // zigzag order, as written to the file
  float scale[2][64];    // natural order: 1 / (quantizer × the DCT's scale)
  Code dc[2][12];
  Code ac[2][256];
};

static void putByte(Encoder &e, uint8_t b) {
  if (e.len < e.cap) e.out[e.len++] = b;
  else e.overflow = true;
}

static void putBytes(Encoder &e, const uint8_t *b, size_t n) {
  for (size_t i = 0; i < n; i++) putByte(e, b[i]);
}

static void putWord(Encoder &e, uint16_t w) {
  putByte(e, w >> 8);
  putByte(e, w & 255);
}

/** Canonical Huffman codes from the code lengths (spec Annex C). */
static void buildCodes(const uint8_t bits[16], const uint8_t *values, Code *codes) {
  uint16_t code = 0;
  int k = 0;
  for (int len = 1; len <= 16; len++) {
    for (int i = 0; i < bits[len - 1]; i++) codes[values[k++]] = {code++, (uint8_t)len};
    code <<= 1;
  }
}

/** Append `len` (≤ 16) bits, stuffing a 0 after each 0xFF byte. */
static void writeBits(Encoder &e, uint16_t bits, int len) {
  e.bitCount += len;
  e.bitBuf |= (uint32_t)bits << (24 - e.bitCount);
  while (e.bitCount >= 8) {
    uint8_t c = e.bitBuf >> 16 & 255;
    putByte(e, c);
    if (c == 255) putByte(e, 0);
    e.bitBuf <<= 8;
    e.bitCount -= 8;
  }
}

/** A coefficient's size category and its bits (negative values as one's complement). */
static void writeValue(Encoder &e, const Code *codes, int run, int v) {
  int a = v < 0 ? -v : v, size = 0;
  while (a) {
    size++;
    a >>= 1;
  }
  const Code &c = codes[run << 4 | size];
  writeBits(e, c.bits, c.len);
  writeBits(e, (v < 0 ? v - 1 : v) & ((1 << size) - 1), size);
}

/** One-dimensional AAN forward DCT on 8 values `stride` apart, in place. */
static void dct(float *d, int stride) {
  float d0 = d[0], d1 = d[stride], d2 = d[2 * stride], d3 = d[3 * stride];
  float d4 = d[4 * stride], d5 = d[5 * stride], d6 = d[6 * stride], d7 = d[7 * stride];
  float tmp0 = d0 + d7, tmp7 = d0 - d7, tmp1 = d1 + d6, tmp6 = d1 - d6;
  float tmp2 = d2 + d5, tmp5 = d2 - d5, tmp3 = d3 + d4, tmp4 = d3 - d4;

  float tmp10 = tmp0 + tmp3, tmp13 = tmp0 - tmp3, tmp11 = tmp1 + tmp2, tmp12 = tmp1 - tmp2;
  d[0] = tmp10 + tmp11;
  d[4 * stride] = tmp10 - tmp11;
  float z1 = (tmp12 + tmp13) * 0.707106781f;
  d[2 * stride] = tmp13 + z1;
  d[6 * stride] = tmp13 - z1;

  tmp10 = tmp4 + tmp5;
  tmp11 = tmp5 + tmp6;
  tmp12 = tmp6 + tmp7;
  float z5 = (tmp10 - tmp12) * 0.382683433f;
  float z2 = tmp10 * 0.541196100f + z5;
  float z4 = tmp12 * 1.306562965f + z5;
  float z3 = tmp11 * 0.707106781f;
  float z11 = tmp7 + z3, z13 = tmp7 - z3;
  d[5 * stride] = z13 + z2;
  d[3 * stride] = z13 - z2;
  d[stride] = z11 + z4;
  d[7 * stride] = z11 - z4;
}

/** Transform, quantize and write one 8 × 8 block; returns its DC value for the next block's difference. */
static int encodeBlock(Encoder &e, float *block, int table, int previousDc) {
  for (int row = 0; row < 64; row += 8) dct(block + row, 1);
  for (int col = 0; col < 8; col++) dct(block + col, 8);
  int q[64];
  for (int i = 0; i < 64; i++) {
    float v = block[i] * e.scale[table][i];
    q[ZIGZAG[i]] = (int)(v < 0 ? v - 0.5f : v + 0.5f);
  }

  int diff = q[0] - previousDc;
  if (diff == 0) writeBits(e, e.dc[table][0].bits, e.dc[table][0].len);
  else writeValue(e, e.dc[table], 0, diff);

  const Code *ac = e.ac[table];
  int last = 63;
  while (last > 0 && q[last] == 0) last--;
  for (int i = 1; i <= last; i++) {
    int run = 0;
    while (q[i] == 0) {
      run++;
      i++;
    }
    for (; run >= 16; run -= 16) writeBits(e, ac[0xF0].bits, ac[0xF0].len);  // 16 zeros
    writeValue(e, ac, run, q[i]);
  }
  if (last != 63) writeBits(e, ac[0x00].bits, ac[0x00].len);  // end of block
  return q[0];
}

static void writeHeaders(Encoder &e, int width, int height) {
  static const uint8_t APP0[] = {0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 'J', 'F', 'I', 'F', 0, 1, 1, 0, 0, 1, 0, 1, 0, 0};
  putBytes(e, APP0, sizeof(APP0));

  putWord(e, 0xFFDB);  // quantization tables
  putWord(e, 2 + 2 * 65);
  for (int t = 0; t < 2; t++) {
    putByte(e, t);
    putBytes(e, e.quant[t], 64);
  }

  putWord(e, 0xFFC0);  // baseline frame, three components at full resolution
  putWord(e, 17);
  putByte(e, 8);
  putWord(e, height);
  putWord(e, width);
  static const uint8_t COMPONENTS[] = {3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1};
  putBytes(e, COMPONENTS, sizeof(COMPONENTS));

  putWord(e, 0xFFC4);  // Huffman tables
  putWord(e, 2 + 4 * 17 + 2 * 12 + 2 * 162);
  struct {
    uint8_t id;
    const uint8_t *bits, *values;
    int count;
  } tables[] = {
    {0x00, DC_LUMA_BITS, DC_VALUES, 12},
    {0x10, AC_LUMA_BITS, AC_LUMA_VALUES, 162},
    {0x01, DC_CHROMA_BITS, DC_VALUES, 12},
    {0x11, AC_CHROMA_BITS, AC_CHROMA_VALUES, 162},
  };
  for (auto &t : tables) {
    putByte(e, t.id);
    putBytes(e, t.bits, 16);
    putBytes(e, t.values, t.count);
  }

  static const uint8_t SCAN[] = {0xFF, 0xDA, 0, 12, 3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0};
  putBytes(e, SCAN, sizeof(SCAN));
}

uint8_t *encodeJpeg(int width, int height, PixelSource pixel, const void *ctx, int quality, size_t &len) {
  len = 0;
  Encoder *e = (Encoder *)heap_caps_malloc(sizeof(Encoder), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  if (!e) e = (Encoder *)heap_caps_malloc(sizeof(Encoder), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!e) return nullptr;
  memset(e, 0, sizeof(Encoder));
  e->cap = (size_t)width * height + 2048;  // 8 bits a pixel: far more than a photo needs at quality 80
  e->out = (uint8_t *)heap_caps_malloc(e->cap, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!e->out) {
    heap_caps_free(e);
    return nullptr;
  }

  // The libjpeg quality scaling of the standard tables.
  if (quality < 1) quality = 1;
  if (quality > 100) quality = 100;
  int scaling = quality < 50 ? 5000 / quality : 200 - quality * 2;
  const uint8_t *bases[2] = {LUMA_QUANT, CHROMA_QUANT};
  for (int t = 0; t < 2; t++) {
    for (int i = 0; i < 64; i++) {
      int q = (bases[t][i] * scaling + 50) / 100;
      q = q < 1 ? 1 : q > 255 ? 255 : q;
      e->quant[t][ZIGZAG[i]] = q;
      e->scale[t][i] = 1.0f / (q * AAN_SCALE[i / 8] * AAN_SCALE[i % 8] * 8);
    }
  }
  buildCodes(DC_LUMA_BITS, DC_VALUES, e->dc[0]);
  buildCodes(DC_CHROMA_BITS, DC_VALUES, e->dc[1]);
  buildCodes(AC_LUMA_BITS, AC_LUMA_VALUES, e->ac[0]);
  buildCodes(AC_CHROMA_BITS, AC_CHROMA_VALUES, e->ac[1]);

  writeHeaders(*e, width, height);
  float y[64], cb[64], cr[64];
  uint8_t p[3];
  int dcY = 0, dcCb = 0, dcCr = 0;
  for (int by = 0; by < height && !e->overflow; by += 8) {
    for (int bx = 0; bx < width; bx += 8) {
      for (int k = 0; k < 64; k++) {
        int px = bx + k % 8, py = by + k / 8;  // past the edge, repeat the last row or column
        pixel(ctx, px < width ? px : width - 1, py < height ? py : height - 1, p);
        float r = p[0], g = p[1], b = p[2];
        y[k] = 0.29900f * r + 0.58700f * g + 0.11400f * b - 128;
        cb[k] = -0.16874f * r - 0.33126f * g + 0.50000f * b;
        cr[k] = 0.50000f * r - 0.41869f * g - 0.08131f * b;
      }
      dcY = encodeBlock(*e, y, 0, dcY);
      dcCb = encodeBlock(*e, cb, 1, dcCb);
      dcCr = encodeBlock(*e, cr, 1, dcCr);
    }
  }
  writeBits(*e, 0x7F, 7);  // pad the last byte with ones
  putWord(*e, 0xFFD9);

  uint8_t *out = e->out;
  len = e->len;
  bool ok = !e->overflow;
  heap_caps_free(e);
  if (!ok) {
    heap_caps_free(out);
    len = 0;
    return nullptr;
  }
  uint8_t *fitted = (uint8_t *)heap_caps_realloc(out, len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  return fitted ? fitted : out;
}

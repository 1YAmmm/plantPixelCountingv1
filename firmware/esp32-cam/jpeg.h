// A small baseline JPEG encoder for the report's picture (see jpeg.cpp).

#pragma once

#include <stddef.h>
#include <stdint.h>

/** Writes the RGB of pixel (x, y) of the image being encoded into `out`. */
typedef void (*PixelSource)(const void *ctx, int x, int y, uint8_t out[3]);

/**
 * Encode a width × height image, read pixel by pixel from `pixel`, as a baseline JPEG (4:4:4,
 * quality 1–100). Returns a PSRAM buffer of `len` bytes for heap_caps_free(), or nullptr when out
 * of memory.
 */
uint8_t *encodeJpeg(int width, int height, PixelSource pixel, const void *ctx, int quality, size_t &len);

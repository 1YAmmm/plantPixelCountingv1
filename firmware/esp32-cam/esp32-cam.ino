// Plant Pixel Counter: AI-Thinker ESP32-CAM as a Bluetooth (BLE) camera, plan §11.3.
//
// Board: "AI Thinker ESP32-CAM" (esp32:esp32:esp32cam, core 3.x), partition "Huge APP", PSRAM.
// The web app (Analyze → ESP32-CAM) connects with Web Bluetooth, writes "capture" to Control and
// receives the JPEG on Data as START, CHUNK…, END packets. "preview" does the same with a small
// QVGA frame, which the browser requests back to back for its live view. The wire format is described in
// lib/ble/protocol.ts; keep the two in sync (tests/ble-protocol.test.ts checks the UUIDs).

#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <Preferences.h>
#include "esp_camera.h"
#include "esp_gatt_common_api.h"
#include "esp_mac.h"

#define FIRMWARE_VERSION "1.1.0"

#define SERVICE_UUID "7a1e0000-5c3b-4d2a-8f1e-3b9c6d4a2e10"
#define CONTROL_UUID "7a1e0001-5c3b-4d2a-8f1e-3b9c6d4a2e10"
#define STATUS_UUID "7a1e0002-5c3b-4d2a-8f1e-3b9c6d4a2e10"
#define DATA_UUID "7a1e0003-5c3b-4d2a-8f1e-3b9c6d4a2e10"
#define INFO_UUID "7a1e0004-5c3b-4d2a-8f1e-3b9c6d4a2e10"

// Data packet types (first byte of every Data notification).
static const uint8_t PKT_START = 0x01;  // u32 size, u16 chunks, u32 crc32, u16 chunk size, u16 width, u16 height, u16 capture id
static const uint8_t PKT_CHUNK = 0x02;  // u16 seq, payload
static const uint8_t PKT_END = 0x03;    // u16 chunks, u16 capture id

// AI-Thinker ESP32-CAM pins.
#define PWDN_GPIO_NUM 32
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM 0
#define SIOD_GPIO_NUM 26
#define SIOC_GPIO_NUM 27
#define Y9_GPIO_NUM 35
#define Y8_GPIO_NUM 34
#define Y7_GPIO_NUM 39
#define Y6_GPIO_NUM 36
#define Y5_GPIO_NUM 21
#define Y4_GPIO_NUM 19
#define Y3_GPIO_NUM 18
#define Y2_GPIO_NUM 5
#define VSYNC_GPIO_NUM 25
#define HREF_GPIO_NUM 23
#define PCLK_GPIO_NUM 22
#define LED_GPIO_NUM 4

static const int JPEG_QUALITY = 12;  // 10–63, lower is better quality and a bigger file
static const uint32_t SEND_TIMEOUT_MS = 3000;

struct FrameOption {
  const char *name;
  framesize_t size;
};
// Largest first: the camera is initialised at the largest size so every option fits the buffer.
static const FrameOption FRAMES[] = {
  {"UXGA", FRAMESIZE_UXGA}, {"SXGA", FRAMESIZE_SXGA}, {"XGA", FRAMESIZE_XGA}, {"SVGA", FRAMESIZE_SVGA}, {"VGA", FRAMESIZE_VGA}, {"QVGA", FRAMESIZE_QVGA},
};
static const int FRAME_COUNT = sizeof(FRAMES) / sizeof(FRAMES[0]);
// Live preview frames: small enough for a few frames a second over BLE (about 5 KB each).
static const framesize_t PREVIEW_SIZE = FRAMESIZE_QVGA;
// The LED stays on this long after the last photo, so a live preview with the LED does not flicker.
static const uint32_t LED_HOLD_MS = 1500;

struct Command {
  char text[48];
};

static BLEServer *server = nullptr;
static BLECharacteristic *statusChar = nullptr;
static BLECharacteristic *dataChar = nullptr;
static BLECharacteristic *infoChar = nullptr;
static QueueHandle_t commands = nullptr;
static Preferences prefs;

static volatile bool connected = false;
static volatile uint16_t connId = 0;
static volatile bool notifyFailed = false;

static int frameIndex = 1;  // SXGA: sharp enough for the 1000 px square, about 3 s over BLE
static uint8_t ledLevel = 0;
static bool cameraOk = false;
static framesize_t sensorSize = FRAMESIZE_INVALID;
static bool ledOn = false;
static uint32_t ledOffAt = 0;

// The last JPEG, kept so lost chunks can be resent without taking a new photo.
static uint8_t *jpeg = nullptr;
static size_t jpegLen = 0;
static size_t jpegCap = 0;
static uint16_t jpegWidth = 0;
static uint16_t jpegHeight = 0;
static uint32_t jpegCrc = 0;
static uint16_t captureId = 0;
static uint16_t chunkSize = 0;
static uint16_t chunkCount = 0;

/** CRC-32 (IEEE 802.3, the zlib one), the same as crc32() in lib/ble/protocol.ts. */
static uint32_t crc32(const uint8_t *data, size_t len) {
  uint32_t crc = 0xFFFFFFFF;
  for (size_t i = 0; i < len; i++) {
    crc ^= data[i];
    for (int b = 0; b < 8; b++) crc = (crc >> 1) ^ (0xEDB88320 & (0 - (crc & 1)));
  }
  return ~crc;
}

static void putU16(uint8_t *p, uint16_t v) {
  p[0] = v & 0xFF;
  p[1] = v >> 8;
}

static void putU32(uint8_t *p, uint32_t v) {
  for (int i = 0; i < 4; i++) p[i] = (v >> (8 * i)) & 0xFF;
}

static void setStatus(const String &status) {
  Serial.printf("[status] %s\n", status.c_str());
  statusChar->setValue(status);
  if (connected) statusChar->notify();
}

static void updateInfo() {
  uint16_t mtu = connected ? server->getPeerMTU(connId) : 23;
  char json[200];
  snprintf(
    json, sizeof(json), "{\"fw\":\"%s\",\"model\":\"AI-Thinker ESP32-CAM\",\"camera\":%s,\"frame\":\"%s\",\"quality\":%d,\"led\":%u,\"psram\":%s,\"mtu\":%u}",
    FIRMWARE_VERSION, cameraOk ? "true" : "false", FRAMES[frameIndex].name, JPEG_QUALITY, ledLevel, psramFound() ? "true" : "false", mtu
  );
  infoChar->setValue(String(json));
}

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *s, esp_ble_gatts_cb_param_t *param) override {
    connId = param->connect.conn_id;
    connected = true;
    // Ask for a short connection interval (7.5–15 ms): more packets per second. The phone may refuse.
    s->requestConnParams(param->connect.remote_bda, 6, 12, 0, 400);
    Serial.printf("[ble] connected (conn %u)\n", connId);
  }
  void onDisconnect(BLEServer *, esp_ble_gatts_cb_param_t *) override {
    connected = false;
    Serial.println("[ble] disconnected");
  }
  void onMtuChanged(BLEServer *, esp_ble_gatts_cb_param_t *param) override {
    Serial.printf("[ble] MTU %u\n", param->mtu.mtu);
  }
};

class ControlCallbacks : public BLECharacteristicCallbacks {
  // Runs on the Bluetooth task: only queue the command, loop() does the slow work.
  void onWrite(BLECharacteristic *c) override {
    Command cmd = {};
    String value = c->getValue();
    strncpy(cmd.text, value.c_str(), sizeof(cmd.text) - 1);
    if (xQueueSend(commands, &cmd, 0) != pdTRUE) Serial.println("[ble] command queue full");
  }
};

class DataCallbacks : public BLECharacteristicCallbacks {
  void onStatus(BLECharacteristic *, Status s, uint32_t code) override {
    if (s != SUCCESS_NOTIFY && s != SUCCESS_INDICATE) notifyFailed = true;
  }
};

static bool initCamera() {
  camera_config_t config = {};
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sccb_sda = SIOD_GPIO_NUM;
  config.pin_sccb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = psramFound() ? FRAMESIZE_UXGA : FRAMESIZE_VGA;
  config.jpeg_quality = JPEG_QUALITY;
  config.fb_count = 1;
  config.fb_location = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
  config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("[camera] init failed: 0x%x\n", err);
    return false;
  }
  if (!psramFound()) frameIndex = FRAME_COUNT - 1;  // without PSRAM only QVGA/VGA fit; stay small
  esp_camera_sensor_get()->set_framesize(esp_camera_sensor_get(), FRAMES[frameIndex].size);
  sensorSize = FRAMES[frameIndex].size;
  return true;
}

static void setLed(bool on) {
  ledOn = on && ledLevel > 0;
  ledcWrite(LED_GPIO_NUM, ledOn ? ledLevel : 0);
}

/**
 * Take a fresh photo into `jpeg`. Returns false (with a status) if the camera failed.
 * A preview reports no status and skips the settling frames, so the live view stays fast.
 */
static bool takePhoto(framesize_t size, bool preview) {
  if (!cameraOk) {
    setStatus("error:camera not found, check the ribbon cable");
    return false;
  }
  if (!preview) setStatus("capturing");
  // A photo skips the frame waiting in the buffer (taken at the last request) and one more for
  // exposure; a new size or the LED just switched on needs a few more to settle.
  int discard = preview ? 0 : 2;
  if (size != sensorSize) {
    esp_camera_sensor_get()->set_framesize(esp_camera_sensor_get(), size);
    sensorSize = size;
    discard += 2;
  }
  if (ledLevel > 0) {
    if (!ledOn) {
      setLed(true);
      delay(150);
      discard += 2;
    }
    ledOffAt = millis() + LED_HOLD_MS;
  }
  for (int i = 0; i < discard; i++) {
    camera_fb_t *old = esp_camera_fb_get();
    if (old) esp_camera_fb_return(old);
  }
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    setStatus("error:capture failed");
    return false;
  }
  if (fb->len > jpegCap) {
    free(jpeg);
    jpegCap = fb->len + 16 * 1024;
    jpeg = (uint8_t *)(psramFound() ? ps_malloc(jpegCap) : malloc(jpegCap));
  }
  if (!jpeg) {
    jpegCap = 0;
    esp_camera_fb_return(fb);
    setStatus("error:out of memory");
    return false;
  }
  memcpy(jpeg, fb->buf, fb->len);
  jpegLen = fb->len;
  jpegWidth = fb->width;
  jpegHeight = fb->height;
  esp_camera_fb_return(fb);
  jpegCrc = crc32(jpeg, jpegLen);
  captureId++;
  if (!preview) Serial.printf("[camera] %ux%u, %u bytes, crc %08lx\n", jpegWidth, jpegHeight, (unsigned)jpegLen, (unsigned long)jpegCrc);
  return true;
}

/** Notify one Data packet, waiting for room in the Bluetooth controller's buffer. */
static bool sendPacket(const uint8_t *data, size_t len) {
  for (int attempt = 0; attempt < 5; attempt++) {
    uint32_t start = millis();
    while (esp_ble_get_cur_sendable_packets_num(connId) == 0) {
      if (!connected || millis() - start > SEND_TIMEOUT_MS) return false;
      vTaskDelay(1);
    }
    if (!connected) return false;
    notifyFailed = false;
    dataChar->setValue(data, len);
    dataChar->notify();
    if (!notifyFailed) return true;
    vTaskDelay(pdMS_TO_TICKS(20));
  }
  return false;
}

static bool sendChunk(uint16_t seq) {
  static uint8_t packet[ESP_GATT_MAX_MTU_SIZE];
  size_t offset = (size_t)seq * chunkSize;
  size_t len = min((size_t)chunkSize, jpegLen - offset);
  packet[0] = PKT_CHUNK;
  putU16(packet + 1, seq);
  memcpy(packet + 3, jpeg + offset, len);
  return sendPacket(packet, len + 3);
}

static bool sendEnd() {
  uint8_t packet[5] = {PKT_END};
  putU16(packet + 1, chunkCount);
  putU16(packet + 3, captureId);
  return sendPacket(packet, sizeof(packet));
}

/** Send the whole photo: START, every chunk, END. A preview frame only reports errors. */
static void sendPhoto(bool preview) {
  // Each notification carries MTU − 3 bytes of ATT payload; a chunk uses 3 of them for its header.
  uint16_t mtu = server->getPeerMTU(connId);
  chunkSize = max(1, (int)mtu - 3 - 3);
  chunkCount = (jpegLen + chunkSize - 1) / chunkSize;
  if (!preview) setStatus("sending");
  uint32_t started = millis();

  uint8_t start[19] = {PKT_START};
  putU32(start + 1, jpegLen);
  putU16(start + 5, chunkCount);
  putU32(start + 7, jpegCrc);
  putU16(start + 11, chunkSize);
  putU16(start + 13, jpegWidth);
  putU16(start + 15, jpegHeight);
  putU16(start + 17, captureId);
  bool ok = sendPacket(start, sizeof(start));
  for (uint16_t seq = 0; ok && seq < chunkCount; seq++) ok = sendChunk(seq);
  if (ok) ok = sendEnd();

  if (!connected) return;
  if (!ok) {
    setStatus("error:send failed");
    return;
  }
  if (preview) return;
  unsigned ms = max(1UL, (unsigned long)(millis() - started));
  Serial.printf("[ble] sent %u chunks of %u bytes in %u ms (%.1f KB/s)\n", chunkCount, chunkSize, ms, jpegLen / 1.024 / ms);
  setStatus("ready");
}

/** "resend:<from>:<count>": the browser lost some chunks of the current photo. */
static void resendChunks(const char *args) {
  unsigned from = 0, count = 0;
  if (!jpegLen || sscanf(args, "%u:%u", &from, &count) != 2 || from >= chunkCount) {
    setStatus("error:nothing to resend");
    return;
  }
  setStatus("sending");
  bool ok = true;
  for (unsigned seq = from; ok && seq < from + count && seq < chunkCount; seq++) ok = sendChunk(seq);
  if (ok) ok = sendEnd();
  if (connected) setStatus(ok ? "ready" : "error:send failed");
}

static void handleCommand(const char *text) {
  if (strcmp(text, "preview") == 0) {
    if (takePhoto(PREVIEW_SIZE, true)) sendPhoto(true);
    return;
  }
  Serial.printf("[cmd] %s\n", text);
  if (strcmp(text, "capture") == 0) {
    if (takePhoto(FRAMES[frameIndex].size, false)) sendPhoto(false);
  } else if (strncmp(text, "resend:", 7) == 0) {
    resendChunks(text + 7);
  } else if (strncmp(text, "frame:", 6) == 0) {
    for (int i = 0; i < FRAME_COUNT; i++) {
      if (strcmp(text + 6, FRAMES[i].name) != 0) continue;
      if (!psramFound() && FRAMES[i].size > FRAMESIZE_VGA) break;
      frameIndex = i;  // the sensor switches at the next capture
      prefs.putUChar("frame", i);
      updateInfo();
      setStatus("ready");
      return;
    }
    setStatus("error:unsupported frame size");
  } else if (strncmp(text, "led:", 4) == 0) {
    ledLevel = constrain(atoi(text + 4), 0, 255);
    if (ledOn) setLed(true);  // the new brightness now (or off for 0)
    prefs.putUChar("led", ledLevel);
    updateInfo();
    setStatus("ready");
  } else if (strcmp(text, "info") == 0) {
    updateInfo();
    setStatus(cameraOk ? "ready" : "error:camera not found, check the ribbon cable");
  } else {
    setStatus("error:unknown command");
  }
}

void setup() {
  Serial.begin(115200);
  Serial.println("\n[plantcam] firmware " FIRMWARE_VERSION);
  commands = xQueueCreate(8, sizeof(Command));

  prefs.begin("plantcam", false);
  frameIndex = constrain(prefs.getUChar("frame", 1), 0, FRAME_COUNT - 1);
  ledLevel = prefs.getUChar("led", 0);

  cameraOk = initCamera();
  Serial.printf("[camera] %s, PSRAM %s\n", cameraOk ? "ok" : "FAILED", psramFound() ? "yes" : "no");
  // After the camera, like the core's CameraWebServer example: the camera's XCLK owns LEDC timer 0.
  ledcAttach(LED_GPIO_NUM, 5000, 8);
  ledcWrite(LED_GPIO_NUM, 0);

  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_BT);
  char name[20];
  snprintf(name, sizeof(name), "PlantCam-%02X%02X", mac[4], mac[5]);

  BLEDevice::init(name);
  BLEDevice::setMTU(ESP_GATT_MAX_MTU_SIZE);
  server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  server->advertiseOnDisconnect(true);

  BLEService *service = server->createService(BLEUUID(SERVICE_UUID), 16);
  BLECharacteristic *control = service->createCharacteristic(CONTROL_UUID, BLECharacteristic::PROPERTY_WRITE);
  control->setCallbacks(new ControlCallbacks());
  statusChar = service->createCharacteristic(STATUS_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  statusChar->addDescriptor(new BLE2902());
  dataChar = service->createCharacteristic(DATA_UUID, BLECharacteristic::PROPERTY_NOTIFY);
  dataChar->addDescriptor(new BLE2902());
  dataChar->setCallbacks(new DataCallbacks());
  infoChar = service->createCharacteristic(INFO_UUID, BLECharacteristic::PROPERTY_READ);
  updateInfo();
  statusChar->setValue(cameraOk ? "ready" : "error:camera not found, check the ribbon cable");
  service->start();

  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(true);  // the name goes in the scan response when it does not fit
  BLEDevice::startAdvertising();
  Serial.printf("[ble] advertising as %s\n", name);
}

void loop() {
  Command cmd;
  if (xQueueReceive(commands, &cmd, pdMS_TO_TICKS(100)) == pdTRUE) {
    if (connected) updateInfo();  // keeps the reported MTU current
    handleCommand(cmd.text);
  }
  if (ledOn && (int32_t)(millis() - ledOffAt) > 0) setLed(false);
}

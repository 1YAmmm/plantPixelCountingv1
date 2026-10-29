// Plant Pixel Counter: AI-Thinker ESP32-CAM as a Bluetooth (BLE) camera, plan §11.3, that also
// takes the daily report photo over WiFi by itself (newplan.md step 8).
//
// Board: "AI Thinker ESP32-CAM" (esp32:esp32:esp32cam, core 3.x), partition "Huge APP", PSRAM.
// The web app (Analyze → ESP32-CAM) connects with Web Bluetooth, writes "capture" to Control and
// receives the JPEG on Data as START, CHUNK…, END packets. "preview" does the same with a small
// QVGA frame, which the browser requests back to back for its live view. The wire format is described in
// lib/ble/protocol.ts; keep the two in sync (tests/ble-protocol.test.ts checks the UUIDs).
//
// Daily report: the Settings page sends the WiFi, the server address and the device key over BLE
// ("wifi-ssid:", "wifi-pass:", "server:", "key:", then "wifi:connect"); they are kept in flash.
// On WiFi, the board asks the server every minute (GET /api/device/config) whether to take a
// photo. When told "capture=<slot>", it takes one and POSTs it (/api/device/captures). The server
// keeps the schedule, so the board needs no clock. loop() does one thing at a time, so BLE
// commands and uploads never use the camera together.

#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <NetworkClientSecure.h>
#include <Preferences.h>
#include <WiFi.h>
#include "esp_camera.h"
#include "esp_gatt_common_api.h"
#include "esp_heap_caps.h"
#include "esp_mac.h"

#define FIRMWARE_VERSION "2.0.0"

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

// Daily report over WiFi.
static const uint32_t WIFI_CONNECT_TIMEOUT_MS = 15000;
static const uint32_t WIFI_RETRY_MS = 60000;      // begin() again if still not connected
static const uint32_t POLL_TIMEOUT_MS = 20000;
static const uint32_t UPLOAD_TIMEOUT_MS = 60000;  // the server analyzes the photo and emails it before replying
static const int UPLOAD_ATTEMPTS = 3;
static const uint32_t UPLOAD_RETRY_MS = 20000;
static const uint32_t RESTART_AFTER_MS = 30UL * 60 * 1000;  // no successful poll for this long: restart

struct Command {
  char text[200];  // long enough for "server:<url>" and "key:<device key>"
};

/** The server address split up: "http[s]://host[:port][/base path]". Up here for the .ino prototypes. */
struct ServerAddress {
  bool https = false;
  String host;
  uint16_t port = 0;
  String base;
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

// WiFi and server settings (Preferences), and the poll state.
static String wifiSsid;
static String wifiPass;
static String serverUrl;
static String deviceKey;
static bool wifiDirty = false;  // a new name or password since the last "wifi:connect"
static bool wifiWasUp = false;
static bool pollNow = false;
static uint32_t pollMs = 60000;
static uint32_t nextPollAt = 0;
static uint32_t lastPollOkAt = 0;
static uint32_t lastWifiAttemptAt = 0;
static bool tlsChecked = false;
static volatile uint16_t lastDisconnectReason = 0;

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

/** A JSON string literal (the WiFi name may contain quotes or backslashes). */
static String jsonString(const String &s) {
  String out = "\"";
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '"' || c == '\\') {
      out += '\\';
      out += c;
    } else if ((uint8_t)c < 0x20) {
      char esc[7];
      snprintf(esc, sizeof(esc), "\\u%04x", c);
      out += esc;
    } else {
      out += c;
    }
  }
  return out + "\"";
}

static void updateInfo() {
  uint16_t mtu = connected ? server->getPeerMTU(connId) : 23;
  bool wifiUp = WiFi.status() == WL_CONNECTED;
  char json[200];
  snprintf(
    json, sizeof(json), "{\"fw\":\"%s\",\"model\":\"AI-Thinker ESP32-CAM\",\"camera\":%s,\"frame\":\"%s\",\"quality\":%d,\"led\":%u,\"psram\":%s,\"mtu\":%u",
    FIRMWARE_VERSION, cameraOk ? "true" : "false", FRAMES[frameIndex].name, JPEG_QUALITY, ledLevel, psramFound() ? "true" : "false", mtu
  );
  String info = json;
  info += ",\"wifi\":";
  info += wifiUp ? "true" : "false";
  info += ",\"ssid\":" + jsonString(wifiSsid);
  info += ",\"ip\":" + jsonString(wifiUp ? WiFi.localIP().toString() : String());
  if (wifiUp) info += ",\"rssi\":" + String(WiFi.RSSI());
  info += ",\"server\":";
  info += serverUrl.length() && deviceKey.length() ? "true" : "false";
  info += "}";
  infoChar->setValue(info);
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

/** A status for the BLE client, or only the serial log for a photo nobody over BLE asked for. */
static void photoStatus(const char *status, bool quiet) {
  if (quiet) Serial.printf("[camera] %s\n", status);
  else setStatus(status);
}

/**
 * Take a fresh photo into `jpeg`. Returns false (with a status) if the camera failed.
 * A preview reports no status and skips the settling frames, so the live view stays fast.
 * `quiet` (the daily report photo) reports nothing over BLE, so a connected browser is not confused.
 */
static bool takePhoto(framesize_t size, bool preview, bool quiet = false) {
  if (!cameraOk) {
    photoStatus("error:camera not found, check the ribbon cable", quiet);
    return false;
  }
  if (!preview && !quiet) setStatus("capturing");
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
    photoStatus("error:capture failed", quiet);
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
    photoStatus("error:out of memory", quiet);
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

// ---- Daily report over WiFi (newplan.md step 8) ----

static void onWifiEvent(arduino_event_id_t event, arduino_event_info_t info) {
  if (event == ARDUINO_EVENT_WIFI_STA_DISCONNECTED) lastDisconnectReason = info.wifi_sta_disconnected.reason;
  else if (event == ARDUINO_EVENT_WIFI_STA_GOT_IP) lastDisconnectReason = 0;
}

/** Why joining failed, from the last disconnect reason. */
static const char *wifiFailure(uint16_t reason) {
  switch (reason) {
    case WIFI_REASON_NO_AP_FOUND:
    case WIFI_REASON_NO_AP_FOUND_W_COMPATIBLE_SECURITY:
    case WIFI_REASON_NO_AP_FOUND_IN_AUTHMODE_THRESHOLD:
    case WIFI_REASON_NO_AP_FOUND_IN_RSSI_THRESHOLD: return "network not found";
    case WIFI_REASON_AUTH_FAIL:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_MIC_FAILURE: return "wrong password";
    default: return "timeout";
  }
}

static void beginWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  lastDisconnectReason = 0;
  lastWifiAttemptAt = millis();
  WiFi.begin(wifiSsid.c_str(), wifiPass.c_str());
}

/** "wifi:connect": join the saved WiFi, waiting up to 15 s, and say why if it fails. */
static void connectWifi() {
  if (wifiSsid.isEmpty()) {
    setStatus("error:no WiFi name saved");
    return;
  }
  if (WiFi.status() == WL_CONNECTED && WiFi.SSID() == wifiSsid && !wifiDirty) {
    pollNow = true;  // the server address or key may be new: check in now
    updateInfo();
    setStatus("ready");
    return;
  }
  setStatus("connecting");
  WiFi.disconnect();
  delay(200);
  beginWifi();
  wifiDirty = false;
  uint32_t start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_CONNECT_TIMEOUT_MS) delay(100);
  updateInfo();
  if (WiFi.status() != WL_CONNECTED) {
    const char *reason = wifiFailure(lastDisconnectReason);
    Serial.printf("[wifi] could not join %s: %s (reason %u)\n", wifiSsid.c_str(), reason, lastDisconnectReason);
    setStatus(String("error:") + reason);
    return;
  }
  Serial.printf("[wifi] joined %s, IP %s, %d dBm\n", wifiSsid.c_str(), WiFi.localIP().toString().c_str(), WiFi.RSSI());
  wifiWasUp = true;
  pollNow = true;
  setStatus("ready");
}

static void forgetWifi() {
  wifiSsid = "";
  wifiPass = "";
  prefs.remove("ssid");
  prefs.remove("pass");
  WiFi.disconnect(true);
  wifiWasUp = false;
  updateInfo();
  setStatus("ready");
}

static void logHeap(const char *when) {
  Serial.printf(
    "[heap] %s: internal free %u, largest block %u, PSRAM free %u\n", when, (unsigned)ESP.getFreeHeap(),
    (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT | MALLOC_CAP_INTERNAL), (unsigned)ESP.getFreePsram()
  );
}

// A minimal HTTP/1.1 client. The core's HTTPClient parses cookie dates, which links libc's time
// functions into IRAM, and with BLE, WiFi and the PSRAM workaround IRAM is already full.

static bool parseServer(const String &url, ServerAddress &out) {
  out.https = url.startsWith("https://");
  if (!out.https && !url.startsWith("http://")) return false;
  String rest = url.substring(out.https ? 8 : 7);
  int slash = rest.indexOf('/');
  String hostPort = slash < 0 ? rest : rest.substring(0, slash);
  out.base = slash < 0 ? String() : rest.substring(slash);
  int colon = hostPort.lastIndexOf(':');
  out.host = colon < 0 ? hostPort : hostPort.substring(0, colon);
  long port = colon < 0 ? (out.https ? 443 : 80) : hostPort.substring(colon + 1).toInt();
  if (out.host.isEmpty() || port <= 0 || port > 65535) return false;
  out.port = port;
  return true;
}

/** One line of the reply (without CR LF), waiting until `deadline`. */
static bool readLine(NetworkClient &c, String &line, uint32_t deadline) {
  line = "";
  while ((int32_t)(deadline - millis()) > 0) {
    if (c.available()) {
      int ch = c.read();
      if (ch < 0) continue;
      if (ch == '\n') {
        if (line.endsWith("\r")) line.remove(line.length() - 1);
        return true;
      }
      if (line.length() < 512) line += (char)ch;
    } else if (!c.connected()) {
      return false;
    } else {
      delay(2);
    }
  }
  return false;
}

/** `len` bytes of the reply body (until the connection closes if negative); keeps the first 1 KB. */
static void readBody(NetworkClient &c, String &body, long len, uint32_t deadline) {
  while (len != 0 && (int32_t)(deadline - millis()) > 0) {
    if (c.available()) {
      int ch = c.read();
      if (ch < 0) continue;
      if (body.length() < 1024) body += (char)ch;
      if (len > 0) len--;
    } else if (!c.connected()) {
      return;
    } else {
      delay(2);
    }
  }
}

/**
 * One request to the server with the device key (Connection: close). Returns the HTTP status, or a
 * negative number when the server could not be reached, and the start of the reply body in `reply`.
 * HTTPS checks the server's certificate with the core's root certificate bundle; plain HTTP is for
 * local testing.
 */
static int httpRequest(const char *method, const String &path, const String &headers, const uint8_t *body, size_t bodyLen, uint32_t timeoutMs, String &reply) {
  static NetworkClientSecure *secure = nullptr;
  static NetworkClient plain;
  reply = "";
  ServerAddress a;
  if (!parseServer(serverUrl, a)) {
    reply = "invalid server address";
    return -1;
  }
  if (a.https && !secure) {
    secure = new NetworkClientSecure();
    secure->useBuiltinCACertBundle();
  }
  NetworkClient &c = a.https ? *secure : plain;
  if (!c.connect(a.host.c_str(), a.port, 10000)) {
    reply = a.https ? "could not connect (or TLS failed)" : "could not connect";
    return -2;
  }
  String head = String(method) + " " + a.base + path + " HTTP/1.1\r\nHost: " + a.host;
  if (a.port != (a.https ? 443 : 80)) head += ":" + String(a.port);
  head += "\r\nUser-Agent: PlantCam/" FIRMWARE_VERSION "\r\nAuthorization: Bearer " + deviceKey + "\r\nConnection: close\r\n" + headers;
  head += "Content-Length: " + String((unsigned)bodyLen) + "\r\n\r\n";
  bool ok = c.write((const uint8_t *)head.c_str(), head.length()) == head.length();
  for (size_t sent = 0; ok && sent < bodyLen;) {
    size_t n = c.write(body + sent, min((size_t)4096, bodyLen - sent));
    ok = n > 0;
    sent += n;
  }
  if (!ok) {
    c.stop();
    reply = "send failed";
    return -3;
  }

  uint32_t deadline = millis() + timeoutMs;
  String line;
  if (!readLine(c, line, deadline) || !line.startsWith("HTTP/1.")) {
    c.stop();
    reply = "no reply";
    return -4;
  }
  int code = line.substring(9, 12).toInt();
  long length = -1;
  bool chunked = false;
  while (readLine(c, line, deadline) && line.length()) {
    line.toLowerCase();
    if (line.startsWith("content-length:")) length = line.substring(15).toInt();
    else if (line.startsWith("transfer-encoding:") && line.indexOf("chunked") >= 0) chunked = true;
  }
  if (chunked) {
    while (readLine(c, line, deadline)) {
      long size = strtol(line.c_str(), nullptr, 16);
      if (size <= 0) break;
      readBody(c, reply, size, deadline);
      readLine(c, line, deadline);  // the CR LF after each chunk
    }
  } else {
    readBody(c, reply, length, deadline);
  }
  c.stop();
  reply.trim();
  return code;
}

/** POST the photo in `jpeg` for `slot`. Returns the HTTP status (negative: no connection). */
static int uploadPhoto(const String &slot) {
  String reply;
  int code = httpRequest("POST", "/api/device/captures", "Content-Type: image/jpeg\r\nX-Slot: " + slot + "\r\n", jpeg, jpegLen, UPLOAD_TIMEOUT_MS, reply);
  Serial.printf("[upload] %s, %u bytes: %d %s\n", slot.c_str(), (unsigned)jpegLen, code, reply.c_str());
  return code;
}

/** "capture=<slot>": take the photo with the frame size and LED set over BLE, and upload it. */
static void captureAndUpload(const String &slot) {
  if (!takePhoto(FRAMES[frameIndex].size, false, true)) return;  // the server asks again at the next poll
  for (int attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    int code = uploadPhoto(slot);
    if (code >= 200 && code < 300) return;
    if (code >= 400 && code < 500) return;  // not asked for, or a bad request: trying again will not help
    if (attempt < UPLOAD_ATTEMPTS) delay(UPLOAD_RETRY_MS);
  }
}

/** GET /api/device/config: report in, and do what the server says (one key=value per line). */
static void pollServer() {
  String path = "/api/device/config?fw=" FIRMWARE_VERSION "&ip=" + WiFi.localIP().toString() + "&rssi=" + String(WiFi.RSSI()) + "&heap=" + String(ESP.getFreeHeap());
  bool firstTls = !tlsChecked && serverUrl.startsWith("https://");
  if (firstTls) logHeap("before the first TLS handshake");
  String body;
  int code = httpRequest("GET", path, String(), nullptr, 0, POLL_TIMEOUT_MS, body);
  if (firstTls) {
    logHeap(code > 0 ? "after the first TLS handshake" : "after a FAILED TLS handshake");
    tlsChecked = code > 0;
  }
  if (code != 200) {
    Serial.printf("[poll] %s: %d %s\n", serverUrl.c_str(), code, body.c_str());
    return;
  }
  lastPollOkAt = millis();

  String slot;
  int start = 0;
  while (start < (int)body.length()) {
    int end = body.indexOf('\n', start);
    if (end < 0) end = body.length();
    String line = body.substring(start, end);
    line.trim();
    start = end + 1;
    if (line.startsWith("poll=")) {
      long seconds = line.substring(5).toInt();
      if (seconds >= 10 && seconds <= 3600) pollMs = seconds * 1000;
    } else if (line.startsWith("capture=")) {
      slot = line.substring(8);
    }
  }
  Serial.printf("[poll] ok%s%s\n", slot.length() ? ", capture " : "", slot.c_str());
  if (slot.length()) captureAndUpload(slot);
}

/** Called from loop(): keep the WiFi up and poll the server every `pollMs`. */
static void serviceWifi() {
  if (wifiSsid.isEmpty()) return;
  uint32_t now = millis();
  bool configured = serverUrl.length() && deviceKey.length();
  if (configured && !connected && now - lastPollOkAt > RESTART_AFTER_MS) {
    Serial.println("[wifi] no successful poll for 30 minutes, restarting");
    delay(100);
    ESP.restart();
  }
  if (WiFi.status() != WL_CONNECTED) {
    if (wifiWasUp) {
      wifiWasUp = false;
      Serial.println("[wifi] connection lost, reconnecting");
      updateInfo();
    }
    if (now - lastWifiAttemptAt > WIFI_RETRY_MS) beginWifi();
    return;
  }
  if (!wifiWasUp) {
    wifiWasUp = true;
    pollNow = true;  // check in right away, so the Settings page sees the camera within seconds
    Serial.printf("[wifi] connected to %s, IP %s, %d dBm\n", wifiSsid.c_str(), WiFi.localIP().toString().c_str(), WiFi.RSSI());
    updateInfo();
  }
  if (!configured) return;
  if (pollNow || (int32_t)(now - nextPollAt) >= 0) {
    pollNow = false;
    pollServer();
    nextPollAt = millis() + pollMs;
  }
}

/** Save one setting from a "name:value" command. */
static void saveSetting(const char *key, String &target, const char *value) {
  target = value;
  target.trim();
  prefs.putString(key, target);
}

static void handleCommand(const char *text) {
  if (strcmp(text, "preview") == 0) {
    if (takePhoto(PREVIEW_SIZE, true)) sendPhoto(true);
    return;
  }
  // The WiFi password and the device key stay out of the serial log.
  if (strncmp(text, "wifi-pass:", 10) == 0 || strncmp(text, "key:", 4) == 0) Serial.printf("[cmd] %.*s***\n", (int)(strchr(text, ':') - text + 1), text);
  else Serial.printf("[cmd] %s\n", text);
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
  } else if (strncmp(text, "wifi-ssid:", 10) == 0) {
    saveSetting("ssid", wifiSsid, text + 10);
    wifiDirty = true;
    setStatus(wifiSsid.length() <= 32 ? "ready" : "error:WiFi name too long");
  } else if (strncmp(text, "wifi-pass:", 10) == 0) {
    wifiPass = text + 10;  // not trimmed: spaces can be part of a password
    prefs.putString("pass", wifiPass);
    wifiDirty = true;
    setStatus("ready");
  } else if (strncmp(text, "server:", 7) == 0) {
    String url = String(text + 7);
    url.trim();
    while (url.endsWith("/")) url.remove(url.length() - 1);
    ServerAddress address;
    if (!parseServer(url, address)) {
      setStatus("error:the server address must look like https://example.com");
      return;
    }
    saveSetting("server", serverUrl, url.c_str());
    updateInfo();
    setStatus("ready");
  } else if (strncmp(text, "key:", 4) == 0) {
    saveSetting("key", deviceKey, text + 4);
    updateInfo();
    setStatus("ready");
  } else if (strcmp(text, "wifi:connect") == 0) {
    connectWifi();
  } else if (strcmp(text, "wifi:forget") == 0) {
    forgetWifi();
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
  wifiSsid = prefs.getString("ssid", "");
  wifiPass = prefs.getString("pass", "");
  serverUrl = prefs.getString("server", "");
  deviceKey = prefs.getString("key", "");

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

  // WiFi after BLE, so the heap numbers logged before the first TLS handshake include both.
  WiFi.onEvent(onWifiEvent);
  logHeap("BLE running");
  if (wifiSsid.length()) {
    Serial.printf("[wifi] joining %s, server %s\n", wifiSsid.c_str(), serverUrl.length() ? serverUrl.c_str() : "(not set)");
    beginWifi();
  } else {
    Serial.println("[wifi] not set up: use the Settings page (Daily email report, step 1)");
  }
}

void loop() {
  Command cmd;
  if (xQueueReceive(commands, &cmd, pdMS_TO_TICKS(100)) == pdTRUE) {
    if (connected) updateInfo();  // keeps the reported MTU current
    handleCommand(cmd.text);
  }
  if (ledOn && (int32_t)(millis() - ledOffAt) > 0) setLed(false);
  serviceWifi();
}

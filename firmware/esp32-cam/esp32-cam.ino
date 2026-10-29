// PlantCam: an AI-Thinker ESP32-CAM that photographs a plant on a schedule and sends the report to
// Telegram by itself. The web app only sets it up over Bluetooth (BLE): the WiFi, the Telegram bot
// token and chat, and the days and time of the report, all kept in flash. The commands and the Info
// JSON are described in lib/ble/protocol.ts; keep the two in sync (tests/ble-protocol.test.ts
// checks the UUIDs and the command names).
//
// Board: "AI Thinker ESP32-CAM" (esp32:esp32:esp32cam, core 3.x), partition "Huge APP", PSRAM.
// The clock comes from the internet (SNTP) once on WiFi; the schedule is in the camera's local
// time, a fixed UTC offset sent by the web app. loop() does one thing at a time, so BLE commands
// and reports never use the camera together.
//
// Instruction RAM (IRAM) is nearly full: BLE, WiFi and the PSRAM cache workaround, which also puts
// libc's time functions in IRAM. So no time()/localtime()/strftime(): dates are computed here from
// gettimeofday(). The TLS buffers go to PSRAM, so HTTPS to Telegram fits next to BLE and WiFi.

#include <Arduino.h>
#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>
#include <NetworkClientSecure.h>
#include <Preferences.h>
#include <WiFi.h>
#include <sys/time.h>
#include "esp_camera.h"
#include "esp_gatt_common_api.h"
#include "esp_heap_caps.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "lwip/apps/sntp.h"
#include "lwip/priv/tcpip_priv.h"
#include "mbedtls/platform.h"

#define FIRMWARE_VERSION "3.0.0"

#define SERVICE_UUID "7a1e0000-5c3b-4d2a-8f1e-3b9c6d4a2e10"
#define CONTROL_UUID "7a1e0001-5c3b-4d2a-8f1e-3b9c6d4a2e10"
#define STATUS_UUID "7a1e0002-5c3b-4d2a-8f1e-3b9c6d4a2e10"
#define INFO_UUID "7a1e0004-5c3b-4d2a-8f1e-3b9c6d4a2e10"

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

#define TELEGRAM_HOST "api.telegram.org"
#define BOUNDARY "PlantCamFormBoundary7MA4YWxk"

static const int JPEG_QUALITY = 12;                 // 10–63, lower is better quality and a bigger file
static const framesize_t PHOTO_SIZE = FRAMESIZE_SXGA;  // 1280 × 1024: sharp enough for the 1000 px guide square

static const uint32_t WIFI_ATTEMPT_MS = 12000;  // per attempt of "wifi:connect" (the web app waits 20 s per status)
static const int WIFI_ATTEMPTS = 2;             // BLE shares the radio: the first scan sometimes misses the network
static const uint32_t WIFI_RETRY_MS = 60000;    // begin() again if still not connected
static const uint32_t RESTART_AFTER_MS = 30UL * 60 * 1000;  // WiFi set up but down this long, nobody on BLE: restart
static const uint32_t HTTP_TIMEOUT_MS = 30000;
static const uint32_t REPORT_RETRY_MS = 5UL * 60 * 1000;  // a report that could not reach Telegram
static const int32_t LATE_LIMIT_MIN = 180;  // a report missed at the set time (power, WiFi) is still sent this long after
static const int32_t LATE_AFTER_MIN = 15;   // and is marked late after this
static const time_t CLOCK_VALID_AFTER = 1704067200;  // 2024-01-01: an earlier clock was never set
static const size_t MAX_LABEL_BYTES = 120;
static const uint32_t CAMERA_SETTLE_MS = 1500;  // auto exposure and white balance after a start

struct Command {
  char text[200];  // long enough for "tg-label:<label>" and "wifi-pass:<password>"
};

/** How a report ended. Up here for the .ino prototypes. */
enum ReportResult { REPORT_SENT, REPORT_FAILED, REPORT_REFUSED };

static BLEServer *server = nullptr;
static BLECharacteristic *statusChar = nullptr;
static BLECharacteristic *infoChar = nullptr;
static QueueHandle_t commands = nullptr;
static Preferences prefs;
static char deviceName[20];

static volatile bool connected = false;
static bool cameraOk = false;       // found at boot
static bool cameraRunning = false;  // the driver is started (stopped during uploads)
static uint32_t cameraStartedAt = 0;
static bool restartWhenIdle = false;  // the internal RAM ran out: restart once nobody is on BLE

// The last photo, in PSRAM.
static uint8_t *jpeg = nullptr;
static size_t jpegLen = 0;
static size_t jpegCap = 0;

// Settings (Preferences).
static String wifiSsid;
static String wifiPass;
static String tgToken;
static String tgChat;
static String tgLabel;
static uint8_t schedDays = 0;      // bit 0 = Sunday … bit 6 = Saturday; 0 = no reports
static uint16_t schedMinute = 0;   // minute of the day, local time
static int16_t schedOffset = 0;    // local time = UTC + this many minutes
static uint32_t lastSlot = 0;      // the last scheduled time handled, local minutes since 1970
static bool skipPastSlots = false; // a new schedule starts with its next time, not one already past today

// WiFi and clock state.
static bool wifiDirty = false;  // a new name or password since the last "wifi:connect"
static bool wifiWasUp = false;
static uint32_t lastWifiAttemptAt = 0;
static uint32_t wifiDownSince = 0;
static volatile uint16_t lastDisconnectReason = 0;
static bool clockStarted = false;
static bool clockWasValid = false;
static uint32_t nextReportTryAt = 0;

static void setStatus(const String &status) {
  Serial.printf("[status] %s\n", status.c_str());
  statusChar->setValue(status);
  if (connected) statusChar->notify();
}

static void logHeap(const char *when) {
  Serial.printf(
    "[heap] %s: internal free %u, largest block %u, PSRAM free %u\n", when, (unsigned)ESP.getFreeHeap(),
    (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT | MALLOC_CAP_INTERNAL), (unsigned)ESP.getFreePsram()
  );
}

// ---- Clock and dates (no libc time functions: see the top) ----

static time_t nowUtc() {
  struct timeval tv;
  gettimeofday(&tv, nullptr);
  return tv.tv_sec;
}

static bool clockValid() {
  return nowUtc() > CLOCK_VALID_AFTER;
}

/** The camera's local time in minutes since 1970-01-01 00:00. */
static int64_t localMinutes() {
  return (int64_t)nowUtc() / 60 + schedOffset;
}

/** 0 = Sunday, like the schedule's bits (1970-01-01 was a Thursday). */
static int weekday(int64_t day) {
  return (int)((day + 4) % 7);
}

/** Year, month (1–12) and day of `days` since 1970-01-01 (H. Hinnant's civil_from_days). */
static void civilFromDays(int64_t days, int &y, unsigned &m, unsigned &d) {
  days += 719468;
  const int64_t era = (days >= 0 ? days : days - 146096) / 146097;
  const unsigned doe = (unsigned)(days - era * 146097);
  const unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
  const unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  const unsigned mp = (5 * doy + 2) / 153;
  d = doy - (153 * mp + 2) / 5 + 1;
  m = mp < 10 ? mp + 3 : mp - 9;
  y = (int)(yoe + era * 400 + (m <= 2));
}

/** "Thu 29 Oct 2026, 7:00" for local minutes since 1970. */
static String formatLocal(int64_t localMin) {
  static const char *DAYS[] = {"Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"};
  static const char *MONTHS[] = {"Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"};
  int64_t day = localMin / 1440;
  int minute = (int)(localMin % 1440);
  int y;
  unsigned m, d;
  civilFromDays(day, y, m, d);
  char buf[32];
  snprintf(buf, sizeof(buf), "%s %u %s %d, %d:%02d", DAYS[weekday(day)], d, MONTHS[m - 1], y, minute / 60, minute % 60);
  return buf;
}

/** 480 → "UTC+8", 330 → "UTC+5:30". */
static String formatOffset(int offset) {
  char buf[16];
  int a = offset < 0 ? -offset : offset;
  if (a % 60) snprintf(buf, sizeof(buf), "UTC%c%d:%02d", offset < 0 ? '-' : '+', a / 60, a % 60);
  else snprintf(buf, sizeof(buf), "UTC%c%d", offset < 0 ? '-' : '+', a / 60);
  return buf;
}

/** Ask the internet for the time (SNTP, every hour), like the core's configTime() without the time zone. */
static void startClock() {
  if (clockStarted) return;
  clockStarted = true;
  esp_netif_init();
#ifdef CONFIG_LWIP_TCPIP_CORE_LOCKING
  bool locked = !sys_thread_tcpip(LWIP_CORE_LOCK_QUERY_HOLDER);
  if (locked) LOCK_TCPIP_CORE();
#endif
  sntp_setoperatingmode(SNTP_OPMODE_POLL);
  sntp_setservername(0, (char *)"pool.ntp.org");
  sntp_setservername(1, (char *)"time.google.com");
  sntp_setservername(2, (char *)"time.cloudflare.com");
  sntp_init();
#ifdef CONFIG_LWIP_TCPIP_CORE_LOCKING
  if (locked) UNLOCK_TCPIP_CORE();
#endif
}

// ---- Info and settings ----

/** A JSON string literal (the WiFi name or the label may contain quotes or backslashes). */
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

static bool telegramReady() {
  return tgToken.length() && tgChat.length();
}

/** "62,07:00,480" (days, time, UTC offset), as the web app sends it; empty when there is none. */
static String scheduleText() {
  if (!schedDays) return String();
  char buf[24];
  snprintf(buf, sizeof(buf), "%u,%02u:%02u,%d", schedDays, schedMinute / 60, schedMinute % 60, schedOffset);
  return buf;
}

static void updateInfo() {
  bool wifiUp = WiFi.status() == WL_CONNECTED;
  String info = "{\"fw\":\"" FIRMWARE_VERSION "\",\"model\":\"AI-Thinker ESP32-CAM\",\"camera\":";
  info += cameraOk ? "true" : "false";
  info += ",\"psram\":";
  info += psramFound() ? "true" : "false";
  info += ",\"wifi\":";
  info += wifiUp ? "true" : "false";
  info += ",\"ssid\":" + jsonString(wifiSsid);
  info += ",\"ip\":" + jsonString(wifiUp ? WiFi.localIP().toString() : String());
  if (wifiUp) info += ",\"rssi\":" + String(WiFi.RSSI());
  info += ",\"telegram\":";
  info += telegramReady() ? "true" : "false";
  info += ",\"tgLabel\":" + jsonString(tgLabel);
  info += ",\"schedule\":" + jsonString(scheduleText());
  info += ",\"clock\":";
  info += clockValid() ? "true" : "false";
  info += "}";
  infoChar->setValue(info);
}

/** "7012345678:AAE…": digits, a colon and the secret. */
static bool validToken(const char *t) {
  const char *colon = strchr(t, ':');
  if (!colon || colon - t < 5 || strlen(colon + 1) < 30) return false;
  for (const char *p = t; p < colon; p++)
    if (!isdigit((unsigned char)*p)) return false;
  for (const char *p = colon + 1; *p; p++)
    if (!isalnum((unsigned char)*p) && *p != '_' && *p != '-') return false;
  return true;
}

/** A chat id: an integer, negative for groups and channels. */
static bool validChatId(const char *t) {
  const char *p = *t == '-' ? t + 1 : t;
  if (!*p || strlen(p) > 20) return false;
  for (; *p; p++)
    if (!isdigit((unsigned char)*p)) return false;
  return true;
}

/** "schedule:<days>,<HH:MM>,<offset>". */
static bool saveSchedule(const char *args) {
  unsigned days, hh, mm;
  int offset;
  char end;
  if (sscanf(args, "%u,%u:%u,%d%c", &days, &hh, &mm, &offset, &end) != 4) return false;
  if (days > 127 || hh > 23 || mm > 59 || offset < -720 || offset > 840) return false;
  schedDays = days;
  schedMinute = hh * 60 + mm;
  schedOffset = offset;
  prefs.putUChar("sdays", schedDays);
  prefs.putUShort("stime", schedMinute);
  prefs.putShort("soff", schedOffset);
  skipPastSlots = true;
  nextReportTryAt = millis();
  return true;
}

// ---- Camera ----

/**
 * Start the camera driver. It takes about 43 KB of internal RAM (DMA buffers, its task), which the
 * upload to Telegram needs next to BLE and WiFi, so sendReport() stops it during the upload.
 */
static esp_err_t startCamera() {
  if (cameraRunning) return ESP_OK;
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
  config.frame_size = psramFound() ? PHOTO_SIZE : FRAMESIZE_VGA;  // without PSRAM only VGA fits
  config.jpeg_quality = JPEG_QUALITY;
  config.fb_count = 1;
  config.fb_location = psramFound() ? CAMERA_FB_IN_PSRAM : CAMERA_FB_IN_DRAM;
  config.grab_mode = CAMERA_GRAB_WHEN_EMPTY;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("[camera] start failed: 0x%x (%s)\n", err, esp_err_to_name(err));
    return err;
  }
  cameraRunning = true;
  cameraStartedAt = millis();
  return ESP_OK;
}

static void stopCamera() {
  if (!cameraRunning) return;
  esp_camera_deinit();
  cameraRunning = false;
}

/** A status for the BLE client, or only the serial log for a report nobody over BLE asked for. */
static void reportStatus(const String &status, bool quiet) {
  if (quiet) Serial.printf("[report] %s\n", status.c_str());
  else setStatus(status);
}

/** Take a fresh photo into `jpeg`. Returns false (with a status) if the camera failed. */
static bool takePhoto(bool quiet) {
  if (!cameraOk) {
    reportStatus("error:camera not found, check the ribbon cable", quiet);
    return false;
  }
  if (!quiet) setStatus("capturing");
  esp_err_t err = startCamera();
  if (err != ESP_OK) {
    // Out of memory: the internal RAM is too fragmented to start it again. A restart fixes that,
    // and a scheduled report is then sent late.
    if (err == ESP_ERR_NO_MEM) restartWhenIdle = true;
    reportStatus(err == ESP_ERR_NO_MEM ? "error:out of memory, restart the camera" : "error:the camera did not start, check the ribbon cable", quiet);
    return false;
  }
  // Skip the frame waiting in the buffer (taken at the last request, maybe hours ago) and one more
  // for the exposure; right after a start, keep skipping until the exposure has settled.
  for (int i = 0; i < 2 || millis() - cameraStartedAt < CAMERA_SETTLE_MS; i++) {
    camera_fb_t *old = esp_camera_fb_get();
    if (old) esp_camera_fb_return(old);
  }
  camera_fb_t *fb = esp_camera_fb_get();
  if (!fb) {
    reportStatus("error:capture failed", quiet);
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
    reportStatus("error:out of memory", quiet);
    return false;
  }
  memcpy(jpeg, fb->buf, fb->len);
  jpegLen = fb->len;
  Serial.printf("[camera] %ux%u, %u bytes\n", fb->width, fb->height, (unsigned)jpegLen);
  esp_camera_fb_return(fb);
  return true;
}

// ---- Telegram Bot API over HTTPS ----
// A minimal HTTP/1.1 client: the core's HTTPClient parses cookie dates, which would link libc's
// time functions into the full IRAM.

/** TLS buffers in PSRAM (internal RAM as a fallback): BLE and WiFi need the internal RAM. */
static void *tlsCalloc(size_t n, size_t size) {
  void *p = heap_caps_calloc(n, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  return p ? p : heap_caps_calloc(n, size, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
}

static void tlsFree(void *p) {
  heap_caps_free(p);
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

static bool writeAll(NetworkClient &c, const uint8_t *data, size_t len) {
  for (size_t sent = 0; sent < len;) {
    size_t n = c.write(data + sent, min((size_t)4096, len - sent));
    if (n == 0) return false;
    sent += n;
  }
  return true;
}

static bool writeAll(NetworkClient &c, const String &s) {
  return writeAll(c, (const uint8_t *)s.c_str(), s.length());
}

static String formField(const char *name, const String &value) {
  return String("--" BOUNDARY "\r\nContent-Disposition: form-data; name=\"") + name + "\"\r\n\r\n" + value + "\r\n";
}

/** Telegram's "description" in an error reply. */
static String jsonDescription(const String &body) {
  int start = body.indexOf("\"description\":\"");
  if (start < 0) return String();
  String out;
  for (int i = start + 15; i < (int)body.length(); i++) {
    char c = body[i];
    if (c == '"') break;
    if (c == '\\' && i + 1 < (int)body.length()) c = body[++i];
    out += c;
  }
  return out;
}

/**
 * POST `fields` (form fields from formField()) and an optional JPEG as "photo" to the Bot API
 * method. Returns the HTTP status, or a negative number when Telegram could not be reached, with
 * the reason in `error`. The certificate is checked with the core's root certificate bundle.
 */
static int telegramPost(const char *method, const String &fields, const uint8_t *photo, size_t photoLen, String &error) {
  static NetworkClientSecure *tls = nullptr;
  static bool heapLogged = false;
  if (!tls) {
    tls = new NetworkClientSecure();
    tls->useBuiltinCACertBundle();
  }
  error = "";
  if (!heapLogged) logHeap("before the first TLS handshake");
  if (!tls->connect(TELEGRAM_HOST, 443, 15000)) {
    char buf[100] = "";
    tls->lastError(buf, sizeof(buf));
    error = buf[0] ? buf : "no connection";
    Serial.printf("[telegram] could not connect: %s\n", error.c_str());
    if (!heapLogged) logHeap("after a FAILED TLS handshake");
    return -1;
  }
  if (!heapLogged) {
    heapLogged = true;
    logHeap("after the first TLS handshake");
  }

  String photoHead;
  String tail = "--" BOUNDARY "--\r\n";
  if (photo) {
    photoHead = "--" BOUNDARY "\r\nContent-Disposition: form-data; name=\"photo\"; filename=\"plant.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n";
    tail = "\r\n" + tail;
  }
  size_t contentLength = fields.length() + photoHead.length() + photoLen + tail.length();
  String head = String("POST /bot") + tgToken + "/" + method + " HTTP/1.1\r\nHost: " TELEGRAM_HOST "\r\nUser-Agent: PlantCam/" FIRMWARE_VERSION
                "\r\nConnection: close\r\nContent-Type: multipart/form-data; boundary=" BOUNDARY "\r\nContent-Length: " + String((unsigned)contentLength) + "\r\n\r\n";
  if (!writeAll(*tls, head) || !writeAll(*tls, fields) || !writeAll(*tls, photoHead) || (photo && !writeAll(*tls, photo, photoLen)) || !writeAll(*tls, tail)) {
    tls->stop();
    error = "the upload was cut off";
    return -2;
  }

  uint32_t deadline = millis() + HTTP_TIMEOUT_MS;
  String line;
  if (!readLine(*tls, line, deadline) || !line.startsWith("HTTP/1.")) {
    tls->stop();
    error = "no reply";
    return -3;
  }
  int code = line.substring(9, 12).toInt();
  long bodyLength = -1;
  bool chunked = false;
  while (readLine(*tls, line, deadline) && line.length()) {
    line.toLowerCase();
    if (line.startsWith("content-length:")) bodyLength = line.substring(15).toInt();
    else if (line.startsWith("transfer-encoding:") && line.indexOf("chunked") >= 0) chunked = true;
  }
  String body;
  if (chunked) {
    while (readLine(*tls, line, deadline)) {
      long size = strtol(line.c_str(), nullptr, 16);
      if (size <= 0) break;
      readBody(*tls, body, size, deadline);
      readLine(*tls, line, deadline);  // the CR LF after each chunk
    }
  } else {
    readBody(*tls, body, bodyLength, deadline);
  }
  tls->stop();
  if (code != 200) {
    error = jsonDescription(body);
    if (error.isEmpty()) error = "HTTP " + String(code);
  }
  return code;
}

// ---- Reports ----

/** The photo's caption: camera, local time, and `note` ("Test report", "Sent 20 min late"). */
static String reportCaption(const String &note) {
  String c = "\xF0\x9F\x8C\xB1 ";  // seedling emoji
  c += deviceName;
  c += "\n";
  c += clockValid() ? formatLocal(localMinutes()) + " (" + formatOffset(schedOffset) + ")" : String("Time not known yet");
  if (note.length()) c += "\n" + note;
  c += "\nPhoto only for now: the leaf analysis comes with the next firmware.";
  return c;
}

/**
 * Take a photo and send it to the Telegram chat. `quiet` (a scheduled report) shows the progress
 * in the serial log only. REPORT_REFUSED means trying again would not help (wrong token or chat,
 * or a broken camera, which the chat is told about).
 */
static ReportResult sendReport(bool quiet, const String &note) {
  if (!telegramReady()) {
    reportStatus("error:Telegram is not set up", quiet);
    return REPORT_REFUSED;
  }
  if (WiFi.status() != WL_CONNECTED) {
    reportStatus("error:the camera is not on WiFi", quiet);
    return REPORT_FAILED;
  }
  String error;
  if (!takePhoto(quiet)) {
    if (restartWhenIdle) return REPORT_FAILED;  // out of memory: sent after the restart
    // Tell the chat, so a broken camera does not go unnoticed.
    telegramPost("sendMessage", formField("chat_id", tgChat) + formField("text", String(deviceName) + ": the camera could not take the photo. Check the ribbon cable, then restart the camera."), nullptr, 0, error);
    return REPORT_REFUSED;
  }
  if (!quiet) setStatus("sending");
  stopCamera();  // its internal RAM goes to WiFi and TCP during the upload
  int code = telegramPost("sendPhoto", formField("chat_id", tgChat) + formField("caption", reportCaption(note)), jpeg, jpegLen, error);
  Serial.printf("[telegram] sendPhoto, %u bytes: %d %s\n", (unsigned)jpegLen, code, error.c_str());
  if (startCamera() != ESP_OK) restartWhenIdle = true;
  logHeap("after the report");
  if (code == 200) {
    if (!quiet) setStatus("ready");
    return REPORT_SENT;
  }
  reportStatus(code < 0 ? "error:could not reach Telegram (" + error + ")" : "error:Telegram: " + error, quiet);
  return code >= 400 && code < 500 && code != 429 ? REPORT_REFUSED : REPORT_FAILED;
}

/** The latest scheduled time at or before `nowMin` (local minutes since 1970), or 0 if none this week. */
static uint32_t latestSlot(int64_t nowMin) {
  int64_t today = nowMin / 1440;
  for (int k = 0; k <= 7; k++) {
    int64_t day = today - k;
    if (!(schedDays & (1 << weekday(day)))) continue;
    int64_t slot = day * 1440 + schedMinute;
    if (slot <= nowMin) return (uint32_t)slot;
  }
  return 0;
}

static void markHandled(uint32_t slot) {
  lastSlot = slot;
  prefs.putUInt("lastslot", lastSlot);
}

/** Called from loop(): send the report when a scheduled time is due, once per time. */
static void serviceSchedule() {
  if (!schedDays || !clockValid()) return;
  int64_t now = localMinutes();
  uint32_t slot = latestSlot(now);
  if (skipPastSlots) {
    skipPastSlots = false;
    if (slot > lastSlot) markHandled(slot);
    return;
  }
  if (!slot || slot <= lastSlot) return;
  int32_t late = (int32_t)(now - slot);
  if (late > LATE_LIMIT_MIN) return;  // missed while the camera was off, and too long ago now
  if (!telegramReady() || WiFi.status() != WL_CONNECTED || (int32_t)(millis() - nextReportTryAt) < 0) return;

  String note;
  if (late > LATE_AFTER_MIN) {
    char at[8];
    snprintf(at, sizeof(at), "%u:%02u", schedMinute / 60, schedMinute % 60);
    note = "Sent " + String(late) + " min late: the camera was off or offline at " + at + ".";
  }
  Serial.printf("[report] scheduled for %s\n", formatLocal(slot).c_str());
  ReportResult result = sendReport(true, note);
  if (result == REPORT_FAILED) nextReportTryAt = millis() + REPORT_RETRY_MS;
  else markHandled(slot);
}

// ---- WiFi ----

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

/** "wifi:connect": join the saved WiFi (two tries), and say why if it fails. */
static void connectWifi() {
  if (wifiSsid.isEmpty()) {
    setStatus("error:no WiFi name saved");
    return;
  }
  if (WiFi.status() == WL_CONNECTED && WiFi.SSID() == wifiSsid && !wifiDirty) {
    updateInfo();
    setStatus("ready");
    return;
  }
  for (int attempt = 1; attempt <= WIFI_ATTEMPTS; attempt++) {
    setStatus("connecting");  // also restarts the web app's timer
    WiFi.disconnect();
    delay(200);
    beginWifi();
    uint32_t start = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_ATTEMPT_MS) delay(100);
    if (WiFi.status() == WL_CONNECTED) break;
    Serial.printf("[wifi] attempt %d: %s (reason %u)\n", attempt, wifiFailure(lastDisconnectReason), lastDisconnectReason);
    if (strcmp(wifiFailure(lastDisconnectReason), "wrong password") == 0) break;  // another try will not help
  }
  wifiDirty = false;
  updateInfo();
  if (WiFi.status() != WL_CONNECTED) {
    wifiWasUp = false;
    wifiDownSince = millis();  // the 30-minute restart counts from now
    setStatus(String("error:") + wifiFailure(lastDisconnectReason));
    return;
  }
  Serial.printf("[wifi] joined %s, IP %s, %d dBm\n", wifiSsid.c_str(), WiFi.localIP().toString().c_str(), WiFi.RSSI());
  wifiWasUp = true;
  startClock();
  updateInfo();
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

/** Called from loop(): keep the WiFi up, start the clock, restart after a long outage. */
static void serviceWifi() {
  if (wifiSsid.isEmpty()) return;
  uint32_t now = millis();
  if (WiFi.status() != WL_CONNECTED) {
    if (wifiWasUp) {
      wifiWasUp = false;
      wifiDownSince = now;
      Serial.println("[wifi] connection lost, reconnecting");
      updateInfo();
    }
    if (!connected && now - wifiDownSince > RESTART_AFTER_MS) {
      Serial.println("[wifi] offline for 30 minutes, restarting");
      delay(100);
      ESP.restart();
    }
    if (now - lastWifiAttemptAt > WIFI_RETRY_MS) beginWifi();
    return;
  }
  if (!wifiWasUp) {
    wifiWasUp = true;
    Serial.printf("[wifi] connected to %s, IP %s, %d dBm\n", wifiSsid.c_str(), WiFi.localIP().toString().c_str(), WiFi.RSSI());
    logHeap("WiFi up");
    startClock();
    updateInfo();
  }
}

/** Called from loop(): note when the time first arrives from the internet. */
static void serviceClock() {
  if (clockWasValid || !clockValid()) return;
  clockWasValid = true;
  Serial.printf("[clock] %s (%s)\n", formatLocal(localMinutes()).c_str(), formatOffset(schedOffset).c_str());
  updateInfo();
}

// ---- BLE ----

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *, esp_ble_gatts_cb_param_t *) override {
    connected = true;
    Serial.println("[ble] connected");
  }
  void onDisconnect(BLEServer *, esp_ble_gatts_cb_param_t *) override {
    connected = false;
    Serial.println("[ble] disconnected");
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

/** Save one setting from a "name:value" command. */
static void saveSetting(const char *key, String &target, const char *value) {
  target = value;
  target.trim();
  prefs.putString(key, target);
}

static void handleCommand(const char *text) {
  // The WiFi password and the bot token stay out of the serial log.
  if (strncmp(text, "wifi-pass:", 10) == 0 || strncmp(text, "tg-token:", 9) == 0) Serial.printf("[cmd] %.*s***\n", (int)(strchr(text, ':') - text + 1), text);
  else Serial.printf("[cmd] %s\n", text);

  if (strcmp(text, "info") == 0) {
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
  } else if (strcmp(text, "wifi:connect") == 0) {
    connectWifi();
  } else if (strcmp(text, "wifi:forget") == 0) {
    forgetWifi();
  } else if (strncmp(text, "tg-token:", 9) == 0) {
    if (!validToken(text + 9)) return setStatus("error:that is not a Telegram bot token");
    saveSetting("tgtoken", tgToken, text + 9);
    updateInfo();
    setStatus("ready");
  } else if (strncmp(text, "tg-chat:", 8) == 0) {
    if (!validChatId(text + 8)) return setStatus("error:that is not a Telegram chat id");
    saveSetting("tgchat", tgChat, text + 8);
    updateInfo();
    setStatus("ready");
  } else if (strncmp(text, "tg-label:", 9) == 0) {
    saveSetting("tglabel", tgLabel, text + 9);
    if (tgLabel.length() > MAX_LABEL_BYTES) tgLabel.remove(MAX_LABEL_BYTES);
    updateInfo();
    setStatus("ready");
  } else if (strncmp(text, "schedule:", 9) == 0) {
    if (!saveSchedule(text + 9)) return setStatus("error:the schedule must look like 62,07:00,480");
    updateInfo();
    setStatus("ready");
  } else if (strcmp(text, "report") == 0) {
    sendReport(false, "Test report");
  } else {
    setStatus("error:unknown command");
  }
}

void setup() {
  Serial.begin(115200);
  Serial.println("\n[plantcam] firmware " FIRMWARE_VERSION);
  // Before any TLS: its buffers (about 40 KB) go to PSRAM instead of the internal RAM.
  if (psramFound()) mbedtls_platform_set_calloc_free(tlsCalloc, tlsFree);
  pinMode(LED_GPIO_NUM, OUTPUT);
  digitalWrite(LED_GPIO_NUM, LOW);  // the flash LED stays off
  commands = xQueueCreate(8, sizeof(Command));

  prefs.begin("plantcam", false);
  for (const char *old : {"server", "key", "frame", "led"}) prefs.remove(old);  // firmware 2 settings
  wifiSsid = prefs.getString("ssid", "");
  wifiPass = prefs.getString("pass", "");
  tgToken = prefs.getString("tgtoken", "");
  tgChat = prefs.getString("tgchat", "");
  tgLabel = prefs.getString("tglabel", "");
  schedDays = prefs.getUChar("sdays", 0);
  schedMinute = prefs.getUShort("stime", 7 * 60);
  schedOffset = prefs.getShort("soff", 0);
  lastSlot = prefs.getUInt("lastslot", 0);

  logHeap("start");
  cameraOk = startCamera() == ESP_OK;
  Serial.printf("[camera] %s, PSRAM %s\n", cameraOk ? "ok" : "FAILED", psramFound() ? "yes" : "no");
  logHeap("camera on");

  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_BT);
  snprintf(deviceName, sizeof(deviceName), "PlantCam-%02X%02X", mac[4], mac[5]);

  BLEDevice::init(deviceName);
  BLEDevice::setMTU(ESP_GATT_MAX_MTU_SIZE);  // the Info JSON is read in one go
  server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());
  server->advertiseOnDisconnect(true);

  BLEService *service = server->createService(BLEUUID(SERVICE_UUID), 12);
  BLECharacteristic *control = service->createCharacteristic(CONTROL_UUID, BLECharacteristic::PROPERTY_WRITE);
  control->setCallbacks(new ControlCallbacks());
  statusChar = service->createCharacteristic(STATUS_UUID, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  statusChar->addDescriptor(new BLE2902());
  infoChar = service->createCharacteristic(INFO_UUID, BLECharacteristic::PROPERTY_READ);
  updateInfo();
  statusChar->setValue(cameraOk ? "ready" : "error:camera not found, check the ribbon cable");
  service->start();

  BLEAdvertising *advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->setScanResponse(true);  // the name goes in the scan response when it does not fit
  BLEDevice::startAdvertising();
  Serial.printf("[ble] advertising as %s\n", deviceName);

  WiFi.onEvent(onWifiEvent);
  logHeap("BLE running");
  Serial.printf("[telegram] %s, schedule %s\n", telegramReady() ? tgLabel.c_str() : "not set up", schedDays ? scheduleText().c_str() : "not set");
  if (wifiSsid.length()) {
    Serial.printf("[wifi] joining %s\n", wifiSsid.c_str());
    wifiDownSince = millis();
    beginWifi();
  } else {
    Serial.println("[wifi] not set up: use the setup page");
  }
}

/** The same commands typed in the serial monitor (one per line), plus "heap". */
static void serviceSerial() {
  static String line;
  while (Serial.available()) {
    char c = Serial.read();
    if (c != '\n' && c != '\r') {
      if (line.length() < sizeof(Command::text) - 1) line += c;
      continue;
    }
    if (line == "heap") logHeap("now");
    else if (line.length()) handleCommand(line.c_str());
    line = "";
  }
}

void loop() {
  Command cmd;
  if (xQueueReceive(commands, &cmd, pdMS_TO_TICKS(100)) == pdTRUE) handleCommand(cmd.text);
  serviceSerial();
  serviceWifi();
  serviceClock();
  serviceSchedule();
  if (restartWhenIdle && !connected) {
    Serial.println("[plantcam] out of memory, restarting");
    delay(100);
    ESP.restart();
  }
}

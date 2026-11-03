#include <Arduino.h>
#include <Wire.h>
#include <hd44780.h>
#include <hd44780ioClass/hd44780_I2Cexp.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <time.h>

#define SOIL_RX 16
#define SOIL_TX 17
#define AIR_RX 4
#define AIR_TX 18
#define SDA_PIN 21
#define SCL_PIN 22
#define SENSOR_BAUD 9600
#define RESPONSE_TIMEOUT_MS 300
#define READ_INTERVAL_MS 250
#define RETRY_COUNT 3
#define SOIL_FAIL_LIMIT 5
#define AIR_FAIL_LIMIT 5
#define LCD_COLS 20
#define LCD_ROWS 4

#define SOIL_SLAVE_ID 0x01
#define SOIL_FUNC 0x03
#define SOIL_REG_START 0x0000
#define SOIL_REG_COUNT 0x0001

#define AIR_SLAVE_ID 0x01
#define AIR_FUNC 0x04
#define AIR_REG_START 0x0001
#define AIR_REG_COUNT 0x0002

#define RELAY1_PIN 25
#define RELAY2_PIN 26
#define RELAY3_PIN 27
#define RELAY_ACTIVE_LOW false

#define WIFI_SSID "sigmaboy"
#define WIFI_PASS "akuanakhamidah"
#define MQTT_HOST "w001eaad.ala.asia-southeast1.emqxsl.com"
#define MQTT_PORT 8883
#define MQTT_USER "rahseey"
#define MQTT_PASS "040896"
#define MQTT_TLS 1
#define PREFIX "rahseey"

#if MQTT_TLS
#include <WiFiClientSecure.h>
WiFiClientSecure net;
#else
WiFiClient net;
#endif

PubSubClient mqtt(net);
Preferences prefs;
hd44780_I2Cexp lcd;

float soilHumidity = 0;
float airTemperature = 0;
float airHumidity = 0;
bool soilValid = false;
bool airValid = false;
bool airHumValid = false;
bool lcdOk = false;
bool relay1On = false;
bool relay2On = false;
bool relay3On = false;
uint8_t soilFail = 0;
uint8_t airFail = 0;
unsigned long lastRead = 0;
unsigned long lastPublish = 0;
unsigned long lastReconnect = 0;
bool publishNow = false;
bool autoMode = true;
float spSoilHumMin = 25.0;
float spAirHumMin = 40.0;
float spAirTempMax = 29.0;

String topicOf(const String &sub) { return String(PREFIX) + "/" + sub; }

uint16_t modbusCRC16(const uint8_t *buf, size_t len) {
  uint16_t crc = 0xFFFF;
  for (size_t i = 0; i < len; i++) {
    crc ^= buf[i];
    for (uint8_t b = 0; b < 8; b++) {
      if (crc & 0x0001) {
        crc = (crc >> 1) ^ 0xA001;
      } else {
        crc >>= 1;
      }
    }
  }
  return crc;
}

bool readModbusOnce(HardwareSerial &port, uint8_t slave, uint8_t func, uint16_t start, uint16_t count, uint16_t *out) {
  uint8_t req[8];
  req[0] = slave;
  req[1] = func;
  req[2] = (start >> 8) & 0xFF;
  req[3] = start & 0xFF;
  req[4] = (count >> 8) & 0xFF;
  req[5] = count & 0xFF;
  uint16_t crc = modbusCRC16(req, 6);
  req[6] = crc & 0xFF;
  req[7] = (crc >> 8) & 0xFF;

  while (port.available()) {
    port.read();
  }

  port.write(req, sizeof(req));
  port.flush();

  size_t respLen = 5 + count * 2;
  uint8_t buf[64];
  size_t idx = 0;
  unsigned long startTime = millis();

  while ((millis() - startTime) < RESPONSE_TIMEOUT_MS) {
    while (port.available() && idx < sizeof(buf)) {
      buf[idx++] = (uint8_t)port.read();
    }

    if (idx >= respLen) {
      for (size_t i = 0; i + respLen <= idx; i++) {
        if (buf[i] == slave && buf[i + 1] == func && buf[i + 2] == count * 2) {
          uint16_t crcCalc = modbusCRC16(&buf[i], respLen - 2);
          uint16_t crcRecv = buf[i + respLen - 2] | (buf[i + respLen - 1] << 8);
          if (crcCalc == crcRecv) {
            for (uint16_t k = 0; k < count; k++) {
              out[k] = ((uint16_t)buf[i + 3 + k * 2] << 8) | buf[i + 4 + k * 2];
            }
            return true;
          }
        }
      }
    }
  }

  return false;
}

bool readModbus(HardwareSerial &port, uint8_t slave, uint8_t func, uint16_t start, uint16_t count, uint16_t *out) {
  for (uint8_t i = 0; i < RETRY_COUNT; i++) {
    if (readModbusOnce(port, slave, func, start, count, out)) {
      return true;
    }
    delay(20);
  }
  return false;
}

void readSoil() {
  uint16_t regs[SOIL_REG_COUNT];
  bool ok = readModbus(Serial2, SOIL_SLAVE_ID, SOIL_FUNC, SOIL_REG_START, SOIL_REG_COUNT, regs);

  if (ok) {
    soilHumidity = regs[0] / 10.0;
    soilValid = true;
    soilFail = 0;
  } else {
    if (soilFail < 255) {
      soilFail++;
    }
    if (soilFail >= SOIL_FAIL_LIMIT) {
      soilValid = false;
    }
  }
}

void readAir() {
  uint16_t regs[AIR_REG_COUNT];
  bool ok = readModbus(Serial1, AIR_SLAVE_ID, AIR_FUNC, AIR_REG_START, AIR_REG_COUNT, regs);

  if (ok) {
    airTemperature = (int16_t)regs[0] / 10.0;
    airHumidity = regs[1] / 10.0;
    airValid = true;
    airHumValid = (airHumidity >= 0.0 && airHumidity <= 100.0);
    airFail = 0;
  } else {
    if (airFail < 255) {
      airFail++;
    }
    if (airFail >= AIR_FAIL_LIMIT) {
      airValid = false;
      airHumValid = false;
    }
  }
}

void writeRelay(uint8_t pin, bool on) {
  digitalWrite(pin, (on ^ RELAY_ACTIVE_LOW) ? HIGH : LOW);
}

void updateRelays() {
  if (autoMode) {
    if (soilValid) {
      if (soilHumidity < spSoilHumMin) relay1On = true;
      else if (soilHumidity > spSoilHumMin + 6.0f) relay1On = false;
    } else {
      relay1On = false;
    }

    if (airValid && airHumValid) {
      if (airHumidity < spAirHumMin) relay2On = true;
      else if (airHumidity > spAirHumMin + 5.0f) relay2On = false;
    } else {
      relay2On = false;
    }

    if (airValid) {
      if (airTemperature > spAirTempMax) relay3On = true;
      else if (airTemperature < spAirTempMax - 1.0f) relay3On = false;
    } else {
      relay3On = false;
    }
  }

  writeRelay(RELAY1_PIN, relay1On);
  writeRelay(RELAY2_PIN, relay2On);
  writeRelay(RELAY3_PIN, relay3On);
}

void saveConfig() {
  prefs.putBool("auto", autoMode);
  prefs.putFloat("hum", spAirHumMin);
  prefs.putFloat("soil", spSoilHumMin);
  prefs.putFloat("temp", spAirTempMax);
}

void publishTelemetry() {
  if (!mqtt.connected()) return;
  JsonDocument doc;
  time_t now = time(nullptr);
  doc["ts"] = now > 1600000000 ? (long)now : (long)(millis() / 1000);
  doc["air_temp"] = !airValid ? 0.0f : roundf(airTemperature * 10) / 10;
  doc["air_hum"] = !(airValid && airHumValid) ? 0.0f : roundf(airHumidity * 10) / 10;
  doc["soil_hum"] = !soilValid ? 0.0f : roundf(soilHumidity * 10) / 10;
  doc["air_valid"] = airValid;
  doc["soil_valid"] = soilValid;
  JsonObject r = doc["relays"].to<JsonObject>();
  r["relay1"] = relay1On;
  r["relay2"] = relay2On;
  r["relay3"] = relay3On;
  doc["mode"] = autoMode ? "AUTO" : "MANUAL";
  JsonObject sp = doc["setpoints"].to<JsonObject>();
  sp["air_hum_min"] = spAirHumMin;
  sp["soil_hum_min"] = spSoilHumMin;
  sp["air_temp_max"] = spAirTempMax;
  doc["rssi"] = WiFi.RSSI();
  doc["uptime"] = (long)(millis() / 1000);
  char buf[512];
  size_t n = serializeJson(doc, buf, sizeof(buf));
  mqtt.publish(topicOf("telemetry").c_str(), (const uint8_t *)buf, n, true);
}

void onMessage(char *topic, byte *payload, unsigned int len) {
  String t(topic);
  String body;
  for (unsigned int i = 0; i < len; i++) body += (char)payload[i];
  body.trim();

  String relayPrefix = topicOf("cmd/relay/");
  if (t.startsWith(relayPrefix)) {
    if (autoMode) return;
    String name = t.substring(relayPrefix.length());
    if (name == "relay1") {
      if (body == "ON") relay1On = true;
      else if (body == "OFF") relay1On = false;
      else return;
    } else if (name == "relay2") {
      if (body == "ON") relay2On = true;
      else if (body == "OFF") relay2On = false;
      else return;
    } else if (name == "relay3") {
      if (body == "ON") relay3On = true;
      else if (body == "OFF") relay3On = false;
      else return;
    } else {
      return;
    }
    updateRelays();
    publishNow = true;
  } else if (t == topicOf("cmd/mode")) {
    if (body == "AUTO") autoMode = true;
    else if (body == "MANUAL") autoMode = false;
    else return;
    saveConfig();
    publishNow = true;
  } else if (t == topicOf("cmd/setpoint")) {
    JsonDocument doc;
    if (deserializeJson(doc, body)) return;
    JsonVariant v;
    v = doc["air_hum_min"];
    if (v.is<float>() && v.as<float>() >= 0 && v.as<float>() <= 100) spAirHumMin = v.as<float>();
    v = doc["soil_hum_min"];
    if (v.is<float>() && v.as<float>() >= 0 && v.as<float>() <= 100) spSoilHumMin = v.as<float>();
    v = doc["air_temp_max"];
    if (v.is<float>() && v.as<float>() >= 10 && v.as<float>() <= 50) spAirTempMax = v.as<float>();
    saveConfig();
    publishNow = true;
  }
}

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  static unsigned long lastAttempt = 0;
  if (millis() - lastAttempt < 10000 && WiFi.status() != WL_DISCONNECTED) return;
  lastAttempt = millis();

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
}

void connectMqtt() {
  if (mqtt.connected() || WiFi.status() != WL_CONNECTED) return;
  if (millis() - lastReconnect < 5000) return;
  lastReconnect = millis();
  String clientId = "gh-esp32-" + String((uint32_t)ESP.getEfuseMac(), HEX);
  String statusTopic = topicOf("status");
  bool ok = mqtt.connect(clientId.c_str(), strlen(MQTT_USER) ? MQTT_USER : nullptr, strlen(MQTT_PASS) ? MQTT_PASS : nullptr,
                         statusTopic.c_str(), 1, true, "offline");
  if (ok) {
    mqtt.publish(statusTopic.c_str(), "online", true);
    mqtt.subscribe(topicOf("cmd/#").c_str(), 1);
    publishNow = true;
  }
}

void printLine(uint8_t row, const char *text) {
  if (!lcdOk) {
    return;
  }
  char buf[LCD_COLS + 1];
  snprintf(buf, sizeof(buf), "%-*s", LCD_COLS, text);
  lcd.setCursor(0, row);
  lcd.print(buf);
}

void showData() {
  char l1[32];
  char l2[32];
  char l3[32];
  char l4[32];

  if (soilValid) {
    snprintf(l1, sizeof(l1), "Tanah Hum:%5.1f%%", soilHumidity);
  } else {
    snprintf(l1, sizeof(l1), "Tanah Hum: ERROR");
  }

  if (airValid) {
    snprintf(l2, sizeof(l2), "Ruang Suhu:%5.1fC", airTemperature);
    if (airHumValid) {
      snprintf(l3, sizeof(l3), "Ruang Hum :%5.1f%%", airHumidity);
    } else {
      snprintf(l3, sizeof(l3), "Ruang Hum : ---");
    }
  } else {
    snprintf(l2, sizeof(l2), "Ruang Suhu: ERROR");
    snprintf(l3, sizeof(l3), "Ruang Hum : ERROR");
  }

  snprintf(l4, sizeof(l4), "R1:%-3s R2:%-3s R3:%-3s",
           relay1On ? "ON" : "OFF",
           relay2On ? "ON" : "OFF",
           relay3On ? "ON" : "OFF");

  printLine(0, l1);
  printLine(1, l2);
  printLine(2, l3);
  printLine(3, l4);
}

void setup() {
  pinMode(RELAY1_PIN, OUTPUT);
  pinMode(RELAY2_PIN, OUTPUT);
  pinMode(RELAY3_PIN, OUTPUT);
  writeRelay(RELAY1_PIN, false);
  writeRelay(RELAY2_PIN, false);
  writeRelay(RELAY3_PIN, false);

  Serial.begin(115200);
  Serial2.begin(SENSOR_BAUD, SERIAL_8N1, SOIL_RX, SOIL_TX);
  Serial1.begin(SENSOR_BAUD, SERIAL_8N1, AIR_RX, AIR_TX);
  Wire.begin(SDA_PIN, SCL_PIN);
  Wire.setClock(100000);
  delay(1000);

  int status = lcd.begin(LCD_COLS, LCD_ROWS);
  if (status) {
    lcdOk = false;
  } else {
    lcdOk = true;
    lcd.backlight();
    lcd.clear();
    printLine(0, "Soil + Air Sensor");
    printLine(1, "Memulai...");
    delay(1500);
    lcd.clear();
  }

  prefs.begin("gh", false);
  autoMode = prefs.getBool("auto", true);
  spAirHumMin = prefs.getFloat("hum", 40.0);
  spSoilHumMin = prefs.getFloat("soil", 25.0);
  spAirTempMax = prefs.getFloat("temp", 29.0);

  connectWifi();
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");

#if MQTT_TLS
  net.setInsecure();
#endif
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMessage);
  mqtt.setBufferSize(768);
  mqtt.setKeepAlive(20);

  lastRead = millis();
}

void loop() {
  connectWifi();
  connectMqtt();
  mqtt.loop();

  unsigned long now = millis();

  if (now - lastRead >= READ_INTERVAL_MS) {
    lastRead = now;
    readSoil();
    readAir();
    updateRelays();
    showData();
  }

  if (publishNow || now - lastPublish >= 5000) {
    publishNow = false;
    lastPublish = now;
    publishTelemetry();
  }
}
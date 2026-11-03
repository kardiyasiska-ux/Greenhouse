# Kontrol Greenhouse

Dashboard web untuk sistem greenhouse ESP32 + MQTT. HTML, CSS, dan JavaScript tanpa build step.

```
greenhouse/
├── index.html
├── css/style.css
├── js/
│   ├── config.js
│   ├── mqtt-client.js
│   ├── state.js
│   ├── ui.js
│   ├── charts.js
│   ├── demo.js
│   └── app.js
├── firmware/greenhouse_esp32/greenhouse_esp32.ino
└── README.md
```

## Menjalankan

1. Buka folder `greenhouse` di VS Code, pasang ekstensi Live Server.
2. Klik kanan `index.html`, pilih Open with Live Server.
3. Secara bawaan dashboard berjalan di mode demo (data simulasi, tanpa broker).

## Membuka dari HP

1. HP dan komputer harus satu Wi-Fi.
2. Cari IP komputer (`ipconfig` di Windows, `ifconfig` di macOS/Linux), misalnya `192.168.1.20`.
3. Di HP buka `http://192.168.1.20:5500` (port Live Server).
4. Jika tidak terbuka, izinkan port 5500 di firewall komputer.

## Mengisi broker

Buka Pengaturan (ikon roda gigi), matikan Mode demo, lalu isi:

| Kolom | Isi |
|---|---|
| Host broker | alamat broker, tanpa `ws://` |
| Port | port WebSocket broker (bukan 1883) |
| Path | umumnya `/mqtt` |
| TLS | nyalakan jika memakai `wss` |
| Username / Password | jika broker meminta |
| Prefix topik | harus sama dengan `PREFIX` di firmware |

Pengaturan disimpan di localStorage browser, tidak ada kredensial di kode.

Halaman yang dibuka lewat `https://` hanya boleh memakai `wss`. Dari `http://` (Live Server) boleh `ws` maupun `wss`.

## Firmware ESP32

Pustaka Arduino: PubSubClient, ArduinoJson 7, DHT sensor library (Adafruit), Adafruit Unified Sensor. Ganti bagian di antara `GANTI BAGIAN INI` pada file `.ino`, lalu unggah ke ESP32.

Broker harus mengaktifkan TCP (ESP32) dan WebSocket (web) sekaligus, misalnya Mosquitto, EMQX, atau HiveMQ.

## Kontrak MQTT

Prefix bawaan `gh01`: `gh01/telemetry`, `gh01/status`, `gh01/cmd/relay/{humidifier|irrigation|cooling|pump}`, `gh01/cmd/mode`, `gh01/cmd/setpoint`.

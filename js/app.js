import { STORAGE, RELAYS, LIMITS } from "./config.js";
import { createStore, parseTelemetry, deviceOnline } from "./state.js";
import { createMqttLink } from "./mqtt-client.js";
import { createDemoLink } from "./demo.js";
import { createUi, isoLocal } from "./ui.js";

const store = createStore();
let link = null;
let ui = null;

const labelOf = (key) => (RELAYS.find((r) => r.key === key) || { label: key }).label;

function evaluateAlarms() {
  const s = store.state;
  const t = s.telemetry;
  const online = deviceOnline(s);
  const tempMax = t ? t.setpoints.air_temp_max : null;
  const conditions = [
    {
      type: "device_offline",
      active: s.conn === "connected" && (s.device === "offline" || (s.lastTelemetryAt !== null && !online)),
      msg: "Perangkat offline",
    },
    { type: "sensor_air_hum", active: online && Boolean(t && t.air_hum_fault), msg: "Sensor kelembaban ruang fault: nilai tidak valid" },
    { type: "sensor_soil_hum", active: online && Boolean(t && t.soil_hum_fault), msg: "Sensor kelembaban tanah fault: nilai tidak valid" },
    { type: "sensor_air_temp", active: online && Boolean(t && t.air_temp_fault), msg: "Sensor suhu ruang fault: nilai tidak valid" },
    {
      type: "temp_high",
      active: online && Boolean(t) && t.air_temp !== null && tempMax !== null && t.air_temp > tempMax,
      msg: t && t.air_temp !== null ? `Suhu ruang ${t.air_temp.toFixed(1)} °C melewati batas ${tempMax} °C` : "Suhu ruang melewati batas",
    },
  ];
  const raised = store.syncAlarms(conditions, s.now);
  if (raised.length) ui.announce(raised.map((a) => a.msg).join(". "));
}

function onConn(conn, info) {
  const prev = store.state.conn;
  store.setConn(conn, info);
  if (conn !== prev) {
    const text = { connected: "Terhubung ke broker", reconnecting: "Koneksi broker terputus", error: "Koneksi broker gagal", connecting: "Menghubungkan ke broker" }[conn];
    if (text && !(conn === "connecting" && prev === "reconnecting")) store.logEvent(info && conn !== "connected" ? `${text}: ${info}` : text, conn === "connected" ? "info" : "warn");
  }
}

function onMessage(sub, payload, retained = false) {
  if (sub === "status") {
    store.setDevice(payload.trim());
    evaluateAlarms();
    return;
  }
  if (sub !== "telemetry") return;
  const t = parseTelemetry(payload);
  if (!t) {
    store.logEvent("Telemetri tidak valid diabaikan", "warn");
    store.notify();
    return;
  }
  const now = Date.now();
  const at = retained && t.ts !== null && t.ts > 1.6e9 ? Math.min(now, t.ts * 1000) : now;
  if (store.state.device === "unknown" && now - at <= LIMITS.offlineAfterMs) store.setDevice("online");
  store.state.now = now;
  store.ingestTelemetry(t, at);
  evaluateAlarms();
}

function startLink() {
  if (link) link.stop();
  const s = store.state.settings;
  store.resetLive();
  store.clearHistory();
  if (s.demo) {
    link = createDemoLink({ onMessage, onConn });
    for (const p of link.prefill(6, 5)) {
      const t = parseTelemetry(p.raw);
      if (t) store.addHistory(p.at, t);
    }
  } else {
    store.loadHistory();
    link = createMqttLink({ settings: s, onMessage, onConn });
  }
  link.start();
}

function send(sub, payload, okMsg) {
  if (link && link.publish(sub, payload)) {
    store.logEvent(okMsg, "cmd");
    return true;
  }
  store.logEvent("Perintah gagal dikirim: tidak terhubung ke broker", "warn");
  store.notify();
  return false;
}

const handlers = {
  onRelay(key, on) {
    const target = on ? "ON" : "OFF";
    if (send(`cmd/relay/${key}`, target, `Perintah dikirim: ${labelOf(key)} ${target}`)) store.setPendingRelay(key, target);
  },
  async onMode(target) {
    const t = store.state.telemetry;
    if (t && t.mode === target) return;
    if (!(await ui.confirmMode(target))) return;
    if (send("cmd/mode", target, `Perintah dikirim: mode ${target}`)) store.setPendingMode(target);
  },
  onSetpoints(values) {
    if (send("cmd/setpoint", JSON.stringify(values), `Perintah dikirim: setpoint ${JSON.stringify(values)}`)) store.setPendingSetpoints(values);
  },
  onAck: (id) => store.ack(id),
  onRange: (min) => store.setRange(min),
  onCsv() {
    const from = Date.now() - store.state.rangeMin * 60e3;
    const rows = store.state.history.filter((p) => p.t >= from);
    const cell = (v) => (v === null ? "" : v);
    const lines = ["timestamp,air_temp_c,air_hum_rh,soil_hum_pct"];
    for (const p of rows) lines.push(`${new Date(p.t).toISOString()},${cell(p.air_temp)},${cell(p.air_hum)},${cell(p.soil_hum)}`);
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `greenhouse-${isoLocal(Date.now()).replace(/[:]/g, "-")}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
  onTheme() {
    const root = document.documentElement;
    const next = root.dataset.theme === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try {
      localStorage.setItem(STORAGE.theme, next);
    } catch {}
    ui.applyTheme();
  },
  onSettings(next) {
    store.setSettings(next);
    startLink();
  },
};

ui = createUi(store, handlers);
store.subscribe((s) => ui.render(s));

setInterval(() => {
  store.state.now = Date.now();
  store.expirePending(store.state.now);
  evaluateAlarms();
  store.notify();
}, 1000);

function persist() {
  if (!store.state.settings.demo) store.saveHistory();
}
setInterval(persist, 30000);
addEventListener("pagehide", persist);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") persist();
});

startLink();
if (!store.state.settings.demo && !store.state.settings.host) ui.openSettings();

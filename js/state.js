import { STORAGE, DEFAULT_SETTINGS, RELAYS, LIMITS, SENSORS } from "./config.js";

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const bool = (v) => (typeof v === "boolean" ? v : null);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

export function loadSettings() {
  const s = readJson(STORAGE.settings, {});
  return { ...DEFAULT_SETTINGS, ...(isObj(s) ? s : {}) };
}
export function saveSettings(s) {
  writeJson(STORAGE.settings, s);
}

export function parseTelemetry(raw) {
  let d;
  try {
    d = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(d)) return null;
  const airValidFlag = bool(d.air_valid) !== false;
  const soilValidFlag = bool(d.soil_valid) !== false;
  let airTemp = num(d.air_temp);
  if (airTemp !== null && (airTemp < -40 || airTemp > 80)) airTemp = null;
  let airHum = num(d.air_hum);
  const airFault = !airValidFlag || airHum === null || airHum < 0 || airHum > 100;
  if (airFault) airHum = null;
  let soil = num(d.soil_hum);
  const soilFault = !soilValidFlag || soil === null || soil < 0 || soil > 100;
  if (soilFault) soil = null;
  const relays = {};
  const r = isObj(d.relays) ? d.relays : {};
  for (const { key } of RELAYS) relays[key] = bool(r[key]);
  const sp = isObj(d.setpoints) ? d.setpoints : {};
  const mode = d.mode === "AUTO" || d.mode === "MANUAL" ? d.mode : null;
  return {
    ts: num(d.ts),
    air_temp: airTemp,
    air_hum: airHum,
    soil_hum: soil,
    air_temp_fault: airTemp === null,
    air_hum_fault: airFault,
    soil_hum_fault: soilFault,
    relays,
    mode,
    setpoints: {
      air_hum_min: num(sp.air_hum_min),
      soil_hum_min: num(sp.soil_hum_min),
      air_temp_max: num(sp.air_temp_max),
    },
    rssi: num(d.rssi),
    uptime: num(d.uptime),
  };
}

export function createStore() {
  const listeners = new Set();
  const state = {
    settings: loadSettings(),
    conn: "idle",
    connInfo: "",
    device: "unknown",
    lastTelemetryAt: null,
    telemetry: null,
    relaySince: {},
    pendingRelay: {},
    pendingMode: null,
    pendingSetpoints: null,
    history: [],
    rangeMin: 60,
    alarms: [],
    events: [],
    now: Date.now(),
  };
  let alarmSeq = 0;

  const notify = () => listeners.forEach((fn) => fn(state));

  return {
    state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    notify,

    setSettings(s) {
      state.settings = { ...state.settings, ...s };
      saveSettings(state.settings);
      notify();
    },
    setConn(conn, info = "") {
      state.conn = conn;
      state.connInfo = info;
      notify();
    },
    setDevice(status) {
      state.device = status === "online" || status === "offline" ? status : "unknown";
      notify();
    },
    resetLive() {
      state.device = "unknown";
      state.lastTelemetryAt = null;
      state.telemetry = null;
      state.relaySince = {};
      state.pendingRelay = {};
      state.pendingMode = null;
      state.pendingSetpoints = null;
      notify();
    },
    setRange(min) {
      state.rangeMin = min;
      notify();
    },
    tick() {
      state.now = Date.now();
      notify();
    },

    ingestTelemetry(t, at = Date.now(), { silent = false } = {}) {
      const prev = state.telemetry;
      state.telemetry = t;
      state.lastTelemetryAt = at;
      for (const { key } of RELAYS) {
        const cur = t.relays[key];
        const was = prev ? prev.relays[key] : null;
        if (cur === true && was !== true) state.relaySince[key] = at;
        if (cur !== true) delete state.relaySince[key];
        const pend = state.pendingRelay[key];
        if (pend && cur !== null && (cur ? "ON" : "OFF") === pend.target) delete state.pendingRelay[key];
        if (prev && cur !== null && was !== null && cur !== was) {
          this.logEvent(`${labelOf(key)} ${cur ? "ON" : "OFF"}`, "relay", at);
        }
      }
      if (state.pendingMode && t.mode === state.pendingMode.target) state.pendingMode = null;
      if (prev && t.mode && prev.mode && prev.mode !== t.mode) this.logEvent(`Mode ${t.mode}`, "mode", at);
      if (state.pendingSetpoints) {
        const want = state.pendingSetpoints.values;
        if (Object.keys(want).every((k) => t.setpoints[k] === want[k])) {
          state.pendingSetpoints = null;
          this.logEvent("Setpoint dikonfirmasi perangkat", "setpoint", at);
        }
      }
      this.addHistory(at, t);
      if (!silent) notify();
    },

    addHistory(at, t) {
      const last = state.history[state.history.length - 1];
      if (last && last.t >= at) return;
      state.history.push({
        t: at,
        air_temp: t.air_temp,
        air_hum: t.air_hum,
        soil_hum: t.soil_hum,
      });
      const cutoff = at - LIMITS.historyMaxMs;
      while (state.history.length && state.history[0].t < cutoff) state.history.shift();
    },

    loadHistory() {
      const h = readJson(STORAGE.history, []);
      if (!Array.isArray(h)) return;
      const cutoff = Date.now() - LIMITS.historyMaxMs;
      state.history = h
        .filter((p) => Array.isArray(p) && p.length === 4 && num(p[0]) !== null && p[0] >= cutoff)
        .map(([t, a, b, c]) => ({ t, air_temp: num(a), air_hum: num(b), soil_hum: num(c) }));
    },
    saveHistory() {
      const now = Date.now();
      const out = [];
      let bucket = null;
      for (const p of state.history) {
        const age = now - p.t;
        const step = age < 3600e3 ? 0 : age < 6 * 3600e3 ? 60e3 : 300e3;
        if (!step) {
          out.push(p);
          bucket = null;
          continue;
        }
        const id = Math.floor(p.t / step);
        if (bucket && bucket.id === id) continue;
        bucket = { id };
        out.push(p);
      }
      writeJson(STORAGE.history, out.map((p) => [p.t, p.air_temp, p.air_hum, p.soil_hum]));
    },
    clearHistory() {
      state.history = [];
    },

    setPendingRelay(key, target) {
      state.pendingRelay[key] = { target, at: Date.now() };
      notify();
    },
    setPendingMode(target) {
      state.pendingMode = { target, at: Date.now() };
      notify();
    },
    setPendingSetpoints(values) {
      state.pendingSetpoints = { values, at: Date.now() };
      notify();
    },
    expirePending(now = Date.now()) {
      let changed = false;
      for (const [k, p] of Object.entries(state.pendingRelay)) {
        if (now - p.at > LIMITS.pendingTimeoutMs) {
          delete state.pendingRelay[k];
          this.logEvent(`Tidak ada konfirmasi untuk ${labelOf(k)}`, "warn");
          changed = true;
        }
      }
      if (state.pendingMode && now - state.pendingMode.at > LIMITS.pendingTimeoutMs) {
        this.logEvent(`Tidak ada konfirmasi perubahan mode ke ${state.pendingMode.target}`, "warn");
        state.pendingMode = null;
        changed = true;
      }
      if (state.pendingSetpoints && now - state.pendingSetpoints.at > LIMITS.pendingTimeoutMs) {
        this.logEvent("Tidak ada konfirmasi setpoint dari perangkat", "warn");
        state.pendingSetpoints = null;
        changed = true;
      }
      if (changed) notify();
    },

    logEvent(msg, kind = "info", at = Date.now()) {
      state.events.unshift({ ts: at, msg, kind });
      if (state.events.length > LIMITS.eventsMax) state.events.length = LIMITS.eventsMax;
    },

    syncAlarms(conditions, now = Date.now()) {
      const raised = [];
      for (const c of conditions) {
        let a = state.alarms.find((x) => x.type === c.type && x.active);
        if (c.active && !a) {
          a = { id: ++alarmSeq, type: c.type, msg: c.msg, ts: now, active: true, ack: false, cleared: null };
          state.alarms.unshift(a);
          if (state.alarms.length > LIMITS.alarmsMax) state.alarms.length = LIMITS.alarmsMax;
          this.logEvent(`Alarm: ${c.msg}`, "alarm", now);
          raised.push(a);
        } else if (!c.active && a) {
          a.active = false;
          a.cleared = now;
          this.logEvent(`Alarm selesai: ${a.msg}`, "info", now);
        } else if (c.active && a) {
          a.msg = c.msg;
        }
      }
      return raised;
    },
    ack(id) {
      const a = state.alarms.find((x) => x.id === id);
      if (a) a.ack = true;
      notify();
    },
    ackAll() {
      state.alarms.forEach((a) => (a.ack = true));
      notify();
    },
  };
}

function labelOf(key) {
  const r = RELAYS.find((x) => x.key === key);
  return r ? r.label : key;
}

export function deviceOnline(state) {
  if (state.conn !== "connected") return false;
  if (state.device === "offline") return false;
  if (state.lastTelemetryAt === null) return false;
  return state.now - state.lastTelemetryAt <= LIMITS.offlineAfterMs;
}

export function statusFor(key, t) {
  if (!t) return { level: "none", text: "Tidak ada data" };
  const sp = t.setpoints;
  const v = t[key];
  if (t[`${key}_fault`] || v === null) return { level: "alarm", text: "Sensor fault" };
  if (key === "air_temp") {
    if (sp.air_temp_max === null) return { level: "ok", text: "Normal" };
    if (v > sp.air_temp_max + LIMITS.tempAlarmMargin) return { level: "alarm", text: "Alarm: terlalu panas" };
    if (v > sp.air_temp_max) return { level: "warn", text: "Perhatian: di atas batas" };
    return { level: "ok", text: "Normal" };
  }
  const min = key === "air_hum" ? sp.air_hum_min : sp.soil_hum_min;
  if (min === null) return { level: "ok", text: "Normal" };
  if (v < min - LIMITS.humAlarmMargin) return { level: "alarm", text: "Alarm: terlalu kering" };
  if (v < min) return { level: "warn", text: "Perhatian: di bawah batas" };
  return { level: "ok", text: "Normal" };
}

export function trendOf(key, history, now) {
  const pts = history.filter((p) => p[key] !== null && now - p.t <= 10 * 60e3);
  if (pts.length < 6) return null;
  const avg = (a) => a.reduce((s, p) => s + p[key], 0) / a.length;
  const d = avg(pts.slice(-3)) - avg(pts.slice(0, 3));
  const eps = SENSORS[key].trendEps;
  return d > eps ? "up" : d < -eps ? "down" : "flat";
}

export function downsample(points, maxPoints) {
  if (points.length <= maxPoints) return points;
  const step = points.length / maxPoints;
  const out = [];
  for (let i = 0; i < maxPoints; i++) out.push(points[Math.floor(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}

import { RELAYS, SETPOINT_LIMITS } from "./config.js";

const rnd = (a = 1) => (Math.random() - 0.5) * 2 * a;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function createDemoLink({ onMessage, onConn }) {
  const sim = {
    t: 0,
    temp: 27.5,
    airHum: 62,
    soil: 40,
    mode: "AUTO",
    relays: { humidifier: false, irrigation: false, cooling: false, pump: false },
    sp: { air_hum_min: 60, soil_hum_min: 30, air_temp_max: 30 },
  };
  let iv = null;
  const timers = new Set();

  function control() {
    if (sim.mode !== "AUTO") return;
    const r = sim.relays;
    const { air_temp_max: tmax, air_hum_min: hmin, soil_hum_min: smin } = sim.sp;
    if (sim.temp > tmax) r.cooling = true;
    else if (sim.temp < tmax - 1) r.cooling = false;
    if (sim.airHum < hmin) r.humidifier = true;
    else if (sim.airHum > hmin + 5) r.humidifier = false;
    if (sim.soil < smin) r.irrigation = true;
    else if (sim.soil > smin + 6) r.irrigation = false;
    r.pump = r.irrigation || r.humidifier || r.cooling;
  }

  function step(dt = 5) {
    const k = dt / 5;
    sim.t += dt;
    const r = sim.relays;
    const ambT = 28.5 + 3.4 * Math.sin((sim.t / 1500) * 2 * Math.PI);
    const ambH = 52 + 9 * Math.sin((sim.t / 1900) * 2 * Math.PI + 1);
    sim.temp += k * ((ambT - sim.temp) * 0.03 - (r.cooling ? 0.22 : 0) - (r.humidifier ? 0.02 : 0) + rnd(0.04));
    sim.airHum += k * ((ambH - sim.airHum) * 0.03 + (r.humidifier ? 1.1 : 0) + (r.cooling ? 0.15 : 0) + rnd(0.15));
    sim.soil += k * (-0.1 + (r.irrigation && r.pump ? 0.8 : 0) + rnd(0.03));
    sim.airHum = clamp(sim.airHum, 20, 95);
    sim.soil = clamp(sim.soil, 5, 90);
    control();
  }

  function payload() {
    const faulty = sim.t % 420 >= 150 && sim.t % 420 < 195;
    const airHum = faulty ? Math.round((101 + Math.random() * 45) * 10) / 10 : Math.round(sim.airHum * 10) / 10;
    return JSON.stringify({
      ts: Math.floor(Date.now() / 1000),
      air_temp: Math.round(sim.temp * 10) / 10,
      air_hum: airHum,
      soil_hum: Math.round(sim.soil * 10) / 10,
      air_valid: true,
      soil_valid: true,
      relays: { ...sim.relays },
      mode: sim.mode,
      setpoints: { ...sim.sp },
      rssi: -58 - Math.round(Math.random() * 8),
      uptime: Math.floor(sim.t),
    });
  }

  const emit = () => onMessage("telemetry", payload());

  function later(fn, ms) {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
  }

  return {
    prefill(hours = 6, stepSec = 5) {
      const n = Math.floor((hours * 3600) / stepSec);
      const now = Date.now();
      const out = [];
      for (let i = n; i > 0; i--) {
        step(stepSec);
        const p = JSON.parse(payload());
        out.push({ at: now - i * stepSec * 1000, raw: JSON.stringify(p) });
      }
      return out;
    },
    start() {
      onConn("connected", "Mode demo");
      onMessage("status", "online");
      emit();
      iv = setInterval(() => {
        step(5);
        emit();
      }, 5000);
    },
    stop() {
      clearInterval(iv);
      iv = null;
      timers.forEach(clearTimeout);
      timers.clear();
      onConn("idle", "");
    },
    publish(sub, text) {
      if (sub.startsWith("cmd/relay/")) {
        const key = sub.slice(10);
        if (!RELAYS.some((r) => r.key === key) || sim.mode !== "MANUAL") return true;
        if (text !== "ON" && text !== "OFF") return true;
        later(() => {
          sim.relays[key] = text === "ON";
          emit();
        }, 700);
      } else if (sub === "cmd/mode") {
        if (text !== "AUTO" && text !== "MANUAL") return true;
        later(() => {
          sim.mode = text;
          control();
          emit();
        }, 700);
      } else if (sub === "cmd/setpoint") {
        let d;
        try {
          d = JSON.parse(text);
        } catch {
          return true;
        }
        later(() => {
          for (const [k, lim] of Object.entries(SETPOINT_LIMITS)) {
            if (typeof d[k] === "number" && d[k] >= lim.min && d[k] <= lim.max) sim.sp[k] = d[k];
          }
          control();
          emit();
        }, 900);
      }
      return true;
    },
  };
}

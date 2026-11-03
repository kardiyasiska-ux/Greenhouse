import { RELAYS, SENSORS, SETPOINT_LIMITS, LIMITS } from "./config.js";
import { deviceOnline, statusFor, trendOf } from "./state.js";
import { drawSparkline, createTrendCharts } from "./charts.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");

export function isoLocal(ms, withOffset = false) {
  const d = new Date(ms);
  let s = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  if (withOffset) {
    const o = -d.getTimezoneOffset();
    s += `${o >= 0 ? "+" : "-"}${pad(Math.floor(Math.abs(o) / 60))}:${pad(Math.abs(o) % 60)}`;
  }
  return s;
}

function duration(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.appendChild(use);
  return svg;
}

const STATUS_ICON = { ok: "ok", warn: "warn", alarm: "alarm", none: "off" };
const TREND = { up: ["up", "naik"], down: ["down", "turun"], flat: ["flat", "stabil"] };

export function createUi(store, h) {
  const gauges = {};
  for (const key of Object.keys(SENSORS)) {
    const root = $(`g-${key}`);
    const f = {};
    root.querySelectorAll("[data-f]").forEach((el) => (f[el.dataset.f] = el));
    gauges[key] = { root, f };
  }
  const rows = {};
  document.querySelectorAll("#relayRows .row").forEach((li) => {
    const key = li.dataset.relay;
    rows[key] = {
      li,
      state: li.querySelector('[data-f="state"]'),
      dur: li.querySelector('[data-f="dur"]'),
      sw: li.querySelector(".switch"),
      pending: li.querySelector(".pending"),
    };
    rows[key].sw.addEventListener("click", () => h.onRelay(key, rows[key].sw.getAttribute("aria-checked") !== "true"));
  });
  const modeBtns = [...document.querySelectorAll("#modeSeg button")];
  modeBtns.forEach((b) => b.addEventListener("click", () => h.onMode(b.dataset.mode)));

  const spRows = [...document.querySelectorAll(".sp")].map((el) => ({
    key: el.dataset.sp,
    el,
    input: el.querySelector("input"),
    active: el.querySelector('[data-f="active"]'),
    err: el.querySelector(".err"),
  }));
  spRows.forEach((r) => r.input.addEventListener("input", () => {
    r.input.dataset.dirty = "1";
    r.input.removeAttribute("aria-invalid");
    r.err.textContent = "";
  }));
  $("spForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const values = {};
    let first = null;
    for (const r of spRows) {
      const lim = SETPOINT_LIMITS[r.key];
      const raw = r.input.value.trim();
      const v = Number(raw);
      if (raw === "" || !Number.isFinite(v) || v < lim.min || v > lim.max) {
        r.input.setAttribute("aria-invalid", "true");
        r.err.textContent = `${lim.label}: isi angka ${lim.min} sampai ${lim.max} ${lim.unit}`;
        first = first || r.input;
      } else {
        values[r.key] = v;
      }
    }
    if (first) {
      first.focus();
      return;
    }
    h.onSetpoints(values);
  });

  document.querySelectorAll("#rangeSeg button").forEach((b) => b.addEventListener("click", () => h.onRange(Number(b.dataset.min))));
  $("btnCsv").addEventListener("click", () => h.onCsv());
  $("btnTheme").addEventListener("click", () => h.onTheme());
  $("btnSettings").addEventListener("click", () => openSettings());

  const trends = createTrendCharts();
  let alarmSig = "";
  let logSig = "";
  let chartSig = "";

  function renderGauges(s, online) {
    const t = s.telemetry;
    for (const [key, meta] of Object.entries(SENSORS)) {
      const { root, f } = gauges[key];
      const st = statusFor(key, t);
      const v = t ? t[key] : null;
      root.dataset.stale = String(!online && Boolean(t));
      f.value.textContent = v === null || v === undefined ? "—" : v.toFixed(meta.decimals);
      f.status.dataset.level = st.level;
      f.status.replaceChildren(icon(STATUS_ICON[st.level]), document.createTextNode(st.text));
      const tr = v === null || v === undefined ? null : trendOf(key, s.history, s.now);
      f.trend.replaceChildren();
      if (tr) {
        f.trend.append(icon(TREND[tr][0]), document.createTextNode(TREND[tr][1]));
      }
      const [lo, hi] = meta.scale;
      const pct = (x) => `${Math.min(100, Math.max(0, ((x - lo) / (hi - lo)) * 100))}%`;
      const sp = t ? t.setpoints : null;
      let a = null;
      let b = null;
      let label = "Target belum diketahui";
      if (sp) {
        if (key === "air_temp" && sp.air_temp_max !== null) {
          a = LIMITS.tempBandMin;
          b = sp.air_temp_max;
          label = `Target ≤ ${sp.air_temp_max} °C`;
        } else if (key === "air_hum" && sp.air_hum_min !== null) {
          a = sp.air_hum_min;
          b = hi;
          label = `Target ≥ ${sp.air_hum_min} %RH`;
        } else if (key === "soil_hum" && sp.soil_hum_min !== null) {
          a = sp.soil_hum_min;
          b = hi;
          label = `Target ≥ ${sp.soil_hum_min} %`;
        }
      }
      if (a !== null) {
        f.target.style.left = pct(a);
        f.target.style.width = `${Math.max(0, parseFloat(pct(b)) - parseFloat(pct(a)))}%`;
      } else {
        f.target.style.width = "0";
      }
      f.marker.hidden = v === null || v === undefined;
      if (!f.marker.hidden) f.marker.style.left = pct(v);
      f.bmin.textContent = String(lo);
      f.bmax.textContent = String(hi);
      f.btarget.textContent = label;
      drawSparkline(f.spark, s.history, key, s.now);
      f.stamp.textContent = !online && s.lastTelemetryAt ? `Data terakhir ${isoLocal(s.lastTelemetryAt)}` : "";
    }
  }

  function renderActuators(s, online) {
    const t = s.telemetry;
    const manual = Boolean(t && t.mode === "MANUAL");
    for (const { key } of RELAYS) {
      const r = rows[key];
      const v = t ? t.relays[key] : null;
      const pend = s.pendingRelay[key];
      r.state.textContent = v === null ? "—" : v ? "ON" : "OFF";
      r.state.dataset.on = String(v === true);
      r.dur.textContent = v === true && s.relaySince[key] ? duration(s.now - s.relaySince[key]) : "—";
      r.sw.setAttribute("aria-checked", String(v === true));
      r.sw.disabled = !(online && manual && v !== null) || Boolean(pend);
      if (pend) r.sw.setAttribute("aria-busy", "true");
      else r.sw.removeAttribute("aria-busy");
      r.pending.hidden = !pend;
      if (pend) r.pending.textContent = `Menunggu konfirmasi (${pend.target})`;
    }
    $("actHint").textContent = !t ? "" : manual ? "Kontrol manual aktif" : "Sakelar aktif hanya di mode MANUAL";
    for (const b of modeBtns) {
      b.setAttribute("aria-checked", String(Boolean(t && t.mode === b.dataset.mode)));
      b.disabled = !online || Boolean(s.pendingMode);
    }
    $("modeHint").textContent = s.pendingMode ? `Menunggu konfirmasi mode ${s.pendingMode.target}` : t && t.mode ? `Mode aktif: ${t.mode}` : "Mode belum diketahui";
  }

  function renderSetpoints(s, online) {
    const t = s.telemetry;
    for (const r of spRows) {
      const v = t ? t.setpoints[r.key] : null;
      r.active.textContent = `Aktif: ${v === null || v === undefined ? "—" : v}`;
      if (v === null || v === undefined) continue;
      if (r.input.dataset.dirty && Number(r.input.value) === v && !s.pendingSetpoints) delete r.input.dataset.dirty;
      if (!r.input.dataset.dirty && document.activeElement !== r.input) r.input.value = String(v);
    }
    $("btnApply").disabled = !online || Boolean(s.pendingSetpoints);
    $("spStatus").textContent = s.pendingSetpoints ? "Menunggu konfirmasi perangkat" : "";
  }

  function renderHeader(s, online) {
    $("siteName").textContent = s.settings.site || "Greenhouse";
    $("clock").textContent = isoLocal(s.now, true);
    const demo = s.settings.demo;
    const b = $("chipBroker");
    const bm = {
      connected: [demo ? "Demo (simulasi)" : "terhubung", "none"],
      connecting: ["menghubungkan", "warn"],
      reconnecting: ["terputus", "alarm"],
      error: ["gagal", "alarm"],
      idle: ["—", "none"],
    }[s.conn] || ["—", "none"];
    b.dataset.level = bm[1];
    b.lastElementChild.textContent = `Broker: ${bm[0]}`;
    const d = $("chipDevice");
    let dm = ["—", "none"];
    if (s.conn === "connected") {
      if (online) dm = ["online", "none"];
      else if (s.lastTelemetryAt === null && s.device !== "offline") dm = ["menunggu data", "warn"];
      else dm = ["offline", "alarm"];
    }
    d.dataset.level = dm[1];
    d.lastElementChild.textContent = `Perangkat: ${dm[0]}`;

    const banner = $("banner");
    let text = "";
    let lvl = "";
    if (s.conn === "idle") {
      text = "Belum terhubung ke broker. Buka Pengaturan untuk mengisi broker atau aktifkan mode demo.";
    } else if (s.conn === "connecting") {
      text = "Menghubungkan ke broker…";
    } else if (s.conn === "reconnecting" || s.conn === "error") {
      text = `Koneksi ke broker terputus. ${s.connInfo}`;
      lvl = "alarm";
    } else if (s.conn === "connected" && s.lastTelemetryAt !== null && !online) {
      text = "Perangkat offline. Nilai yang tampil adalah data terakhir dan kontrol dinonaktifkan.";
      lvl = "alarm";
    }
    banner.hidden = !text;
    banner.className = `banner ${lvl}`.trim();
    banner.textContent = text;
  }

  function renderLists(s) {
    const aSig = s.alarms.map((a) => `${a.id}${a.active ? 1 : 0}${a.ack ? 1 : 0}`).join(",");
    if (aSig !== alarmSig) {
      alarmSig = aSig;
      const list = $("alarmList");
      list.replaceChildren();
      if (!s.alarms.length) {
        const li = document.createElement("li");
        li.className = "empty";
        li.textContent = "Tidak ada alarm";
        list.appendChild(li);
      }
      for (const a of s.alarms) {
        const li = document.createElement("li");
        li.className = "alarm-item";
        li.dataset.active = String(a.active);
        li.dataset.ack = String(a.ack);
        const lead = icon(a.active ? "alarm" : "ok");
        lead.classList.add("lead");
        const msg = document.createElement("div");
        msg.className = "msg";
        msg.textContent = a.msg;
        const ts = document.createElement("span");
        ts.className = "ts";
        ts.textContent = isoLocal(a.ts);
        const meta = document.createElement("div");
        meta.className = "meta";
        const stt = document.createElement("span");
        stt.textContent = a.active ? (a.ack ? "Aktif, diakui" : "Aktif, belum diakui") : `Selesai ${isoLocal(a.cleared)}`;
        meta.appendChild(stt);
        if (!a.ack && a.active) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "btn";
          btn.textContent = "Akui";
          btn.addEventListener("click", () => h.onAck(a.id));
          meta.appendChild(btn);
        }
        li.append(lead, msg, ts, meta);
        list.appendChild(li);
      }
    }
    const unack = s.alarms.filter((a) => a.active && !a.ack).length;
    const c = $("alCount");
    c.textContent = String(unack);
    c.dataset.n = String(unack);
    c.setAttribute("aria-label", `${unack} alarm aktif belum diakui`);

    const lSig = `${s.events.length}:${s.events[0] ? s.events[0].ts + s.events[0].msg : ""}`;
    if (lSig !== logSig) {
      logSig = lSig;
      const list = $("logList");
      list.replaceChildren();
      if (!s.events.length) {
        const li = document.createElement("li");
        li.className = "empty";
        li.textContent = "Belum ada kejadian";
        list.appendChild(li);
      }
      for (const e of s.events) {
        const li = document.createElement("li");
        const ts = document.createElement("span");
        ts.className = "ts";
        ts.textContent = isoLocal(e.ts);
        const msg = document.createElement("span");
        msg.className = "msg";
        msg.textContent = e.msg;
        li.append(ts, msg);
        list.appendChild(li);
      }
      $("logCount").textContent = `${s.events.length} kejadian`;
    }
  }

  function renderCharts(s) {
    document.querySelectorAll("#rangeSeg button").forEach((b) => b.setAttribute("aria-pressed", String(Number(b.dataset.min) === s.rangeMin)));
    const last = s.history[s.history.length - 1];
    const sig = `${s.rangeMin}:${s.history.length}:${last ? last.t : 0}:${Math.floor(s.now / 15000)}`;
    if (sig === chartSig) return;
    chartSig = sig;
    trends.update(s.history, s.rangeMin, s.telemetry ? s.telemetry.setpoints : null, s.now);
  }

  function render(s) {
    const online = deviceOnline(s);
    renderHeader(s, online);
    renderGauges(s, online);
    renderActuators(s, online);
    renderSetpoints(s, online);
    renderLists(s);
    renderCharts(s);
  }

  function confirmMode(target) {
    const dlg = $("dlgMode");
    $("dlgModeT").textContent = `Ubah mode ke ${target}?`;
    $("dlgModeP").textContent =
      target === "MANUAL"
        ? "Logika otomatis dihentikan. Relay hanya berubah mengikuti sakelar di dashboard ini."
        : "Perangkat akan mengatur relay sendiri berdasarkan setpoint.";
    return new Promise((resolve) => {
      dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok"), { once: true });
      dlg.returnValue = "";
      dlg.showModal();
    });
  }

  const setDlg = $("dlgSet");
  const fld = (id) => $(`s_${id}`);
  function openSettings() {
    const st = store.state.settings;
    fld("site").value = st.site;
    fld("host").value = st.host;
    fld("port").value = st.port;
    fld("path").value = st.path;
    fld("tls").checked = st.tls;
    fld("user").value = st.username;
    fld("pass").value = st.password;
    fld("prefix").value = st.prefix;
    fld("demo").checked = st.demo;
    $("setErr").textContent = "";
    setDlg.showModal();
  }
  $("setCancel").addEventListener("click", () => setDlg.close());
  $("setForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const next = {
      site: fld("site").value.trim() || "Greenhouse",
      host: fld("host").value.trim().replace(/^(wss?|https?|mqtts?):\/\//i, "").replace(/\/.*$/, ""),
      port: Number(fld("port").value),
      path: fld("path").value.trim() || "/mqtt",
      tls: fld("tls").checked,
      username: fld("user").value.trim(),
      password: fld("pass").value,
      prefix: fld("prefix").value.trim().replace(/^\/+|\/+$/g, ""),
      demo: fld("demo").checked,
    };
    let err = "";
    if (!next.prefix || /[#+\s]/.test(next.prefix)) err = "Prefix topik wajib diisi dan tidak boleh berisi spasi, # atau +.";
    else if (!next.demo && !next.host) err = "Host broker wajib diisi, atau aktifkan mode demo.";
    else if (!next.demo && !(Number.isInteger(next.port) && next.port >= 1 && next.port <= 65535)) err = "Port harus berupa angka 1 sampai 65535.";
    if (err) {
      $("setErr").textContent = err;
      return;
    }
    setDlg.close();
    h.onSettings(next);
  });

  return {
    render,
    confirmMode,
    openSettings,
    applyTheme: () => trends.applyTheme(),
    announce(text) {
      const el = $("liveAlarm");
      el.textContent = "";
      setTimeout(() => (el.textContent = text), 50);
    },
  };
}

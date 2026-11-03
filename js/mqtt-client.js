import { LIMITS } from "./config.js";

export function createMqttLink({ settings, onMessage, onConn }) {
  const prefix = settings.prefix.replace(/^\/+|\/+$/g, "");
  let client = null;
  let timer = null;
  let attempt = 0;
  let stopped = true;

  const url = () => `${settings.tls ? "wss" : "ws"}://${settings.host}:${settings.port}${settings.path.startsWith("/") ? "" : "/"}${settings.path}`;

  function schedule() {
    if (stopped || timer) return;
    const base = Math.min(LIMITS.reconnectMaxMs, LIMITS.reconnectMinMs * 2 ** attempt);
    const delay = Math.round(base * (0.8 + Math.random() * 0.4));
    attempt += 1;
    onConn("reconnecting", `Mencoba lagi dalam ${Math.ceil(delay / 1000)} detik`);
    timer = setTimeout(() => {
      timer = null;
      open();
    }, delay);
  }

  function open() {
    if (stopped) return;
    if (typeof mqtt === "undefined") {
      onConn("error", "Library mqtt.js tidak termuat");
      return;
    }
    onConn("connecting", "");
    let c;
    try {
      c = mqtt.connect(url(), {
        clientId: `ghweb-${Math.random().toString(16).slice(2, 10)}`,
        username: settings.username || undefined,
        password: settings.password || undefined,
        keepalive: 30,
        connectTimeout: 8000,
        reconnectPeriod: 0,
        clean: true,
      });
    } catch (e) {
      onConn("error", "Alamat broker tidak valid");
      return;
    }
    client = c;
    c.on("connect", () => {
      if (client !== c) return;
      attempt = 0;
      c.subscribe([`${prefix}/telemetry`, `${prefix}/status`], { qos: 1 }, (err) => {
        if (err) onConn("error", "Gagal subscribe");
      });
      onConn("connected", "");
    });
    c.on("message", (topic, payload, packet) => {
      if (client !== c || !topic.startsWith(`${prefix}/`)) return;
      onMessage(topic.slice(prefix.length + 1), payload.toString(), Boolean(packet && packet.retain));
    });
    c.on("error", (err) => {
      if (client !== c) return;
      onConn("error", err && err.message ? err.message : "Kesalahan koneksi");
    });
    c.on("close", () => {
      if (client !== c) return;
      client = null;
      schedule();
    });
  }

  return {
    start() {
      this.stop();
      if (!settings.host) {
        onConn("error", "Host broker belum diisi");
        return;
      }
      stopped = false;
      attempt = 0;
      open();
    },
    stop() {
      stopped = true;
      clearTimeout(timer);
      timer = null;
      if (client) {
        const c = client;
        client = null;
        try {
          c.end(true);
        } catch {}
      }
      onConn("idle", "");
    },
    publish(sub, payload) {
      if (!client || !client.connected) return false;
      client.publish(`${prefix}/${sub}`, payload, { qos: 1, retain: false });
      return true;
    },
  };
}

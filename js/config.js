export const STORAGE = {
  settings: "gh.settings",
  theme: "gh.theme",
  history: "gh.history",
};

export const DEFAULT_SETTINGS = {
  site: "Greenhouse 01",
  host: "w001eaad.ala.asia-southeast1.emqxsl.com",
  port: 8084,
  path: "/mqtt",
  tls: true,
  username: "rahseey",
  password: "040896", 
  prefix: "rahseey",
  demo: false,
};

export const RELAYS = [
  { key: "humidifier", label: "Humidifier" },
  { key: "irrigation", label: "Valve penyiraman" },
  { key: "cooling", label: "Valve pendingin ruangan" },
  { key: "pump", label: "Pompa air" },
];

export const SETPOINT_LIMITS = {
  air_temp_max: { min: 10, max: 50, label: "Suhu ruang maksimum", unit: "°C" },
  air_hum_min: { min: 0, max: 100, label: "Kelembaban ruang minimum", unit: "%RH" },
  soil_hum_min: { min: 0, max: 100, label: "Kelembaban tanah minimum", unit: "%" },
};

export const SENSORS = {
  air_temp: { label: "Suhu ruang", unit: "°C", decimals: 1, scale: [0, 50], trendEps: 0.3 },
  air_hum: { label: "Kelembaban ruang", unit: "%RH", decimals: 1, scale: [0, 100], trendEps: 1.5 },
  soil_hum: { label: "Kelembaban tanah", unit: "%", decimals: 1, scale: [0, 100], trendEps: 1.5 },
};

export const LIMITS = {
  offlineAfterMs: 30000,
  pendingTimeoutMs: 10000,
  historyMaxMs: 24 * 3600 * 1000,
  eventsMax: 200,
  alarmsMax: 100,
  tempAlarmMargin: 2,
  humAlarmMargin: 10,
  reconnectMinMs: 1000,
  reconnectMaxMs: 30000,
  tempBandMin: 18,
};

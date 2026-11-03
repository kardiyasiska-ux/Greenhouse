import { downsample } from "./state.js";

const SVG_NS = "http://www.w3.org/2000/svg";
const KEYS = ["air_temp", "air_hum", "soil_hum"];
const SP_KEY = { air_temp: "air_temp_max", air_hum: "air_hum_min", soil_hum: "soil_hum_min" };
const Y_RANGE = { air_temp: [15, 40], air_hum: [0, 100], soil_hum: [0, 100] };

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (ms) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export function drawSparkline(svg, history, key, now) {
  const from = now - 3600e3;
  const pts = history.filter((p) => p.t >= from);
  svg.replaceChildren();
  const base = document.createElementNS(SVG_NS, "line");
  base.setAttribute("class", "base");
  base.setAttribute("x1", "0");
  base.setAttribute("x2", "120");
  base.setAttribute("y1", "35.5");
  base.setAttribute("y2", "35.5");
  svg.appendChild(base);
  const vals = pts.map((p) => p[key]).filter((v) => v !== null);
  if (vals.length < 2) return;
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (hi - lo < 1) {
    const mid = (hi + lo) / 2;
    lo = mid - 0.5;
    hi = mid + 0.5;
  }
  let d = "";
  let pen = false;
  for (const p of pts) {
    if (p[key] === null) {
      pen = false;
      continue;
    }
    const x = ((p.t - from) / 3600e3) * 120;
    const y = 33 - ((p[key] - lo) / (hi - lo)) * 30;
    d += `${pen ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`;
    pen = true;
  }
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  svg.appendChild(path);
}

export function createTrendCharts() {
  const charts = {};
  if (typeof Chart === "undefined") return { update() {}, applyTheme() {} };

  for (const key of KEYS) {
    const canvas = document.getElementById(`ch-${key}`);
    charts[key] = new Chart(canvas, {
      type: "line",
      data: {
        datasets: [
          { data: [], borderWidth: 1.6, pointRadius: 0, pointHoverRadius: 3, spanGaps: false, tension: 0 },
          { data: [], borderWidth: 1, borderDash: [5, 4], pointRadius: 0, pointHoverRadius: 0, tension: 0 },
        ],
      },
      options: {
        animation: false,
        parsing: false,
        normalized: true,
        maintainAspectRatio: false,
        interaction: { mode: "nearest", axis: "x", intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            filter: (item) => item.datasetIndex === 0,
            callbacks: {
              title: (items) => (items.length ? new Date(items[0].parsed.x).toISOString().slice(0, 19).replace("T", " ") + " UTC" : ""),
            },
          },
        },
        scales: {
          x: { type: "linear", ticks: { maxTicksLimit: 5, maxRotation: 0, callback: (v) => hhmm(v) }, grid: {} },
          y: { suggestedMin: Y_RANGE[key][0], suggestedMax: Y_RANGE[key][1], grid: {} },
        },
      },
    });
  }

  function applyTheme() {
    const line = css("--chart-line");
    const sp = css("--chart-sp");
    const grid = css("--chart-grid");
    const text = css("--text-3");
    for (const key of KEYS) {
      const c = charts[key];
      c.data.datasets[0].borderColor = line;
      c.data.datasets[1].borderColor = sp;
      for (const ax of ["x", "y"]) {
        c.options.scales[ax].grid.color = grid;
        c.options.scales[ax].ticks.color = text;
        c.options.scales[ax].border = { color: grid };
      }
      c.update("none");
    }
  }

  function update(history, rangeMin, setpoints, now) {
    const from = now - rangeMin * 60e3;
    const sel = history.filter((p) => p.t >= from);
    for (const key of KEYS) {
      const c = charts[key];
      const data = downsample(sel, 400).map((p) => ({ x: p.t, y: p[key] }));
      c.data.datasets[0].data = data;
      const sp = setpoints ? setpoints[SP_KEY[key]] : null;
      c.data.datasets[1].data = typeof sp === "number" ? [{ x: from, y: sp }, { x: now, y: sp }] : [];
      c.options.scales.x.min = from;
      c.options.scales.x.max = now;
      c.update("none");
    }
  }

  applyTheme();
  return { update, applyTheme };
}

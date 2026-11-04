import { useEffect, useRef, useState } from "react";
import {
  getTemps,
  getTempsHistory,
  type TempCpuDto,
  type TempGpuDto,
  type TempSampleDto,
  type TempsFeed,
} from "./api";
import {
  TEMP_DISPLAY_LIMITS,
  TEMP_PERIODS,
  WARM_MARGIN_C,
  filterSamplesByWindow,
  formatSampleTime,
  formatTemp,
  isStale,
  mergeTempSamples,
  meterPercent,
  readSeries,
  readingTone,
  worstGpuStatus,
  type TempPeriodId,
  type TempReadingTone,
} from "./hardware-temps";
import { Notice } from "./ui";

const POLL_MS = 2000;
const HISTORY_SECONDS = 3600;
const CHART_Y_MAX = 110;

const GPU_SENSORS = [
  { key: "edge", label: "核心", swatch: "blue" },
  { key: "junction", label: "热点", swatch: "orange" },
  { key: "memory", label: "显存", swatch: "violet" },
] as const;

type SensorKey = (typeof GPU_SENSORS)[number]["key"];
type ChartPoint = { t: number; v: number | null };
type ChartSeries = { label: string; color: string; points: ChartPoint[] };
type ChartPalette = { blue: string; orange: string; violet: string; grid: string; label: string };
type LinkState = "unknown" | "up" | "down";

const FALLBACK_PALETTE: ChartPalette = {
  blue: "#3b7ad0",
  orange: "#be6d21",
  violet: "#8b63be",
  grid: "#e5e9ef",
  label: "#7a8494",
};

function isAbortError(err: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

function toSample(feed: TempsFeed): TempSampleDto {
  return { timestamp: feed.timestamp, cpu: feed.cpu, gpus: feed.gpus };
}

function gpuById(gpus: TempGpuDto[], id: number): TempGpuDto | null {
  return gpus.find((gpu) => gpu.id === id) ?? null;
}

function newestSample(samples: TempSampleDto[]): TempSampleDto | null {
  let best: TempSampleDto | null = null;
  for (const sample of samples) {
    if (!best || sample.timestamp >= best.timestamp) best = sample;
  }
  return best;
}

function sensorLimit(gpu: TempGpuDto | null, key: SensorKey): number {
  const limit = gpu?.temperatures[key].limit;
  return limit != null && Number.isFinite(limit) && limit > 0 ? limit : TEMP_DISPLAY_LIMITS[key];
}

function statusLabel(status: TempReadingTone | TempCpuDto["status"] | "partial"): string {
  switch (status) {
    case "normal":
    case "available":
      return "正常";
    case "warm":
      return "偏热";
    case "over":
      return "超限";
    case "partial":
      return "部分";
    default:
      return "无读数";
  }
}

function pillClass(status: string): string {
  if (status === "normal" || status === "available") return "temps-pill-ok";
  if (status === "warm" || status === "partial") return "temps-pill-warm";
  if (status === "over") return "temps-pill-over";
  return "temps-pill-missing";
}

function formatPower(power: number | null, cap: number | null): string {
  if (power == null && cap == null) return "—";
  return `${formatTemp(power, 0)} / ${formatTemp(cap, 0)} W`;
}

function formatGiB(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const digits = value >= 10 ? 1 : 2;
  return String(Number(value.toFixed(digits)));
}

function formatVram(used: number | null, total: number | null): string {
  if (used == null && total == null) return "—";
  return `${formatGiB(used)} / ${formatGiB(total)} GiB`;
}

function lastValue(points: ChartPoint[]): number | null {
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const value = points[i]?.v;
    if (value != null) return value;
  }
  return null;
}

function readPalette(): ChartPalette {
  if (typeof document === "undefined") return FALLBACK_PALETTE;
  const style = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    blue: pick("--chart-blue", FALLBACK_PALETTE.blue),
    orange: pick("--chart-orange", FALLBACK_PALETTE.orange),
    violet: pick("--chart-violet", FALLBACK_PALETTE.violet),
    grid: pick("--border", FALLBACK_PALETTE.grid),
    label: pick("--text-dim", FALLBACK_PALETTE.label),
  };
}

export function SystemTemperaturePage({ now }: { now: number }) {
  const [samples, setSamples] = useState<TempSampleDto[]>([]);
  const [latest, setLatest] = useState<TempSampleDto | null>(null);
  const [link, setLink] = useState<LinkState>("unknown");
  const [error, setError] = useState<string | null>(null);
  const [historySettled, setHistorySettled] = useState(false);
  const [pollSettled, setPollSettled] = useState(false);
  const [period, setPeriod] = useState<TempPeriodId>(3600);
  const [clock, setClock] = useState(() => Date.now());
  const [palette, setPalette] = useState<ChartPalette>(FALLBACK_PALETTE);

  useEffect(() => {
    setClock((current) => (now > current ? now : current));
  }, [now]);

  useEffect(() => {
    const id = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    setPalette(readPalette());
  }, []);

  useEffect(() => {
    let stopped = false;
    const historyController = new AbortController();
    const pollController = new AbortController();
    const pollOk = { current: null as boolean | null };
    let busy = false;

    getTempsHistory(HISTORY_SECONDS, historyController.signal)
      .then((feed) => {
        if (stopped) return;
        if (feed.connected) {
          if (feed.samples.length > 0) {
            setSamples((current) => mergeTempSamples(feed.samples, current));
            const newest = newestSample(feed.samples);
            if (newest) {
              setLatest((prev) => (!prev || newest.timestamp > prev.timestamp ? newest : prev));
            }
          }
          if (pollOk.current !== false) {
            setLink("up");
            setError(null);
          }
        } else if (pollOk.current !== true) {
          setLink("down");
          setError(feed.error ?? null);
        }
      })
      .catch((err: unknown) => {
        if (stopped || isAbortError(err)) return;
        if (pollOk.current === true) return;
        setLink("down");
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!stopped) setHistorySettled(true);
      });

    const poll = async () => {
      if (stopped || busy) return;
      busy = true;
      try {
        const feed = await getTemps(pollController.signal);
        if (stopped) return;
        pollOk.current = feed.connected;
        if (feed.connected) {
          const sample = toSample(feed);
          setLatest((prev) => (!prev || sample.timestamp >= prev.timestamp ? sample : prev));
          setSamples((current) => mergeTempSamples(current, [sample]));
          setLink("up");
          setError(null);
        } else {
          setLink("down");
          setError(feed.error ?? null);
        }
      } catch (err: unknown) {
        if (stopped || isAbortError(err)) return;
        pollOk.current = false;
        setLink("down");
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        busy = false;
        if (!stopped) setPollSettled(true);
      }
    };

    void poll();
    const intervalId = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      stopped = true;
      historyController.abort();
      pollController.abort();
      window.clearInterval(intervalId);
    };
  }, []);

  const nowSec = Math.max(clock / 1000, latest?.timestamp ?? 0);
  const windowed = filterSamplesByWindow(samples, nowSec, period);
  const ageStale = latest != null && isStale(latest.timestamp, clock);
  const live = latest != null && link !== "down" && !ageStale;
  const retained = latest != null && !live && pollSettled && (ageStale || link === "down");
  const offline = latest == null && historySettled && pollSettled;
  const loading = !latest && !offline;

  const gpuStatus = worstGpuStatus([
    gpuById(latest?.gpus ?? [], 0)?.status ?? "missing",
    gpuById(latest?.gpus ?? [], 1)?.status ?? "missing",
  ]);
  const guardTone = !latest ? "idle" : ageStale || link === "down" ? "stale" : gpuStatus;

  return (
    <main className="overview temps-page" data-testid="temps-page" aria-busy={loading || undefined}>
      <header className="page-heading temps-header">
        <div className="page-heading-copy">
          <h1 tabIndex={-1}>CPU 与双卡温度</h1>
          <p>RX 7900 XTX 双卡与 Ryzen 的实时温度。缺失读数保持为 —，不使用示例数据。</p>
        </div>
        <div className="temps-live">
          <span
            className={`temps-pill ${live ? "temps-pill-live" : retained ? "temps-pill-stale" : offline ? "temps-pill-offline" : "temps-pill-missing"}`}
            data-testid="temps-pill"
          >
            {live ? "实时" : retained ? "已过期" : offline ? "未连接" : "读取中"}
          </span>
          {latest ? (
            <time dateTime={new Date(latest.timestamp * 1000).toISOString()}>
              更新于 {formatSampleTime(latest.timestamp)}
            </time>
          ) : (
            <span>尚未采样</span>
          )}
        </div>
      </header>

      {loading && <Notice tone="info">正在读取温度…</Notice>}
      {offline && (
        <div data-testid="temps-banner">
          <Notice tone="error">
            连接中断{error ? `（${error}）` : ""}。没有可用采样，页面不会填入示例温度。
          </Notice>
        </div>
      )}
      {retained && (
        <div data-testid="temps-banner">
          <Notice tone="warning">
            连接中断{error ? `（${error}）` : ""}。以下为上次成功采样，已标记为已过期。
          </Notice>
        </div>
      )}

      <section className={`temps-guard temps-guard-${guardTone}`} aria-label="温度保护">
        <p className="temps-guard-copy">{guardMessage(guardTone, latest)}</p>
        <ul className="temps-shutdown">
          {[0, 1].map((id) => {
            const gpu = latest ? gpuById(latest.gpus, id) : null;
            return (
              <li key={id}>
                GPU {id} 关机线：核心 {sensorLimit(gpu, "edge")}°C · 热点 {sensorLimit(gpu, "junction")}°C · 显存{" "}
                {sensorLimit(gpu, "memory")}°C
              </li>
            );
          })}
        </ul>
      </section>

      <div className="temps-gpu-grid">
        <GpuCard id={0} gpu={latest ? gpuById(latest.gpus, 0) : null} />
        <GpuCard id={1} gpu={latest ? gpuById(latest.gpus, 1) : null} />
      </div>

      <CpuCard cpu={latest?.cpu ?? null} />

      <section className="temps-history" aria-label="温度历史">
        <div className="chart-head temps-history-head">
          <div>
            <h2 className="chart-title">温度历史</h2>
            <p className="chart-desc">纵轴 0–110°C。只连接已返回的采样，空档断开，不补 0。</p>
          </div>
          <label className="temps-period">
            <span>时间范围</span>
            <select
              value={period}
              onChange={(event) => {
                const next = Number(event.target.value);
                if (TEMP_PERIODS.some((item) => item.id === next)) setPeriod(next as TempPeriodId);
              }}
            >
              {TEMP_PERIODS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="temps-chart-grid">
          <TempChart
            title="GPU 0"
            palette={palette}
            startSec={nowSec - period}
            endSec={nowSec}
            series={[
              { label: "核心", color: palette.blue, points: readSeries(windowed, (s) => gpuById(s.gpus, 0)?.temperatures.edge.value ?? null) },
              { label: "热点", color: palette.orange, points: readSeries(windowed, (s) => gpuById(s.gpus, 0)?.temperatures.junction.value ?? null) },
              { label: "显存", color: palette.violet, points: readSeries(windowed, (s) => gpuById(s.gpus, 0)?.temperatures.memory.value ?? null) },
            ]}
          />
          <TempChart
            title="GPU 1"
            palette={palette}
            startSec={nowSec - period}
            endSec={nowSec}
            series={[
              { label: "核心", color: palette.blue, points: readSeries(windowed, (s) => gpuById(s.gpus, 1)?.temperatures.edge.value ?? null) },
              { label: "热点", color: palette.orange, points: readSeries(windowed, (s) => gpuById(s.gpus, 1)?.temperatures.junction.value ?? null) },
              { label: "显存", color: palette.violet, points: readSeries(windowed, (s) => gpuById(s.gpus, 1)?.temperatures.memory.value ?? null) },
            ]}
          />
          <TempChart
            title="CPU"
            palette={palette}
            startSec={nowSec - period}
            endSec={nowSec}
            series={[
              { label: "Tctl", color: palette.blue, points: readSeries(windowed, (s) => s.cpu.temperatures.tctl.value) },
              { label: "Tccd1", color: palette.violet, points: readSeries(windowed, (s) => s.cpu.temperatures.tccd1.value) },
            ]}
          />
        </div>
      </section>
    </main>
  );
}

function guardMessage(tone: string, sample: TempSampleDto | null): string {
  if (!sample || tone === "idle") return "正在确认采集。关机线如下；返回前不显示温度数字。";
  if (tone === "stale") return "上次采样已保留。下面的关机线仍然有效，温度数字可能已经过期。";
  if (tone === "over") return "告警。至少一路温度已经超过关机线。";
  if (tone === "warm") return `注意。至少一路温度距关机线不超过 ${WARM_MARGIN_C}°C。`;
  if (tone === "missing" || sample.cpu.status !== "available") {
    return "在线。部分传感器没有读数，缺失项显示为 —。";
  }
  return "在线。双卡温度都在关机线以下。";
}

function GpuCard({ id, gpu }: { id: number; gpu: TempGpuDto | null }) {
  const status = gpu?.status ?? "missing";
  return (
    <article className="temps-gpu-card" data-testid={`temps-gpu-${id}`} aria-label={`GPU ${id}`}>
      <header className="temps-card-head">
        <div>
          <p className="temps-kicker">GPU {id}</p>
          <h2>{gpu?.name ?? "等待采样"}</h2>
          <p className="temps-card-meta">{gpu?.card ?? "—"}</p>
        </div>
        <span className={`temps-pill ${pillClass(status)}`}>{statusLabel(status)}</span>
      </header>
      <div className="temps-sensors">
        {GPU_SENSORS.map((sensor) => {
          const reading = gpu?.temperatures[sensor.key] ?? null;
          const value = reading?.value ?? null;
          const limit = sensorLimit(gpu, sensor.key);
          const tone = readingTone(value, limit);
          return (
            <div key={sensor.key} className="temps-sensor">
              <span className="temps-sensor-label">{sensor.label}</span>
              <p className={`temps-sensor-value temps-value-${tone}`} data-testid={`temps-gpu-${id}-${sensor.key}`}>
                {formatTemp(value, 1)}
                {value != null && <span className="temps-sensor-unit">°C</span>}
              </p>
              <div
                className={`temps-meter temps-meter-${tone}`}
                role={value == null ? undefined : "meter"}
                aria-label={`${sensor.label}温度`}
                aria-valuemin={value == null ? undefined : 0}
                aria-valuemax={value == null ? undefined : limit}
                aria-valuenow={value == null ? undefined : value}
              >
                <span style={{ width: `${meterPercent(value, limit)}%` }} />
              </div>
              <span className="temps-sensor-limit">关机 {limit}°C</span>
            </div>
          );
        })}
      </div>
      <dl className="temps-stats">
        <div>
          <dt>风扇</dt>
          <dd>{gpu && gpu.fan_rpm != null ? `${formatTemp(gpu.fan_rpm, 0)} rpm` : "—"}</dd>
        </div>
        <div>
          <dt>功耗</dt>
          <dd>{gpu ? formatPower(gpu.power_w, gpu.power_cap_w) : "—"}</dd>
        </div>
        <div>
          <dt>负载</dt>
          <dd>{gpu && gpu.utilization != null ? `${formatTemp(gpu.utilization, 0)}%` : "—"}</dd>
        </div>
        <div>
          <dt>显存</dt>
          <dd>{gpu ? formatVram(gpu.vram_used_gib, gpu.vram_total_gib) : "—"}</dd>
        </div>
      </dl>
    </article>
  );
}

function CpuCard({ cpu }: { cpu: TempCpuDto | null }) {
  const status = cpu?.status ?? "missing";
  const rows = [
    { key: "tctl", label: "Tctl", value: cpu?.temperatures.tctl.value ?? null },
    { key: "tccd1", label: "Tccd1", value: cpu?.temperatures.tccd1.value ?? null },
  ];
  return (
    <section className="temps-cpu-card" aria-label="CPU 温度">
      <header className="temps-card-head">
        <div>
          <p className="temps-kicker">CPU</p>
          <h2>{cpu?.name ?? "等待采样"}</h2>
        </div>
        <span className={`temps-pill ${pillClass(status)}`}>{statusLabel(status)}</span>
      </header>
      <div className="temps-cpu-grid">
        {rows.map((row) => (
          <div key={row.key} className="temps-sensor">
            <span className="temps-sensor-label">{row.label}</span>
            <p className="temps-sensor-value" data-testid={`temps-cpu-${row.key}`}>
              {formatTemp(row.value, 1)}
              {row.value != null && <span className="temps-sensor-unit">°C</span>}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}

function TempChart({
  title,
  series,
  startSec,
  endSec,
  palette,
}: {
  title: string;
  series: ChartSeries[];
  startSec: number;
  endSec: number;
  palette: ChartPalette;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hasPoint = series.some((line) => line.points.some((point) => point.v != null));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const draw = () => drawTempChart(canvas, series, startSec, endSec, palette);
    draw();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => draw());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [series, startSec, endSec, palette]);

  return (
    <article className="temps-chart" aria-label={`${title} 温度曲线`}>
      <header className="temps-chart-head">
        <h3>{title}</h3>
        <ul className="temps-legend">
          {series.map((line) => (
            <li key={line.label}>
              <span className="temps-swatch" style={{ background: line.color }} />
              {line.label}
            </li>
          ))}
        </ul>
      </header>
      <canvas ref={canvasRef} aria-hidden="true" />
      <p className="visually-hidden">
        {title}。
        {series.map((line) => `${line.label} ${formatTemp(lastValue(line.points), 1)}°C`).join("，")}
        。纵轴 0 到 {CHART_Y_MAX}°C。
      </p>
      {!hasPoint && <p className="temps-chart-empty">此范围没有采样</p>}
    </article>
  );
}

const CHART_PAD = { l: 36, r: 8, t: 12, b: 22 };

function drawTempChart(
  canvas: HTMLCanvasElement,
  series: ChartSeries[],
  startSec: number,
  endSec: number,
  palette: ChartPalette,
) {
  const cssW = canvas.clientWidth;
  const cssH = canvas.clientHeight || 168;
  if (cssW < 8) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const nextW = Math.max(1, Math.round(cssW * dpr));
  const nextH = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== nextW || canvas.height !== nextH) {
    canvas.width = nextW;
    canvas.height = nextH;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const plotW = cssW - CHART_PAD.l - CHART_PAD.r;
  const plotH = cssH - CHART_PAD.t - CHART_PAD.b;
  const span = Math.max(1, endSec - startSec);
  const xOf = (t: number) => CHART_PAD.l + ((t - startSec) / span) * plotW;
  const yOf = (value: number) =>
    CHART_PAD.t + (1 - Math.min(CHART_Y_MAX, Math.max(0, value)) / CHART_Y_MAX) * plotH;

  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.lineWidth = 1;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const tick of [0, 55, 110]) {
    const y = yOf(tick);
    ctx.strokeStyle = palette.grid;
    ctx.beginPath();
    ctx.moveTo(CHART_PAD.l, y);
    ctx.lineTo(cssW - CHART_PAD.r, y);
    ctx.stroke();
    ctx.fillStyle = palette.label;
    ctx.fillText(String(tick), CHART_PAD.l - 6, y);
  }

  ctx.lineWidth = 1.75;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const line of series) {
    ctx.strokeStyle = line.color;
    ctx.fillStyle = line.color;
    let segment: { x: number; y: number }[] = [];
    const flush = () => {
      if (segment.length === 1) {
        const point = segment[0]!;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 2.4, 0, Math.PI * 2);
        ctx.fill();
      } else if (segment.length > 1) {
        ctx.beginPath();
        ctx.moveTo(segment[0]!.x, segment[0]!.y);
        for (let i = 1; i < segment.length; i += 1) ctx.lineTo(segment[i]!.x, segment[i]!.y);
        ctx.stroke();
      }
      segment = [];
    };
    for (const point of line.points) {
      if (point.v == null) flush();
      else segment.push({ x: xOf(point.t), y: yOf(point.v) });
    }
    flush();
  }

  const startLabel = axisClock(startSec);
  const endLabel = axisClock(endSec);
  ctx.fillStyle = palette.label;
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillText(startLabel, CHART_PAD.l, cssH - 14);
  ctx.textAlign = "right";
  ctx.fillText(endLabel, cssW - CHART_PAD.r, cssH - 14);
}

function axisClock(timestampSec: number): string {
  const date = new Date(timestampSec * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

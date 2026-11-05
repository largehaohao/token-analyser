import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
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
  formatTemp,
  isStale,
  mergeTempSamples,
  readSeries,
  readingTone,
  worstGpuStatus,
  type TempPeriodId,
  type TempReadingTone,
} from "./hardware-temps";
import { Icon, Notice, SegmentedControl, srTable } from "./ui";

const POLL_MS = 2000;
const HISTORY_SECONDS = 3600;
/** 实时柱状读数与历史曲线共用同一个温度刻度顶，方便上下对照。 */
const TEMP_SCALE_TOP = 110;

function scalePercent(value: number | null): number {
  if (value == null || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, (value / TEMP_SCALE_TOP) * 100));
}

const GPU_SENSORS = [
  { key: "edge", label: "核心", swatch: "blue" },
  { key: "junction", label: "热点", swatch: "orange" },
  { key: "memory", label: "显存", swatch: "violet" },
] as const;

const PERIOD_OPTIONS = TEMP_PERIODS.map((item) => ({
  id: String(item.id),
  label: item.label.replace(/^最近\s*/, ""),
}));

type SensorKey = (typeof GPU_SENSORS)[number]["key"];
type Swatch = (typeof GPU_SENSORS)[number]["swatch"];
type ChartPoint = { t: number; v: number | null };
type ChartSeries = {
  label: string;
  color: string;
  points: ChartPoint[];
  /** 停机线（°C）：有值时画同色虚线；CPU 系列不画。 */
  limit?: number | null;
};
type ChartPalette = {
  blue: string;
  orange: string;
  violet: string;
  grid: string;
  label: string;
  surface: string;
};
type LinkState = "unknown" | "up" | "down";
type Tightest = {
  margin: number;
  value: number;
  limit: number;
  sensor: string;
  gpuId: number;
};

const FALLBACK_PALETTE: ChartPalette = {
  blue: "#3b7ad0",
  orange: "#be6d21",
  violet: "#8b63be",
  grid: "#e5e9ef",
  label: "#7a8494",
  surface: "#ffffff",
};

function isAbortError(err: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" &&
      err instanceof DOMException &&
      err.name === "AbortError") ||
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
  return limit != null && Number.isFinite(limit) && limit > 0
    ? limit
    : TEMP_DISPLAY_LIMITS[key];
}

function statusLabel(
  status: TempReadingTone | TempCpuDto["status"] | "partial",
): string {
  switch (status) {
    case "normal":
    case "available":
      return "温度正常";
    case "warm":
      return "温度偏热";
    case "over":
      return "温度超限";
    case "partial":
      return "部分读数";
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

function formatGiB(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const digits = value >= 10 ? 1 : 2;
  return String(Number(value.toFixed(digits)));
}

/** 图片风格的短名：AMD Radeon RX 7900 XTX → RX 7900 XTX。 */
function shortGpuName(name: string | null | undefined): string | null {
  if (!name) return null;
  return name.replace(/^AMD Radeon\s+/i, "").trim() || name;
}

function shortCpuName(name: string | null | undefined): string | null {
  if (!name) return null;
  return name.replace(/^AMD\s+/i, "").trim() || name;
}

/** 页头标题跟随实际显卡数量，不再把「双卡」写死。 */
function pageTitle(count: number | null): string {
  if (count == null || count === 2) return "CPU 与双卡温度";
  if (count === 0) return "CPU 温度";
  if (count === 1) return "CPU 与单卡温度";
  return `CPU 与 ${count} 张显卡温度`;
}

/** 页头副标题：优先用真实采样里的硬件名，未采样时退回契约文案。 */
function headline(sample: TempSampleDto | null): string {
  if (!sample) return "等待首次采样。缺失读数保持为 —，不填入示例数据。";
  const cpu = shortCpuName(sample.cpu.name) ?? "本机 CPU";
  const gpu = shortGpuName(sample.gpus[0]?.name);
  const count = sample.gpus.length;
  if (!gpu || count === 0) return `${cpu} · 实时温度`;
  return `${cpu} · ${count} × ${gpu} · 实时温度与散热余量`;
}

function formatClock(timestampSec: number): string {
  const date = new Date(timestampSec * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function marginLabel(value: number | null, limit: number): string {
  if (value == null || !Number.isFinite(value) || !Number.isFinite(limit)) return "—";
  return `${Math.max(0, Math.round(limit - value))}°C`;
}

/** 所有传感器里距离停机线最近的一路，是这一屏最该被看见的派生信息。 */
function tightestMargin(sample: TempSampleDto | null): Tightest | null {
  if (!sample) return null;
  let best: Tightest | null = null;
  for (const gpu of sample.gpus) {
    for (const sensor of GPU_SENSORS) {
      const value = gpu.temperatures[sensor.key].value;
      if (value == null || !Number.isFinite(value)) continue;
      const limit = sensorLimit(gpu, sensor.key);
      const margin = limit - value;
      if (!best || margin < best.margin) {
        best = {
          margin,
          value,
          limit,
          sensor: sensor.label,
          gpuId: gpu.id,
        };
      }
    }
  }
  return best;
}

function guardMessage(tone: string, sample: TempSampleDto | null): string {
  if (!sample || tone === "idle")
    return "正在确认采集。停机线如下，返回前不显示温度数字。";
  if (tone === "stale") return "上次采样已保留，温度数字可能已经过期。";
  if (tone === "over") return "告警：至少一路温度已超过停机线。";
  if (tone === "warm")
    return `注意：至少一路温度距停机线不超过 ${WARM_MARGIN_C}°C。`;
  if (tone === "missing") return "在线，但部分传感器没有读数，缺失项显示为 —。";
  if (sample.cpu.status !== "available")
    return "在线，CPU 读数不完整，缺失项显示为 —。";
  const count = sample.gpus.length;
  return `在线：${count === 2 ? "双卡" : `${count} 张显卡`}温度都在停机线以下。`;
}

function lastValue(points: ChartPoint[]): number | null {
  for (let i = points.length - 1; i >= 0; i -= 1) {
    const value = points[i]?.v;
    if (value != null) return value;
  }
  return null;
}

function seriesStats(points: ChartPoint[]) {
  const values = points
    .map((point) => point.v)
    .filter((value): value is number => value != null && Number.isFinite(value));
  return {
    count: values.length,
    last: lastValue(points),
    min: values.length > 0 ? Math.min(...values) : null,
    max: values.length > 0 ? Math.max(...values) : null,
  };
}

function chartYMax(series: ChartSeries[]): number {
  let highest = 0;
  for (const line of series) {
    if (line.limit != null && Number.isFinite(line.limit)) {
      highest = Math.max(highest, line.limit);
    }
    for (const point of line.points) {
      if (point.v != null && Number.isFinite(point.v)) {
        highest = Math.max(highest, point.v);
      }
    }
  }
  return Math.max(TEMP_SCALE_TOP, Math.ceil((highest + 5) / 10) * 10);
}

function readPalette(): ChartPalette {
  if (typeof document === "undefined") return FALLBACK_PALETTE;
  const style = getComputedStyle(document.documentElement);
  const pick = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    blue: pick("--chart-blue", FALLBACK_PALETTE.blue),
    orange: pick("--chart-orange", FALLBACK_PALETTE.orange),
    violet: pick("--chart-violet", FALLBACK_PALETTE.violet),
    grid: pick("--border", FALLBACK_PALETTE.grid),
    label: pick("--text-dim", FALLBACK_PALETTE.label),
    surface: pick("--bg-raised", FALLBACK_PALETTE.surface),
  };
}

function colorFor(palette: ChartPalette, swatch: Swatch): string {
  if (swatch === "blue") return palette.blue;
  if (swatch === "orange") return palette.orange;
  return palette.violet;
}

export function SystemTemperaturePage({ now }: { now: number }) {
  const [samples, setSamples] = useState<TempSampleDto[]>([]);
  const [latest, setLatest] = useState<TempSampleDto | null>(null);
  const [link, setLink] = useState<LinkState>("unknown");
  const [error, setError] = useState<string | null>(null);
  const [sourceUrl, setSourceUrl] = useState<string | null>(null);
  const [historySettled, setHistorySettled] = useState(false);
  const [pollSettled, setPollSettled] = useState(false);
  const [period, setPeriod] = useState<TempPeriodId>(3600);
  const [clock, setClock] = useState(() => Date.now());
  const [palette, setPalette] = useState<ChartPalette>(FALLBACK_PALETTE);
  const historyRetry = useRef(0);

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
        if (feed.url) setSourceUrl(feed.url);
        if (feed.connected) {
          if (feed.samples.length > 0) {
            setSamples((current) => mergeTempSamples(feed.samples, current));
            const newest = newestSample(feed.samples);
            if (newest) {
              setLatest((prev) =>
                !prev || newest.timestamp > prev.timestamp ? newest : prev,
              );
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
        if (stopped || isAbortError(err) || pollOk.current === true) return;
        setLink("down");
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!stopped) setHistorySettled(true);
      });

    const poll = async () => {
      // A hidden tab keeps readable data but stops generating requests.
      if (stopped || busy || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const feed = await getTemps(pollController.signal);
        if (stopped) return;
        pollOk.current = feed.connected;
        if (feed.url) setSourceUrl(feed.url);
        if (feed.connected) {
          const sample = toSample(feed);
          setLatest((prev) =>
            !prev || sample.timestamp >= prev.timestamp ? sample : prev,
          );
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

    function onVisibilityChange() {
      if (document.visibilityState === "visible") void poll();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    void poll();
    const intervalId = window.setInterval(() => void poll(), POLL_MS);
    return () => {
      stopped = true;
      historyController.abort();
      pollController.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.clearInterval(intervalId);
    };
  }, []);

  // A transient history failure used to leave the charts permanently empty
  // even after live polling recovered. Retry exactly once in that case.
  useEffect(() => {
    if (
      link !== "up" ||
      !historySettled ||
      samples.length > 0 ||
      historyRetry.current >= 1
    ) {
      return;
    }
    historyRetry.current += 1;
    let cancelled = false;
    const controller = new AbortController();
    void getTempsHistory(HISTORY_SECONDS, controller.signal)
      .then((feed) => {
        if (cancelled || !feed.connected || feed.samples.length === 0) return;
        setSamples((current) => mergeTempSamples(feed.samples, current));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [link, historySettled, samples.length]);

  const nowSec = Math.max(clock / 1000, latest?.timestamp ?? 0);
  // Charts only need to move when a new sample can arrive; quantising keeps a
  // 1s status clock from forcing three full canvas redraws every second.
  const chartNowSec = Math.ceil(nowSec / 2) * 2;
  const windowed = useMemo(
    () => filterSamplesByWindow(samples, chartNowSec, period),
    [samples, chartNowSec, period],
  );
  const ageStale = latest != null && isStale(latest.timestamp, clock);
  const live = latest != null && link !== "down" && !ageStale;
  const retained =
    latest != null && !live && pollSettled && (ageStale || link === "down");
  const offline = latest == null && historySettled && pollSettled;
  const loading = !latest && !offline;

  // Before the first sample we only reserve two neutral placeholders. Once the
  // hardware is known, the page follows the real device list instead of
  // pretending every host has exactly two GPUs.
  const gpuIds = useMemo(
    () =>
      latest && latest.gpus.length > 0
        ? latest.gpus.map((gpu) => gpu.id).sort((a, b) => a - b)
        : [0, 1],
    [latest],
  );
  const gpuStatus = worstGpuStatus(
    latest ? latest.gpus.map((gpu) => gpu.status) : [],
  );
  const guardTone = !latest
    ? "idle"
    : ageStale || link === "down"
      ? "stale"
      : gpuStatus;
  const guardGpu = gpuById(latest?.gpus ?? [], gpuIds[0] ?? 0);
  const tightest = useMemo(() => tightestMargin(latest), [latest]);
  const ageSec =
    latest != null ? Math.max(0, Math.round(nowSec - latest.timestamp)) : null;

  const gpuSeries = (id: number): ChartSeries[] => {
    const gpu = gpuById(latest?.gpus ?? [], id);
    return GPU_SENSORS.map((sensor) => ({
      label: sensor.label,
      color: colorFor(palette, sensor.swatch),
      limit: sensorLimit(gpu, sensor.key),
      points: readSeries(
        windowed,
        (sample) =>
          gpuById(sample.gpus, id)?.temperatures[sensor.key].value ?? null,
      ),
    }));
  };
  const cpuSeries: ChartSeries[] = [
    {
      label: "Tctl",
      color: palette.blue,
      points: readSeries(windowed, (sample) => sample.cpu.temperatures.tctl.value),
    },
    {
      label: "Tccd1",
      color: palette.violet,
      points: readSeries(
        windowed,
        (sample) => sample.cpu.temperatures.tccd1.value,
      ),
    },
  ];

  return (
    <main
      className="overview temps-page"
      data-testid="temps-page"
      aria-busy={loading || undefined}
    >
      <header className="page-heading temps-header">
        <div className="page-heading-copy">
          <p className="temps-kicker">系统监控 / 温度</p>
          <h1 tabIndex={-1}>
            {pageTitle(latest ? latest.gpus.length : null)}
          </h1>
          <p>{headline(latest)}</p>
        </div>
        <div className="temps-live">
          <span
            className={`temps-pill ${live ? "temps-pill-live" : retained ? "temps-pill-stale" : offline ? "temps-pill-offline" : "temps-pill-missing"}`}
            data-testid="temps-pill"
          >
            {live ? "实时采样" : retained ? "已过期" : offline ? "未连接" : "读取中"}
          </span>
          {latest ? (
            <time dateTime={new Date(latest.timestamp * 1000).toISOString()}>
              {formatClock(latest.timestamp)} 更新
            </time>
          ) : (
            <span>尚未采样</span>
          )}
          <span className="temps-live-meta" title={sourceUrl ?? undefined}>
            {ageSec != null ? `数据 ${ageSec} 秒前` : "每 2 秒采样"} · 每 2 秒刷新
          </span>
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

      <section
        className={`temps-guard temps-guard-${guardTone}`}
        aria-label="温度保护"
      >
        <div className="temps-guard-main">
          <span className="temps-guard-icon" aria-hidden="true">
            <Icon
              name={
                guardTone === "over" ||
                guardTone === "warm" ||
                guardTone === "stale"
                  ? "warning"
                  : "check"
              }
            />
          </span>
          <p className="temps-guard-copy">
            {guardMessage(guardTone, latest)}
          </p>
        </div>
        <div className="temps-guard-side">
          {tightest && (
            <span
              className={`temps-margin-chip ${
                tightest.margin <= 0
                  ? "is-over"
                  : tightest.margin <= WARM_MARGIN_C
                    ? "is-warm"
                    : "is-ok"
              }`}
            >
              最紧余量 <b>{marginLabel(tightest.value, tightest.limit)}</b>
              <span className="temps-margin-detail">
                GPU {tightest.gpuId} · {tightest.sensor} {formatTemp(tightest.value, 0)}°C
              </span>
            </span>
          )}
          <p className="temps-guard-limits">
            <span className="temps-guard-limits-label">GPU 停机线</span>
            {(["edge", "junction", "memory"] as const).map((key, index) => (
              <span className="temps-guard-limit" key={key}>
                {GPU_SENSORS[index]!.label}{" "}
                <b>{sensorLimit(guardGpu, key)}°C</b>
              </span>
            ))}
          </p>
        </div>
      </section>

      <section className="temps-section" aria-label="实时读数">
        <div className="temps-section-head">
          <div>
            <p className="temps-kicker">实时读数</p>
            <h2 className="temps-section-title">传感器与散热余量</h2>
          </div>
          <p className="temps-section-meta" title={sourceUrl ?? undefined}>
            <Icon name="clock" /> 数据源 Prometheus · 每 2 秒采样 · 无示例数据
          </p>
        </div>
        <div className="temps-gpu-grid">
          {gpuIds.map((id) => (
            <GpuCard
              key={id}
              id={id}
              gpu={latest ? gpuById(latest.gpus, id) : null}
              stale={retained}
            />
          ))}
        </div>
        <CpuCard cpu={latest?.cpu ?? null} live={live} stale={retained} />
      </section>

      <section className="temps-history" aria-label="温度历史">
        <div className="chart-head temps-history-head">
          <div>
            <p className="temps-kicker">历史趋势</p>
            <h2 className="chart-title">温度历史</h2>
            <p className="chart-desc">
              虚线是各传感器停机线，空档断开、不补 0。
              <span className="temps-hint-desktop">
                悬停或聚焦曲线后用 ← → 查看每个采样。
              </span>
              <span className="temps-hint-touch">轻触曲线查看某一时刻的读数。</span>
            </p>
          </div>
          <div className="temps-period">
            <span className="filter-label">时间范围</span>
            <SegmentedControl
              className="temps-period-control"
              label="温度历史时间范围"
              value={String(period)}
              options={PERIOD_OPTIONS}
              onChange={(id) => {
                const next = Number(id);
                if (TEMP_PERIODS.some((item) => item.id === next)) {
                  setPeriod(next as TempPeriodId);
                }
              }}
            />
          </div>
        </div>
        <div className="temps-chart-grid">
          {gpuIds.map((id) => (
            <TempChart
              key={id}
              title={`GPU ${id}`}
              palette={palette}
              startSec={chartNowSec - period}
              endSec={chartNowSec}
              series={gpuSeries(id)}
            />
          ))}
          <TempChart
            title="CPU"
            palette={palette}
            digits={1}
            startSec={chartNowSec - period}
            endSec={chartNowSec}
            series={cpuSeries}
          />
        </div>
      </section>
    </main>
  );
}

function GpuCard({
  id,
  gpu,
  stale,
}: {
  id: number;
  gpu: TempGpuDto | null;
  stale: boolean;
}) {
  const status = gpu?.status ?? "missing";
  const fanStopped = gpu?.fan_rpm === 0;
  return (
    <article
      className="temps-gpu-card"
      data-testid={`temps-gpu-${id}`}
      data-stale={stale || undefined}
      aria-label={`GPU ${id}`}
    >
      <header className="temps-card-head">
        <div className="temps-card-title">
          <span className="temps-badge" aria-hidden="true">
            {String(id + 1).padStart(2, "0")}
          </span>
          <div>
            <h2>
              GPU {id}
              {gpu?.name ? ` · ${shortGpuName(gpu.name)}` : ""}
            </h2>
            <p className="temps-card-meta">{gpu?.card ?? "—"}</p>
          </div>
        </div>
        <div className="temps-card-flags">
          {stale && <span className="temps-stale-tag">数据已过期</span>}
          <span className={`temps-pill ${pillClass(status)}`}>
            {statusLabel(status)}
          </span>
        </div>
      </header>
      <div className="temps-sensors temps-sensors-columns">
        {GPU_SENSORS.map((sensor) => {
          const reading = gpu?.temperatures[sensor.key] ?? null;
          const value = reading?.value ?? null;
          const limit = sensorLimit(gpu, sensor.key);
          const tone = readingTone(value, limit);
          return (
            <div key={sensor.key} className="temps-sensor">
              <span className="temps-sensor-label">
                <i
                  className={`temps-dot temps-dot-${sensor.swatch}`}
                  aria-hidden="true"
                />
                {sensor.label}
              </span>
              <p
                className={`temps-sensor-value temps-value-${tone}`}
                data-testid={`temps-gpu-${id}-${sensor.key}`}
              >
                {formatTemp(value, 0)}
                {value != null && <span className="temps-sensor-unit">°C</span>}
              </p>
              <div
                className={`temps-meter temps-meter-${sensor.swatch} temps-meter-${tone}`}
                style={
                  {
                    "--fill": `${scalePercent(value)}%`,
                    "--limit": `${scalePercent(limit)}%`,
                    "--warm-start": `${scalePercent(limit - WARM_MARGIN_C)}%`,
                  } as CSSProperties
                }
                role={value == null ? undefined : "meter"}
                aria-label={value == null ? undefined : `${sensor.label}温度`}
                aria-valuemin={value == null ? undefined : 0}
                aria-valuemax={value == null ? undefined : TEMP_SCALE_TOP}
                aria-valuenow={
                  value == null
                    ? undefined
                    : Math.min(TEMP_SCALE_TOP, Math.max(0, value))
                }
                aria-valuetext={
                  value == null
                    ? undefined
                    : `${formatTemp(value, 0)} 摄氏度，共用刻度 0 到 ${TEMP_SCALE_TOP} 摄氏度，停机线 ${limit} 摄氏度，余量 ${marginLabel(value, limit)}`
                }
              >
                <span className="temps-meter-fill" />
                <span className="temps-meter-limit" aria-hidden="true" />
              </div>
              <span className="temps-sensor-range">
                <span>停机线 {limit}°C</span>
                <span>余量 {marginLabel(value, limit)}</span>
              </span>
            </div>
          );
        })}
      </div>
      <p className="temps-scale-note">
        三条共用 0–{TEMP_SCALE_TOP}°C 刻度 · 虚线是各自停机线，柱顶到虚线就是余量
      </p>
      <dl className="temps-stats">
        <div>
          <dt>风扇转速</dt>
          <dd>
            {gpu && gpu.fan_rpm != null
              ? `${formatTemp(gpu.fan_rpm, 0)} RPM`
              : "—"}
            {fanStopped && <span className="temps-stat-flag">停转</span>}
          </dd>
        </div>
        <div>
          <dt>GPU 功耗 / 上限</dt>
          <dd>
            {gpu && gpu.power_w != null
              ? `${formatTemp(gpu.power_w, 0)} W`
              : "—"}
            {gpu?.power_cap_w != null && (
              <small className="temps-stat-sub">
                / {formatTemp(gpu.power_cap_w, 0)} W
              </small>
            )}
          </dd>
        </div>
        <div>
          <dt>GPU 负载</dt>
          <dd>
            {gpu && gpu.utilization != null
              ? `${formatTemp(gpu.utilization, 0)} %`
              : "—"}
          </dd>
        </div>
        <div>
          <dt>显存占用 / 总量</dt>
          <dd>
            {gpu && gpu.vram_used_gib != null
              ? `${formatGiB(gpu.vram_used_gib)} GiB`
              : "—"}
            {gpu?.vram_total_gib != null && (
              <small className="temps-stat-sub">
                / {formatGiB(gpu.vram_total_gib)} GiB
              </small>
            )}
          </dd>
        </div>
      </dl>
    </article>
  );
}

function CpuCard({
  cpu,
  live,
  stale,
}: {
  cpu: TempCpuDto | null;
  live: boolean;
  stale: boolean;
}) {
  const status = cpu?.status ?? "missing";
  const rows = [
    {
      key: "tctl",
      label: "控温 · Tctl",
      swatch: "blue",
      value: cpu?.temperatures.tctl.value ?? null,
    },
    {
      key: "tccd1",
      label: "芯粒 · Tccd1",
      swatch: "violet",
      value: cpu?.temperatures.tccd1.value ?? null,
    },
  ];
  const monitoring = live && status === "available";
  return (
    <section
      className="temps-cpu-card"
      data-stale={stale || undefined}
      aria-label="CPU 温度"
    >
      <div className="temps-cpu-id">
        <p className="temps-kicker">CPU 温度</p>
        <h2>{cpu?.name ?? "等待采样"}</h2>
        <span
          className={`temps-pill ${
            stale
              ? "temps-pill-stale"
              : monitoring
                ? "temps-pill-ok"
                : pillClass(status)
          }`}
        >
          {stale ? "数据已过期" : monitoring ? "实时监测" : statusLabel(status)}
        </span>
      </div>
      <div className="temps-cpu-grid">
        {rows.map((row) => (
          <div key={row.key} className="temps-sensor">
            <span className="temps-sensor-label">
              <i
                className={`temps-dot temps-dot-${row.swatch}`}
                aria-hidden="true"
              />
              {row.label}
            </span>
            <p
              className="temps-sensor-value temps-sensor-value-cpu"
              data-testid={`temps-cpu-${row.key}`}
            >
              {formatTemp(row.value, 1)}
              {row.value != null && (
                <span className="temps-sensor-unit">°C</span>
              )}
            </p>
          </div>
        ))}
      </div>
      <p className="temps-cpu-note">
        CPU 无停机线设定
        <br />
        仅展示实测温度
      </p>
    </section>
  );
}

function TempChart({
  title,
  series,
  startSec,
  endSec,
  palette,
  digits = 0,
}: {
  title: string;
  series: ChartSeries[];
  startSec: number;
  endSec: number;
  palette: ChartPalette;
  /** 浮层与摘要的小数位：GPU 整数、CPU 一位，与卡片数值一致。 */
  digits?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hoverRef = useRef<{ index: number; x: number } | null>(null);
  const [hover, setHover] = useState<{
    index: number;
    x: number;
    flip: boolean;
  } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const grid = series[0]?.points ?? [];
  const hasPoint = series.some((line) =>
    line.points.some((point) => point.v != null),
  );
  const primary = seriesStats(grid);
  const yMax = chartYMax(series);
  const hasLimits = series.some((line) => line.limit != null);

  const drawRef = useRef<() => void>(() => {});
  drawRef.current = () => {
    const canvas = canvasRef.current;
    if (canvas) {
      drawTempChart(
        canvas,
        series,
        startSec,
        endSec,
        palette,
        yMax,
        hoverRef.current,
      );
    }
  };
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    drawRef.current();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => drawRef.current());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    drawRef.current();
  }, [series, startSec, endSec, palette, yMax]);

  function showIndex(index: number, announce = false) {
    const canvas = canvasRef.current;
    const sample = grid[index];
    if (!canvas || !sample) return;
    const plotW = canvas.clientWidth - CHART_PAD.l - CHART_PAD.r;
    if (plotW <= 0) return;
    const span = Math.max(1, endSec - startSec);
    const x = Math.max(
      CHART_PAD.l,
      Math.min(
        canvas.clientWidth - CHART_PAD.r,
        CHART_PAD.l + ((sample.t - startSec) / span) * plotW,
      ),
    );
    hoverRef.current = { index, x };
    drawRef.current();
    setHover({ index, x, flip: x > canvas.clientWidth * 0.6 });
    if (announce) {
      setAnnouncement(
        `${axisClock(sample.t)}，${series
          .map((line) => {
            const value = line.points[index]?.v ?? null;
            return `${line.label} ${value == null ? "无读数" : `${formatTemp(value, digits)} 摄氏度`}`;
          })
          .join("，")}`,
      );
    }
  }

  function clearHover() {
    if (!hoverRef.current) return;
    hoverRef.current = null;
    drawRef.current();
    setHover(null);
  }

  /** 指针位置 → 最近采样。所有 series 共用同一份采样网格，索引互通。 */
  function handlePointerMove(event: ReactPointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas || grid.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    const pointerX = event.clientX - rect.left;
    const plotW = canvas.clientWidth - CHART_PAD.l - CHART_PAD.r;
    if (plotW <= 0) return;
    const span = Math.max(1, endSec - startSec);
    const t = startSec + ((pointerX - CHART_PAD.l) / plotW) * span;
    let low = 0;
    let high = grid.length - 1;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if ((grid[mid]?.t ?? 0) < t) low = mid;
      else high = mid;
    }
    const before = grid[low]!;
    const after = grid[high]!;
    showIndex(Math.abs(before.t - t) <= Math.abs(after.t - t) ? low : high);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (grid.length === 0) return;
    if (event.key === "Escape") {
      clearHover();
      return;
    }
    const current = hover?.index ?? grid.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = Math.max(0, current - 1);
    else if (event.key === "ArrowRight")
      next = Math.min(grid.length - 1, current + 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = grid.length - 1;
    else return;
    event.preventDefault();
    showIndex(next, true);
  }

  const hoverTime = hover != null ? grid[hover.index]?.t : null;
  const valueText = (value: number | null) =>
    value == null ? "—" : formatTemp(value, digits);
  const valueWithUnit = (value: number | null) =>
    value == null ? "—" : `${formatTemp(value, digits)}°C`;

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
          {hasLimits && (
            <li className="temps-legend-limit">
              <span className="temps-swatch-dashed" aria-hidden="true" />
              停机线
            </li>
          )}
        </ul>
      </header>
      <div
        className="temps-chart-body"
        role="group"
        tabIndex={0}
        aria-label={`${title} 温度曲线。用左右方向键查看采样，Home 与 End 跳到两端，Escape 关闭读数。`}
        onKeyDown={handleKeyDown}
        onBlur={clearHover}
      >
        <canvas
          ref={canvasRef}
          aria-hidden="true"
          onPointerDown={handlePointerMove}
          onPointerMove={handlePointerMove}
          onPointerLeave={(event) => {
            // 触摸抬起时浏览器会补发 pointerleave；保留读数让用户看清楚。
            if (event.pointerType !== "touch") clearHover();
          }}
        />
        {hover != null && hoverTime != null && (
          <div
            className={`temps-tooltip${hover.flip ? " temps-tooltip-flip" : ""}`}
            style={{ left: hover.x }}
            aria-hidden="true"
          >
            <b className="temps-tooltip-time">{formatClock(hoverTime)}</b>
            {series.map((line) => {
              const value = line.points[hover.index]?.v ?? null;
              return (
                <span className="temps-tooltip-row" key={line.label}>
                  <i style={{ background: line.color }} />
                  <span className="temps-tooltip-label">{line.label}</span>
                  <b>{value == null ? "—" : `${formatTemp(value, digits)}°C`}</b>
                </span>
              );
            })}
          </div>
        )}
        {!hasPoint && <p className="temps-chart-empty">此范围没有采样</p>}
      </div>
      <footer className="temps-chart-foot">
        {hasPoint ? (
          <>
            <span>
              当前 <b>{valueWithUnit(primary.last)}</b>
            </span>
            <span>
              峰值 <b>{valueWithUnit(primary.max)}</b>
            </span>
            <span>{primary.count} 个采样</span>
          </>
        ) : (
          <span>暂无可用采样</span>
        )}
      </footer>
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
      <p className="visually-hidden">
        {title}。纵轴 0 到 {yMax}°C。
        {series.map((line) => `${line.label} ${formatTemp(lastValue(line.points), digits)}°C`).join("，")}
        。
      </p>
      {srTable(
        `${title} 温度历史摘要`,
        ["传感器", "当前 (°C)", "区间最低 (°C)", "区间最高 (°C)", "采样数"],
        series.map((line) => {
          const stats = seriesStats(line.points);
          return [
            line.label,
            valueText(stats.last),
            valueText(stats.min),
            valueText(stats.max),
            String(stats.count),
          ];
        }),
      )}
    </article>
  );
}

const CHART_PAD = { l: 38, r: 12, t: 20, b: 24 };

function drawTempChart(
  canvas: HTMLCanvasElement,
  series: ChartSeries[],
  startSec: number,
  endSec: number,
  palette: ChartPalette,
  yMax: number,
  hover?: { index: number; x: number } | null,
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
    CHART_PAD.t + (1 - Math.min(yMax, Math.max(0, value)) / yMax) * plotH;

  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.lineWidth = 1;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (const tick of [0, yMax / 2, yMax]) {
    const y = yOf(tick);
    ctx.strokeStyle = palette.grid;
    ctx.beginPath();
    ctx.moveTo(CHART_PAD.l, y);
    ctx.lineTo(cssW - CHART_PAD.r, y);
    ctx.stroke();
    ctx.fillStyle = palette.label;
    ctx.fillText(String(Math.round(tick)), CHART_PAD.l - 6, y);
  }
  ctx.save();
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.fillStyle = palette.label;
  ctx.textAlign = "right";
  ctx.fillText("°C", CHART_PAD.l - 6, CHART_PAD.t / 2);
  ctx.restore();

  // 各传感器的停机线：同色虚线 + 右端数值，给曲线一个可读参照。
  const limitLabels: { y: number; text: string; color: string }[] = [];
  ctx.save();
  ctx.setLineDash([5, 4]);
  ctx.lineWidth = 1;
  for (const line of series) {
    if (line.limit == null || !Number.isFinite(line.limit)) continue;
    const y = yOf(line.limit);
    ctx.strokeStyle = line.color;
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.moveTo(CHART_PAD.l, y);
    ctx.lineTo(cssW - CHART_PAD.r, y);
    ctx.stroke();
    limitLabels.push({
      y,
      text: `${Math.round(line.limit)}°`,
      color: line.color,
    });
  }
  ctx.restore();
  ctx.save();
  ctx.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  let lastLabelY = -Infinity;
  for (const label of limitLabels.sort((a, b) => a.y - b.y)) {
    const y = Math.max(label.y - 2, lastLabelY + 11);
    ctx.fillStyle = label.color;
    ctx.globalAlpha = 0.9;
    ctx.fillText(label.text, cssW - CHART_PAD.r - 2, y);
    lastLabelY = y;
  }
  ctx.restore();

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
        for (let i = 1; i < segment.length; i += 1)
          ctx.lineTo(segment[i]!.x, segment[i]!.y);
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

  // 悬停准线 + 各系列读数点；具体数值由 DOM 浮层展示。
  if (hover) {
    ctx.save();
    ctx.strokeStyle = palette.label;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(hover.x, CHART_PAD.t);
    ctx.lineTo(hover.x, cssH - CHART_PAD.b);
    ctx.stroke();
    ctx.restore();
    for (const line of series) {
      const value = line.points[hover.index]?.v;
      if (value == null) continue;
      ctx.beginPath();
      ctx.arc(hover.x, yOf(value), 3.2, 0, Math.PI * 2);
      ctx.fillStyle = line.color;
      ctx.fill();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = palette.surface;
      ctx.stroke();
    }
  }

  ctx.fillStyle = palette.label;
  ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
  ctx.textBaseline = "top";
  const labelY = cssH - 16;
  ctx.textAlign = "left";
  ctx.fillText(axisClock(startSec), CHART_PAD.l, labelY);
  ctx.textAlign = "center";
  ctx.fillText(axisClock((startSec + endSec) / 2), CHART_PAD.l + plotW / 2, labelY);
  ctx.textAlign = "right";
  ctx.fillText(axisClock(endSec), cssW - CHART_PAD.r, labelY);
}

function axisClock(timestampSec: number): string {
  const date = new Date(timestampSec * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

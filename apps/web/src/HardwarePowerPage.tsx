import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_PRICE_CNY_PER_KWH,
  customRangePrefill,
  isLivePowerFeed,
  POWER_RANGES,
  POWER_SERIES,
  bucketizeSamples,
  chartBucketMs,
  demoPowerAdapter,
  energyCostCny,
  formatClock,
  formatCoverage,
  formatCny,
  formatDuration,
  formatKwh,
  formatPricePerKwh,
  formatWatts,
  formatWindowRange,
  integrateSeries,
  resolveQuickWindow,
  sampleStepMs,
  toLocalDateTimeInput,
  validateCustomRange,
  type PowerBucket,
  type PowerDataAdapter,
  type PowerQuickRangeId,
  type PowerSample,
  type PowerWindow,
  type SeriesIntegral,
  type SeriesPoint,
} from "./hardware-power";
import { getPowerFeed } from "./api";
import { Button, Notice, SegmentedControl, srTable } from "./ui";

type RangeMode =
  | { kind: "quick"; id: PowerQuickRangeId }
  | { kind: "custom"; window: PowerWindow };

const RANGE_OPTIONS: { id: PowerQuickRangeId | "custom"; label: string }[] = [
  ...POWER_RANGES.map((range) => ({ id: range.id, label: range.label })),
  { id: "custom", label: "自定义" },
];

const PLOT_LEFT = 44;
const PLOT_TOP = 8;
const PLOT_H = 208;
const COL_W = 24;
/** 瞬时功率短窗步长：与所选统计范围无关，始终以 now 为终点。 */
const INSTANT_STEP_MS = 30_000;

function seriesPoints(samples: PowerSample[], key: "cpu" | "gpu" | "machine"): SeriesPoint[] {
  return samples.map((s) => ({ t: s.t, v: s[key] }));
}

/** 其他硬件 = 整机 − CPU − GPU；三者任一缺失即无法推算，保持 null。 */
function otherPoints(samples: PowerSample[]): SeriesPoint[] {
  return samples.map((s) => ({
    t: s.t,
    v:
      s.machine != null && s.cpu != null && s.gpu != null
        ? Math.max(0, s.machine - s.cpu - s.gpu)
        : null,
  }));
}

function niceMaxW(value: number): number {
  return Math.max(100, Math.ceil(value / 50) * 50);
}

function parsePrice(raw: string): { value: number; error: string | null } {
  const trimmed = raw.trim();
  const v = Number(trimmed);
  if (trimmed === "" || !Number.isFinite(v) || v <= 0)
    return {
      value: 0,
      error: `请输入大于 0 的电价，例如 ${formatPricePerKwh(DEFAULT_PRICE_CNY_PER_KWH)}（元/kWh）。`,
    };
  if (v > 1000) return { value: 0, error: "电价过高，请检查单位（元/kWh）。" };
  return { value: v, error: null };
}

/**
 * 硬件用电页。整机是含其他硬件的总量（实时模式下为 Prometheus 的墙插
 * 估算），CPU / GPU 是分项：三条序列各自独立积分，任何统计都不把三者
 * 相加。数据优先来自后端 /power → Prometheus 实时采集；采集不可达时
 * 回退到演示适配器，并在页面显式标注“演示数据，尚未接入”。
 */
export function HardwarePowerPage({
  now,
  adapter = demoPowerAdapter,
}: {
  now: number;
  adapter?: PowerDataAdapter;
}) {
  const [mode, setMode] = useState<RangeMode>({ kind: "quick", id: "24h" });
  const [startDraft, setStartDraft] = useState("");
  const [endDraft, setEndDraft] = useState("");
  const [rangeErrors, setRangeErrors] = useState<
    { field: "start" | "end"; message: string }[]
  >([]);
  const [priceRaw, setPriceRaw] = useState(String(DEFAULT_PRICE_CNY_PER_KWH));
  const [tipIndex, setTipIndex] = useState<number | null>(null);
  const [tipPos, setTipPos] = useState({ left: 8, top: 8 });

  const price = parsePrice(priceRaw);

  const activeWindow: PowerWindow = useMemo(
    () =>
      mode.kind === "quick"
        ? resolveQuickWindow(mode.id, now)
        : mode.window,
    [mode, now],
  );
  const spanMs = activeWindow.endMs - activeWindow.startMs;
  const stepMs = sampleStepMs(spanMs);
  const bucketMs = chartBucketMs(spanMs, stepMs);

  // 后端 /power → Prometheus 实时采集；不可达或返回空时回退演示序列。
  const [feed, setFeed] = useState<{
    loading: boolean;
    connected: boolean;
    url: string | null;
    samples: PowerSample[] | null;
    error: string | null;
  }>({ loading: true, connected: false, url: null, samples: null, error: null });
  const feedRequest = useRef(0);
  useEffect(() => {
    const requestId = ++feedRequest.current;
    // 范围一切换就丢掉上一窗的 samples/connected，避免图表、积分和
    // “已接入”横幅在新范围标签下继续展示旧窗数据。
    setFeed((current) => ({
      loading: true,
      connected: false,
      url: current.url,
      samples: null,
      error: null,
    }));
    // 范围切换/卸载时主动取消在途请求（开发模式 StrictMode 下首轮请求
    // 会被立即取消，不能把它当“采集失败”，否则页面会闪回演示态）。
    const controller = new AbortController();
    getPowerFeed(activeWindow.startMs, activeWindow.endMs, stepMs, controller.signal)
      .then((result) => {
        if (requestId !== feedRequest.current) return;
        setFeed({
          loading: false,
          connected: isLivePowerFeed(result.connected, result.samples.length),
          url: result.url ?? null,
          samples: result.samples,
          error: result.connected ? null : (result.error ?? null),
        });
      })
      .catch((err: unknown) => {
        if (requestId !== feedRequest.current) return;
        const isAbort =
          typeof DOMException !== "undefined" &&
          err instanceof DOMException &&
          err.name === "AbortError";
        if (isAbort) return;
        setFeed({
          loading: false,
          connected: false,
          url: null,
          samples: null,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return () => {
      controller.abort();
    };
  }, [activeWindow.startMs, activeWindow.endMs, stepMs]);

  // 瞬时功率单独拉一段以 now 为终点的短窗，与所选统计范围解耦。
  const [instantSample, setInstantSample] = useState<PowerSample | null>(null);
  const instantRequest = useRef(0);
  useEffect(() => {
    const requestId = ++instantRequest.current;
    const controller = new AbortController();
    const startMs = now - 3 * INSTANT_STEP_MS;
    getPowerFeed(startMs, now, INSTANT_STEP_MS, controller.signal)
      .then((result) => {
        if (requestId !== instantRequest.current) return;
        const last =
          result.connected && result.samples.length > 0
            ? result.samples[result.samples.length - 1]!
            : null;
        setInstantSample(last);
      })
      .catch((err: unknown) => {
        if (requestId !== instantRequest.current) return;
        const isAbort =
          typeof DOMException !== "undefined" &&
          err instanceof DOMException &&
          err.name === "AbortError";
        if (isAbort) return;
        setInstantSample(null);
      });
    return () => {
      controller.abort();
    };
  }, [now]);

  const live = feed.connected && feed.samples != null;
  const samples = useMemo(() => {
    if (live && feed.samples) return feed.samples;
    // 已知采集地址时，重拉过程中不要闪回演示序列；首访（尚无 url）仍
    // 可用演示数据填满首屏，避免离线 e2e / 冷启动空表。
    if (feed.loading && feed.url) return [];
    return adapter.series(activeWindow.startMs, activeWindow.endMs, stepMs);
  }, [
    live,
    feed.samples,
    feed.loading,
    feed.url,
    adapter,
    activeWindow.startMs,
    activeWindow.endMs,
    stepMs,
  ]);

  const integrals: Record<"cpu" | "gpu" | "machine" | "other", SeriesIntegral> =
    useMemo(() => {
      const integrate = (points: SeriesPoint[]) =>
        integrateSeries(points, activeWindow.startMs, activeWindow.endMs);
      return {
        cpu: integrate(seriesPoints(samples, "cpu")),
        gpu: integrate(seriesPoints(samples, "gpu")),
        machine: integrate(seriesPoints(samples, "machine")),
        other: integrate(otherPoints(samples)),
      };
    }, [samples, activeWindow.startMs, activeWindow.endMs]);

  // 曲线展示把原始采样聚成可读的列（桶内均值 + 桶内峰值）；用电量、平均
  // 功率与峰值积分始终跑原始采样，分桶不会把尖峰抹平。
  const buckets: PowerBucket[] = useMemo(
    () => bucketizeSamples(samples, bucketMs, activeWindow.startMs),
    [samples, bucketMs, activeWindow.startMs],
  );
  // 分桶细于 1 分钟时，桶标签必须带上秒，否则起止看起来是同一刻。
  const bucketHasSeconds = bucketMs < 60_000;

  // 瞬时功率不受统计范围影响：优先用 now 短窗的最新采样；演示模式用
  // adapter.sampleAt(now)。实时但短窗尚未返回时，仅当范围终点≈now 才
  // 借用范围序列末点，避免历史自定义窗把“当前功率”显示成窗尾功率。
  const current: PowerSample = (() => {
    if (instantSample) return instantSample;
    if (!live) return adapter.sampleAt(now);
    if (
      feed.samples &&
      feed.samples.length > 0 &&
      activeWindow.endMs >= now - stepMs
    ) {
      return feed.samples[feed.samples.length - 1]!;
    }
    return { t: now, cpu: null, gpu: null, machine: null };
  })();
  const otherNow =
    current.machine != null && current.cpu != null && current.gpu != null
      ? Math.max(0, current.machine - current.cpu - current.gpu)
      : null;

  const cost = (integral: SeriesIntegral) =>
    energyCostCny(integral.kwh, price.value);

  function switchRange(next: PowerQuickRangeId | "custom") {
    if (next === "custom") {
      // 切到自定义时，用当前范围预填起止时间，方便微调。
      // Demo data cannot start before the synthetic epoch; live feeds may.
      const end = Math.min(activeWindow.endMs, now);
      const window = customRangePrefill(activeWindow.startMs, end, live);
      setStartDraft(toLocalDateTimeInput(window.startMs));
      setEndDraft(toLocalDateTimeInput(window.endMs));
      setMode({ kind: "custom", window });
      return;
    }
    setRangeErrors([]);
    setMode({ kind: "quick", id: next });
  }

  function applyCustom(event: React.FormEvent) {
    event.preventDefault();
    const result = validateCustomRange(startDraft, endDraft, now);
    if (!result.ok) {
      setRangeErrors(result.errors);
      return;
    }
    setRangeErrors([]);
    setMode({ kind: "custom", window: result.window });
  }

  function showTip(index: number, target: HTMLElement) {
    const rect = target.getBoundingClientRect();
    setTipPos({
      left: Math.max(8, Math.min(rect.left + rect.width / 2 - 100, window.innerWidth - 216)),
      top: Math.max(8, Math.min(rect.top - 8, window.innerHeight - 232)),
    });
    setTipIndex(index);
  }

  const n = buckets.length;
  const chartWidth = Math.max(680, PLOT_LEFT + n * COL_W);
  const yMax = niceMaxW(
    Math.max(
      0,
      ...buckets.flatMap((b) =>
        [
          b.cpu,
          b.gpu,
          b.machine,
          b.peak.cpu,
          b.peak.gpu,
          b.peak.machine,
        ].filter((v): v is number => v != null),
      ),
    ),
  );
  const x = (i: number) => PLOT_LEFT + i * COL_W + COL_W / 2;
  const y = (w: number) => PLOT_TOP + PLOT_H - (PLOT_H * w) / yMax;

  function pathFor(key: "cpu" | "gpu" | "machine"): string {
    let d = "";
    let open = false;
    buckets.forEach((b, i) => {
      const v = b[key];
      if (v == null) {
        open = false;
        return;
      }
      d += `${open ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
      open = true;
    });
    return d.trim();
  }

  const tickEvery = Math.max(1, Math.ceil((n - 1) / 5) || 1);
  const visibleTicks = buckets
    .map((b, i) => ({ b, i }))
    .filter(({ i }) => i % tickEvery === 0 || i === n - 1);
  const srStride = Math.max(1, Math.ceil(n / 120));
  const srRows = buckets
    .filter((_, i) => i % srStride === 0)
    .map((b) => [
      `${formatClock(b.startMs, bucketHasSeconds)} → ${formatClock(b.endMs, bucketHasSeconds)}`,
      formatWatts(b.cpu),
      formatWatts(b.gpu),
      formatWatts(b.machine),
    ]);

  const bucketLabel = (b: PowerBucket) =>
    `${formatClock(b.startMs, bucketHasSeconds)} → ${formatClock(
      b.endMs,
      bucketHasSeconds,
    )} · CPU 均值 ${formatWatts(b.cpu)} 峰值 ${formatWatts(b.peak.cpu)} · GPU 均值 ${formatWatts(
      b.gpu,
    )} 峰值 ${formatWatts(b.peak.gpu)} · 整机 均值 ${formatWatts(b.machine)} 峰值 ${formatWatts(
      b.peak.machine,
    )} · ${b.count} 个采样`;

  const rangeSub =
    mode.kind === "quick" ? activeWindow.label : "自定义范围";

  return (
    <main className="overview power-page" data-testid="power-page">
      <header className="page-heading">
        <div className="page-heading-copy">
          <div className="heading-title-row">
            <h1 tabIndex={-1}>硬件用电</h1>
            <span className="page-range">
              {formatWindowRange(activeWindow)} · {rangeSub}
            </span>
          </div>
          <p>
            查看 CPU、GPU 与整机的当前功率，以及所选时间段的用电量和电费。
          </p>
          <p className="power-heading-summary" data-testid="power-summary">
            <span className="power-heading-figure">
              <span className="power-heading-figure-label">{rangeSub}用电量</span>
              <span className="power-heading-figure-value">
                {formatKwh(integrals.machine)}
                <span className="power-heading-figure-unit"> kWh</span>
              </span>
            </span>
            <span className="power-heading-figure">
              <span className="power-heading-figure-label">
                {live ? "电费" : "演示电费"}
              </span>
              <span className="power-heading-figure-value">
                {formatCny(cost(integrals.machine), integrals.machine.complete)}
              </span>
            </span>
            <span className="power-heading-figure-note">
              电价{" "}
              {price.error ? "—" : formatPricePerKwh(price.value)}{" "}
              元/kWh · {formatWindowRange(activeWindow)}
            </span>
          </p>
        </div>
      </header>

      {live ? (
        <Notice tone="success">
          已接入实时采集：Prometheus（{feed.url ?? "已配置地址"}）。以下功率、用电量与电费均来自该范围内真实采样；
          瞬时功率为最新采样。电费仍为本地估算，不计入成本总览的 Token 成本。
        </Notice>
      ) : feed.loading && !feed.samples && !feed.error ? (
        <Notice tone="info">正在连接功率采集源…</Notice>
      ) : (
        <Notice tone="warning">
          演示数据，尚未接入
          {feed.error ? `（采集源不可用：${feed.error}）` : ""}
          。以下数值由内置示例序列生成，缺失读数显示 —；演示电费不计入 Token 成本。
        </Notice>
      )}

      <section className="chart-card power-controls" aria-label="统计范围与电价">
        <div className="chart-head">
          <div>
            <h2 className="chart-title">统计范围与电价</h2>
            <p className="chart-desc">
              时间范围作用于趋势、用电量和电费；当前功率不受范围影响。采样粒度越细，
              用电量与峰值越接近真实用电曲线；曲线只按分桶均值展示。
            </p>
          </div>
        </div>
        <div className="power-controls-grid">
          <div className="filter-field">
            <span className="filter-label" id="power-range-label">
              时间范围
            </span>
            <SegmentedControl
              className="power-range-switch"
              label="时间范围"
              value={mode.kind === "quick" ? mode.id : "custom"}
              options={RANGE_OPTIONS}
              onChange={switchRange}
            />
          </div>
          {mode.kind === "custom" && <form className="power-custom-form" noValidate onSubmit={applyCustom}>
            <div className="power-field">
              <label htmlFor="power-start">开始时间</label>
              <input
                id="power-start"
                className="power-input"
                type="datetime-local"
                value={startDraft}
                onInput={(e) => setStartDraft(e.currentTarget.value)}
                onChange={(e) => setStartDraft(e.target.value)}
                aria-invalid={rangeErrors.some((err) => err.field === "start")}
                aria-describedby={rangeErrors.some((err) => err.field === "start") ? "power-start-error" : undefined}
              />
              {rangeErrors
                .filter((err) => err.field === "start")
                .map((err) => (
                  <p key={err.message} id="power-start-error" className="power-error" role="alert">
                    {err.message}
                  </p>
                ))}
            </div>
            <div className="power-field">
              <label htmlFor="power-end">结束时间</label>
              <input
                id="power-end"
                className="power-input"
                type="datetime-local"
                value={endDraft}
                onInput={(e) => setEndDraft(e.currentTarget.value)}
                onChange={(e) => setEndDraft(e.target.value)}
                aria-invalid={rangeErrors.some((err) => err.field === "end")}
                aria-describedby={rangeErrors.some((err) => err.field === "end") ? "power-end-error" : undefined}
              />
              {rangeErrors
                .filter((err) => err.field === "end")
                .map((err) => (
                  <p key={err.message} id="power-end-error" className="power-error" role="alert">
                    {err.message}
                  </p>
                ))}
            </div>
            <Button type="submit" className="power-apply">
              应用自定义范围
            </Button>
          </form>}
          <div className="power-field">
            <label htmlFor="power-price">电价（元/kWh）</label>
            <input
              id="power-price"
              className="power-input power-price-input"
              type="number"
              step="0.01"
              min="0.01"
              inputMode="decimal"
              value={priceRaw}
              onChange={(e) => setPriceRaw(e.target.value)}
              aria-invalid={price.error != null}
              aria-describedby={price.error ? "power-price-error" : undefined}
            />
            {price.error && (
              <p id="power-price-error" className="power-error" role="alert">
                {price.error}
              </p>
            )}
            <p className="power-note">
              默认电价 {formatPricePerKwh(DEFAULT_PRICE_CNY_PER_KWH)} 元/kWh，可调整；电费 = 范围用电量 × 电价，仅为演示。
            </p>
          </div>
        </div>
        <p className="power-window" role="status">
          当前统计范围：{formatWindowRange(activeWindow)}（共 {formatDuration(spanMs)} ·{" "}
          {rangeSub}；{mode.kind === "quick" ? "结束于当前时间" : "按自定义起止时间统计"}）。
          趋势、用电量与电费均来自这一范围：采集粒度每 {formatDuration(stepMs)}（共{" "}
          {samples.length} 个采样），曲线均值粒度每 {formatDuration(bucketMs)}。
        </p>
      </section>

      <section className="ledger power-ledger-now" aria-label="当前瞬时功率">
        {(["cpu", "gpu", "machine"] as const).map((key) => {
          const meta = POWER_SERIES.find((s) => s.key === key)!;
          const v = current[key];
          return (
            <div className="ledger-item" key={key}>
              <span className="ledger-label">
                {key === "machine" ? "整机" : meta.label} 当前功率
              </span>
              <span className="ledger-value">
                {v == null ? "—" : Math.round(v).toLocaleString("zh-CN")}
                <span className="ledger-unit"> W</span>
              </span>
              <span className="ledger-delta">
                {v == null
                  ? "当前时刻无采样"
                  : `瞬时功率 · 当前值 · 采样于 ${formatClock(current.t)}`}
                {key === "machine" && v != null ? " · 含其他硬件" : ""}
              </span>
            </div>
          );
        })}
      </section>

      <section
        className="ledger power-ledger-range power-energy-hero"
        aria-label="所选范围累计用电与电费"
        data-testid="power-energy-hero"
      >
        <div className="ledger-item power-hero-item">
          <span className="ledger-label">整机 用电量（{rangeSub}）</span>
          <span className="ledger-value power-hero-value">
            {formatKwh(integrals.machine)}
            <span className="ledger-unit"> kWh</span>
          </span>
          <span className="ledger-delta">
            {integrals.machine.kwh == null
              ? `${rangeSub}无整机采样`
              : `${formatWindowRange(activeWindow)} · 覆盖 ${formatCoverage(integrals.machine)}`}
          </span>
        </div>
        <div className="ledger-item power-hero-item">
          <span className="ledger-label">
            整机 {live ? "电费" : "演示电费"}（{rangeSub}）
          </span>
          <span className="ledger-value power-hero-value">
            {formatCny(cost(integrals.machine), integrals.machine.complete)}
          </span>
          <span className="ledger-delta">
            {price.error
              ? "电价无效，电费显示 —"
              : integrals.machine.kwh == null
                ? `${rangeSub}无整机采样`
                : `电价 ${formatPricePerKwh(price.value)} 元/kWh · ${live ? "本地估算，不计入 Token 成本" : "演示值，不计入 Token 成本"}`}
          </span>
        </div>
      </section>

      <section className="chart-card" data-testid="power-trend" aria-label="功率趋势">
        <div className="chart-head">
          <div>
            <h2 className="chart-title">功率趋势</h2>
            <p className="chart-desc">
              {formatWindowRange(activeWindow)} · {rangeSub} · 采集粒度每{" "}
              {formatDuration(stepMs)}（{samples.length} 个采样），曲线每{" "}
              {formatDuration(bucketMs)} 取一列均值（{n} 列），桶内峰值见悬停与明细表。
              颜色与线型区分设备，断开表示缺失。左右滚动查看完整范围，聚焦数据列查看数值，Esc 关闭。
            </p>
          </div>
          <div className="chart-legend power-legend" aria-hidden="true">
            {POWER_SERIES.map((s) => (
              <span key={s.key}>
                <svg width="22" height="8" viewBox="0 0 22 8" aria-hidden="true">
                  <line
                    x1="1"
                    y1="4"
                    x2="21"
                    y2="4"
                    stroke={s.color}
                    strokeWidth="2"
                    strokeDasharray={s.dash === "none" ? undefined : s.dash}
                  />
                </svg>
                {s.key === "machine" ? (live ? "整机（墙插估算）" : "整机（总量）") : s.label}
              </span>
            ))}
            <span>断开 = 缺失（—）</span>
            <span>曲线 = {formatDuration(bucketMs)} 均值 · 峰值见悬停</span>
          </div>
        </div>
        {n < 2 ? (
          <p className="empty-inline">该时间范围内没有采样。</p>
        ) : (
          <>
            <div className="power-chart-scroll">
              <div className="power-plot" style={{ width: chartWidth }}>
                <svg
                  className="power-svg"
                  width={chartWidth}
                  height={PLOT_TOP + PLOT_H + 4}
                  viewBox={`0 0 ${chartWidth} ${PLOT_TOP + PLOT_H + 4}`}
                  role="img"
                  aria-label={`${rangeSub}功率趋势图：CPU、GPU、整机三条折线`}
                >
                  {[1, 0.5, 0].map((ratio) => (
                    <line
                      key={ratio}
                      className="power-grid"
                      x1={PLOT_LEFT}
                      x2={chartWidth - 8}
                      y1={PLOT_TOP + PLOT_H * (1 - ratio)}
                      y2={PLOT_TOP + PLOT_H * (1 - ratio)}
                    />
                  ))}
                  {[1, 0.5, 0].map((ratio) => (
                    <text
                      key={`t-${ratio}`}
                      className="power-ylab"
                      x={PLOT_LEFT - 6}
                      y={PLOT_TOP + PLOT_H * (1 - ratio) + 3}
                      textAnchor="end"
                    >
                      {Math.round(yMax * ratio)}
                    </text>
                  ))}
                  {POWER_SERIES.map((s) => (
                    <path
                      key={s.key}
                      className="power-line"
                      d={pathFor(s.key)}
                      stroke={s.color}
                      strokeDasharray={s.dash === "none" ? undefined : s.dash}
                    />
                  ))}
                </svg>
                <div
                  className="power-cols"
                  style={{ left: PLOT_LEFT, width: chartWidth - PLOT_LEFT - 8 }}
                >
                  {buckets.map((b, i) => (
                    <button
                      key={b.t}
                      type="button"
                      className="power-col"
                      aria-label={bucketLabel(b)}
                      onMouseEnter={(e) => showTip(i, e.currentTarget)}
                      onMouseLeave={() => setTipIndex(null)}
                      onFocus={(e) => showTip(i, e.currentTarget)}
                      onBlur={() => setTipIndex(null)}
                      onClick={(e) => showTip(i, e.currentTarget)}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") setTipIndex(null);
                      }}
                    >
                      {tipIndex === i && (
                        <span className="chart-tooltip" style={tipPos}>
                          <b>
                            {formatClock(b.startMs, bucketHasSeconds)} →{" "}
                            {formatClock(b.endMs, bucketHasSeconds)}
                          </b>
                          <span>
                            CPU 均值 {formatWatts(b.cpu)} · 峰值 {formatWatts(b.peak.cpu)}
                          </span>
                          <span>
                            GPU 均值 {formatWatts(b.gpu)} · 峰值 {formatWatts(b.peak.gpu)}
                          </span>
                          <span>
                            整机 均值 {formatWatts(b.machine)} · 峰值{" "}
                            {formatWatts(b.peak.machine)}
                          </span>
                          <span className="sep">
                            {b.count} 个采样（每 {formatDuration(stepMs)}）·{" "}
                            {live ? "实时采集 · Prometheus" : "演示数据，尚未接入"}
                          </span>
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                <div className="power-ticks">
                  {visibleTicks.map(({ b, i }) => (
                    <span key={b.t} style={{ left: Math.min(chartWidth - 70, Math.max(70, x(i))) }}>
                      {formatClock(b.t)}
                    </span>
                  ))}
                </div>
              </div>
            </div>
            <div className="visually-hidden">{srTable(
              `功率趋势（${live ? "实时采集" : "演示数据"}，每 ${formatDuration(
                stepMs,
              )} 一采样，曲线按每 ${formatDuration(bucketMs)} 取均值${
                srStride > 1 ? `，表格每 ${srStride} 条取 1 条` : ""
              }）`,
              ["时间", "CPU 均值", "GPU 均值", "整机 均值"],
              srRows,
            )}</div>
          </>
        )}
      </section>

      <section className="chart-card" aria-label="区间统计明细">
        <div className="chart-head">
          <div>
            <h2 className="chart-title">区间统计明细（{rangeSub}）</h2>
            <p className="chart-desc">
              整机包含 CPU、GPU 和其他硬件，各行不可重复相加。
              覆盖不足时显示已知下限。表格可左右滚动查看用电量、电费和覆盖率。
              用电量、平均功率与峰值都取自每 {formatDuration(stepMs)} 的原始采样，
              不受曲线分桶影响。
            </p>
          </div>
        </div>
        <div className="power-table-scroll" tabIndex={0} role="region" aria-label="区间统计表，可左右滚动">
          <table className="mt power-mt">
            <thead>
              <tr>
                <th scope="col">设备</th>
                <th scope="col">瞬时功率（当前）</th>
                <th scope="col">区间用电量 kWh</th>
                <th scope="col">区间电费</th>
                <th scope="col">平均功率</th>
                <th scope="col">峰值功率</th>
                <th scope="col">数据覆盖</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">CPU（分项）</th>
                <td className="num">{formatWatts(current.cpu)}</td>
                <td className="num">{formatKwh(integrals.cpu)}</td>
                <td className="num">{formatCny(cost(integrals.cpu), integrals.cpu.complete)}</td>
                <td className="num">{formatWatts(integrals.cpu.avgW)}</td>
                <td className="num">{formatWatts(integrals.cpu.peakW)}</td>
                <td>{formatCoverage(integrals.cpu)}</td>
              </tr>
              <tr>
                <th scope="row">GPU（分项）</th>
                <td className="num">{formatWatts(current.gpu)}</td>
                <td className="num">{formatKwh(integrals.gpu)}</td>
                <td className="num">{formatCny(cost(integrals.gpu), integrals.gpu.complete)}</td>
                <td className="num">{formatWatts(integrals.gpu.avgW)}</td>
                <td className="num">{formatWatts(integrals.gpu.peakW)}</td>
                <td>{formatCoverage(integrals.gpu)}</td>
              </tr>
              <tr>
                <th scope="row">整机（总量，含其他硬件）</th>
                <td className="num">{formatWatts(current.machine)}</td>
                <td className="num">{formatKwh(integrals.machine)}</td>
                <td className="num">
                  {formatCny(cost(integrals.machine), integrals.machine.complete)}
                </td>
                <td className="num">{formatWatts(integrals.machine.avgW)}</td>
                <td className="num">{formatWatts(integrals.machine.peakW)}</td>
                <td>{formatCoverage(integrals.machine)}</td>
              </tr>
              <tr>
                <th scope="row">其他硬件（整机 − CPU − GPU，推算）</th>
                <td className="num">{formatWatts(otherNow)}</td>
                <td className="num">{formatKwh(integrals.other)}</td>
                <td className="num">{formatCny(cost(integrals.other), integrals.other.complete)}</td>
                <td className="num">{formatWatts(integrals.other.avgW)}</td>
                <td className="num">—</td>
                <td>{formatCoverage(integrals.other)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="power-note">
          “其他硬件”行是整机与两个分项在同一采样上的差值（内存、存储、风扇与电源转换损耗等），
          任一序列缺失时无法推算，显示 —；其余各行的用电量都来自各自序列的独立积分。
          {live ? "电费" : "演示电费"}不会加入成本总览的 Token 成本。
        </p>
      </section>
    </main>
  );
}

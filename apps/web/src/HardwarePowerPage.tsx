import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_POWER_RANGE_ID,
  DEFAULT_PRICE_CNY_PER_KWH,
  POWER_DEMO_ANCHOR_MS,
  POWER_RANGES,
  POWER_SERIES,
  bucketizeSamples,
  chartBucketMs,
  demoPowerAdapter,
  energyCostCny,
  selectPowerSamples,
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
  type PowerSeriesKey,
  type PowerWindow,
  type SeriesIntegral,
  type SeriesPoint,
} from "./hardware-power";
import { getPowerFeed, getRuntimeConfig } from "./api";
import { easeOutCubic, lerp, sameGapPattern, useAnimatedNumber } from "./motion";
import { Button, Notice, Panel, SegmentedControl, srTable } from "./ui";
import { LegacyBadge as Badge } from "@/components/ui/legacy-badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";


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

type SeriesKey = PowerSeriesKey;
const SERIES_KEYS: SeriesKey[] = POWER_SERIES.map((s) => s.key);
type YValues = Record<SeriesKey, (number | null)[]>;

function lineD(
  ys: (number | null)[],
  x: (i: number) => number,
  y: (w: number) => number,
): string {
  let d = "";
  let open = false;
  ys.forEach((v, i) => {
    if (v == null) {
      open = false;
      return;
    }
    d += `${open ? "L" : "M"}${x(i).toFixed(1)} ${y(v).toFixed(1)} `;
    open = true;
  });
  return d.trim();
}

/** Closed-to-baseline area under the machine curve; gaps stay gaps. */
function areaD(
  ys: (number | null)[],
  x: (i: number) => number,
  y: (w: number) => number,
  baseline: number,
): string {
  let d = "";
  let segment: number[] = [];
  const flush = () => {
    if (segment.length === 0) return;
    d += `M${x(segment[0]!).toFixed(1)} ${baseline.toFixed(1)} `;
    for (const i of segment) d += `L${x(i).toFixed(1)} ${y(ys[i]!).toFixed(1)} `;
    d += `L${x(segment[segment.length - 1]!).toFixed(1)} ${baseline.toFixed(1)} Z `;
    segment = [];
  };
  ys.forEach((v, i) => {
    if (v == null) flush();
    else segment.push(i);
  });
  flush();
  return d.trim();
}

/**
 * 当前瞬时功率拆分卡片：以 Crisp Sky 占比条与四格内嵌指标展示整机/GPU/CPU/其他功耗。
 */
function PowerSplitCard({
  current,
  otherNow,
}: {
  current: PowerSample;
  otherNow: number | null;
}) {
  const total = current.machine;
  const gpu = current.gpu;
  const cpu = current.cpu;
  const denom = total != null && total > 0 ? total : null;
  const shareText = (val: number | null) =>
    val != null && denom != null ? `${((100 * val) / denom).toFixed(1)}%` : "—";
  const parts = [
    { key: "gpu", label: "GPU 功耗", value: gpu, color: "var(--color-output)" },
    { key: "cpu", label: "CPU 功耗", value: cpu, color: "var(--color-input)" },
    { key: "other", label: "其他组件", value: otherNow, color: "var(--color-neutral)" },
  ];

  return (
    <Panel role="region" className="cs-card power-split-card" aria-label="当前瞬时功率">
      <div className="cs-card-header">
        <div>
          <h2 className="cs-card-title">当前瞬时功率拆分</h2>
          <p className="cs-card-subtitle">
            {total == null
              ? "当前时刻暂无整机功率采样"
              : `采样于 ${formatClock(current.t)} · 按核心组件拆分实时整机功耗占比`}
          </p>
        </div>
        <span className="cs-tag cs-tag--cyan mono">
          整机 {formatWatts(total)}
        </span>
      </div>
      <div className="power-split-bar" aria-hidden="true">
        {parts.map((part) => {
          const w =
            denom != null && part.value != null
              ? Math.max(0, (100 * part.value) / denom)
              : 0;
          return (
            <span
              key={part.key}
              style={{
                width: `${w}%`,
                background: part.color,
              }}
              title={`${part.label}: ${formatWatts(part.value)}`}
            />
          );
        })}
      </div>
      <div className="power-split-cards">
        <div className="power-split-item od-stat">
          <span className="perf-label">整机总功耗</span>
          <span className="perf-value od-nowrap">{formatWatts(total)}</span>
        </div>
        <div className="power-split-item od-stat">
          <span className="perf-label">GPU 功耗 ({shareText(gpu)})</span>
          <span className="perf-value od-nowrap" style={{ color: "var(--color-output-ink)" }}>
            {formatWatts(gpu)}
          </span>
        </div>
        <div className="power-split-item od-stat">
          <span className="perf-label">CPU 功耗 ({shareText(cpu)})</span>
          <span className="perf-value od-nowrap" style={{ color: "var(--accent-secondary-ink)" }}>
            {formatWatts(cpu)}
          </span>
        </div>
        <div className="power-split-item od-stat">
          <span className="perf-label">其他组件 ({shareText(otherNow)})</span>
          <span className="perf-value od-nowrap">{formatWatts(otherNow)}</span>
        </div>
      </div>
    </Panel>
  );
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
 * 相加。数据优先来自后端 /power → Prometheus 实时采集。采集不可达时
 * 只有引擎运行时开启 ENABLE_POWER_PREVIEW 才回退演示序列。
 */
export function HardwarePowerPage({
  now,
  refreshKey = 0,
  adapter = demoPowerAdapter,
  onTopMeta,
}: {
  now: number;
  refreshKey?: number;
  adapter?: PowerDataAdapter;
  onTopMeta?: (meta: { devicePill?: string; windowPill?: string; hostPill?: string; statusText?: string }) => void;
}) {
  const [mode, setMode] = useState<RangeMode>({
    kind: "quick",
    id: DEFAULT_POWER_RANGE_ID,
  });
  const [startDraft, setStartDraft] = useState("");
  const [endDraft, setEndDraft] = useState("");
  const [rangeErrors, setRangeErrors] = useState<
    { field: "start" | "end"; message: string }[]
  >([]);
  const [priceRaw, setPriceRaw] = useState(String(DEFAULT_PRICE_CNY_PER_KWH));
  const [tipIndex, setTipIndex] = useState<number | null>(null);
  const [tipPos, setTipPos] = useState({ left: 8, top: 8 });
  const chartScrollRef = useRef<HTMLDivElement>(null);

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

  const [powerPreview, setPowerPreview] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void getRuntimeConfig().then((config) => {
      if (!cancelled) setPowerPreview(config.powerPreview);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 后端 /power → Prometheus 实时采集。演示序列只在运行时 powerPreview 打开时使用。
  const [feed, setFeed] = useState<{
    loading: boolean;
    connected: boolean;
    url: string | null;
    samples: PowerSample[] | null;
    error: string | null;
  }>({ loading: true, connected: false, url: null, samples: null, error: null });
  const feedRequest = useRef(0);
  const lastRangeRefresh = useRef(refreshKey);
  useEffect(() => {
    const requestId = ++feedRequest.current;
    const refresh = lastRangeRefresh.current !== refreshKey;
    lastRangeRefresh.current = refreshKey;
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
    getPowerFeed(activeWindow.startMs, activeWindow.endMs, stepMs, controller.signal, refresh)
      .then((result) => {
        if (requestId !== feedRequest.current) return;
        setFeed({
          loading: false,
          connected: result.connected && result.samples.length >= 2,
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
  }, [activeWindow.startMs, activeWindow.endMs, stepMs, refreshKey]);

  // 瞬时功率单独拉一段以 now 为终点的短窗，与所选统计范围解耦。
  const [instantSample, setInstantSample] = useState<PowerSample | null>(null);
  const instantRequest = useRef(0);
  const lastInstantRefresh = useRef(refreshKey);
  useEffect(() => {
    const requestId = ++instantRequest.current;
    const refresh = lastInstantRefresh.current !== refreshKey;
    lastInstantRefresh.current = refreshKey;
    const controller = new AbortController();
    const startMs = now - 3 * INSTANT_STEP_MS;
    getPowerFeed(startMs, now, INSTANT_STEP_MS, controller.signal, refresh)
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
  }, [now, refreshKey]);

  const live = feed.connected && feed.samples != null;
  const usingDemo = !live && powerPreview;
  const samples = useMemo(() => {
    return selectPowerSamples({
      live,
      loading: feed.loading,
      knownCollector: feed.url != null,
      powerPreview,
      liveSamples: feed.samples,
      demoSamples: () => adapter.series(activeWindow.startMs, activeWindow.endMs, stepMs),
    });
  }, [
    live,
    feed.samples,
    feed.loading,
    feed.url,
    powerPreview,
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

  // Composition shares divide integrals measured on the SAME coverage:
  // independently covered components cannot be compared against a partially
  // covered machine total. Statistics above keep their own full integrals.
  const composition: Record<"cpu" | "gpu" | "machine" | "other", SeriesIntegral> =
    useMemo(() => {
      const common = samples.filter(
        (sample) => sample.cpu != null && sample.gpu != null && sample.machine != null,
      );
      const integrate = (points: SeriesPoint[]) =>
        integrateSeries(points, activeWindow.startMs, activeWindow.endMs);
      return {
        cpu: integrate(seriesPoints(common, "cpu")),
        gpu: integrate(seriesPoints(common, "gpu")),
        machine: integrate(seriesPoints(common, "machine")),
        other: integrate(otherPoints(common)),
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
    if (usingDemo) return adapter.sampleAt(now);
    if (!live) return { t: now, cpu: null, gpu: null, machine: null };
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

  const animatedKwh = useAnimatedNumber(integrals.machine.kwh);
  const animatedCost = useAnimatedNumber(cost(integrals.machine));

  function switchRange(next: PowerQuickRangeId | "custom") {
    if (next === "custom") {
      // 切到自定义时，用当前范围预填起止时间，方便微调。
      const end = Math.min(activeWindow.endMs, now);
      setStartDraft(toLocalDateTimeInput(Math.max(activeWindow.startMs, POWER_DEMO_ANCHOR_MS)));
      setEndDraft(toLocalDateTimeInput(end));
      setMode({ kind: "custom", window: { startMs: Math.max(activeWindow.startMs, POWER_DEMO_ANCHOR_MS), endMs: end, label: "自定义" } });
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
  const rangeKey =
    mode.kind === "quick"
      ? mode.id
      : `${mode.window.startMs}:${mode.window.endMs}`;
  // 宽曲线默认停在最新一端；只在切换窗口或列数变化时复位，避免 now 刷新抢走横向浏览。
  useLayoutEffect(() => {
    const el = chartScrollRef.current;
    if (!el || n < 2) return;
    const snapToLatest = () => {
      el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
    };
    snapToLatest();
    const frame = requestAnimationFrame(snapToLatest);
    return () => cancelAnimationFrame(frame);
  }, [rangeKey, n, chartWidth]);
  // 曲线只画分桶均值，纵轴也只按均值定标并留 8% 余量；桶内峰值仍由悬停与
  // 明细表给出，避免偶发尖峰把整条曲线压到图底。
  const yMax = niceMaxW(
    1.08 *
      Math.max(
        0,
        ...buckets.flatMap((b) =>
          [b.cpu, b.gpu, b.machine].filter((v): v is number => v != null),
        ),
      ),
  );
  const x = (i: number) => PLOT_LEFT + i * COL_W + COL_W / 2;
  const y = (w: number) => PLOT_TOP + PLOT_H - (PLOT_H * w) / yMax;
  const baseline = PLOT_TOP + PLOT_H;

  function pathFor(key: SeriesKey): string {
    return lineD(buckets.map((b) => b[key]), x, y);
  }

  // Range/refresh morph: interpolate the drawn watts between the previous and
  // next bucket grids so the curve flows instead of jumping. Missing readings
  // never interpolate — a changed gap pattern snaps, keeping "— honest".
  const lineRefs = useRef<Record<SeriesKey, SVGPathElement | null>>({
    cpu: null,
    gpu: null,
    machine: null,
  });
  const areaRef = useRef<SVGPathElement | null>(null);
  const drawnYsRef = useRef<YValues | null>(null);
  const morphFrame = useRef<number | null>(null);
  useLayoutEffect(() => {
    const target: YValues = {
      cpu: buckets.map((b) => b.cpu),
      gpu: buckets.map((b) => b.gpu),
      machine: buckets.map((b) => b.machine),
    };
    const write = (ys: YValues) => {
      for (const key of SERIES_KEYS) {
        lineRefs.current[key]?.setAttribute("d", lineD(ys[key], x, y));
      }
      areaRef.current?.setAttribute("d", areaD(ys.machine, x, y, baseline));
    };
    const previous = drawnYsRef.current;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const morphable =
      previous != null &&
      !reduced &&
      SERIES_KEYS.every((key) => sameGapPattern(previous[key], target[key]));
    if (!morphable) {
      drawnYsRef.current = target;
      write(target);
      return;
    }
    const from = previous;
    const start = performance.now();
    const duration = 300;
    const step = (time: number) => {
      const progress = Math.min(1, (time - start) / duration);
      const eased = easeOutCubic(progress);
      const ys = {} as YValues;
      for (const key of SERIES_KEYS) {
        ys[key] = target[key].map((v, i) =>
          v == null ? null : lerp(from[key][i]!, v, eased),
        );
      }
      drawnYsRef.current = ys;
      write(ys);
      if (progress < 1) morphFrame.current = requestAnimationFrame(step);
    };
    morphFrame.current = requestAnimationFrame(step);
    return () => {
      if (morphFrame.current != null) cancelAnimationFrame(morphFrame.current);
    };
    // x/y/baseline derive from yMax and chartWidth; buckets carry the window.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buckets, yMax, chartWidth]);

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

  // 整机用电量 = CPU + GPU + 其他硬件（共同覆盖区间上的差值），可直接拆成占比。
  const energyParts = [
    { key: "cpu", label: "CPU", integral: composition.cpu },
    { key: "gpu", label: "GPU", integral: composition.gpu },
    { key: "other", label: "其他硬件", integral: composition.other },
  ];
  const energySharePct = (kwh: number | null): number | null => {
    const total = composition.machine.kwh;
    if (kwh == null || total == null || total <= 0) return null;
    return (100 * kwh) / total;
  };
  const energyShare = (kwh: number | null) => {
    const pct = energySharePct(kwh);
    return pct == null ? "—" : `${pct.toFixed(1)}%`;
  };
  const loadScaleW = Math.max(current.machine ?? 0, integrals.machine.peakW ?? 0, 1);
  const loadNowPct =
    current.machine == null ? 0 : Math.min(100, (100 * current.machine) / loadScaleW);
  const loadPeakPct =
    integrals.machine.peakW == null
      ? 0
      : Math.min(100, (100 * integrals.machine.peakW) / loadScaleW);

  const hostLabel = useMemo(() => {
    if (!feed.url) return undefined;
    try {
      return new URL(feed.url).hostname;
    } catch {
      return undefined;
    }
  }, [feed.url]);
  const windowLabelText = formatWindowRange(activeWindow);
  const topStatusText = live
    ? "Prometheus 已接入 · 电费不计入 Token 成本"
    : feed.loading && !feed.samples && !feed.error
      ? "正在连接功率采集源"
      : usingDemo
        ? "演示数据 · 电费不计入 Token 成本"
        : "采集源不可达 · 电费不计入 Token 成本";

  useEffect(() => {
    onTopMeta?.({
      windowPill: windowLabelText,
      hostPill: hostLabel,
      statusText: topStatusText,
    });
  }, [onTopMeta, windowLabelText, hostLabel, topStatusText]);

  return (
    <main className="overview power-page" data-testid="power-page">
      {live ? null : feed.loading && !feed.samples && !feed.error ? (
        <Notice tone="info">正在连接功率采集源…</Notice>
      ) : usingDemo ? (
        <Notice tone="warning">
          {instantSample != null
            ? `历史范围为演示数据，尚未接入${feed.error ? `（${feed.error}）` : ""}，当前功率为实时采样；电费不计入 Token 成本。`
            : `演示数据，尚未接入${feed.error ? `（${feed.error}）` : ""} · 电费不计入 Token 成本。`}
        </Notice>
      ) : (
        <Notice tone="warning">
          采集源不可达{feed.error ? `（${feed.error}）` : ""} · 启动引擎前设置 ENABLE_POWER_PREVIEW=1 可预览示例。
        </Notice>
      )}

      <Panel role="region"
        className="cs-card power-energy-hero"
        aria-label="所选范围累计用电与电费"
        data-testid="power-energy-hero"
      >
        <p className="power-heading-summary" data-testid="power-summary">
          <span className="cs-tag cs-tag--cyan">
            {rangeSub}用电量 · 整机口径
          </span>
          <span className="power-heading-note">
            电价 {price.error ? "—" : formatPricePerKwh(price.value)} 元/kWh ·{" "}
            {formatWindowRange(activeWindow)}
          </span>
        </p>

        <div className="cs-kpi-grid power-kpi-grid">
          <div className="cs-kpi-card">
            <span className="cs-kpi-label ledger-label">整机用电量</span>
            <span className="cs-kpi-value ledger-value power-hero-value">
              {formatKwh({ kwh: animatedKwh, complete: integrals.machine.complete })}
              <span className="ledger-unit"> kWh</span>
            </span>
            <span className="cs-kpi-sub ledger-delta">
              {integrals.machine.kwh == null
                ? `${rangeSub}无整机采样`
                : `覆盖 ${formatCoverage(integrals.machine)} · 含其他硬件`}
            </span>
          </div>

          <div className="cs-kpi-card is-brand">
            <span className="cs-kpi-label ledger-label">
              {usingDemo ? "演示电费" : "估算电费"}
            </span>
            <span className="cs-kpi-value ledger-value power-hero-value power-hero-cost">
              {formatCny(animatedCost, integrals.machine.complete)}
            </span>
            <span className="cs-kpi-sub ledger-delta">
              {price.error
                ? "电价无效"
                : integrals.machine.kwh == null
                  ? `${rangeSub}无整机采样`
                  : `${formatPricePerKwh(price.value)} 元/kWh · 本地电价估算`}
            </span>
          </div>

          <div className="cs-kpi-card">
            <span className="cs-kpi-label">区间平均功耗</span>
            <span className="cs-kpi-value">{formatWatts(integrals.machine.avgW)}</span>
            <span className="cs-kpi-sub">
              {current.machine == null
                ? "当前时刻无瞬时采样"
                : `当前瞬时 ${formatWatts(current.machine)}`}
            </span>
          </div>

          <div className="cs-kpi-card">
            <span className="cs-kpi-label">区间峰值功耗</span>
            <span className="cs-kpi-value">{formatWatts(integrals.machine.peakW)}</span>
            <span className="cs-kpi-sub power-peak-sub">
              <span>
                {current.machine != null && integrals.machine.peakW != null
                  ? `当前 ${Math.round(loadNowPct)}%`
                  : `统计窗口 ${formatDuration(spanMs)}`}
              </span>
              {current.machine != null && integrals.machine.peakW != null && (
                <span
                  className="power-load-track"
                  aria-hidden="true"
                  title={`当前相对区间峰值 ${Math.round(loadNowPct)}% · 统计窗口 ${formatDuration(spanMs)}`}
                >
                  <i className="power-load-fill" style={{ width: `${loadNowPct}%` }} />
                  <i className="power-load-peak" style={{ left: `${loadPeakPct}%` }} />
                </span>
              )}
            </span>
          </div>
        </div>

        <div className="power-energy-breakdown">
          <div className="power-energy-breakdown-head">
            <span>用电构成</span>
            <span
              title={`构成占比按 CPU、GPU、整机同时有读数的区间计算（共同覆盖 ${formatDuration(composition.machine.coveredMs)}）。统计窗口 ${formatDuration(spanMs)}。`}
            >
              共同覆盖区间 · {formatDuration(composition.machine.coveredMs)}
            </span>
          </div>
          <div className="power-energy-bar" aria-hidden="true">
            {energyParts.map((part) => {
              const pct = energySharePct(part.integral.kwh);
              return (
                <span
                  key={part.key}
                  className={`power-energy-seg ${part.key}`}
                  style={{ flex: `${Math.max(pct ?? 0.1, 0.1)} 1 0%` }}
                >
                  {pct != null && pct >= 14
                    ? `${part.label} ${pct.toFixed(0)}%`
                    : ""}
                </span>
              );
            })}
          </div>
          <div className="power-energy-legend">
            {energyParts.map((part) => (
              <span key={part.key}>
                <i className={`power-energy-dot ${part.key}`} aria-hidden="true" />
                {part.label} <b>{formatKwh(part.integral)} kWh</b>
                <em>{energyShare(part.integral.kwh)}</em>
              </span>
            ))}
          </div>
        </div>
      </Panel>

      <div className="power-middle-split">
        <Panel role="region" className="cs-card power-controls" aria-label="统计范围与电价">
          <div className="power-controls-grid">
            <h2 className="cs-card-title">电价与采集参数</h2>
            <div className="rate-input-group">
              <Label htmlFor="power-price">电价（元/kWh）</Label>
              <div className="rate-input-wrap">
                <Input
                  id="power-price"
                  className="rate-input power-price-input"
                  type="number"
                  step="0.01"
                  min="0.01"
                  inputMode="decimal"
                  value={priceRaw}
                  onChange={(e) => setPriceRaw(e.target.value)}
                  aria-invalid={price.error != null}
                  aria-describedby={price.error ? "power-price-error" : undefined}
                />
                <span className="rate-unit" aria-hidden="true">元</span>
              </div>
              {price.error && (
                <p id="power-price-error" className="field-error power-error" role="alert">
                  {price.error}
                </p>
              )}
            </div>
            <p className="power-window" role="status">
              当前统计范围 {rangeSub}（{formatWindowRange(activeWindow)}）· 采集粒度每 {formatDuration(stepMs)}（{samples.length} 点）· 曲线均值粒度每 {formatDuration(bucketMs)} · 默认 {formatPricePerKwh(DEFAULT_PRICE_CNY_PER_KWH)} 元/kWh
            </p>
          </div>
        </Panel>

        <PowerSplitCard current={current} otherNow={otherNow} />
      </div>

      <Panel role="region" className="cs-card power-trend" data-testid="power-trend" aria-label="功率趋势">
        <div className="cs-card-header power-trend-head">
          <div>
            <div className="power-trend-title-row">
              <h2 className="cs-card-title">功率变化趋势</h2>
              <div className="chart-legend power-legend" aria-hidden="true">
                {POWER_SERIES.map((s) => (
                  <span key={s.key}>
                    <i className="power-legend-line" style={{ background: s.color }} />
                    {s.key === "machine" ? "整机功耗" : `${s.label} 功耗`}
                  </span>
                ))}
                <span>{formatDuration(bucketMs)} 均值</span>
              </div>
            </div>
            <p className="cs-card-subtitle">
              {formatWindowRange(activeWindow)} · {rangeSub} · 移动指针查看各时段均值与峰值 · 峰值见悬停
            </p>
          </div>
          <SegmentedControl
            className="power-range-switch power-trend-ranges"
            label="时间范围"
            value={mode.kind === "quick" ? mode.id : "custom"}
            options={RANGE_OPTIONS}
            onChange={switchRange}
          />
        </div>
        {mode.kind === "custom" && (
          <form className="power-custom-form" noValidate onSubmit={applyCustom}>
            <div className="power-field">
              <Label htmlFor="power-start">开始时间</Label>
              <Input
                id="power-start"
                className="power-input"
                type="datetime-local"
                value={startDraft}
                onInput={(e) => setStartDraft(e.currentTarget.value)}
                onChange={(e) => setStartDraft(e.target.value)}
                aria-invalid={rangeErrors.some((err) => err.field === "start")}
                aria-describedby={
                  rangeErrors.some((err) => err.field === "start")
                    ? "power-start-error"
                    : undefined
                }
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
              <Label htmlFor="power-end">结束时间</Label>
              <Input
                id="power-end"
                className="power-input"
                type="datetime-local"
                value={endDraft}
                onInput={(e) => setEndDraft(e.currentTarget.value)}
                onChange={(e) => setEndDraft(e.target.value)}
                aria-invalid={rangeErrors.some((err) => err.field === "end")}
                aria-describedby={
                  rangeErrors.some((err) => err.field === "end") ? "power-end-error" : undefined
                }
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
          </form>
        )}
        {n < 2 ? (
          <p className="empty-inline">该时间范围内没有采样。</p>
        ) : (
          <>
            <div className="power-chart-frame">
              <div className="power-y-axis" aria-hidden="true">
                {[1, 0.5, 0].map((ratio) => (
                  <span key={ratio}>{Math.round(yMax * ratio)}W</span>
                ))}
              </div>
              <div
                className="power-chart-scroll"
                ref={chartScrollRef}
                data-testid="power-chart-scroll"
              >
                <div className="power-plot" style={{ width: chartWidth }}>
                  <svg
                    className="power-svg"
                    width={chartWidth}
                    height={PLOT_TOP + PLOT_H + 4}
                    viewBox={`0 0 ${chartWidth} ${PLOT_TOP + PLOT_H + 4}`}
                    role="img"
                    aria-label={`${rangeSub}功率趋势图：CPU、GPU、整机三条折线`}
                  >
                    <defs>
                      <linearGradient
                        id="power-area-fill"
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop
                          offset="0%"
                          style={{ stopColor: "var(--accent-primary)" }}
                          stopOpacity="0.22"
                        />
                        <stop
                          offset="100%"
                          style={{ stopColor: "var(--accent-primary)" }}
                          stopOpacity="0.01"
                        />
                      </linearGradient>
                    </defs>
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
                  <path
                    ref={areaRef}
                    className="power-area"
                    d={areaD(buckets.map((b) => b.machine), x, y, baseline)}
                    fill="url(#power-area-fill)"
                    stroke="none"
                  />
                  {POWER_SERIES.map((s) => (
                    <path
                      key={s.key === "machine" ? `machine-${rangeKey}` : s.key}
                      ref={(el) => {
                        lineRefs.current[s.key] = el;
                      }}
                      className={
                        s.key === "machine"
                          ? "power-line power-line-main"
                          : "power-line"
                      }
                      d={pathFor(s.key)}
                      pathLength={s.key === "machine" ? 1 : undefined}
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
                            {live ? "实时采集 · Prometheus" : usingDemo ? "演示数据，尚未接入" : "采集源不可达"}
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
            </div>
            <div className="visually-hidden">{srTable(
              `功率趋势（${live ? "实时采集" : usingDemo ? "演示数据" : "无采样"}，每 ${formatDuration(
                stepMs,
              )} 一采样，曲线按每 ${formatDuration(bucketMs)} 取均值${
                srStride > 1 ? `，表格每 ${srStride} 条取 1 条` : ""
              }）`,
              ["时间", "CPU 均值", "GPU 均值", "整机 均值"],
              srRows,
            )}</div>
          </>
        )}
      </Panel>

      <Panel role="region" className="chart-card" aria-label="区间统计明细">
        <div className="chart-head">
          <div>
            <h2 className="chart-title">区间统计明细（{rangeSub}）</h2>
          </div>
        </div>
        <div className="power-table-scroll" tabIndex={0} role="region" aria-label="区间统计表，可左右滚动">
          <table className="mt power-mt">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">设备</TableHead>
                <TableHead scope="col" className="num">当前功率</TableHead>
                <TableHead scope="col" className="num">用电量 (kWh)</TableHead>
                <TableHead scope="col" className="num">电费</TableHead>
                <TableHead scope="col" className="num">平均功率</TableHead>
                <TableHead scope="col" className="num">峰值功率</TableHead>
                <TableHead scope="col" className="num">覆盖</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableHead scope="row">
                  <span className="power-device-name">
                    <i className="power-device-dot is-cpu" aria-hidden="true" />
                    CPU
                  </span>
                </TableHead>
                <TableCell className="num">{formatWatts(current.cpu)}</TableCell>
                <TableCell className="num">{formatKwh(integrals.cpu)}</TableCell>
                <TableCell className="num">{formatCny(cost(integrals.cpu), integrals.cpu.complete)}</TableCell>
                <TableCell className="num">{formatWatts(integrals.cpu.avgW)}</TableCell>
                <TableCell className="num">{formatWatts(integrals.cpu.peakW)}</TableCell>
                <TableCell className="num power-cov-cell">{formatCoverage(integrals.cpu)}</TableCell>
              </TableRow>
              <TableRow>
                <TableHead scope="row">
                  <span className="power-device-name">
                    <i className="power-device-dot is-gpu" aria-hidden="true" />
                    GPU
                  </span>
                </TableHead>
                <TableCell className="num">{formatWatts(current.gpu)}</TableCell>
                <TableCell className="num">{formatKwh(integrals.gpu)}</TableCell>
                <TableCell className="num">{formatCny(cost(integrals.gpu), integrals.gpu.complete)}</TableCell>
                <TableCell className="num">{formatWatts(integrals.gpu.avgW)}</TableCell>
                <TableCell className="num">{formatWatts(integrals.gpu.peakW)}</TableCell>
                <TableCell className="num power-cov-cell">{formatCoverage(integrals.gpu)}</TableCell>
              </TableRow>
              <TableRow className="is-machine-row">
                <TableHead scope="row">
                  <span className="power-device-name">
                    <i className="power-device-dot is-machine" aria-hidden="true" />
                    整机（总量）
                  </span>
                </TableHead>
                <TableCell className="num">{formatWatts(current.machine)}</TableCell>
                <TableCell className="num">{formatKwh(integrals.machine)}</TableCell>
                <TableCell className="num power-cost-cell">
                  {formatCny(cost(integrals.machine), integrals.machine.complete)}
                </TableCell>
                <TableCell className="num">{formatWatts(integrals.machine.avgW)}</TableCell>
                <TableCell className="num">{formatWatts(integrals.machine.peakW)}</TableCell>
                <TableCell className="num power-cov-cell">{formatCoverage(integrals.machine)}</TableCell>
              </TableRow>
              <TableRow>
                <TableHead scope="row">
                  <span className="power-device-name">
                    <i className="power-device-dot is-other" aria-hidden="true" />
                    其他硬件（推算）
                  </span>
                </TableHead>
                <TableCell className="num">{formatWatts(otherNow)}</TableCell>
                <TableCell className="num">{formatKwh(integrals.other)}</TableCell>
                <TableCell className="num">{formatCny(cost(integrals.other), integrals.other.complete)}</TableCell>
                <TableCell className="num">{formatWatts(integrals.other.avgW)}</TableCell>
                <TableCell className="num">—</TableCell>
                <TableCell className="num power-cov-cell">{formatCoverage(integrals.other)}</TableCell>
              </TableRow>
            </TableBody>
          </table>
        </div>
        <details className="performance-footnote">
          <summary>口径说明 · 整机含 CPU、GPU 及其他硬件，各行独立积分</summary>
          <p className="performance-note">
            用电量、平均功率与峰值均按每 {formatDuration(stepMs)} 原始采样独立积分，覆盖不足时显示已知下限；
            “其他硬件”为整机减去 CPU 与 GPU 的同点差值（内存、存储、风扇与电源损耗等），任一序列缺失时显示 —。
            {usingDemo ? "演示电费" : "电费"}不计入成本总览的 Token 成本。
          </p>
        </details>
      </Panel>
    </main>
  );
}

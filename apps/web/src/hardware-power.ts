/**
 * 硬件用电 · 演示数据模块与统计纯函数。
 *
 * 页面优先展示后端 /power → Prometheus（192.168.1.102）的实时采集；采集
 * 不可达时回退到本模块的演示序列。所有曲线都是时间戳的确定性函数
 * （固定锚点、无随机数），同一时刻重复渲染得到完全相同的数值。
 *
 * 语义约束：整机（machine）是含其他硬件的总表读数，CPU / GPU 是其中分项；
 * 三条序列各自独立积分，任何统计都不把三者相加。
 */

export type PowerSeriesKey = "cpu" | "gpu" | "machine";

export type PowerSample = {
  t: number;
  cpu: number | null;
  gpu: number | null;
  machine: number | null;
};

export type PowerDataAdapter = {
  id: string;
  /** 演示数据始终标注 connected: false，页面据此显示“尚未接入”。 */
  connected: boolean;
  sampleAt(tMs: number): PowerSample;
  series(startMs: number, endMs: number, stepMs: number): PowerSample[];
};

/** 演示序列的固定纪元：此时刻之前没有任何采样（返回 null / —）。 */
export const POWER_DEMO_ANCHOR_MS = Date.UTC(2025, 0, 1);
export const DEMO_PRICE_CNY_PER_KWH = 0.55;

export const POWER_SERIES: {
  key: PowerSeriesKey;
  label: string;
  color: string;
  /** 颜色之外再用线型区分三条序列。 */
  dash: string;
}[] = [
  { key: "cpu", label: "CPU", color: "var(--chart-blue)", dash: "none" },
  { key: "gpu", label: "GPU", color: "var(--chart-violet)", dash: "6 4" },
  {
    key: "machine",
    label: "整机",
    color: "var(--chart-cyan)",
    dash: "14 4 2 4",
  },
];

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const TAU = Math.PI * 2;

/** 小整数散列：确定性“伪随机”，跨机器跨渲染结果一致。 */
function hash(n: number): number {
  let x = (n ^ 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 15), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return x >>> 0;
}

function unit(n: number): number {
  return hash(n) / 0xffffffff;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * 确定性功率采样：输入为绝对毫秒时间戳，输出唯一。
 * - CPU：常驻 8–20 W 待机，工作时段爬升，长任务日负载更高；
 * - GPU：训练/推理窗口高负载，其余时间低负载；
 * - 整机 = CPU 与 GPU 各自 ≈1.02 倍 + 其他硬件（内存、存储、风扇、
 *   电源转换损耗）40–70 W，因此始终高于 CPU + GPU 之和；
 * - 缺失窗口：GPU 每天 02:30–03:10（UTC）无采样；整机表每周三
 *   01:00–03:00（UTC）离线。缺失返回 null，绝不返回 0。
 */
export function demoSampleAt(tMs: number): PowerSample {
  if (tMs < POWER_DEMO_ANCHOR_MS) {
    return { t: tMs, cpu: null, gpu: null, machine: null };
  }
  const ms = tMs - POWER_DEMO_ANCHOR_MS;
  const dayIndex = Math.floor(ms / DAY);
  const minuteOfDay = Math.floor((ms % DAY) / MINUTE);
  const weekday = new Date(tMs).getUTCDay(); // 0=周日
  const workday = weekday >= 1 && weekday <= 5;

  // 工作强度：工作日两个工作块，平滑爬坡；每日整体强度由散列决定。
  const block = (start: number, end: number) =>
    minuteOfDay >= start && minuteOfDay < end ? 1 : 0;
  const ramp = (start: number, end: number) => {
    if (minuteOfDay < start - 30 || minuteOfDay >= end + 30) return 0;
    if (minuteOfDay < start) return (minuteOfDay - (start - 30)) / 30;
    if (minuteOfDay >= end) return (end + 30 - minuteOfDay) / 30;
    return 1;
  };
  const morning = ramp(9 * 60, 12 * 60);
  const afternoon = ramp(13 * 60 + 30, 18 * 60 + 30);
  const dayIntensity = workday ? 0.62 + 0.38 * unit(dayIndex) : 0.12;
  const burst =
    workday && unit(dayIndex * 1440 + Math.floor(minuteOfDay / 15)) > 0.88
      ? 1
      : 0; // 每 15 分钟一档的确定性突发
  const w = clamp(dayIntensity * Math.max(morning, afternoon) + 0.18 * burst, 0, 1);

  const cpuWave = 11 + 5 * Math.sin((TAU * ms) / (6 * HOUR)) + 2.5 * Math.sin((TAU * ms) / HOUR);
  const cpu = round1(clamp(cpuWave + w * (88 + 34 * Math.sin((TAU * ms) / (2.5 * HOUR) + dayIndex)), 5, 168));

  // GPU：周三/周六长训练窗口，其余工作时段轻推理。
  const trainingDay = weekday === 3 || weekday === 6;
  const training = trainingDay && block(6 * 60, 10 * 60) ? 1 : 0;
  const gpuWave = 5 + 2 * Math.sin((TAU * ms) / (4 * HOUR));
  const gpu = round1(
    clamp(
      gpuWave + training * (196 + 44 * Math.sin((TAU * ms) / (1.7 * HOUR))) + w * 42,
      3,
      320,
    ),
  );

  const other = round1(46 + 12 * Math.sin((TAU * ms) / (9 * HOUR)) + 6 * Math.sin((TAU * ms) / (40 * MINUTE)));
  const machine = round1(cpu * 1.02 + gpu * 1.03 + other);

  const gpuMissing = minuteOfDay >= 150 && minuteOfDay < 190;
  const machineMissing = weekday === 3 && minuteOfDay >= 60 && minuteOfDay < 180;

  return {
    t: tMs,
    cpu,
    gpu: gpuMissing ? null : gpu,
    machine: machineMissing ? null : machine,
  };
}

export const demoPowerAdapter: PowerDataAdapter = {
  id: "demo",
  connected: false,
  sampleAt: demoSampleAt,
  series(startMs, endMs, stepMs) {
    if (![startMs, endMs, stepMs].every(Number.isFinite) || !(stepMs > 0) || endMs < startMs) return [];
    const first = Math.ceil(startMs / stepMs) * stepMs;
    const out: PowerSample[] = [demoSampleAt(startMs)];
    for (let t = first; t < endMs; t += stepMs) {
      if (t > startMs) out.push(demoSampleAt(t));
    }
    if (endMs > startMs) out.push(demoSampleAt(endMs));
    return out;
  },
};

/* ------------------------------------------------------------------ */
/* 时间范围与趋势分辨率                                                */
/* ------------------------------------------------------------------ */

export const POWER_RANGES = [
  { id: "1h", label: "近1小时", ms: HOUR },
  { id: "24h", label: "近24小时", ms: 24 * HOUR },
  { id: "7d", label: "近7天", ms: 7 * DAY },
] as const;

export type PowerQuickRangeId = (typeof POWER_RANGES)[number]["id"];

export type PowerWindow = { startMs: number; endMs: number; label: string };

export function resolveQuickWindow(
  id: PowerQuickRangeId,
  nowMs: number,
): PowerWindow {
  const range = POWER_RANGES.find((item) => item.id === id)!;
  return {
    startMs: nowMs - range.ms,
    endMs: nowMs,
    label: range.label,
  };
}

/**
 * 趋势/积分共用同一采样网格，保证“看到的曲线”就是“被积分的曲线”。
 * 跨度越大步长越粗，最长 7 天量级内保持可读的点数。
 */
export function trendStepMs(spanMs: number): number {
  if (spanMs <= 2 * HOUR) return 2 * MINUTE;
  if (spanMs <= 26 * HOUR) return 15 * MINUTE;
  if (spanMs <= 9 * DAY) return HOUR;
  return 2 * HOUR;
}

export type CustomRangeResult =
  | { ok: true; window: PowerWindow }
  | { ok: false; errors: { field: "start" | "end"; message: string }[] };

/** datetime-local 字符串（本地时间）→ 毫秒；非法输入返回 null。 */
export function parseLocalDateTime(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const t = Date.parse(`${value}:00`);
  if (!Number.isFinite(t) || toLocalDateTimeInput(t) !== value) return null;
  return t;
}

export function toLocalDateTimeInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function validateCustomRange(
  startRaw: string,
  endRaw: string,
  nowMs: number,
): CustomRangeResult {
  const errors: { field: "start" | "end"; message: string }[] = [];
  const start = parseLocalDateTime(startRaw);
  const end = parseLocalDateTime(endRaw);
  if (start == null) errors.push({ field: "start", message: "请输入有效的开始时间。" });
  if (end == null) errors.push({ field: "end", message: "请输入有效的结束时间。" });
  if (start != null && end != null) {
    if (end <= start)
      errors.push({ field: "end", message: "结束时间必须晚于开始时间。" });
    if (end > nowMs)
      errors.push({ field: "end", message: "结束时间不能超过当前时间。" });
    if (end - start > 31 * DAY)
      errors.push({ field: "end", message: "单次最多查看 31 天，请缩小时间范围。" });
  }
  if (errors.length > 0 || start == null || end == null)
    return { ok: false, errors };
  return {
    ok: true,
    window: { startMs: start, endMs: end, label: "自定义" },
  };
}

/* ------------------------------------------------------------------ */
/* 能耗积分与电费                                                      */
/* ------------------------------------------------------------------ */

export type SeriesPoint = { t: number; v: number | null };

export type SeriesIntegral = {
  /** 梯形积分得到的 kWh；无任何有效相邻采样时为 null（显示 —）。 */
  kwh: number | null;
  /** 有采样覆盖的时间长度（相邻两采样都有效才计入）。 */
  coveredMs: number;
  windowMs: number;
  complete: boolean;
  avgW: number | null;
  peakW: number | null;
};

/**
 * 对同一选定范围内的采样序列做梯形积分。缺失（null）打断积分段，
 * 覆盖不足时 complete=false，页面按“≥ 下限”展示，绝不补零。
 */
export function integrateSeries(
  points: SeriesPoint[],
  startMs: number,
  endMs: number,
): SeriesIntegral {
  const windowMs = Math.max(0, endMs - startMs);
  let wh = 0;
  let coveredMs = 0;
  let peak: number | null = null;
  let a = points[0];
  for (let i = 1; i < points.length; i += 1) {
    const b = points[i];
    if (!a || !Number.isFinite(b.t) || b.t <= a.t) continue;
    const dt = b.t - a.t;
    const left = Math.max(startMs, a.t);
    const right = Math.min(endMs, b.t);
    if (a.v != null && b.v != null && Number.isFinite(a.v) && Number.isFinite(b.v) &&
        a.v >= 0 && b.v >= 0 && right > left) {
      const leftW = a.v + (b.v - a.v) * ((left - a.t) / dt);
      const rightW = a.v + (b.v - a.v) * ((right - a.t) / dt);
      wh += ((leftW + rightW) / 2) * ((right - left) / HOUR);
      coveredMs += right - left;
      peak = Math.max(peak ?? 0, leftW, rightW);
    }
    a = b;
  }
  const kwh = coveredMs > 0 ? wh / 1000 : null;
  const complete = windowMs > 0 && coveredMs >= windowMs - Math.max(1, windowMs * 1e-9);
  const avgW =
    kwh != null && coveredMs > 0 ? (kwh * 1000) / (coveredMs / HOUR) : null;
  return { kwh, coveredMs, windowMs, complete, avgW, peakW: peak };
}

export function energyCostCny(
  kwh: number | null,
  pricePerKwh: number,
): number | null {
  if (kwh == null || !(pricePerKwh > 0)) return null;
  return kwh * pricePerKwh;
}

/* ------------------------------------------------------------------ */
/* 展示格式化                                                          */
/* ------------------------------------------------------------------ */

export function formatWatts(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${Math.round(v).toLocaleString("zh-CN")} W`;
}

export function formatKwh(
  integral: Pick<SeriesIntegral, "kwh" | "complete">,
): string {
  const { kwh, complete } = integral;
  if (kwh == null) return "—";
  const text = kwh >= 100 ? kwh.toFixed(1) : kwh.toFixed(3);
  return complete ? text : `≥ ${text}`;
}

export function formatCny(v: number | null, complete = true): string {
  if (v == null) return "—";
  const text =
    v >= 1000
      ? v.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : v.toFixed(2);
  return complete ? `¥${text}` : `≥ ¥${text}`;
}

export function formatCoverage(integral: SeriesIntegral): string {
  if (integral.kwh == null) return "无采样";
  if (integral.complete) return "100%";
  const missingMin = Math.round((integral.windowMs - integral.coveredMs) / MINUTE);
  const pct = integral.windowMs > 0
    ? Math.round((100 * integral.coveredMs) / integral.windowMs)
    : 0;
  return `${pct}% · 缺失约 ${missingMin} 分钟`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function formatWindowRange(w: PowerWindow): string {
  return `${formatClock(w.startMs)} → ${formatClock(w.endMs)}`;
}

export function formatDuration(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MINUTE))} 分钟`;
  if (ms < 48 * HOUR) return `${(ms / HOUR).toFixed(ms < 10 * HOUR ? 1 : 0)} 小时`;
  return `${(ms / DAY).toFixed(1)} 天`;
}

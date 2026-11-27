import { useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { formatPercent } from "./format";
import {
  distributionSummary,
  percentileBucket,
  type HistogramData,
} from "./perf-buckets";
import { Panel, srTable } from "./ui";

/**
 * A fixed-bucket histogram. Bars are drawn as blocks, not lines, so a bucket with
 * one sample is still a visible, readable block. Axis ticks sit on column edges
 * (upper bound on the right; open `>` bucket on the left); counts/% appear on
 * hover (pointer) or tap (touch). Dashed marks locate p50/p95 on the same fixed
 * scale, and the cumulative view answers "what share is at or below X" directly.
 *
 * 28 个桶在窄屏里每根只有十几 px，达不到 WCAG 2.2 的 24px 目标尺寸；
 * 因此柱体本身不是焦点目标：整张图是一个可聚焦的 group，用方向键逐桶
 * 读数（与温度曲线同一套键盘模型），读屏由 srTable 与 live region 承担。
 */
export function Histogram({
  title,
  data,
  cumulative = false,
  noun = "轮",
}: {
  title: string;
  data: HistogramData;
  cumulative?: boolean;
  noun?: string;
}) {
  const max = Math.max(...data.counts, 1);
  // 桶多时卡片里挤不下每份轴标签：字号压小，窄屏再隔一个标。
  const dense = data.labels.length > 6;
  // 输出速度已到 28 个桶，比 TTFT 更密：再压一档间距，窄屏只留隔一个的标签。
  const veryDense = data.labels.length > 16;
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");

  const cumulativeCounts: number[] = [];
  let running = 0;
  for (const count of data.counts) {
    running += count;
    cumulativeCounts.push(running);
  }
  const p50 = percentileBucket(data, 50);
  const p95 = percentileBucket(data, 95);
  const percentileText =
    p50 != null && p95 != null
      ? `，p50 落在 ${data.labels[p50]}，p95 落在 ${data.labels[p95]}`
      : "";
  const headline =
    p50 != null && p95 != null
      ? `p50 ${data.labels[p50]} · p95 ${data.labels[p95]}`
      : null;

  const tipFor = (index: number) => {
    const label = data.labels[index] ?? "";
    const count = data.counts[index] ?? 0;
    const cum = cumulativeCounts[index] ?? 0;
    if (cumulative) {
      const cumShare = data.known > 0 ? (100 * cum) / data.known : 0;
      return `${label} · 累计 ${cum} ${noun}（${formatPercent(cumShare)}）`;
    }
    const share = data.known > 0 ? (100 * count) / data.known : 0;
    return `${label} · ${count} ${noun}${
      data.known > 0 ? `（${formatPercent(share)}）` : ""
    }`;
  };

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const count = data.labels.length;
    if (count === 0) return;
    if (event.key === "Escape") {
      setActiveIndex(null);
      return;
    }
    const current = activeIndex ?? count - 1;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = Math.max(0, current - 1);
    else if (event.key === "ArrowRight") next = Math.min(count - 1, current + 1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = count - 1;
    else return;
    event.preventDefault();
    setActiveIndex(next);
    setAnnouncement(tipFor(next));
  }

  return (
    <div
      className={`hist${dense ? " dense" : ""}${veryDense ? " very-dense" : ""}`}
      role="group"
      tabIndex={0}
      aria-label={`${title}分布${cumulative ? "（累积视图）" : ""}${percentileText}。用左右方向键查看各桶，Home 与 End 跳到两端，Escape 关闭读数。`}
      onKeyDown={handleKeyDown}
      onBlur={() => setActiveIndex(null)}
    >
      {headline && (
        <p className="hist-percentile" aria-hidden="true">{headline}</p>
      )}
      <div className="hist-bars">
        {data.labels.map((label, index) => {
          const count = data.counts[index] ?? 0;
          const cum = cumulativeCounts[index] ?? 0;
          const tip = tipFor(index);
          const showTip = activeIndex === index;
          const height = cumulative
            ? data.known > 0
              ? (100 * cum) / data.known
              : 0
            : (100 * count) / max;
          const mark =
            p50 != null && p95 != null && p50 === p95 && index === p50
              ? "p50·p95"
              : index === p50
                ? "p50"
                : index === p95
                  ? "p95"
                  : null;
          return (
            <div
              className={showTip ? "hb tip-on" : "hb"}
              key={label}
              title={tip}
              data-tip={tip}
              aria-hidden="true"
              style={{ "--i": Math.min(index, 18) } as CSSProperties}
              onPointerEnter={() => setActiveIndex(index)}
              onPointerLeave={() =>
                setActiveIndex((current) => (current === index ? null : current))
              }
              onClick={() =>
                setActiveIndex((current) => (current === index ? null : index))
              }
            >
              <div className="hb-bar">
                <i
                  className={count === max && max > 0 ? "is-peak" : undefined}
                  style={{ height: `${height}%` }}
                  aria-hidden="true"
                />
              </div>
              {mark && (
                <span
                  className={`pct-mark${mark === "p95" ? " p95" : ""}`}
                  aria-hidden="true"
                >
                  <b>{mark}</b>
                </span>
              )}
            </div>
          );
        })}
      </div>
      <div className="hist-axis" aria-hidden="true">
        {data.ticks.map((tick, index) => {
          const openEnd = index === data.ticks.length - 1 && tick.startsWith(">");
          return (
            <span
              key={`${tick}-${index}`}
              className={openEnd ? "hist-tick hist-tick-open-end" : "hist-tick"}
            >
              {tick}
            </span>
          );
        })}
      </div>
      {srTable(
        `${title}分布（${cumulative ? "累积视图" : "分布视图"}，共 ${data.known} 个有记录的${noun}）${percentileText}`,
        ["区间", cumulative ? "累计数量" : "数量", "占比"],
        data.labels.map((label, index) => {
          const share =
            data.known > 0
              ? (100 * (cumulative ? cumulativeCounts[index] ?? 0 : data.counts[index] ?? 0)) /
                data.known
              : 0;
          return [
            label,
            String(cumulative ? cumulativeCounts[index] ?? 0 : data.counts[index] ?? 0),
            formatPercent(share),
          ];
        }),
      )}
      <p className="visually-hidden" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}

export function HistogramPair({
  ttft,
  speed,
  noun = "轮",
}: {
  ttft: HistogramData;
  speed: HistogramData;
  /** 摘要里的样本单位：轮次计时是「轮」，任务计时是「次任务」。 */
  noun?: string;
}) {
  const [ttftCumulative, setTtftCumulative] = useState(false);
  const [speedCumulative, setSpeedCumulative] = useState(false);
  return (
    <div className="hist-grid">
      <Panel className="hist-card is-ttft">
        <div className="hist-head">
          <span className="h">首字延迟 TTFT</span>
          <button
            type="button"
            className="hist-mode"
            aria-pressed={ttftCumulative}
            title="在分布与累积（CDF）视图之间切换"
            onClick={() => setTtftCumulative((current) => !current)}
          >
            累积
          </button>
          <span className="c">{distributionSummary(ttft, noun)}</span>
        </div>
        <Histogram title="TTFT" data={ttft} cumulative={ttftCumulative} noun={noun} />
      </Panel>
      <Panel className="hist-card is-speed">
        <div className="hist-head">
          <span className="h">输出速度 tok/s</span>
          <button
            type="button"
            className="hist-mode"
            aria-pressed={speedCumulative}
            title="在分布与累积（CDF）视图之间切换"
            onClick={() => setSpeedCumulative((current) => !current)}
          >
            累积
          </button>
          <span className="c">{distributionSummary(speed, noun)}</span>
        </div>
        <Histogram title="输出速度" data={speed} cumulative={speedCumulative} noun={noun} />
      </Panel>
    </div>
  );
}

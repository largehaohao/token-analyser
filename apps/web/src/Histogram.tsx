import { useState } from "react";
import { formatPercent } from "./format";
import { distributionSummary, type HistogramData } from "./perf-buckets";

/**
 * A fixed-bucket histogram. Bars are drawn as blocks, not lines, so a bucket with
 * one sample is still a visible, readable block. Axis ticks sit on column edges
 * (upper bound on the right; open `>` bucket on the left); counts/% appear on
 * hover (pointer) or tap (touch).
 */
export function Histogram({
  title,
  data,
}: {
  title: string;
  data: HistogramData;
}) {
  const max = Math.max(...data.counts, 1);
  // 13 个桶时卡片里挤不下 13 份轴标签：字号压小，窄屏再隔一个标。
  const dense = data.labels.length > 6;
  const [activeTip, setActiveTip] = useState<string | null>(null);
  return (
    <div
      className={dense ? "hist dense" : "hist"}
      role="img"
      aria-label={`${title}分布`}
    >
      <div className="hist-bars">
        {data.labels.map((label, index) => {
          const count = data.counts[index] ?? 0;
          const share = data.known > 0 ? (100 * count) / data.known : 0;
          const tip = `${label} · ${count} 轮${
            data.known > 0 ? `（${formatPercent(share)}）` : ""
          }`;
          const showTip = activeTip === label;
          return (
            <button
              type="button"
              className={showTip ? "hb tip-on" : "hb"}
              key={label}
              title={tip}
              data-tip={tip}
              aria-label={tip}
              onPointerEnter={() => setActiveTip(label)}
              onPointerLeave={() => setActiveTip((current) => (current === label ? null : current))}
              onFocus={() => setActiveTip(label)}
              onBlur={() => setActiveTip((current) => (current === label ? null : current))}
              onClick={() =>
                setActiveTip((current) => (current === label ? null : label))
              }
            >
              <div className="hb-bar">
                <i
                  style={{ height: `${(100 * count) / max}%` }}
                  aria-hidden="true"
                />
              </div>
            </button>
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
    </div>
  );
}

export function HistogramPair({
  ttft,
  speed,
}: {
  ttft: HistogramData;
  speed: HistogramData;
}) {
  return (
    <div className="hist-grid">
      <div className="hist-card">
        <div className="hist-head">
          <span className="h">TTFT 分布</span>
          <span className="c">{distributionSummary(ttft)}</span>
        </div>
        <Histogram title="TTFT" data={ttft} />
      </div>
      <div className="hist-card">
        <div className="hist-head">
          <span className="h">输出速度分布</span>
          <span className="c">{distributionSummary(speed)}</span>
        </div>
        <Histogram title="输出速度" data={speed} />
      </div>
    </div>
  );
}

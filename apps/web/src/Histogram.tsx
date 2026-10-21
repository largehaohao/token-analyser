import { formatPercent } from "./format";
import { distributionSummary, type HistogramData } from "./perf-buckets";

/**
 * A fixed-bucket histogram. Bars are drawn as blocks, not lines, so a bucket with
 * one sample is still a visible, readable block.
 */
export function Histogram({
  title,
  data,
}: {
  title: string;
  data: HistogramData;
}) {
  const max = Math.max(...data.counts, 1);
  return (
    <div className="hist" role="img" aria-label={`${title}分布`}>
      {data.labels.map((label, index) => {
        const count = data.counts[index] ?? 0;
        const share = data.known > 0 ? (100 * count) / data.known : 0;
        return (
          <div
            className="hb"
            key={label}
            title={`${label} · ${count} 轮${
              data.known > 0 ? `（${formatPercent(share)}）` : ""
            }`}
          >
            <b>{count === 0 ? "" : formatPercent(share)}</b>
            <div className="hb-bar">
              <i
                style={{ height: `${(100 * count) / max}%` }}
                aria-hidden="true"
              />
            </div>
            <span>{label}</span>
          </div>
        );
      })}
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

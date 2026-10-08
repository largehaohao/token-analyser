import {
  SESSION_SOURCES,
  sourceEmptyCopy,
  type SessionSourceFilter,
} from "./session-source";
import { Button } from "./ui";

type Props = {
  source: SessionSourceFilter;
  counts: Record<SessionSourceFilter, number>;
  loaded: boolean;
  visibleCount: number;
  rangeLabel: string;
  onChange: (source: SessionSourceFilter) => void;
  onShowAllTime: () => void;
};

export function SourceSwitcher({
  source,
  counts,
  loaded,
  visibleCount,
  rangeLabel,
  onChange,
  onShowAllTime,
}: Props) {
  const label = SESSION_SOURCES.find((item) => item.id === source)!.label;
  return (
    <section className="source-toolbar" aria-label="会话来源筛选">
      <div className="source-toolbar-controls">
        <span className="source-toolbar-label">会话来源</span>
        <div
          className="segmented-control source-switch"
          role="group"
          aria-label="会话来源"
        >
          {SESSION_SOURCES.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-label={item.label}
              aria-pressed={source === item.id}
              className={source === item.id ? "active" : ""}
              title={`${item.label} · 全部时间已发现 ${loaded ? counts[item.id] : "…"} 个会话`}
              onClick={() => onChange(item.id)}
            >
              {item.label}
              <span className="source-count" aria-hidden="true">
                {loaded ? counts[item.id] : "—"}
              </span>
            </button>
          ))}
        </div>
        <span className="source-count-caption">数量按全部时间统计</span>
      </div>
      {loaded && source !== "all" && counts[source] === 0 && (
        <p className="source-range-notice" role="status">
          {sourceEmptyCopy(source)}
        </p>
      )}
      {loaded && counts[source] > 0 && visibleCount === 0 && (
        <div className="source-range-notice" role="status">
          <span>{label} 已发现 {counts[source]} 个会话，当前「{rangeLabel}」范围内没有记录。</span>
          <Button onClick={onShowAllTime}>查看全部时间</Button>
        </div>
      )}
    </section>
  );
}

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
    <section className="source-filter-bar" aria-label="会话来源筛选">
      <div className="source-rail" role="group" aria-label="代理来源筛选">
        {SESSION_SOURCES.map((item) => {
          const active = source === item.id;
          const count = loaded ? counts[item.id] : null;
          return (
            <button
              key={item.id}
              type="button"
              data-source={item.id}
              className={`source-chip${active ? " is-active" : ""}`}
              aria-pressed={active}
              title={`${item.label} · 全部时间已发现 ${count ?? "—"} 个会话`}
              onClick={() => onChange(item.id)}
            >
              {item.color && (
                <span
                  className="source-dot"
                  style={{ background: item.color }}
                  aria-hidden="true"
                />
              )}
              <span>{item.label}</span>
              {count != null && (
                <span className="source-chip-count">{count}</span>
              )}
            </button>
          );
        })}
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

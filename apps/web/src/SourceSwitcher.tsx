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
      <label className="filter-field source-filter-field">
        <span className="filter-label">来源</span>
        <select
          className="source-select"
          aria-label="会话来源"
          value={source}
          onChange={(event) =>
            onChange(event.target.value as SessionSourceFilter)
          }
        >
          {SESSION_SOURCES.map((item) => {
            const count = loaded ? counts[item.id] : "—";
            return (
              <option
                key={item.id}
                value={item.id}
                title={`${item.label} · 全部时间已发现 ${count} 个会话`}
              >
                {item.label} {count}
              </option>
            );
          })}
        </select>
        <span className="source-count-caption">全部时间的会话数</span>
      </label>
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

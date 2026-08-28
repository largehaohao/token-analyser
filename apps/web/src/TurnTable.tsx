import { useEffect, useMemo, useRef, useState } from "react";
import type { Turn } from "./api";
import { LABEL_CHIP, treeAppearance } from "./buckets";
import { formatCost, formatExactTokens } from "./format";
import { MixBar } from "./MixBar";
import { TurnSparkline } from "./TurnSparkline";
import {
  TURN_PAGE_SIZE,
  limitIncludingId,
  nextTurnLimit,
  visibleTurns,
} from "./turn-page";

type Props = {
  turns: Turn[];
  turnIds: Set<string>;
  highlightTurnId: string | null;
  resetKey: string;
};

function excerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

function formatTools(turn: Turn): string {
  if (turn.tools.length === 0) return "—";
  return turn.tools.map((t) => `${t.name}(${t.input})`).join(", ");
}

export function TurnTable({ turns, turnIds, highlightTurnId, resetKey }: Props) {
  const filtered = useMemo(
    () =>
      turns
        .filter((t) => turnIds.has(t.id))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    [turns, turnIds],
  );
  const [limit, setLimit] = useState(TURN_PAGE_SIZE);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());

  useEffect(() => {
    setLimit(TURN_PAGE_SIZE);
  }, [resetKey]);

  const shownLimit = limitIncludingId(filtered, limit, highlightTurnId);
  const visible = visibleTurns(filtered, shownLimit);

  useEffect(() => {
    if (!highlightTurnId) return;
    rowRefs.current.get(highlightTurnId)?.scrollIntoView({
      block: "nearest",
      behavior: "smooth",
    });
  }, [highlightTurnId, visible]);

  return (
    <div className="turn-table-wrap chart-card">
      <div className="turn-table-head">
        <h3>
          轮次 ({visible.length}
          {filtered.length !== visible.length ? ` / ${filtered.length}` : ""})
        </h3>
        <TurnSparkline turns={filtered} />
        {filtered.length > 0 && (
          <div className="mix-legend">
            <span className="swatch uncached" /> 未缓存
            <span className="swatch cached" /> 缓存
            <span className="swatch output" /> 输出
          </div>
        )}
      </div>
      {filtered.length === 0 ? (
        <p className="empty-turns">
          该节点没有轮次。点选「本会话」查看全部。
        </p>
      ) : (
        <>
          <div className="turn-table-scroll">
            <table className="turn-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>分类</th>
                  <th>工具</th>
                  <th>提示</th>
                  <th>构成</th>
                  <th>未缓存</th>
                  <th>缓存</th>
                  <th>输出</th>
                  <th>Credits</th>
                  <th>$</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((t) => {
                  const appearance = t.bucket
                    ? treeAppearance(t.bucket, "bucket", t.bucket)
                    : null;
                  return (
                    <tr
                      key={t.id}
                      ref={(el) => {
                        if (el) rowRefs.current.set(t.id, el);
                        else rowRefs.current.delete(t.id);
                      }}
                      className={highlightTurnId === t.id ? "highlighted" : ""}
                    >
                      <td
                        title={new Date(t.startedAt).toLocaleString("zh-CN", {
                          hour12: false,
                        })}
                      >
                        {new Date(t.startedAt).toLocaleTimeString("zh-CN", {
                          hour12: false,
                        })}
                      </td>
                      <td className="bucket-col">
                        {appearance ? (
                          <span className="bucket-chip">
                            <i
                              className="legend-dot"
                              style={{ background: appearance.color }}
                            />
                            {appearance.label}
                          </span>
                        ) : (
                          "—"
                        )}
                        {(t.labels ?? []).map((label) => (
                          <span key={label} className="label-chip">
                            {LABEL_CHIP[label] ?? label}
                          </span>
                        ))}
                      </td>
                      <td className="tools-col" title={formatTools(t)}>
                        {formatTools(t)}
                      </td>
                      <td className="prompt-col" title={t.prompt}>
                        {excerpt(t.prompt, 80)}
                      </td>
                      <td className="mix-col">
                        <MixBar
                          className="turn-mix"
                          label="未缓存 / 缓存 / 输出"
                          segments={[
                            {
                              key: "uncached",
                              label: "未缓存",
                              value: t.cost.uncached_input,
                              className: "uncached",
                            },
                            {
                              key: "cached",
                              label: "缓存",
                              value: t.cost.cached_input,
                              className: "cached",
                            },
                            {
                              key: "output",
                              label: "输出",
                              value: t.cost.output,
                              className: "output",
                            },
                          ]}
                        />
                      </td>
                      <td>{formatExactTokens(t.cost.uncached_input)}</td>
                      <td>{formatExactTokens(t.cost.cached_input)}</td>
                      <td>{formatExactTokens(t.cost.output)}</td>
                      <td>{formatCost(t.cost, "credits")}</td>
                      <td>{formatCost(t.cost, "usd")}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {visible.length < filtered.length && (
            <button
              type="button"
              className="load-more"
              onClick={() =>
                setLimit(nextTurnLimit(shownLimit, filtered.length))
              }
            >
              加载更多（还有 {filtered.length - visible.length} 轮）
            </button>
          )}
        </>
      )}
    </div>
  );
}

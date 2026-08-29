import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { Turn } from "./api";
import { LABEL_CHIP, treeAppearance } from "./buckets";
import { formatCost, formatCostTitle, formatExactTokens } from "./format";
import { MixBar } from "./MixBar";
import { TurnSparkline } from "./TurnSparkline";
import {
  TURN_PAGE_SIZE,
  highlightScrollBehavior,
  nextTurnLimit,
  visibleTurnWindow,
} from "./turn-page";

type Props = {
  turns: Turn[];
  turnIds: Set<string>;
  highlightTurnId: string | null;
  highlightNonce?: number;
  resetKey: string;
  scopeLabel?: string;
};

function excerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

function formatToolNames(turn: Turn): string {
  if (turn.tools.length === 0) return "—";
  return turn.tools.map((t) => t.name).join(", ");
}

function formatTools(turn: Turn): string {
  if (turn.tools.length === 0) return "—";
  return turn.tools.map((t) => `${t.name}(${t.input})`).join(", ");
}

export function TurnTable({
  turns,
  turnIds,
  highlightTurnId,
  highlightNonce = 0,
  resetKey,
  scopeLabel,
}: Props) {
  const filtered = useMemo(
    () =>
      turns
        .filter((t) => turnIds.has(t.id))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
    [turns, turnIds],
  );
  const [limit, setLimit] = useState(TURN_PAGE_SIZE);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLTableRowElement>());

  useEffect(() => {
    setLimit(TURN_PAGE_SIZE);
    setExpandedId(null);
  }, [resetKey]);

  const visible = visibleTurnWindow(filtered, limit, highlightTurnId);

  useEffect(() => {
    if (!highlightTurnId) return;
    setExpandedId(highlightTurnId);
    const reduceMotion =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    rowRefs.current.get(highlightTurnId)?.scrollIntoView({
      block: "nearest",
      behavior: highlightScrollBehavior(reduceMotion),
    });
  }, [highlightTurnId, highlightNonce]);

  return (
    <div className="turn-table-wrap chart-card">
      <div className="turn-table-head">
        <h3>
          轮次{scopeLabel ? ` · ${scopeLabel}` : ""} ({visible.length}
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
                  const expanded = expandedId === t.id;
                  return (
                    <Fragment key={t.id}>
                      <tr
                        ref={(el) => {
                          if (el) rowRefs.current.set(t.id, el);
                          else rowRefs.current.delete(t.id);
                        }}
                        className={[
                          highlightTurnId === t.id ? "highlighted" : "",
                          expanded ? "expanded" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        tabIndex={0}
                        aria-expanded={expanded}
                        onClick={() =>
                          setExpandedId((current) =>
                            current === t.id ? null : t.id,
                          )
                        }
                        onKeyDown={(event) => {
                          if (event.key !== "Enter" && event.key !== " ") return;
                          event.preventDefault();
                          setExpandedId((current) =>
                            current === t.id ? null : t.id,
                          );
                        }}
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
                          {t.fastMode && (
                            <span
                              className="badge fast turn-fast"
                              title="该轮使用 Fast；费用倍率按模型费率计算"
                            >
                              Fast
                            </span>
                          )}
                        </td>
                        <td className="tools-col" title={formatTools(t)}>
                          {formatToolNames(t)}
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
                        <td title={formatExactTokens(t.cost.uncached_input)}>
                          {formatExactTokens(t.cost.uncached_input)}
                        </td>
                        <td title={formatExactTokens(t.cost.cached_input)}>
                          {formatExactTokens(t.cost.cached_input)}
                        </td>
                        <td title={formatExactTokens(t.cost.output)}>
                          {formatExactTokens(t.cost.output)}
                        </td>
                        <td title={formatCostTitle(t.cost, "credits")}>
                          {formatCost(t.cost, "credits")}
                        </td>
                        <td title={formatCostTitle(t.cost, "usd")}>
                          {formatCost(t.cost, "usd")}
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="turn-detail">
                          <td colSpan={10}>
                            <div className="turn-detail-grid">
                              <div>
                                <h4>提示</h4>
                                <pre>{t.prompt || "（无用户提示）"}</pre>
                              </div>
                              <div>
                                <h4>工具</h4>
                                {t.tools.length === 0 ? (
                                  <p className="empty-turns">该轮没有工具调用。</p>
                                ) : (
                                  <ul className="turn-tool-list">
                                    {t.tools.map((tool, i) => (
                                      <li key={`${t.id}-tool-${i}`}>
                                        <strong>{tool.name}</strong>
                                        <pre>{tool.input || "（无输入）"}</pre>
                                        {tool.outputPreview && (
                                          <p className="turn-output">
                                            {tool.outputPreview}
                                            {tool.outputBytes > 0 && (
                                              <span>
                                                {" "}
                                                · {tool.outputBytes.toLocaleString("en-US")}{" "}
                                                B · {tool.outputSha256.slice(0, 8)}
                                              </span>
                                            )}
                                          </p>
                                        )}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
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
                setLimit(nextTurnLimit(limit, filtered.length))
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

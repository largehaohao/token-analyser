import type { Turn } from "./api";
import { formatCost } from "./format";
import { MixBar } from "./MixBar";
import { TurnSparkline } from "./TurnSparkline";

type Props = {
  turns: Turn[];
  turnIds: Set<string>;
};

function excerpt(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

function formatTools(turn: Turn): string {
  if (turn.tools.length === 0) return "—";
  return turn.tools.map((t) => `${t.name}(${t.input})`).join(", ");
}

export function TurnTable({ turns, turnIds }: Props) {
  const filtered = turns
    .filter((t) => turnIds.has(t.id))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  return (
    <div className="turn-table-wrap chart-card">
      <div className="turn-table-head">
        <h3>轮次 ({filtered.length})</h3>
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
        <p className="empty-turns">选择成本树节点查看轮次。</p>
      ) : (
        <table className="turn-table">
          <thead>
            <tr>
              <th>时间</th>
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
            {filtered.map((t) => (
              <tr key={t.id}>
                <td>{new Date(t.startedAt).toLocaleTimeString()}</td>
                <td className="tools-col">{formatTools(t)}</td>
                <td className="prompt-col">{excerpt(t.prompt, 80)}</td>
                <td className="mix-col">
                  <MixBar
                    className="turn-mix"
                    label="uncached / cached / output"
                    segments={[
                      {
                        key: "uncached",
                        value: t.cost.uncached_input,
                        className: "uncached",
                      },
                      {
                        key: "cached",
                        value: t.cost.cached_input,
                        className: "cached",
                      },
                      {
                        key: "output",
                        value: t.cost.output,
                        className: "output",
                      },
                    ]}
                  />
                </td>
                <td>{t.cost.uncached_input.toLocaleString()}</td>
                <td>{t.cost.cached_input.toLocaleString()}</td>
                <td>{t.cost.output.toLocaleString()}</td>
                <td>{formatCost(t.cost, "credits")}</td>
                <td>{formatCost(t.cost, "usd")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

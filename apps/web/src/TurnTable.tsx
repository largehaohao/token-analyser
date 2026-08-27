import type { Turn } from "./api";
import { formatCost } from "./format";

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
    <div className="turn-table-wrap">
      <h3>Turns ({filtered.length})</h3>
      {filtered.length === 0 ? (
        <p className="empty-turns">Select a tree node to view turns.</p>
      ) : (
        <table className="turn-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Tools</th>
              <th>Prompt</th>
              <th>Uncached</th>
              <th>Cached</th>
              <th>Output</th>
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

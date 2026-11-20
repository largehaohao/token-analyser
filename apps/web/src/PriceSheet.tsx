import { useEffect, useMemo, useState } from "react";
import { getPriceSheet, type PriceSheet as PriceSheetData } from "./api";
import { Button } from "./ui";

type LoadState = "idle" | "loading" | "ready" | "error";

function formatRate(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 4,
  }).format(value);
}

export function PriceSheet({
  open,
  reloadKey,
}: {
  open: boolean;
  reloadKey: number;
}) {
  const [sheet, setSheet] = useState<PriceSheetData | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancel = false;
    setState("loading");
    getPriceSheet()
      .then((next) => {
        if (cancel) return;
        setSheet(next);
        setState("ready");
      })
      .catch(() => {
        if (!cancel) setState("error");
      });
    return () => {
      cancel = true;
    };
  }, [open, reloadKey, attempt]);

  const needle = query.trim().toLowerCase();
  const groups = useMemo(() => {
    if (!sheet) return [];
    return sheet.groups
      .map((group) => ({
        ...group,
        rows: needle
          ? group.rows.filter((row) => row.id.toLowerCase().includes(needle))
          : group.rows,
      }))
      .filter((group) => group.rows.length > 0);
  }, [needle, sheet]);
  const rowCount = groups.reduce((sum, group) => sum + group.rows.length, 0);

  if (!open) return null;

  return (
    <section className="price-sheet" id="price-sheet">
      <div className="price-sheet-toolbar">
        <input
          className="price-sheet-search"
          type="search"
          value={query}
          placeholder="筛选模型"
          aria-label="筛选模型"
          onChange={(event) => setQuery(event.target.value)}
        />
        <p>
          {state === "ready"
            ? `${rowCount} 个模型 · 单价为每百万 token，说明里的第二档不改变默认报价`
            : "正在读取本地价格表"}
        </p>
      </div>

      {state === "error" && (
        <p className="data-notice" role="alert">
          价格表加载失败。确认本地引擎正在运行后重试。
        </p>
      )}

      {state === "ready" && rowCount === 0 && (
        <p className="data-notice">没有匹配的模型。</p>
      )}

      {groups.map((group) => (
        <section key={group.id} className="price-sheet-group">
          <h2>
            {group.label}
            <span>
              {group.asOf} · {group.unitLabel}
            </span>
          </h2>
          {group.note ? <p>{group.note}</p> : null}
          <div className="price-sheet-scroll">
            <table>
              <thead>
                <tr>
                  <th>模型</th>
                  <th>输入</th>
                  <th>缓存输入</th>
                  <th>输出</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((row) => (
                  <tr key={row.id}>
                    <th scope="row">{row.id}</th>
                    <td>{formatRate(row.input)}</td>
                    <td>{formatRate(row.cached)}</td>
                    <td>{formatRate(row.output)}</td>
                    <td>{row.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      {state === "error" ? (
        <Button onClick={() => setAttempt((value) => value + 1)}>重试</Button>
      ) : null}
    </section>
  );
}

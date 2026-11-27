import { useEffect, useMemo, useState, type ReactNode } from "react";
import { getPriceSheet, ignorePriceModel, restorePriceModel, type PriceSheet as PriceSheetData } from "./api";
import { Button, Icon } from "./ui";

type LoadState = "idle" | "loading" | "ready" | "error";

function formatRate(value: number): string {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 4,
  }).format(value);
}

export function PriceSheet({
  open,
  reloadKey,
  onUpdate,
  updating,
  status,
}: {
  open: boolean;
  reloadKey: number;
  onUpdate: () => void;
  updating: boolean;
  status?: ReactNode;
}) {
  const [sheet, setSheet] = useState<PriceSheetData | null>(null);
  const [state, setState] = useState<LoadState>("idle");
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [ignoring, setIgnoring] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
  const ignored = useMemo(() => {
    const entries = sheet?.ignored ?? [];
    if (!needle) return entries;
    return entries.filter((entry) =>
      entry.model.toLowerCase().includes(needle) || entry.label.toLowerCase().includes(needle),
    );
  }, [needle, sheet]);
  const rowCount = groups.reduce((sum, group) => sum + group.rows.length, 0);

  async function changeIgnore(action: "ignore" | "restore", group: string, model: string) {
    const key = `${action}:${group}:${model}`;
    setIgnoring(key);
    setError(null);
    try {
      if (action === "ignore") await ignorePriceModel(group, model);
      else await restorePriceModel(group, model);
      setAttempt((value) => value + 1);
    } catch {
      setError(action === "ignore" ? "忽略失败，请重试。" : "恢复失败，请重试。");
    } finally {
      setIgnoring(null);
    }
  }

  if (!open) return null;

  return (
    <section className="price-sheet" id="price-sheet">
      <div className="price-sheet-toolbar">
        <h2 className="price-sheet-title">模型价格表 (PriceSheet)</h2>
        <input
          className="price-sheet-search"
          type="search"
          value={query}
          placeholder="筛选模型…"
          aria-label="筛选模型"
          onChange={(event) => setQuery(event.target.value)}
        />
        <p className="price-sheet-count">
          {state === "ready"
            ? `${rowCount} 个模型 · 单价为每百万 token (USD)`
            : "正在读取本地价格表"}
        </p>
        <Button emphasis="solid" intent="brand" className="price-sheet-update-btn" onClick={onUpdate} busy={updating}>
          <Icon name="refresh" /> 更新模型价格
        </Button>
      </div>
      {status && <div className="app-notice">{status}</div>}

      {state === "error" && (
        <p className="data-notice" role="alert">
          价格表加载失败。确认本地引擎正在运行后重试。
        </p>
      )}
      {error && <p className="data-notice" role="alert">{error}</p>}

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
            <table className="price-sheet-table">
              <colgroup>
                <col className="price-sheet-col-action" />
                <col className="price-sheet-col-model" />
                <col className="price-sheet-col-rate" />
                <col className="price-sheet-col-rate" />
                <col className="price-sheet-col-rate" />
                <col className="price-sheet-col-note" />
              </colgroup>
              <thead>
                <tr>
                  <th aria-label="操作" />
                  <th>模型</th>
                  <th>输入</th>
                  <th>缓存输入</th>
                  <th>输出</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {group.rows.map((row) => (
                  <tr key={row.id} className={row.aliasOf ? "price-sheet-row-alias" : undefined}>
                    <td className="price-sheet-action">
                      <button
                        type="button"
                        className="price-sheet-ignore"
                        disabled={ignoring !== null}
                        onClick={() => void changeIgnore("ignore", group.id, row.id)}
                        aria-label={`忽略 ${row.id}`}
                        title="忽略后不再更新，也不再展示"
                      >
                        {ignoring === `ignore:${group.id}:${row.id}` ? "…" : "忽略"}
                      </button>
                    </td>
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
      {state === "ready" && (sheet?.ignored?.length ?? 0) > 0 && (
        <details className="price-sheet-ignored" open>
          <summary>已忽略 {sheet?.ignored?.length ?? 0} 个模型</summary>
          {ignored.length === 0 ? (
            <p>没有匹配的已忽略模型。</p>
          ) : (
            <ul>
              {ignored.map((entry) => {
                const key = `restore:${entry.group}:${entry.model}`;
                return (
                  <li key={`${entry.group}:${entry.model}`}>
                    <button
                      type="button"
                      className="price-sheet-ignore"
                      disabled={ignoring !== null}
                      onClick={() => void changeIgnore("restore", entry.group, entry.model)}
                      aria-label={`恢复 ${entry.model}`}
                      title="恢复后重新展示，并在下次更新时刷新价格"
                    >
                      {ignoring === key ? "…" : "恢复"}
                    </button>
                    <span>
                      <b>{entry.label}</b>
                      {entry.model}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </details>
      )}
      {state === "error" ? (
        <Button onClick={() => setAttempt((value) => value + 1)}>重试</Button>
      ) : null}
    </section>
  );
}

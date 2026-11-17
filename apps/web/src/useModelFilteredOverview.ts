import { useCallback, useEffect, useState } from "react";
import type { Overview } from "./api";
import { ALL_MODELS } from "./model-filter";

/**
 * Loads a model-scoped overview for one panel. `filterScope` changes when the
 * page window or source changes so the selection re-queries the same bounds.
 * The payload is bound to its model and scope: another model's numbers are
 * never shown under the current selection, and a failed read keeps `null`
 * (an explicit error state) instead of falling back to all-model figures.
 */
export function useModelFilteredOverview(
  base: Overview,
  filterScope: string,
  fetchOverviewForModel: (model: string) => Promise<Overview>,
) {
  const [model, setModel] = useState(ALL_MODELS);
  const [payload, setPayload] = useState<{ key: string; data: Overview } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const key = `${model}|${filterScope}`;

  useEffect(() => {
    if (model === ALL_MODELS) {
      setPayload(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setPayload(null);
    setError(null);
    void fetchOverviewForModel(model)
      .then((data) => {
        if (cancelled) return;
        setPayload({ key, data });
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setPayload(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [model, filterScope, fetchOverviewForModel, key, attempt]);

  return {
    model,
    setModel,
    overview: model === ALL_MODELS ? base : payload?.key === key ? payload.data : null,
    loading,
    error,
    retry,
  };
}

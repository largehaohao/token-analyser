import { useEffect, useState } from "react";
import type { Overview } from "./api";
import { ALL_MODELS, overviewForModelFilter } from "./model-filter";

/**
 * Loads a model-scoped overview for one panel. `filterScope` changes when the
 * page window or source changes so the selection re-queries the same bounds.
 */
export function useModelFilteredOverview(
  base: Overview,
  filterScope: string,
  fetchOverviewForModel: (model: string) => Promise<Overview>,
) {
  const [model, setModel] = useState(ALL_MODELS);
  const [filtered, setFiltered] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (model === ALL_MODELS) {
      setFiltered(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void fetchOverviewForModel(model)
      .then((data) => {
        if (cancelled) return;
        setFiltered(data);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setFiltered(null);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [model, filterScope, fetchOverviewForModel]);

  return {
    model,
    setModel,
    overview: overviewForModelFilter(base, filtered, model),
    loading,
    error,
  };
}

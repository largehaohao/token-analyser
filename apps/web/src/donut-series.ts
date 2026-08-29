import type { OverviewSlice } from "./api";
import { SLICE_META, type SliceKey } from "./buckets";
import { allocatePercents } from "./format";

export type DonutSlice = {
  key: string;
  raw: number;
  label: string;
  color: string;
};

const UNATTRIBUTED: Omit<DonutSlice, "raw"> = {
  key: "unattributed",
  label: "未归因",
  color: "#64706a",
};

export function buildDonutSeries(
  slices: OverviewSlice[],
  totalRaw: number,
): DonutSlice[] {
  const series: DonutSlice[] = slices.map((slice) => {
    const meta = SLICE_META[slice.key as SliceKey];
    return {
      key: slice.key,
      raw: slice.raw,
      label: meta?.label ?? slice.key,
      color: meta?.color ?? "#7dffb3",
    };
  });
  const sliceSum = series.reduce((sum, slice) => sum + slice.raw, 0);
  const extra = totalRaw - sliceSum;
  if (extra > 0) {
    series.push({ ...UNATTRIBUTED, raw: extra });
  }
  return series;
}

export function donutPercents(series: DonutSlice[]): number[] {
  return allocatePercents(series.map((slice) => slice.raw));
}

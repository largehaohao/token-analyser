export function downsampleValues(
  values: number[],
  maxPoints: number,
): number[] {
  if (maxPoints <= 0) return [];
  if (values.length <= maxPoints) return values.slice();
  const out: number[] = [];
  for (let i = 0; i < maxPoints; i++) {
    const start = Math.floor((i / maxPoints) * values.length);
    const end = Math.max(
      start + 1,
      Math.floor(((i + 1) / maxPoints) * values.length),
    );
    let peak = 0;
    for (let j = start; j < end; j++) {
      const value = values[j] ?? 0;
      if (value > peak) peak = value;
    }
    out.push(peak);
  }
  return out;
}

export function sparklinePoints(
  values: number[],
  width: number,
  height: number,
  pad = 2,
): string {
  if (values.length < 2) return "";
  const max = Math.max(...values, 1);
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  return values
    .map((value, i) => {
      const x = pad + (i / (values.length - 1)) * innerW;
      const y = height - pad - (value / max) * innerH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

export type Series = number[];

export function computeEmaSeries(values: Series, period: number): Series {
  const out = new Array(values.length).fill(NaN);
  const n = Math.floor(period);
  if (n <= 0) return out;
  if (values.length < n) return out;

  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  let prev = sum / n;
  const alpha = 2 / (n + 1);
  out[n - 1] = prev;

  for (let i = n; i < values.length; i++) {
    prev = alpha * values[i] + (1 - alpha) * prev;
    out[i] = prev;
  }

  return out;
}

export function computeEmaMultiSeries(values: Series, periods: number[]): Record<number, Series> {
  const uniquePeriods = Array.from(new Set(periods.map((p) => Math.floor(p)))).filter((p) => p > 0);
  uniquePeriods.sort((a, b) => a - b);
  const result: Record<number, Series> = {};
  for (const p of uniquePeriods) {
    result[p] = computeEmaSeries(values, p);
  }
  return result;
}


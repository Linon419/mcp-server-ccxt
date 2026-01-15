export type Ohlcv = [number, number, number, number, number, number];

export type MaBandOscParams = {
  // Core params (matching defaults in the Pine script)
  len?: number; // main channel length
  avgLen?: number; // signal length
  smoothLen?: number; // smoothing length
  mult?: number;
  hybridWtWeight?: number;
  hybridMfiLen?: number;
  useHeikinAshi?: boolean;
  maType?: 'SMA' | 'EMA' | 'HMA' | 'ALMA' | 'Laguerre';
  laguerreGamma?: number;
  useSigmoid?: boolean;
  sigmoidGain?: number;
  oscMax?: number;
  oscMin?: number;
  enableStepQuantization?: boolean;
  stepSize?: number;
  stepQuantMethod?: 'Floor' | 'Round';
};

type Series = number[];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sign(value: number): number {
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

function sma(values: Series, length: number): Series {
  const out = new Array(values.length).fill(NaN);
  if (length <= 0) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    sum += v;
    if (i >= length) sum -= values[i - length];
    if (i >= length - 1) out[i] = sum / length;
  }
  return out;
}

function ema(values: Series, length: number): Series {
  const out = new Array(values.length).fill(NaN);
  if (length <= 0) return out;
  const alpha = 2 / (length + 1);
  let prev = values[0];
  out[0] = prev;
  for (let i = 1; i < values.length; i++) {
    prev = alpha * values[i] + (1 - alpha) * prev;
    out[i] = prev;
  }
  return out;
}

function wma(values: Series, length: number): Series {
  const out = new Array(values.length).fill(NaN);
  if (length <= 0) return out;
  const denom = (length * (length + 1)) / 2;
  for (let i = length - 1; i < values.length; i++) {
    let sum = 0;
    for (let k = 0; k < length; k++) {
      const weight = k + 1;
      sum += values[i - (length - 1 - k)] * weight;
    }
    out[i] = sum / denom;
  }
  return out;
}

function hma(values: Series, length: number): Series {
  // HMA = WMA(2*WMA(n/2) - WMA(n), sqrt(n))
  const n = Math.max(1, Math.floor(length));
  const half = Math.max(1, Math.floor(n / 2));
  const sqrtN = Math.max(1, Math.floor(Math.sqrt(n)));
  const wmaHalf = wma(values, half);
  const wmaFull = wma(values, n);
  const diff = values.map((_, i) => 2 * (wmaHalf[i] ?? NaN) - (wmaFull[i] ?? NaN));
  return wma(diff, sqrtN);
}

function alma(values: Series, length: number, offset = 0.85, sigma = 6): Series {
  const out = new Array(values.length).fill(NaN);
  if (length <= 0) return out;
  const m = offset * (length - 1);
  const s = length / sigma;
  const weights = new Array(length).fill(0).map((_, i) => {
    const x = i - m;
    return Math.exp(-(x * x) / (2 * s * s));
  });
  const sumw = weights.reduce((a, b) => a + b, 0);

  for (let i = length - 1; i < values.length; i++) {
    let sum = 0;
    for (let k = 0; k < length; k++) {
      sum += values[i - (length - 1 - k)] * weights[k];
    }
    out[i] = sumw === 0 ? NaN : sum / sumw;
  }
  return out;
}

function laguerre(values: Series, gamma: number): Series {
  const out = new Array(values.length).fill(NaN);
  let L0 = 0;
  let L1 = 0;
  let L2 = 0;
  let L3 = 0;

  for (let i = 0; i < values.length; i++) {
    const src = values[i];
    const prevL0 = L0;
    const prevL1 = L1;
    const prevL2 = L2;
    const prevL3 = L3;

    L0 = (1 - gamma) * src + gamma * prevL0;
    L1 = -gamma * L0 + prevL0 + gamma * prevL1;
    L2 = -gamma * L1 + prevL1 + gamma * prevL2;
    L3 = -gamma * L2 + prevL2 + gamma * prevL3;
    out[i] = (L0 + 2 * L1 + 2 * L2 + L3) / 6;
  }

  return out;
}

function getMa(values: Series, length: number, type: MaBandOscParams['maType'], laguerreGamma: number): Series {
  switch (type) {
    case 'SMA':
      return sma(values, length);
    case 'EMA':
      return ema(values, length);
    case 'HMA':
      return hma(values, length);
    case 'ALMA':
      return alma(values, length, 0.85, 6);
    case 'Laguerre':
      return laguerre(values, laguerreGamma);
    default:
      return sma(values, length);
  }
}

function sigmoid(values: Series, gain: number): Series {
  // Pine: val = src/100; sig = 2/(1+exp(-gain*val))-1; *100
  return values.map((v) => {
    const val = v / 100;
    const sig = 2 / (1 + Math.exp(-gain * val)) - 1;
    return sig * 100;
  });
}

function hlc3(ohlcv: Ohlcv): number {
  return (ohlcv[2] + ohlcv[3] + ohlcv[4]) / 3;
}

export function heikinAshi(ohlcvs: Ohlcv[]): { open: Series; high: Series; low: Series; close: Series; hlc3: Series } {
  const outOpen: Series = new Array(ohlcvs.length).fill(NaN);
  const outHigh: Series = new Array(ohlcvs.length).fill(NaN);
  const outLow: Series = new Array(ohlcvs.length).fill(NaN);
  const outClose: Series = new Array(ohlcvs.length).fill(NaN);
  const outHlc3: Series = new Array(ohlcvs.length).fill(NaN);

  let prevHaOpen = NaN;
  let prevHaClose = NaN;

  for (let i = 0; i < ohlcvs.length; i++) {
    const [, open, high, low, close] = ohlcvs[i];
    const haClose = (open + high + low + close) / 4;
    const haOpen = i === 0 ? (open + close) / 2 : (prevHaOpen + prevHaClose) / 2;
    const haHigh = Math.max(high, haOpen, haClose);
    const haLow = Math.min(low, haOpen, haClose);

    outOpen[i] = haOpen;
    outHigh[i] = haHigh;
    outLow[i] = haLow;
    outClose[i] = haClose;
    outHlc3[i] = (haHigh + haLow + haClose) / 3;

    prevHaOpen = haOpen;
    prevHaClose = haClose;
  }

  return { open: outOpen, high: outHigh, low: outLow, close: outClose, hlc3: outHlc3 };
}

function mfi(source: Series, volume: Series, length: number): Series {
  const out = new Array(source.length).fill(NaN);
  if (length <= 0) return out;

  const pos: Series = new Array(source.length).fill(0);
  const neg: Series = new Array(source.length).fill(0);
  for (let i = 1; i < source.length; i++) {
    const moneyFlow = source[i] * volume[i];
    if (source[i] > source[i - 1]) pos[i] = moneyFlow;
    else if (source[i] < source[i - 1]) neg[i] = moneyFlow;
  }

  let posSum = 0;
  let negSum = 0;
  for (let i = 0; i < source.length; i++) {
    posSum += pos[i];
    negSum += neg[i];
    if (i >= length) {
      posSum -= pos[i - length];
      negSum -= neg[i - length];
    }
    if (i >= length - 1) {
      if (negSum === 0) out[i] = 100;
      else if (posSum === 0) out[i] = 0;
      else {
        const ratio = posSum / negSum;
        out[i] = 100 - 100 / (1 + ratio);
      }
    }
  }
  return out;
}

function wavetrend(source: Series, chlen: number, avglen: number, smlen: number, laguerreGamma: number): Series {
  const esa = ema(source, chlen);
  const absDiff = source.map((v, i) => Math.abs(v - esa[i]));
  const d = ema(absDiff, chlen);
  const ci = source.map((v, i) => (d[i] !== 0 ? (v - esa[i]) / (0.015 * d[i]) : 0));
  const wt1 = getMa(ci, avglen, 'EMA', laguerreGamma);
  const wt2 = getMa(wt1, smlen, 'ALMA', laguerreGamma);
  return wt2;
}

export function computeMaBandOscSeries(
  ohlcvs: Ohlcv[],
  params: MaBandOscParams = {}
): { timestamps: number[]; osc: number[] } {
  const {
    len = 10,
    avgLen = 8,
    smoothLen = 5,
    mult = 1.2,
    hybridWtWeight = 0.3,
    hybridMfiLen = 10,
    useHeikinAshi = true,
    maType = 'ALMA',
    laguerreGamma = 0.66,
    useSigmoid = false,
    sigmoidGain = 2.2,
    oscMax = 60,
    oscMin = -60,
    enableStepQuantization = true,
    stepSize = 6.6,
    stepQuantMethod = 'Round'
  } = params;

  const timestamps = ohlcvs.map((c) => c[0]);
  const volume = ohlcvs.map((c) => c[5]);
  const typical = ohlcvs.map((c) => hlc3(c));

  const ha = heikinAshi(ohlcvs);
  const src = useHeikinAshi ? ha.hlc3 : typical;

  const wt = wavetrend(src, len, avgLen, smoothLen, laguerreGamma);
  const mfiVal = mfi(src, volume, hybridMfiLen).map((v) => (v - 50) * 1.5);
  const raw = wt.map((v, i) => hybridWtWeight * v + (1 - hybridWtWeight) * mfiVal[i]);

  const processed = useSigmoid ? sigmoid(raw.map((v) => v * mult), sigmoidGain) : raw.map((v) => v * mult);
  const smoothed = getMa(processed, smoothLen, maType, laguerreGamma);

  const osc = smoothed.map((v) => {
    const limited = clamp(v, oscMin, oscMax);
    if (!enableStepQuantization || stepSize <= 0) return limited;
    const scaled = limited / stepSize;
    const absSteps = stepQuantMethod === 'Round' ? Math.round(Math.abs(scaled)) : Math.floor(Math.abs(scaled));
    const quantized = sign(scaled) * absSteps * stepSize;
    return clamp(quantized, oscMin, oscMax);
  });

  return { timestamps, osc };
}


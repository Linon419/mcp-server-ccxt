/**
 * Divergence Detection Tools
 * Detects Regular and Hidden divergences using multiple technical indicators
 *
 * 背离检测工具
 * 使用多个技术指标检测常规和隐藏背离
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getExchange } from '../exchange/manager.js';
import { log, LogLevel } from '../utils/logging.js';

// Types
interface OHLCV {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface PivotPoint {
  index: number;
  value: number;
  price: number;
}

interface Divergence {
  indicator: string;
  type: 'positive_regular' | 'negative_regular' | 'positive_hidden' | 'negative_hidden';
  barDistance: number;
  startPrice: number;
  endPrice: number;
  startIndicator: number;
  endIndicator: number;
}

// Technical Indicator Calculations
function sma(data: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
    } else {
      const slice = data.slice(i - period + 1, i + 1);
      result.push(slice.reduce((a, b) => a + b, 0) / period);
    }
  }
  return result;
}

function ema(data: number[], period: number): number[] {
  const result: number[] = [];
  const multiplier = 2 / (period + 1);
  for (let i = 0; i < data.length; i++) {
    if (i === 0) {
      result.push(data[0]);
    } else {
      result.push((data[i] - result[i - 1]) * multiplier + result[i - 1]);
    }
  }
  return result;
}

function rsi(closes: number[], period: number = 14): number[] {
  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }

  const avgGains = sma([0, ...gains], period);
  const avgLosses = sma([0, ...losses], period);

  const result: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period) {
      result.push(NaN);
    } else {
      const rs = avgGains[i] / (avgLosses[i] || 0.0001);
      result.push(100 - (100 / (1 + rs)));
    }
  }
  return result;
}

function macd(closes: number[], fast: number = 12, slow: number = 26, signal: number = 9): { macd: number[], signal: number[], histogram: number[] } {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);

  const macdLine: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    macdLine.push(emaFast[i] - emaSlow[i]);
  }

  const signalLine = ema(macdLine, signal);
  const histogram: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    histogram.push(macdLine[i] - signalLine[i]);
  }

  return { macd: macdLine, signal: signalLine, histogram };
}

function stochastic(highs: number[], lows: number[], closes: number[], period: number = 14, smoothK: number = 3): number[] {
  const rawK: number[] = [];

  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      rawK.push(NaN);
    } else {
      const highSlice = highs.slice(i - period + 1, i + 1);
      const lowSlice = lows.slice(i - period + 1, i + 1);
      const highestHigh = Math.max(...highSlice);
      const lowestLow = Math.min(...lowSlice);
      const k = ((closes[i] - lowestLow) / (highestHigh - lowestLow || 0.0001)) * 100;
      rawK.push(k);
    }
  }

  return sma(rawK, smoothK);
}

function cci(highs: number[], lows: number[], closes: number[], period: number = 20): number[] {
  const typicalPrices: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    typicalPrices.push((highs[i] + lows[i] + closes[i]) / 3);
  }

  const smaTP = sma(typicalPrices, period);
  const result: number[] = [];

  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
    } else {
      const slice = typicalPrices.slice(i - period + 1, i + 1);
      const meanDev = slice.reduce((acc, val) => acc + Math.abs(val - smaTP[i]), 0) / period;
      result.push((typicalPrices[i] - smaTP[i]) / (0.015 * meanDev || 0.0001));
    }
  }
  return result;
}

function momentum(closes: number[], period: number = 10): number[] {
  const result: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period) {
      result.push(NaN);
    } else {
      result.push(closes[i] - closes[i - period]);
    }
  }
  return result;
}

function obv(closes: number[], volumes: number[]): number[] {
  const result: number[] = [0];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1]) {
      result.push(result[i - 1] + volumes[i]);
    } else if (closes[i] < closes[i - 1]) {
      result.push(result[i - 1] - volumes[i]);
    } else {
      result.push(result[i - 1]);
    }
  }
  return result;
}

function vwma(closes: number[], volumes: number[], period: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      result.push(NaN);
    } else {
      let sumPV = 0, sumV = 0;
      for (let j = i - period + 1; j <= i; j++) {
        sumPV += closes[j] * volumes[j];
        sumV += volumes[j];
      }
      result.push(sumPV / (sumV || 1));
    }
  }
  return result;
}

function vwmacd(closes: number[], volumes: number[], fast: number = 12, slow: number = 26): number[] {
  const vwmaFast = vwma(closes, volumes, fast);
  const vwmaSlow = vwma(closes, volumes, slow);
  const result: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    result.push(vwmaFast[i] - vwmaSlow[i]);
  }
  return result;
}

function cmf(highs: number[], lows: number[], closes: number[], volumes: number[], period: number = 21): number[] {
  const mfMultiplier: number[] = [];
  const mfVolume: number[] = [];

  for (let i = 0; i < closes.length; i++) {
    const hl = highs[i] - lows[i];
    const mult = hl !== 0 ? ((closes[i] - lows[i]) - (highs[i] - closes[i])) / hl : 0;
    mfMultiplier.push(mult);
    mfVolume.push(mult * volumes[i]);
  }

  const sumMfv = sma(mfVolume, period).map((v, i) => v * period);
  const sumVol = sma(volumes, period).map((v, i) => v * period);

  const result: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    result.push(sumMfv[i] / (sumVol[i] || 1));
  }
  return result;
}

function mfi(highs: number[], lows: number[], closes: number[], volumes: number[], period: number = 14): number[] {
  const typicalPrices: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    typicalPrices.push((highs[i] + lows[i] + closes[i]) / 3);
  }

  const rawMF: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    rawMF.push(typicalPrices[i] * volumes[i]);
  }

  const result: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period) {
      result.push(NaN);
    } else {
      let posMF = 0, negMF = 0;
      for (let j = i - period + 1; j <= i; j++) {
        if (typicalPrices[j] > typicalPrices[j - 1]) {
          posMF += rawMF[j];
        } else {
          negMF += rawMF[j];
        }
      }
      const mfRatio = posMF / (negMF || 0.0001);
      result.push(100 - (100 / (1 + mfRatio)));
    }
  }
  return result;
}

// Pivot Detection
function findPivotHighs(prices: number[], period: number): PivotPoint[] {
  const pivots: PivotPoint[] = [];
  for (let i = period; i < prices.length - period; i++) {
    let isPivot = true;
    for (let j = 1; j <= period; j++) {
      if (prices[i] <= prices[i - j] || prices[i] <= prices[i + j]) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) {
      pivots.push({ index: i, value: prices[i], price: prices[i] });
    }
  }
  return pivots;
}

function findPivotLows(prices: number[], period: number): PivotPoint[] {
  const pivots: PivotPoint[] = [];
  for (let i = period; i < prices.length - period; i++) {
    let isPivot = true;
    for (let j = 1; j <= period; j++) {
      if (prices[i] >= prices[i - j] || prices[i] >= prices[i + j]) {
        isPivot = false;
        break;
      }
    }
    if (isPivot) {
      pivots.push({ index: i, value: prices[i], price: prices[i] });
    }
  }
  return pivots;
}

// Divergence Detection
function detectPositiveRegularDivergence(
  prices: number[],
  indicator: number[],
  pivotLows: PivotPoint[],
  indicatorPivotLows: PivotPoint[],
  maxBars: number
): number {
  const len = prices.length;
  if (pivotLows.length < 2 || indicatorPivotLows.length < 2) return 0;

  const recentPricePivot = pivotLows[pivotLows.length - 1];

  for (let i = pivotLows.length - 2; i >= 0; i--) {
    const prevPivot = pivotLows[i];
    const distance = recentPricePivot.index - prevPivot.index;

    if (distance > maxBars) break;
    if (distance < 5) continue;

    // Price makes lower low, indicator makes higher low = positive regular divergence
    if (recentPricePivot.price < prevPivot.price) {
      const recentIndValue = indicator[recentPricePivot.index];
      const prevIndValue = indicator[prevPivot.index];

      if (!isNaN(recentIndValue) && !isNaN(prevIndValue) && recentIndValue > prevIndValue) {
        return distance;
      }
    }
  }
  return 0;
}

function detectNegativeRegularDivergence(
  prices: number[],
  indicator: number[],
  pivotHighs: PivotPoint[],
  maxBars: number
): number {
  if (pivotHighs.length < 2) return 0;

  const recentPricePivot = pivotHighs[pivotHighs.length - 1];

  for (let i = pivotHighs.length - 2; i >= 0; i--) {
    const prevPivot = pivotHighs[i];
    const distance = recentPricePivot.index - prevPivot.index;

    if (distance > maxBars) break;
    if (distance < 5) continue;

    // Price makes higher high, indicator makes lower high = negative regular divergence
    if (recentPricePivot.price > prevPivot.price) {
      const recentIndValue = indicator[recentPricePivot.index];
      const prevIndValue = indicator[prevPivot.index];

      if (!isNaN(recentIndValue) && !isNaN(prevIndValue) && recentIndValue < prevIndValue) {
        return distance;
      }
    }
  }
  return 0;
}

function detectPositiveHiddenDivergence(
  prices: number[],
  indicator: number[],
  pivotLows: PivotPoint[],
  maxBars: number
): number {
  if (pivotLows.length < 2) return 0;

  const recentPricePivot = pivotLows[pivotLows.length - 1];

  for (let i = pivotLows.length - 2; i >= 0; i--) {
    const prevPivot = pivotLows[i];
    const distance = recentPricePivot.index - prevPivot.index;

    if (distance > maxBars) break;
    if (distance < 5) continue;

    // Price makes higher low, indicator makes lower low = positive hidden divergence
    if (recentPricePivot.price > prevPivot.price) {
      const recentIndValue = indicator[recentPricePivot.index];
      const prevIndValue = indicator[prevPivot.index];

      if (!isNaN(recentIndValue) && !isNaN(prevIndValue) && recentIndValue < prevIndValue) {
        return distance;
      }
    }
  }
  return 0;
}

function detectNegativeHiddenDivergence(
  prices: number[],
  indicator: number[],
  pivotHighs: PivotPoint[],
  maxBars: number
): number {
  if (pivotHighs.length < 2) return 0;

  const recentPricePivot = pivotHighs[pivotHighs.length - 1];

  for (let i = pivotHighs.length - 2; i >= 0; i--) {
    const prevPivot = pivotHighs[i];
    const distance = recentPricePivot.index - prevPivot.index;

    if (distance > maxBars) break;
    if (distance < 5) continue;

    // Price makes lower high, indicator makes higher high = negative hidden divergence
    if (recentPricePivot.price < prevPivot.price) {
      const recentIndValue = indicator[recentPricePivot.index];
      const prevIndValue = indicator[prevPivot.index];

      if (!isNaN(recentIndValue) && !isNaN(prevIndValue) && recentIndValue > prevIndValue) {
        return distance;
      }
    }
  }
  return 0;
}

// Calculate all indicators
function calculateIndicators(ohlcv: OHLCV[]): Record<string, number[]> {
  const closes = ohlcv.map(c => c.close);
  const highs = ohlcv.map(c => c.high);
  const lows = ohlcv.map(c => c.low);
  const volumes = ohlcv.map(c => c.volume);

  const macdResult = macd(closes);

  return {
    RSI: rsi(closes),
    MACD: macdResult.macd,
    'MACD Histogram': macdResult.histogram,
    Stochastic: stochastic(highs, lows, closes),
    CCI: cci(highs, lows, closes),
    Momentum: momentum(closes),
    OBV: obv(closes, volumes),
    VWMACD: vwmacd(closes, volumes),
    CMF: cmf(highs, lows, closes, volumes),
    MFI: mfi(highs, lows, closes, volumes)
  };
}

// Main detection function
function detectDivergences(
  ohlcv: OHLCV[],
  indicatorsToCheck: string[],
  divergenceType: 'regular' | 'hidden' | 'both',
  pivotPeriod: number,
  maxBarsToCheck: number
): Divergence[] {
  const divergences: Divergence[] = [];
  const closes = ohlcv.map(c => c.close);
  const highs = ohlcv.map(c => c.high);
  const lows = ohlcv.map(c => c.low);

  const indicators = calculateIndicators(ohlcv);
  const pricePivotHighs = findPivotHighs(highs, pivotPeriod);
  const pricePivotLows = findPivotLows(lows, pivotPeriod);

  for (const indName of indicatorsToCheck) {
    const indValues = indicators[indName];
    if (!indValues) continue;

    const indPivotHighs = findPivotHighs(indValues, pivotPeriod);
    const indPivotLows = findPivotLows(indValues, pivotPeriod);

    // Regular divergences
    if (divergenceType === 'regular' || divergenceType === 'both') {
      const posRegDist = detectPositiveRegularDivergence(lows, indValues, pricePivotLows, indPivotLows, maxBarsToCheck);
      if (posRegDist > 0) {
        const recentPivot = pricePivotLows[pricePivotLows.length - 1];
        const prevPivot = pricePivotLows.find(p => recentPivot.index - p.index === posRegDist) || pricePivotLows[pricePivotLows.length - 2];
        divergences.push({
          indicator: indName,
          type: 'positive_regular',
          barDistance: posRegDist,
          startPrice: prevPivot?.price || 0,
          endPrice: recentPivot?.price || 0,
          startIndicator: indValues[prevPivot?.index || 0] || 0,
          endIndicator: indValues[recentPivot?.index || 0] || 0
        });
      }

      const negRegDist = detectNegativeRegularDivergence(highs, indValues, pricePivotHighs, maxBarsToCheck);
      if (negRegDist > 0) {
        const recentPivot = pricePivotHighs[pricePivotHighs.length - 1];
        const prevPivot = pricePivotHighs.find(p => recentPivot.index - p.index === negRegDist) || pricePivotHighs[pricePivotHighs.length - 2];
        divergences.push({
          indicator: indName,
          type: 'negative_regular',
          barDistance: negRegDist,
          startPrice: prevPivot?.price || 0,
          endPrice: recentPivot?.price || 0,
          startIndicator: indValues[prevPivot?.index || 0] || 0,
          endIndicator: indValues[recentPivot?.index || 0] || 0
        });
      }
    }

    // Hidden divergences
    if (divergenceType === 'hidden' || divergenceType === 'both') {
      const posHidDist = detectPositiveHiddenDivergence(lows, indValues, pricePivotLows, maxBarsToCheck);
      if (posHidDist > 0) {
        const recentPivot = pricePivotLows[pricePivotLows.length - 1];
        const prevPivot = pricePivotLows.find(p => recentPivot.index - p.index === posHidDist) || pricePivotLows[pricePivotLows.length - 2];
        divergences.push({
          indicator: indName,
          type: 'positive_hidden',
          barDistance: posHidDist,
          startPrice: prevPivot?.price || 0,
          endPrice: recentPivot?.price || 0,
          startIndicator: indValues[prevPivot?.index || 0] || 0,
          endIndicator: indValues[recentPivot?.index || 0] || 0
        });
      }

      const negHidDist = detectNegativeHiddenDivergence(highs, indValues, pricePivotHighs, maxBarsToCheck);
      if (negHidDist > 0) {
        const recentPivot = pricePivotHighs[pricePivotHighs.length - 1];
        const prevPivot = pricePivotHighs.find(p => recentPivot.index - p.index === negHidDist) || pricePivotHighs[pricePivotHighs.length - 2];
        divergences.push({
          indicator: indName,
          type: 'negative_hidden',
          barDistance: negHidDist,
          startPrice: prevPivot?.price || 0,
          endPrice: recentPivot?.price || 0,
          startIndicator: indValues[prevPivot?.index || 0] || 0,
          endIndicator: indValues[recentPivot?.index || 0] || 0
        });
      }
    }
  }

  return divergences;
}

const AVAILABLE_INDICATORS = [
  'RSI', 'MACD', 'MACD Histogram', 'Stochastic', 'CCI',
  'Momentum', 'OBV', 'VWMACD', 'CMF', 'MFI'
];

export function registerDivergenceTools(server: McpServer) {
  server.tool(
    "detect-divergence",
    "Detect price/indicator divergences for a trading pair. Supports Regular and Hidden divergences across multiple indicators (RSI, MACD, Stochastic, CCI, Momentum, OBV, VWMACD, CMF, MFI).",
    {
      exchange: z.string().describe("Exchange ID (e.g., binance, coinbase)"),
      symbol: z.string().describe("Trading pair symbol (e.g., BTC/USDT)"),
      timeframe: z.string().default("1h").describe("Timeframe (e.g., 1m, 5m, 15m, 1h, 4h, 1d)"),
      indicators: z.array(z.string()).default(AVAILABLE_INDICATORS).describe("Indicators to check for divergence"),
      divergenceType: z.enum(["regular", "hidden", "both"]).default("both").describe("Type of divergence to detect"),
      pivotPeriod: z.number().default(5).describe("Period for pivot point detection (default 5)"),
      maxBarsToCheck: z.number().default(100).describe("Maximum bars to look back for divergence (default 100)"),
      limit: z.number().default(200).describe("Number of candles to fetch (default 200)")
    },
    async ({ exchange, symbol, timeframe, indicators, divergenceType, pivotPeriod, maxBarsToCheck, limit }) => {
      try {
        log(LogLevel.INFO, `Detecting divergences for ${symbol} on ${exchange} (${timeframe})`);

        const ex = getExchange(exchange);
        await ex.loadMarkets();

        const ohlcvRaw = await ex.fetchOHLCV(symbol, timeframe, undefined, limit);

        const ohlcv: OHLCV[] = ohlcvRaw.map((candle: any) => ({
          timestamp: candle[0],
          open: candle[1],
          high: candle[2],
          low: candle[3],
          close: candle[4],
          volume: candle[5]
        }));

        const validIndicators = indicators.filter(ind => AVAILABLE_INDICATORS.includes(ind));

        const divergences = detectDivergences(
          ohlcv,
          validIndicators,
          divergenceType,
          pivotPeriod,
          maxBarsToCheck
        );

        const result = {
          symbol,
          exchange,
          timeframe,
          analyzedCandles: ohlcv.length,
          divergenceType,
          indicatorsChecked: validIndicators,
          divergencesFound: divergences.length,
          divergences: divergences.map(d => ({
            ...d,
            description: getDivergenceDescription(d)
          }))
        };

        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }]
        };
      } catch (error) {
        log(LogLevel.ERROR, `Error detecting divergences: ${error instanceof Error ? error.message : String(error)}`);
        return {
          content: [{
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : String(error)}`
          }],
          isError: true
        };
      }
    }
  );

  server.tool(
    "list-divergence-indicators",
    "List all available indicators for divergence detection",
    {},
    async () => {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            availableIndicators: AVAILABLE_INDICATORS,
            divergenceTypes: ["regular", "hidden", "both"],
            description: {
              regular: "Price and indicator move in opposite directions (reversal signal)",
              hidden: "Price and indicator confirm trend continuation"
            }
          }, null, 2)
        }]
      };
    }
  );
}

function getDivergenceDescription(d: Divergence): string {
  const typeDesc: Record<string, string> = {
    positive_regular: "Bullish reversal signal - price makes lower low while indicator makes higher low",
    negative_regular: "Bearish reversal signal - price makes higher high while indicator makes lower high",
    positive_hidden: "Bullish continuation - price makes higher low while indicator makes lower low",
    negative_hidden: "Bearish continuation - price makes lower high while indicator makes higher high"
  };
  return `${d.indicator}: ${typeDesc[d.type]} (${d.barDistance} bars)`;
}

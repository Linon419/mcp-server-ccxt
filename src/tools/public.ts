/**
 * Public API Tools
 * Tools for accessing public cryptocurrency exchange data
 * 
 * 公共API工具
 * 用于访问公共加密货币交易所数据的工具
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getDefaultMarketType, getExchange, getExchangeWithMarketType, validateSymbol, SUPPORTED_EXCHANGES, MarketType } from '../exchange/manager.js';
import { getCachedData } from '../utils/cache.js';
import { rateLimiter } from '../utils/rate-limiter.js';
import { log, LogLevel } from '../utils/logging.js';
import { computeMaBandOscSeries } from '../utils/indicators/ma-band-osc.js';

async function resolveBinanceMarketId(ex: any, symbol: string): Promise<string> {
  const raw = symbol.trim().toUpperCase();
  if (!raw) throw new Error('symbol is required');

  if (!raw.includes('/')) {
    return raw.replace(/[^A-Z0-9]/g, '');
  }

  await ex.loadMarkets();

  try {
    const market = ex.market(raw);
    return (market?.id || raw).toString();
  } catch {
    // ignore and try fallback formats
  }

  if (!raw.includes(':')) {
    const [base, quote] = raw.split('/');
    if (base && quote) {
      const alt = `${base}/${quote}:${quote}`;
      try {
        const market = ex.market(alt);
        return (market?.id || alt).toString();
      } catch {
        // ignore
      }
    }
  }

  return raw.replace(/[^A-Z0-9]/g, '');
}

export function registerPublicTools(server: McpServer) {
  // List supported exchanges
  // 列出支持的交易所
  server.tool("list-exchanges", "List all available cryptocurrency exchanges", {}, 
    async () => {
      return {
        content: [{
          type: "text",
          text: JSON.stringify(SUPPORTED_EXCHANGES, null, 2)
        }]
      };
    }
  );

  // Get ticker information
  // 获取行情信息
  server.tool("get-ticker", "Get current ticker information for a trading pair", {
    exchange: z.string().describe("Exchange ID (e.g., binance, coinbase)"),
    symbol: z.string().describe("Trading pair symbol (e.g., BTC/USDT)"),
    marketType: z.enum(["spot", "future", "swap", "option", "margin"]).optional().describe("Market type (default: spot)")
  }, async ({ exchange, symbol, marketType }) => {
    try {
      return await rateLimiter.execute(exchange, async () => {
        const effectiveMarketType = marketType || getDefaultMarketType();
        const ex = getExchangeWithMarketType(exchange, effectiveMarketType);
        const cacheKey = `ticker:${exchange}:${effectiveMarketType}:${symbol}`;
        
        const ticker = await getCachedData(cacheKey, async () => {
          log(LogLevel.INFO, `Fetching ticker for ${symbol} on ${exchange}`);
          return await ex.fetchTicker(symbol);
        });
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(ticker, null, 2)
          }]
        };
      });
    } catch (error) {
      log(LogLevel.ERROR, `Error fetching ticker: ${error instanceof Error ? error.message : String(error)}`);
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  });

  // Batch get tickers
  // 批量获取行情
  server.tool("batch-get-tickers", "Get ticker information for multiple trading pairs at once", {
    exchange: z.string().describe("Exchange ID (e.g., binance, coinbase)"),
    symbols: z.array(z.string()).describe("List of trading pair symbols (e.g., ['BTC/USDT', 'ETH/USDT'])"),
    marketType: z.enum(["spot", "future", "swap", "option", "margin"]).optional().describe("Market type (default: spot)")
  }, async ({ exchange, symbols, marketType }) => {
    try {
      return await rateLimiter.execute(exchange, async () => {
        const effectiveMarketType = marketType || getDefaultMarketType();
        const ex = getExchangeWithMarketType(exchange, effectiveMarketType);
        const cacheKey = `tickers:${exchange}:${effectiveMarketType}:${symbols.join(',')}`;
        
        const tickers = await getCachedData(cacheKey, async () => {
          log(LogLevel.INFO, `Batch fetching tickers for ${symbols.length} symbols on ${exchange}`);
          return await ex.fetchTickers(symbols);
        });
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(tickers, null, 2)
          }]
        };
      });
    } catch (error) {
      log(LogLevel.ERROR, `Error batch fetching tickers: ${error instanceof Error ? error.message : String(error)}`);
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  });

  // Get order book
  // 获取订单簿
  server.tool("get-orderbook", "Get market order book for a trading pair", {
    exchange: z.string().describe("Exchange ID (e.g., binance, coinbase)"),
    symbol: z.string().describe("Trading pair symbol (e.g., BTC/USDT)"),
    limit: z.number().optional().default(20).describe("Depth of the orderbook")
  }, async ({ exchange, symbol, limit }) => {
    try {
      return await rateLimiter.execute(exchange, async () => {
        const effectiveMarketType = getDefaultMarketType();
        const ex = getExchangeWithMarketType(exchange, effectiveMarketType);
        const cacheKey = `orderbook:${exchange}:${effectiveMarketType}:${symbol}:${limit}`;
        
        const orderbook = await getCachedData(cacheKey, async () => {
          log(LogLevel.INFO, `Fetching orderbook for ${symbol} on ${exchange}, depth: ${limit}`);
          return await ex.fetchOrderBook(symbol, limit);
        });
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(orderbook, null, 2)
          }]
        };
      });
    } catch (error) {
      log(LogLevel.ERROR, `Error fetching orderbook: ${error instanceof Error ? error.message : String(error)}`);
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  });

  // Get OHLCV data
  // 获取K线数据
  server.tool("get-ohlcv", "Get OHLCV candlestick data for a trading pair", {
    exchange: z.string().describe("Exchange ID (e.g., binance, coinbase)"),
    symbol: z.string().describe("Trading pair symbol (e.g., BTC/USDT)"),
    timeframe: z.string().optional().default("1d").describe("Timeframe (e.g., 1m, 5m, 1h, 1d)"),
    limit: z.number().optional().default(100).describe("Number of candles to fetch (max 1000)")
  }, async ({ exchange, symbol, timeframe, limit }) => {
    try {
      return await rateLimiter.execute(exchange, async () => {
        const effectiveMarketType = getDefaultMarketType();
        const ex = getExchangeWithMarketType(exchange, effectiveMarketType);
        const cacheKey = `ohlcv:${exchange}:${effectiveMarketType}:${symbol}:${timeframe}:${limit}`;
        
        const ohlcv = await getCachedData(cacheKey, async () => {
          log(LogLevel.INFO, `Fetching OHLCV for ${symbol} on ${exchange}, timeframe: ${timeframe}, limit: ${limit}`);
          return await ex.fetchOHLCV(symbol, timeframe, undefined, limit);
        });
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(ohlcv, null, 2)
          }]
        };
      });
    } catch (error) {
      log(LogLevel.ERROR, `Error fetching OHLCV data: ${error instanceof Error ? error.message : String(error)}`);
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  });

  // Get recent trades
  // 获取最近交易
  server.tool("get-trades", "Get recent trades for a trading pair", {
    exchange: z.string().describe("Exchange ID (e.g., binance, coinbase)"),
    symbol: z.string().describe("Trading pair symbol (e.g., BTC/USDT)"),
    limit: z.number().optional().default(50).describe("Number of trades to fetch")
  }, async ({ exchange, symbol, limit }) => {
    try {
      return await rateLimiter.execute(exchange, async () => {
        const effectiveMarketType = getDefaultMarketType();
        const ex = getExchangeWithMarketType(exchange, effectiveMarketType);
        const cacheKey = `trades:${exchange}:${effectiveMarketType}:${symbol}:${limit}`;
        
        const trades = await getCachedData(cacheKey, async () => {
          log(LogLevel.INFO, `Fetching trades for ${symbol} on ${exchange}, limit: ${limit}`);
          return await ex.fetchTrades(symbol, undefined, limit);
        });
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(trades, null, 2)
          }]
        };
      });
    } catch (error) {
      log(LogLevel.ERROR, `Error fetching trades: ${error instanceof Error ? error.message : String(error)}`);
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  });

  // Get exchange markets
  // 获取交易所市场
  server.tool("get-markets", "Get all available markets for an exchange", {
    exchange: z.string().describe("Exchange ID (e.g., binance, coinbase)"),
    page: z.number().optional().default(1).describe("Page number"),
    pageSize: z.number().optional().default(100).describe("Items per page")
  }, async ({ exchange, page, pageSize }) => {
    try {
      return await rateLimiter.execute(exchange, async () => {
        const effectiveMarketType = getDefaultMarketType();
        const ex = getExchangeWithMarketType(exchange, effectiveMarketType);
        const cacheKey = `markets:${exchange}:${effectiveMarketType}`;
        
        const allMarkets = await getCachedData(cacheKey, async () => {
          log(LogLevel.INFO, `Fetching all markets for ${exchange}`);
          await ex.loadMarkets();
          return Object.values(ex.markets);
        }, 3600000); // Cache for 1 hour
        
        // Simple pagination
        const start = (page - 1) * pageSize;
        const end = start + pageSize;
        const pagedMarkets = allMarkets.slice(start, end);
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              total: allMarkets.length,
              page,
              pageSize,
              data: pagedMarkets
            }, null, 2)
          }]
        };
      });
    } catch (error) {
      log(LogLevel.ERROR, `Error fetching markets: ${error instanceof Error ? error.message : String(error)}`);
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  });

  // Get exchange information
  // 获取交易所信息
  server.tool("get-exchange-info", "Get exchange information and status", {
    exchange: z.string().describe("Exchange ID (e.g., binance, coinbase)"),
    marketType: z.enum(["spot", "future", "swap", "option", "margin"]).optional().describe("Market type (default: spot)")
  }, async ({ exchange, marketType }) => {
    try {
      return await rateLimiter.execute(exchange, async () => {
        const effectiveMarketType = marketType || getDefaultMarketType();
        const ex = getExchangeWithMarketType(exchange, effectiveMarketType);
        const cacheKey = `status:${exchange}:${effectiveMarketType}`;
        
        const info = await getCachedData(cacheKey, async () => {
          log(LogLevel.INFO, `Fetching status information for ${exchange}`);
          return await ex.fetchStatus();
        }, 300000); // Cache for 5 minutes
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(info, null, 2)
          }]
        };
      });
    } catch (error) {
      log(LogLevel.ERROR, `Error fetching exchange information: ${error instanceof Error ? error.message : String(error)}`);
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  });

  // Get futures leverage tiers
  // 获取期货杠杆级别
  server.tool("get-leverage-tiers", "Get futures leverage tiers for trading pairs", {
    exchange: z.string().describe("Exchange ID (e.g., binance, bybit)"),
    symbol: z.string().optional().describe("Trading pair symbol (optional, e.g., BTC/USDT)"),
    marketType: z.enum(["future", "swap"]).default("future").describe("Market type (default: future)")
  }, async ({ exchange, symbol, marketType }) => {
    try {
      return await rateLimiter.execute(exchange, async () => {
        // Get futures exchange
        const ex = getExchangeWithMarketType(exchange, marketType);
        const cacheKey = `leverage_tiers:${exchange}:${marketType}:${symbol || 'all'}`;
        
        const tiers = await getCachedData(cacheKey, async () => {
          log(LogLevel.INFO, `Fetching leverage tiers for ${symbol || 'all symbols'} on ${exchange} (${marketType})`);
          if (symbol) {
            return await ex.fetchMarketLeverageTiers(symbol);
          } else {
            return await ex.fetchLeverageTiers();
          }
        }, 3600000); // Cache for 1 hour
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(tiers, null, 2)
          }]
        };
      });
    } catch (error) {
      log(LogLevel.ERROR, `Error fetching leverage tiers: ${error instanceof Error ? error.message : String(error)}`);
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  });
  
  // Get funding rates
  // 获取资金费率
  server.tool("get-funding-rates", "Get current funding rates for perpetual contracts", {
    exchange: z.string().describe("Exchange ID (e.g., binance, bybit)"),
    symbols: z.array(z.string()).optional().describe("List of trading pair symbols (optional)"),
    marketType: z.enum(["future", "swap"]).default("swap").describe("Market type (default: swap)")
  }, async ({ exchange, symbols, marketType }) => {
    try {
      return await rateLimiter.execute(exchange, async () => {
        // Get futures exchange
        const ex = getExchangeWithMarketType(exchange, marketType);
        const cacheKey = `funding_rates:${exchange}:${marketType}:${symbols ? symbols.join(',') : 'all'}`;
        
        const rates = await getCachedData(cacheKey, async () => {
          log(LogLevel.INFO, `Fetching funding rates for ${symbols ? symbols.length : 'all'} symbols on ${exchange} (${marketType})`);
          if (symbols) {
            return await ex.fetchFundingRates(symbols);
          } else {
            return await ex.fetchFundingRates();
          }
        }, 300000); // Cache for 5 minutes
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(rates, null, 2)
          }]
        };
      });
    } catch (error) {
      log(LogLevel.ERROR, `Error fetching funding rates: ${error instanceof Error ? error.message : String(error)}`);
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  });

  // Get Binance USD-M open interest (fapi /openInterest)
  // 获取币安 USD-M 合约持仓量（Open Interest）
  server.tool("get-open-interest", "Get Binance USD-M open interest (/fapi/v1/openInterest)", {
    exchange: z.string().describe("Exchange ID (must be binance or binanceusdm)"),
    symbol: z.string().describe("Symbol (e.g., BTC/USDT, BTC/USDT:USDT, or BTCUSDT)")
  }, async ({ exchange, symbol }) => {
    const exchangeId = exchange.toLowerCase();
    if (exchangeId !== 'binance' && exchangeId !== 'binanceusdm') {
      return {
        content: [{
          type: "text",
          text: "Error: get-open-interest currently supports only Binance USD-M (exchange: binance or binanceusdm)."
        }],
        isError: true
      };
    }

    try {
      return await rateLimiter.execute(exchangeId, async () => {
        const ex: any = getExchangeWithMarketType(exchangeId, 'future');
        const cacheKey = `open_interest:${exchangeId}:future:${symbol}`;

        const oi = await getCachedData(cacheKey, async () => {
          const marketId = await resolveBinanceMarketId(ex, symbol);
          log(LogLevel.INFO, `Fetching open interest for ${marketId} on ${exchangeId} (fapi)`);
          return await ex.fapiPublicGetOpenInterest({ symbol: marketId });
        }, 10_000);

        return {
          content: [{
            type: "text",
            text: JSON.stringify(oi, null, 2)
          }]
        };
      });
    } catch (error) {
      log(LogLevel.ERROR, `Error fetching open interest: ${error instanceof Error ? error.message : String(error)}`);
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  });

  const bandFilterOscSchema = {
    exchange: z.string().describe("Exchange ID (e.g., binance)"),
    symbol: z.string().describe("Trading pair symbol (e.g., BTC/USDT or BTC/USDT:USDT for derivatives)"),
    timeframe: z.string().optional().default("15m").describe("Timeframe (default: 15m)"),
    limit: z.number().int().positive().optional().default(300).describe("Number of candles to return (default: 300, max: 1000)"),
    marketType: z.enum(["spot", "future", "swap", "option", "margin"]).optional().describe("Market type (default: from DEFAULT_MARKET_TYPE)"),
    cacheTtlMs: z.number().int().positive().optional().default(30000).describe("Cache TTL in ms (default: 30000)")
  };

  const bandFilterOscHandler = async ({ exchange, symbol, timeframe, limit, marketType, cacheTtlMs }: any) => {
    try {
      return await rateLimiter.execute(exchange, async () => {
        const effectiveMarketType = (marketType || getDefaultMarketType()) as any;
        const ex: any = getExchangeWithMarketType(exchange, effectiveMarketType);

        const safeLimit = Math.min(Math.max(1, limit), 1000);
        const warmup = Math.min(500, Math.max(0, 1000 - safeLimit));
        const fetchLimit = Math.min(1000, safeLimit + warmup);
        const safeCacheTtlMs = Math.min(Math.max(1000, cacheTtlMs), 300000);

        const cacheKey = `band_filter_osc:${exchange}:${effectiveMarketType}:${symbol}:${timeframe}:${safeLimit}:${fetchLimit}`;

        const result = await getCachedData(cacheKey, async () => {
          log(LogLevel.INFO, `Fetching OHLCV for 波段过滤器: ${exchange} ${symbol} ${timeframe} limit=${fetchLimit} (${effectiveMarketType})`);
          const ohlcv = await ex.fetchOHLCV(symbol, timeframe, undefined, fetchLimit);
          const { timestamps, osc } = computeMaBandOscSeries(ohlcv);

          const sliceStart = Math.max(0, osc.length - safeLimit);
          const series = timestamps.slice(sliceStart).map((ts: number, idx: number) => [ts, osc[sliceStart + idx]]);

          return {
            exchange,
            symbol,
            marketType: effectiveMarketType,
            timeframe,
            limit: safeLimit,
            note:
              "Osc is computed from the bundled 均线波段过滤器_加密货币优化版.pine defaults (HA=true, WaveTrend+MFI hybrid). " +
              "For Binance derivatives, prefer symbols like BTC/USDT:USDT to avoid ambiguity.",
            data: series
          };
        }, safeCacheTtlMs);

        return {
          content: [{
            type: "text",
            text: JSON.stringify(result, null, 2)
          }]
        };
      });
    } catch (error) {
      log(LogLevel.ERROR, `Error computing band-filter osc series: ${error instanceof Error ? error.message : String(error)}`);
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  };

  // 波段过滤器 osc 序列（默认 15m / 300 根）
  server.tool("band-filter-osc-series", "Compute 波段过滤器 osc series (default 15m/300)", bandFilterOscSchema, bandFilterOscHandler);

  // Backward-compatible alias (older name)
  server.tool("ma-band-osc-series", "[Deprecated] Use band-filter-osc-series", bandFilterOscSchema, bandFilterOscHandler);
  
  // Get exchange market types
  // 获取交易所支持的市场类型
  server.tool("get-market-types", "Get market types supported by an exchange", {
    exchange: z.string().describe("Exchange ID (e.g., binance, coinbase)"),
  }, async ({ exchange }) => {
    try {
      return await rateLimiter.execute(exchange, async () => {
        const ex = getExchange(exchange);
        // Get markets and group by contract type
        let marketTypes = ['spot']; // Spot is always available
        
        // Try to access exchange's market type property if available
        if (ex.has && ex.has.fetchMarketLeverageTiers) {
          marketTypes.push('future');
        }
        
        // Some exchanges have specific markets property
        if (ex.markets) {
          const markets = Object.values(ex.markets);
          for (const market of markets) {
            const type = (market as any).type;
            if (type && !marketTypes.includes(type)) {
              marketTypes.push(type);
            }
          }
        }
        
        // Manually check for common market types
        try {
          const futureEx = getExchangeWithMarketType(exchange, 'future');
          await futureEx.loadMarkets();
          if (Object.keys(futureEx.markets).length > 0) {
            if (!marketTypes.includes('future')) marketTypes.push('future');
          }
        } catch (e) {
          // Future markets not available
        }
        
        try {
          const swapEx = getExchangeWithMarketType(exchange, 'swap');
          await swapEx.loadMarkets();
          if (Object.keys(swapEx.markets).length > 0) {
            if (!marketTypes.includes('swap')) marketTypes.push('swap');
          }
        } catch (e) {
          // Swap markets not available
        }
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              exchange,
              marketTypes: [...new Set(marketTypes)], // Remove duplicates
            }, null, 2)
          }]
        };
      });
    } catch (error) {
      log(LogLevel.ERROR, `Error fetching market types: ${error instanceof Error ? error.message : String(error)}`);
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  });
  
  // Removed duplicate log message
}

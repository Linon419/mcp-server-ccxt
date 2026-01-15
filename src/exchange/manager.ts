/**
 * Exchange Manager
 * Manages cryptocurrency exchange instances and provides utility functions
 * 
 * 交易所管理器
 * 管理加密货币交易所实例并提供实用函数
 */
import * as ccxt from 'ccxt';
import { log, LogLevel } from '../utils/logging.js';

// List of supported exchanges
// 支持的交易所列表
export const SUPPORTED_EXCHANGES = [
  // 原有交易所
  'binance', 'coinbase', 'kraken', 'kucoin', 'okx', 
  'gate', 'bybit', 'mexc', 'huobi',
  // 新增主流交易所
  'bitget', 'coinex', 'cryptocom', 'hashkey', 'hyperliquid',
  // 延伸现有交易所的衍生品市场
  'binanceusdm', 'binancecoinm', 'kucoinfutures', 'bitfinex', 'bitmex',
  'gateio', 'woo', 'deribit', 'phemex', 'bingx'
];

// Exchange instance cache
// 交易所实例缓存
const exchanges: Record<string, ccxt.Exchange> = {};

/**
 * Clear exchange instance cache
 * This is useful when proxy or other configurations change
 */
export function clearExchangeCache(): void {
  Object.keys(exchanges).forEach(key => {
    delete exchanges[key];
  });
  log(LogLevel.INFO, 'Exchange cache cleared');
}

// Default exchange and market type
// 默认交易所和市场类型
//
// NOTE: These defaults are intentionally read dynamically from process.env so that
// runtime configuration tools (e.g. set-market-type) can take effect without restart.
export function getDefaultExchange(): string {
  return (process.env.DEFAULT_EXCHANGE || 'binance').toLowerCase();
}

export function getDefaultMarketType(): string {
  return (process.env.DEFAULT_MARKET_TYPE || 'spot').toLowerCase();
}

// Market types enum
// 市场类型枚举
export enum MarketType {
  SPOT = 'spot',
  FUTURE = 'future',
  SWAP = 'swap',
  OPTION = 'option',
  MARGIN = 'margin'
}

function isInlineCredentialsAllowed(): boolean {
  return (process.env.ALLOW_INLINE_CREDENTIALS || '').toLowerCase() === 'true';
}

function normalizeMarketTypeForExchange(exchangeId: string, marketType: string): string {
  const id = exchangeId.toLowerCase();
  const type = (marketType || '').toLowerCase();

  // CCXT binance uses legacy "future"/"delivery" instead of "swap"
  if (id === 'binance' || id === 'binanceusdm') {
    if (type === MarketType.SWAP) return MarketType.FUTURE;
  }

  if (id === 'binancecoinm') {
    if (type === MarketType.SWAP) return MarketType.FUTURE;
  }

  return type;
}

function mapCcxtDefaultType(exchangeId: string, marketType: string): string {
  const id = exchangeId.toLowerCase();
  const type = marketType.toLowerCase();

  if (id === 'binance') {
    if (type === MarketType.FUTURE) return 'future';   // USDT-margined futures/perps (fapi)
    if (type === MarketType.OPTION) return 'option';
    if (type === MarketType.MARGIN) return 'margin';
    return 'spot';
  }

  if (id === 'binanceusdm') {
    return 'future';
  }

  if (id === 'binancecoinm') {
    return 'delivery';
  }

  return type;
}

/**
 * Get exchange instance
 * @param exchangeId Exchange ID
 * @returns Exchange instance
 * 
 * 获取交易所实例
 * @param exchangeId 交易所ID
 * @returns 交易所实例
 */
/**
 * Get proxy configuration from environment
 * @returns Proxy configuration or null if proxy is disabled
 */
export function getProxyConfig(): { url: string; username?: string; password?: string } | null {
  const useProxy = process.env.USE_PROXY === 'true';
  if (!useProxy) return null;
  
  const url = process.env.PROXY_URL;
  if (!url) {
    log(LogLevel.WARNING, 'USE_PROXY is true but PROXY_URL is not set');
    return null;
  }
  
  const username = process.env.PROXY_USERNAME || undefined;
  const password = process.env.PROXY_PASSWORD || undefined;
  
  return { url, username, password };
}

/**
 * Format proxy URL with authentication if provided
 * @param config Proxy configuration
 * @returns Formatted proxy URL
 */
function formatProxyUrl(config: { url: string; username?: string; password?: string }): string {
  if (!config.username || !config.password) return config.url;
  
  // Extract protocol and host from URL
  const match = config.url.match(/^(https?|socks[45]):\/\/([^\/]+)/);
  if (!match) return config.url;
  
  const protocol = match[1];
  const host = match[2];
  return `${protocol}://${config.username}:${config.password}@${host}`;
}

/**
 * Get exchange instance with the default market type
 * @param exchangeId Exchange ID
 * @returns Exchange instance
 */
export function getExchange(exchangeId?: string): ccxt.Exchange {
  return getExchangeWithMarketType(exchangeId);
}

/**
 * Get exchange instance with specific market type
 * @param exchangeId Exchange ID
 * @param marketType Market type (spot, future, etc.)
 * @returns Exchange instance
 */
export function getExchangeWithMarketType(exchangeId?: string, marketType?: MarketType | string): ccxt.Exchange {
  const id = (exchangeId || getDefaultExchange()).toLowerCase();
  const requestedType = (marketType || getDefaultMarketType()).toString().toLowerCase();
  const type = normalizeMarketTypeForExchange(id, requestedType);
  
  // Create a cache key that includes both exchange ID and market type
  const cacheKey = `${id}:${type}`;
  
  if (!exchanges[cacheKey]) {
    if (!SUPPORTED_EXCHANGES.includes(id)) {
      throw new Error(`Exchange '${id}' not supported`);
    }
    
    const apiKey = process.env[`${id.toUpperCase()}_API_KEY`];
    const secret = process.env[`${id.toUpperCase()}_SECRET`];
    const passphrase = process.env[`${id.toUpperCase()}_PASSPHRASE`];
    
    try {
      log(LogLevel.INFO, `Initializing exchange: ${id} (${type})`);
      // Use indexed access to create exchange instance
      const ExchangeClass = ccxt[id as keyof typeof ccxt];
      
      // Configure options with possible proxy
      const options: any = {
        apiKey,
        secret,
        enableRateLimit: true,
        options: {}
      };
      
      // Add passphrase if provided (required for exchanges like KuCoin)
      if (passphrase) {
        options.password = passphrase;
      }
      
      // Configure market type specifics
      if (type !== MarketType.SPOT) {
        options.options.defaultType = mapCcxtDefaultType(id, type);
      }
      
      // Add proxy configuration if enabled
      const proxyConfig = getProxyConfig();
      if (proxyConfig) {
        options.proxy = formatProxyUrl(proxyConfig);
        log(LogLevel.INFO, `Using proxy for ${id}`);
      }
      
      exchanges[cacheKey] = new (ExchangeClass as any)(options);
    } catch (error) {
      log(LogLevel.ERROR, `Failed to initialize exchange ${id} (${type}): ${error instanceof Error ? error.message : String(error)}`);
      throw new Error(`Failed to initialize exchange ${id} (${type}): ${error.message}`);
    }
  }
  
  return exchanges[cacheKey];
}

/**
 * Get exchange instance with specific credentials
 * @param exchangeId Exchange ID
 * @param apiKey API key
 * @param secret API secret
 * @param marketType Market type (spot, future, etc.)
 * @param passphrase Passphrase for authentication (required for some exchanges like KuCoin)
 * @returns Exchange instance
 * 
 * 使用特定凭据获取交易所实例
 * @param exchangeId 交易所ID
 * @param apiKey API密钥
 * @param secret API密钥秘密
 * @param marketType 市场类型（现货、期货等）
 * @param passphrase 认证密码（某些交易所如KuCoin需要）
 * @returns 交易所实例
 */
export function getExchangeWithCredentials(
  exchangeId: string,
  apiKey?: string,
  secret?: string,
  marketType?: MarketType | string,
  passphrase?: string
): ccxt.Exchange {
  try {
    const id = exchangeId.toLowerCase();

    if (!SUPPORTED_EXCHANGES.includes(id)) {
      throw new Error(`Exchange '${exchangeId}' not supported`);
    }
    
    const requestedType = (marketType || getDefaultMarketType()).toString().toLowerCase();
    const type = normalizeMarketTypeForExchange(id, requestedType);

    const hasInlineCredentials = !!(apiKey || secret || passphrase);
    if (hasInlineCredentials && !isInlineCredentialsAllowed()) {
      throw new Error(
        `Inline credentials are disabled. Set ${id.toUpperCase()}_API_KEY / ${id.toUpperCase()}_SECRET (and optional ${id.toUpperCase()}_PASSPHRASE) in environment variables, ` +
        `or set ALLOW_INLINE_CREDENTIALS=true to allow passing credentials as tool parameters.`
      );
    }

    const resolvedApiKey = apiKey || process.env[`${id.toUpperCase()}_API_KEY`];
    const resolvedSecret = secret || process.env[`${id.toUpperCase()}_SECRET`];
    const resolvedPassphrase = passphrase || process.env[`${id.toUpperCase()}_PASSPHRASE`];

    if (!resolvedApiKey || !resolvedSecret) {
      throw new Error(
        `Missing API credentials for ${id}. Set ${id.toUpperCase()}_API_KEY and ${id.toUpperCase()}_SECRET in environment variables ` +
        `(recommended), or set ALLOW_INLINE_CREDENTIALS=true and pass them as tool parameters.`
      );
    }
    
    // Configure options with possible proxy
    const options: any = {
      apiKey: resolvedApiKey,
      secret: resolvedSecret,
      enableRateLimit: true,
      options: {}
    };
    
    // Add passphrase if provided (required for exchanges like KuCoin)
    if (resolvedPassphrase) {
      options.password = resolvedPassphrase;
    }
    
    // Configure market type specifics
    if (type !== MarketType.SPOT) {
      options.options.defaultType = mapCcxtDefaultType(id, type);
    }
    
    // Add proxy configuration if enabled
    const proxyConfig = getProxyConfig();
    if (proxyConfig) {
      options.proxy = formatProxyUrl(proxyConfig);
      log(LogLevel.INFO, `Using proxy for ${id} (${type}) with custom credentials`);
    }
    
    // Use indexed access to create exchange instance
    const ExchangeClass = ccxt[id as keyof typeof ccxt];
    return new (ExchangeClass as any)(options);
  } catch (error) {
    log(LogLevel.ERROR, `Failed to initialize exchange ${exchangeId} with credentials: ${error instanceof Error ? error.message : String(error)}`);
    throw new Error(`Failed to initialize exchange ${exchangeId}: ${error.message}`);
  }
}

/**
 * Validate and format trading pair symbol
 * @param symbol Trading pair symbol
 * @returns Formatted trading pair symbol
 * 
 * 验证和格式化交易对符号
 * @param symbol 交易对符号
 * @returns 格式化的交易对符号
 */
export function validateSymbol(symbol: string): string {
  // Simple validation to ensure symbol includes slash
  // 简单验证，确保符号包含斜杠
  if (!symbol.includes('/')) {
    throw new Error(`Invalid symbol: ${symbol}, should be in format like BTC/USDT`);
  }
  return symbol.toUpperCase();
}

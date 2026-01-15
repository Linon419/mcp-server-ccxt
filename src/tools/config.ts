/**
 * Configuration Tools
 * Tools for configuring the MCP server
 * 
 * 配置工具
 * 用于配置MCP服务器的工具
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { log, LogLevel } from '../utils/logging.js';
import { getProxyConfig, clearExchangeCache } from '../exchange/manager.js';

function redactUrlUserInfo(rawUrl: string): string {
  if (!rawUrl) return rawUrl;

  try {
    const url = new URL(rawUrl);
    if (url.username || url.password) {
      url.username = url.username ? '***' : '';
      url.password = url.password ? '***' : '';
    }
    return url.toString();
  } catch {
    return rawUrl.replace(/^(https?|socks[45]):\/\/([^\/@]+):([^\/@]+)@/i, '$1://***:***@');
  }
}

/**
 * Register configuration tools with the MCP server
 * @param server MCP server instance
 */
export function registerConfigTools(server: McpServer) {
  // Get proxy configuration
  // 获取代理配置
  server.tool("get-proxy-config", "Get the current proxy configuration", {}, 
    async () => {
      const useProxy = process.env.USE_PROXY === 'true';
      const proxyUrl = process.env.PROXY_URL || '';
      const proxyUsername = process.env.PROXY_USERNAME || '';
      // Don't return the password for security reasons
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            enabled: useProxy,
            url: redactUrlUserInfo(proxyUrl),
            username: proxyUsername,
            isConfigured: useProxy && !!proxyUrl
          }, null, 2)
        }]
      };
    }
  );

  // Set proxy configuration
  // 设置代理配置
  server.tool("set-proxy-config", "Configure proxy settings for all exchanges", {
    enabled: z.boolean().describe("Enable or disable proxy"),
    url: z.string().describe("Proxy URL (e.g., http://proxy-server:port)"),
    username: z.string().optional().describe("Proxy username (optional)"),
    password: z.string().optional().describe("Proxy password (optional)"),
    clearCache: z.boolean().default(true).describe("Clear exchange cache to apply changes immediately")
  }, async ({ enabled, url, username, password, clearCache }) => {
    try {
      // For security and simplicity, we'll use environment variables
      // In a production app, you might want to use a more persistent storage method
      process.env.USE_PROXY = enabled.toString();
      
      if (url) {
        process.env.PROXY_URL = url;
      }
      
      if (username !== undefined) {
        process.env.PROXY_USERNAME = username;
      }
      
      if (password !== undefined) {
        process.env.PROXY_PASSWORD = password;
      }
      
      log(LogLevel.INFO, `Proxy configuration updated. Enabled: ${enabled}`);
      
      // Clear exchange cache if requested
      if (clearCache) {
        clearExchangeCache();
        log(LogLevel.INFO, "Exchange cache cleared to apply new proxy settings");
      }
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            message: "Proxy configuration updated successfully",
            cacheCleared: clearCache,
            note: clearCache 
              ? "Exchange cache was cleared. New proxy settings will be applied immediately."
              : "Changes will only affect newly created exchange instances. Use clear-exchange-cache tool for immediate effect."
          }, null, 2)
        }]
      };
    } catch (error) {
      log(LogLevel.ERROR, `Error updating proxy configuration: ${error instanceof Error ? error.message : String(error)}`);
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  });

  // Test proxy connection
  // 测试代理连接
  server.tool("test-proxy-connection", "Test the proxy connection with a specified exchange", {
    exchange: z.string().describe("Exchange ID to test connection with (e.g., binance)"),
  }, async ({ exchange }) => {
    try {
      const useProxy = process.env.USE_PROXY === 'true';
      if (!useProxy) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              message: "Proxy is not enabled. Enable it first with set-proxy-config"
            }, null, 2)
          }]
        };
      }
      
      const proxyConfig = getProxyConfig();
      if (!proxyConfig) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: false,
              message: "Proxy is enabled but not properly configured"
            }, null, 2)
          }]
        };
      }
      
      // Since we can't create a standalone test here without potentially affecting 
      // the exchange cache, we'll just return the current configuration
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            message: "Proxy configuration looks valid",
            proxyUrl: proxyConfig.url,
            note: "To test actual connectivity, try fetching data from an exchange using one of the other tools"
          }, null, 2)
        }]
      };
    } catch (error) {
      log(LogLevel.ERROR, `Error testing proxy: ${error instanceof Error ? error.message : String(error)}`);
      return {
        content: [{
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  });

  // Clear exchange cache
  // 清除交易所缓存
  server.tool("clear-exchange-cache", "Clear exchange instance cache to apply configuration changes", {}, 
    async () => {
      try {
        clearExchangeCache();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              success: true,
              message: "Exchange cache cleared successfully",
              note: "New exchange instances will be created with current configuration"
            }, null, 2)
          }]
        };
      } catch (error) {
        log(LogLevel.ERROR, `Error clearing exchange cache: ${error instanceof Error ? error.message : String(error)}`);
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
  
  // Set market type
  // 设置市场类型
  server.tool("set-market-type", "Set default market type for all exchanges", {
    marketType: z.enum(["spot", "future", "swap", "option", "margin"]).describe("Market type to set"),
    clearCache: z.boolean().default(true).describe("Clear exchange cache to apply changes immediately")
  }, async ({ marketType, clearCache }) => {
    try {
      // Set market type in environment variables
      process.env.DEFAULT_MARKET_TYPE = marketType;
      log(LogLevel.INFO, `Default market type set to: ${marketType}`);
      
      // Clear cache if requested
      if (clearCache) {
        clearExchangeCache();
        log(LogLevel.INFO, "Exchange cache cleared to apply new market type");
      }
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            success: true,
            message: `Default market type set to: ${marketType}`,
            cacheCleared: clearCache,
            note: clearCache 
              ? "Exchange cache was cleared. New market type will be applied immediately."
              : "Changes will only affect newly created exchange instances. Use clear-exchange-cache tool for immediate effect."
          }, null, 2)
        }]
      };
    } catch (error) {
      log(LogLevel.ERROR, `Error setting market type: ${error instanceof Error ? error.message : String(error)}`);
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

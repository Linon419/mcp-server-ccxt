/**
 * Tools Registry
 * Manages the registration of all API tools with the MCP server
 * 
 * 工具注册表
 * 管理所有API工具在MCP服务器上的注册
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerPublicTools } from './public.js';
import { registerPrivateTools } from './private.js';
import { registerConfigTools } from './config.js';
import { registerOnchainTools } from './onchain.js';
import { registerTelegramTools } from './telegram.js';
import { registerOrderBookTools } from './orderbook.js';
import { registerDivergenceTools } from './divergence.js';
import { log, LogLevel } from '../utils/logging.js';

/**
 * Register all tools with the MCP server
 * @param server MCP server instance
 * 
 * 向MCP服务器注册所有工具
 * @param server MCP服务器实例
 */
export function registerAllTools(server: McpServer) {
  try {
    // Register public API tools
    registerPublicTools(server);
    log(LogLevel.INFO, "Public API tools registered successfully");
    
    // Register private API tools
    registerPrivateTools(server);
    log(LogLevel.INFO, "Private API tools registered successfully");
    
    // Register configuration tools
    registerConfigTools(server);
    log(LogLevel.INFO, "Configuration tools registered successfully");

    // Register on-chain tools
    registerOnchainTools(server);
    log(LogLevel.INFO, "On-chain tools registered successfully");

    // Register notification tools
    registerTelegramTools(server);
    log(LogLevel.INFO, "Telegram tools registered successfully");

    // Register orderbook wall/OFI tools (bundled Python)
    registerOrderBookTools(server);
    log(LogLevel.INFO, "OrderBook tools registered successfully");

    // Register divergence detection tools
    registerDivergenceTools(server);
    log(LogLevel.INFO, "Divergence tools registered successfully");
  } catch (error) {
    log(LogLevel.ERROR, `Error registering tools: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

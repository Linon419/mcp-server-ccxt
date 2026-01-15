/**
 * On-chain Tools
 * Tools that execute local on-chain analysis helpers.
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { log, LogLevel } from '../utils/logging.js';
import { getCachedData } from '../utils/cache.js';

const execFileAsync = promisify(execFile);

function getBundledBscAnalyzerPath(): string {
  return fileURLToPath(new URL('../../assets/onchain/bsc-chain-analysis/mcp_volume_analyze.py', import.meta.url));
}

function getPythonCommand(): string {
  return process.env.PYTHON_BIN || 'python';
}

function isHexAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

function isValidHttpUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function registerOnchainTools(server: McpServer) {
  server.tool('bsc-analyzer-healthcheck', 'Check local Python/web3 availability and optional RPC connectivity', {
    rpcUrl: z.string().optional().describe('Optional BSC RPC URL to test connectivity (http/https)'),
    timeoutMs: z.number().int().positive().optional().default(30000).describe('Max runtime in ms (default: 30000)')
  }, async ({ rpcUrl, timeoutMs }) => {
    if (rpcUrl && !isValidHttpUrl(rpcUrl)) {
      return {
        content: [{ type: 'text', text: `Error: invalid rpcUrl (must be http/https): ${rpcUrl}` }],
        isError: true
      };
    }

    const safeTimeoutMs = Math.min(Math.max(1000, timeoutMs), 120000);

    try {
      const python = getPythonCommand();
      const codeParts = [
        'import json',
        'import sys',
        'out={"python":sys.version.split()[0]}',
        'try:',
        ' import web3',
        ' out["web3"]="ok"',
        'except Exception as e:',
        ' out["web3"]="error"; out["web3Error"]=str(e)',
        'try:',
        ' import requests',
        ' out["requests"]="ok"',
        'except Exception as e:',
        ' out["requests"]="error"; out["requestsError"]=str(e)',
      ];

      if (rpcUrl) {
        codeParts.push(
          'try:',
          ' from web3 import Web3',
          ` w3=Web3(Web3.HTTPProvider(${JSON.stringify(rpcUrl)}))`,
          ' out["rpcConnected"]=bool(w3.is_connected())',
          ' out["rpcUrl"]=' + JSON.stringify(rpcUrl),
          'except Exception as e:',
          ' out["rpcConnected"]=False; out["rpcError"]=str(e); out["rpcUrl"]=' + JSON.stringify(rpcUrl),
        );
      }

      codeParts.push('print(json.dumps(out, ensure_ascii=False, indent=2))');

      const { stdout, stderr } = await execFileAsync(python, ['-c', codeParts.join('\n')], {
        windowsHide: true,
        timeout: safeTimeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8'
        }
      });

      const combinedErr = (stderr || '').trim();
      if (combinedErr) {
        log(LogLevel.WARNING, `bsc-analyzer-healthcheck stderr: ${combinedErr}`);
      }

      return { content: [{ type: 'text', text: (stdout || '').trim() || '{}' }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(LogLevel.ERROR, `bsc-analyzer-healthcheck failed: ${message}`);
      return {
        content: [{
          type: 'text',
          text: `Error: ${message}\nYou can set PYTHON_BIN to choose the python executable.`
        }],
        isError: true
      };
    }
  });

  server.tool('bsc-volume-analyze', 'Analyze BSC token buy/sell volume vs WBNB (PancakeSwap V2 Swap logs)', {
    tokenAddress: z.string().describe('BSC token contract address (0x...)'),
    blocksBack: z.number().int().positive().optional().default(1000).describe('How many blocks back to analyze (default: 1000)'),
    rpcUrl: z.string().optional().describe('BSC RPC URL (optional, default: https://binance.llamarpc.com)'),
    chunkSize: z.number().int().positive().optional().default(100).describe('Log query chunk size in blocks (default: 100)'),
    timeoutMs: z.number().int().positive().optional().default(120000).describe('Max runtime in ms (default: 120000)'),
    cacheTtlMs: z.number().int().positive().optional().default(30000).describe('Cache TTL in ms (default: 30000)')
  }, async ({ tokenAddress, blocksBack, rpcUrl, chunkSize, timeoutMs, cacheTtlMs }) => {
    if (!isHexAddress(tokenAddress)) {
      return {
        content: [{ type: 'text', text: `Error: invalid tokenAddress: ${tokenAddress}` }],
        isError: true
      };
    }

    if (rpcUrl && !isValidHttpUrl(rpcUrl)) {
      return {
        content: [{ type: 'text', text: `Error: invalid rpcUrl (must be http/https): ${rpcUrl}` }],
        isError: true
      };
    }

    const safeBlocksBack = Math.min(Math.max(1, blocksBack), 20000);
    const safeChunkSize = Math.min(Math.max(10, chunkSize), 2000);
    const safeTimeoutMs = Math.min(Math.max(1000, timeoutMs), 300000);
    const safeCacheTtlMs = Math.min(Math.max(1000, cacheTtlMs), 300000);

    try {
      const cacheKey = `bsc_volume:${tokenAddress}:${safeBlocksBack}:${rpcUrl || 'default'}:${safeChunkSize}`;

      const output = await getCachedData(cacheKey, async () => {
        const python = getPythonCommand();
        const scriptPath = getBundledBscAnalyzerPath();

        log(LogLevel.INFO, `Running BSC volume analyzer: token=${tokenAddress}, blocksBack=${safeBlocksBack}`);

        const args = [
          scriptPath,
          '--token', tokenAddress,
          '--blocks-back', String(safeBlocksBack),
          '--chunk-size', String(safeChunkSize)
        ];

        if (rpcUrl) {
          args.push('--rpc', rpcUrl);
        }

        const { stdout, stderr } = await execFileAsync(python, args, {
          windowsHide: true,
          timeout: safeTimeoutMs,
          maxBuffer: 5 * 1024 * 1024,
          env: {
            ...process.env,
            PYTHONIOENCODING: 'utf-8'
          }
        });

        const combinedErr = (stderr || '').trim();
        if (combinedErr) {
          log(LogLevel.WARNING, `bsc-volume-analyze stderr: ${combinedErr}`);
        }

        return (stdout || '').trim() || '{}';
      }, safeCacheTtlMs);

      return {
        content: [{ type: 'text', text: output }]
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log(LogLevel.ERROR, `bsc-volume-analyze failed: ${message}`);
      return {
        content: [{
          type: 'text',
          text:
            `Error: ${message}\n` +
            `Requirements: Python 3 + pip packages (web3). You can set PYTHON_BIN to choose the python executable. ` +
            `To use a dedicated RPC (e.g. GetBlock), set BSC_RPC_URL or pass rpcUrl to this tool.`
        }],
        isError: true
      };
    }
  });
}

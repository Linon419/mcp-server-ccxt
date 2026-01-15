/**
 * OrderBook (Wall Map + OFI) Tools
 * Integrates the bundled Python orderbook collector/query helpers.
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as os from 'node:os';
import * as path from 'node:path';
import { log, LogLevel } from '../utils/logging.js';

const execFileAsync = promisify(execFile);

type CollectorState = {
  proc: ReturnType<typeof spawn> | null;
  startedAt: number | null;
  lastStdout: string[];
  lastStderr: string[];
};

const collectorState: CollectorState = {
  proc: null,
  startedAt: null,
  lastStdout: [],
  lastStderr: [],
};

function ringPush(buf: string[], line: string, max = 200) {
  buf.push(line);
  if (buf.length > max) buf.splice(0, buf.length - max);
}

function getBundledQueryPath(): string {
  return fileURLToPath(new URL('../../assets/orderbook/query.py', import.meta.url));
}

function getBundledDaemonPath(): string {
  return fileURLToPath(new URL('../../assets/orderbook/run_daemon.py', import.meta.url));
}

function getPythonCommand(): string {
  return process.env.PYTHON_BIN || 'python';
}

function getDefaultDataDir(): string {
  return process.env.ORDERBOOK_DATA_DIR || path.join(os.homedir(), '.mcp-server-ccxt', 'orderbook');
}

async function runQuery(
  cmd: string,
  args: string[],
  opts: { dataDir?: string; timeoutMs?: number } = {},
): Promise<any> {
  const python = getPythonCommand();
  const scriptPath = getBundledQueryPath();
  const dataDir = opts.dataDir || getDefaultDataDir();
  const timeoutMs = Math.min(Math.max(1000, opts.timeoutMs ?? 30000), 120000);

  const { stdout } = await execFileAsync(
    python,
    [scriptPath, '--data-dir', dataDir, cmd, ...args],
    { timeout: timeoutMs, env: { ...process.env, ORDERBOOK_DATA_DIR: dataDir } },
  );

  const raw = String(stdout ?? '').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function isCollectorRunning(): boolean {
  return Boolean(collectorState.proc && collectorState.proc.exitCode === null);
}

export function registerOrderBookTools(server: McpServer) {
  server.tool(
    'orderbook-healthcheck',
    'Check local Python + aiohttp availability for the bundled orderbook collector',
    {
      dataDir: z.string().optional().describe('Optional data directory override (default: ~/.mcp-server-ccxt/orderbook)'),
      timeoutMs: z.number().int().positive().optional().default(30000).describe('Max runtime in ms (default: 30000)'),
    },
    async ({ dataDir, timeoutMs }) => {
      try {
        const result = await runQuery('healthcheck', [], { dataDir, timeoutMs });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );

  server.tool(
    'orderbook-start-collector',
    'Start the bundled Python orderbook collector (writes latest.json + orderbook.db)',
    {
      dataDir: z.string().optional().describe('Data directory (default: ~/.mcp-server-ccxt/orderbook)'),
      symbols: z.array(z.string()).optional().default(['BTCUSDT']).describe('Symbols like BTCUSDT, ETHUSDT'),
      thresholdsUsd: z
        .record(z.number())
        .optional()
        .describe('Optional per-symbol wall thresholds in USD, e.g. {"BTCUSDT":300000}'),
      writeIntervalSec: z.number().positive().optional().default(2).describe('latest.json write interval (default: 2s)'),
      ofiIntervalSec: z.number().positive().optional().default(30).describe('OFI history persist interval (default: 30s)'),
      wallSnapshotIntervalSec: z
        .number()
        .positive()
        .optional()
        .default(300)
        .describe('Wall snapshot persist interval (default: 300s)'),
    },
    async ({ dataDir, symbols, thresholdsUsd, writeIntervalSec, ofiIntervalSec, wallSnapshotIntervalSec }) => {
      try {
        if (isCollectorRunning()) {
          return { content: [{ type: 'text', text: 'Error: collector is already running.' }], isError: true };
        }

        const safeSymbols = symbols
          .map((s) => s.trim().toUpperCase())
          .filter(Boolean)
          .slice(0, 20);
        if (safeSymbols.length === 0) {
          return { content: [{ type: 'text', text: 'Error: symbols must not be empty.' }], isError: true };
        }

        const scriptPath = getBundledDaemonPath();
        const python = getPythonCommand();
        const finalDataDir = dataDir || getDefaultDataDir();
        const thresholdsJson = thresholdsUsd ? JSON.stringify(thresholdsUsd) : '';

        collectorState.lastStdout = [];
        collectorState.lastStderr = [];

        const proc = spawn(
          python,
          [
            scriptPath,
            '--data-dir',
            finalDataDir,
            '--symbols',
            safeSymbols.join(','),
            '--thresholds-json',
            thresholdsJson,
            '--write-interval-sec',
            String(writeIntervalSec),
            '--ofi-interval-sec',
            String(ofiIntervalSec),
            '--wall-snapshot-interval-sec',
            String(wallSnapshotIntervalSec),
          ],
          { env: { ...process.env, ORDERBOOK_DATA_DIR: finalDataDir } },
        );

        collectorState.proc = proc;
        collectorState.startedAt = Date.now();

        proc.stdout?.setEncoding('utf8');
        proc.stderr?.setEncoding('utf8');
        proc.stdout?.on('data', (chunk: string) => {
          for (const line of chunk.split(/\r?\n/)) {
            if (line.trim()) ringPush(collectorState.lastStdout, line.trim());
          }
        });
        proc.stderr?.on('data', (chunk: string) => {
          for (const line of chunk.split(/\r?\n/)) {
            if (line.trim()) ringPush(collectorState.lastStderr, line.trim());
          }
        });

        proc.on('exit', (code, signal) => {
          log(LogLevel.WARNING, `OrderBook collector exited (code=${code}, signal=${signal ?? 'none'})`);
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { status: 'STARTED', pid: proc.pid, dataDir: finalDataDir, symbols: safeSymbols },
                null,
                2,
              ),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );

  server.tool('orderbook-stop-collector', 'Stop the bundled Python orderbook collector', {}, async () => {
    try {
      if (!isCollectorRunning()) {
        collectorState.proc = null;
        collectorState.startedAt = null;
        return { content: [{ type: 'text', text: 'Collector is not running.' }] };
      }

      collectorState.proc?.kill();
      const pid = collectorState.proc?.pid;
      collectorState.proc = null;
      collectorState.startedAt = null;

      return { content: [{ type: 'text', text: JSON.stringify({ status: 'STOPPED', pid }, null, 2) }] };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
    }
  });

  server.tool(
    'orderbook-collector-logs',
    'Get recent stdout/stderr lines from the bundled Python orderbook collector (if started via this server)',
    {
      stream: z.enum(['stdout', 'stderr']).optional().default('stderr').describe('Log stream (default: stderr)'),
      tail: z.number().int().positive().optional().default(50).describe('Max lines to return (default: 50)'),
    },
    async ({ stream, tail }) => {
      const buf = stream === 'stdout' ? collectorState.lastStdout : collectorState.lastStderr;
      const lines = buf.slice(Math.max(0, buf.length - Math.min(Math.max(1, tail), 200)));
      return { content: [{ type: 'text', text: lines.join('\n') || '(no logs captured)' }] };
    },
  );

  server.tool(
    'orderbook-status',
    'Get collector status based on latest.json (and whether a local collector process is running)',
    {
      dataDir: z.string().optional().describe('Optional data directory override'),
      timeoutMs: z.number().int().positive().optional().default(30000).describe('Max runtime in ms (default: 30000)'),
    },
    async ({ dataDir, timeoutMs }) => {
      try {
        const result = await runQuery('status', [], { dataDir, timeoutMs });
        const enriched = {
          ...result,
          process: isCollectorRunning()
            ? { running: true, pid: collectorState.proc?.pid, startedAt: collectorState.startedAt }
            : { running: false },
        };
        return { content: [{ type: 'text', text: JSON.stringify(enriched, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );

  server.tool(
    'orderbook-wall-map',
    'Get wall map (support/resistance walls) for a symbol/timeframe from the local collector output',
    {
      symbol: z.string().optional().default('BTCUSDT').describe('Symbol like BTCUSDT'),
      timeframe: z.enum(['4h', '1h', '15min']).optional().default('1h').describe('Timeframe (default: 1h)'),
      dataDir: z.string().optional().describe('Optional data directory override'),
      timeoutMs: z.number().int().positive().optional().default(30000).describe('Max runtime in ms (default: 30000)'),
    },
    async ({ symbol, timeframe, dataDir, timeoutMs }) => {
      try {
        const result = await runQuery('wall-map', ['--symbol', symbol, '--timeframe', timeframe], { dataDir, timeoutMs });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );

  server.tool(
    'orderbook-ofi',
    'Get OFI (Order Flow Imbalance) signal for a symbol from the local collector output',
    {
      symbol: z.string().optional().default('BTCUSDT').describe('Symbol like BTCUSDT'),
      dataDir: z.string().optional().describe('Optional data directory override'),
      timeoutMs: z.number().int().positive().optional().default(30000).describe('Max runtime in ms (default: 30000)'),
    },
    async ({ symbol, dataDir, timeoutMs }) => {
      try {
        const result = await runQuery('ofi', ['--symbol', symbol], { dataDir, timeoutMs });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );

  server.tool(
    'orderbook-orderbook',
    'Get current best bid/ask/spread for a symbol from the local collector output',
    {
      symbol: z.string().optional().default('BTCUSDT').describe('Symbol like BTCUSDT'),
      dataDir: z.string().optional().describe('Optional data directory override'),
      timeoutMs: z.number().int().positive().optional().default(30000).describe('Max runtime in ms (default: 30000)'),
    },
    async ({ symbol, dataDir, timeoutMs }) => {
      try {
        const result = await runQuery('orderbook', ['--symbol', symbol], { dataDir, timeoutMs });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );

  server.tool(
    'orderbook-real-walls',
    'Get validated real walls (strong 4h + moderate 1h) from the local collector output',
    {
      symbol: z.string().optional().default('BTCUSDT').describe('Symbol like BTCUSDT'),
      side: z.enum(['bid', 'ask', 'both']).optional().default('both').describe('bid/ask/both (default: both)'),
      dataDir: z.string().optional().describe('Optional data directory override'),
      timeoutMs: z.number().int().positive().optional().default(30000).describe('Max runtime in ms (default: 30000)'),
    },
    async ({ symbol, side, dataDir, timeoutMs }) => {
      try {
        const result = await runQuery('real-walls', ['--symbol', symbol, '--side', side], { dataDir, timeoutMs });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );

  server.tool(
    'orderbook-check-signal',
    'Check a simple trade signal by combining near-wall proximity + OFI',
    {
      symbol: z.string().optional().default('BTCUSDT').describe('Symbol like BTCUSDT'),
      dataDir: z.string().optional().describe('Optional data directory override'),
      timeoutMs: z.number().int().positive().optional().default(30000).describe('Max runtime in ms (default: 30000)'),
    },
    async ({ symbol, dataDir, timeoutMs }) => {
      try {
        const result = await runQuery('check-signal', ['--symbol', symbol], { dataDir, timeoutMs });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );

  server.tool(
    'orderbook-history',
    'Get basic history stats from orderbook.db (requires the collector to be running previously)',
    {
      symbol: z.string().optional().default('BTCUSDT').describe('Symbol like BTCUSDT'),
      hours: z.number().int().positive().optional().default(24).describe('Lookback hours (default: 24)'),
      dataDir: z.string().optional().describe('Optional data directory override'),
      timeoutMs: z.number().int().positive().optional().default(30000).describe('Max runtime in ms (default: 30000)'),
    },
    async ({ symbol, hours, dataDir, timeoutMs }) => {
      try {
        const result = await runQuery('history', ['--symbol', symbol, '--hours', String(hours)], { dataDir, timeoutMs });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
      }
    },
  );
}

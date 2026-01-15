/**
 * Telegram Notification Tools
 * Manual notification helpers for workflows (e.g., after automated trades).
 */
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import https from 'node:https';
import { URL } from 'node:url';
import { log, LogLevel } from '../utils/logging.js';

type TelegramConfig = {
  botToken: string;
  chatId: string;
  apiBase: string;
};

function getTelegramConfig(): TelegramConfig | null {
  const botToken = process.env.TG_BOT_TOKEN || '';
  const chatId = process.env.TG_CHAT_ID || '';
  const apiBase = process.env.TG_API_BASE || 'https://api.telegram.org';

  if (!botToken || !chatId) return null;
  return { botToken, chatId, apiBase };
}

function maskToken(token: string): string {
  if (!token) return '';
  if (token.length <= 10) return '***';
  return `${token.slice(0, 6)}***${token.slice(-4)}`;
}

async function telegramSendMessage(config: TelegramConfig, payload: Record<string, string | number | boolean>): Promise<any> {
  const url = new URL(`/bot${config.botToken}/sendMessage`, config.apiBase);
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(payload)) {
    body.set(key, String(value));
  }
  const data = body.toString();

  return await new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(data).toString(),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {
            // ignore
          }

          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            return resolve(json ?? { ok: true, raw: text });
          }

          const status = res.statusCode ?? 0;
          const message = `Telegram API error (HTTP ${status}): ${json?.description || text || 'unknown error'}`;
          return reject(new Error(message));
        });
      }
    );

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

export function registerTelegramTools(server: McpServer) {
  server.tool('tg-notify', 'Send a Telegram message (manual trigger, plain text)', {
    text: z.string().min(1).describe('Message text (plain text)'),
    chatId: z.string().optional().describe('Override chat_id (optional; default from TG_CHAT_ID)'),
    disablePreview: z.boolean().optional().default(true).describe('Disable web page preview (default: true)'),
    silent: z.boolean().optional().default(false).describe('Disable notification sound (default: false)')
  }, async ({ text, chatId, disablePreview, silent }) => {
    const config = getTelegramConfig();
    if (!config) {
      return {
        content: [{
          type: 'text',
          text: 'Error: Telegram is not configured. Set TG_BOT_TOKEN and TG_CHAT_ID in environment variables.'
        }],
        isError: true
      };
    }

    const effectiveChatId = (chatId || config.chatId).trim();
    if (!effectiveChatId) {
      return {
        content: [{ type: 'text', text: 'Error: chatId is empty.' }],
        isError: true
      };
    }

    try {
      log(LogLevel.INFO, `Sending Telegram message to chatId=${effectiveChatId} via ${config.apiBase} (token=${maskToken(config.botToken)})`);
      const resp = await telegramSendMessage(config, {
        chat_id: effectiveChatId,
        text,
        disable_web_page_preview: disablePreview,
        disable_notification: silent
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ ok: true, result: resp?.result ?? resp }, null, 2)
        }]
      };
    } catch (error) {
      log(LogLevel.ERROR, `tg-notify failed: ${error instanceof Error ? error.message : String(error)}`);
      return {
        content: [{
          type: 'text',
          text: `Error: ${error instanceof Error ? error.message : String(error)}`
        }],
        isError: true
      };
    }
  });
}


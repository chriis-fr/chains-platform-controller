import type { TelegramConfig } from './config.js';

/**
 * Every Telegram Bot API call goes through here.
 *
 * The VPS network blocks api.telegram.org (both v4 and v6 time out, other sites load), so with
 * `telegram.relayUrl` set in apps.json the call goes to a relay instead — chains-erp.com/api/tg —
 * which forwards it. The token travels in a header, never in the URL, so it stays out of access logs.
 * Without relayUrl the bot talks to Telegram directly, as before.
 */
export async function tgCall(tg: TelegramConfig, method: string, body: unknown, timeoutMs = 20_000): Promise<any> {
  const relay = tg.relayUrl?.replace(/\/+$/, '');
  const url = relay ? `${relay}/${method}` : `https://api.telegram.org/bot${tg.botToken}/${method}`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (relay) headers['x-telegram-bot-token'] = tg.botToken;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.json();
}

/** How long getUpdates may long-poll: the relay runs on a serverless function, so keep it shorter. */
export const pollSeconds = (tg: TelegramConfig): number => (tg.relayUrl ? 25 : 50);

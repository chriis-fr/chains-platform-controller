import type { TelegramConfig } from './config.js';

/**
 * Every Telegram Bot API call goes through here.
 *
 * The server calls Telegram directly. When that fails, for example while Kenyan networks block
 * Telegram during national exams, and `telegram.relayUrl` is set in apps.json, the call goes
 * through the relay instead (app.chains-erp.com/api/tg), which forwards it. Direct is retried every
 * few minutes, so the controller goes back to calling Telegram itself as soon as the block lifts,
 * with no config change. The token travels in a header to the relay, never in its URL.
 */
const RECHECK_DIRECT_MS = 5 * 60_000;
let directBlockedUntil = 0;

/** Whether calls are currently going through the relay, for /status. */
export const usingRelay = (): boolean => Date.now() < directBlockedUntil;

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return res.json();
}

export async function tgCall(tg: TelegramConfig, method: string, body: unknown, timeoutMs = 20_000): Promise<any> {
  const relay = tg.relayUrl?.replace(/\/+$/, '');
  const direct = () => post(`https://api.telegram.org/bot${tg.botToken}/${method}`, {}, body, relay ? Math.min(timeoutMs, 8000) : timeoutMs);
  const viaRelay = () => post(`${relay}/${method}`, { 'x-telegram-bot-token': tg.botToken }, body, timeoutMs);

  if (!relay) return direct();
  if (!usingRelay()) {
    try {
      return await direct();
    } catch (e) {
      // Unreachable (blocked or down): use the relay for a while, then try direct again.
      if (directBlockedUntil === 0 || !usingRelay()) console.error(`telegram: direct call failed (${(e as Error).name}); using relay ${relay}`);
      directBlockedUntil = Date.now() + RECHECK_DIRECT_MS;
    }
  }
  return viaRelay();
}

/** How long getUpdates may long-poll. Polling is the fallback when no webhook is set; the relay refuses it. */
export const pollSeconds = (_tg: TelegramConfig): number => 50;

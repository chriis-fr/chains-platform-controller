import { loadConfig } from './config.js';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function notify(text: string, buttons?: { text: string; data: string }[][]): Promise<void> {
  const tg = loadConfig().telegram;
  if (!tg) return;
  try {
    await fetch(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: tg.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true,
        reply_markup: buttons
          ? { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) }
          : undefined,
      }),
    });
  } catch (e) {
    console.error('telegram notify failed:', (e as Error).message);
  }
}

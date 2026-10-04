import { loadConfig, appKind, type TelegramConfig, type AppConfig } from './config.js';
import { pm2Health, pm2DiskCommit, pm2Uptime, pm2Errors, dockerErrors } from './pm2app.js';
import { loadState } from './deployer.js';
import { runDeploy, runRollback } from './orchestrator.js';
import { running } from './state.js';
import { escapeHtml } from './notify.js';

const api = (tg: TelegramConfig, method: string, body: unknown) =>
  fetch(`https://api.telegram.org/bot${tg.botToken}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }).then((r) => r.json()).catch(() => null);

type Keyboard = { text: string; callback_data: string }[][];

const edit = (tg: TelegramConfig, chatId: number, messageId: number, text: string, keyboard?: Keyboard) =>
  api(tg, 'editMessageText', {
    chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
  });

function fmtTime(iso: string): string {
  return new Date(iso).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

// Renders as a numbered list of app blocks — one app or ten, same layout.
//
// Async now, because a pm2 app is asked what it is SERVING rather than read from a state
// file the deployer wrote. Those two disagreed for thirteen days on this box: the repo was
// pulled, pm2 was never restarted, and the API served three-week-old code while every file
// on disk was current. A state file would have called that deploy fine. /health does not,
// and the DRIFT line below exists to make that exact failure impossible to miss again.
async function pm2Block(a: AppConfig, i: number): Promise<string> {
  const [h, disk, up] = await Promise.all([pm2Health(a), pm2DiskCommit(a), pm2Uptime(a)]);
  const live = running.has(a.name) ? '⏳ deploying now' : h.ok ? '✅ live' : '🔴 DOWN';
  const drift = h.commit && disk && h.commit !== disk;
  return [
    `${i + 1}. <b>${a.name}</b> <i>(pm2)</i>`,
    `   ├ ${live}${h.commit ? ` — <code>${h.commit}</code>` : ''}${up ? ` · up ${up}` : ''}`,
    drift ? `   ├ ⚠️ DRIFT — disk is <code>${disk}</code>, serving <code>${h.commit}</code>. Deploy to pick it up.` : null,
    `   └ https://${a.domain}`,
  ].filter(Boolean).join('\n');
}

function dockerBlock(a: AppConfig, i: number): string {
  const s = loadState(a.name);
  const state = running.has(a.name) ? '⏳ deploying now' : s ? '✅ live' : '➖ never deployed';
  if (!s) {
    return [`${i + 1}. <b>${a.name}</b>`, `   ├ ${state}`, `   └ ${a.repo}#${a.branch}`].join('\n');
  }
  return [
    `${i + 1}. <b>${a.name}</b>`,
    `   ├ ${state} — <code>${s.sha.slice(0, 7)}</code> on ${s.active}`,
    `   ├ deployed ${fmtTime(s.at)}`,
    s.prevSha ? `   ├ rollback → <code>${s.prevSha.slice(0, 7)}</code>` : null,
    `   └ https://${a.domain}`,
  ].filter(Boolean).join('\n');
}

async function statusText(): Promise<string> {
  const apps = loadConfig().apps;
  const header = `📦 <b>Chains Platform</b> — ${apps.length} app${apps.length === 1 ? '' : 's'}`;
  const blocks = await Promise.all(
    apps.map((a, i) => (appKind(a) === 'pm2' ? pm2Block(a, i) : Promise.resolve(dockerBlock(a, i)))),
  );
  return `${header}\n\n${blocks.join('\n\n')}`;
}

/**
 * /errors — what is actually going wrong, per app.
 *
 * The API logs one JSON line per request, so a plain log tail is almost entirely 200s and
 * tells you nothing. This keeps only lines that are a problem, collapses repeats, and
 * shows the newest first: a single fault repeating four hundred times is one entry here,
 * not four hundred.
 */
async function errorsText(): Promise<string> {
  const apps = loadConfig().apps;
  const sections = await Promise.all(apps.map(async (a) => {
    const lines = appKind(a) === 'pm2'
      ? await pm2Errors(a)
      : await dockerErrors(`chains-${a.name}`);
    if (lines.length === 0) return `<b>${a.name}</b>\n   ✅ nothing in the recent log`;
    return `<b>${a.name}</b>\n<pre>${escapeHtml(lines.join('\n'))}</pre>`;
  }));
  return `🩺 <b>Recent errors</b>\n\n${sections.join('\n\n')}`;
}

function statusKeyboard(): Keyboard {
  const rows: Keyboard = loadConfig().apps.map((a) => ([
    { text: `🚀 Deploy ${a.name}`, callback_data: `ask:deploy:${a.name}` },
    { text: `↩️ Rollback ${a.name}`, callback_data: `ask:rollback:${a.name}` },
  ]));
  rows.push([
    { text: '🩺 Errors', callback_data: 'errors' },
    { text: '🔄 Refresh', callback_data: 'refresh' },
  ]);
  return rows;
}

const HELP =
  '<b>Chains Platform</b>\n/status — apps, live commits, action buttons\n/errors — recent problems from every app log\n/help — this message\n\nDeploys also trigger automatically on git push.';

async function handleUpdate(tg: TelegramConfig, u: any): Promise<void> {
  const msg = u.message;
  if (msg) {
    if (msg.chat?.id !== tg.chatId) return;
    const text = (msg.text ?? '').trim();
    if (text === '/start' || text === '/help') {
      await api(tg, 'sendMessage', { chat_id: tg.chatId, text: HELP, parse_mode: 'HTML' });
    } else if (text === '/errors') {
      await api(tg, 'sendMessage', {
        chat_id: tg.chatId, text: await errorsText(), parse_mode: 'HTML', disable_web_page_preview: true,
      });
    } else if (text === '/status') {
      await api(tg, 'sendMessage', {
        chat_id: tg.chatId, text: await statusText(), parse_mode: 'HTML', disable_web_page_preview: true,
        reply_markup: { inline_keyboard: statusKeyboard() },
      });
    }
    return;
  }

  const q = u.callback_query;
  if (!q) return;
  const chatId = q.message?.chat?.id;
  const messageId = q.message?.message_id;
  if (chatId !== tg.chatId || !messageId) {
    await api(tg, 'answerCallbackQuery', { callback_query_id: q.id });
    return;
  }
  const data: string = q.data ?? '';
  const ack = (text?: string) => api(tg, 'answerCallbackQuery', { callback_query_id: q.id, text });

  if (data === 'errors') {
    await ack('Reading logs…');
    await api(tg, 'sendMessage', {
      chat_id: tg.chatId, text: await errorsText(), parse_mode: 'HTML', disable_web_page_preview: true,
    });

  } else if (data === 'refresh') {
    await ack('Refreshed');
    await edit(tg, chatId, messageId, await statusText(), statusKeyboard());

  } else if (data.startsWith('ask:')) {
    const [, action, name] = data.split(':');
    if (running.has(name)) {
      await ack(`${name} is already deploying`);
      await edit(tg, chatId, messageId, await statusText(), statusKeyboard());
      return;
    }
    await ack();
    const verb = action === 'deploy' ? '🚀 Deploy' : '↩️ Roll back';
    await edit(tg, chatId, messageId, `${verb} <b>${name}</b> — are you sure?`, [[
      { text: '✅ Yes, go', callback_data: `go:${action}:${name}` },
      { text: '❌ Cancel', callback_data: 'refresh' },
    ]]);

  } else if (data.startsWith('go:')) {
    const [, action, name] = data.split(':');
    if (running.has(name)) {
      await ack(`${name} is already deploying`);
      await edit(tg, chatId, messageId, await statusText(), statusKeyboard());
      return;
    }
    await ack(`${action} triggered`);
    const verb = action === 'deploy' ? '🚀 Deploying' : '↩️ Rolling back';
    await edit(tg, chatId, messageId, `${verb} <b>${name}</b>… progress updates incoming.`);
    if (action === 'deploy') void runDeploy(name);
    if (action === 'rollback') void runRollback(name);
  }
}

export function startTelegram(): void {
  const tg = loadConfig().telegram;
  if (!tg) { console.log('telegram: not configured, skipping'); return; }
  console.log('telegram: polling started');
  void (async () => {
    let offset = 0;
    for (;;) {
      try {
        const res = await fetch(`https://api.telegram.org/bot${tg.botToken}/getUpdates?timeout=50&offset=${offset}`);
        const data: any = await res.json();
        for (const u of data?.result ?? []) {
          offset = u.update_id + 1;
          await handleUpdate(tg, u).catch((e) => console.error('telegram handler:', (e as Error).message));
        }
      } catch {
        await new Promise((r) => setTimeout(r, 3000));
      }
    }
  })();
}

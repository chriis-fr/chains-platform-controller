/**
 * Telegram relay for the Chains infra bot, as a Cloudflare Worker.
 *
 * Only needed while the server's network blocks api.telegram.org (Kenyan networks block
 * Telegram during the national exams each November). The controller calls Telegram directly
 * first and uses this only when that fails, so once the block lifts this sits idle.
 *
 *   POST https://<worker>/<method>   header x-telegram-bot-token: <token>   body: JSON
 *
 * Deploy: Cloudflare dashboard → Workers & Pages → Create → Worker → paste this file → Deploy.
 * Then set telegram.relayUrl in apps.json to the worker's URL.
 *
 * Only our own bot is relayed: the token must start with an allowed bot id (a bot's numeric id
 * is public; the secret is the part after the colon), so this is not an open Telegram proxy.
 * getUpdates is refused: the controller receives updates by webhook.
 */
const ALLOWED_BOT_IDS = ['8670911721'];
const METHOD_RE = /^[A-Za-z]{3,40}$/;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(request) {
    if (request.method !== 'POST') return json({ ok: false, description: 'POST only' }, 405);

    const method = new URL(request.url).pathname.split('/').filter(Boolean).pop() ?? '';
    const token = request.headers.get('x-telegram-bot-token') ?? '';
    const botId = token.split(':')[0];

    if (!METHOD_RE.test(method)) return json({ ok: false, description: 'bad method' }, 400);
    if (method === 'getUpdates') return json({ ok: false, description: 'getUpdates is not relayed: use the webhook' }, 400);
    if (!token.includes(':') || !ALLOWED_BOT_IDS.includes(botId)) return json({ ok: false, description: 'bot not allowed' }, 403);

    const body = await request.text();
    if (body.length > 1_000_000) return json({ ok: false, description: 'body too large' }, 413);

    try {
      const upstream = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body || '{}',
        signal: AbortSignal.timeout(15000),
      });
      return new Response(await upstream.text(), {
        status: upstream.status,
        headers: { 'content-type': 'application/json' },
      });
    } catch (e) {
      return json({ ok: false, description: `relay could not reach Telegram: ${e.name}` }, 502);
    }
  },
};

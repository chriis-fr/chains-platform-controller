import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { loadConfig, findAppByRepo } from './config.js';
import { runDeploy } from './orchestrator.js';
import { running } from './state.js';
import { startTelegram, handleWebhookUpdate } from './telegram.js';
import { startMonitor } from './monitor.js';
import { notify } from './notify.js';
import { verifyFleetopsSignature, formatFleetopsEvent, DEFAULT_EVENTS } from './fleetops.js';

const app = express();
app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));

function verifySignature(secret: string, raw: Buffer, sig?: string): boolean {
  if (!sig) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

app.get('/healthz', (_req, res) => { res.json({ ok: true, running: [...running] }); });

// Telegram updates (button taps, commands), when telegram.webhookUrl is set in apps.json.
// Telegram signs each call with the secret given to setWebhook.
app.post('/telegram/webhook', (req: any, res) => {
  const tg = loadConfig().telegram;
  const got = Buffer.from(String(req.header('x-telegram-bot-api-secret-token') ?? ''));
  const want = Buffer.from(tg?.webhookSecret ?? '');
  if (!tg?.webhookUrl || !want.length || got.length !== want.length || !timingSafeEqual(got, want)) {
    res.status(401).json({ error: 'bad secret' });
    return;
  }
  // Answer at once: Telegram retries a slow webhook, and a deploy takes minutes.
  res.json({ ok: true });
  void handleWebhookUpdate(req.body);
});

app.post('/webhook', (req: any, res) => {
  const cfg = loadConfig();
  if (!verifySignature(cfg.webhookSecret, req.rawBody, req.header('x-hub-signature-256'))) {
    res.status(401).json({ error: 'bad signature' });
    return;
  }
  const event = req.header('x-github-event');
  if (event === 'ping') { res.json({ pong: true }); return; }
  if (event !== 'push') { res.json({ ignored: event }); return; }

  const repo = req.body?.repository?.full_name as string | undefined;
  const ref = req.body?.ref as string | undefined;
  const appCfg = repo ? findAppByRepo(cfg, repo) : undefined;
  if (!appCfg) { res.json({ ignored: repo }); return; }
  if (ref !== `refs/heads/${appCfg.branch}`) { res.json({ ignored: ref }); return; }

  res.json({ deploying: appCfg.name, commit: req.body?.after });
  void runDeploy(appCfg.name);
});

// Chains FleetOps (Fleetbase) webhooks → Telegram. Point a FleetOps webhook endpoint at
// https://deploy.chains-erp.com/fleetops/webhook and put its signing secret in apps.json (fleetops.webhookSecret).
app.post('/fleetops/webhook', (req: any, res) => {
  const f = loadConfig().fleetops;
  if (!f?.webhookSecret) { res.status(503).json({ error: 'fleetops webhook not configured' }); return; }
  if (!verifyFleetopsSignature(req.rawBody ?? Buffer.alloc(0), req.header('x-fleetbase-signature'), f.webhookSecret)) {
    res.status(401).json({ error: 'bad signature' });
    return;
  }
  const event: string = req.body?.event ?? '';
  res.json({ received: event });
  if (!(f.events ?? DEFAULT_EVENTS).includes(event)) return;
  const text = formatFleetopsEvent(req.body, f.consoleUrl);
  if (text) void notify(text);
});

const port = Number(process.env.PORT ?? 9600);
app.listen(port, '127.0.0.1', () => console.log(`chains controller on 127.0.0.1:${port}`));
startTelegram();
startMonitor();

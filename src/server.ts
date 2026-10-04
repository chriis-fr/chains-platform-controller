import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { loadConfig, findAppByRepo } from './config.js';
import { runDeploy } from './orchestrator.js';
import { running } from './state.js';
import { startTelegram } from './telegram.js';
import { startMonitor } from './monitor.js';

const app = express();
app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf; } }));

function verifySignature(secret: string, raw: Buffer, sig?: string): boolean {
  if (!sig) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(sig);
  return a.length === b.length && timingSafeEqual(a, b);
}

app.get('/healthz', (_req, res) => { res.json({ ok: true, running: [...running] }); });

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

const port = Number(process.env.PORT ?? 9600);
app.listen(port, '127.0.0.1', () => console.log(`chains controller on 127.0.0.1:${port}`));
startTelegram();
startMonitor();

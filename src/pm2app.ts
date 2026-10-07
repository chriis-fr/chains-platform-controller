import { spawn } from 'node:child_process';
import type { AppConfig } from './config.js';
import { notify, escapeHtml } from './notify.js';

/**
 * Apps that run under pm2 rather than in a container.
 *
 * WHY THE API IS NOT BLUE/GREEN
 *
 * The docker deployer swaps colours: it starts the new container, health-checks it, then
 * retires the old one. For the POS that is ideal — a stateless web app, no downtime.
 *
 * For chains-api it would be actively harmful, because the API runs background work the
 * POS does not. During the overlap there would be TWO of everything:
 *
 *   pos-rollups     two passes over one database
 *   mpesa-sync      two pulls hitting Safaricom
 *   daily-brief     two briefs — every subscriber messaged twice
 *
 * The API's own overlap guards are IN-PROCESS. They stop one instance stacking on itself
 * and do nothing about a second process. Blue/green would reintroduce the connection-pool
 * exhaustion those guards were written to fix, and double-message real customers.
 *
 * So the API stays single-instance under pm2, and this module gives it the same Telegram
 * surface the POS has: status, deploy, rollback, errors. One control plane, two very
 * different runtimes underneath, which is the honest shape rather than pretending both
 * deploy the same way.
 */

export interface Pm2Health {
  ok: boolean;
  commit: string | null;
  startedAt: string | null;
  raw: Record<string, unknown> | null;
}

// Falls back to $CHAINS_REPO_ROOT (or $HOME) rather than a hardcoded home directory,
// so this runs as any user on any box. apps.json can always override per app.
const repoRoot = () => process.env.CHAINS_REPO_ROOT ?? process.env.HOME ?? '/srv';
const repoDir = (app: AppConfig) => app.repoDir ?? `${repoRoot()}/${app.name}`;
const pm2Name = (app: AppConfig) => app.pm2Name ?? app.name;

function shOut(
  cmd: string,
  args: string[],
  cwd?: string,
  timeoutMs = 20_000,
  env?: Record<string, string>,
): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: env ? { ...process.env, ...env } : process.env });
    let out = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('error', () => { clearTimeout(t); resolve(out); });
    p.on('exit', () => { clearTimeout(t); resolve(out); });
  });
}

/**
 * What the RUNNING process reports about itself.
 *
 * Read from /health rather than from a state file the deployer wrote, deliberately. A
 * state file records what was deployed; /health records what is executing. Those two
 * disagreed for thirteen days on this box — the repo was pulled and pm2 was never
 * restarted, so the API served three-week-old code while every file on disk was current.
 * Asking the process is the only answer that cannot drift.
 */
export async function pm2Health(app: AppConfig): Promise<Pm2Health> {
  const url = `http://127.0.0.1:${app.appPort}${app.healthPath}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return {
      ok: res.ok && body?.ok !== false,
      commit: typeof body?.commit === 'string' ? body.commit : null,
      startedAt: typeof body?.startedAt === 'string' ? body.startedAt : null,
      raw: body,
    };
  } catch {
    return { ok: false, commit: null, startedAt: null, raw: null };
  }
}

/** The commit the repo on disk is at — compared against /health to expose drift. */
export async function pm2DiskCommit(app: AppConfig): Promise<string | null> {
  const out = (await shOut('git', ['rev-parse', '--short', 'HEAD'], repoDir(app))).trim();
  return /^[0-9a-f]{7,}$/.test(out) ? out : null;
}

export async function pm2Uptime(app: AppConfig): Promise<string | null> {
  const out = await shOut('pm2', ['jlist']);
  try {
    const list = JSON.parse(out.slice(out.indexOf('['))) as Array<Record<string, unknown>>;
    const proc = list.find((p) => p.name === pm2Name(app));
    const env = (proc?.pm2_env ?? {}) as Record<string, unknown>;
    const since = Number(env.pm_uptime ?? 0);
    if (!since) return null;
    const h = Math.round((Date.now() - since) / 3_600_000);
    return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`;
  } catch {
    return null;
  }
}

/**
 * Deploy by running the repo's own deploy.sh.
 *
 * The script is the authority, not this module. It already refuses on a dirty tree,
 * type-checks before restarting, installs only when the lockfile moved, and — the part
 * that matters here — polls /health until the served commit matches what it deployed.
 * Reimplementing any of that would give two subtly different deploys for one app, which
 * is how the API ended up stale in the first place.
 */
export async function deployPm2(app: AppConfig): Promise<void> {
  const dir = repoDir(app);
  const script = app.deployScript ?? './deploy.sh';
  const before = (await pm2Health(app)).commit;

  await notify(`🚀 <b>${app.name}</b> — deploying via <code>${script}</code>…`);

  /*
   * CHAINS_DEPLOY_VIA_CONTROLLER tells the script to keep quiet on Telegram.
   *
   * A repo's deploy.sh now announces its own deploys, because most of them are run by a
   * person over SSH and used to happen in silence. When the controller is the one
   * running it, the controller has already posted "deploying…" and will post the
   * outcome — so without this flag every button press would report itself twice.
   */
  const out = await shOut('bash', [script], dir, 10 * 60_000, {
    CHAINS_DEPLOY_VIA_CONTROLLER: '1',
  });
  const after = await pm2Health(app);
  const disk = await pm2DiskCommit(app);

  // The script's own verdict is what decides. It prints this line only after /health has
  // confirmed the served commit, so trusting its output is trusting a real check.
  const succeeded = /✓ Deployed/.test(out) && after.ok && after.commit === disk;

  if (succeeded) {
    await notify(
      `✅ <b>${app.name}</b> deployed\n` +
      `   ├ serving <code>${after.commit}</code>${before && before !== after.commit ? ` (was <code>${before}</code>)` : ''}\n` +
      `   └ https://${app.domain}`,
    );
    return;
  }

  // The tail, not the whole log. A deploy failure is read on a phone.
  const tail = out.trim().split('\n').slice(-12).join('\n');
  await notify(
    `❌ <b>${app.name}</b> deploy FAILED\n` +
    `   ├ disk <code>${disk ?? '?'}</code> · serving <code>${after.commit ?? 'unreachable'}</code>\n` +
    `   └ health ${after.ok ? 'ok' : 'NOT ok'}\n\n<pre>${escapeHtml(tail)}</pre>`,
  );
  throw new Error(`${app.name}: deploy.sh did not confirm a successful deploy`);
}

/**
 * Roll back to the previous commit and redeploy.
 *
 * `git reset` is avoided — a deploy is not the place to rewrite history. This checks out
 * the previous commit as a detached HEAD, which is reversible by pulling again and leaves
 * the branch untouched.
 */
export async function rollbackPm2(app: AppConfig): Promise<void> {
  const dir = repoDir(app);
  const prev = (await shOut('git', ['rev-parse', '--short', 'HEAD~1'], dir)).trim();
  if (!/^[0-9a-f]{7,}$/.test(prev)) throw new Error(`${app.name}: cannot resolve the previous commit`);

  await notify(`↩️ <b>${app.name}</b> — rolling back to <code>${prev}</code>…`);
  await shOut('git', ['checkout', prev], dir, 60_000);
  await shOut('pm2', ['restart', pm2Name(app), '--update-env'], undefined, 60_000);

  // Give it a moment to bind, then report what is actually serving.
  await new Promise((r) => setTimeout(r, 8000));
  const h = await pm2Health(app);
  await notify(
    h.ok && h.commit === prev
      ? `✅ <b>${app.name}</b> rolled back — serving <code>${h.commit}</code>`
      : `⚠️ <b>${app.name}</b> rollback finished but health says serving <code>${h.commit ?? 'unreachable'}</code> (expected <code>${prev}</code>). Check the logs.`,
  );
}

/**
 * Recent errors, for /errors.
 *
 * The API logs one JSON line per request, so a plain tail is almost all 200s. This keeps
 * only lines that are actually a problem — level error/warn, or an unhandled throw — and
 * strips the request-id noise so the message is readable on a phone.
 */
export async function pm2Errors(app: AppConfig, limit = 12): Promise<string[]> {
  const out = await shOut('pm2', ['logs', pm2Name(app), '--lines', '400', '--nostream'], undefined, 25_000);
  const hits: string[] = [];

  for (const line of out.split('\n')) {
    const isProblem =
      /"level":"(error|fatal)"/.test(line) ||
      /"status":5\d\d/.test(line) ||
      /unhandled|FATAL|ECONNREFUSED|Timed out|ETIMEDOUT/i.test(line);
    if (!isProblem) continue;

    // Prefer the structured fields when it is one of our JSON log lines.
    let shown = line.replace(/^\d+\|[^|]*\|\s*/, '').trim();
    try {
      const j = JSON.parse(shown) as Record<string, unknown>;
      const t = typeof j.time === 'string' ? j.time.slice(11, 19) : '';
      const msg = String(j.message ?? '');
      const err = j.err ? ` — ${String(j.err)}` : '';
      shown = `${t} ${msg}${err}`.trim();
    } catch { /* not JSON — show the raw line */ }

    if (shown) hits.push(shown.slice(0, 220));
  }

  // Newest first, deduplicated: a repeating error is one problem, not forty.
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const h of hits.reverse()) {
    const key = h.replace(/^\d\d:\d\d:\d\d /, '');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(h);
    if (unique.length >= limit) break;
  }
  return unique;
}

/** Recent errors from a container's log, so /errors covers both runtimes. */
export async function dockerErrors(containerPrefix: string, limit = 12): Promise<string[]> {
  const name = (await shOut('docker', ['ps', '--format', '{{.Names}}'])).split('\n')
    .map((s) => s.trim()).find((n) => n.startsWith(containerPrefix));
  if (!name) return [];

  const out = await shOut('docker', ['logs', '--tail', '300', name], undefined, 20_000);
  const hits = out.split('\n').filter((l) =>
    /error|fatal|unhandled|ECONNREFUSED|ETIMEDOUT|\b5\d\d\b/i.test(l) && l.trim().length > 0,
  );

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const h of hits.reverse()) {
    const key = h.slice(0, 120);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(h.trim().slice(0, 220));
    if (unique.length >= limit) break;
  }
  return unique;
}

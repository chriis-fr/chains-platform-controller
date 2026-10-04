import { spawn } from 'node:child_process';
import { loadConfig, appKind, type AppConfig } from './config.js';
import { loadState } from './deployer.js';
import { runDeploy, runRollback } from './orchestrator.js';
import { pm2Health, pm2DiskCommit, pm2Uptime } from './pm2app.js';

/**
 * The same actions as the Telegram bot, from a shell.
 *
 * Deploy and rollback go through the orchestrator rather than calling the docker deployer
 * directly, so the CLI dispatches on `kind` exactly as a Telegram button or a webhook
 * does. Calling the deployer straight from here would run a blue/green swap against a
 * pm2 app — the one thing this codebase exists to keep separate.
 *
 * The overlap guard it inherits is in-process, so it only sees deploys started by THIS
 * command. A CLI deploy cannot tell that the service is already deploying the same app.
 * Prefer Telegram when the service is up; this is for when it is not.
 */

const [cmd, name] = process.argv.slice(2);
const cfg = loadConfig();

function requireApp(n?: string): AppConfig {
  const app = cfg.apps.find((a) => a.name === n);
  if (!app) {
    console.error(`Unknown app "${n}". Registered: ${cfg.apps.map((a) => a.name).join(', ')}`);
    process.exit(1);
  }
  return app;
}

async function printStatus(app: AppConfig): Promise<void> {
  if (appKind(app) === 'pm2') {
    const [h, disk, up] = await Promise.all([pm2Health(app), pm2DiskCommit(app), pm2Uptime(app)]);
    const state = h.ok ? 'live' : 'DOWN';
    const drift = h.commit && disk && h.commit !== disk ? `  DRIFT: disk ${disk}` : '';
    console.log(
      `${app.name} (pm2): ${state} serving ${h.commit ?? '?'}` +
      `${up ? ` since ${up} ago` : ''}${drift}  https://${app.domain}`,
    );
    return;
  }
  const s = loadState(app.name);
  console.log(s
    ? `${app.name}: ${s.sha.slice(0, 7)} on ${s.active} since ${s.at}${s.prevSha ? ` (rollback → ${s.prevSha.slice(0, 7)})` : ''}  https://${app.domain}`
    : `${app.name}: never deployed`);
}

function followLogs(app: AppConfig): void {
  if (appKind(app) === 'pm2') {
    spawn('pm2', ['logs', app.pm2Name ?? app.name, '--lines', '100'], { stdio: 'inherit' });
    return;
  }
  const s = loadState(app.name);
  if (!s) { console.error(`${app.name}: never deployed`); process.exit(1); }
  spawn('docker', ['logs', '-f', '--tail', '100', `chains-${app.name}-${s.active}`], { stdio: 'inherit' });
}

async function main(): Promise<void> {
  switch (cmd) {
    case 'deploy':
      await runDeploy(requireApp(name).name);
      break;
    case 'rollback':
      await runRollback(requireApp(name).name);
      break;
    case 'status':
      for (const app of name ? [requireApp(name)] : cfg.apps) await printStatus(app);
      break;
    case 'logs':
      followLogs(requireApp(name));
      break;
    case 'apps':
      for (const a of cfg.apps) {
        console.log(`${a.name}  [${appKind(a)}]  ${a.repo}#${a.branch}  → https://${a.domain}`);
      }
      break;
    default:
      console.log('Usage: chains <deploy|rollback|status|logs|apps> [app]');
  }
}

main().catch((e) => { console.error((e as Error).message); process.exit(1); });

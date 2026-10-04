import { loadConfig, appKind } from './config.js';
import { deploy, rollback } from './deployer.js';
import { deployPm2, rollbackPm2 } from './pm2app.js';
import { running, queued } from './state.js';

export async function runDeploy(name: string): Promise<void> {
  if (running.has(name)) { queued.add(name); return; }
  running.add(name);
  try {
    const app = loadConfig().apps.find((a) => a.name === name);
    if (app) await (appKind(app) === 'pm2' ? deployPm2(app) : deploy(app));
  } catch (e) {
    console.error(`[${name}] deploy failed:`, (e as Error).message);
  } finally {
    running.delete(name);
    if (queued.delete(name)) void runDeploy(name);
  }
}

export async function runRollback(name: string): Promise<void> {
  if (running.has(name)) return;
  running.add(name);
  try {
    const app = loadConfig().apps.find((a) => a.name === name);
    if (app) await (appKind(app) === 'pm2' ? rollbackPm2(app) : rollback(app));
  } catch (e) {
    console.error(`[${name}] rollback failed:`, (e as Error).message);
  } finally {
    running.delete(name);
  }
}

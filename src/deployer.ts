import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './config.js';
import { notify, escapeHtml } from './notify.js';
import { expectRemoval } from './state.js';

const APPS_DIR = '/opt/chains/apps';
const DATA_DIR = '/opt/chains/data/deploys';
const KEEP_IMAGES = 5;

export interface AppState { active: 'blue' | 'green'; sha: string; prevSha?: string; at: string; }

function sh(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, stdio: 'inherit' });
    p.on('error', reject);
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} → exit ${c}`))));
  });
}

function shOut(cmd: string, args: string[], opts: { cwd?: string } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: opts.cwd });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', reject);
    p.on('exit', (c) => (c === 0 ? resolve(out.trim()) : reject(new Error(`${cmd} ${args.join(' ')} → exit ${c}`))));
  });
}

function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

const statePath = (app: string) => path.join(DATA_DIR, `${app}.json`);

export function loadState(app: string): AppState | null {
  return existsSync(statePath(app)) ? (JSON.parse(readFileSync(statePath(app), 'utf8')) as AppState) : null;
}

function log(app: string, msg: string) {
  console.log(`[${app}] ${msg}`);
  mkdirSync(DATA_DIR, { recursive: true });
  appendFileSync(path.join(DATA_DIR, `${app}.log`), `${new Date().toISOString()} ${msg}\n`);
}

async function release(app: AppConfig, image: string, sha: string, kind: 'deploy' | 'rollback'): Promise<void> {
  const state = loadState(app.name);
  const active = state?.active ?? null;
  const target = active === 'blue' ? 'green' : 'blue';
  const targetName = `chains-${app.name}-${target}`;
  const envPath = path.join(APPS_DIR, app.name, '.env');

  expectRemoval(targetName);
  await sh('docker', ['rm', '-f', targetName]).catch(() => {});
  const args = ['run', '-d', '--name', targetName, '--restart', 'unless-stopped',
    '--network', 'chains-edge',
    '--cpus', String(app.cpus ?? 1), '--memory', `${app.memoryMb ?? 1024}m`,
    '--label', 'traefik.enable=true',
    '--label', 'traefik.http.routers.' + app.name + '.rule=Host(`' + app.domain + '`)',
    '--label', `traefik.http.routers.${app.name}.entrypoints=web`,
    '--label', `traefik.http.services.${app.name}.loadbalancer.server.port=${app.appPort}`];
  if (existsSync(envPath)) args.push('--env-file', envPath);
  args.push(image);
  await sh('docker', args);

  log(app.name, `waiting for ${targetName} to become healthy…`);
  let healthy = false;
  for (let i = 0; i < 60; i++) {
    const s = await shOut('docker', ['inspect', '-f', '{{.State.Health.Status}}', targetName]).catch(() => 'starting');
    if (s === 'healthy') { healthy = true; break; }
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!healthy) {
    log(app.name, `FAILED — ${targetName} unhealthy. Traffic untouched. Container logs:`);
    await sh('docker', ['logs', '--tail', '50', targetName]).catch(() => {});
    expectRemoval(targetName);
    await sh('docker', ['rm', '-f', targetName]).catch(() => {});
    throw new Error(`health check failed, ${kind} aborted — traffic untouched`);
  }

  if (active) {
    const oldName = `chains-${app.name}-${active}`;
    expectRemoval(oldName);
    await sh('docker', ['rm', '-f', oldName]).catch(() => {});
  }
  writeFileSync(statePath(app.name), JSON.stringify(
    { active: target, sha, prevSha: state?.sha, at: new Date().toISOString() } satisfies AppState, null, 2));
}

async function pruneImages(appName: string): Promise<void> {
  const tags = (await shOut('docker', ['images', `chains/${appName}`, '--format', '{{.Tag}}']).catch(() => ''))
    .split('\n').filter(Boolean);
  for (const tag of tags.slice(KEEP_IMAGES)) {
    await sh('docker', ['rmi', `chains/${appName}:${tag}`]).catch(() => {});
  }
}

export async function deploy(app: AppConfig): Promise<void> {
  const t0 = Date.now();
  const appDir = path.join(APPS_DIR, app.name);
  const repoDir = path.join(appDir, 'repo');
  const envPath = path.join(appDir, '.env');

  log(app.name, '=== deploy started ===');
  try {
    const before = await shOut('git', ['rev-parse', 'HEAD'], { cwd: repoDir });
    await sh('git', ['fetch', 'origin', app.branch], { cwd: repoDir });
    await sh('git', ['reset', '--hard', `origin/${app.branch}`], { cwd: repoDir });
    const sha = await shOut('git', ['rev-parse', 'HEAD'], { cwd: repoDir });
    const short = sha.slice(0, 7);
    log(app.name, `at commit ${short}`);
    void notify(`🚀 <b>${app.name}</b> — deploying <code>${short}</code>…`);

    const needCi =
      !existsSync(path.join(repoDir, 'node_modules')) ||
      (before !== sha &&
        (await shOut('git', ['diff', '--name-only', before, sha], { cwd: repoDir }))
          .split('\n').includes('package-lock.json'));
    if (needCi) {
      log(app.name, 'lockfile changed → npm ci');
      await sh('npm', ['ci'], { cwd: repoDir });
    }

    log(app.name, 'building…');
    await sh('npm', ['run', 'build'], {
      cwd: repoDir,
      env: { ...readEnvFile(envPath), BUILD_STANDALONE: 'true', NEXT_TELEMETRY_DISABLED: '1' },
    });

    const ctx = path.join(appDir, 'context');
    rmSync(ctx, { recursive: true, force: true });
    mkdirSync(path.join(ctx, '.next'), { recursive: true });
    cpSync(path.join(repoDir, '.next/standalone'), ctx, { recursive: true });
    cpSync(path.join(repoDir, '.next/static'), path.join(ctx, '.next/static'), { recursive: true });
    if (existsSync(path.join(repoDir, 'public'))) {
      cpSync(path.join(repoDir, 'public'), path.join(ctx, 'public'), { recursive: true });
    }

    const image = `chains/${app.name}:${short}`;
    await sh('docker', ['build', '-f', path.join(appDir, 'Dockerfile'),
      '--build-arg', `PORT=${app.appPort}`, '--build-arg', `HEALTH_PATH=${app.healthPath}`,
      '-t', image, ctx]);

    await release(app, image, sha, 'deploy');
    await pruneImages(app.name);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    log(app.name, `LIVE — ${short} on ${loadState(app.name)!.active} in ${secs}s`);
    void notify(`✅ <b>${app.name}</b> — <code>${short}</code> LIVE on ${loadState(app.name)!.active} in ${secs}s\nhttps://${app.domain}`);
  } catch (e) {
    void notify(`❌ <b>${app.name}</b> — deploy FAILED\n<code>${escapeHtml((e as Error).message)}</code>\nLive traffic is untouched.`);
    throw e;
  }
}

export async function rollback(app: AppConfig): Promise<void> {
  const t0 = Date.now();
  try {
    const state = loadState(app.name);
    if (!state?.prevSha) throw new Error('no previous deploy recorded — nothing to roll back to');
    const short = state.prevSha.slice(0, 7);
    const image = `chains/${app.name}:${short}`;
    await shOut('docker', ['image', 'inspect', image]);
    log(app.name, `=== rollback to ${short} ===`);
    void notify(`↩️ <b>${app.name}</b> — rolling back to <code>${short}</code>…`);
    await release(app, image, state.prevSha, 'rollback');
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    log(app.name, `LIVE — rolled back to ${short} in ${secs}s`);
    void notify(`✅ <b>${app.name}</b> — rolled back to <code>${short}</code> in ${secs}s`);
  } catch (e) {
    void notify(`❌ <b>${app.name}</b> — rollback FAILED\n<code>${escapeHtml((e as Error).message)}</code>`);
    throw e;
  }
}

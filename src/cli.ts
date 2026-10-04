import { spawn } from 'node:child_process';
import { loadConfig } from './config.js';
import { deploy, rollback, loadState } from './deployer.js';

const [cmd, name] = process.argv.slice(2);
const cfg = loadConfig();

function requireApp(n?: string) {
  const app = cfg.apps.find((a) => a.name === n);
  if (!app) {
    console.error(`Unknown app "${n}". Registered: ${cfg.apps.map((a) => a.name).join(', ')}`);
    process.exit(1);
  }
  return app;
}

switch (cmd) {
  case 'deploy':
    deploy(requireApp(name)).catch((e) => { console.error(e.message); process.exit(1); });
    break;
  case 'rollback':
    rollback(requireApp(name)).catch((e) => { console.error(e.message); process.exit(1); });
    break;
  case 'status': {
    for (const app of name ? [requireApp(name)] : cfg.apps) {
      const s = loadState(app.name);
      console.log(s
        ? `${app.name}: ${s.sha.slice(0, 7)} on ${s.active} since ${s.at}${s.prevSha ? ` (rollback → ${s.prevSha.slice(0, 7)})` : ''}  https://${app.domain}`
        : `${app.name}: never deployed`);
    }
    break;
  }
  case 'logs': {
    const app = requireApp(name);
    const s = loadState(app.name);
    if (!s) { console.error(`${app.name}: never deployed`); process.exit(1); }
    spawn('docker', ['logs', '-f', '--tail', '100', `chains-${app.name}-${s.active}`], { stdio: 'inherit' });
    break;
  }
  case 'apps':
    for (const a of cfg.apps) console.log(`${a.name}  ${a.repo}#${a.branch}  → https://${a.domain}`);
    break;
  default:
    console.log('Usage: chains <deploy|rollback|status|logs|apps> [app]');
}

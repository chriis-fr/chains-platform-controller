import { spawn } from 'node:child_process';
import { wasExpected } from './state.js';
import { notify } from './notify.js';

const lastAlert = new Map<string, number>();

export function startMonitor(): void {
  const p = spawn('docker', ['events', '--filter', 'event=die', '--format', '{{json .}}']);
  let buf = '';
  p.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines.filter(Boolean)) {
      try {
        const ev = JSON.parse(line);
        const name: string = ev?.Actor?.Attributes?.name ?? '';
        if (!name.startsWith('chains-')) continue;
        if (wasExpected(name)) continue;               // blue/green swap, not a crash
        const code = ev?.Actor?.Attributes?.exitCode ?? '?';
        const now = Date.now();
        if ((lastAlert.get(name) ?? 0) > now - 60_000) continue;  // max 1 alert/min/container
        lastAlert.set(name, now);
        void notify(`⚠️ <b>${name}</b> died unexpectedly (exit ${code}). Docker's restart policy is bringing it back — if this repeats, check <code>chains logs</code>.`);
      } catch { /* ignore malformed event lines */ }
    }
  });
  p.on('exit', () => setTimeout(startMonitor, 3000));
  console.log('monitor: watching docker events');
}

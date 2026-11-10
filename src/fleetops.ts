import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FleetOpsConfig } from './config.js';
import { escapeHtml } from './notify.js';

/**
 * Chains FleetOps (Fleetbase) on Telegram.
 *
 * Webhooks: FleetOps signs each delivery with
 *   X-Fleetbase-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(endpoint secret, `${t}.${rawBody}`)>
 * (core-api src/Webhook/Signer/EndpointSignature.php). We accept a 5-minute clock window, like FleetOps does.
 * The body is `{ id, api_version, event, created_at, data }`, with events named `<model>.<name>`.
 */
export function verifyFleetopsSignature(rawBody: Buffer, header: string | undefined, secret: string, toleranceSec = 300): boolean {
  if (!header || !secret) return false;
  const parts: Record<string, string[]> = {};
  for (const piece of header.split(',')) {
    const [k, v] = piece.trim().split('=', 2);
    if (k && v) (parts[k] ??= []).push(v);
  }
  const t = parts.t?.[0];
  if (!t || !/^\d+$/.test(t) || Math.abs(Date.now() / 1000 - Number(t)) > toleranceSec) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${t}.`).update(rawBody).digest('hex'));
  return (parts.v1 ?? []).some((sig) => {
    const got = Buffer.from(sig);
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

/** Events worth a phone notification. Everything else is acknowledged and dropped. */
export const DEFAULT_EVENTS = [
  'order.created', 'order.dispatched', 'order.driver_assigned', 'order.started',
  'order.completed', 'order.canceled', 'order.failed', 'order.dispatch_failed',
];

const ICON: Record<string, string> = {
  created: '🆕', dispatched: '📤', driver_assigned: '🧑‍✈️', started: '🚚', completed: '✅',
  canceled: '🚫', failed: '🔴', dispatch_failed: '⚠️', ready: '📦',
};

const pick = (o: any, ...paths: string[]): string | undefined => {
  for (const p of paths) {
    const v = p.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), o);
    if (v != null && v !== '') return String(v);
  }
  return undefined;
};

export function formatFleetopsEvent(body: any, consoleUrl: string): string | null {
  const event: string = body?.event ?? '';
  const [model, name] = event.split('.', 2);
  if (model !== 'order') return `📍 <b>FleetOps</b> — <code>${escapeHtml(event || 'unknown event')}</code>`;

  const d = body?.data ?? {};
  const id = pick(d, 'public_id', 'id') ?? '?';
  const tracking = pick(d, 'tracking_number.tracking_number', 'tracking');
  const status = pick(d, 'status');
  const driver = pick(d, 'driver_assigned.name', 'driver.name');
  const from = pick(d, 'payload.pickup.address', 'payload.pickup.name', 'pickup.address');
  const to = pick(d, 'payload.dropoff.address', 'payload.dropoff.name', 'dropoff.address');
  const customer = pick(d, 'customer.name');

  return [
    `${ICON[name] ?? '📦'} <b>Order ${escapeHtml(name?.replace(/_/g, ' ') ?? 'update')}</b> — <code>${escapeHtml(id)}</code>`,
    status ? `   ├ status: ${escapeHtml(status)}` : null,
    tracking ? `   ├ tracking: <code>${escapeHtml(tracking)}</code>` : null,
    customer ? `   ├ customer: ${escapeHtml(customer)}` : null,
    driver ? `   ├ driver: ${escapeHtml(driver)}` : null,
    from ? `   ├ from: ${escapeHtml(from)}` : null,
    to ? `   ├ to: ${escapeHtml(to)}` : null,
    `   └ ${consoleUrl}`,
  ].filter(Boolean).join('\n');
}

async function probe(url: string, init?: RequestInit): Promise<{ ok: boolean; status: number; ms: number; json?: any }> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    const json = res.headers.get('content-type')?.includes('json') ? await res.json().catch(() => undefined) : undefined;
    return { ok: res.ok, status: res.status, ms: Date.now() - t0, json };
  } catch {
    return { ok: false, status: 0, ms: Date.now() - t0 };
  }
}

/** /fleet — is FleetOps up, and (with an API key) what is moving right now. */
export async function fleetStatusText(f: FleetOpsConfig): Promise<string> {
  const [api, consoleRes] = await Promise.all([probe(`${f.apiUrl}/health`), probe(f.consoleUrl)]);
  const line = (label: string, r: { ok: boolean; status: number; ms: number }) =>
    `   ├ ${r.ok ? '✅' : '🔴'} ${label} — ${r.status || 'no answer'} · ${r.ms} ms`;

  const out = [
    '🚚 <b>Chains FleetOps</b>',
    line('API', api),
    line('Console', consoleRes),
  ];

  if (f.apiKey) {
    const statuses = ['created', 'dispatched', 'started'];
    const counts = await Promise.all(statuses.map((s) =>
      probe(`${f.apiUrl}/v1/orders?status=${s}&limit=100`, { headers: { authorization: `Bearer ${f.apiKey}` } })));
    const bits = statuses.map((s, i) => {
      const r = counts[i];
      if (!r.ok) return `${s}: ?`;
      const n = Array.isArray(r.json) ? r.json.length : Array.isArray(r.json?.data) ? r.json.data.length : undefined;
      return `${s}: ${n === undefined ? '?' : n >= 100 ? '100+' : n}`;
    });
    out.push(`   ├ orders — ${bits.join(' · ')}`);
  } else {
    out.push('   ├ orders — add <code>fleetops.apiKey</code> to apps.json to see counts');
  }
  out.push(`   └ ${f.consoleUrl}`);
  return out.join('\n');
}

import { readFileSync } from 'node:fs';

/**
 * How an app runs. Docker apps deploy blue/green; pm2 apps are single-instance.
 *
 * The distinction is not cosmetic. chains-api runs background schedulers — rollups,
 * M-Pesa sync, the daily brief — and its overlap guards are in-process. Two instances,
 * even for the seconds of a blue/green swap, means two of every scheduled job and two
 * WhatsApp briefs to every subscriber. So it stays single-instance and deploys through
 * its own deploy.sh, which verifies /health reports the commit it just deployed.
 */
export type AppKind = "docker" | "pm2";

export interface AppConfig {
  name: string; repo: string; branch: string; domain: string;
  appPort: number; healthPath: string; cpus?: number; memoryMb?: number;
  /** Defaults to "docker" so every existing entry behaves exactly as before. */
  kind?: AppKind;
  /** pm2 only: where the checkout and its deploy.sh live. */
  repoDir?: string;
  /** pm2 only: the process name, when it differs from the app name. */
  pm2Name?: string;
  /** pm2 only: defaults to ./deploy.sh */
  deployScript?: string;
}

export const appKind = (a: AppConfig): AppKind => a.kind ?? "docker";
export interface TelegramConfig { botToken: string; chatId: number; }
export interface PlatformConfig {
  webhookSecret: string;
  telegram?: TelegramConfig;
  apps: AppConfig[];
}

const CONFIG_PATH = process.env.CHAINS_CONFIG ?? '/opt/chains/platform/apps.json';
export function loadConfig(): PlatformConfig {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as PlatformConfig;
}
export function findAppByRepo(cfg: PlatformConfig, repoFullName: string): AppConfig | undefined {
  return cfg.apps.find((a) => a.repo.toLowerCase() === repoFullName.toLowerCase());
}

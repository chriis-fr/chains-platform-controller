# chains-platform-controller

A small deploy controller for a single VPS, driven from Telegram.

It deploys apps from GitHub on push, reports what happened, and lets you check status,
deploy, roll back and read errors from a phone. Roughly the parts of Vercel or Railway
that matter when everything runs on one machine you own.

It is about 830 lines of TypeScript with one runtime dependency. It is not a platform —
it is the smallest thing that removes "SSH in and hope you remember the steps".

## What it does

```
git push ──► GitHub webhook ──► controller ──► build, swap, health-check ──► Telegram
                                     │
Telegram /status ────────────────────┤
Telegram /errors ────────────────────┤
Telegram /logs ──────────────────────┘
```

**Two kinds of app**, because one deploy model does not fit both:

| | `kind: "docker"` | `kind: "pm2"` |
|---|---|---|
| strategy | blue/green | single instance |
| downtime | none | a restart |
| resource limits | `--cpus`, `--memory` | whatever pm2 gives it |
| rollback | retag the previous image | `git checkout HEAD~1` + restart |
| deploy | build, start the other colour, health-check, retire the old | run the repo's own `deploy.sh` |

The distinction is not cosmetic, and it is the main thing this repo gets right.

**Blue/green is wrong for an app with background work.** During the overlap there are two
instances, so an app that runs schedulers runs each of them twice — two cron passes
against one database, two outbound syncs, two notification batches to the same users. An
app's own in-process guards do not help: they stop one instance stacking on itself and
know nothing about a second process.

So a stateful app stays single-instance and deploys through its own script. It costs a few
seconds of downtime and it cannot double-send anything.

## Telegram

| | |
|---|---|
| `/status` | every app, its live commit, and buttons to deploy or roll back |
| `/errors` | recent real problems per app — repeats collapsed, newest first |
| `/logs` | a live tail that refreshes for a bounded window, with a Stop button |
| `/help` | the list |

Only the configured `chatId` is answered. Every destructive action asks for confirmation
with an inline button first.

### /status reports what is RUNNING, not what was deployed

This is the detail worth copying if you build your own.

A deploy writes a state file saying "deployed abc1234". Read that back and you learn what
a deploy *claimed*, not what is executing. Those two can disagree for a long time — pull
new code, forget to restart, and the state file still says everything is current while the
process serves last month's build.

That happened on the box this was written for: thirteen days of a `git pull` with no
restart, an API serving three-week-old code, every fix present on disk and absent from
memory, and nothing anywhere reporting it. The symptom was "the fixes don't work".

So for `pm2` apps the controller asks the app itself:

```jsonc
// GET /health on your app should return at least:
{ "ok": true, "commit": "c068bd6", "startedAt": "2026-10-04T07:46:27.921Z" }
```

`commit` is read **once at boot** — deliberately, since the point is what this process
started from. The controller compares it to `git rev-parse HEAD` in the repo and prints a
`⚠️ DRIFT` line when they differ. One request, instead of inferring it from process
uptime.

Your app needs to expose that field for drift detection to work. Everything else
functions without it.

## Requirements

- One Linux box with Docker, pm2, git and Node 20+ (`npx tsx` runs the TypeScript)
- A reverse proxy that routes by container label if you use `kind: "docker"` — Traefik
  with `--providers.docker` is what this was written against
- A Telegram bot from [@BotFather](https://t.me/botfather), and your numeric chat id

## Setup

```bash
git clone https://github.com/<you>/chains-platform-controller /opt/chains/platform/controller
cd /opt/chains/platform/controller
npm install

cp apps.example.json /opt/chains/platform/apps.json
chmod 600 /opt/chains/platform/apps.json     # it holds your bot token
$EDITOR /opt/chains/platform/apps.json

sudo cp chains-controller.service.example /etc/systemd/system/chains-controller.service
$EDITOR /etc/systemd/system/chains-controller.service    # user, paths
sudo systemctl enable --now chains-controller
```

Then point a GitHub webhook at `http://your-host:9600/webhook` (behind your proxy, or
tunnelled) with the `webhookSecret` from `apps.json` as the secret.

Send `/status` to the bot. If it answers, it works.

**`apps.json` is gitignored and must stay that way.** It holds the bot token, the chat id
and the webhook secret. There are no credentials anywhere else in this repo.

## Configuration

Two environment variables, both with defaults:

| | default | |
|---|---|---|
| `CHAINS_CONFIG` | `/opt/chains/platform/apps.json` | where `apps.json` lives |
| `CHAINS_REPO_ROOT` | `$HOME` | where pm2 repos live, when `apps.json` doesn't say |

Per app in `apps.json`:

| field | | |
|---|---|---|
| `name` | both | short id; the container prefix for Docker apps |
| `kind` | both | `docker` or `pm2`. Omitted means `docker` |
| `repo` | both | `owner/name` — matched against the webhook payload |
| `branch` | both | pushes to any other branch are ignored |
| `domain` | both | the Traefik host rule, for Docker apps |
| `appPort` | both | the port the app listens on |
| `healthPath` | both | polled after a deploy; `/health` should return `commit` |
| `cpus`, `memoryMb` | docker | container limits. Set them — an unlimited container will take the box down with it |
| `repoDir` | pm2 | the checkout. Defaults to `$CHAINS_REPO_ROOT/<name>` |
| `pm2Name` | pm2 | process name, when it differs from `name` |
| `deployScript` | pm2 | defaults to `./deploy.sh` |

A `pm2` app brings its own `deploy.sh`. The controller runs it and reads `/health`; what
happens in between is the repo's business. A script worth copying refuses to run on a
dirty tree, fast-forwards rather than resetting, type-checks before it restarts anything,
and polls `/health` until the commit served matches the commit deployed — so it cannot
report success for a restart that silently didn't take.

## Layout

```
src/
  server.ts        the webhook endpoint, binds 127.0.0.1:9600
  config.ts        apps.json loading, app kinds
  telegram.ts      polling, commands, inline-button flows, rendering
  orchestrator.ts  one deploy per app at a time, queues the rest
  deployer.ts      docker blue/green: build, start, health-check, retire, prune
  pm2app.ts        pm2 apps: /health, drift, deploy.sh, rollback, error extraction
  monitor.ts       watches `docker events` for containers dying unexpectedly
  notify.ts        Telegram sending
  state.ts         what is running or queued, in memory
  cli.ts           the same actions from a shell
```

No build step. `tsx` runs the TypeScript, and the only dependency is `express`.

## What it does not do

Worth being plain about, because the gaps are deliberate:

- **One box.** No orchestration, no multiple hosts, no scheduling.
- **No secret management.** Your app's `.env` is your business; this never reads it.
- **No TLS.** The controller binds `127.0.0.1`. Put a proxy in front.
- **No database migrations.** A `deploy.sh` can run them; the controller will not.
- **No multi-user auth.** One Telegram chat id is trusted. There are no roles.
- **In-memory state.** Restart it mid-deploy and it forgets a deploy was running. The
  deploy itself continues; the controller just stops narrating it.
- **`/logs` is polled, not streamed.** Telegram cannot stream, so it edits one message on
  a timer for a bounded window. It reads like a tail; it is not one.

## Why it exists

A VPS is cheaper than a platform and gives you the machine. What you lose is the part of
Vercel you actually use every day: knowing what is deployed, redeploying without
remembering the steps, and seeing errors without SSH.

This is that part, for one box, in a file you can read in an afternoon.

## Licence

MIT.

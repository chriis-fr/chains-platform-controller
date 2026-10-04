# chains-platform-controller

A small deploy controller for a single VPS, driven from Telegram.

It deploys apps from GitHub on push, reports what happened, and lets you check status,
deploy, roll back and read errors from a phone. Roughly the parts of Vercel or Railway
that matter when everything runs on one machine you own.

It is about 870 lines of TypeScript with one runtime dependency. It is not a platform —
it is the smallest thing that removes "SSH in and hope you remember the steps".

## What it does

```
git push ──► GitHub webhook ──► controller ──► build, swap, health-check ──► Telegram
                                     │
Telegram /status ────────────────────┤
Telegram /errors ────────────────────┘
```

**Two kinds of app**, because one deploy model does not fit both:

| | `kind: "docker"` | `kind: "pm2"` |
|---|---|---|
| strategy | blue/green | single instance |
| downtime | none | a restart |
| resource limits | `--cpus`, `--memory` | whatever pm2 gives it |
| rollback | start the previous image again | `git checkout HEAD~1` + restart |
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
| `/help` | the list |

`/status` also carries inline buttons: deploy, roll back, errors, refresh. Messages from
any chat other than the configured `chatId` are dropped without a reply, and deploy and
rollback both ask "are you sure?" and wait for a second tap.

`/errors` is a filtered digest, not a tail. An app that logs one JSON line per request
produces a log that is almost entirely 200s, where a tail shows you volume and hides the
fault. This keeps only the lines that are a problem, collapses repeats, and puts the
newest first — so one fault that fired four hundred times is one entry, not four hundred.

### From a shell, when the bot is the thing that's down

```bash
npm run cli -- status            # every app, or one by name
npm run cli -- deploy  <app>
npm run cli -- rollback <app>
npm run cli -- logs    <app>     # docker logs -f, or pm2 logs
npm run cli -- apps
```

Same dispatch on `kind` as the webhook and the buttons — a CLI deploy of a pm2 app runs
its `deploy.sh`, not a blue/green swap. The overlap guard is in-process, so this cannot
see a deploy the service is already running; prefer Telegram while the service is up.

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

The controller listens on `127.0.0.1:9600` only, so GitHub cannot reach it directly. Give
it a route through the proxy that already fronts your apps — a host or path rule to
`127.0.0.1:9600` — and point the webhook at that public URL with `webhookSecret` from
`apps.json` as the secret. The payload is verified with HMAC-SHA256 against that secret
and a wrong signature gets a 401, so the endpoint is safe to expose; binding to loopback
just means TLS is the proxy's job rather than this process's.

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
| `healthPath` | both | pm2: polled after a deploy, and should return `commit`. docker: passed to the build as `HEALTH_PATH`, for your Dockerfile's `HEALTHCHECK` |
| `cpus`, `memoryMb` | docker | container limits. Set them — an unlimited container will take the box down with it |
| `repoDir` | pm2 | the checkout. Defaults to `$CHAINS_REPO_ROOT/<name>` |
| `pm2Name` | pm2 | process name, when it differs from `name` |
| `deployScript` | pm2 | defaults to `./deploy.sh` |

A `pm2` app brings its own `deploy.sh`. The controller runs it and reads `/health`; what
happens in between is the repo's business. A script worth copying refuses to run on a
dirty tree, fast-forwards rather than resetting, type-checks before it restarts anything,
and polls `/health` until the commit served matches the commit deployed — so it cannot
report success for a restart that silently didn't take.

### The Docker path expects a specific setup

Read this before pointing a `kind: "docker"` app at it, because the deployer is not
generic — it was written for Next.js apps on one box, and it shows.

It runs `npm run build` with `BUILD_STANDALONE=true`, then assembles the image context
from `.next/standalone`, `.next/static` and `public/`. A Next.js app with standalone
output builds as-is. **Anything else needs `deploy()` in `deployer.ts` changed**, which is
about twenty lines.

The on-disk layout is hardcoded at the top of `deployer.ts`:

```
/opt/chains/apps/<name>/repo/        the checkout — git reset --hard origin/<branch>
/opt/chains/apps/<name>/Dockerfile   yours, built with PORT and HEALTH_PATH build args
/opt/chains/apps/<name>/.env         passed to the container with --env-file
/opt/chains/data/deploys/<name>.json which colour is live, and the previous sha
```

Three things that will cost you an afternoon if nobody says them:

- **Your Dockerfile must declare a `HEALTHCHECK`.** The deployer gates the swap on
  `docker inspect .State.Health.Status`, so a container with no healthcheck never reports
  `healthy`, and every deploy waits 60 seconds and then aborts with traffic untouched.
  `healthPath` is handed to the build as `HEALTH_PATH` for the Dockerfile to use.
- **Containers join a network called `chains-edge`** and are labelled for Traefik on an
  entrypoint called `web`. Create the network, or change the two constants.
- **The checkout is `git reset --hard`.** Anything edited directly on the server inside
  `repo/` is gone on the next deploy. That is deliberate — but it is the opposite of what
  the pm2 path does, which refuses to deploy a dirty tree rather than flattening it.

Rollback reuses the image built for the previous commit rather than rebuilding it, so it
takes seconds. The last 5 image tags per app are kept and older ones pruned; roll back
further than that and the image is gone.

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
  cli.ts           the same actions from a shell, dispatching on the same kind
```

`monitor.ts` is worth a line: it alerts on containers that die, but a blue/green swap
*intentionally* kills a container every deploy. So the deployer marks a removal as
expected before it happens, and the monitor stays quiet for it — otherwise every
successful deploy would page you. Alerts are also capped at one per container per minute,
since a crash-looping container restarts faster than you can read about it.

No build step. `tsx` runs the TypeScript, and the only dependency is `express`.

## What it does not do

Worth being plain about, because the gaps are deliberate:

- **One box.** No orchestration, no multiple hosts, no scheduling.
- **Not a generic builder.** The Docker path builds Next.js standalone output and assumes
  the directory layout above. Other stacks need `deployer.ts` edited.
- **No secret management.** For a Docker app it reads `/opt/chains/apps/<name>/.env` and
  hands it to the build and to the container with `--env-file`, so keep that file at
  `600`. It never generates, encrypts, rotates or versions anything in it, and never puts
  a value from it in a Telegram message. For a pm2 app it does not touch env at all.
- **No TLS.** The controller binds `127.0.0.1`. Put a proxy in front.
- **No database migrations.** A `deploy.sh` can run them; the controller will not.
- **No multi-user auth.** One Telegram chat id is trusted. There are no roles.
- **In-memory state.** Restart it mid-deploy and it forgets a deploy was running. The
  deploy itself continues; the controller just stops narrating it.
- **No live log tailing.** Telegram has no streaming transport, so following a log means
  editing one message on a timer. `/errors` gives you a digest on demand instead; for a
  real tail you still SSH.
- **No metrics.** No request rates, no latency, no graphs. `/status` answers "is it up and
  what is it serving"; it does not answer "how is it doing".

## Why it exists

A VPS is cheaper than a platform and gives you the machine. What you lose is the part of
Vercel you actually use every day: knowing what is deployed, redeploying without
remembering the steps, and seeing errors without SSH.

This is that part, for one box, in a file you can read in an afternoon.

## Licence

MIT.

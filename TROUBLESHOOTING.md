# TROUBLESHOOTING.md — running the Hide Haven agent

> ⚠️ **This is a live production system answering real paying customers.** Every command below
> is safe to run; the only thing to be careful with is restarting, which briefly stops replies.
> Read [AGENT.md](AGENT.md) for architecture and landmines.

---

## 1. This host is a STANDBY (since 2026-10-17)

The live agent runs on **EC2** (`ssh -i "ec2 keys.pem" ubuntu@13.212.10.34`). This machine is
kept as a backup and **does not start the agent on its own, by design**. Running both at once
would mean two WhatsApp sessions and two queue workers on the same customer traffic —
duplicate replies, and potentially duplicate orders.

After a reboot this host brings up only the supporting cast:

| What | Starts at boot? |
|---|---|
| Redis | ✅ via `boot-services.sh` |
| **crond** (nightly backup + log rotation) | ✅ via `boot-services.sh` |
| cloudflared, ssh, filebrowser | ✅ host boot script |
| **hh-agent** | ❌ standby |
| **whatsapp-bridge** | ❌ standby |

Verify the standby is healthy:

```sh
sh /projects/HH-agent/scripts/healthcheck.sh    # expect RESULT: healthy, MODE standby
```

### Bring the standby agent up by hand

**Stop the EC2 agent first** — otherwise customers get two replies to every message.

```sh
sh /projects/HH-agent/scripts/start-agent.sh    # starts Redis if needed, then bridge + agent
sh /projects/HH-agent/scripts/healthcheck.sh    # now expect the agent + WhatsApp checks to run
```

`start-agent.sh` waits for both services and tells you whether WhatsApp is actually connected.
It deliberately does **not** run `pm2 save`, so the agent is still off after the next reboot.

Put it back to standby:

```sh
sh /projects/HH-agent/scripts/stop-agent.sh     # pm2 delete — removes them from the boot dump too
```

### Re-enabling autostart permanently (e.g. if EC2 is retired)

```sh
# uncomment both app names in /etc/hh-agent/autostart, then:
pm2 start /projects/HH-agent/ecosystem.config.js
pm2 save
```

⚠️ **`pm2 save` while the apps are running re-arms autostart** — the saved process list is
exactly what `pm2 resurrect` replays at boot. That single command is the only thing that undoes
standby mode accidentally. `boot-services.sh` and `start-agent.sh` both refuse to run it while
autostart is disabled.

---

## 2. What comes back on its own (verified 2026-10-17, standby)

| Component | After reboot | Notes |
|---|---|---|
| **Redis** | ✅ via `boot-services.sh` | No init script exists; that script is the only thing that starts it. |
| **cron** (`crond`) | ✅ via `boot-services.sh` | Nothing else starts it. Without it, **nightly backups and log rotation do not happen.** |
| **hh-agent** | ❌ **No — standby** | Deliberately absent from `dump.pm2` and from `/etc/hh-agent/autostart`. Start it with `scripts/start-agent.sh`. |
| **whatsapp-bridge** | ❌ **No — standby** | Same. The bridge is stopped with the agent: running it alone would queue customer messages that nobody answers, and replay them when the agent is next started. |
| **cloudflared / ssh / filebrowser** | ✅ Yes | Managed by the host boot script, outside the chroot. |

**Where the boot chain actually lives:** `/etc/inittab` points at `/sbin/openrc`, which **does
not exist** in this chroot, so every in-chroot boot line is a no-op. Boot is driven from
Android by the Magisk script `/data/adb/service.d/99-alpine-server.sh`, which starts sshd and
then runs `chroot /data/local/alpine /bin/sh /usr/local/bin/alpine-services.sh`. That script
starts ttyd, cloudflared, `pm2 resurrect`, then `boot-services.sh`.

It is reachable from inside the chroot at
`/proc/1/root/data/adb/service.d/99-alpine-server.sh` (PID 1 is Android's init), and so is its
log, `/proc/1/root/data/local/alpine-boot.log`.

The Android script never touches PM2 — it only calls `alpine-services.sh`. So the **only** boot
path to the agent is `pm2 resurrect`, and it is closed twice over: the dump no longer contains
the two apps, and `alpine-services.sh` re-reads `/etc/hh-agent/autostart` immediately after
resurrecting and deletes anything it does not list (logged as `standby policy: removed …`).
A stray `pm2 save` can therefore re-arm the dump, but not actually run the agent at boot.

---

## 3. Verify the stack is actually working

```sh
sh /projects/HH-agent/scripts/healthcheck.sh    # one command, exit 0 = everything OK
```

It checks Redis, the agent, the database, the WhatsApp link, queue backlog, failed jobs,
stuck handoffs and provider failovers. Individual pieces:

```sh
curl -s http://127.0.0.1:3000/health            # only in active mode: expect "database":"connected"
curl -s http://127.0.0.1:3001/status            # only in active mode: expect "isConnected":true
pm2 list                                        # standby: only filebrowser + cloudflare-tunnel
                                                # active:  plus hh-agent + whatsapp-bridge "online"
pidof crond                                     # expect a PID (check by NAME — see §5)
```

`healthcheck.sh` printing one `WARN` about provider failovers is normal — that is LLM rate
limiting, not a fault.

---

## 4. Common problems

| Symptom | What it means / fix |
|---|---|
| **`pm2 list` shows no `hh-agent`** | **Normal on this host** — it is a standby (§1). Bring it up with `sh scripts/start-agent.sh` after stopping EC2. |
| **PM2 all green but customers get no replies** | Redis is down. Run `sh scripts/boot-services.sh`. This is the #1 silent failure. |
| `NOAUTH Authentication required` from `redis-cli` | **Expected.** Redis requires a password. Use `REDISCLI_AUTH=$(grep -m1 '^REDIS_PASSWORD=' agent/.env \| cut -d= -f2-) redis-cli ping` |
| **Dashboard shows a QR code** | The WhatsApp session was logged out. Re-pair: scan the QR with the store phone → WhatsApp → *Linked devices*. **Never delete `whatsapp_bridge/auth_info/`.** |
| Replies very slow (tens of seconds) | Normal is p50 ≈ 9 s, p90 ≈ 23–37 s. Spikes usually mean provider failovers — look for `trying next candidate` in `pm2 logs hh-agent`. |
| **Bridge has no `creds.json` / `auth_info` looks rebuilt** | The session was lost. Look for `auth_info.broken-<timestamp>` — the bridge *quarantines* rather than deletes, so move it back to restore. Otherwise re-pair. |
| A change to `agent/src` had no effect | `dist/` is what runs. `cd agent && npx tsc && pm2 restart hh-agent`. |
| **Agent exits at boot with `Missing required environment variable X`** | Deliberate. `agent/.env` is missing a required value. Compare against `agent/.env.example` — this is meant to fail loudly, not start half-configured. |
| Agent restarted, then doubled replies / duplicate orders | Two workers are running. `pm2 list` — there should be exactly one `hh-agent`. Delete extras with `pm2 delete <name>`. |

---

## 5. Known gaps — things that do NOT fix themselves

1. **Nightly backups run only while `crond` is alive — and only `boot-services.sh` starts it.**
   *(Fixed 2026-10-16: `crond` is now running, and `boot-services.sh` will start it if it is
   missing.)* The jobs live in `/etc/periodic/daily/` (`hh-agent-backup`,
   `hh-agent-logrotate`). Before that date **nothing** started `crond`, so they never fired —
   the only backups on disk were two made **by hand** during the 2026-10-15 audit, and log
   rotation was not happening either. To check: `pidof crond`, and read `/var/log/crond.log`.
   - ⚠️ **Check cron by process name (`pidof crond`), never `ps -ef | grep crond`.** The latter
     also matches any shell that merely *mentions* crond in its arguments, so it reports a dead
     cron as healthy. The first version of the `boot-services.sh` fix had exactly this bug.
2. **The host boot script does not call `boot-services.sh`.** One line needs adding to the host
   script (outside the chroot, so it cannot be edited from in here):
   ```sh
   /bin/sh /projects/HH-agent/scripts/boot-services.sh
   ```
3. **Backups are local only.** Copy `/backups/hh-agent/*` to another machine or cloud storage.
   A backup stored only on the box that dies is not a backup.
4. **WhatsApp credentials are not rotated** — see AGENT.md §6. The DB password, admin dashboard
   password and webhook secret were exposed and must be rotated.

---

## 6. Routine commands

```sh
pm2 list                          # all processes
pm2 logs hh-agent                 # follow the app log (Ctrl-C to exit)
pm2 restart hh-agent              # ⚠️ briefly stops replies — prefer off-peak

sh scripts/healthcheck.sh         # is it healthy? (standby-aware)
sh scripts/backup.sh              # manual backup -> /backups/hh-agent
sh scripts/boot-services.sh       # Redis + cron; agent apps only if autostart says so
sh scripts/start-agent.sh         # ⚠️ stop EC2 first — start the standby agent by hand
sh scripts/stop-agent.sh          # back to standby (also removes them from the boot dump)
tail -n 100 /root/.pm2/logs/hh-agent-out.log   # log of a stopped/removed app

cd agent && npx tsc && pm2 restart hh-agent   # deploy a source change
cd agent && npm run sync:faq                  # after editing data/faq.json
cd agent && npm run sync:products             # re-pull the WooCommerce catalog
```

**Do not** hit the bridge's `/send` or `/send-image`, `place_order`, or the admin reply
endpoint to "test" things — they message **real customers**.

---

## 7. If you are unsure whether it is working

Do this in order and stop at the first failure:

```sh
sh scripts/healthcheck.sh                        # 1. overall verdict
curl -s http://127.0.0.1:3000/health             # 2. agent + database
curl -s http://127.0.0.1:3001/status             # 3. WhatsApp connected?
pidof crond; pidof redis-server                  # 4. cron + redis alive?
pm2 logs hh-agent --lines 50                     # 5. what is it actually doing?
```

Step 5 is the real answer to most questions — the log shows every incoming message, the tools
the model called, and any error. If a customer says "the bot never replied", grep the log for
their phone number before assuming the system is down.

---

## 8. The EC2 production host (since 2026-10-17)

The live agent runs on **EC2** (`ssh -i "ec2 keys.pem" ubuntu@13.212.10.34`), published at
**`https://aws.apigateway.live`** (Cloudflare tunnel → `http://127.0.0.1:3000`).

- **Repo:** `/home/ubuntu/projects/HH-agent/whatsapp_agent/` (note the nested directory).
- **Boot:** there is no chroot here. `systemd` starts everything:
  - `cloudflared.service` — enabled
  - `redis-server.service` — enabled
  - `pm2-ubuntu.service` — enabled by `pm2 startup`; replays `~/.pm2/dump.pm2`
    (`hh-agent` + `whatsapp-bridge`). **After any `pm2 start`/`stop` change, run `pm2 save`**
    or the list at boot will be stale.
  - `cron.service` — enabled; the nightly backup is a `crontab -e` entry for `ubuntu`, and
    PM2/log rotation is `/etc/logrotate.d/hh-agent`.
- **Redis requires a password here too** (`requirepass` in `/etc/redis/redis.conf`, matching
  `REDIS_PASSWORD` in both `.env` files). `NOAUTH` from a bare `redis-cli` is expected.

Deploying a source change:

```sh
cd ~/projects/HH-agent/whatsapp_agent
git pull
cd agent && npm ci && npx tsc
pm2 restart hh-agent         # ⚠️ briefly stops replies — prefer off-peak
pm2 save
```

⚠️ **If `agent/.env` changed** (a rotated secret, a new key), `pm2 restart` is not enough: PM2
caches each app's environment and `dotenv` never overrides a variable that is already set, so
the old value silently survives. Re-create the app instead:

```sh
pm2 delete hh-agent && pm2 start ecosystem.config.js --only hh-agent && pm2 save
```

Verify:

```sh
curl -s http://127.0.0.1:3000/health
curl -s https://aws.apigateway.live/health
sh scripts/healthcheck.sh
```

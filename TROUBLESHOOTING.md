# TROUBLESHOOTING.md — running the Hide Haven agent

> ⚠️ **This is a live production system answering real paying customers.** Every command below
> is safe to run; the only thing to be careful with is restarting, which briefly stops replies.
> Read [AGENT.md](AGENT.md) for architecture and landmines.

---

## 1. The server rebooted — do this

Get a shell, then run these three commands **in order**:

```sh
sh /projects/HH-agent/scripts/boot-services.sh   # 1. Redis + cron + the two PM2 apps
sh /projects/HH-agent/scripts/healthcheck.sh     # 2. verify
```

You want to see **`RESULT: healthy`** from the last one. Then open the dashboard
(`http://<host>:3000/admin`) and confirm WhatsApp shows **connected**, not a QR code.

`boot-services.sh` is idempotent — it starts only what is missing, so running it when the stack
is already up is safe. It will not create duplicate workers (that would cause double replies).

---

## 2. What comes back on its own (verified 2026-10-16)

| Component | After reboot | Notes |
|---|---|---|
| **Redis** | ❌ **No** | No init script exists. Only `boot-services.sh` starts it. If missing, the bot looks alive but answers nobody. |
| **cron** (`crond`) | ✅ via `boot-services.sh` | Nothing else starts it. Without it, **nightly backups and log rotation do not happen.** |
| **hh-agent** | ⚠️ Only if the host boot script runs `pm2 resurrect` | `pm2 save` has been run, so `~/.pm2/dump.pm2` holds the app list. |
| **whatsapp-bridge** | ⚠️ Same as above — it is a PM2 app | |
| **cloudflared / ssh / filebrowser** | ✅ Yes | Managed by the host boot script, outside the chroot. |

**Why the uncertainty:** `/etc/inittab` points at `/sbin/openrc`, which **does not exist** in
this chroot, so every in-chroot boot line is a no-op. Boot is driven by a script on the host,
which is not visible from in here. That is why step 1 above is "just run it" rather than
"check whether it ran".

---

## 3. Verify the stack is actually working

```sh
sh /projects/HH-agent/scripts/healthcheck.sh    # one command, exit 0 = everything OK
```

It checks Redis, the agent, the database, the WhatsApp link, queue backlog, failed jobs,
stuck handoffs and provider failovers. Individual pieces:

```sh
curl -s http://127.0.0.1:3000/health            # expect "database":"connected"
curl -s http://127.0.0.1:3001/status            # expect "isConnected":true
pm2 list                                        # expect hh-agent + whatsapp-bridge "online"
pidof crond                                     # expect a PID (check by NAME — see §5)
```

`healthcheck.sh` printing one `WARN` about provider failovers is normal — that is LLM rate
limiting, not a fault.

---

## 4. Common problems

| Symptom | What it means / fix |
|---|---|
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

sh scripts/healthcheck.sh         # is it healthy?
sh scripts/backup.sh              # manual backup -> /backups/hh-agent
sh scripts/boot-services.sh       # bring the whole stack up (idempotent)

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

#!/bin/sh
#
# Idempotent startup for the Hide Haven WhatsApp agent stack.
#
# Safe to run repeatedly (at boot, or by hand any time). It starts only what is missing,
# so it will not duplicate processes that your host boot script already started.
#
# Suggested use — add ONE line to your host boot script, after the chroot is up:
#   /bin/sh /projects/HH-agent/scripts/boot-services.sh
#
# Why this exists: Redis was started by hand and is not covered by anything at boot. If
# Redis is absent the whole pipeline stalls (the bridge and agent both need it), so the
# stack comes back up in a silent, half-broken state: WhatsApp is connected but no message
# is ever processed.
#
set -u

SRC=/projects/HH-agent
REDIS_DIR=${REDIS_DIR:-/var/lib/hh-redis}
REDIS_LOG="$REDIS_DIR/redis.log"
AGENT_URL=http://127.0.0.1:3000/health
BRIDGE_URL=http://127.0.0.1:3001/qr

log() { printf '[boot-services] %s\n' "$*"; }

# Redis password, shared by the agent and the bridge (REDIS_PASSWORD in either env file).
# Exported so redis-cli calls in this script authenticate automatically.
REDIS_PASSWORD=$(grep -m1 '^REDIS_PASSWORD=' "$SRC/agent/.env" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"'')
if [ -n "$REDIS_PASSWORD" ]; then
  REDISCLI_AUTH=$REDIS_PASSWORD
  export REDISCLI_AUTH
else
  log "WARNING: REDIS_PASSWORD is not set in agent/.env — starting Redis without authentication."
fi

# ---------------------------------------------------------------- 1. Redis
if redis-cli ping >/dev/null 2>&1; then
  log "Redis already running."
else
  log "Redis not responding — starting it (loopback only, data kept outside the project)."
  mkdir -p "$REDIS_DIR"

  # Preserve the queue data from the old in-project DB file, if this is the first run.
  if [ ! -f "$REDIS_DIR/dump.rdb" ] && [ -f "$SRC/dump.rdb" ]; then
    cp -p "$SRC/dump.rdb" "$REDIS_DIR/dump.rdb" && log "Migrated existing Redis data into $REDIS_DIR"
  fi

  # Notes on the flags:
  #  --bind 127.0.0.1   Redis was reachable from the whole network with no password.
  #  --requirepass       ditto: anyone who could reach the port had root-equivalent control.
  #  --appendonly yes    the queue holds customer messages; AOF loses seconds, RDB loses
  #                      up to an hour of jobs (i.e. dropped customer messages).
  #  --dir               keeps customer data out of the source tree.
  if [ -n "$REDIS_PASSWORD" ]; then
    redis-server \
      --bind 127.0.0.1 \
      --protected-mode yes \
      --port 6379 \
      --requirepass "$REDIS_PASSWORD" \
      --dir "$REDIS_DIR" \
      --dbfilename dump.rdb \
      --appendonly yes \
      --daemonize yes \
      --logfile "$REDIS_LOG"
  else
    redis-server \
      --bind 127.0.0.1 \
      --protected-mode yes \
      --port 6379 \
      --dir "$REDIS_DIR" \
      --dbfilename dump.rdb \
      --appendonly yes \
      --daemonize yes \
      --logfile "$REDIS_LOG"
  fi

  i=0
  while [ "$i" -lt 20 ]; do
    redis-cli ping >/dev/null 2>&1 && break
    i=$((i + 1))
    sleep 1
  done

  if redis-cli ping >/dev/null 2>&1; then
    log "Redis is up."
  else
    log "ERROR: Redis did not start — see $REDIS_LOG"
  fi
fi

# ------------------------------------------------------------- 2. PM2 apps
if ! command -v pm2 >/dev/null 2>&1; then
  log "ERROR: pm2 not found on PATH."
  exit 1
fi

# Restore the saved process list ONLY when PM2 does not already know about these apps.
# Running resurrect unconditionally starts a SECOND copy of every app (e.g. hh-agent-1), and
# two queue workers on the same queue mean duplicate replies and potentially duplicate orders.
if pm2 describe hh-agent >/dev/null 2>&1 || pm2 describe whatsapp-bridge >/dev/null 2>&1; then
  log "PM2 already knows these apps — not resurrecting (would create duplicates)."
else
  log "PM2 has no agent processes — restoring the saved process list."
  pm2 resurrect >/dev/null 2>&1 || true
fi

ensure_app() {
  app="$1"
  if pm2 describe "$app" 2>/dev/null | grep -q 'online'; then
    log "$app is online."
    return 0
  fi
  if pm2 describe "$app" >/dev/null 2>&1; then
    log "$app exists but is not online — restarting."
    pm2 restart "$app" >/dev/null 2>&1 || true
  else
    log "$app is missing — starting it from ecosystem.config.js."
    pm2 start "$SRC/ecosystem.config.js" --only "$app" >/dev/null 2>&1 || true
  fi
}

ensure_app hh-agent
ensure_app whatsapp-bridge
pm2 save >/dev/null 2>&1 || true

# --------------------------------------------------------- 3. Verify it works
i=0
while [ "$i" -lt 30 ]; do
  agent_ok=0
  bridge_ok=0
  curl -fsS -m 4 "$AGENT_URL" >/dev/null 2>&1 && agent_ok=1
  curl -fsS -m 4 "$BRIDGE_URL" >/dev/null 2>&1 && bridge_ok=1
  [ "$agent_ok" -eq 1 ] && [ "$bridge_ok" -eq 1 ] && break
  i=$((i + 1))
  sleep 2
done

status=0
if [ "${agent_ok:-0}" -eq 1 ]; then log "Agent HTTP health: OK"; else log "ERROR: Agent not healthy at $AGENT_URL"; status=1; fi
if [ "${bridge_ok:-0}" -eq 1 ]; then log "WhatsApp bridge: OK"; else log "ERROR: bridge not responding at $BRIDGE_URL"; status=1; fi
if redis-cli ping >/dev/null 2>&1; then log "Redis: OK"; else log "ERROR: Redis not responding"; status=1; fi

if [ "$status" -eq 0 ]; then
  log "All services are up."
else
  log "One or more services failed to start — check: pm2 logs"
fi
exit "$status"

#!/bin/sh
#
# Start the Hide Haven agent BY HAND on this standby host.
#
#   sh /projects/HH-agent/scripts/start-agent.sh
#
# ⚠️ Stop the EC2 agent first. Two agents on the same customer traffic means two WhatsApp
# sessions and two queue workers: duplicate replies, and potentially duplicate orders.
#
# ⚠️ This deliberately does NOT run `pm2 save`. The saved process list (dump.pm2) is what
# `pm2 resurrect` replays at boot, so saving here would silently re-enable autostart. The
# apps start now and stay off after the next reboot — which is the intended behaviour.
#
# Stop them again with: sh /projects/HH-agent/scripts/stop-agent.sh
#
set -u

SRC=/projects/HH-agent
AGENT_URL=http://127.0.0.1:3000/health
BRIDGE_URL=http://127.0.0.1:3001/qr

log() { printf '[start-agent] %s\n' "$*"; }

if ! command -v pm2 >/dev/null 2>&1; then
  log "ERROR: pm2 not found on PATH."
  exit 1
fi

log "Reminder: the EC2 agent should be STOPPED before this one starts."

# Redis is not managed by PM2 and nothing in the stack works without it. Delegate to the
# boot script, which starts Redis and cron and (because autostart is disabled) stops there.
RP=$(sed -n 's/^REDIS_PASSWORD=//p' "$SRC/agent/.env" 2>/dev/null | head -1 | tr -d "\"'")
if [ -n "$RP" ]; then
  REDISCLI_AUTH=$RP
  export REDISCLI_AUTH
fi
if redis-cli ping >/dev/null 2>&1; then
  log "Redis is up."
else
  log "Redis is down — running boot-services.sh to bring it (and cron) up."
  sh "$SRC/scripts/boot-services.sh" >/dev/null 2>&1 || true
  if redis-cli ping >/dev/null 2>&1; then
    log "Redis is up."
  else
    log "ERROR: Redis is still down — see /var/lib/hh-redis/redis.log"
    exit 1
  fi
fi

# Bridge first, then the agent: the bridge is what receives messages, and the agent's worker
# can only process what is already in Redis.
for app in whatsapp-bridge hh-agent; do
  if pm2 describe "$app" 2>/dev/null | grep -q 'online'; then
    log "$app is already online."
  elif pm2 describe "$app" >/dev/null 2>&1; then
    log "$app exists but is not online — restarting it."
    pm2 restart "$app" >/dev/null 2>&1 || true
  else
    log "$app is not in the PM2 list — starting it from ecosystem.config.js."
    pm2 start "$SRC/ecosystem.config.js" --only "$app" >/dev/null 2>&1 || true
  fi
done

# Wait for both HTTP endpoints. The agent needs up to ~20s on a cold start (DB connect, RAG
# index load), so allow 90s before calling it a failure.
i=0
agent_ok=0
bridge_ok=0
while [ "$i" -lt 45 ]; do
  curl -fsS -m 4 "$AGENT_URL" >/dev/null 2>&1 && agent_ok=1
  curl -fsS -m 4 "$BRIDGE_URL" >/dev/null 2>&1 && bridge_ok=1
  [ "$agent_ok" -eq 1 ] && [ "$bridge_ok" -eq 1 ] && break
  i=$((i + 1))
  sleep 2
done

status=0
if [ "$agent_ok" -eq 1 ]; then
  log "Agent HTTP health: OK"
else
  log "ERROR: agent not healthy at $AGENT_URL — check: pm2 logs hh-agent"
  status=1
fi
if [ "$bridge_ok" -eq 1 ]; then
  log "WhatsApp bridge: OK"
else
  log "ERROR: bridge not responding at $BRIDGE_URL — check: pm2 logs whatsapp-bridge"
  status=1
fi

# A bridge that runs but is logged out cannot answer anyone. Never echo the raw payload: when
# the session is down it carries a live pairing QR code.
if [ "$bridge_ok" -eq 1 ]; then
  body=$(curl -fsS -m 5 "$BRIDGE_URL" 2>/dev/null || true)
  case "$body" in
    *'"isConnected":true'*)
      log "WhatsApp session is connected."
      ;;
    *'"isConnected":false'*)
      log "⚠️ Bridge is up but NOT connected. Open the dashboard and scan the QR with the store"
      log "   phone (WhatsApp -> Linked devices). Never delete whatsapp_bridge/auth_info/."
      ;;
    *)
      log "⚠️ Could not read the bridge's connection state (payload omitted — it may hold a QR)."
      ;;
  esac
fi

log "pm2 save was NOT run: these apps will NOT start at the next reboot."
if [ "$status" -eq 0 ]; then
  log "The standby agent is up."
else
  log "One or more services failed — see the errors above."
fi
exit "$status"

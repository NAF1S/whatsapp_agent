#!/bin/sh
#
# Health check for the Hide Haven WhatsApp agent stack.
#
# Run it after every deploy, after a reboot, or from cron. It exits non-zero and prints
# FAIL lines when something that matters to customers is broken.
#
#   /bin/sh /projects/HH-agent/scripts/healthcheck.sh
#
set -u

# Locate the repo from this script's own path — it is /projects/HH-agent on the home server
# and ~/projects/HH-agent/whatsapp_agent on EC2.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SRC=$(dirname "$SCRIPT_DIR")

AGENT_URL=http://127.0.0.1:3000/health
BRIDGE_URL=http://127.0.0.1:3001/qr
MAX_QUEUE_BACKLOG=${MAX_QUEUE_BACKLOG:-50}

fails=0
warns=0

# Authenticate redis-cli without putting the password on the command line.
REDIS_PASSWORD=$(grep -m1 '^REDIS_PASSWORD=' "$SRC/agent/.env" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"'')
if [ -n "$REDIS_PASSWORD" ]; then
  REDISCLI_AUTH=$REDIS_PASSWORD
  export REDISCLI_AUTH
fi

ok()   { printf 'OK    %s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*"; warns=$((warns + 1)); }
fail() { printf 'FAIL  %s\n' "$*"; fails=$((fails + 1)); }

# 1. Redis reachable (everything else depends on it)
if redis-cli ping 2>/dev/null | grep -q PONG; then
  ok "Redis responds to PING"
else
  fail "Redis is not responding — the agent cannot process any message"
fi

# Standby detection. On this host the live agent runs on EC2 and the local apps are
# intentionally absent from PM2 unless started by hand (see scripts/start-agent.sh). That is
# a state, not a fault, so the agent/bridge checks below are skipped rather than reported as
# FAIL. As soon as the apps exist in PM2 again, the full checks apply.
STANDBY=0
if command -v pm2 >/dev/null 2>&1; then
  if ! pm2 describe hh-agent >/dev/null 2>&1 && ! pm2 describe whatsapp-bridge >/dev/null 2>&1; then
    STANDBY=1
  fi
fi

# 2. Agent HTTP + database
if [ "$STANDBY" -eq 1 ]; then
  ok "Agent: STANDBY — not running here (live on EC2; start locally with scripts/start-agent.sh)"
else
  agent_body=$(curl -fsS -m 5 "$AGENT_URL" 2>/dev/null || true)
  if [ -z "$agent_body" ]; then
    fail "Agent health endpoint unreachable at $AGENT_URL"
  else
    ok "Agent HTTP is up"
    case "$agent_body" in
      *'"database":"connected"'*) ok "Agent reports database connected" ;;
      *) fail "Agent reports database NOT connected: $agent_body" ;;
    esac
  fi
fi

# 3. WhatsApp bridge + live session (a bridge that runs but is logged out still fails here)
if [ "$STANDBY" -eq 1 ]; then
  ok "WhatsApp bridge: STANDBY — not running here"
else
  bridge_body=$(curl -fsS -m 5 "$BRIDGE_URL" 2>/dev/null || true)
  if [ -z "$bridge_body" ]; then
    fail "WhatsApp bridge unreachable at $BRIDGE_URL"
  else
    case "$bridge_body" in
      *'"isConnected":true'*) ok "WhatsApp session is connected" ;;
      *'"isConnected":false'*)
        fail "WhatsApp bridge is running but NOT connected — customers get no replies (re-pair required?)" ;;
      *)
        # Never echo the raw body: it can contain a live pairing QR code.
        warn "Unexpected bridge status payload (omitted — it may contain a pairing QR)" ;;
    esac
  fi
fi

# 4. Queue backlog
waiting=$(redis-cli LLEN bull:whatsapp-incoming:wait 2>/dev/null || echo 0)
case "$waiting" in ''|*[!0-9]*) waiting=0 ;; esac
if [ "$waiting" -le "$MAX_QUEUE_BACKLOG" ]; then
  ok "Incoming queue backlog: $waiting"
else
  warn "Incoming queue backlog is $waiting — messages are arriving faster than they are processed"
fi

# 5. Permanently failed jobs (a customer whose message was never answered)
failed=$(redis-cli ZCARD bull:whatsapp-incoming:failed 2>/dev/null || echo 0)
case "$failed" in ''|*[!0-9]*) failed=0 ;; esac
if [ "$failed" -eq 0 ]; then
  ok "No failed jobs in the queue"
else
  warn "$failed permanently failed job(s) in the queue — a customer message may be unanswered (pm2 logs hh-agent)"
fi

# 6. Sessions stuck waiting for a human (bot silent to that customer)
if command -v psql >/dev/null 2>&1; then
  DB=$(grep -m1 '^DATABASE_URL=' "$SRC/agent/.env" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"'')
  if [ -n "$DB" ]; then
    locked=$(psql "$DB" -At -c \
      "SELECT count(*) FROM sessions WHERE is_human_controlled AND handoff_at < now() - interval '2 hours'" \
      2>/dev/null || echo "")
    case "$locked" in
      ''|*[!0-9]*) warn "Could not read locked-session count from the database" ;;
      0)           ok "No session has been waiting on a human for over 2 hours" ;;
      *)           warn "$locked session(s) have been locked awaiting a human for 2+ hours — the bot is silent to those customers" ;;
    esac
  fi
fi

# 7. Provider quota visibility: count recent model-call failures in today's log
logfile=/root/.pm2/logs/hh-agent-out.log
if [ -f "$logfile" ]; then
  recent=$(tail -n 3000 "$logfile" 2>/dev/null | grep -c 'trying next candidate' || true)
  case "$recent" in ''|*[!0-9]*) recent=0 ;; esac
  if [ "$recent" -eq 0 ]; then
    ok "No recent LLM provider failovers"
  else
    warn "$recent recent provider failover(s) (429/503/timeout) in the agent log — replies are slower than normal"
  fi
fi

if [ "$STANDBY" -eq 1 ]; then
  printf 'MODE  standby — the agent and bridge are intentionally not running on this host\n'
fi

printf '\n%s\n' "-----------------------------------------"
if [ "$fails" -eq 0 ]; then
  printf 'RESULT: healthy (%s warning(s))\n' "$warns"
  exit 0
fi
printf 'RESULT: %s FAILURE(S), %s warning(s)\n' "$fails" "$warns"
exit 1

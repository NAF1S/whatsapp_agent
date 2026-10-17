#!/bin/sh
#
# Stop the Hide Haven agent on this host and leave it in standby.
#
#   sh /projects/HH-agent/scripts/stop-agent.sh
#
# Uses `pm2 delete` rather than `pm2 stop`: delete removes the app from PM2's process list,
# so a later `pm2 save` cannot write it back into the boot dump and silently re-arm
# autostart. The log files are kept — /root/.pm2/logs/{hh-agent,whatsapp-bridge}-*.log.
#
# Redis and cron are intentionally left running: cron drives the nightly backup and log
# rotation, and Redis is harmless when idle.
#
set -u

log() { printf '[stop-agent] %s\n' "$*"; }

if ! command -v pm2 >/dev/null 2>&1; then
  log "ERROR: pm2 not found on PATH."
  exit 1
fi

status=0
for app in hh-agent whatsapp-bridge; do
  if pm2 describe "$app" >/dev/null 2>&1; then
    if pm2 delete "$app" >/dev/null 2>&1; then
      log "$app stopped and removed from the PM2 list."
    else
      log "WARNING: could not remove $app from PM2 — check: pm2 list"
      status=1
    fi
  else
    log "$app is not in the PM2 list — nothing to do."
  fi
done

log "Redis and cron are left running (the nightly backup depends on cron)."
log "The saved boot dump was not touched, so autostart stays disabled."
exit "$status"

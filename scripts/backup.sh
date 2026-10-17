#!/bin/sh
#
# Back up everything needed to rebuild the Hide Haven agent after a disk failure, a bad
# deploy, or a lost WhatsApp session. Nothing here is backed up anywhere today: there is no
# git repository, no database dump, and no copy of the WhatsApp session — losing
# whatsapp_bridge/auth_info means re-pairing the store's WhatsApp account by hand.
#
# Usage (run it from anywhere — it locates the repo from its own path):
#   /bin/sh <repo>/scripts/backup.sh
#   BACKUP_ROOT=/mnt/usb/hh-agent-backups /bin/sh <repo>/scripts/backup.sh
#
# Keep a copy OFF this machine (USB drive, another host, or cloud storage): a backup that
# lives only on the box that dies is not a backup.
#
set -u

# Resolve the project root from this script's location instead of hardcoding a host path.
# The repo lives at /projects/HH-agent on the home server and under
# ~/projects/HH-agent/whatsapp_agent on EC2; this makes the same script correct on both.
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SRC=$(dirname "$SCRIPT_DIR")
DEST_ROOT=${BACKUP_ROOT:-/backups/hh-agent}
KEEP=${BACKUP_KEEP:-7}
STAMP=$(date +%Y%m%d-%H%M%S)
DEST="$DEST_ROOT/$STAMP"

log() { printf '[backup] %s\n' "$*"; }

mkdir -p "$DEST" || { log "ERROR: cannot create $DEST"; exit 1; }

# 1. Secrets, WhatsApp session and live data (what you cannot recreate from source)
# The root .env only exists on the home server, so include it only when present — a missing
# path makes tar exit non-zero and would report a false failure every night on EC2.
CONFIG_ITEMS="whatsapp_bridge/auth_info agent/.env ecosystem.config.js data"
[ -f "$SRC/.env" ] && CONFIG_ITEMS="$CONFIG_ITEMS .env"

if tar -czf "$DEST/config-and-session.tar.gz" -C "$SRC" \
     --exclude='node_modules' \
     $CONFIG_ITEMS 2>/dev/null; then
  log "Backed up WhatsApp session, env files and data."
else
  log "WARN: config/session backup reported an error (partial archive kept)."
fi

# 2. Source code (dependencies are reinstallable, so they are excluded)
if tar -czf "$DEST/source.tar.gz" -C "$SRC" \
     --exclude='node_modules' \
     --exclude='auth_info' \
     --exclude='*.rdb' \
     --exclude='*.log' \
     agent/src agent/scripts agent/package.json agent/tsconfig.json \
     whatsapp_bridge/whatsapp-bridge.js whatsapp_bridge/package.json \
     dashboard scripts \
     wordpress-plugin data ecosystem.config.js 2>/dev/null; then
  log "Backed up source tree."
else
  log "WARN: source backup reported an error (partial archive kept)."
fi

# 3. Supabase database (sessions, messages, catalog, orders cache)
DB=$(grep -m1 '^DATABASE_URL=' "$SRC/agent/.env" 2>/dev/null | cut -d= -f2- | tr -d '"'"'"'')
if [ -n "$DB" ] && command -v pg_dump >/dev/null 2>&1; then
  if pg_dump "$DB" --schema=public --no-owner --no-privileges -Fc \
       -f "$DEST/supabase-public.dump" 2>"$DEST/pg_dump.err"; then
    rm -f "$DEST/pg_dump.err"
    log "Backed up the Supabase public schema."
  else
    log "WARN: database dump failed — see $DEST/pg_dump.err"
  fi
else
  log "WARN: pg_dump unavailable or DATABASE_URL not found — database NOT backed up."
fi

# 4. Tighten permissions: these archives contain customer PII and the WhatsApp credentials.
chmod 700 "$DEST" 2>/dev/null
chmod 600 "$DEST"/* 2>/dev/null

# 5. Prune old backups, keeping the most recent $KEEP
count=$(ls -1d "$DEST_ROOT"/*/ 2>/dev/null | wc -l)
if [ "$count" -gt "$KEEP" ]; then
  to_remove=$((count - KEEP))
  ls -1dt "$DEST_ROOT"/*/ 2>/dev/null | tail -n "$to_remove" | while read -r old; do
    rm -rf "$old" && log "Pruned old backup $(basename "$old")"
  done
fi

size=$(du -sh "$DEST" 2>/dev/null | cut -f1)
log "Done: $DEST (${size:-unknown size})"
log "Reminder: copy this off the machine — a backup stored only on this box is not a backup."

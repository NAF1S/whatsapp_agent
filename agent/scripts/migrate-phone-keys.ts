/**
 * One-off: merge customer sessions that are split across multiple non-canonical keys.
 *
 *   cd agent
 *   npx ts-node scripts/migrate-phone-keys.ts            # DRY RUN — prints, writes nothing
 *   npx ts-node scripts/migrate-phone-keys.ts --apply    # performs the merge
 *
 * Why: `public.sessions.phone` is the customer identity (PRIMARY KEY). It was never
 * canonicalised, so one person could hold several rows — e.g. "8801892740307" and
 * "+8801892740307" — each with its own conversation history and its own human-handoff lock.
 * `toCanonicalPhone()` now collapses those forms for NEW writes; this script fixes the rows
 * that already exist.
 *
 * Safety:
 *   - Dry-run by default; nothing is written without `--apply`.
 *   - Before writing, dumps the affected session rows and their message counts to a JSON file
 *     under /backups/hh-agent/ so the merge is reconstructable by hand.
 *   - Single transaction, so it is all-or-nothing.
 *   - Idempotent: once merged, re-running finds no groups.
 *   - Every table is schema-qualified `public.` — Supabase also ships a differently-shaped
 *     `sessions` table in another schema, and an unqualified DELETE could hit the wrong one.
 *
 * Ordering below is load-bearing: `public.messages.phone` has
 * `REFERENCES public.sessions(phone) ON DELETE CASCADE`, so messages MUST be moved to the
 * canonical key BEFORE any session row is deleted — otherwise the delete silently destroys
 * the entire conversation history.
 */
import fs from 'fs';
import path from 'path';
import { pool } from '../src/data/db';
import { toCanonicalPhone } from '../src/utils/phone';

const APPLY = process.argv.includes('--apply');
const BACKUP_DIR = '/backups/hh-agent';

interface SessionRow {
  phone: string;
  customer_name: string | null;
  is_human_controlled: boolean;
  human_agent_id: string | null;
  handoff_reason: string | null;
  handoff_at: Date | null;
  last_message_at: Date | null;
  metadata: Record<string, any> | null;
  created_at: Date | null;
}

const SELECT_COLUMNS = `phone, customer_name, is_human_controlled, human_agent_id,
  handoff_reason, handoff_at, last_message_at, metadata, created_at`;

function log(msg: string): void {
  process.stdout.write(msg + '\n');
}

/** Newest activity wins when no row already holds the canonical key. */
function pickSurvivor(rows: SessionRow[], canonical: string): SessionRow {
  const exact = rows.find((r) => r.phone === canonical);
  if (exact) return exact;
  return [...rows].sort((a, b) => {
    const at = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
    const bt = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
    return bt - at;
  })[0];
}

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    const all = await client.query<SessionRow>(
      `SELECT ${SELECT_COLUMNS} FROM public.sessions`,
    );

    // Group every session by its canonical key; a group of >1 row is a split customer.
    const groups = new Map<string, SessionRow[]>();
    for (const row of all.rows) {
      const canonical = toCanonicalPhone(row.phone);
      if (!canonical) continue; // never merge into an empty key
      if (!groups.has(canonical)) groups.set(canonical, []);
      groups.get(canonical)!.push(row);
    }

    const todo = [...groups.entries()].filter(([, rows]) => rows.length > 1);

    log(`\nsessions total      : ${all.rows.length}`);
    log(`canonical groups    : ${groups.size}`);
    log(`groups needing merge: ${todo.length}`);
    log(`mode                : ${APPLY ? 'APPLY (writing)' : 'DRY RUN (no writes)'}\n`);

    if (todo.length === 0) {
      log('Nothing to merge — every session already holds a canonical key.\n');
      return;
    }

    // Plan each merge before touching anything, so the dry run reports exactly what will happen.
    const plans = todo.map(([canonical, rows]) => {
      const survivor = pickSurvivor(rows, canonical);
      const variants = rows.filter((r) => r.phone !== survivor.phone);
      const lockHolder =
        rows.filter((r) => r.is_human_controlled).sort((a, b) => {
          const at = a.handoff_at ? new Date(a.handoff_at).getTime() : 0;
          const bt = b.handoff_at ? new Date(b.handoff_at).getTime() : 0;
          return bt - at;
        })[0] || null;
      return { canonical, rows, survivor, variants, lockHolder };
    });

    // Message counts, for the report and the backup.
    const messageCounts = new Map<string, number>();
    for (const p of plans) {
      for (const r of p.rows) {
        const res = await client.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n FROM public.messages WHERE phone = $1`,
          [r.phone],
        );
        messageCounts.set(r.phone, parseInt(res.rows[0]?.n || '0', 10));
      }
    }

    for (const p of plans) {
      log(`── canonical ${p.canonical}`);
      log(`   survivor: ${p.survivor.phone}${p.survivor.phone === p.canonical ? ' (already canonical)' : '  -> canonical row will be created and seeded from it'}`);
      for (const v of p.variants) {
        log(`   merge   : ${v.phone}  (${messageCounts.get(v.phone) ?? 0} messages will move)`);
      }
      if (p.lockHolder) {
        log(`   ⚠ active human-handoff lock on ${p.lockHolder.phone} — will be carried to the survivor`);
      }
    }

    const totalMessages = [...messageCounts.values()].reduce((a, b) => a + b, 0);
    log(`\ntotal messages across affected rows: ${totalMessages}`);

    if (!APPLY) {
      log('\nDRY RUN — nothing written. Re-run with --apply to perform the merge.\n');
      return;
    }

    // Backup before writing.
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(BACKUP_DIR, `phone-migration-${stamp}.json`);
    fs.writeFileSync(
      backupPath,
      JSON.stringify(
        plans.map((p) => ({
          canonical: p.canonical,
          survivor: p.survivor,
          merged: p.variants,
          messageCounts: Object.fromEntries(p.rows.map((r) => [r.phone, messageCounts.get(r.phone) ?? 0])),
        })),
        null,
        2,
      ),
      { mode: 0o600 },
    );
    log(`backup written: ${backupPath}\n`);

    await client.query('BEGIN');
    let movedMessages = 0;
    let deletedSessions = 0;

    for (const p of plans) {
      // 1. Make sure a row with the canonical key exists BEFORE any message is moved —
      //    messages.phone is a FK to sessions.phone.
      //
      //    ⚠ NEVER rename a key with `UPDATE sessions SET phone = …`. Verified against the
      //    live catalog: messages_phone_fkey has confupdtype='a' (NO ACTION), so renaming a
      //    parent key fails with a foreign-key violation whenever any message still
      //    references it. An INSERT is the only safe way to bring the canonical row into
      //    existence; the state merge below then fills it in.
      await client.query(
        `INSERT INTO public.sessions (phone, last_message_at) VALUES ($1, NOW())
         ON CONFLICT (phone) DO NOTHING`,
        [p.canonical],
      );

      // 2. Move the history onto the canonical key. MUST precede the delete below.
      //    Every group row except the canonical one is a variant — including the case where
      //    no row held the canonical key and step 1 just created it.
      const variantKeys = p.rows.map((r) => r.phone).filter((ph) => ph !== p.canonical);
      if (variantKeys.length > 0) {
        const res = await client.query(
          `UPDATE public.messages SET phone = $1 WHERE phone = ANY($2::text[])`,
          [p.canonical, variantKeys],
        );
        movedMessages += res.rowCount ?? 0;
      }

      // 3. Merge session state onto the survivor without losing an active handoff lock.
      //    Survivor's metadata wins, so variants are folded in underneath it.
      const mergedMetadata: Record<string, any> = {};
      for (const v of [...p.variants, p.survivor]) {
        Object.assign(mergedMetadata, v.metadata || {});
      }

      const nameFromVariant =
        p.variants.map((v) => v.customer_name).find((n) => n && n.trim()) || null;

      const isHuman = Boolean(p.lockHolder);
      const handoffSource = p.lockHolder || p.survivor;

      const createdAts = p.rows
        .map((r) => (r.created_at ? new Date(r.created_at).getTime() : null))
        .filter((t): t is number => t !== null);
      const lastAts = p.rows
        .map((r) => (r.last_message_at ? new Date(r.last_message_at).getTime() : null))
        .filter((t): t is number => t !== null);

      await client.query(
        `UPDATE public.sessions SET
           customer_name       = COALESCE(NULLIF(customer_name, ''), $2),
           is_human_controlled = $3,
           human_agent_id      = $4,
           handoff_reason      = $5,
           handoff_at          = $6,
           metadata            = $7::jsonb,
           created_at          = $8,
           last_message_at     = $9
         WHERE phone = $1`,
        [
          p.canonical,
          nameFromVariant,
          isHuman,
          isHuman ? handoffSource.human_agent_id : p.survivor.human_agent_id,
          isHuman ? handoffSource.handoff_reason : p.survivor.handoff_reason,
          isHuman ? handoffSource.handoff_at : p.survivor.handoff_at,
          JSON.stringify(mergedMetadata),
          createdAts.length ? new Date(Math.min(...createdAts)) : p.survivor.created_at,
          lastAts.length ? new Date(Math.max(...lastAts)) : p.survivor.last_message_at,
        ],
      );

      // 4. Now the variants hold no messages, so the cascade has nothing left to destroy.
      if (variantKeys.length > 0) {
        const res = await client.query(
          `DELETE FROM public.sessions WHERE phone = ANY($1::text[])`,
          [variantKeys],
        );
        deletedSessions += res.rowCount ?? 0;
      }
    }

    await client.query('COMMIT');
    log(`merged ${plans.length} group(s): moved ${movedMessages} messages, removed ${deletedSessions} duplicate session(s)`);
    log('COMMITTED\n');
  } catch (err: any) {
    try {
      await client.query('ROLLBACK');
      log('\nROLLED BACK — nothing was changed.\n');
    } catch {
      /* the transaction may already be aborted */
    }
    throw err;
  } finally {
    client.release();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    process.stderr.write(`migration failed: ${err?.message || err}\n`);
    process.exit(1);
  });

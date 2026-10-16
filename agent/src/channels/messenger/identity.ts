/**
 * Customer identity across channels.
 *
 * WhatsApp identifies a customer by phone number; Messenger has no phone number at all, only
 * a Page-Scoped ID (PSID) — an opaque string that is different for the same person on a
 * different Page. `sessions.phone` is the PRIMARY KEY of the live table, so Messenger
 * customers have to fit into that column.
 *
 * The chosen approach (plan §9, option A) is to **namespace** the key rather than migrate to a
 * composite primary key on a table serving live customers:
 *
 *     WhatsApp  →  "8801892740307"      (canonicalised — see normalizeCustomerId)
 *     Messenger →  "fb:105316893089913" (PSID, prefixed)
 *
 * ⚠️ **This is why `normalizeCustomerId` exists rather than a raw regex at the call site.**
 * The session layer currently cleans keys with `phone.replace(/[^\d+]/g, '')`, which would
 * strip the `fb:` prefix and leave a bare 15-17 digit string — indistinguishable from a
 * phone number, and liable to collide with a real customer's. Any code path that handles a
 * Messenger identity must go through this helper instead.
 *
 * NOT YET WIRED INTO `session/manager.ts` — that file still uses its own inline replace. This
 * helper exists so the Messenger path has correct normalisation ready, and so the swap in
 * Phase 2 is a mechanical change at known call sites rather than a hunt.
 */

import { toCanonicalPhone } from '../../utils/phone';

export const MESSENGER_PREFIX = 'fb:';

/** True when a customer key refers to a Messenger PSID rather than a WhatsApp number. */
export function isMessengerId(customerId: string): boolean {
  return customerId.startsWith(MESSENGER_PREFIX);
}

/**
 * Canonical form of a customer key. Total function: safe to call on any string.
 *
 * WhatsApp keys go through `toCanonicalPhone`, so `"+8801892740307"`, `"01892740307"` and
 * `"8801892740307"` all resolve to the SAME key. They previously did not, which split one
 * customer across several `sessions` rows — separate histories, separate handoff locks.
 *
 * ⚠️ This is deliberately NOT byte-identical to the old `replace(/[^\d+]/g, '')` any more.
 * Existing rows whose key was a `+…` or `01…` form must be merged by
 * `scripts/migrate-phone-keys.ts`; until that runs, those customers simply keep using their
 * old row for reads and start a new canonical one for writes.
 */
export function normalizeCustomerId(customerId: string): string {
  if (isMessengerId(customerId)) {
    const psid = customerId.slice(MESSENGER_PREFIX.length).replace(/\D/g, '');
    return psid ? `${MESSENGER_PREFIX}${psid}` : '';
  }
  return toCanonicalPhone(customerId);
}

/** Build the session key for a Messenger sender. */
export function messengerCustomerId(psid: string): string {
  return normalizeCustomerId(`${MESSENGER_PREFIX}${psid}`);
}

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
 *     WhatsApp  →  "8801892740307"      (unchanged, exactly as today)
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

export const MESSENGER_PREFIX = 'fb:';

/** True when a customer key refers to a Messenger PSID rather than a WhatsApp number. */
export function isMessengerId(customerId: string): boolean {
  return customerId.startsWith(MESSENGER_PREFIX);
}

/**
 * Canonical form of a customer key. Total function: safe to call on any string, and
 * byte-identical to the previous `replace(/[^\d+]/g, '')` behaviour for every WhatsApp input,
 * so swapping the call sites cannot re-key existing sessions.
 */
export function normalizeCustomerId(customerId: string): string {
  if (isMessengerId(customerId)) {
    const psid = customerId.slice(MESSENGER_PREFIX.length).replace(/\D/g, '');
    return psid ? `${MESSENGER_PREFIX}${psid}` : '';
  }
  return customerId.replace(/[^\d+]/g, '');
}

/** Build the session key for a Messenger sender. */
export function messengerCustomerId(psid: string): string {
  return normalizeCustomerId(`${MESSENGER_PREFIX}${psid}`);
}

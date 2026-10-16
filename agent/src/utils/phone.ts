/**
 * The single canonical form of a phone number.
 *
 * Used for **customer identity**, where the value is a PRIMARY KEY — so this function decides
 * whether two messages belong to the same person. It was previously admin-only
 * (`data/settings.ts`), which is how the same customer ended up in several `sessions` rows:
 * `"+8801892740307"`, `"8801892740307"` and `"01892740307"` were three distinct keys, with
 * three separate conversation histories and three separate human-handoff locks.
 *
 * Rules:
 *   - strip every non-digit (so a leading `+`, spaces and dashes all vanish — this is what
 *     collapses `+880…` onto `880…`)
 *   - rewrite an 11-digit Bangladesh national mobile (`01…`) to international (`88…`)
 *
 * ⚠️ The `length === 11` guard is load-bearing and must not be relaxed. WhatsApp LIDs are
 * ~15 digits and are used as a fallback customer id when the bridge cannot resolve one to a
 * phone number; without the length check, a LID that happened to start with `01` would be
 * rewritten into something that looks like a subscriber number.
 *
 * Deliberately a pure module with no imports: it sits on the customer-identity path, which
 * includes the Messenger webhook and its test harness, and pulling in the database pool there
 * would be both unnecessary and surprising.
 */
export function toCanonicalPhone(rawPhone: string): string {
  if (!rawPhone) return '';
  let cleaned = rawPhone.replace(/[^\d]/g, '');
  // If Bangladesh local mobile (e.g. 01892740307 - 11 digits starting with 01)
  if (cleaned.startsWith('01') && cleaned.length === 11) {
    cleaned = '88' + cleaned;
  }
  return cleaned;
}

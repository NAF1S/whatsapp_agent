import crypto from 'crypto';

/**
 * Verify Meta's `X-Hub-Signature-256` webhook signature.
 *
 * Meta signs the request with HMAC-SHA256, keyed on the App Secret, and sends the result as
 * lowercase hex prefixed with `sha256=`. Three things are easy to get wrong here:
 *
 * 1. **It must be the raw bytes.** Meta signs an *escaped-unicode* rendering of the payload.
 *    Re-serialising the parsed JSON object will not reproduce it, and if `express.json()` has
 *    already consumed the body the original bytes are gone. That is why the webhook route
 *    installs `express.raw()` before the global JSON parser — see `webhook.ts`.
 * 2. **Compare in constant time.** An early-exit `===` leaks how much of the expected value
 *    was guessed correctly.
 * 3. **Reject non-hex before buffering.** `Buffer.from(x, 'hex')` silently truncates at the
 *    first invalid character, so a malformed header could otherwise compare short-but-equal.
 */
export function verifyWebhookSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  appSecret: string,
): boolean {
  if (!appSecret) return false;
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;

  const providedHex = signatureHeader.slice('sha256='.length).trim();
  if (!providedHex || !/^[0-9a-f]+$/i.test(providedHex)) return false;

  const expected = crypto.createHmac('sha256', appSecret).update(rawBody).digest();

  let provided: Buffer;
  try {
    provided = Buffer.from(providedHex, 'hex');
  } catch {
    return false;
  }

  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

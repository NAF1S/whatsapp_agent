import { sendWhatsAppMessage, sendWhatsAppImage } from './whatsapp/send';
import { sendText, sendImageUrl, isMessengerConfigured } from './messenger/client';
import { isMessengerId, MESSENGER_PREFIX } from './messenger/identity';
import { logger } from '../utils/logger';

/**
 * Channel-agnostic outbound send.
 *
 * **How the channel is decided:** from the recipient id alone, not from a parameter threaded
 * through every caller. Messenger ids are namespaced `fb:<psid>` (see `messenger/identity.ts`)
 * and WhatsApp recipient ids are JIDs (`<digits>@s.whatsapp.net`), so the prefix is an
 * unambiguous discriminator. This keeps the change small: `sendMessage`/`sendImage` replace
 * the old direct calls with the same signature, and no function upstream has to learn about
 * channels.
 *
 * ⚠️ The one thing this relies on: **every** outbound recipient must already be in its
 * canonical form. `sessionId`/`targetJid` are (the worker passes the bridge's JID straight
 * through, and the Messenger webhook passes `fb:<psid>`), but anything that hands us a bare
 * PSID without the prefix would be misrouted to the WhatsApp bridge. Normalise first via
 * `messengerCustomerId()`.
 */

export function channelOf(recipient: string): 'messenger' | 'whatsapp' {
  return isMessengerId(recipient) ? 'messenger' : 'whatsapp';
}

/** `fb:12345` → `12345`. Meta's API takes the raw PSID, never our namespaced session key. */
export function toMessengerPsid(recipient: string): string {
  return recipient.slice(MESSENGER_PREFIX.length);
}

export async function sendMessage(to: string, text: string): Promise<boolean> {
  if (channelOf(to) === 'messenger') {
    if (!isMessengerConfigured()) {
      // Should be unreachable: a Messenger job can only exist if the channel is configured.
      // Loud, because silently dropping a customer reply is the worst outcome here.
      logger.error({ to }, 'Messenger reply requested but the channel is not configured — reply DROPPED');
      return false;
    }
    const res = await sendText(toMessengerPsid(to), text);
    return res.success;
  }
  return sendWhatsAppMessage(to, text);
}

export async function sendImage(to: string, imageUrl: string, caption = ''): Promise<boolean> {
  if (channelOf(to) === 'messenger') {
    if (!isMessengerConfigured()) {
      logger.error({ to }, 'Messenger image send requested but the channel is not configured');
      return false;
    }
    const psid = toMessengerPsid(to);
    // Meta's attachment payload has no caption field, so the caption (which carries the
    // product name and price) goes as its own message first rather than being lost.
    if (caption) await sendText(psid, caption);
    const res = await sendImageUrl(psid, imageUrl);
    return res.success;
  }
  return sendWhatsAppImage(to, imageUrl, caption);
}

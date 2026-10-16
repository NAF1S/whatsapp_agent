import axios from 'axios';
import { config } from '../../config';
import { logger } from '../../utils/logger';

/**
 * Outbound WhatsApp sends, via the local Baileys bridge HTTP API.
 *
 * These live here rather than in `queue/worker.ts` so that `channels/dispatch.ts` can reach
 * them without a circular import (worker → dispatch → worker). `worker.ts` re-exports
 * `sendWhatsAppMessage`, so existing importers — the admin reply route in `index.ts` and the
 * escalation notifier — are unchanged.
 *
 * Behaviour is byte-identical to the previous inline implementations: same URL, same body,
 * same 15s timeout, same `success === true` check.
 */

export async function sendWhatsAppMessage(toJid: string, text: string): Promise<boolean> {
  const bridgeUrl = `${config.whatsapp.bridgeUrl}/send`;
  try {
    const res = await axios.post(bridgeUrl, { to: toJid, text }, { timeout: 15000 });
    return res.data?.success === true;
  } catch (err: any) {
    logger.error({ err: err.message, to: toJid, bridgeUrl }, 'Failed to send message via WhatsApp bridge');
    return false;
  }
}

export async function sendWhatsAppImage(
  toJid: string,
  imageUrl: string,
  caption = '',
): Promise<boolean> {
  const bridgeUrl = `${config.whatsapp.bridgeUrl}/send-image`;
  try {
    const res = await axios.post(bridgeUrl, { to: toJid, imageUrl, caption }, { timeout: 15000 });
    return res.data?.success === true;
  } catch (err: any) {
    logger.error({ err: err.message, to: toJid, imageUrl }, 'Failed to send image via WhatsApp bridge');
    return false;
  }
}

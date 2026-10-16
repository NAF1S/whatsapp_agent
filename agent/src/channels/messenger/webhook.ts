import express, { Request, Response, Router } from 'express';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { verifyWebhookSignature } from './signature';
import { isMessengerConfigured } from './client';
import { messengerCustomerId } from './identity';

/**
 * Inbound side of the Messenger channel.
 *
 * ⚠️ **Mounting order is load-bearing.** This router installs `express.raw()` so it can see
 * the exact bytes Meta signed. If the global `express.json()` in `index.ts` runs first it
 * will have already consumed and parsed the body, `express.raw()` will skip (body-parser
 * sets `req._body`), and the signature will never verify. `index.ts` therefore mounts this
 * router *before* the JSON parser. Do not reorder those two lines.
 *
 * Phase 1 (this file, as deployed): verify, parse, log, return 200. It deliberately does NOT
 * enqueue anything — the worker is not channel-aware yet, and handing it a Messenger job now
 * would send a reply to a PSID through the WhatsApp bridge. Enqueueing arrives with Phase 2.
 */

interface MessengerSender {
  id: string;
}

interface MessengerAttachment {
  type: string;
  payload?: { url?: string };
}

interface MessengerMessage {
  mid?: string;
  text?: string;
  is_echo?: boolean;
  attachments?: MessengerAttachment[];
  quick_reply?: { payload?: string };
}

interface MessagingEvent {
  sender?: MessengerSender;
  recipient?: MessengerSender;
  timestamp?: number;
  message?: MessengerMessage;
  postback?: { payload?: string; title?: string };
  delivery?: unknown;
  read?: unknown;
  reaction?: unknown;
}

interface WebhookEntry {
  id?: string;
  time?: number;
  messaging?: MessagingEvent[];
}

interface WebhookBody {
  object?: string;
  entry?: WebhookEntry[];
}

/**
 * Reduce one `messaging` event to something loggable. Returns null for anything that is not a
 * customer message we should act on — echoes especially, which would otherwise be a feedback
 * loop (the bot's own replies arriving back as inbound events).
 */
function describeEvent(event: MessagingEvent): {
  psid: string;
  customerId: string;
  kind: 'text' | 'image' | 'audio' | 'video' | 'file' | 'postback' | 'other';
  preview: string;
  mid?: string;
} | null {
  const psid = event.sender?.id;
  if (!psid) return null;

  const customerId = messengerCustomerId(psid);

  if (event.message) {
    // The bot's own outgoing messages arrive back as events. Dropping them is mandatory.
    if (event.message.is_echo) return null;

    const attachment = event.message.attachments?.[0];
    if (attachment) {
      const t = (attachment.type || '').toLowerCase();
      const kind =
        t === 'image' ? 'image' : t === 'audio' ? 'audio' : t === 'video' ? 'video' : 'file';
      return {
        psid,
        customerId,
        kind,
        preview: `[${attachment.type}]`,
        mid: event.message.mid,
      };
    }

    if (typeof event.message.text === 'string') {
      return {
        psid,
        customerId,
        kind: 'text',
        preview: event.message.text.slice(0, 120),
        mid: event.message.mid,
      };
    }

    if (event.message.quick_reply) {
      return {
        psid,
        customerId,
        kind: 'text',
        preview: `[quick_reply] ${event.message.quick_reply.payload ?? ''}`,
        mid: event.message.mid,
      };
    }
    return null;
  }

  if (event.postback) {
    return {
      psid,
      customerId,
      kind: 'postback',
      preview: event.postback.title || event.postback.payload || '',
    };
  }

  // delivery / read / reaction / policy events: real, but nothing to act on yet.
  return null;
}

/** Parse a full webhook payload into the events worth logging. Pure — unit-testable. */
export function parseWebhookEvents(body: WebhookBody): NonNullable<ReturnType<typeof describeEvent>>[] {
  const out: NonNullable<ReturnType<typeof describeEvent>>[] = [];
  for (const entry of body?.entry ?? []) {
    for (const event of entry?.messaging ?? []) {
      const described = describeEvent(event);
      if (described) out.push(described);
    }
  }
  return out;
}

export const messengerWebhookRouter: Router = express.Router();

/**
 * Meta's subscription handshake. It calls this once when the webhook is saved, and expects the
 * raw challenge value echoed back as plain text.
 *
 * 503 rather than 403 when unconfigured: a 403 would be indistinguishable from a wrong verify
 * token, which is the single most confusing failure when setting this up.
 */
messengerWebhookRouter.get('/', (req: Request, res: Response) => {
  if (!isMessengerConfigured()) {
    logger.warn('Messenger verification attempted but the channel is not configured');
    return res.status(503).send('Messenger channel not configured');
  }

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === config.messenger.verifyToken) {
    logger.info('Messenger webhook verified by Meta');
    return res.status(200).send(String(challenge));
  }

  logger.warn({ mode }, 'Messenger webhook verification failed (mode/token mismatch)');
  return res.status(403).send('Forbidden');
});

/**
 * Event delivery. Always answer 200 once the signature checks out: Meta retries failures
 * immediately, and after roughly an hour of them it disables and removes the subscription —
 * so a 500 here costs you the whole channel, not one message.
 */
messengerWebhookRouter.post('/', express.raw({ type: '*/*' }), (req: Request, res: Response) => {
  if (!isMessengerConfigured()) {
    return res.status(503).send('Messenger channel not configured');
  }

  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const signature = req.headers['x-hub-signature-256'] as string | undefined;

  if (!verifyWebhookSignature(rawBody, signature, config.messenger.appSecret)) {
    logger.warn({ ip: req.ip }, 'Messenger webhook rejected: bad or missing signature');
    return res.status(401).send('Invalid signature');
  }

  // Acknowledge first — Meta's guidance is to return quickly, and our processing is not
  // allowed to delay it. Anything slow belongs on the queue, not in this handler.
  res.status(200).send('EVENT_RECEIVED');

  try {
    const body = JSON.parse(rawBody.toString('utf8')) as WebhookBody;

    if (body.object !== 'page') {
      logger.warn({ object: body.object }, 'Messenger webhook for unexpected object type');
      return;
    }

    const events = parseWebhookEvents(body);
    logger.info({ count: events.length }, 'Messenger webhook received');

    for (const event of events) {
      // Phase 1: observe only. No enqueue, no reply — see the header comment.
      logger.info(
        {
          channel: 'messenger',
          customerId: event.customerId,
          kind: event.kind,
          mid: event.mid,
          preview: event.preview,
        },
        'Messenger inbound event (phase 1: logged only, not replied to)',
      );
    }
  } catch (err) {
    // Parsing failed, but the signature was valid and we have already replied 200. Swallowing
    // is correct: an uncaught throw here would 500 on an already-sent response and gain nothing.
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'Messenger webhook body could not be parsed',
    );
  }
});

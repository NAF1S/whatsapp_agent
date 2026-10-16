import express, { Request, Response, Router } from 'express';
import { config } from '../../config';
import { logger } from '../../utils/logger';
import { IncomingRawPayload } from '../../preprocessor';
import { enqueueIncoming } from '../../queue/producer';
import { verifyWebhookSignature } from './signature';
import { isMessengerConfigured, sendTypingOn, fetchAttachment } from './client';
import { messengerCustomerId } from './identity';

/**
 * Inbound side of the Messenger channel.
 *
 * ⚠️ **Mounting order is load-bearing.** This router installs `express.raw()` so it can see
 * the exact bytes Meta signed. If the global `express.json()` in `index.ts` runs first it
 * will have already consumed and parsed the body, `express.raw()` will skip (body-parser
 * sets `req._body`), and the signature will never verify. `index.ts` therefore mounts this
 * router *before* the JSON parser. Do not reorder those two lines.
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

type EventKind = 'text' | 'image' | 'audio' | 'video' | 'file' | 'postback';

export interface DescribedEvent {
  psid: string;
  customerId: string;
  kind: EventKind;
  preview: string;
  mid?: string;
  /** The customer's text, if any. */
  text: string;
  /** Present for media; Meta's CDN URL, requiring the page token to download. */
  attachmentUrl?: string;
}

/**
 * Reduce one `messaging` event to something actionable. Returns null for anything that is not
 * a customer message we should act on — echoes especially, which would otherwise be a feedback
 * loop (the bot's own replies arriving back as inbound events).
 */
function describeEvent(event: MessagingEvent): DescribedEvent | null {
  const psid = event.sender?.id;
  if (!psid) return null;

  const customerId = messengerCustomerId(psid);

  if (event.message) {
    if (event.message.is_echo) return null;

    const attachment = event.message.attachments?.[0];
    if (attachment) {
      const t = (attachment.type || '').toLowerCase();
      const kind: EventKind =
        t === 'image' ? 'image' : t === 'audio' ? 'audio' : t === 'video' ? 'video' : 'file';
      return {
        psid,
        customerId,
        kind,
        preview: `[${attachment.type}]`,
        mid: event.message.mid,
        text: typeof event.message.text === 'string' ? event.message.text : '',
        attachmentUrl: attachment.payload?.url,
      };
    }

    if (typeof event.message.text === 'string') {
      return {
        psid,
        customerId,
        kind: 'text',
        preview: event.message.text.slice(0, 120),
        mid: event.message.mid,
        text: event.message.text,
      };
    }

    if (event.message.quick_reply) {
      const payload = event.message.quick_reply.payload ?? '';
      return {
        psid,
        customerId,
        kind: 'text',
        preview: `[quick_reply] ${payload}`,
        mid: event.message.mid,
        text: payload,
      };
    }
    return null;
  }

  if (event.postback) {
    const title = event.postback.title || event.postback.payload || '';
    return { psid, customerId, kind: 'postback', preview: title, text: title };
  }

  // delivery / read / reaction / policy events: real, but nothing to act on.
  return null;
}

/** Parse a full webhook payload into the events worth acting on. Pure — unit-testable. */
export function parseWebhookEvents(body: WebhookBody): DescribedEvent[] {
  const out: DescribedEvent[] = [];
  for (const entry of body?.entry ?? []) {
    for (const event of entry?.messaging ?? []) {
      const described = describeEvent(event);
      if (described) out.push(described);
    }
  }
  return out;
}

/**
 * Per-customer debounce, mirroring the WhatsApp bridge's 3-second window.
 *
 * Without this, a customer who sends "hi" then "price koto?" a second apart gets two separate
 * brain runs and two replies — noticeably worse than the WhatsApp experience. The bridge
 * solves it the same way; this is the equivalent for a channel with no socket to buffer on.
 *
 * In-memory and per-process, which is safe here because the agent runs as a single instance
 * (a second worker would already break the per-customer mutex — see AGENT.md).
 */
interface BufferedItem {
  mid?: string;
  kind: EventKind;
  text: string;
  mediaBase64?: string;
  mimeType?: string;
}

interface Buffer {
  items: BufferedItem[];
  timer: NodeJS.Timeout;
  typingSent: boolean;
}

const DEBOUNCE_MS = 3000;
const buffers = new Map<string, Buffer>();

function buildPayload(customerId: string, items: BufferedItem[]): IncomingRawPayload {
  const combinedText = items
    .map((i) => i.text)
    .filter(Boolean)
    .join('\n');

  const images = items.filter((i) => i.kind === 'image' && i.mediaBase64);
  const audio = items.find((i) => i.kind === 'audio' && i.mediaBase64);

  const payload: IncomingRawPayload = {
    channel: 'messenger',
    // Identity AND destination are the same namespaced key for Messenger: there is no JID to
    // resolve, and channels/dispatch.ts routes on the `fb:` prefix.
    sessionId: customerId,
    senderPhone: customerId,
    messageType: 'text',
    textPayload: combinedText,
    timestamp: Date.now(),
    // Messenger has no equivalent of the bridge's global pause flag; the admin pause toggle
    // is WhatsApp-specific. Escalation/handoff still applies normally.
    isBotPaused: false,
  };

  if (images.length > 0) {
    payload.messageType = 'image';
    payload.caption = combinedText;
    payload.mediaBase64 = images[0].mediaBase64;
    payload.mimeType = images[0].mimeType || 'image/jpeg';
    payload.mediaList = images.map((i) => ({
      mediaBase64: i.mediaBase64 as string,
      mimeType: i.mimeType || 'image/jpeg',
      caption: combinedText,
    }));
  } else if (audio) {
    payload.messageType = 'audio';
    payload.caption = combinedText;
    payload.mediaBase64 = audio.mediaBase64;
    payload.mimeType = audio.mimeType || 'audio/mpeg';
  } else if (!combinedText) {
    // Media we could not fetch, or an event type we cannot turn into text. Be explicit rather
    // than sending an empty string, so the brain can respond to the customer instead of
    // silently producing nothing.
    payload.textPayload =
      '[Customer sent something that could not be read. Ask them politely to resend as text.]';
  }

  return payload;
}

async function flush(customerId: string): Promise<void> {
  const buffer = buffers.get(customerId);
  if (!buffer) return;
  buffers.delete(customerId);

  const items = buffer.items;
  if (items.length === 0) return;

  const payload = buildPayload(customerId, items);

  // Deduplicate on the message ids so a Meta redelivery cannot produce a second reply.
  const mids = items.map((i) => i.mid).filter(Boolean) as string[];
  const jobId = mids.length
    ? `ms-${mids.sort().join('|').slice(0, 180)}`
    : `ms-${customerId}-${Date.now()}`;

  try {
    await enqueueIncoming(payload, jobId);
    logger.info(
      { channel: 'messenger', customerId, items: items.length, messageType: payload.messageType, jobId },
      'Messenger message enqueued for processing',
    );
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), customerId },
      'Failed to enqueue Messenger message — customer will not get a reply',
    );
  }
}

async function bufferEvent(event: DescribedEvent): Promise<void> {
  let buffer = buffers.get(event.customerId);
  if (!buffer) {
    buffer = { items: [], timer: setTimeout(() => {}, 0), typingSent: false };
    buffers.set(event.customerId, buffer);

    // Fire-and-forget: Meta expects the webhook to answer fast, and a failed typing indicator
    // must never delay or block the actual reply. Sent once per burst, not per message.
    if (isMessengerConfigured()) {
      buffer.typingSent = true;
      void sendTypingOn(event.psid);
    }
  }

  let mediaBase64: string | undefined;
  let mimeType: string | undefined;
  if (event.attachmentUrl) {
    const fetched = await fetchAttachment(event.attachmentUrl);
    if (fetched) {
      mediaBase64 = fetched.buffer.toString('base64');
      mimeType = fetched.mimeType;
    } else {
      logger.warn({ customerId: event.customerId }, 'Could not download Messenger attachment');
    }
  }

  buffer.items.push({
    mid: event.mid,
    kind: event.kind,
    text: event.text,
    mediaBase64,
    mimeType,
  });

  clearTimeout(buffer.timer);
  buffer.timer = setTimeout(() => {
    void flush(event.customerId);
  }, DEBOUNCE_MS);
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

  // Acknowledge first — Meta's guidance is to return quickly, and nothing we do here is
  // allowed to delay it. Processing happens after the response has been sent.
  res.status(200).send('EVENT_RECEIVED');

  void (async () => {
    try {
      const body = JSON.parse(rawBody.toString('utf8')) as WebhookBody;

      if (body.object !== 'page') {
        logger.warn({ object: body.object }, 'Messenger webhook for unexpected object type');
        return;
      }

      const events = parseWebhookEvents(body);
      logger.info({ count: events.length }, 'Messenger webhook received');

      if (!config.messenger.enqueueEnabled) {
        for (const event of events) {
          logger.info(
            { channel: 'messenger', customerId: event.customerId, kind: event.kind, mid: event.mid, preview: event.preview },
            'Messenger inbound event (MESSENGER_ENQUEUE=false: logged only, not replied to)',
          );
        }
        return;
      }

      // Sequential so a burst from one customer keeps its order.
      for (const event of events) {
        await bufferEvent(event);
      }
    } catch (err) {
      // The signature was valid and we have already replied 200. Swallowing is correct: an
      // uncaught throw here would try to send a second response and gain nothing.
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Messenger webhook processing failed',
      );
    }
  })();
});

import crypto from 'crypto';
import axios from 'axios';
import { config } from '../../config';
import { logger } from '../../utils/logger';

/**
 * Outbound side of the Messenger channel (Graph API).
 *
 * Unlike WhatsApp there is no bridge process and no socket to hold open — these are plain
 * authenticated HTTPS calls Meta makes on our behalf, so they run in-process. Nothing here is
 * wired into the worker yet: this channel is being built alongside a live WhatsApp path and
 * the send dispatch lands in Phase 2.
 *
 * ⚠️ Messenger is subject to a **24-hour messaging window**: sends after it closes fail with
 * error 1545041. And Meta's policy requires bots to respond within 30 seconds, which this
 * agent's 9-37s latency does not reliably meet — hence `sendTypingOn` and the planned
 * immediate acknowledgement (`sendText` is used for both).
 */

/** Meta's hard limit is 2000 characters per message. Leave margin and split on the boundary. */
const MAX_TEXT_LENGTH = 1900;

/**
 * All four values are needed for anything to work. The webhook and the worker both gate on
 * this, so a half-filled .env degrades to "channel off" rather than "channel on and failing".
 */
export function isMessengerConfigured(): boolean {
  const m = config.messenger;
  return Boolean(m.pageId && m.pageAccessToken && m.appSecret && m.verifyToken);
}

function messagesUrl(): string {
  return `https://graph.facebook.com/${config.messenger.graphVersion}/${config.messenger.pageId}/messages`;
}

/**
 * `appsecret_proof` is an HMAC of the access token keyed with the App Secret. Meta recommends
 * it: it means a leaked access token alone is not enough to call the API. Cheap to add.
 */
function appSecretProof(): string {
  return crypto
    .createHmac('sha256', config.messenger.appSecret)
    .update(config.messenger.pageAccessToken)
    .digest('hex');
}

/**
 * Split text into sendable chunks without breaking surrogate pairs or Bengali graphemes
 * mid-way — the customer base writes in Bengali/Banglish, and slicing a multi-byte character
 * produces visible replacement characters.
 */
export function splitMessage(text: string, limit = MAX_TEXT_LENGTH): string[] {
  const codePoints = Array.from(text);
  if (codePoints.length <= limit) return [text];

  const chunks: string[] = [];
  let current: string[] = [];

  // Prefer to break on a newline, then a space, then anywhere — never mid-word if avoidable.
  for (const ch of codePoints) {
    current.push(ch);
    if (current.length >= limit) {
      let breakAt = -1;
      for (let i = current.length - 1; i > limit * 0.6; i--) {
        if (current[i] === '\n' || current[i] === ' ') {
          breakAt = i;
          break;
        }
      }
      if (breakAt > 0) {
        chunks.push(current.slice(0, breakAt).join(''));
        current = current.slice(breakAt + 1);
      } else {
        chunks.push(current.join(''));
        current = [];
      }
    }
  }
  if (current.length) chunks.push(current.join(''));
  return chunks;
}

interface SendResult {
  success: boolean;
  error?: string;
  messageId?: string;
}

async function graphPost(body: Record<string, unknown>, what: string): Promise<SendResult> {
  if (!isMessengerConfigured()) {
    logger.warn({ what }, 'Messenger send attempted but the channel is not configured');
    return { success: false, error: 'Messenger channel not configured' };
  }

  try {
    const res = await axios.post(
      messagesUrl(),
      { ...body, appsecret_proof: appSecretProof() },
      {
        headers: { Authorization: `Bearer ${config.messenger.pageAccessToken}` },
        timeout: 15000,
      },
    );
    return { success: true, messageId: res.data?.message_id };
  } catch (err) {
    // Meta returns a useful error body; surface it rather than a bare axios message, because
    // the difference between "window closed" (1545041) and "bad token" (190) matters.
    const data = axios.isAxiosError(err) ? err.response?.data : undefined;
    const detail = data?.error
      ? `code=${data.error.code} subcode=${data.error.error_subcode} ${data.error.message}`
      : err instanceof Error
        ? err.message
        : String(err);
    logger.error({ what, detail }, 'Messenger API call failed');
    return { success: false, error: detail };
  }
}

/**
 * Reply to a customer. `messaging_type: 'RESPONSE'` is required for a reply inside the
 * 24-hour window and is the only type a bot of ours should be sending.
 */
export async function sendText(psid: string, text: string): Promise<SendResult> {
  const chunks = splitMessage(text);
  let last: SendResult = { success: false, error: 'no chunks' };

  for (const chunk of chunks) {
    last = await graphPost(
      {
        recipient: { id: psid },
        messaging_type: 'RESPONSE',
        message: { text: chunk },
      },
      'sendText',
    );
    if (!last.success) return last;
  }
  return last;
}

/**
 * Typing indicator. Given p90 latency of 23-37s, this is the difference between "working on
 * it" and "broken" from the customer's side. The WhatsApp path has no equivalent.
 */
export async function sendTypingOn(psid: string): Promise<SendResult> {
  return graphPost({ recipient: { id: psid }, sender_action: 'typing_on' }, 'sendTypingOn');
}

export async function sendTypingOff(psid: string): Promise<SendResult> {
  return graphPost({ recipient: { id: psid }, sender_action: 'typing_off' }, 'sendTypingOff');
}

export async function markSeen(psid: string): Promise<SendResult> {
  return graphPost({ recipient: { id: psid }, sender_action: 'mark_seen' }, 'markSeen');
}

/**
 * Send a catalog photo by URL. Meta fetches the URL itself, so no download is needed here —
 * unlike WhatsApp, where the bridge pre-fetches into a Buffer before handing it to Baileys.
 */
export async function sendImageUrl(psid: string, imageUrl: string): Promise<SendResult> {
  return graphPost(
    {
      recipient: { id: psid },
      messaging_type: 'RESPONSE',
      message: { attachment: { type: 'image', payload: { url: imageUrl, is_reusable: true } } },
    },
    'sendImageUrl',
  );
}

/**
 * Download an inbound attachment. Meta's attachment URLs require the page token, and for
 * images you must request the image itself — asking without that redirect returns an HTML
 * page, not the picture.
 */
export async function fetchAttachment(
  url: string,
): Promise<{ buffer: Buffer; mimeType?: string } | null> {
  if (!isMessengerConfigured()) return null;
  try {
    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${config.messenger.pageAccessToken}` },
      params: { access_token: config.messenger.pageAccessToken },
      responseType: 'arraybuffer',
      timeout: 20000,
      maxRedirects: 5,
    });
    const contentType = res.headers?.['content-type'];
    return {
      buffer: Buffer.from(res.data),
      mimeType: typeof contentType === 'string' ? contentType : undefined,
    };
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'Messenger attachment download failed',
    );
    return null;
  }
}

/**
 * Reply shaping for WhatsApp/Messenger.
 *
 * The store wants replies to read like a real shop assistant: a separate greeting, then the
 * answer broken into a few short messages — not one long paragraph. The brain is instructed
 * to emit a `<<<MSG>>>` token between messages; this module turns that into discrete sends,
 * and applies a deterministic tone guard because prompt instructions alone do not reliably
 * stop emoji spam.
 */

/** Token the system prompt tells the model to put between messages. */
export const SEGMENT_TOKEN = '<<<MSG>>>';

/** Hard limit on bubbles per reply. Overflow is merged into the last message. */
const MAX_PARTS = 4;

/** Above this length a single unsplit reply is broken on sentence boundaries. */
const FALLBACK_SPLIT_AT = 320;

/** Target size of a fallback-split chunk. */
const FALLBACK_CHUNK = 220;

/** Send gap, so four bubbles do not arrive as one burst (milliseconds). */
export const PART_DELAY_MS = 700;

/** Any pictographic emoji, plus an optional variation selector. */
const ANY_EMOJI = /\p{Extended_Pictographic}️?/gu;

/**
 * Remove every emoji from outbound text.
 * Prompt rules alone are not reliable — this is the deterministic backstop.
 */
export function toneDownEmojis(text: string): string {
  // Strip EVERY pictographic emoji. The earlier "sentimental blocklist + keep one neutral
  // emoji" rule still let 🙂 through on every single reply, because 🙂 was not on the list
  // and became the one survivor. The store wants none, so none is what this enforces.
  return text
    .replace(ANY_EMOJI, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([.,!?।;:])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/**
 * Break a reply that ignored the `<<<MSG>>>` format into sentence-sized chunks, so the
 * customer still gets small messages instead of a wall of text.
 */
function splitSentences(text: string): string[] {
  const sentences = text.match(/[^।.!?\n]+[।.!?]+|[^।.!?\n]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  if (sentences.length < 2) return [text];

  const chunks: string[] = [];
  let buffer = '';
  for (const sentence of sentences) {
    if (buffer && buffer.length + sentence.length + 1 > FALLBACK_CHUNK) {
      chunks.push(buffer);
      buffer = sentence;
    } else {
      buffer = buffer ? `${buffer} ${sentence}` : sentence;
    }
  }
  if (buffer) chunks.push(buffer);
  return chunks;
}

/**
 * Turn the model's reply into the bubbles that will be sent, in order.
 * Always returns at least one non-empty part for non-empty input.
 */
export function splitMessageParts(text: string): string[] {
  const raw = String(text ?? '').trim();
  if (!raw) return [];

  let parts = raw
    .split(/<<<MSG>>>|\n\s*\[\[MSG\]\]\s*\n/gi)
    .map((part) => toneDownEmojis(part.trim()))
    .filter(Boolean);

  // Models do not always obey the `<<<MSG>>>` instruction — observed live: one reply used
  // the token, the next wrote the same shape as four newline-separated lines. Treat each
  // non-empty line as its own bubble so the customer still gets small messages.
  if (parts.length === 1) {
    const lines = parts[0]
      .split(/\n+/)
      .map((line) => toneDownEmojis(line.trim()))
      .filter(Boolean);
    if (lines.length > 1) parts = lines;
  }

  // Last resort for one long paragraph: break it on sentence boundaries.
  if (parts.length === 1 && raw.length > FALLBACK_SPLIT_AT) {
    parts = splitSentences(parts[0]).map(toneDownEmojis).filter(Boolean);
  }

  if (parts.length === 0) return [];
  if (parts.length > MAX_PARTS) {
    parts = [...parts.slice(0, MAX_PARTS - 1), parts.slice(MAX_PARTS - 1).join(' ')];
  }

  return parts;
}

/** The reply as one readable string, for storage and conversation history. */
export function stripSegmentTokens(text: string): string {
  return String(text ?? '')
    .replace(/\n?\s*<<<MSG>>>\s*\n?/gi, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

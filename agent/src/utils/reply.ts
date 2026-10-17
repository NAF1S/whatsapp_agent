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

/**
 * Emojis that read as sentimental/over-familiar in a shop conversation. Removed outright —
 * one stray heart is exactly what the store asked to stop.
 */
const SENTIMENTAL_EMOJI = new Set<number>([
  0x2764, // red heart
  0x263a, // smiling face
  0x1f493, // beating hearts
  0x1f495, // two hearts
  0x1f496, // sparkling heart
  0x1f497, // growing heart
  0x1f498, // heart with arrow
  0x1f49d, // heart with ribbon
  0x1f49e, // revolving hearts
  0x1f48b, // kiss mark
  0x1f48c, // love letter
  0x1f60a, // smiling face with smiling eyes
  0x1f60d, // heart eyes
  0x1f618, // blowing a kiss
  0x1f617, // kissing face
  0x1f619, // kissing face with smiling eyes
  0x1f61a, // kissing face with closed eyes
  0x1f63b, // smiling cat with heart eyes
  0x1f64f, // folded hands
  0x1f917, // hugging face
  0x1f970, // smiling face with hearts
  0x1f973, // partying face
  0x1f97a, // pleading face
  0x2728, // sparkles
  0x1f338, // cherry blossom
  0x1f490, // bouquet
  0x1f9e1, // orange heart
  0x1f49b, // yellow heart
  0x1f49a, // green heart
  0x1f499, // blue heart
  0x1f49c, // purple heart
  0x1f5a4, // black heart
  0x1f90d, // white heart
  0x1f90e, // brown heart
  0x1faf6, // heart hands
  0x1fac2, // people hugging
]);

/** Any pictographic emoji, plus an optional variation selector. */
const ANY_EMOJI = /\p{Extended_Pictographic}️?/gu;

/**
 * Strip sentimental emojis, then keep at most one remaining emoji per message.
 * Prompt rules alone are not reliable — this is the deterministic backstop.
 */
export function toneDownEmojis(text: string): string {
  let out = text.replace(ANY_EMOJI, (match) => {
    const cp = match.codePointAt(0);
    return cp != null && SENTIMENTAL_EMOJI.has(cp) ? '' : match;
  });

  let kept = 0;
  out = out.replace(ANY_EMOJI, (match) => (++kept > 1 ? '' : match));

  return out
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

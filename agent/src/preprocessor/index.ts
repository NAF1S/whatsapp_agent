import { gemini } from '../brain/gemini';
import { deepseek } from '../brain/deepseek';
import { logger } from '../utils/logger';

export interface IncomingRawPayload {
  /**
   * Which channel this message arrived on. Optional and defaulted to 'whatsapp' so every
   * existing producer keeps working untouched — the WhatsApp bridge does not set it, and the
   * worker treats an absent value as WhatsApp.
   */
  channel?: 'whatsapp' | 'messenger';
  sessionId: string;
  senderPhone: string;
  messageType: 'text' | 'audio' | 'image' | 'video' | 'unknown';
  textPayload: string;
  mediaBase64?: string;
  caption?: string;
  mimeType?: string;
  mediaList?: Array<{
    mediaBase64: string;
    mimeType?: string;
    caption?: string;
  }>;
  timestamp: number;
  isBotPaused?: boolean;
}

export class MultimodalPreprocessor {
  /**
   * Helper to analyze an image buffer using DeepSeek Vision (primary) or Gemini Vision (fallback)
   */
  private async analyzeBuffer(buf: Buffer, caption: string = '', mimeType: string = 'image/jpeg'): Promise<string> {
    if (deepseek.isConfigured) {
      try {
        return await deepseek.analyzeImage(buf, caption, mimeType);
      } catch (dsErr: any) {
        logger.warn({ err: dsErr.message }, 'DeepSeek Vision failed, falling back to Gemini Vision');
      }
    }
    return await gemini.analyzeImage(buf, caption, mimeType);
  }

  /**
   * Preprocess incoming multimodal messages (voice notes, images, text)
   * and convert them into clean, structured text for the brain.
   */
  async process(payload: IncomingRawPayload): Promise<string> {
    const { messageType, textPayload, mediaBase64, caption, mimeType, mediaList } = payload;

    switch (messageType) {
      case 'audio': {
        if (!mediaBase64) {
          logger.warn('Audio message received without media buffer');
          return '[Customer sent an empty voice note]';
        }

        try {
          logger.info({ phone: payload.senderPhone }, 'Transcribing voice note with Gemini');
          const buffer = Buffer.from(mediaBase64, 'base64');
          const transcription = await gemini.transcribeAudio(buffer, mimeType || 'audio/ogg');
          logger.info({ transcription: transcription.substring(0, 60) }, 'Voice note transcribed');
          return `[Customer Voice Note]: "${transcription}"`;
        } catch (err: any) {
          logger.error({ err: err.message }, 'Failed to transcribe audio note');
          return '[Customer sent a voice note that could not be processed]';
        }
      }

      case 'image': {
        // Handle multiple images if present
        if (mediaList && mediaList.length > 1) {
          try {
            logger.info({ phone: payload.senderPhone, count: mediaList.length }, 'Analyzing multiple images');
            const analyses: string[] = [];
            for (let i = 0; i < Math.min(mediaList.length, 3); i++) {
              const item = mediaList[i];
              const buf = Buffer.from(item.mediaBase64, 'base64');
              const a = await this.analyzeBuffer(buf, item.caption || '', item.mimeType || 'image/jpeg');
              analyses.push(`[Image ${i + 1} Analysis: ${a}]`);
            }
            const textExtra = (textPayload || '').trim();
            return `${analyses.join('\n\n')}${textExtra ? `\n\n[Customer Text]: "${textExtra}"` : ''}`;
          } catch (err: any) {
            logger.error({ err: err.message }, 'Failed analyzing multiple images, falling back to single image');
          }
        }

        if (!mediaBase64) {
          return caption ? `[Customer sent an image with caption]: "${caption}"` : '[Customer sent an image]';
        }

        try {
          logger.info({ phone: payload.senderPhone }, 'Analyzing image with Primary Vision model');
          const buffer = Buffer.from(mediaBase64, 'base64');
          const analysis = await this.analyzeBuffer(buffer, caption || '', mimeType || 'image/jpeg');
          logger.info({ analysis: analysis.substring(0, 60) }, 'Image analyzed');
          const textExtra = (textPayload || '').trim();
          if (textExtra && !analysis.includes(textExtra)) {
            return `${analysis}\n\n[Customer Additional Text]: "${textExtra}"`;
          }
          return analysis;
        } catch (err: any) {
          logger.error({ err: err.message }, 'Failed to analyze image');
          return caption ? `[Customer sent an image with caption]: "${caption}"` : '[Customer sent an image]';
        }
      }

      case 'text':
      default: {
        return (textPayload || '').trim();
      }
    }
  }
}

export const multimodalPreprocessor = new MultimodalPreprocessor();

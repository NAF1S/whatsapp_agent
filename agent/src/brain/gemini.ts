import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface ToolCall {
  name: string;
  args: Record<string, any>;
}

export interface ToolResult {
  name: string;
  response: Record<string, any>;
}

// In-memory model cooldown registry to prevent spamming models on temporary 429 / 503
const modelCooldowns = new Map<string, number>();

function isModelCoolingDown(model: string): boolean {
  const until = modelCooldowns.get(model);
  if (!until) return false;
  if (Date.now() > until) {
    modelCooldowns.delete(model);
    return false;
  }
  return true;
}

function markCooldown(model: string, status: number) {
  // If 429 quota exhausted: cooldown for 2 minutes
  // If 503 high demand: cooldown for 45 seconds
  const duration = status === 429 ? 120000 : 45000;
  modelCooldowns.set(model, Date.now() + duration);
  logger.warn({ model, status, cooldownSec: duration / 1000 }, 'Model marked on temporary cooldown');
}

export class GeminiClient {
  private apiKeys: string[] = [];
  private currentKeyIndex = 0;

  constructor() {
    const rawKeys = process.env.GEMINI_API_KEYS || config.gemini.apiKey || '';
    this.apiKeys = rawKeys
      .split(',')
      .map((k) => k.trim())
      .filter((k) => k.length > 0);

    if (this.apiKeys.length === 0) {
      logger.warn('No GEMINI_API_KEY configured!');
    } else {
      logger.info({ keyCount: this.apiKeys.length }, 'GeminiClient initialized with key pool');
    }
  }

  /**
   * Get currently active API key
   */
  private getApiKey(): string {
    if (this.apiKeys.length === 0) return '';
    return this.apiKeys[this.currentKeyIndex % this.apiKeys.length];
  }

  /**
   * Rotate to next API key upon 429 rate limit
   */
  private rotateKey() {
    if (this.apiKeys.length > 1) {
      this.currentKeyIndex = (this.currentKeyIndex + 1) % this.apiKeys.length;
      logger.warn({ newIndex: this.currentKeyIndex }, 'Rotated to next Gemini API key in pool');
    }
  }

  /**
   * Generate 768-dimensional vector embedding using gemini-embedding-2
   */
  async embedText(text: string): Promise<number[]> {
    const key = this.getApiKey();
    const url = `${BASE_URL}/${config.gemini.embeddingModel}:embedContent?key=${key}`;
    try {
      const response = await axios.post(
        url,
        {
          content: { parts: [{ text }] },
          outputDimensionality: config.gemini.embeddingDimension,
        },
        { timeout: 15000 }
      );

      const embedding = response.data?.embedding?.values;
      if (!embedding || !Array.isArray(embedding)) {
        throw new Error('Invalid embedding response from Gemini API');
      }
      return embedding;
    } catch (err: any) {
      logger.error({ err: err.response?.data || err.message }, 'Failed to generate embedding');
      throw err;
    }
  }

  /**
   * Transcribe WhatsApp voice notes (.ogg) using gemini-3.5-flash-lite / gemini-2.5-flash
   */
  async transcribeAudio(audioBuffer: Buffer, mimeType: string = 'audio/ogg'): Promise<string> {
    const base64Audio = audioBuffer.toString('base64');
    const modelsToTry = [
      'gemini-2.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
      config.gemini.transcribeModel,
    ];

    for (const model of modelsToTry) {
      if (isModelCoolingDown(model)) continue;
      const key = this.getApiKey();
      const url = `${BASE_URL}/${model}:generateContent?key=${key}`;

      try {
        const response = await axios.post(
          url,
          {
            contents: [
              {
                parts: [
                  {
                    text: 'Please transcribe this customer voice message accurately. Reply with ONLY the transcribed text in the original language spoken (Bangla or English). If unclear, output what you can decipher.',
                  },
                  {
                    inlineData: {
                      mimeType: mimeType,
                      data: base64Audio,
                    },
                  },
                ],
              },
            ],
          },
          { timeout: 25000 }
        );

        const candidate = response.data?.candidates?.[0];
        const text = candidate?.content?.parts?.map((p: any) => p.text).join(' ').trim() || '';
        if (text) return text;
      } catch (err: any) {
        const status = err.response?.status;
        if (status === 429) {
          this.rotateKey();
          markCooldown(model, 429);
        } else if (status === 503) {
          markCooldown(model, 503);
        }
        logger.warn({ model, err: err.message }, 'Audio transcription attempt failed, trying next candidate');
      }
    }

    return '[Customer sent a voice note that could not be transcribed]';
  }

  /**
   * Analyze customer images using verified high-quota models
   */
  async analyzeImage(imageBuffer: Buffer, userCaption: string = '', mimeType: string = 'image/jpeg'): Promise<string> {
    const base64Image = imageBuffer.toString('base64');
    const modelsToTry = [
      'gemini-2.5-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
    ];

    const prompt = `You are the vision preprocessor for "Hide Haven", a premium genuine leather brand in Bangladesh.
The customer sent this image on WhatsApp (often a screenshot of our Facebook post, ad, website product page, or a photo of our leather product).

Your tasks:
1. Identify if this is a Hide Haven leather product:
   - Product Type: (e.g. Bifold Wallet, Long Wallet, Moving Belt, Formal Belt, Cardholder, Key Case, Combo Set).
   - Pattern / Leather Type: (e.g. Dot Pattern, Mat Pattern, Crocodile Pattern, Plain Napa, Stitched, Embossed).
   - Color: (e.g. Chocolate Brown, Dark Brown, Forest Green, Classic Black, Tan).
2. OCR Extraction: Extract any readable text in the image (e.g. Product names like "The Sovereign", "Four Strips", prices like "549", "799", "1499", or post captions).
3. If the customer sent a caption, note it: "${userCaption || 'No caption provided'}".

Output a concise summary in this format:
[Customer Image Analysis: Product is <Color> <Pattern> <Product Type>. Distinctive features: <features>. Visible text/model: <any OCR text>. Customer inquiry: "${userCaption || 'Asking for availability and price'}"]`;

    for (const model of modelsToTry) {
      if (isModelCoolingDown(model)) continue;
      const key = this.getApiKey();
      const url = `${BASE_URL}/${model}:generateContent?key=${key}`;

      try {
        const response = await axios.post(
          url,
          {
            contents: [
              {
                parts: [
                  { text: prompt },
                  {
                    inlineData: {
                      mimeType: mimeType,
                      data: base64Image,
                    },
                  },
                ],
              },
            ],
          },
          { timeout: 25000 }
        );

        const candidate = response.data?.candidates?.[0];
        const description = candidate?.content?.parts?.map((p: any) => p.text).join(' ').trim() || '';
        if (description) {
          logger.info({ model }, 'Image analysis succeeded with Gemini Vision');
          return description;
        }
      } catch (err: any) {
        const status = err.response?.status;
        if (status === 429) {
          this.rotateKey();
          markCooldown(model, 429);
        } else if (status === 503) {
          markCooldown(model, 503);
        }
        logger.warn({ model, err: err.message }, 'Vision model failed, trying next candidate');
      }
    }

    return `[Customer sent an image of a leather product] ${userCaption ? `Customer Caption: "${userCaption}"` : 'Customer asking for availability and price.'}`.trim();
  }

  /**
   * Call Gemini with tool definitions using verified healthy models
   */
  async callWithTools(
    model: string,
    contents: any[],
    toolDeclarations: any[],
    systemInstruction?: string
  ): Promise<{ text?: string; toolCalls?: ToolCall[]; rawCandidate?: any }> {
    const key = this.getApiKey();
    const url = `${BASE_URL}/${model}:generateContent?key=${key}`;

    const payload: any = {
      contents,
      tools: toolDeclarations.length > 0 ? [{ functionDeclarations: toolDeclarations }] : undefined,
    };

    if (systemInstruction) {
      payload.systemInstruction = {
        parts: [{ text: systemInstruction }],
      };
    }

    try {
      const response = await axios.post(url, payload, { timeout: 35000 });
      const candidate = response.data?.candidates?.[0];

      if (!candidate) {
        return { text: "I'm having trouble processing that right now. Please try again." };
      }

      const parts = candidate.content?.parts || [];
      const toolCalls: ToolCall[] = [];
      let textContent = '';

      for (const part of parts) {
        if (part.functionCall) {
          toolCalls.push({
            name: part.functionCall.name,
            args: part.functionCall.args || {},
          });
        }
        if (part.text) {
          textContent += part.text;
        }
      }

      return {
        text: textContent.trim(),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        rawCandidate: candidate,
      };
    } catch (err: any) {
      const status = err.response?.status;
      if (status === 429) {
        this.rotateKey();
        markCooldown(model, 429);
      } else if (status === 503) {
        markCooldown(model, 503);
      }
      logger.error({ err: err.response?.data || err.message, model }, 'Error in callWithTools');
      throw err;
    }
  }

  /**
   * Chat response generation using fast, high-rate-limit models
   */
  async generateChat(
    contents: any[],
    systemInstruction?: string
  ): Promise<string> {
    const modelsToTry = [
      'gemini-3.5-flash-lite',
      'gemini-2.5-flash',
      'gemini-3.1-flash-lite',
    ];

    for (const model of modelsToTry) {
      if (isModelCoolingDown(model)) continue;
      const key = this.getApiKey();
      const url = `${BASE_URL}/${model}:generateContent?key=${key}`;
      const payload: any = { contents };
      if (systemInstruction) {
        payload.systemInstruction = {
          parts: [{ text: systemInstruction }],
        };
      }

      try {
        const response = await axios.post(url, payload, { timeout: 25000 });
        const candidate = response.data?.candidates?.[0];
        const text = candidate?.content?.parts?.map((p: any) => p.text).join(' ').trim() || '';
        if (text) return text;
      } catch (err: any) {
        const status = err.response?.status;
        if (status === 429) {
          this.rotateKey();
          markCooldown(model, 429);
        } else if (status === 503) {
          markCooldown(model, 503);
        }
        logger.warn({ model, message: err.message }, 'Chat generation attempt failed');
      }
    }

    return "I'm temporarily experiencing high traffic. Please send your question again in a moment.";
  }
}

export const gemini = new GeminiClient();

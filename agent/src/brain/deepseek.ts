import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';

const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/chat/completions';

function convertSchema(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(convertSchema);
  const result: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'type' && typeof v === 'string') {
      result[k] = v.toLowerCase();
    } else {
      result[k] = convertSchema(v);
    }
  }
  return result;
}

export class DeepSeekClient {
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.DEEPSEEK_API_KEY || config.deepseek?.apiKey || '';
    if (this.apiKey) {
      logger.info('DeepSeek-V4.1-Flash initialized as primary AI brain provider');
    }
  }

  get isConfigured(): boolean {
    return !!this.apiKey;
  }

  /**
   * Set API key dynamically
   */
  setApiKey(key: string) {
    this.apiKey = key.trim();
    logger.info('DeepSeek API key updated dynamically');
  }

  /**
   * Convert Gemini-style tools to OpenAI/DeepSeek format
   */
  private formatTools(toolDeclarations: any[]): any[] {
    return toolDeclarations.map((td) => ({
      type: 'function',
      function: {
        name: td.name,
        description: td.description,
        parameters: convertSchema(td.parameters || { type: 'object', properties: {} }),
      },
    }));
  }

  /**
   * Convert Gemini contents array to standard OpenAI/DeepSeek format.
   * Guarantees that multiple tool calls in a turn are consolidated into
   * a single assistant message, followed by matching tool messages.
   */
  private formatMessages(contents: any[], systemInstruction?: string): any[] {
    const messages: any[] = [];
    if (systemInstruction) {
      messages.push({ role: 'system', content: systemInstruction });
    }

    // Queue of pending tool calls from the last assistant message
    let pendingToolCalls: Array<{ id: string; name: string }> = [];

    for (const c of contents) {
      if (c.role === 'model') {
        const textParts: string[] = [];
        const toolCalls: any[] = [];
        let reasoning = '';

        for (const p of c.parts || []) {
          if (p.text) {
            textParts.push(p.text);
          }
          if (p.reasoning_content) {
            reasoning = p.reasoning_content;
          }
          if (p.functionCall) {
            // Read the id if present, but never write it back: `contents` is shared with
            // Gemini, which rejects a function-call `id` as an unknown field (HTTP 400).
            const callId = p.functionCall.id || p.id || `call_${toolCalls.length}_${Date.now()}`;
            toolCalls.push({
              id: callId,
              type: 'function',
              function: {
                name: p.functionCall.name,
                arguments: typeof p.functionCall.args === 'string'
                  ? p.functionCall.args
                  : JSON.stringify(p.functionCall.args || {}),
              },
            });
          }
        }

        if (toolCalls.length > 0) {
          pendingToolCalls = toolCalls.map((tc) => ({ id: tc.id, name: tc.function.name }));
          messages.push({
            role: 'assistant',
            content: textParts.join('\n') || '',
            reasoning_content: reasoning || 'Analyzing query and invoking required tools.',
            tool_calls: toolCalls,
          });
        } else if (textParts.length > 0) {
          messages.push({
            role: 'assistant',
            content: textParts.join('\n'),
          });
        }
      } else {
        // User turn or Tool Response turn
        for (const p of c.parts || []) {
          if (p.text) {
            messages.push({ role: 'user', content: p.text });
          } else if (p.functionResponse) {
            // Find matching tool_call_id from pendingToolCalls. Re-match by name whenever
            // the provided id is missing OR unknown to this turn (the id we recorded came
            // from a different provider, so it never matches the ids generated above).
            // Without this, DeepSeek rejects the request: "an assistant message with
            // tool_calls must be followed by tool messages responding to each tool_call_id".
            let toolCallId = p.functionResponse.id || p.id;
            const idIsKnown = !!toolCallId && pendingToolCalls.some((ptc) => ptc.id === toolCallId);
            if (!idIsKnown) {
              const matched = pendingToolCalls.find((ptc) => ptc.name === p.functionResponse.name);
              if (matched) {
                toolCallId = matched.id;
                // Remove from pending so next call with same name gets next ID
                pendingToolCalls = pendingToolCalls.filter((ptc) => ptc.id !== matched.id);
              } else if (pendingToolCalls.length > 0) {
                toolCallId = pendingToolCalls.shift()!.id;
              } else {
                toolCallId = `call_${Date.now()}`;
              }
            }

            messages.push({
              role: 'tool',
              tool_call_id: toolCallId,
              content: typeof p.functionResponse.response === 'string'
                ? p.functionResponse.response
                : JSON.stringify(p.functionResponse.response || {}),
            });
          }
        }
      }
    }
    return messages;
  }

  /**
   * Analyze customer images using DeepSeek-V4.1-Flash Vision
   */
  async analyzeImage(imageBuffer: Buffer, userCaption: string = '', mimeType: string = 'image/jpeg'): Promise<string> {
    if (!this.apiKey) {
      throw new Error('DeepSeek API key is not configured');
    }

    const base64 = imageBuffer.toString('base64');
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

    try {
      const res = await axios.post(
        DEEPSEEK_BASE_URL,
        {
          model: config.deepseek?.model || 'deepseek-flash',
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
              ],
            },
          ],
          effort: config.deepseek?.effort || 'low',
          max_tokens: 2000,
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 25000,
        }
      );

      const choice = res.data?.choices?.[0];
      const description = choice?.message?.content?.trim();
      if (description) {
        logger.info('Image analyzed successfully with DeepSeek-V4.1-Flash Vision');
        return description;
      }

      // Fallback: If content was empty due to token usage, extract from reasoning_content
      const reasoning = choice?.message?.reasoning_content || '';
      if (reasoning) {
        const match = reasoning.match(/\[Customer Image Analysis: [^\]]+\]/i);
        if (match) {
          logger.info('Extracted vision analysis from DeepSeek reasoning');
          return match[0];
        }
      }

      throw new Error('Empty response from DeepSeek vision');
    } catch (err: any) {
      logger.error({ err: err.response?.data || err.message }, 'DeepSeek vision analysis failed');
      throw err;
    }
  }

  /**
   * Execute intelligent reasoning and tool-calling with DeepSeek-V4.1-Flash
   */
  async callWithTools(
    contents: any[],
    toolDeclarations: any[],
    systemInstruction?: string
  ): Promise<{ text?: string; toolCalls?: Array<{ name: string; args: any; id?: string }>; rawCandidate?: any } | null> {
    if (!this.apiKey) return null;

    try {
      const messages = this.formatMessages(contents, systemInstruction);
      const tools = this.formatTools(toolDeclarations);

      const payload: any = {
        model: config.deepseek?.model || 'deepseek-flash',
        messages,
        effort: config.deepseek?.effort || 'low',
        max_tokens: 2500,
        temperature: 0.2,
      };

      if (tools.length > 0) {
        payload.tools = tools;
      }

      const res = await axios.post(DEEPSEEK_BASE_URL, payload, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30000,
      });

      const choice = res.data?.choices?.[0];
      if (!choice) return null;

      const message = choice.message;
      const reasoningContent = message.reasoning_content || '';
      const toolCalls: Array<{ name: string; args: any; id?: string }> = [];

      if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
        for (const tc of message.tool_calls) {
          try {
            toolCalls.push({
              id: tc.id,
              name: tc.function.name,
              args: typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments,
            });
          } catch (parseErr) {
            logger.warn({ parseErr, args: tc.function.arguments }, 'Failed to parse DeepSeek tool arguments');
          }
        }
      }

      return {
        text: message.content || '',
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        rawCandidate: {
          content: {
            role: 'model',
            parts: toolCalls.map((tc) => ({
              reasoning_content: reasoningContent,
              functionCall: {
                id: tc.id,
                name: tc.name,
                args: tc.args,
              },
            })),
          },
        },
      };
    } catch (err: any) {
      logger.error({ err: err.response?.data || err.message }, 'DeepSeek callWithTools failed');
      return null;
    }
  }

  /**
   * Fast chat synthesis using DeepSeek-V4.1-Flash
   */
  async generateChat(contents: any[], systemInstruction?: string): Promise<string | null> {
    if (!this.apiKey) return null;

    try {
      const messages = this.formatMessages(contents, systemInstruction);
      const res = await axios.post(
        DEEPSEEK_BASE_URL,
        {
          model: config.deepseek?.model || 'deepseek-flash',
          messages,
          effort: config.deepseek?.effort || 'low',
          max_tokens: 1000,
          temperature: 0.3,
        },
        {
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 25000,
        }
      );

      return res.data?.choices?.[0]?.message?.content || null;
    } catch (err: any) {
      logger.error({ err: err.response?.data || err.message }, 'DeepSeek generateChat failed');
      return null;
    }
  }
}

export const deepseek = new DeepSeekClient();

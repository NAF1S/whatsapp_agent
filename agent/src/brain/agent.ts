import { gemini, ToolCall } from './gemini';
import { deepseek } from './deepseek';
import { TOOL_DECLARATIONS, executeTool } from './tools';
import { SYSTEM_PROMPT } from './prompt';
import { sessionManager } from '../session/manager';
import { escalationNotifier } from '../escalation/notifier';
import { config } from '../config';
import { logger } from '../utils/logger';
import { stripSegmentTokens } from '../utils/reply';

/**
 * Build the provider-neutral record of a model turn for the SHARED `contents` array.
 *
 * `rawCandidate.content` is provider-specific: DeepSeek attaches `reasoning_content` and
 * function-call `id`s that Gemini rejects outright ("Unknown name ...", HTTP 400). Because
 * this one array is replayed to whichever provider answers next, pushing the raw candidate
 * verbatim used to poison every fallback and leave the customer with a generic reply.
 * Only `text` and `functionCall{name,args}` survive here — fields both providers accept.
 */
function toSharedModelTurn(rawCandidate: any, toolCalls: ToolCall[]): any {
  const parts: any[] = [];

  const rawParts = rawCandidate?.content?.parts;
  if (Array.isArray(rawParts)) {
    for (const p of rawParts) {
      if (typeof p?.text === 'string' && p.text.trim()) {
        parts.push({ text: p.text });
      }
    }
  }

  for (const call of toolCalls) {
    let args: any = call.args;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch {
        args = {};
      }
    }
    parts.push({
      functionCall: {
        name: call.name,
        args: args && typeof args === 'object' ? args : {},
      },
    });
  }

  if (parts.length === 0) {
    parts.push({ text: '' });
  }

  return { role: 'model', parts };
}

function detectEscalationTrigger(text: string): { matched: boolean; reason: string } {
  const lower = text.toLowerCase().trim();

  // 1. Demands for human / person / owner
  const hasHumanKeyword =
    /\b(human|agent|representative|owner|founder|boss|admin|manager)\b/i.test(lower) ||
    /(মানুষ|মালিক|এডমিন|অ্যাডমিন|ম্যানেজার|রিপ্রেজেন্টেটিভ|কাস্টমার কেয়ার|কথা বলুন)/i.test(text);

  if (hasHumanKeyword) {
    const hasIntent =
      /(kotha|talk|connect|transfer|কথা|যোগাযোগ|চাই|ডাকেন|দিন|কল দিন|ফোন দিন|number|নম্বর|dao|দাও)/i.test(text) ||
      /\b(malik k|owner k|manush dao|human dao|admin dao|call me|phone number)\b/i.test(lower);

    if (hasIntent) {
      return { matched: true, reason: 'Customer requested human agent / store owner' };
    }
  }

  // 2. Legal / Police / Fraud / Scam accusations
  if (
    /\b(scam|fraud|police|thana|court|cheat|harass|lawyer)\b/i.test(lower) ||
    /(মামলা|পুলিশ|থানা|প্রতারণা|প্রতারক|চিটার|আদালত|ভোক্তা অধিকার|আইনি)/i.test(text)
  ) {
    return { matched: true, reason: 'Dispute / Legal threat / Scam allegation' };
  }

  // 3. Sensitive business matters (profit, valuation, wholesale)
  if (
    /\b(valuation|net worth|profit margin|shareholder)\b/i.test(lower) ||
    /(লাভ কত|লাভের অংশ|ভ্যালুয়েশন|কোম্পানির শেয়ার)/i.test(text)
  ) {
    return { matched: true, reason: 'Inquiry regarding business valuation / profit' };
  }

  return { matched: false, reason: '' };
}

export class AgentBrain {
  /**
   * Process a customer message through the intelligent agent loop
   */
  async processCustomerMessage(customerPhone: string, incomingText: string, targetJid?: string): Promise<string> {
    const session = await sessionManager.getOrCreateSession(customerPhone);

    // If session is locked by human handoff, do not auto-respond!
    if (session.isHumanControlled) {
      logger.info({ phone: customerPhone }, 'Session is human-controlled. Skipping AI auto-reply.');
      await sessionManager.addMessage(customerPhone, 'user', incomingText, {
        status: 'pending_human_review',
      });
      return ''; // No reply sent by bot; human agent will reply via dashboard
    }

    // 0. Pre-filter rule check for immediate escalation
    const escTrigger = detectEscalationTrigger(incomingText);
    if (escTrigger.matched) {
      logger.warn({ phone: customerPhone, reason: escTrigger.reason }, 'Triggered immediate pre-filter human escalation');
      await sessionManager.lockForHuman(customerPhone, escTrigger.reason);
      await sessionManager.addMessage(customerPhone, 'user', incomingText);

      await escalationNotifier.sendAdminEscalationAlert({
        customerPhone,
        reason: escTrigger.reason,
        situationSummary: `Customer message: "${incomingText}"`,
      });

      const handoffReply =
        'আপনার অনুরোধটি আমাদের স্টোর ম্যানেজার ও অ্যাডমিনকে সরাসরি পাঠিয়ে দেওয়া হয়েছে। একজন প্রতিনিধি খুব শীঘ্রই আপনার সাথে হোয়াটসঅ্যাপে যোগাযোগ করবেন। সাথে থাকার জন্য আন্তরিক ধন্যবাদ।';

      await sessionManager.addMessage(customerPhone, 'assistant', handoffReply);
      return handoffReply;
    }

    // Save incoming user message
    await sessionManager.addMessage(customerPhone, 'user', incomingText);

    // Fetch conversation history
    const history = await sessionManager.getRecentMessages(customerPhone, 8);

    // Build Gemini contents array from history
    const contents: any[] = [];

    for (const msg of history) {
      if (msg.role === 'user') {
        contents.push({
          role: 'user',
          parts: [{ text: msg.content }],
        });
      } else if (msg.role === 'assistant') {
        contents.push({
          role: 'model',
          parts: [{ text: msg.content }],
        });
      }
    }

    // Ensure the last item in contents is the user's latest incoming message
    if (
      contents.length === 0 ||
      contents[contents.length - 1].role !== 'user' ||
      contents[contents.length - 1].parts[0]?.text !== incomingText
    ) {
      contents.push({
        role: 'user',
        parts: [{ text: incomingText }],
      });
    }

    // Multi-turn tool execution loop
    let iterations = 0;
    const maxIterations = 3;
    let finalReply = '';

    while (iterations < maxIterations) {
      iterations++;
      logger.debug({ iteration: iterations, phone: customerPhone }, 'Running AI brain iteration');

      try {
        let brainResult: any = null;

        // 1. Primary Provider: DeepSeek-V4.1-Flash (if configured as primary)
        if (config.deepseek.isPrimary && deepseek.isConfigured) {
          try {
            logger.debug({ iteration: iterations, phone: customerPhone }, 'Calling primary AI: DeepSeek-V4.1-Flash');
            brainResult = await deepseek.callWithTools(contents, TOOL_DECLARATIONS, SYSTEM_PROMPT);
          } catch (dsErr: any) {
            logger.warn({ err: dsErr.message }, 'Primary DeepSeek call failed, falling back to Gemini');
          }
        }

        // 2. Secondary / Fallback: Gemini healthy models
        if (!brainResult) {
          const toolModels = [
            'gemini-2.5-flash',
            'gemini-3.5-flash-lite',
            'gemini-3.1-flash-lite',
          ];
          for (const m of toolModels) {
            try {
              brainResult = await gemini.callWithTools(
                m,
                contents,
                TOOL_DECLARATIONS,
                SYSTEM_PROMPT
              );
              if (brainResult) break;
            } catch (modelErr: any) {
              logger.warn({ model: m, err: modelErr.message }, 'Gemini model call failed, trying next candidate');
            }
          }
        }

        // 3. Fallback to DeepSeek if Gemini was primary and failed
        if (!brainResult && !config.deepseek.isPrimary && deepseek.isConfigured) {
          try {
            brainResult = await deepseek.callWithTools(contents, TOOL_DECLARATIONS, SYSTEM_PROMPT);
          } catch (dsErr: any) {
            logger.warn({ err: dsErr.message }, 'Secondary DeepSeek tool call failed');
          }
        }

        if (!brainResult) {
          break;
        }

        // If the model called tools, execute them
        if (brainResult.toolCalls && brainResult.toolCalls.length > 0) {
          logger.info({ toolCalls: brainResult.toolCalls }, 'AI brain called tools');

          // Append model's tool calls to contents (provider-neutral, see helper above)
          contents.push(toSharedModelTurn(brainResult.rawCandidate, brainResult.toolCalls));

          // Execute all requested tools and add function responses
          for (let i = 0; i < brainResult.toolCalls.length; i++) {
            const call = brainResult.toolCalls[i];
            const callId = call.id || `call_${i}`;

            let toolOutput: Record<string, any>;
            try {
              toolOutput = await executeTool(call.name, call.args, customerPhone, targetJid);
            } catch (toolErr: any) {
              // Hand the failure back to the model as a tool result instead of aborting the
              // turn, so it can apologise / offer human help rather than leaving the
              // customer with a generic fallback message.
              logger.error({ err: toolErr.message, toolName: call.name }, 'Tool execution failed; returning error result to model');
              toolOutput = {
                success: false,
                error: `Tool ${call.name} failed: ${toolErr.message}. Explain the problem briefly to the customer and offer human help if it cannot be resolved.`,
              };
            }

            contents.push({
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    id: callId,
                    name: call.name,
                    response: toolOutput,
                  },
                },
              ],
            });
          }
          // Continue to next iteration so model can inspect tool output
          continue;
        }

        // If no tool calls, model gave a direct text answer
        if (brainResult.text) {
          finalReply = brainResult.text;
          break;
        }

        // Model returned neither text nor tool calls. Re-sending the identical request
        // would burn another model call (and quota) for nothing — stop and synthesise.
        logger.warn({ iteration: iterations, phone: customerPhone },
          'Model returned no text and no tool calls; stopping tool loop');
        break;
      } catch (err: any) {
        logger.error({ err: err.message, iteration: iterations }, 'Brain loop iteration failed, falling back to chat model');
        break;
      }
    }

    // If loop produced text, use it; otherwise synthesize with chat model
    if (!finalReply) {
      if (config.deepseek.isPrimary && deepseek.isConfigured) {
        try {
          const dsReply = await deepseek.generateChat(contents, SYSTEM_PROMPT);
          if (dsReply) finalReply = dsReply;
        } catch (dsChatErr: any) {
          logger.warn({ err: dsChatErr.message }, 'Primary DeepSeek chat failed, trying Gemini');
        }
      }

      if (!finalReply) {
        try {
          finalReply = await gemini.generateChat(contents, SYSTEM_PROMPT);
        } catch (err: any) {
          logger.warn({ err: err.message }, 'Gemini final chat fallback failed');
          if (!config.deepseek.isPrimary && deepseek.isConfigured) {
            try {
              const dsReply = await deepseek.generateChat(contents, SYSTEM_PROMPT);
              if (dsReply) finalReply = dsReply;
            } catch (dsChatErr: any) {
              logger.error({ err: dsChatErr.message }, 'DeepSeek chat fallback also failed');
            }
          }
        }
      }

      if (!finalReply) {
        finalReply =
          'Hello! Thank you for reaching out to Hide Haven. We received your message and an agent will follow up with you shortly.';
      }
    }

    // Post-filter: If AI response indicates escalation, ensure session is locked & admin is alerted
    const indicatesEscalation =
      /(হিউম্যান|এসকেলেট|এসকেলেশন|স্টোর ম্যানেজার|সাপোর্ট টিমকে জানিয়ে দিচ্ছি|এডমিনকে জানাচ্ছি|ম্যানেজারকে জানাচ্ছি|মানব প্রতিনিধি|human agent|escalat|representative will contact)/i.test(
        finalReply
      );

    if (indicatesEscalation) {
      const currentSession = await sessionManager.getOrCreateSession(customerPhone);
      if (!currentSession.isHumanControlled) {
        logger.warn({ phone: customerPhone }, 'Post-filter caught escalation in AI text; locking session and alerting admin');
        await sessionManager.lockForHuman(customerPhone, 'AI response indicated human escalation');
        await escalationNotifier.sendAdminEscalationAlert({
          customerPhone,
          reason: 'AI message indicated human escalation',
          situationSummary: `AI generated reply: "${finalReply}"`,
        });
      }
    }

    // Persist assistant reply to database as one readable message. The `<<<MSG>>>` tokens are
    // an outbound wire format only — replaying them as conversation history would teach the
    // model to leak them into normal text.
    await sessionManager.addMessage(customerPhone, 'assistant', stripSegmentTokens(finalReply));

    return finalReply;
  }
}

export const agentBrain = new AgentBrain();

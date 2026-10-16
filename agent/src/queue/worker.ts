import { Worker, Job } from 'bullmq';
import axios from 'axios';
import { multimodalPreprocessor, IncomingRawPayload } from '../preprocessor';
import { agentBrain } from '../brain/agent';
import { sessionManager } from '../session/manager';
import { config } from '../config';
import { logger } from '../utils/logger';

// Per-customer sequential mutex to avoid race conditions and parallel replies
const customerLocks = new Map<string, Promise<void>>();

export function startQueueWorker(): Worker {
  const connection = {
    host: config.redis.host,
    port: config.redis.port,
    ...(config.redis.password ? { password: config.redis.password } : {}),
  };

  logger.info({ redis: `${config.redis.host}:${config.redis.port}` }, 'Starting BullMQ queue worker for whatsapp-incoming');

  const worker = new Worker<IncomingRawPayload>(
    'whatsapp-incoming',
    async (job: Job<IncomingRawPayload>) => {
      const start = Date.now();
      const { sessionId, senderPhone, messageType, isBotPaused } = job.data;
      logger.info({ jobId: job.id, senderPhone, messageType, isBotPaused: !!isBotPaused }, 'Processing incoming WhatsApp job');

      const phoneKey = senderPhone.replace(/[^\d+]/g, '');
      const previousLock = customerLocks.get(phoneKey) || Promise.resolve();

      let releaseLock: () => void = () => {};
      const currentLock = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      customerLocks.set(phoneKey, currentLock);

      // Wait for any previous job for this customer to finish
      await previousLock;

      try {
        // 1. Check if session is already in human control BEFORE spending AI resources
        const session = await sessionManager.getOrCreateSession(senderPhone);
        if (session.isHumanControlled) {
          logger.info({ senderPhone }, 'Session is human-controlled. Saving message for human review; skipping AI auto-reply.');
          const normalizedText = await multimodalPreprocessor.process(job.data);
          if (normalizedText) {
            await sessionManager.addMessage(senderPhone, 'user', normalizedText, {
              status: 'pending_human_review',
            });
          }
          return;
        }

        // 2. Preprocess multimodal message (Voice -> STT, Image -> OCR/Vision, Text -> Sanitized)
        const normalizedText = await multimodalPreprocessor.process(job.data);

        if (!normalizedText) {
          logger.warn({ senderPhone }, 'Empty text after preprocessing, ignoring job');
          return;
        }

        // If bot is paused by admin, record message in database for manual human handling
        if (isBotPaused) {
          logger.info({ senderPhone }, 'Bot is globally PAUSED by admin. Message saved for human review; skipping AI auto-reply.');
          await sessionManager.addMessage(senderPhone, 'user', normalizedText, {
            status: 'bot_paused',
          });
          return;
        }

        // 3. Process through agent brain (session check, tool execution, LLM synthesis)
        const reply = await agentBrain.processCustomerMessage(senderPhone, normalizedText, sessionId);

        // 4. If a reply was produced (i.e. session was not human-locked), send via WhatsApp bridge
        if (reply) {
          logger.info({ senderPhone, replyLength: reply.length }, 'Sending reply via WhatsApp bridge');
          await sendWhatsAppMessage(sessionId, reply);
        } else {
          logger.info({ senderPhone }, 'No automated reply sent (session in human control)');
        }

        const duration = Date.now() - start;
        logger.info({ jobId: job.id, senderPhone, durationMs: duration }, 'Completed WhatsApp message job');
      } catch (err: any) {
        logger.error({ err: err.message, jobId: job.id, senderPhone }, 'Error in queue worker job');
        throw err;
      } finally {
        releaseLock();
        if (customerLocks.get(phoneKey) === currentLock) {
          customerLocks.delete(phoneKey);
        }
      }
    },
    {
      connection,
      concurrency: 3,
    }
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, 'Queue job failed permanently');
  });

  // A Redis connection error is emitted as an 'error' event. With no listener attached, an
  // EventEmitter throws on 'error' and takes the whole process down — which is how a Redis
  // blip becomes an unexplained PM2 restart with nothing in the error log.
  worker.on('error', (err) => {
    logger.error({ err: err.message }, 'Queue worker error (Redis connection)');
  });

  return worker;
}

/**
 * Send outbound WhatsApp message via the Baileys bridge API
 */
export async function sendWhatsAppMessage(toJid: string, text: string): Promise<boolean> {
  const bridgeUrl = `${config.whatsapp.bridgeUrl}/send`;
  try {
    const res = await axios.post(
      bridgeUrl,
      { to: toJid, text },
      { timeout: 15000 }
    );
    return res.data?.success === true;
  } catch (err: any) {
    logger.error({ err: err.message, to: toJid, bridgeUrl }, 'Failed to send message via WhatsApp bridge');
    return false;
  }
}

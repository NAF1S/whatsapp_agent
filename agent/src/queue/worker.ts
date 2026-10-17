import { Worker, Job } from 'bullmq';
import { multimodalPreprocessor, IncomingRawPayload } from '../preprocessor';
import { agentBrain } from '../brain/agent';
import { sessionManager } from '../session/manager';
import { config } from '../config';
import { logger } from '../utils/logger';
import { normalizeCustomerId } from '../channels/messenger/identity';
import { sendMessage, channelOf } from '../channels/dispatch';
import { splitMessageParts, PART_DELAY_MS } from '../utils/reply';

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
      logger.info({ jobId: job.id, senderPhone, messageType, isBotPaused: !!isBotPaused }, 'Processing inbound message job');

      // Channel-aware key. A plain strip of non-digits would reduce a Messenger PSID to a
      // bare 15-17 digit string, which can collide with a real customer's phone number —
      // two different people sharing one session, one lock, and one conversation history.
      const phoneKey = normalizeCustomerId(senderPhone);
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

        // 4. If a reply was produced (i.e. session was not human-locked), send it back on
        // whichever channel the message arrived from — decided from `sessionId`.
        if (reply) {
          const channel = channelOf(sessionId);
          // The brain emits the greeting and the answer as separate bubbles separated by
          // `<<<MSG>>>`. Send them one at a time, with a short gap, so the customer sees a
          // natural sequence of small messages instead of one wall of text. The per-customer
          // mutex above is held for the whole loop, so another job cannot interleave.
          const parts = splitMessageParts(reply);
          logger.info(
            { senderPhone, channel, replyLength: reply.length, parts: parts.length },
            'Sending reply to customer'
          );
          for (let i = 0; i < parts.length; i++) {
            const sent = await sendMessage(sessionId, parts[i]);
            if (!sent) {
              logger.error({ senderPhone, part: i + 1, of: parts.length }, 'A reply part failed to send; stopping the sequence');
              break;
            }
            if (i < parts.length - 1) {
              await new Promise((resolve) => setTimeout(resolve, PART_DELAY_MS));
            }
          }
        } else {
          logger.info({ senderPhone }, 'No automated reply sent (session in human control)');
        }

        const duration = Date.now() - start;
        logger.info({ jobId: job.id, senderPhone, durationMs: duration }, 'Completed message job');
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

// The WhatsApp send implementation moved to channels/whatsapp/send.ts so that
// channels/dispatch.ts can use it without a circular import (worker → dispatch → worker).
// Re-exported here unchanged so the existing importers — the admin reply route in index.ts
// and the escalation notifier — need no modification at all.
export { sendWhatsAppMessage } from '../channels/whatsapp/send';

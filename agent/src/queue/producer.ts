import { Queue } from 'bullmq';
import { config } from '../config';
import { IncomingRawPayload } from '../preprocessor';
import { logger } from '../utils/logger';

/**
 * Producer side of the inbound queue.
 *
 * The worker (queue/worker.ts) only consumes; until now the only producer was the WhatsApp
 * bridge, which owns its own Queue instance. The Messenger webhook needs one on the agent
 * side, so this module provides it.
 *
 * The queue NAME is still `whatsapp-incoming` and is deliberately unchanged: renaming it
 * would mean touching the bridge, the worker and every queued job in flight for no functional
 * gain. It is now the inbound queue for both channels — the channel travels in the payload.
 */

const connection = {
  host: config.redis.host,
  port: config.redis.port,
  ...(config.redis.password ? { password: config.redis.password } : {}),
};

export const incomingQueue = new Queue<IncomingRawPayload>('whatsapp-incoming', { connection });

// A Redis error on the Queue would otherwise be an unhandled 'error' event and kill the
// process — the same trap the worker and the bridge both guard against.
incomingQueue.on('error', (err) => {
  logger.error({ err: err.message }, 'Inbound queue error (Redis)');
});

/**
 * Enqueue one inbound message.
 *
 * `jobId` gives idempotency: a redelivered webhook (Meta retries aggressively) cannot create
 * a second job, so the customer gets one reply rather than several.
 */
export async function enqueueIncoming(
  payload: IncomingRawPayload,
  jobId?: string,
): Promise<void> {
  const opts: { removeOnComplete: number; removeOnFail: number; jobId?: string } = {
    removeOnComplete: 100,
    removeOnFail: 200,
  };
  if (jobId) opts.jobId = jobId;

  await incomingQueue.add('message', payload, opts);
}

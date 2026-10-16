import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import axios from 'axios';
import { config } from './config';
import { logger } from './utils/logger';
import { checkDbConnection, query } from './data/db';
import { startQueueWorker, sendWhatsAppMessage } from './queue/worker';
import { sessionManager } from './session/manager';
import { ragIndexer } from './rag/indexer';
import { settingsService } from './data/settings';
import { escalationNotifier } from './escalation/notifier';

const app = express();
app.use(cors());
app.use(express.json({ limit: '15mb' }));

// 1. Static Dashboard files
const dashboardDir = path.resolve(__dirname, '../../dashboard');
app.use(express.static(dashboardDir, {
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
}));
app.get('/admin', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(dashboardDir, 'index.html'));
});

// 2. Health Check
app.get('/health', async (req, res) => {
  const dbOk = await checkDbConnection();
  res.json({
    status: dbOk ? 'healthy' : 'degraded',
    service: 'Hide Haven AI Agent',
    timestamp: new Date().toISOString(),
    models: {
      brain: config.gemini.brainModel,
      chat: config.gemini.chatModel,
      transcribe: config.gemini.transcribeModel,
      embedding: config.gemini.embeddingModel,
    },
    database: dbOk ? 'connected' : 'disconnected',
  });
});

// 3. WooCommerce Webhook for live product/catalog sync
app.post('/api/webhook/product-sync', async (req: Request, res: Response) => {
  const secret = req.headers['x-webhook-secret'];
  if (secret !== config.server.webhookSecret) {
    logger.warn({ ip: req.ip }, 'Unauthorized webhook attempt');
    return res.status(401).json({ error: 'Unauthorized: invalid webhook secret' });
  }

  const { event, product } = req.body;
  logger.info({ event, productId: product?.id, name: product?.name }, 'Received WooCommerce product sync webhook');

  const isDeleteEvent = typeof event === 'string' && /delet|trash|remov/i.test(event);

  if (product && product.id && isDeleteEvent) {
    try {
      const removed = await ragIndexer.deleteProduct(product.id);
      return res.json({ success: true, message: `Product ${product.id} removal handled`, removed });
    } catch (err: any) {
      logger.error({ err: err.message, productId: product.id }, 'Failed to remove webhook product');
      return res.status(500).json({ error: err.message });
    }
  }

  if (product && product.id) {
    try {
      await ragIndexer.indexProduct(product);
      return res.json({ success: true, message: `Product ${product.id} indexed successfully` });
    } catch (err: any) {
      logger.error({ err: err.message }, 'Failed to index webhook product');
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'Missing product payload' });
});

// 4. Admin Authentication Middleware
function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith('Bearer ') ? authHeader.substring(7) : '';

  if (token && token === config.server.adminPassword) {
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized: Invalid admin password' });
}

// 5. Admin API Routes
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === config.server.adminPassword) {
    return res.json({ success: true });
  }
  return res.status(401).json({ error: 'Invalid administrator password' });
});

app.get('/api/admin/conversations', requireAdminAuth, async (req, res) => {
  const filter = req.query.filter || 'escalations';

  try {
    let whereClause = '';
    if (filter === 'escalations') {
      whereClause = 'WHERE s.is_human_controlled = true';
    }

    const rows = await query<any>(`
      SELECT 
        s.phone, 
        s.customer_name, 
        s.is_human_controlled, 
        s.handoff_reason, 
        s.last_message_at,
        (
          SELECT content 
          FROM messages m 
          WHERE m.phone = s.phone 
          ORDER BY m.created_at DESC 
          LIMIT 1
        ) as last_message
      FROM sessions s
      ${whereClause}
      ORDER BY s.last_message_at DESC
      LIMIT 50
    `);

    const countRes = await query<any>('SELECT COUNT(*) as count FROM sessions WHERE is_human_controlled = true');
    const escalationCount = parseInt(countRes.rows[0]?.count || '0', 10);

    return res.json({
      conversations: rows.rows,
      escalationCount,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/conversation/:phone', requireAdminAuth, async (req, res) => {
  const phone = req.params.phone;

  try {
    const sessionRes = await query<any>('SELECT * FROM sessions WHERE phone = $1', [phone]);
    const messagesRes = await query<any>(
      'SELECT id, role, content, metadata, created_at FROM messages WHERE phone = $1 ORDER BY created_at ASC',
      [phone]
    );

    return res.json({
      session: sessionRes.rows[0] || null,
      messages: messagesRes.rows,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/reply', requireAdminAuth, async (req, res) => {
  const { phone, text } = req.body;
  if (!phone || !text) {
    return res.status(400).json({ error: 'Missing phone or text' });
  }

  try {
    // 1. Send message to WhatsApp via Baileys bridge
    const sent = await sendWhatsAppMessage(phone, text);
    if (!sent) {
      return res.status(502).json({ error: 'Failed to send message via WhatsApp gateway' });
    }

    // 2. Persist message with role 'human'
    await sessionManager.addMessage(phone, 'human', text);

    // 3. Refresh the handoff lease: a human is clearly present, so the session must not
    //    expire back to the bot while they are mid-conversation.
    await sessionManager.refreshHandoff(phone);

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/close-ticket', requireAdminAuth, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Missing phone' });

  try {
    await sessionManager.unlockSession(phone);
    return res.json({ success: true, message: 'Session returned to automated AI bot' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/lock-ticket', requireAdminAuth, async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Missing phone' });

  try {
    await sessionManager.lockForHuman(phone, 'Manual operator takeover');
    return res.json({ success: true, message: 'Session locked for human support' });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/sync-catalog', requireAdminAuth, async (req, res) => {
  try {
    const result = await ragIndexer.syncAllWooCommerceProducts();
    return res.json({ success: true, synced: result.indexed, removed: result.removed });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// 6. WhatsApp Connection & Control Endpoints for Admin Dashboard
app.get('/api/admin/whatsapp/status', requireAdminAuth, async (req, res) => {
  try {
    const bridgeResp = await axios.get(`${config.whatsapp.bridgeUrl}/qr`, { timeout: 4000 });
    return res.json(bridgeResp.data);
  } catch (err: any) {
    return res.status(502).json({
      isConnected: false,
      isPaused: false,
      error: 'WhatsApp bridge is not responding on port 3001',
    });
  }
});

app.post('/api/admin/whatsapp/reset', requireAdminAuth, async (req, res) => {
  try {
    const bridgeResp = await axios.post(`${config.whatsapp.bridgeUrl}/reset`, {}, { timeout: 5000 });
    return res.json(bridgeResp.data);
  } catch (err: any) {
    return res.status(502).json({ error: 'Failed to reset WhatsApp connection' });
  }
});

app.post('/api/admin/whatsapp/toggle-pause', requireAdminAuth, async (req, res) => {
  try {
    const bridgeResp = await axios.post(
      `${config.whatsapp.bridgeUrl}/pause`,
      req.body,
      { timeout: 4000 }
    );
    return res.json(bridgeResp.data);
  } catch (err: any) {
    return res.status(502).json({ error: 'Failed to toggle pause state' });
  }
});

// 7. Admin Escalation Alert Settings
app.get('/api/admin/settings', requireAdminAuth, async (req, res) => {
  try {
    const adminPhone = await settingsService.getAdminPhone();
    return res.json({ adminPhone });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/settings', requireAdminAuth, async (req, res) => {
  const { adminPhone } = req.body;
  if (!adminPhone) {
    return res.status(400).json({ error: 'Missing adminPhone in request body' });
  }

  try {
    const formatted = await settingsService.setAdminPhone(adminPhone);
    return res.json({ success: true, adminPhone: formatted });
  } catch (err: any) {
    return res.status(400).json({ error: err.message });
  }
});

app.post('/api/admin/test-alert', requireAdminAuth, async (req, res) => {
  try {
    const result = await escalationNotifier.sendTestAlert();
    if (result.success) {
      return res.json({ success: true, message: `Test alert sent to ${result.adminPhone}` });
    } else {
      return res.status(502).json({ error: result.error || 'Failed to send test alert via WhatsApp bridge' });
    }
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Start Server & Worker
async function bootstrap() {
  logger.info('Initializing Hide Haven Customer Support Agent...');

  // Check DB connection
  const isConnected = await checkDbConnection();
  if (!isConnected) {
    logger.error('Could not connect to Supabase PostgreSQL on startup. Check credentials.');
  }

  // Start BullMQ background queue worker
  startQueueWorker();

  // Listen for HTTP requests
  const port = config.server.port;
  app.listen(port, '0.0.0.0', () => {
    logger.info(`Agent HTTP Server running on http://0.0.0.0:${port}`);
    logger.info(`Admin Dashboard available at http://0.0.0.0:${port}/admin`);
  });

  // Safety net for abandoned human handoffs. getOrCreateSession() releases a stale lock the
  // moment the customer writes again, but without inbound traffic the session would stay
  // flagged forever and pollute the dashboard's escalation list. Runs twice per window.
  const sweepMinutes = Math.max(1, Math.floor(config.server.humanHandoffTimeoutMinutes / 2));
  const handoffSweeper = setInterval(async () => {
    try {
      const released = await query<{ phone: string }>(
        `UPDATE sessions
         SET is_human_controlled = false, handoff_reason = NULL, handoff_at = NULL
         WHERE is_human_controlled = true
           AND handoff_at IS NOT NULL
           AND handoff_at < NOW() - ($1::int * INTERVAL '1 minute')
         RETURNING phone`,
        [config.server.humanHandoffTimeoutMinutes]
      );

      if (released.rowCount && released.rowCount > 0) {
        logger.warn(
          { count: released.rowCount, phones: released.rows.map((r) => r.phone) },
          'Auto-released expired human handoffs'
        );
      }
    } catch (err: any) {
      logger.error({ err: err.message }, 'Handoff sweep failed');
    }
  }, sweepMinutes * 60 * 1000);

  // Never let a housekeeping timer hold the process open.
  handoffSweeper.unref();
}

bootstrap().catch((err) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});

import { query } from '../data/db';
import { config } from '../config';
import { logger } from '../utils/logger';
import { normalizeCustomerId } from '../channels/messenger/identity';

export interface Session {
  phone: string;
  customerName?: string;
  isHumanControlled: boolean;
  humanAgentId?: string;
  handoffReason?: string;
  handoffAt?: Date;
  lastMessageAt: Date;
  metadata: Record<string, any>;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'human' | 'system';
  content: string;
  createdAt: Date;
}

export class SessionManager {
  /**
   * Get or create customer session.
   * Auto-releases human handoff lock if timeout has elapsed.
   */
  async getOrCreateSession(phone: string, customerName?: string): Promise<Session> {
    const cleanPhone = normalizeCustomerId(phone);

    const existing = await query<any>(
      'SELECT phone, customer_name, is_human_controlled, human_agent_id, handoff_reason, handoff_at, last_message_at, metadata FROM sessions WHERE phone = $1',
      [cleanPhone]
    );

    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      let isHuman = row.is_human_controlled;

      // Auto-release a STALE handoff. The lock used to be permanent: once a customer
      // escalated, the bot stayed silent to them until a human remembered to click
      // "release" in the dashboard, which nobody was alerted to do — so real customers
      // went unanswered indefinitely. The window is measured from the last human activity
      // (refreshed by refreshHandoff whenever an admin replies), so an admin who is
      // actively handling the chat keeps control; only abandoned handoffs expire.
      if (isHuman && row.handoff_at) {
        const handoffAgeMs = Date.now() - new Date(row.handoff_at).getTime();
        const timeoutMs = config.server.humanHandoffTimeoutMinutes * 60 * 1000;

        if (timeoutMs > 0 && handoffAgeMs > timeoutMs) {
          logger.warn(
            { phone: cleanPhone, lockedMinutes: Math.round(handoffAgeMs / 60000) },
            'Human handoff expired with no human activity — resuming automated replies'
          );
          await query(
            `UPDATE sessions
             SET is_human_controlled = false, handoff_reason = NULL, handoff_at = NULL
             WHERE phone = $1`,
            [cleanPhone]
          );
          isHuman = false;
        }
      }

      // Update last active
      await query('UPDATE sessions SET last_message_at = NOW() WHERE phone = $1', [cleanPhone]);

      return {
        phone: cleanPhone,
        customerName: row.customer_name || customerName,
        isHumanControlled: isHuman,
        humanAgentId: row.human_agent_id,
        handoffReason: row.handoff_reason,
        handoffAt: row.handoff_at,
        lastMessageAt: new Date(row.last_message_at),
        metadata: row.metadata || {},
      };
    }

    // Create new session
    await query(
      `INSERT INTO sessions (phone, customer_name, is_human_controlled, last_message_at, metadata)
       VALUES ($1, $2, false, NOW(), '{}')`,
      [cleanPhone, customerName || null]
    );

    return {
      phone: cleanPhone,
      customerName,
      isHumanControlled: false,
      lastMessageAt: new Date(),
      metadata: {},
    };
  }

  /**
   * Save a message to history
   */
  async addMessage(
    phone: string,
    role: 'user' | 'assistant' | 'human' | 'system',
    content: string,
    metadata: Record<string, any> = {}
  ): Promise<void> {
    const cleanPhone = normalizeCustomerId(phone);
    await query(
      `INSERT INTO messages (phone, role, content, metadata, created_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [cleanPhone, role, content, JSON.stringify(metadata)]
    );
  }

  /**
   * Get recent messages for Gemini prompt context (ordered oldest to newest)
   */
  async getRecentMessages(phone: string, limit: number = 8): Promise<ChatMessage[]> {
    const cleanPhone = normalizeCustomerId(phone);
    const res = await query<any>(
      `SELECT role, content, created_at 
       FROM messages 
       WHERE phone = $1 
       ORDER BY created_at DESC 
       LIMIT $2`,
      [cleanPhone, limit]
    );

    return res.rows.reverse().map((r) => ({
      role: r.role,
      content: r.content,
      createdAt: new Date(r.created_at),
    }));
  }

  /**
   * Lock session for human agent handoff
   */
  async lockForHuman(phone: string, reason: string): Promise<void> {
    const cleanPhone = normalizeCustomerId(phone);
    await query(
      `UPDATE sessions 
       SET is_human_controlled = true, handoff_reason = $2, handoff_at = NOW(), last_message_at = NOW() 
       WHERE phone = $1`,
      [cleanPhone, reason]
    );
    logger.warn({ phone: cleanPhone, reason }, 'Session locked for human escalation');
  }

  /**
   * Unlock session back to automated AI bot
   */
  async unlockSession(phone: string): Promise<void> {
    const cleanPhone = normalizeCustomerId(phone);
    await query(
      `UPDATE sessions 
       SET is_human_controlled = false, handoff_reason = NULL, handoff_at = NULL, last_message_at = NOW() 
       WHERE phone = $1`,
      [cleanPhone]
    );
    logger.info({ phone: cleanPhone }, 'Session unlocked back to automated AI bot');
  }

  /**
   * Refresh the handoff lease. Called whenever a human replies, so the expiry window
   * measures "time since the human last did anything" rather than "time since the lock
   * was created" — an admin actively handling a chat never gets cut off mid-conversation.
   */
  async refreshHandoff(phone: string): Promise<void> {
    const cleanPhone = normalizeCustomerId(phone);
    await query(
      `UPDATE sessions
       SET handoff_at = NOW(), last_message_at = NOW()
       WHERE phone = $1 AND is_human_controlled = true`,
      [cleanPhone]
    );
  }

  /**
   * Update pending order data in session metadata
   */
  async updateSessionMetadata(phone: string, metadata: Record<string, any>): Promise<void> {
    const cleanPhone = normalizeCustomerId(phone);
    await query(
      `UPDATE sessions 
       SET metadata = metadata || $2::jsonb, last_message_at = NOW() 
       WHERE phone = $1`,
      [cleanPhone, JSON.stringify(metadata)]
    );
  }
}

export const sessionManager = new SessionManager();

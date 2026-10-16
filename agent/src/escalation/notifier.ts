import fs from 'fs';
import path from 'path';
import { settingsService, normalizePhoneNumber } from '../data/settings';
import { sessionManager } from '../session/manager';
import { query } from '../data/db';
import { sendWhatsAppMessage } from '../queue/worker';
import { logger } from '../utils/logger';

export interface EscalationPayload {
  customerPhone: string;
  reason: string;
  situationSummary?: string;
}

export interface EscalationResult {
  success: boolean;
  adminPhone?: string;
  sent: boolean;
  error?: string;
}

const ESCALATIONS_LOG_PATH = path.resolve(__dirname, '../../../logs/escalations.jsonl');

export class EscalationNotifier {
  /**
   * Format current time in Asia/Dhaka (GMT+6)
   */
  private getDhakaTime(): string {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Dhaka',
      dateStyle: 'medium',
      timeStyle: 'short',
      hour12: true,
    }).format(new Date());
  }

  /**
   * Send full situation report to store admin WhatsApp
   */
  async sendAdminEscalationAlert(payload: EscalationPayload): Promise<EscalationResult> {
    const { customerPhone, reason, situationSummary } = payload;
    const cleanCustomerPhone = customerPhone.replace(/[^\d+]/g, '');

    try {
      // 1. Fetch admin phone
      const adminPhone = await settingsService.getAdminPhone();
      const cleanAdminPhone = normalizePhoneNumber(adminPhone);

      if (!cleanAdminPhone) {
        logger.warn('Cannot send escalation alert: No admin WhatsApp phone configured');
        return { success: false, sent: false, error: 'No admin WhatsApp phone configured' };
      }

      // 2. Fetch session and recent chat context
      const session = await sessionManager.getOrCreateSession(customerPhone);
      const customerName = session.customerName || 'নতুন কাস্টমার / Not provided';
      const recentMessages = await sessionManager.getRecentMessages(customerPhone, 6);

      // 3. Format chat history snippet
      let chatSnippet = '';
      if (recentMessages.length > 0) {
        chatSnippet = recentMessages
          .map((m) => {
            const sender = m.role === 'user' ? '👤 কাস্টমার' : m.role === 'assistant' ? '🤖 AI' : '👨‍💼 Human';
            const cleanContent = m.content.replace(/\n+/g, ' ').trim();
            const truncated = cleanContent.length > 120 ? `${cleanContent.substring(0, 117)}...` : cleanContent;
            return `${sender}: "${truncated}"`;
          })
          .join('\n');
      } else {
        chatSnippet = '(No recent messages logged)';
      }

      // 4. Check for any recent customer order
      let orderSnippet = '';
      try {
        const orderRes = await query<any>(
          `SELECT id, status, total, currency, created_at 
           FROM customer_orders 
           WHERE billing->>'phone' LIKE $1 OR billing->>'phone' LIKE $2 
           ORDER BY created_at DESC 
           LIMIT 1`,
          [`%${cleanCustomerPhone.slice(-10)}%`, `%${cleanCustomerPhone}%`]
        );
        if (orderRes.rows.length > 0) {
          const o = orderRes.rows[0];
          orderSnippet = `📦 *সম্পর্কিত অর্ডার:* #${o.id} | স্ট্যাটাস: ${o.status.toUpperCase()} | বিল: ${o.total} ${o.currency || 'BDT'}`;
        } else if (session.metadata?.last_order) {
          const lo = session.metadata.last_order;
          orderSnippet = `📦 *সম্পর্কিত অর্ডার:* #${lo.orderId || 'Recent'} | পণ্য: ${lo.product || ''} | মোট: ${lo.totalBill || ''} BDT`;
        }
      } catch (err: any) {
        logger.debug({ err: err.message }, 'Could not fetch order context for escalation alert');
      }

      const timestamp = this.getDhakaTime();

      // 5. Construct the WhatsApp Alert Message
      const alertMessage = 
`🚨 *[Hide Haven — জরুরি কাস্টমার সহায়তা এলার্ট]*
━━━━━━━━━━━━━━━━━━━━━
👤 *গ্রাহকের নাম:* ${customerName}
📞 *ফোন নম্বর:* ${cleanCustomerPhone} (wa.me/${cleanCustomerPhone.replace('+', '')})
⏰ *সময়:* ${timestamp}
⚠️ *হ্যান্ডঅফ কারণ:* ${reason}
${situationSummary ? `\n📋 *পরিস্থিতি সারসংক্ষেপ:*\n${situationSummary}\n` : ''}
💬 *সাম্প্রতিক চ্যাট হিস্ট্রি:*
${chatSnippet}
${orderSnippet ? `\n${orderSnippet}\n` : ''}
👉 *জরুরি করণীয়:*
পরিস্থিতি নিয়ন্ত্রণে নিতে কাস্টমারের সাথে সরাসরি যোগাযোগ করুন অথবা অ্যাডমিন পোর্টালে চ্যাট টেক-ওভার করুন।

🔗 *অ্যাডমিন পোর্টাল সরাসরি লিঙ্ক:*
https://agent.apigateway.live/admin
━━━━━━━━━━━━━━━━━━━━━`;

      // 6. Send message to Admin WhatsApp via bridge
      const adminJid = `${cleanAdminPhone}@s.whatsapp.net`;
      logger.info({ adminJid, customerPhone, reason }, 'Dispatching WhatsApp escalation report to admin');
      const sent = await sendWhatsAppMessage(adminJid, alertMessage);

      // 7. Write audit log to escalations.jsonl
      try {
        const logEntry = {
          timestamp: new Date().toISOString(),
          customer_phone: customerPhone,
          customer_name: customerName,
          admin_phone: adminPhone,
          reason,
          situation_summary: situationSummary || null,
          alert_sent: sent,
          order_info: orderSnippet || null,
        };
        fs.appendFileSync(ESCALATIONS_LOG_PATH, JSON.stringify(logEntry) + '\n');
      } catch (logErr: any) {
        logger.error({ err: logErr.message }, 'Failed to write to escalations.jsonl');
      }

      return {
        success: true,
        adminPhone,
        sent,
      };
    } catch (err: any) {
      logger.error({ err: err.message, customerPhone }, 'Failed to process escalation alert');
      return {
        success: false,
        sent: false,
        error: err.message,
      };
    }
  }

  /**
   * Send a test alert to verify admin phone configuration
   */
  async sendTestAlert(targetPhone?: string): Promise<EscalationResult> {
    try {
      const adminPhone = targetPhone || (await settingsService.getAdminPhone());
      const cleanAdminPhone = normalizePhoneNumber(adminPhone);

      if (!cleanAdminPhone) {
        return { success: false, sent: false, error: 'No admin WhatsApp phone configured' };
      }

      const timestamp = this.getDhakaTime();
      const testMessage = 
`🔔 *[Hide Haven — অ্যাডমিন এলার্ট সফল টেস্ট / Test Alert]*
━━━━━━━━━━━━━━━━━━━━━
✅ আপনার WhatsApp নম্বরটি অ্যাডমিন এলার্ট হিসেবে সফলভাবে যুক্ত ও সক্রিয় করা হয়েছে!

📱 *কনফিগার করা নম্বর:* ${adminPhone}
⏰ *সময়:* ${timestamp}

💡 *সিস্টেম কার্যপদ্ধতি:*
যখন কোনো গ্রাহকের সাথে AI কথোপকথন জটিল হবে, কাস্টমার অসন্তুষ্ট হবেন, অথবা সরাসরি মানুষের সাথে কথা বলতে চাইবেন, তখন সাথে সাথে এই নম্বরে সম্পূর্ণ পরিস্থিতির রিপোর্ট ও চ্যাট হিস্ট্রি চলে আসবে।

🔗 *অ্যাডমিন পোর্টাল:*
https://agent.apigateway.live/admin
━━━━━━━━━━━━━━━━━━━━━`;

      const adminJid = `${cleanAdminPhone}@s.whatsapp.net`;
      logger.info({ adminJid }, 'Sending test escalation alert to admin WhatsApp');
      const sent = await sendWhatsAppMessage(adminJid, testMessage);

      return {
        success: sent,
        adminPhone,
        sent,
        error: sent ? undefined : 'WhatsApp bridge could not deliver the message. Ensure WhatsApp is connected.',
      };
    } catch (err: any) {
      return {
        success: false,
        sent: false,
        error: err.message,
      };
    }
  }
}

export const escalationNotifier = new EscalationNotifier();

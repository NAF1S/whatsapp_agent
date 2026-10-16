import { query } from './db';
import { config } from '../config';
import { logger } from '../utils/logger';

export function normalizePhoneNumber(rawPhone: string): string {
  if (!rawPhone) return '';
  let cleaned = rawPhone.replace(/[^\d]/g, '');
  // If Bangladesh local mobile (e.g. 01892740307 - 11 digits starting with 01)
  if (cleaned.startsWith('01') && cleaned.length === 11) {
    cleaned = '88' + cleaned;
  }
  return cleaned;
}

export class SettingsService {
  async getSetting(key: string, defaultValue: string = ''): Promise<string> {
    try {
      const res = await query<any>(
        'SELECT value FROM agent_settings WHERE key = $1',
        [key]
      );
      if (res.rows.length > 0 && res.rows[0].value) {
        return res.rows[0].value;
      }
    } catch (err: any) {
      logger.error({ err: err.message, key }, 'Failed to fetch setting from DB');
    }
    return defaultValue;
  }

  async setSetting(key: string, value: string): Promise<void> {
    await query(
      `INSERT INTO agent_settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = NOW()`,
      [key, value]
    );
  }

  async getAdminPhone(): Promise<string> {
    const defaultVal = config.whatsapp.adminPhone || '+8801892740307';
    return await this.getSetting('admin_whatsapp_phone', defaultVal);
  }

  async setAdminPhone(phone: string): Promise<string> {
    const normalized = normalizePhoneNumber(phone);
    if (!normalized || normalized.length < 10) {
      throw new Error('Invalid phone number. Please enter a valid WhatsApp phone number (e.g. 01892740307 or +8801892740307).');
    }
    const formatted = `+${normalized}`;
    await this.setSetting('admin_whatsapp_phone', formatted);
    logger.info({ phone: formatted }, 'Admin WhatsApp phone updated');
    return formatted;
  }
}

export const settingsService = new SettingsService();

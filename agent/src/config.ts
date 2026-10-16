import dotenv from 'dotenv';
import path from 'path';

// Load from current dir or parent dir
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Secrets must have NO hardcoded fallback. A baked-in default is published to anyone who
// can read the source, and it silently keeps working after a deploy — so the leak is never
// noticed. Failing loudly at boot is the safer trade. For ADMIN_PASSWORD a fallback is
// doubly dangerous: `password === ''` would authenticate an empty password.
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        'Copy agent/.env.example to agent/.env and fill in every REQUIRED value.'
    );
  }
  return value;
}

export const config = {
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    brainModel: process.env.GEMINI_BRAIN_MODEL || 'gemini-2.5-flash',
    chatModel: process.env.GEMINI_CHAT_MODEL || 'gemini-3.5-flash-lite',
    chatFallbackModel: process.env.GEMINI_CHAT_FALLBACK_MODEL || 'gemini-3.1-flash-lite',
    transcribeModel: process.env.GEMINI_TRANSCRIBE_MODEL || 'gemini-3.5-transcribe',
    embeddingModel: process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-2',
    embeddingDimension: 768,
  },
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    model: process.env.DEEPSEEK_MODEL || 'deepseek-flash',
    effort: (process.env.DEEPSEEK_EFFORT || 'low') as 'low' | 'high' | 'max',
    isPrimary: (process.env.AI_PRIMARY_PROVIDER || 'deepseek').toLowerCase() === 'deepseek',
  },
  db: {
    host: required('DB_HOST'),
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'postgres',
    password: required('DB_PASSWORD'),
    database: process.env.DB_NAME || 'postgres',
    ssl: { rejectUnauthorized: false },
    max: 10,
    idleTimeoutMillis: 30000,
  },
  redis: {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
  },
  woocommerce: {
    url: process.env.WOOCOMMERCE_URL || 'https://shop.hidehaven.me/wp-json/wc/v3',
    consumerKey: process.env.WOOCOMMERCE_CONSUMER_KEY || '',
    consumerSecret: process.env.WOOCOMMERCE_CONSUMER_SECRET || '',
    appPassword: process.env.WORDPRESS_APP_PASSWORD || '',
  },
  whatsapp: {
    adminPhone: process.env.WHATSAPP_ADMIN_PHONE || '+8801892740307',
    bridgeUrl: process.env.WHATSAPP_BRIDGE_URL || 'http://127.0.0.1:3001',
  },
  server: {
    port: parseInt(process.env.AGENT_PORT || '3000', 10),
    adminPassword: required('ADMIN_PASSWORD'),
    webhookSecret: required('WEBHOOK_SECRET'),
    humanHandoffTimeoutMinutes: parseInt(process.env.HUMAN_HANDOFF_TIMEOUT_MINUTES || '30', 10),
    logLevel: process.env.LOG_LEVEL || 'info',
  },
};

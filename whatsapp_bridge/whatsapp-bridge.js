/**
 * WhatsApp Baileys Bridge for Hide Haven AI Agent (Queue-Backed Architecture)
 * 
 * - Dispatches all incoming WhatsApp events (text, audio, image) to Redis BullMQ.
 * - Exposes an Express HTTP server (port 3001) for outbound messaging, QR export,
 *   connection resets, and bot pause/resume controls.
 */

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const crypto = require('crypto');
const pino = require('pino');
const express = require('express');
const qrcodeTerminal = require('qrcode-terminal');
const QRCode = require('qrcode');
const path = require('path');
const axios = require('axios');
const { Queue } = require('bullmq');
require('dotenv').config();

// Setup logging
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: { target: 'pino-pretty' },
});

// Suppress verbose Baileys session logging and non-critical timeout errors
const baileysLogger = pino({
  level: 'error',
  hooks: {
    logMethod(inputArgs, method) {
      const err = inputArgs[0]?.err;
      if (err?.message === 'Timed Out' && inputArgs[0]?.msg?.includes('init queries')) {
        return; // Suppress
      }
      return method.apply(this, inputArgs);
    },
  },
});

// Configuration
const AUTH_DIR = path.resolve(__dirname, process.env.AUTH_DIR || 'auth_info');
const HTTP_PORT = parseInt(process.env.BRIDGE_HTTP_PORT || '3001', 10);
const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = parseInt(process.env.REDIS_PORT || '6379', 10);
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;

/**
 * Main WhatsApp Bridge Class
 */
class HideHavenWhatsAppBridge {
  constructor() {
    this.sock = null;
    this.isConnected = false;
    this.reconnectTimer = null;
    this.resetInProgress = false;

    // QR & Control State
    this.currentQR = null;
    this.qrDataUrl = null;
    this.lastQrTimestamp = null;
    this.isPaused = false;
    this.httpServerStarted = false;

    // Debounce message buffers per customer jid (merges rapid photo + text bursts)
    this.messageBuffers = new Map();

    // Mapping for phone/LID to real remoteJid
    this.jidMap = new Map();

    // LID (WhatsApp privacy id) -> real phone number, loaded from Baileys' on-disk mappings
    this.lidToPn = new Map();

    // Recently seen inbound message ids, so a WhatsApp redelivery cannot be answered twice
    this.seenMessageIds = new Map();

    // Redis BullMQ queue for incoming messages
    this.incomingQueue = new Queue('whatsapp-incoming', {
      connection: {
        host: REDIS_HOST,
        port: REDIS_PORT,
        ...(REDIS_PASSWORD ? { password: REDIS_PASSWORD } : {}),
      },
    });

    // Unhandled 'error' events on an EventEmitter are fatal — a Redis blip would otherwise
    // crash the bridge (and lose any messages sitting in the 3-second debounce buffer).
    this.incomingQueue.on('error', (err) => {
      logger.error(`Incoming queue error (Redis): ${err.message}`);
    });
  }

  /**
   * Load the LID -> phone-number mappings Baileys keeps in auth_info.
   *
   * Some customers reach us from a WhatsApp privacy id ("...@lid"), which is NOT a phone
   * number. Without this, the LID was stored as the customer's phone number, so order
   * lookups never matched and admin escalation reports showed an uncontactable "number".
   */
  _loadLidMappings() {
    try {
      const files = fs
        .readdirSync(AUTH_DIR)
        .filter((f) => f.startsWith('lid-mapping-') && f.endsWith('_reverse.json'));

      for (const file of files) {
        const lid = file.slice('lid-mapping-'.length, -'_reverse.json'.length);
        if (this.lidToPn.has(lid)) continue;
        try {
          const pn = String(JSON.parse(fs.readFileSync(path.join(AUTH_DIR, file), 'utf-8')) || '').replace(/\D/g, '');
          if (pn) this.lidToPn.set(lid, pn);
        } catch (e) {
          // Ignore an unreadable/partial mapping file; it will be retried on demand below.
        }
      }
      logger.info(`Loaded ${this.lidToPn.size} LID->phone mappings from ${AUTH_DIR}`);
    } catch (e) {
      logger.warn(`Could not load LID mappings: ${e.message}`);
    }
  }

  /**
   * Resolve a LID to a real phone number, or null when WhatsApp has not published one yet.
   */
  _pnForLid(lid) {
    if (!lid) return null;
    if (this.lidToPn.has(lid)) return this.lidToPn.get(lid);

    try {
      const file = path.join(AUTH_DIR, `lid-mapping-${lid}_reverse.json`);
      if (fs.existsSync(file)) {
        const pn = String(JSON.parse(fs.readFileSync(file, 'utf-8')) || '').replace(/\D/g, '');
        if (pn) {
          this.lidToPn.set(lid, pn);
          return pn;
        }
      }
    } catch (e) {
      // fall through — caller keeps the LID as the best available identifier
    }
    return null;
  }

  /**
   * Bound the duplicate-suppression set so it can never grow without limit.
   */
  _pruneSeenMessageIds() {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const [id, ts] of this.seenMessageIds) {
      if (ts < cutoff) this.seenMessageIds.delete(id);
    }
    if (this.seenMessageIds.size > 5000) {
      const excess = this.seenMessageIds.size - 5000;
      let removed = 0;
      for (const id of this.seenMessageIds.keys()) {
        this.seenMessageIds.delete(id);
        if (++removed >= excess) break;
      }
    }
  }

  /**
   * Unwrap the message containers WhatsApp nests real content inside. Without this, a
   * customer with disappearing messages enabled (ephemeralMessage) or a view-once photo
   * was dropped entirely, because the wrapper hid the actual payload.
   */
  _unwrapMessage(message) {
    let current = message;
    let guard = 0;
    while (current && guard++ < 5) {
      const wrapper = current.ephemeralMessage || current.viewOnceMessage ||
        current.viewOnceMessageV2 || current.viewOnceMessageV2Extension ||
        current.documentWithCaptionMessage;
      if (wrapper && wrapper.message) {
        current = wrapper.message;
        continue;
      }
      break;
    }
    return current || {};
  }

  /**
   * Resolve destination JID accurately (handles raw digits, LID, and international numbers)
   */
  resolveJid(to) {
    if (!to) return null;
    const str = String(to).trim();

    if (str.includes('@')) {
      return str;
    }

    if (this.jidMap.has(str)) {
      return this.jidMap.get(str);
    }

    // Check if auth_info has lid file for this ID
    try {
      if (fs.existsSync(path.join(AUTH_DIR, `tctoken-${str}@lid.json`))) {
        const lidJid = `${str}@lid`;
        this.jidMap.set(str, lidJid);
        return lidJid;
      }
    } catch (e) {}

    let clean = str.replace(/[^\d]/g, '');
    if (clean.startsWith('01') && clean.length === 11) {
      clean = '88' + clean;
    }
    return `${clean}@s.whatsapp.net`;
  }

  /**
   * Initialize WhatsApp connection
   */
  async initialize() {
    logger.info('Initializing WhatsApp Baileys bridge (Queue Architecture)...');

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Know every privacy-id -> phone number mapping we already have on disk.
    this._loadLidMappings();

    const { version, isLatest, error } = await fetchLatestBaileysVersion();
    if (error) {
      logger.warn(`Using bundled Baileys version: ${error.message || error}`);
    } else if (!isLatest) {
      logger.warn('Using bundled Baileys version');
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    this.sock = makeWASocket({
      auth: state,
      logger: baileysLogger,
      browser: ['Hide Haven WhatsApp Bridge', 'Chrome', '2.0.0'],
      version,
      markOnlineOnConnect: true,
      msgRetryCountDefaultMaxMs: 120000,
    });

    this.sock.ev.on('connection.update', (update) => {
      this._handleConnectionUpdate(update, saveCreds);
    });

    this.sock.ev.on('messages.upsert', (m) => {
      this._handleIncomingMessage(m);
    });

    this.sock.ev.on('creds.update', saveCreds);

    // Start Express API server for outbound dispatch & controls
    this._startHttpServer();

    logger.info('WhatsApp bridge initialized');
  }

  /**
   * Handle connection updates (QR code, connection status, etc.)
   */
  async _handleConnectionUpdate(update, saveCreds) {
    const { connection, lastDisconnect, qr } = update;
    const statusCode = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output?.statusCode : undefined;

    const lastErrorMessage = lastDisconnect?.error?.message || '';
    if (lastErrorMessage && /bad session|bad encrypted|decryption|encrypted message/i.test(lastErrorMessage)) {
      logger.error(`Detected encryption/bad-session error: ${lastErrorMessage}`);
      this._resetAuthState('Detected encryption/bad-session error');
      return;
    }

    if (qr) {
      this.currentQR = qr;
      this.lastQrTimestamp = Date.now();
      try {
        this.qrDataUrl = await QRCode.toDataURL(qr, { width: 320, margin: 2 });
      } catch (e) {
        logger.error(`Failed to generate QR data URL: ${e.message}`);
      }
      logger.info('QR Code received — scan in WhatsApp or visit Admin Dashboard');
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === 'open') {
      this.isConnected = true;
      this.currentQR = null;
      this.qrDataUrl = null;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      logger.info('WhatsApp connected successfully!');
    }

    if (connection === 'close') {
      this.isConnected = false;

      // Only these codes mean the session can never work again, and only these may discard
      // credentials. Everything else is a transient drop that must be retried.
      const logoutReasons = new Set([
        DisconnectReason.loggedOut,           // 401 — the device/session was removed
        DisconnectReason.badSession,          // 500 — stored credentials are unusable
        DisconnectReason.multideviceMismatch, // 411
        DisconnectReason.forbidden,           // 403
      ]);

      // The previous logic reconnected only for a whitelist of codes and treated EVERYTHING
      // else — including a missing statusCode and transient stream errors — as a logout, which
      // deleted the whole auth directory. On 2026-10-15 a transient "Stream Errored (503)"
      // therefore wiped the live WhatsApp session permanently. Default to reconnecting.
      const isLogout = statusCode !== undefined && logoutReasons.has(statusCode);
      const isConflict = statusCode === DisconnectReason.connectionReplaced; // 440

      logger.warn(
        `WhatsApp disconnected: ${lastDisconnect?.error?.message || 'Unknown reason'}${statusCode ? ` (status ${statusCode})` : ''}`
      );

      if (isLogout) {
        logger.error(
          `WhatsApp reported a genuine logout (status ${statusCode}). Credentials must be re-paired; the old auth state is kept aside in case this was wrong.`
        );
        this._resetAuthState(`Logged out (status ${statusCode})`);
        setTimeout(() => this.initialize(), 1500);
      } else {
        const delay = isConflict ? 15000 : 3000;
        if (isConflict) {
          logger.error('WhatsApp session conflict detected (status 440). Reconnecting in 15 seconds.');
        } else {
          logger.info(`Reconnecting in ${delay / 1000} seconds...`);
        }
        if (!this.reconnectTimer) {
          this.reconnectTimer = setTimeout(() => this.initialize(), delay);
        }
      }
    }
  }

  /**
   * Clear saved auth state
   */
  _resetAuthState(reason) {
    if (this.resetInProgress) return;
    this.resetInProgress = true;

    try {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      if (this.sock?.end) {
        try {
          this.sock.end(new Boom(reason, { statusCode: DisconnectReason.connectionReplaced }));
        } catch (error) {
          logger.debug(`Socket end failed: ${error.message}`);
        }
      }

      // QUARANTINE the old credentials instead of deleting them. This used to be an
      // fs.rmSync() of the whole directory, so a single wrongly-detected logout destroyed the
      // WhatsApp session with no way back. Kept aside, it can be restored by hand:
      //   mv <quarantine dir> back to auth_info and restart the bridge.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const quarantine = path.join(path.dirname(AUTH_DIR), `auth_info.broken-${stamp}`);
      let quarantined = false;
      try {
        if (fs.existsSync(AUTH_DIR)) {
          fs.renameSync(AUTH_DIR, quarantine);
          fs.chmodSync(quarantine, 0o700);
          quarantined = true;
        }
      } catch (moveErr) {
        logger.warn(`Could not set aside the old auth state (${moveErr.message}); leaving it in place.`);
      }

      fs.mkdirSync(AUTH_DIR, { recursive: true });
      this.currentQR = null;
      this.qrDataUrl = null;
      logger.error(
        `${reason}. ${quarantined ? `Auth state set aside at ${quarantine} (restorable by hand) and reset.` : 'Auth state reset.'}`
      );
    } catch (error) {
      logger.error(`Failed to reset auth state: ${error.message}`);
    } finally {
      this.isConnected = false;
      this.sock = null;
      setTimeout(() => {
        this.resetInProgress = false;
      }, 5000);
    }
  }

  /**
   * Handle incoming messages from WhatsApp and buffer them for debouncing
   */
  async _handleIncomingMessage(m) {
    const { messages } = m;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid === 'status@broadcast') continue;

      // Never ingest group / newsletter / channel traffic as a customer conversation —
      // otherwise the bot answers into the whole group and shows up in the admin inbox.
      const remoteJid = msg.key.remoteJid || '';
      if (remoteJid.endsWith('@g.us') || remoteJid.endsWith('@newsletter') ||
          remoteJid.endsWith('@broadcast')) {
        continue;
      }

      try {
        // Drop WhatsApp redeliveries (common after a reconnect): answering the same
        // message twice means a duplicate reply, and potentially a duplicate order.
        const msgId = msg.key.id;
        if (msgId) {
          if (this.seenMessageIds.has(msgId)) {
            logger.debug(`Skipping duplicate inbound message id ${msgId}`);
            continue;
          }
          this.seenMessageIds.set(msgId, Date.now());
          this._pruneSeenMessageIds();
        }

        const unwrapped = this._unwrapMessage(msg.message);

        // Reactions, edits, deletes and poll updates carry no customer intent.
        if (unwrapped.reactionMessage || unwrapped.protocolMessage ||
            unwrapped.pollUpdateMessage || unwrapped.pollCreationMessage) {
          continue;
        }

        // Identify the customer by a REAL phone number wherever possible.
        const isLid = remoteJid.endsWith('@lid');
        const lidDigits = isLid ? remoteJid.split('@')[0] : null;

        let senderPn = null;
        const altJid = msg.key.remoteJidAlt || msg.key.senderPn || msg.key.participantAlt || null;
        if (altJid && !String(altJid).endsWith('@lid')) {
          const digits = String(altJid).split('@')[0].replace(/\D/g, '');
          if (digits) senderPn = digits;
        }
        if (!senderPn && lidDigits) {
          senderPn = this._pnForLid(lidDigits);
        }

        const senderPhone = senderPn || remoteJid.split('@')[0];
        if (isLid && !senderPn) {
          logger.warn(`No phone number known yet for LID ${lidDigits}; using the LID as the customer id`);
        }

        this.jidMap.set(senderPhone, remoteJid);
        this.jidMap.set(remoteJid, remoteJid);
        if (lidDigits) this.jidMap.set(lidDigits, remoteJid);

        let messageText = '';
        let messageType = 'text';
        let mediaBase64 = null;
        let caption = '';
        let mimeType = '';

        if (unwrapped.conversation) {
          messageText = unwrapped.conversation;
          messageType = 'text';
        } else if (unwrapped.extendedTextMessage?.text) {
          messageText = unwrapped.extendedTextMessage.text;
          messageType = 'text';
        } else if (unwrapped.audioMessage) {
          messageType = 'audio';
          mimeType = (unwrapped.audioMessage.mimetype || 'audio/ogg').split(';')[0];
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {});
            mediaBase64 = buffer.toString('base64');
            logger.info(`Downloaded voice note from ${senderPhone} (${buffer.length} bytes)`);
          } catch (e) {
            logger.error(`Failed to download audio message: ${e.message}`);
          }
        } else if (unwrapped.imageMessage) {
          messageType = 'image';
          caption = unwrapped.imageMessage?.caption || '';
          mimeType = (unwrapped.imageMessage?.mimetype || 'image/jpeg').split(';')[0];
          try {
            const buffer = await downloadMediaMessage(msg, 'buffer', {});
            mediaBase64 = buffer.toString('base64');
            logger.info(`Downloaded image from ${senderPhone} (${buffer.length} bytes)`);
          } catch (e) {
            logger.error(`Failed to download image message: ${e.message}`);
          }
        } else if (unwrapped.documentMessage) {
          // Payment screenshots are frequently sent as "documents" — read image docs as images.
          const docMime = (unwrapped.documentMessage.mimetype || '').split(';')[0];
          const docName = unwrapped.documentMessage.fileName || 'file';
          caption = unwrapped.documentMessage.caption || '';
          if (docMime.startsWith('image/')) {
            messageType = 'image';
            mimeType = docMime;
            try {
              const buffer = await downloadMediaMessage(msg, 'buffer', {});
              mediaBase64 = buffer.toString('base64');
              logger.info(`Downloaded image document from ${senderPhone} (${buffer.length} bytes)`);
            } catch (e) {
              logger.error(`Failed to download image document: ${e.message}`);
            }
          } else {
            messageType = 'text';
            messageText = `[Customer sent a document "${docName}" (${docMime || 'unknown type'})${caption ? ` with caption: "${caption}"` : ''}. You cannot open documents — acknowledge it and ask them to send it as a photo if you need to see it.]`;
            caption = '';
          }
        } else if (unwrapped.videoMessage) {
          messageType = 'text';
          messageText = `[Customer sent a video${caption || unwrapped.videoMessage?.caption ? ` with caption: "${caption || unwrapped.videoMessage.caption}"` : ''}. You cannot view videos — acknowledge it and answer in text.]`;
        } else if (unwrapped.stickerMessage) {
          messageType = 'text';
          messageText = '[Customer sent a sticker. Respond briefly and naturally, and continue helping if there is an open question.]';
        } else if (unwrapped.locationMessage || unwrapped.liveLocationMessage) {
          const loc = unwrapped.locationMessage || unwrapped.liveLocationMessage;
          messageType = 'text';
          messageText = `[Customer shared a location: latitude ${loc?.degreesLatitude}, longitude ${loc?.degreesLongitude}${loc?.name ? `, name: ${loc.name}` : ''}${loc?.address ? `, address: ${loc.address}` : ''}. If they asked for delivery, confirm delivery is possible and continue the order flow.]`;
        } else if (unwrapped.contactMessage || unwrapped.contactsArrayMessage) {
          messageType = 'text';
          messageText = '[Customer shared a contact card. Acknowledge it and ask what they would like to do with it.]';
        } else if (unwrapped.buttonsResponseMessage || unwrapped.listResponseMessage ||
                   unwrapped.templateButtonReplyMessage) {
          const tapped = unwrapped.buttonsResponseMessage?.selectedDisplayText ||
            unwrapped.listResponseMessage?.title ||
            unwrapped.templateButtonReplyMessage?.selectedDisplayText || '';
          messageType = 'text';
          messageText = tapped || '[Customer tapped a reply button.]';
        } else {
          logger.warn({ type: Object.keys(unwrapped || {}) }, 'Unsupported WhatsApp message type');
          messageType = 'text';
          messageText = '[Customer sent a message type this assistant cannot read. Ask them politely to resend it as text, a voice note, or a photo.]';
        }

        // Buffer message to debounce rapid multi-message bursts (e.g. image + immediate text)
        this._bufferIncomingMessage(remoteJid, {
          sessionId: remoteJid,
          senderPhone,
          senderLid: lidDigits,
          messageId: msgId,
          messageType,
          textPayload: messageText,
          mediaBase64,
          caption,
          mimeType,
          timestamp: Date.now(),
          isBotPaused: this.isPaused,
        });

      } catch (error) {
        logger.error(`Error processing incoming message: ${error.message}`);
      }
    }
  }

  /**
   * Buffer incoming messages by customer JID for 3.0 seconds to combine rapid bursts
   */
  _bufferIncomingMessage(jid, item) {
    if (!this.messageBuffers.has(jid)) {
      this.messageBuffers.set(jid, {
        items: [],
        timer: null,
      });
    }

    const entry = this.messageBuffers.get(jid);
    entry.items.push(item);

    if (entry.timer) {
      clearTimeout(entry.timer);
    }

    // Wait 3000ms of inactivity before flushing into queue
    entry.timer = setTimeout(() => {
      this._flushMessageBuffer(jid);
    }, 3000);
  }

  /**
   * Flush and merge buffered messages for a customer into a single consolidated queue item
   */
  async _flushMessageBuffer(jid) {
    const entry = this.messageBuffers.get(jid);
    this.messageBuffers.delete(jid);
    if (!entry || entry.items.length === 0) return;

    const items = entry.items;
    const texts = items
      .map((i) => (i.caption || i.textPayload || '').trim())
      .filter((t) => t.length > 0);
    const combinedText = texts.join('\n').trim();

    const imageItems = items.filter((i) => i.messageType === 'image' && i.mediaBase64);
    const audioItems = items.filter((i) => i.messageType === 'audio' && i.mediaBase64);

    // Photo/voice note whose download failed: we must still reply, not drop the customer.
    const hadUnreadableMedia = items.some(
      (i) => (i.messageType === 'image' || i.messageType === 'audio') && !i.mediaBase64
    );

    let finalPayload;

    if (imageItems.length > 0) {
      finalPayload = {
        sessionId: jid,
        senderPhone: items[0].senderPhone,
        messageType: 'image',
        textPayload: combinedText,
        caption: combinedText,
        mediaBase64: imageItems[0].mediaBase64,
        mimeType: imageItems[0].mimeType || 'image/jpeg',
        mediaList: imageItems.map((img) => ({
          mediaBase64: img.mediaBase64,
          mimeType: img.mimeType || 'image/jpeg',
          caption: img.caption || '',
        })),
        timestamp: Date.now(),
        isBotPaused: this.isPaused,
      };
    } else if (audioItems.length > 0) {
      finalPayload = {
        sessionId: jid,
        senderPhone: items[0].senderPhone,
        messageType: 'audio',
        textPayload: combinedText,
        caption: combinedText,
        mediaBase64: audioItems[0].mediaBase64,
        mimeType: audioItems[0].mimeType || 'audio/ogg',
        timestamp: Date.now(),
        isBotPaused: this.isPaused,
      };
    } else {
      finalPayload = {
        sessionId: jid,
        senderPhone: items[0].senderPhone,
        messageType: 'text',
        // Media that failed to download used to become an empty payload, which the agent
        // dropped without ever replying. Send an explicit marker so the customer is answered.
        textPayload: combinedText ||
          (hadUnreadableMedia
            ? '[Customer sent a photo or voice note that could not be downloaded. Apologise briefly and ask them to send it again.]'
            : ''),
        timestamp: Date.now(),
        isBotPaused: this.isPaused,
      };
    }

    try {
      const jobOptions = {
        removeOnComplete: 100,
        removeOnFail: 200,
      };

      // Idempotency key: a redelivered batch (after a reconnect or a crash mid-job)
      // cannot create a second job, so it cannot produce a second reply or order.
      const messageIds = items.map((i) => i.messageId).filter((id) => !!id);
      if (messageIds.length > 0) {
        jobOptions.jobId = `wa-${crypto.createHash('sha1').update(messageIds.sort().join('|')).digest('hex')}`;
      }

      await this.incomingQueue.add('message', finalPayload, jobOptions);
      logger.info(
        `Debounced (3000ms) & enqueued consolidated ${finalPayload.messageType} message from ${finalPayload.senderPhone} (${items.length} raw events merged)`
      );
    } catch (err) {
      logger.error(`Failed to enqueue consolidated message: ${err.message}`);
    }
  }

  /**
   * Express HTTP server for outbound message requests from AI agent & dashboard
   */
  _startHttpServer() {
    if (this.httpServerStarted) return;
    this.httpServerStarted = true;

    const app = express();
    app.use(express.json({ limit: '10mb' }));

    // Send text message
    app.post('/send', async (req, res) => {
      const { to, text } = req.body;
      if (!to || !text) {
        return res.status(400).json({ error: 'Missing "to" or "text"' });
      }

      const jid = this.resolveJid(to);
      const success = await this._sendMessage(jid, text);
      if (success) {
        return res.json({ success: true, to: jid });
      } else {
        return res.status(500).json({ success: false, error: 'Socket not connected' });
      }
    });

    // Send image message (downloads image buffer first for 100% reliable WhatsApp delivery)
    app.post('/send-image', async (req, res) => {
      const { to, imageUrl, caption } = req.body;
      if (!to || !imageUrl) {
        return res.status(400).json({ error: 'Missing "to" or "imageUrl"' });
      }

      const jid = this.resolveJid(to);
      try {
        if (!this.sock || !this.isConnected) {
          return res.status(503).json({ error: 'WhatsApp not connected' });
        }

        let imagePayload = { url: imageUrl };
        try {
          const resp = await axios.get(imageUrl, { responseType: 'arraybuffer', timeout: 12000 });
          imagePayload = Buffer.from(resp.data);
        } catch (fetchErr) {
          logger.warn(`Could not pre-fetch image buffer, falling back to direct URL: ${fetchErr.message}`);
        }

        await this.sock.sendMessage(jid, {
          image: imagePayload,
          caption: caption || '',
        });
        logger.info(`Sent real WhatsApp photo to ${jid}: ${imageUrl}`);
        return res.json({ success: true, to: jid });
      } catch (err) {
        logger.error({ err: err.message }, 'Failed to send image');
        return res.status(500).json({ error: err.message });
      }
    });

    // QR Code & Live Connection Status (for web dashboard)
    app.get('/qr', (req, res) => {
      res.json({
        isConnected: this.isConnected,
        isPaused: this.isPaused,
        qrDataUrl: this.qrDataUrl,
        lastQrTimestamp: this.lastQrTimestamp,
        timestamp: new Date().toISOString(),
      });
    });

    // Reset / Disconnect WhatsApp connection
    app.post('/reset', (req, res) => {
      logger.warn('Admin requested WhatsApp connection reset');
      this._resetAuthState('Admin requested connection reset');
      setTimeout(() => this.initialize(), 1500);
      res.json({ success: true, message: 'WhatsApp session reset. Generating fresh QR code...' });
    });

    // Pause / Resume WhatsApp Bot
    app.post('/pause', (req, res) => {
      const { paused } = req.body;
      this.isPaused = typeof paused === 'boolean' ? paused : !this.isPaused;
      logger.info(`WhatsApp Bridge paused status set to: ${this.isPaused}`);
      res.json({ success: true, isPaused: this.isPaused });
    });

    // Bridge Status
    app.get('/status', (req, res) => {
      res.json({
        isConnected: this.isConnected,
        isPaused: this.isPaused,
        timestamp: new Date().toISOString(),
      });
    });

    app.listen(HTTP_PORT, '127.0.0.1', () => {
      logger.info(`WhatsApp Bridge HTTP API listening on http://127.0.0.1:${HTTP_PORT}`);
    });
  }

  /**
   * Send text message to WhatsApp user
   */
  async _sendMessage(jid, text) {
    try {
      if (!this.sock || !this.isConnected) {
        logger.error('WhatsApp socket not connected');
        return false;
      }

      await this.sock.sendMessage(jid, { text });
      await new Promise((resolve) => setTimeout(resolve, 300));
      return true;
    } catch (error) {
      logger.error(`Error sending message: ${error.message}`);
      return false;
    }
  }
}

// Initialize and start bridge
async function main() {
  try {
    const bridge = new HideHavenWhatsAppBridge();
    await bridge.initialize();
  } catch (error) {
    logger.error(`Failed to start bridge: ${error.message}`);
    process.exit(1);
  }
}

main();

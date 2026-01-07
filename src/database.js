import { open } from 'lmdb';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';
import { logger } from './logger.js';

const DEFAULT_HISTORY_LIMIT = 50;
const DM_KIND = 4;
const PUBLIC_KIND = 1;

function sanitizePubkey(pubkey) {
  if (!pubkey || typeof pubkey !== 'string') {
    return '';
  }
  return pubkey.trim().toLowerCase();
}

function sanitizeSessionId(sessionId) {
  if (!sessionId) {
    return '';
  }
  return String(sessionId).trim().slice(0, 120);
}

export class Database {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  async init() {
    if (this.db) {
      return;
    }

    mkdirSync(dirname(this.dbPath), { recursive: true });

    this.db = open({
      path: this.dbPath,
      compression: true,
      encoding: 'json',
    });

    logger.info(`Conversation database ready at ${this.dbPath}`);
  }

  _assertInitialized() {
    if (!this.db) {
      throw new Error('Conversation database not initialized');
    }
  }

  async ensureSession(pubkey, requestedSessionId, metadata = {}) {
    this._assertInitialized();

    const normalizedPubkey = sanitizePubkey(pubkey);
    if (!normalizedPubkey) {
      throw new Error('Valid pubkey is required');
    }

    const sessionId = sanitizeSessionId(requestedSessionId) || 
                     metadata.fallbackId || 
                     `session-${Date.now()}-${randomUUID().slice(0, 8)}`;

    const metaKey = `session:meta:${normalizedPubkey}:${sessionId}`;
    const messagesKey = `session:messages:${normalizedPubkey}:${sessionId}`;
    const userSessionsKey = `user:sessions:${normalizedPubkey}`;

    let sessionMeta = await this.db.get(metaKey);
    const now = Date.now();

    if (!sessionMeta) {
      sessionMeta = {
        pubkey: normalizedPubkey,
        sessionId,
        createdAt: now,
        lastMessageAt: now,
        messageCount: 0,
        origin: metadata.source || null,
        label: metadata.label || null,
      };

      await this.db.put(metaKey, sessionMeta);
      await this.db.put(messagesKey, []);

      let userSessions = await this.db.get(userSessionsKey) || [];
      if (!userSessions.includes(sessionId)) {
        userSessions.push(sessionId);
        await this.db.put(userSessionsKey, userSessions);
      }

      logger.info(`Created new session: ${sessionId.substring(0, 12)}... for user ${normalizedPubkey.substring(0, 8)}...`);

      return { sessionId, isNew: true, session: sessionMeta };
    }

    let dirty = false;
    if (metadata.source && !sessionMeta.origin) {
      sessionMeta.origin = metadata.source;
      dirty = true;
    }
    if (metadata.label && sessionMeta.label !== metadata.label) {
      sessionMeta.label = metadata.label;
      dirty = true;
    }
    if (metadata.touch !== false) {
      sessionMeta.lastTouchedAt = now;
      dirty = true;
    }

    if (dirty) {
      await this.db.put(metaKey, sessionMeta);
    }

    return { sessionId, isNew: false, session: sessionMeta };
  }

  async saveMessage(pubkey, message, isFromBot = false, metadata = {}) {
    this._assertInitialized();

    const normalizedPubkey = sanitizePubkey(pubkey);
    if (!normalizedPubkey) {
      throw new Error('Valid pubkey is required');
    }

    const content = typeof message === 'string' ? message : '';
    const timestamp = Number.isFinite(metadata.timestamp) ? metadata.timestamp : Date.now();
    const direction = isFromBot ? 'bot' : 'user';

    if (metadata.eventId) {
      const eventKey = `event:processed:${metadata.eventId}`;
      const isDuplicate = await this.db.get(eventKey);
      
      if (isDuplicate) {
        logger.info(`Duplicate event ${metadata.eventId} - skipping`);
        return {
          duplicate: true,
          sessionId: isDuplicate.sessionId,
          timestamp: isDuplicate.timestamp,
        };
      }
    }

    const { sessionId } = await this.ensureSession(normalizedPubkey, metadata.sessionId, {
      source: metadata.messageSource ||
        (metadata.eventKind === DM_KIND ? 'dm' :
         metadata.eventKind === PUBLIC_KIND ? 'public' : 
         metadata.eventKind ? `kind-${metadata.eventKind}` : null),
      label: metadata.sessionLabel,
      touch: false,
    });

    const messageRecord = {
      pubkey: normalizedPubkey,
      sessionId,
      message: content,
      isFromBot,
      timestamp,
      messageType: metadata.messageType || (isFromBot ? 'response' : 'question'),
      replyTo: metadata.replyTo || null,
      eventId: metadata.eventId || null,
      eventKind: metadata.eventKind || null,
      userMetadata: metadata.userMetadata || null, // Store user metadata from relay
    };

    const messagesKey = `session:messages:${normalizedPubkey}:${sessionId}`;
    let messages = await this.db.get(messagesKey) || [];

    messages.push(messageRecord);

    if (messages.length > 1000) {
      messages = messages.slice(-1000);
    }

    await this.db.put(messagesKey, messages);

    if (metadata.eventId) {
      const eventKey = `event:processed:${metadata.eventId}`;
      await this.db.put(eventKey, { 
        sessionId, 
        timestamp,
        processed: true 
      });
    }

    const metaKey = `session:meta:${normalizedPubkey}:${sessionId}`;
    let sessionMeta = await this.db.get(metaKey);
    if (sessionMeta) {
      sessionMeta.lastMessageAt = timestamp;
      sessionMeta.messageCount = messages.length;
      await this.db.put(metaKey, sessionMeta);
    }

    logger.info(`Saved ${direction.toUpperCase()} message to session ${sessionId.substring(0, 12)}... (total: ${messages.length} messages)`);

    return {
      duplicate: false,
      sessionId,
      timestamp,
      messageCount: messages.length,
    };
  }

  async getConversationBySession(pubkey, sessionId, limit = DEFAULT_HISTORY_LIMIT) {
    this._assertInitialized();

    const normalizedPubkey = sanitizePubkey(pubkey);
    if (!normalizedPubkey) {
      logger.warn('getConversationBySession: empty pubkey');
      return [];
    }

    const sanitizedSessionId = sanitizeSessionId(sessionId);
    if (!sanitizedSessionId) {
      logger.warn('getConversationBySession: empty sessionId');
      return [];
    }

    const messagesKey = `session:messages:${normalizedPubkey}:${sanitizedSessionId}`;
    
    try {
      let messages = await this.db.get(messagesKey) || [];
      
      logger.info(`Retrieved ${messages.length} messages from session ${sanitizedSessionId.substring(0, 12)}...`);

      if (messages.length > limit) {
        messages = messages.slice(-limit);
      }

      return messages.map(msg => ({
        message: msg.message,
        isFromBot: msg.isFromBot,
        timestamp: msg.timestamp,
        messageType: msg.messageType,
      }));
    } catch (error) {
      logger.error('Failed to get conversation by session:', error);
      return [];
    }
  }

  async getConversation(pubkey, limit = DEFAULT_HISTORY_LIMIT) {
    this._assertInitialized();

    const normalizedPubkey = sanitizePubkey(pubkey);
    if (!normalizedPubkey) {
      logger.warn('getConversation: empty pubkey');
      return [];
    }

    try {
      const userSessionsKey = `user:sessions:${normalizedPubkey}`;
      const sessionIds = await this.db.get(userSessionsKey) || [];

      if (sessionIds.length === 0) {
        logger.info(`No sessions found for user ${normalizedPubkey.substring(0, 8)}...`);
        return [];
      }

      let allMessages = [];
      
      for (const sessionId of sessionIds) {
        const messagesKey = `session:messages:${normalizedPubkey}:${sessionId}`;
        const messages = await this.db.get(messagesKey) || [];
        allMessages = allMessages.concat(messages);
      }

      allMessages.sort((a, b) => a.timestamp - b.timestamp);

      logger.info(`Retrieved ${allMessages.length} messages across ${sessionIds.length} sessions`);

      if (allMessages.length > limit) {
        allMessages = allMessages.slice(-limit);
      }

      return allMessages.map(msg => ({
        message: msg.message,
        isFromBot: msg.isFromBot,
        timestamp: msg.timestamp,
        messageType: msg.messageType,
      }));
    } catch (error) {
      logger.error('Failed to get conversation:', error);
      return [];
    }
  }

  async getSessionMetadata(pubkey, sessionId) {
    this._assertInitialized();

    const normalizedPubkey = sanitizePubkey(pubkey);
    const sanitizedSessionId = sanitizeSessionId(sessionId);
    
    if (!normalizedPubkey || !sanitizedSessionId) {
      return null;
    }

    try {
      const metaKey = `session:meta:${normalizedPubkey}:${sanitizedSessionId}`;
      return await this.db.get(metaKey);
    } catch (error) {
      logger.error('Failed to get session metadata:', error);
      return null;
    }
  }

  async close() {
    if (this.db) {
      await this.db.close();
      this.db = null;
      logger.info('Conversation database closed');
    }
  }
}

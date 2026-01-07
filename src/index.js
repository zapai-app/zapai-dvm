#!/usr/bin/env node
import 'dotenv/config';
import { WebSocket } from 'ws';
import { NostrBot } from './bot.js';
import { WebServer } from './webserver.js';
import { logger } from './logger.js';
import { EventEmitter } from 'events';

// Increase max listeners to prevent warnings
EventEmitter.defaultMaxListeners = 50;

// Polyfill WebSocket for Node.js environment
if (typeof global.WebSocket === 'undefined') {
  global.WebSocket = WebSocket;
}

// Validate environment variables
// NOTE: Gemini key may be provided either as GEMINI_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY
// (the latter is used by newer Google AI SDK setups).
const missing = [];
if (!process.env.BOT_PRIVATE_KEY) missing.push('BOT_PRIVATE_KEY');
if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
  missing.push('GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY)');
}

if (missing.length > 0) {
  logger.error(`Missing required environment variables: ${missing.join(', ')}`);
  logger.info('Please check .env file and set all required variables');
  process.exit(1);
}

// Initialize bot with scalability configurations
const bot = new NostrBot({
  privateKey: process.env.BOT_PRIVATE_KEY,
  geminiApiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY,
  botName: process.env.BOT_NAME || 'ZapAI',
  relays: process.env.NOSTR_RELAYS.split(','),
  // Default to 0 for low-latency responses. Set BOT_RESPONSE_DELAY (ms) if you want a "typing" feel.
  responseDelay: Number.isFinite(parseInt(process.env.BOT_RESPONSE_DELAY))
    ? parseInt(process.env.BOT_RESPONSE_DELAY)
    : 0,

  // User metadata caching (speed up DMs by avoiding repeated relay fetches)
  userMetadataCacheTtlMs: Number.isFinite(parseInt(process.env.USER_METADATA_CACHE_TTL_MS))
    ? parseInt(process.env.USER_METADATA_CACHE_TTL_MS)
    : 6 * 60 * 60 * 1000,
  userMetadataFastTimeoutMs: Number.isFinite(parseInt(process.env.USER_METADATA_FAST_TIMEOUT_MS))
    ? parseInt(process.env.USER_METADATA_FAST_TIMEOUT_MS)
    : 300,
  
  // Queue configuration
  maxConcurrent: parseInt(process.env.MAX_CONCURRENT) || 10,
  maxQueueSize: parseInt(process.env.MAX_QUEUE_SIZE) || 10000,
  queueTimeout: parseInt(process.env.QUEUE_TIMEOUT) || 60000, // 60 seconds default
  
  // Rate limiting configuration
  rateLimit: {
    maxTokens: parseInt(process.env.RATE_LIMIT_MAX_TOKENS) || 50,
    refillRate: parseInt(process.env.RATE_LIMIT_REFILL_RATE) || 5,
  },

  // Gemini tuning
  geminiOptions: {
    enableChatSessionReuse: process.env.ENABLE_CHAT_SESSION_REUSE !== 'false',
    chatSessionTtlMs: Number.isFinite(parseInt(process.env.CHAT_SESSION_TTL_MS))
      ? parseInt(process.env.CHAT_SESSION_TTL_MS)
      : 30 * 60 * 1000,
    maxChatSessions: Number.isFinite(parseInt(process.env.MAX_CHAT_SESSIONS))
      ? parseInt(process.env.MAX_CHAT_SESSIONS)
      : 5000,
    enableMemorySummary: process.env.ENABLE_MEMORY_SUMMARY === 'true',
    memorySummaryMinMessages: Number.isFinite(parseInt(process.env.MEMORY_SUMMARY_MIN_MESSAGES))
      ? parseInt(process.env.MEMORY_SUMMARY_MIN_MESSAGES)
      : 16,
  },
});

// Initialize web server
const webPort = parseInt(process.env.WEB_PORT) || 3000;
const dashboardPassword = process.env.DASHBOARD_PASSWORD || null;
const webServer = new WebServer(bot, webPort, dashboardPassword);

// Handle graceful shutdown
async function shutdown() {
  logger.info('Shutting down...');
  
  await webServer.stop();
  await bot.stop();
  
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start everything
(async () => {
  try {
    // Start the bot
    await bot.start();
    
    // Start the web server
    await webServer.start();
    
    logger.info('All systems running!');
  } catch (err) {
    logger.error('Failed to start:', err);
    process.exit(1);
  }
})();

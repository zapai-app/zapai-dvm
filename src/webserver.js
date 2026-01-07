import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import { logger } from './logger.js';
import { Database } from './database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Web UI Server for monitoring the bot
 */
export class WebServer {
  constructor(bot, port = 3000, dashboardPassword = null) {
    this.bot = bot;
    this.port = port;
    this.dashboardPassword = dashboardPassword;
    this.app = express();
    this.server = null;
    this.db = new Database('./data/conversations');
    
    this.setupMiddleware();
    this.setupRoutes();
  }

  /**
   * Check if authenticated
   */
  requireAuth(req, res, next) {
    if (req.session && req.session.authenticated) {
      next();
    } else {
      res.status(401).json({ error: 'Unauthorized' });
    }
  }

  /**
   * Setup middleware
   */
  setupMiddleware() {
    this.app.use(cors({
      origin: true,
      credentials: true
    }));
    this.app.use(express.json());
    
    // Session middleware
    this.app.use(session({
      secret: this.dashboardPassword || 'zapai-secret-key-change-this',
      resave: false,
      saveUninitialized: false,
      cookie: {
        secure: false, // set to true if using HTTPS
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
      }
    }));
    
    this.app.use(express.static(path.join(__dirname, '../public')));
  }

  /**
   * Setup routes
   */
  setupRoutes() {
    // Login route
    this.app.post('/api/login', (req, res) => {
      const { password } = req.body;
      
      if (!this.dashboardPassword) {
        // No password set, allow access
        req.session.authenticated = true;
        return res.json({ success: true, message: 'Logged in successfully' });
      }
      
      if (password === this.dashboardPassword) {
        req.session.authenticated = true;
        res.json({ success: true, message: 'Logged in successfully' });
      } else {
        res.status(401).json({ success: false, message: 'Invalid password' });
      }
    });

    // Logout route
    this.app.post('/api/logout', (req, res) => {
      req.session.destroy();
      res.json({ success: true, message: 'Logged out successfully' });
    });

    // Check auth status
    this.app.get('/api/auth/check', (req, res) => {
      res.json({ 
        authenticated: req.session && req.session.authenticated === true,
        requiresAuth: !!this.dashboardPassword
      });
    });

    // Protected API Routes
    this.app.get('/api/status', this.requireAuth.bind(this), (req, res) => {
      const stats = this.bot.getStats();
      res.json({
        status: 'running',
        pubkey: this.bot.pubkey,
        stats: {
          ...stats,
          performance: {
            queueSize: stats.queue?.queueSize || 0,
            processing: stats.queue?.processing || 0,
            avgProcessTime: stats.queue?.avgProcessTime || 0,
            successRate: stats.queue?.successRate || 'N/A',
          },
          rateLimiting: {
            activeBuckets: stats.rateLimiter?.activeBuckets || 0,
            globalTokens: stats.rateLimiter?.globalTokens || 0,
            maxTokens: stats.rateLimiter?.maxTokens || 0,
          },
          geminiAI: {
            requests: stats.gemini?.requests || 0,
            successful: stats.gemini?.successful || 0,
            failed: stats.gemini?.failed || 0,
            fallbacks: stats.gemini?.fallbacks || 0,
            successRate: stats.gemini?.successRate || 'N/A',
            circuitBreakerState: stats.gemini?.circuitBreaker?.state || 'UNKNOWN',
          },
        },
      });
    });

    this.app.get('/api/relays', this.requireAuth.bind(this), (req, res) => {
      const relays = Array.from(this.bot.relayStatus.values()).map(relay => ({
        ...relay,
        lastSeenFormatted: relay.lastSeen ? new Date(relay.lastSeen).toLocaleString('en-US') : 'Never',
      }));
      res.json(relays);
    });

    this.app.get('/api/messages', this.requireAuth.bind(this), async (req, res) => {
      try {
        const limit = parseInt(req.query.limit) || 100;
        const messages = await this.db.getRecentMessages(limit);
        res.json(messages);
      } catch (error) {
        logger.error('Failed to get messages:', error);
        res.status(500).json({ error: 'Failed to get messages' });
      }
    });

    this.app.get('/api/conversations', this.requireAuth.bind(this), async (req, res) => {
      try {
        const conversations = await this.db.getAllConversations();
        res.json(conversations);
      } catch (error) {
        logger.error('Failed to get conversations:', error);
        res.status(500).json({ error: 'Failed to get conversations' });
      }
    });

    this.app.get('/api/conversation/:pubkey', this.requireAuth.bind(this), async (req, res) => {
      try {
        const { pubkey } = req.params;
        const messages = await this.db.getConversation(pubkey);
        res.json(messages);
      } catch (error) {
        logger.error('Failed to get conversation:', error);
        res.status(500).json({ error: 'Failed to get conversation' });
      }
    });

    // Zap endpoints
    this.app.get('/api/zaps', this.requireAuth.bind(this), async (req, res) => {
      try {
        const limit = parseInt(req.query.limit) || 100;
        const zaps = await this.bot.zapDb.getAllZaps(limit);
        res.json(zaps);
      } catch (error) {
        logger.error('Failed to get zaps:', error);
        res.status(500).json({ error: 'Failed to get zaps' });
      }
    });

    this.app.get('/api/zaps/:pubkey', this.requireAuth.bind(this), async (req, res) => {
      try {
        const { pubkey } = req.params;
        const limit = parseInt(req.query.limit) || 50;
        const zaps = await this.bot.zapDb.getUserZaps(pubkey, limit);
        res.json(zaps);
      } catch (error) {
        logger.error('Failed to get user zaps:', error);
        res.status(500).json({ error: 'Failed to get user zaps' });
      }
    });

    this.app.get('/api/balance/:pubkey', this.requireAuth.bind(this), async (req, res) => {
      try {
        const { pubkey } = req.params;
        const balance = await this.bot.zapDb.getBalance(pubkey);
        res.json({ pubkey, balance });
      } catch (error) {
        logger.error('Failed to get balance:', error);
        res.status(500).json({ error: 'Failed to get balance' });
      }
    });

    this.app.get('/api/balances', this.requireAuth.bind(this), async (req, res) => {
      try {
        const balances = await this.bot.zapDb.getAllBalances();
        res.json(balances);
      } catch (error) {
        logger.error('Failed to get all balances:', error);
        res.status(500).json({ error: 'Failed to get all balances' });
      }
    });

    // Health check with detailed status
    this.app.get('/health', (req, res) => {
      const stats = this.bot.getStats();
      const isHealthy = stats.queue?.queueSize < 9000 && // Queue not near full
                       stats.gemini?.circuitBreaker?.state !== 'OPEN'; // Circuit not open
      
      res.status(isHealthy ? 200 : 503).json({ 
        status: isHealthy ? 'ok' : 'degraded',
        queueSize: stats.queue?.queueSize || 0,
        circuitBreaker: stats.gemini?.circuitBreaker?.state || 'UNKNOWN',
      });
    });

    // Serve HTML
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, '../public/index.html'));
    });
  }

  /**
   * Start the server
   */
  async start() {
    // Initialize database
    await this.db.init();
    
    return new Promise((resolve, reject) => {
      logger.info(`Attempting to start web server on port ${this.port}...`);
      
      this.server = this.app.listen(this.port, '0.0.0.0', () => {
        logger.info(`Web UI server started on http://0.0.0.0:${this.port}`);
        resolve();
      });
      
      this.server.on('error', (error) => {
        logger.error(`Web server error: ${error.message}`);
        reject(error);
      });
    });
  }

  /**
   * Stop the server
   */
  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          logger.info('Web UI server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
